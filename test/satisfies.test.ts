/*
 * The `satisfies` operator (TypeScript 4.9).
 *
 * `expr satisfies T` asserts that `expr` is assignable to `T` WITHOUT widening
 * `expr` to `T` — that is exactly how it differs from `expr as T`. Like `as`, it
 * is a type-layer construct: it erases completely, so node is the oracle for
 * every runtime-visible case here.
 *
 * The TypeScript conformance suite
 * (`tests/cases/conformance/expressions/satisfiesOperator/`) is NOT vendored into
 * this repo and no network was available, so the behavior list below is DERIVED
 * from the operator's specification rather than mined. The shapes chosen mirror
 * the ones that suite is known to cover: object-literal against an interface,
 * `satisfies` on a call argument, parenthesized/member-access chaining, a return
 * position, and interaction with `as`.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/**
 * Assert the source is REFUSED with the given code, and that the message mentions
 * `needle` — so a case meant to prove "this violates the constraint" cannot pass by
 * being rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("satisfies", () => {
  test("an object literal satisfies an object type", async () => {
    await expectNode(`
const x = { a: 1 } satisfies { a: number };
console.log(x.a);
`);
  });

  /*
   * The defining difference from \`as\`: the annotation is CHECKED against but never
   * ADOPTED. \`lit as {a:number}\` would lose \`b\`; \`satisfies\` keeps the value's own
   * inferred type, so \`x.b\` is still there.
   *
   * Deliberately goes through a BINDING rather than writing the object literal inline.
   * TypeScript applies excess-property ("freshness") checking to a literal written
   * directly under \`satisfies\`, so the inline spelling — `{ a: 1, b: 2 } satisfies
   * { a: number }` — is an ERROR in tsc even though node runs it. We currently ACCEPT
   * that spelling (see the KNOWN GAP note at the bottom of this file); this test is
   * about the no-retype rule, so it uses the form that is valid either way rather than
   * silently depending on the gap.
   */
  test("does not retype the expression — extra fields survive", async () => {
    await expectNode(`
const lit = { a: 1, b: 2 };
const x = lit satisfies { a: number };
console.log(x.b);
`);
  });

  test("parenthesized, with a member access on the result", async () => {
    await expectNode(`
const x = { a: 1 };
console.log((x satisfies { a: number }).a);
`);
  });

  /* The shape that blocks self-hosting: \`return { ... } satisfies ExportTable;\`. */
  test("in a return position", async () => {
    await expectNode(`
interface ExportTable { n: number; }
function f(): ExportTable { return { n: 7 } satisfies ExportTable; }
console.log(f().n);
`);
  });

  test("chains with 'as' in the same expression", async () => {
    await expectNode(`
const x = { a: 1 } satisfies { a: number } as { a: number };
console.log(x.a);
`);
  });

  /*
   * node STRIPS types, so node runs this and prints "s" — node cannot be the oracle
   * for a type-layer constraint. \`tsc\` rejects it, and so do we: reject, never
   * miscompile.
   */
  test("refuses an expression that does not satisfy the type", () => {
    expectRejected(`
const x = { a: "s" } satisfies { a: number };
console.log(x.a);
`, "NT2001", "{a:string} does not satisfy {a:number}");
  });
});

/*
 * KNOWN GAPS — we are MORE PERMISSIVE than tsc here. Neither is a miscompile: in both
 * cases the program we emit agrees with node. They are missing REFUSALS.
 *
 *  1. EXCESS-PROPERTY ("freshness") CHECKING. `{ a: 1, b: 2 } satisfies { a: number }`
 *     is accepted; tsc reports "Object literal may only specify known properties, and
 *     'b' does not exist in type '{ a: number; }'". Catching a typo'd key is one of the
 *     headline reasons `satisfies` exists (the `bleu`/`blue` example in the TS 4.9
 *     notes), so this gap costs real diagnostic value. Closing it needs a freshness
 *     bit on object-literal types, which `checker.ts` does not currently carry — well
 *     beyond this lane. NOTE: tsc's exact behavior here could NOT be verified locally
 *     (no `typescript` dependency and no network); it is asserted from the spec.
 *
 *  2. NO `[no LineTerminator here]` RESTRICTION. TypeScript's grammar forbids a line
 *     break before `satisfies`, so `const a = b \n satisfies(4)` is ASI'd into two
 *     statements. We instead try to parse `satisfies (4)` as the operator and reject
 *     the file. `as` has the identical pre-existing bug — this lane copied its shape
 *     rather than introducing the flaw. Rejection, not miscompilation.
 */
