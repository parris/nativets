/*
 * WHAT A `${…}` SUBSTITUTION CAN SEE.
 *
 * A template substitution is not parsed in place. `Parser.buildTemplate` slices the `${…}`
 * text out of the template token and parses THAT string, so the fragment gets a parser of
 * its own — and for the life of the file that parser was built from nothing but the
 * fragment's tokens. It therefore knew none of the enclosing file's state, which produced
 * two defects of opposite kinds from one cause:
 *
 *   1. A FALSE REFUSAL, on valid TypeScript node runs. Every declared type name was
 *      undeclared inside a substitution:
 *
 *          interface P { v: number }
 *          console.log(`${xs.map((a: P): number => a.v).length}`);
 *          // node: 2, exit 0.  nativets: NT2003 Cannot find name 'P' at 3:27
 *
 *      The identical annotation one character outside the backticks compiled, which is
 *      what makes it a lie rather than a limitation — and the hint said "'P' is not
 *      declared in this file" with `interface P` two lines above it.
 *
 *   2. A SILENT WRONG ANSWER, which is the worse half and was found while fixing the
 *      first. The floating-async guard accumulates DURING the parse (`identCalls`) and is
 *      checked ONCE at the end of `parseProgram`, so anything the fragment's parser
 *      recorded was recorded where nothing would ever look:
 *
 *          async function one(): Promise<number> { return 1; }
 *          console.log(`${one()}`);
 *          // node: [object Promise]   nativets, before: 1     BOTH exit 0
 *
 *      Outside the backticks that same call is NT1020. So the guard had a hole exactly one
 *      character wide, and the failure mode was a different answer rather than a refusal.
 *
 * The fix seeds the sub-parser's type tables from the enclosing parser and seeds AND
 * HARVESTS the async guard's state — the asymmetry is deliberate and `parseSubstitution`
 * documents it: a substitution is an expression, so it can never declare a type to give
 * back, but it can absolutely contain a call the guard has to see.
 *
 * Every case here is executed under node first. The refusals are pinned by CODE, and the
 * accepted ones by node's own bytes.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** node is the oracle: same stdout, same exit code. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

describe("a type name is in scope inside a `${…}` substitution", () => {
  test("an `interface` declared above", async () => {
    await same(
      'interface P { v: number }\n' +
      'const xs: P[] = [{ v: 1 }, { v: 2 }];\n' +
      'console.log(`${xs.map((a: P): number => a.v).length}`);\n',
    );
  });

  test("a `type` alias, in both the parameter and the return position", async () => {
    await same(
      'type N = number;\n' +
      'const ns: number[] = [3, 4];\n' +
      'console.log(`${ns.map((a: N): N => a * 2).join(",")}`);\n',
    );
  });

  /* A class registers its instance shape when `parseClass` RUNS (classes are not hoisted),
   * so this also pins that the seed is taken at the substitution, not at the file's start. */
  test("a `class` declared above", async () => {
    await same(
      'class C { k: number; constructor(k: number) { this.k = k; } }\n' +
      'const cs: C[] = [new C(5), new C(6)];\n' +
      'console.log(`${cs.map((c: C): number => c.k).join("|")}`);\n',
    );
  });

  /* The `@Name` back-edge table is separate from the alias table, so a recursive union
   * needs `recTypes` carried across too — a shape whose members reference the union. */
  test("a recursive discriminated union", async () => {
    await same(
      'type Tree = { kind: "leaf"; n: number } | { kind: "node"; kids: Tree[] };\n' +
      'const ts: Tree[] = [{ kind: "leaf", n: 7 }];\n' +
      'console.log(`${ts.map((t: Tree): string => t.kind).join("")}`);\n',
    );
  });

  /* A type declared BELOW its use. Top-level `type`/`interface` declarations are hoisted,
   * so the alias table is already complete when any statement is parsed. */
  test("an `interface` declared BELOW the template", async () => {
    await same(
      'const xs: Q[] = [{ w: 1 }];\n' +
      'console.log(`${xs.map((a: Q): number => a.w).length}`);\n' +
      'interface Q { w: number }\n',
    );
  });

  /* Nesting: the inner template is sliced out of the outer fragment, so the seed has to
   * survive one more parser hop. Before the fix the inner one was two levels from the
   * file's types rather than one. */
  test("a type name inside a template nested in a template", async () => {
    await same(
      'interface P { v: number }\n' +
      'const xs: P[] = [{ v: 1 }, { v: 2 }];\n' +
      'console.log(`outer ${`inner ${xs.map((a: P): number => a.v + 10).join("/")}`}`);\n',
    );
  });

  /* A generic function's own type parameter is a STACK of frames on the parser, and the
   * substitution sits inside every frame open at that point. */
  test("a generic function's type parameter, used in its own body's template", async () => {
    await same(
      'function tag<T>(v: T): string {\n' +
      '  return `${((x: T): T => x)(v)}`;\n' +
      '}\n' +
      'console.log(`${tag(8)} ${tag("s")}`);\n',
    );
  });

  /*
   * THE OTHER DIRECTION, and the one that keeps the fix from being a hole. Seeding the
   * sub-parser widens what is ACCEPTED, so a name that is genuinely declared nowhere must
   * still be refused — otherwise it would fall through `resolveNamed`'s last resort and
   * erase to `number`, which is the destructive silent answer that refusal exists to
   * prevent. Here the hint is also TRUE, which is the whole complaint about the old
   * behaviour: it said the same sentence when the declaration was two lines above.
   */
  test("a name declared NOWHERE is still NT2003 inside a substitution", () => {
    const r = rejectionOf(
      'const xs: number[] = [1, 2];\n' +
      'console.log(`${xs.map((a: Nope): number => a).length}`);\n',
    );
    expect(r?.code).toBe("NT2003");
    expect(r?.message).toContain("Cannot find name 'Nope'");
    expect(r?.hint).toContain("not declared in this file");
  });
});

describe("the floating-async guard reaches inside a `${…}` substitution", () => {
  /*
   * THE WRONG ANSWER THIS CLOSES. node prints `[object Promise]` because `one()` is a
   * pending promise coerced to a string; nativets erases `async` and runs the body to
   * completion, so it printed `1`. Both exited 0 — nothing anywhere said the two programs
   * disagreed. The refusal is the documented handling (docs/divergences.md): there is no
   * event loop, so an un-awaited async call must be rejected rather than serialized.
   */
  test("an un-awaited async call inside a substitution is NT1020, as it is outside one", () => {
    const src =
      'async function one(): Promise<number> { return 1; }\n' +
      'console.log(`${one()}`);\n';
    const r = rejectionOf(src);
    expect(r?.code).toBe("NT1020");
    expect(r?.message).toContain("without 'await'");
    // The position is the CALL's, inside the substitution — not the template's start.
    expect(r?.message).toContain("2:16");
  });

  test("node really does disagree, so the refusal is not gratuitous", () => {
    const oracle = runWithNode(
      'async function one(): Promise<number> { return 1; }\n' +
      'console.log(`${one()}`);\n',
    );
    expect(oracle.stdout).toBe("[object Promise]\n");
    expect(oracle.exitCode).toBe(0);
  });

  /* The other half of the harvest: `awaitedCalls` has to come back, or a legitimately
   * awaited call inside a substitution would be refused as floating. */
  test("an AWAITED async call inside a substitution still compiles and matches node", async () => {
    await same(
      'async function one(): Promise<number> { return 1; }\n' +
      'async function two(n: number): Promise<number> { return n + 1; }\n' +
      'async function main(): Promise<void> {\n' +
      '  console.log(`awaited: ${await one()}`);\n' +
      '  console.log(`nested: ${await two(await one())}`);\n' +
      '}\n' +
      'main();\n',
    );
  });
});
