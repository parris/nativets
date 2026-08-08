/*
 * Passing an object literal to a parameter whose type has OPTIONAL properties.
 *
 *     interface Opts { a?: number }
 *     function f(o: Opts): number { return o.a ?? 0; }
 *     f({ a: 1 })   // node: 1
 *
 * This was rejected — `[NT2001] 'f' arg 0 expects {a:?Unumber}, got {a:number}` — while
 * the DECLARATION form of the same assignment (`const o: Opts = { a: 1 }`) compiled and
 * ran correctly. The difference was not the assignability rule: `assignable()` already
 * handles optional fields structurally. It was that the declaration path RESHAPES the
 * literal to the declared slot layout (`retypeLiteral`) and the argument path did not.
 *
 * WHY THE STDOUT+EXIT-CODE ASSERTIONS BELOW MATTER MORE THAN THE USUAL ONES. Widening the
 * assignability predicate ALONE — accepting the call without reshaping the literal — makes
 * these programs compile and then die: exit 255, empty stdout, measured. The caller builds
 * `{a:1}` as one raw double slot while the callee reads slot 0 as an i64, `inttoptr`s it
 * and dereferences it as a nullable box. So a test that only asserted "compiles" or only
 * checked the diagnostic would PASS on the memory-unsafe version. Every case here pins the
 * node-differential result — stdout AND exit code — which is the only thing that
 * distinguishes the fix from the miscompile.
 *
 * Cases are hand-derived from the blocker (src/coverage.ts:162 passes an all-present
 * literal to `parse(source, opts: ParseOpts = {})`). There is no TypeScript conformance
 * checkout or test262 on this machine to mine.
 */

import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile+run and `node`-run the same source; both streams must agree exactly. */
async function matchesNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

const OPTS = "interface Opts { a?: number }\nfunction f(o: Opts): number { return o.a ?? 0; }\n";

describe("an object literal argument reshapes to an optional-property parameter", () => {
  test("the optional field is PRESENT", async () => {
    await matchesNode(`${OPTS}console.log(f({ a: 1 }));\n`);
  });

  test("the optional field is OMITTED", async () => {
    await matchesNode(`${OPTS}console.log(f({}));\n`);
  });

  // Present but explicitly `undefined`. node reads the property, gets `undefined`, and
  // `?? 0` yields 0 — the same answer as omitting it, by a different route.
  test("the optional field is PRESENT-BUT-UNDEFINED", async () => {
    await matchesNode(`${OPTS}console.log(f({ a: undefined }));\n`);
  });

  // Several optionals of mixed types, exercising every present/absent combination — the
  // reshape has to fill the right slots, not merely the right NUMBER of slots.
  test("multiple optional fields, each combination of present and absent", async () => {
    await matchesNode(
      "interface Opts { a?: number; b?: string; c?: number }\n" +
      "function f(o: Opts): string { return `${o.a ?? -1}|${o.b ?? \"x\"}|${o.c ?? -1}`; }\n" +
      "console.log(f({ a: 1 }));\nconsole.log(f({ b: \"hi\", c: 3 }));\n" +
      "console.log(f({ a: 1, b: \"hi\", c: 3 }));\nconsole.log(f({}));\n",
    );
  });

  test("a required field alongside an optional one", async () => {
    await matchesNode(
      "interface Opts { req: number; a?: string }\n" +
      "function f(o: Opts): string { return `${o.req}|${o.a ?? \"none\"}`; }\n" +
      "console.log(f({ req: 5 }));\nconsole.log(f({ req: 5, a: \"yes\" }));\n",
    );
  });

  // Nesting falls out of `retypeLiteral` recursing into the field types, which is the
  // whole reason for reusing the declaration path rather than special-casing the top level.
  test("an optional field NESTED inside an object field", async () => {
    await matchesNode(
      "interface Inner { x?: number }\ninterface Outer { in: Inner; tag?: string }\n" +
      "function f(o: Outer): string { return `${o.in.x ?? -1}|${o.tag ?? \"t\"}`; }\n" +
      "console.log(f({ in: { x: 2 } }));\nconsole.log(f({ in: {}, tag: \"z\" }));\n",
    );
  });
});

/*
 * The same reshape, on a parameter DEFAULT — and this half was a live miscompile on main,
 * reachable with no imports and nothing from this lane:
 *
 *     function g(s: string, o: Opts = {}): number { return s.length + (o.a ?? 0); }
 *     g("abc")   // node: 3 | nativets before this lane: empty stdout, exit 255
 *
 * The default literal was materialized in its OWN layout — `nt_obj_new(0)`, zero slots —
 * while the body reads slot 0 as a pointer to a nullable box, which is what `{a?: number}`
 * is. Reading off the end of a 0-slot object. It compiled clean and crashed at runtime, so
 * no diagnostic test could have caught it; only the differential does.
 *
 * `parse(source: string, opts: ParseOpts = {})` (src/parser.ts:2043) is exactly this shape.
 */
describe("a parameter DEFAULT literal reshapes to the parameter's layout", () => {
  const G = "interface Opts { a?: number }\n" +
    "function g(s: string, o: Opts = {}): number { return s.length + (o.a ?? 0); }\n";

  test("the default is used (was: exit 255, empty stdout)", async () => {
    await matchesNode(`${G}console.log(g("abc"));\n`);
  });

  test("the default and an explicit literal, in one program", async () => {
    await matchesNode(`${G}console.log(g("abc"));\nconsole.log(g("x", { a: 5 }));\n`);
  });
});

/*
 * `new C(...)` and `Cls.method(...)` — the SAME reshape, on the two argument paths that
 * do not go through `inferCall`.
 *
 * These were WORSE than the plain-call case, and worse in the dangerous direction. The
 * constructor arg check (checker.ts:1881) called `assignable` DIRECTLY rather than
 * `fitsParam`, so it already ACCEPTED a structurally-compatible object literal — and then
 * never reshaped it. Accept-without-reshape is exactly the crash: where an ordinary call
 * safely rejected, `new C({a: 1})` compiled and died.
 *
 *     class Parser { constructor(opts: ParseOpts = {}) { ... } }
 *     new Parser({ typeEnv: 10 })   // node: 10 | before: empty stdout, exit 255
 *
 * IR before, for the three call sites of the test below: `nt_obj_new(2.0)` for the DEFAULT
 * (correct — the default fix landed first), but `nt_obj_new(1.0)` with a raw double in
 * slot 0 for `{typeEnv: 10}`, and `nt_obj_new(0.0)` — zero slots — for `{}`. After: all
 * three are `nt_obj_new(2.0)` with proper 2-slot boxes.
 *
 * This is `src/parser.ts:158` exactly: `constructor(private toks: Token[], opts: ParseOpts = {})`.
 */
describe("`new C(...)` reshapes its object-literal arguments too", () => {
  const P = "interface ParseOpts { typeEnv?: number; asyncEnv?: number }\n" +
    "class Parser {\n  te: number;\n" +
    "  constructor(opts: ParseOpts = {}) { this.te = opts.typeEnv ?? -1; }\n" +
    "  n(): number { return this.te; }\n}\n";

  test("the default, an explicit literal, and an explicit empty literal", async () => {
    await matchesNode(`${P}console.log(new Parser().n());\nconsole.log(new Parser({ typeEnv: 10 }).n());\nconsole.log(new Parser({}).n());\n`);
  });
});

/*
 * THE BOUNDARY, pinned deliberately.
 *
 * Only an object LITERAL is reshaped, so only an object literal is accepted. A variable
 * of a structurally-compatible type already has its layout fixed by its own declaration —
 * `const v = { a: 1 }` is one raw double slot — and there is no literal at the call site
 * to rewrite. Passing it would need codegen to COPY it into the parameter's layout at the
 * call site, which is a different feature (structural coercion) and is not implemented.
 *
 * So this stays REFUSED even though node runs it (prints 1, exit 0 — verified). That is a
 * false rejection, and it is the correct trade: accepting it on the assignability
 * predicate alone is exactly the exit-255 memory bug this lane exists to avoid. This test
 * fails the moment someone widens `fitsArg` past literals without teaching codegen to copy.
 */
describe("what is deliberately NOT reshaped", () => {
  test("a non-literal argument of a compatible type is still refused", () => {
    const src = "interface Opts { a?: number }\n" +
      "function f(o: Opts): number { return o.a ?? 0; }\n" +
      "const v = { a: 1 };\nconsole.log(f(v));\n";
    let err: unknown;
    try { sourceToIR(src, "entry.ts"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    expect((err as NTError).diag.code).toBe("NT2001");
    // node accepts it — recorded so the divergence is deliberate, not forgotten.
    expect(runWithNode(src).stdout).toBe("1\n");
  });

  /*
   * THE SAME BOUNDARY, IN THE DECLARATION PATH — where it was never enforced.
   *
   * The argument path refuses a non-literal because there is nothing to reshape. The
   * DECLARATION path ran the identical `assignable` predicate and then called
   * `retypeLiteral`, which is a NO-OP on anything that is not a literal — so it
   * ACCEPTED the call and emitted the miscompile the test above exists to prevent:
   *
   *     type Opts = { a?: number };
   *     const src = { a: 1 };
   *     const o: Opts = src;        // accepted
   *     console.log(o.a ?? 0);      // exit 255, EMPTY stdout; node prints 1
   *
   * `src` is one raw double slot; `o` is read as a pointer to a nullable box, so slot 0
   * is `inttoptr`'d and dereferenced. Measured on main before this change. It is the
   * worst outcome available — a program that compiles clean and dies — and it was
   * reachable from ordinary TypeScript with no unsafe construct anywhere.
   *
   * Refused now, exactly as the argument path refuses it, and with the same reasoning:
   * accepting it needs codegen to COPY into the target layout, which is a feature
   * (structural coercion) rather than a predicate change.
   */
  test("a non-literal INITIALIZER of a compatible type is refused, not miscompiled", () => {
    const src = "type Opts = { a?: number };\n" +
      "const v = { a: 1 };\nconst o: Opts = v;\nconsole.log(o.a ?? 0);\n";
    let err: unknown;
    try { sourceToIR(src, "entry.ts"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    expect((err as NTError).diag.code).toBe("NT2001");
    expect(runWithNode(src).stdout).toBe("1\n");
  });

  test("...and the literal form of the same declaration still compiles and runs", async () => {
    await matchesNode("type Opts = { a?: number };\nconst o: Opts = { a: 1 };\nconsole.log(o.a ?? 0);\n");
  });
});
