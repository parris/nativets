/*
 * AN ARROW'S RETURN-TYPE ANNOTATION IS CHECKED AGAINST ITS BODY.
 *
 *     const f = (k: string): boolean => m.delete(k);
 *
 * The `function` and METHOD spellings of that have always been `NT2001`
 * ("return type X does not match declared Y", src/checker.ts, the `ReturnStmt` case).
 * The ARROW spelling was not checked at all — and not because the checker forgot to
 * compare: `parseArrow` (src/parser.ts) PARSED the annotation and threw it away, keeping
 * only "was it a `Promise<…>`/function type" for the async bookkeeping. The type never
 * reached the AST, so there was nothing downstream to compare against.
 *
 * WHY IT MATTERS, precisely — the two halves are not the same kind of bug:
 *
 *  (a) a NODE DIVERGENCE, i.e. a silent WRONG ANSWER. It appears where the body's real
 *      type is something we print or lower differently from the declared one. The live
 *      instance is the one docs/divergences.md names as a known open hole under
 *      "`.delete` consumed as a BOOLEAN": our `Map` is persistent, so `m.delete(k)` is a
 *      new `Map`, not node's boolean. Every boolean CONTEXT is refused (`NT1606`), and
 *      the table's "`return` from a `: boolean` function" row was true for a `function`
 *      and a method and FALSE for an arrow. `console.log(f("zz"))` printed
 *      `Map(1) { 'a' => 1 }` where node prints `false` — exit 0, no diagnostic.
 *
 *  (b) a TSC-ONLY TYPE ERROR, where node AGREES with us. `(n: number): string => n + 1`
 *      is `error TS2322` under tsc, but node erases types and prints `2`, and so did we.
 *      Accepting it was never a divergence; it was a missing static check. It is closed
 *      here too, because "reject, never miscompile" cannot tell the two apart before the
 *      fact — the same missing comparison produced both.
 *
 * Cases are DERIVED from the repro quoted in docs/divergences.md §"`.delete` consumed as
 * a BOOLEAN", from tsc's behaviour on each shape (quoted at the test), and from the
 * TypeScript conformance suite's arrow-function return-type material
 * (tests/cases/conformance/types/typeRelationships/…, `returnTypeAnnotation` shapes).
 * Each ACCEPT case is additionally run against node as the oracle.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

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

/** node is the oracle: same stdout, same exit code. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("(a) the NODE DIVERGENCE: a lying annotation that changed the answer", () => {
  /*
   * docs/divergences.md, §"`.delete` consumed as a BOOLEAN is REFUSED", verbatim:
   *   "It does **not** hold for an **arrow**, because an arrow's declared return type is
   *    never checked against its body at all … prints the map where node prints `false`,
   *    with no diagnostic."
   * node (measured): `false`.  nativets, before: `Map(1) { 'a' => 1 }`, exit 0.
   */
  test("`(k: string): boolean => m.delete(k)` is refused, not silently printed as a Map", () => {
    const r = rejectionOf(
      'let m = new Map<string, number>().set("a", 1);\n' +
      'const f = (k: string): boolean => m.delete(k);\n' +
      'console.log(f("zz"));\n',
    );
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("boolean");
  });

  // The same lie in a BLOCK body goes through `checkBlock`, so the diagnostic can name
  // the offending `return`'s position the way a `function`'s always could.
  test("the block-body spelling names the `return`'s position", () => {
    const r = rejectionOf(
      'let m = new Map<string, number>().set("a", 1);\n' +
      'const f = (k: string): boolean => { return m.delete(k); };\n' +
      'console.log(f("zz"));\n',
    );
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("Map<string,number>");
    expect(r?.message).toContain("2:");
  });
});

describe("(b) the TSC-ONLY type errors: node agrees with us, the check was just missing", () => {
  // tsc: error TS2322: Type 'number' is not assignable to type 'string'.
  // node: prints `2` — it erases the annotation, and so did we. Not a divergence.
  test("an expression body whose type is not the declared one", () => {
    const r = rejectionOf('const f = (n: number): string => n + 1;\nconsole.log(f(1));\n');
    expect(r?.code).toBe("NT2001");
  });

  // tsc: error TS2322: Type 'number' is not assignable to type 'string'.
  test("a BLOCK body's `return` is checked the same way", () => {
    const r = rejectionOf('const f = (n: number): string => { return n + 1; };\nconsole.log(f(1));\n');
    expect(r?.code).toBe("NT2001");
  });

  // tsc: error TS2322 on the INNER arrow. The outer one is fine.
  test("a NESTED arrow's annotation is checked too", () => {
    const r = rejectionOf(
      'const outer = (n: number): number => { const inner = (x: number): string => x + 1; return inner(n).length; };\n' +
      'console.log(outer(1));\n',
    );
    expect(r?.code).toBe("NT2001");
  });

  // tsc: error TS2322: Type 'number' is not assignable to type 'string'. `Promise<T>` is
  // erased to `T` here (async/await is a pass-through), so the comparison is `string` vs
  // `number` — the same one.
  test("an `async` arrow's `Promise<T>` annotation is checked against T", () => {
    const r = rejectionOf(
      'async function main(): Promise<void> {\n' +
      '  const f = async (n: number): Promise<string> => n + 1;\n' +
      '  console.log(await f(1));\n' +
      '}\n' +
      'main();\n',
    );
    expect(r?.code).toBe("NT2001");
  });

  // tsc: error TS2322 on the callback. An inlined HOF callback goes down a DIFFERENT
  // checker path (`typeArrowBody`) from a value-arrow (`typeArrow`), so it is pinned too.
  test("an inlined HOF callback's annotation is checked", () => {
    const r = rejectionOf('console.log([1, 2, 3].map((x): string => x * 2).length);\n');
    expect(r?.code).toBe("NT2001");
  });
});

describe("NOT over-refused: an honest annotation keeps compiling, and matches node", () => {
  test("the annotation agrees with the body", async () => {
    await same('const f = (n: number): number => n + 1;\nconsole.log(f(1));\n');
  });

  test("a widening case: declared `number`, body is an integer literal", async () => {
    await same('const f = (n: number): number => 1;\nconsole.log(f(0));\n');
  });

  test("a nullable case: declared `string | null`, body is `null`", async () => {
    await same('const f = (n: number): string | null => null;\nconsole.log(f(3));\n');
  });

  test("a nullable case where the body is the NON-null arm", async () => {
    await same('const f = (n: number): string | null => "x";\nconsole.log(f(3));\n');
  });

  test("a union case: declared `number | string`, body is one member", async () => {
    await same('type U = number | string;\nconst f = (n: number): U => n;\nconsole.log(f(3));\n');
  });

  test("an object return type", async () => {
    await same(
      'type P = { x: number; y: number };\n' +
      'const mk = (x: number): P => ({ x, y: x + 1 });\n' +
      'console.log(mk(2).y);\n',
    );
  });

  /*
   * NO array-return case here, and that absence is deliberate. A value-arrow that returns
   * an ARRAY is broken on main INDEPENDENTLY of any annotation — found while writing this
   * file, reported separately, NOT this lane's bug:
   *   const f = (n: number) => [n, n + 1];        // no annotation at all
   *   const a = f(1); console.log(a.length);      // node: 2   nativets: exit 255, no output
   * Pinning it here would pin a failure this lane cannot fix; adding a `: number[]`
   * annotation to it changes nothing either way.
   */

  test("a `string` return type", async () => {
    await same('const f = (n: number): string => `n=${n}`;\nconsole.log(f(7));\n');
  });

  test("a block body with several returns, all of the declared type", async () => {
    await same(
      'const f = (n: number): string => {\n' +
      '  if (n > 0) { return "pos"; }\n' +
      '  return "neg";\n' +
      '};\n' +
      'console.log(f(1) + f(-1));\n',
    );
  });

  test("a contextually typed callback that ALSO annotates its return", async () => {
    await same(
      'function apply(cb: (x: number) => string): string { return cb(1); }\n' +
      'console.log(apply((x): string => `v${x}`));\n',
    );
  });

  test("an inlined HOF callback with an honest annotation", async () => {
    await same('console.log([1, 2, 3].map((x): number => x * 2).join(","));\n');
  });

  test("a `boolean`-returning `.filter` callback", async () => {
    await same('console.log([1, 2, 3, 4].filter((x): boolean => x % 2 === 0).join(","));\n');
  });

  test("an `async` arrow whose `Promise<T>` annotation is honest", async () => {
    await same(
      'async function main(): Promise<void> {\n' +
      '  const f = async (n: number): Promise<string> => `v${n}`;\n' +
      '  console.log(await f(1));\n' +
      '}\n' +
      'main();\n',
    );
  });

  test("a generic arrow's own type parameter still erases rather than mis-comparing", async () => {
    await same('const id = <T>(x: T): T => x;\nconsole.log(id(5));\n');
  });

  // `: void` is treated as "no declared type" — a `void` arrow's body is an expression
  // node evaluates and discards, and adopting `void` as the arrow's return type would
  // change the emitted signature rather than catch a lie.
  test("a `: void` arrow is unaffected", async () => {
    await same('const log = (x: number): void => { console.log(x); };\nlog(3);\n');
  });

  /*
   * (2) in `typeArrowReturn`: the annotation is HONEST but wider than `fitsParam` carries.
   * The `function` spelling of each of these is refused today for the same reason
   * (`function f(n: number): string | null { return null; }` → NT2001, measured on main),
   * so an arrow keeping its pre-annotation behaviour is the non-regressing choice —
   * widening `fitsParam` to nullables is a separate lane's change, not this one's.
   */
  test("the nullable widening is not newly refused by this check", async () => {
    await same(
      'const f = (n: number): string | null => null;\n' +
      'const g = (n: number): string | null => "x";\n' +
      'console.log(f(1));\nconsole.log(g(1));\n',
    );
  });
});

describe("the annotation is also the CONTEXT for the body, as it is for a `return`", () => {
  /*
   * `inferBlockReturn` only looks at TOP-LEVEL `return` statements, so an arrow whose
   * only `return` sits inside a `try` (or an `if`/`else` pair) inferred `number` and then
   * rejected its own body with a BOGUS `NT2001` — a false refusal, measured on main:
   *   const f = (n: number): string => { try { … } catch (e) { return "caught"; } };
   *   → error[NT2001]: return type string does not match declared number
   * With the annotation carried through it is the declared type that every `return` is
   * checked against, so the arrow compiles and agrees with node.
   */
  test("an arrow whose only `return` is inside a `try` now compiles", async () => {
    await same(
      'const f = (n: number): string => {\n' +
      '  try { throw new Error("x"); } catch (e) { return "caught"; }\n' +
      '};\n' +
      'console.log(f(1));\n',
    );
  });

  test("an arrow whose only returns are the two arms of an `if`/`else`", async () => {
    await same(
      'const f = (n: number): string => {\n' +
      '  if (n > 0) { return "pos"; } else { return "neg"; }\n' +
      '};\n' +
      'console.log(f(1) + f(-1));\n',
    );
  });
});

/*
 * A STATEMENT ARROW PASSED TO A `=> void` PARAMETER. The mirror image of the block above:
 * there the annotation was DROPPED, here the missing one was never inferred.
 *
 * `inferBlockReturn` answers `number` for a body with no `return` at all — `number` is
 * this checker's universal default, and that answer is right for `inferReturnType` on an
 * unannotated `function`, whose callers may use the value. For an arrow being PASSED into
 * a `(x: number) => void` slot it is a lie: the body returns nothing, and the resulting
 * `(number)=>number` does not fit `(number)=>void`.
 *
 *   function loopA(n: number, iter: (x: number) => void): void { iter(n); }
 *   loopA(1, (x) => { console.log(x); });
 *   → error[NT2001]: 'loopA' arg 1 expects (number)=>void, got (number)=>number
 *
 * node prints `1`. tsc accepts it — a block-bodied arrow with no `return` HAS return type
 * `void` (TypeScript spec §"Arrow function expressions"; conformance
 * tests/cases/conformance/types/typeRelationships/assignmentCompatibility and the
 * `voidReturn` shapes). And the refusal had NO ESCAPE HATCH: annotating the arrow
 * `(x): void => { … }` was refused with the identical message, because `typeArrowReturn`
 * maps a `void` annotation to "no declared type" and falls through to the same inference.
 * So there was no spelling of a statement callback that a `=> void` parameter accepted.
 *
 * FIXED BY MAKING THE TYPE TRUE, not by widening assignability. `(P)=>R` fitting a
 * `(P)=>void` slot for any `R` is TypeScript's actual rule, but it is not safe to adopt
 * HERE: a `=> void` parameter is CALLED as `call void %fp(…)` (verified in the emitted IR),
 * so accepting an arrow that codegen lowers as `define double @arrow_0` would put a
 * return-type mismatch into the IR and rest the answer on ABI luck. Instead the arrow's
 * return type BECOMES `void` when the body cannot produce a value, which is what it
 * already meant — codegen's arrow path handles `void` (`ret void`) and the two sides then
 * agree by construction rather than by tolerance.
 *
 * WHY THIS IS SAFE IN THE ONLY DIRECTION IT MOVES: the rewrite applies only when the body
 * has no value-carrying `return` ANYWHERE, so there is no value for a caller to lose. A
 * body with `return 1;` in it keeps inferring `number` and keeps being refused.
 *
 * `src/ownership.ts`'s `Analyzer.arrowScope` is the self-hosting instance —
 * `this.loop(state, (st) => { this.scoped(list, st); })`.
 */
describe("a statement arrow with no `return` fits a `=> void` parameter", () => {
  test("unannotated, block body, no return", async () => {
    await same(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(1, (x) => { console.log(x); });\n',
    );
  });

  test("the `(x): void => { … }` spelling, which was refused identically", async () => {
    await same(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(2, (x): void => { console.log(x); });\n',
    );
  });

  test("a bare `return;` still counts as returning nothing", async () => {
    await same(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(3, (x) => { if (x > 0) { console.log(x); return; } console.log(0); });\n',
    );
  });

  test("the `Analyzer.arrowScope` shape: a method call through `this`", async () => {
    await same(
      'class A {\n' +
      '  private scoped(list: string[], st: Map<string, number>): void {\n' +
      '    console.log(list.length + st.size);\n' +
      '  }\n' +
      '  private loop(state: Map<string, number>, iter: (st: Map<string, number>) => void): void { iter(state); }\n' +
      '  run(list: string[], state: Map<string, number>): void {\n' +
      '    this.loop(state, (st) => { this.scoped(list, st); });\n' +
      '  }\n' +
      '}\n' +
      'const a = new A();\n' +
      'a.run(["x"], new Map<string, number>());\n',
    );
  });

  /* NOT over-accepted: a body that DOES produce a value keeps the refusal, because the
   * value would be silently discarded and the emitted signatures would disagree. */
  test("a body with a value-carrying `return` is still refused", () => {
    const d = rejectionOf(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(1, (x) => { return x + 1; });\n',
    );
    expect(d?.code).toBe("NT2001");
    expect(d?.message).toContain("=>void");
  });

  /* And the value-carrying `return` is found at DEPTH, not only at the top level —
   * `inferBlockReturn` scans top-level returns only, so a nested one must not be able to
   * sneak a `double`-returning body into a `call void` slot. */
  test("a nested value-carrying `return` is still refused", () => {
    const d = rejectionOf(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(1, (x) => { if (x > 0) { return x + 1; } });\n',
    );
    expect(d?.code).toBe("NT2001");
  });

  /* A nested ARROW's `return` belongs to that arrow, not to this one. */
  test("a nested arrow's `return` does not make the outer body value-carrying", async () => {
    await same(
      'function loopA(n: number, iter: (x: number) => void): void { iter(n); }\n' +
      'loopA(4, (x) => { const g = (y: number): number => { return y + x; }; console.log(g(1)); });\n',
    );
  });
});
