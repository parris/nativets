/*
 * `??` WHEN THE RIGHT OPERAND IS ITSELF NULLABLE.
 *
 * `??` consumes the LEFT operand's nullishness and nothing else. TypeScript's rule:
 * the type of `l ?? r` is `NonNullable<L> | R`. So when `r` is still nullable, the
 * RESULT is still nullable — `(string|undefined) ?? (string|undefined)` is
 * `string | undefined`, not `string`.
 *
 * `Checker.type`'s `LogicalExpr` case answered `baseTy(l)` for every runtime-nullable
 * left, regardless of `r`. That is not a refusal, it is a WRONG ANSWER, and codegen
 * then stored the right operand's [tag,value] BOX into a slot declared to hold the
 * bare base value. Two measured divergences, both exit 0 where node is right:
 *
 *   const a = f("n") ?? f("n");            // both nullish
 *   typeof a  →  node "undefined", nativets "string"
 *   a.length  →  node TypeError (exit 1),  nativets 0
 *
 *   const a = f("n") ?? f("n") ?? "fallback";   // the CHAINED idiom
 *   "[" + a + "]"  →  node "[fallback]", nativets "[]"
 *
 * The second is the one that matters most: chained `??` is the ordinary way to write
 * a defaulting cascade (`src/` alone has 35 of them), and the fallback was silently
 * DROPPED — the box from the middle arm was reinterpreted as a string pointer.
 *
 * PROVENANCE. `test262` is not on this machine, so these are DERIVED from the
 * operator's specified type rule (`NonNullable<L> | R`) rather than mined. test262's
 * own `??` coverage (`language/expressions/coalesce/`) is about evaluation order and
 * short-circuiting, both of which already pass; the result TYPE is a TypeScript
 * question test262 does not ask. Every runtime assertion below is differential
 * against node, which is the oracle for stdout AND exit code.
 *
 * SECOND ORACLE. `tsc` is on this machine, and every type this file asserts was
 * checked against it under `--strict` before being written down:
 *
 *   const c = f("n") ?? f("n") ?? "fallback"; const c1: string = c;          // accepted
 *   const a = f("n") ?? f("n");              const a1: string|undefined = a; // accepted
 *   const b = f("n") ?? null;                const b1: string|null = b;      // accepted
 *   const a = f("n") ?? f("n"); a.length;    // TS18048 'a' is possibly 'undefined'
 *   const s: string = a;                     // TS2322 string|undefined → string
 *
 * tsc's refusal is word-for-word the refusal nativets now issues, which is the point:
 * this lane made nativets agree with the reference type-checker, not merely stop
 * being wrong.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

function rejection(source: string): string {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  return formatDiagnostic((err as NTError).diag, source);
}

const F = `function f(s: string): string | undefined { return s === "y" ? "yes" : undefined; }\n`;

describe("1 — a nullable right operand keeps the result nullable", () => {
  /*
   * THE CHAINED IDIOM, and the reason this file exists. Both leading arms are
   * nullish, so node reaches the string literal. nativets printed `[]`: the middle
   * arm's nullable box was stored into a slot typed `string`, and the third `??`
   * saw a left operand it had already been told was non-nullable, so it returned it
   * unconditionally and never evaluated the fallback at all.
   */
  test("chained `??` reaches its fallback when every earlier arm is nullish", async () => {
    await expectNode(F + `const a = f("n") ?? f("n") ?? "fallback";\nconsole.log("[" + a + "]");\nconsole.log(a.length);\n`);
  });

  /*
   * The result is OBSERVABLY still nullable when both arms are. `typeof` is the
   * cheapest witness — it needs no guard, so node runs the program to completion and
   * the whole thing is a straight stdout comparison. This is the exact program the
   * bug was first reported on, minus the unguarded `.length` (section 3 pins that).
   */
  test("`typeof` sees `undefined` when both arms are nullish", async () => {
    await expectNode(F + `const a = f("n") ?? f("n");\nconsole.log(typeof a);\nconsole.log("[" + a + "]");\n`);
  });

  /* ...and the left arm still wins when it is present, in the same program shape. */
  test("`typeof` sees the present left arm", async () => {
    await expectNode(F + `const a = f("y") ?? f("n");\nconsole.log(typeof a);\nconsole.log("[" + a + "]");\n`);
  });

  /* ...and the RIGHT arm's value survives when only the left is nullish. */
  test("a present right arm is the value", async () => {
    await expectNode(F + `const a = f("n") ?? f("y");\nconsole.log(typeof a);\nconsole.log("[" + a + "]");\n`);
  });
});

describe("2 — the result carries the RIGHT operand's nullish flavour", () => {
  /*
   * `NonNullable<L> | R`, taken literally: `(string|undefined) ?? null` is
   * `string | null`, NOT `string | undefined`. The two are different runtime tags in
   * the A2 [tag,value] box, so getting this wrong is a `=== null` that answers the
   * opposite of node's.
   */
  test("`?Ustring ?? null` is `string | null`", async () => {
    await expectNode(F + `const a: string | null = f("n") ?? null;\nconsole.log(a === null);\nconst b: string | null = f("y") ?? null;\nconsole.log(b === null);\n`);
  });

  /* The nullable result also satisfies a declared nullable RETURN, unboxed and reboxed
   * across the call — the shape a defaulting helper is actually written in. */
  test("the result flows out through a `string | undefined` return", async () => {
    await expectNode(F + `function g(s: string): string | undefined { return f(s) ?? f("n"); }\nconsole.log(typeof g("n"), typeof g("y"));\n`);
  });
});

describe("3 — the NEGATIVE, which is the whole point", () => {
  /*
   * This is the program the bug was reported on. node prints `undefined` and then
   * dies with a TypeError (exit 1). nativets has no runtime TypeError to raise here,
   * so the contract is a COMPILE-TIME refusal that names the real cause — and that is
   * strictly what changed: before this fix the same source compiled clean and printed
   * `string`, `0`, `[]` with exit 0. A silent wrong answer became a truthful refusal.
   *
   * Pinned as hard as the positives: if a later widening makes this accepted again
   * without the result being genuinely non-nullable, this test is what catches it.
   */
  test("dereferencing the result without a guard is refused, not silently zeroed", () => {
    const text = rejection(F + `const a = f("n") ?? f("n");\nconsole.log(a.length);\n`);
    expect(text).toContain("NT2001");
    expect(text).toContain("'a' is possibly undefined");
  });

  /* ...and the guard is what makes it legal, so the refusal is not a dead end. */
  test("a nullish guard on the result unblocks the read", async () => {
    await expectNode(F + `const a = f("n") ?? f("n");\nif (a !== undefined) console.log(a.length);\nelse console.log("none");\n`);
  });
});

describe("4 — the operator's own semantics are unchanged by the retype", () => {
  /*
   * The result type moved; NOTHING else may. Short-circuiting, the number of times
   * the right operand runs, nesting on either side, and the falsy-but-present values
   * `0` / `false` / `""` that `??` must NOT coalesce are all pinned here, because the
   * codegen change (coerce both arms into the expression's own type) touches the same
   * branch that decides all of them.
   */
  test("side effects, short-circuiting and nesting are byte-identical to node", async () => {
    await expectNode(
      `let calls = 0;\n` +
      `function side(): string | undefined { calls = calls + 1; return undefined; }\n` +
      `function pres(): string | undefined { return "p"; }\n` +
      `function u(): string | undefined { return undefined; }\n` +
      `function take(s: string): number { return s.length; }\n` +
      `const a = pres() ?? side();\n` +
      `console.log("A", "" + a, calls);\n` +           // right never runs
      `const b = side() ?? side() ?? "z";\n` +
      `console.log("B", b, calls);\n` +                 // right runs exactly once each
      `console.log("C", (u() ?? u()) ?? "deep");\n` +   // nested on the LEFT
      `console.log("D", u() ?? (u() ?? "deep2"));\n` +  // nested on the RIGHT
      `console.log("E", take(u() ?? u() ?? "abcd"));\n` +
      `console.log("F", \`\${u() ?? u() ?? "tpl"}\`);\n`,
    );
  });

  /* `??` is a NULLISH test, never truthiness: a present `0` / `false` / `""` wins. */
  test("falsy-but-present values are not coalesced", async () => {
    await expectNode(
      `function n(k: string): number | undefined { return k === "y" ? 0 : undefined; }\n` +
      `function b(k: string): boolean | undefined { return k === "y" ? false : undefined; }\n` +
      `console.log(n("y") ?? 9, b("y") ?? true);\n` +
      `console.log(n("n") ?? 9, b("n") ?? true);\n` +
      `console.log("" + (n("n") ?? n("n")), "" + (n("y") ?? n("n")));\n`,
    );
  });
});
