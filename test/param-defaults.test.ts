/*
 * Parameter defaults, and the SCOPE they are typed in.
 *
 * `src/ownership.ts` was blocked by `[NT2001] 'NO_MUTABLE' is not defined` on
 *     constructor(..., private mutable: MutableInfo = NO_MUTABLE, ...)
 * naming a `const` declared 84 lines above it (src/ownership.ts:68). Not a missing
 * feature — the signature pass typed EVERY default against a builtins-only scope, so no
 * identifier in a default could resolve: not a module const, not a `let`, not a preceding
 * parameter. Only calls resolved, because those go through the function table.
 *
 * The working half is a node-differential fixture
 * (test/fixtures/selfhost-scan/param-default-scope.ts). What is pinned HERE is the
 * BOUNDARY — the shapes that must keep being refused, and why. Cases are hand-derived
 * from the blocker, not taken from a reference suite; there is no TypeScript checkout or
 * test262 on this machine to mine.
 */

import { test, expect, describe } from "bun:test";

import { sourceToIR } from "../src/driver.ts";
import { compileAndRun, runWithNode } from "./harness.ts";

/** Differential: our stdout+exit must equal node's. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/*
 * INFERRING A PARAMETER'S TYPE FROM ITS DEFAULT.
 *
 * `const advance = (n = 1) => {…}` (src/lexer.ts:146) was `[NT2001] cannot infer type of
 * arrow parameter 'n'` — a self-hosting blocker. TypeScript widens the default's literal
 * type: `n = 1` is `number`, `s = "a"` is `string`, `b = true` is `boolean`.
 *
 * Cases are MINED from the TypeScript conformance suite,
 * `tests/cases/conformance/es6/defaultParameters/` (emitDefaultParametersFunction.ts,
 * emitDefaultParametersFunctionExpression.ts, emitDefaultParametersMethod.ts) and
 * `tests/cases/conformance/functions/parameterInitializersForwardReferencing*.ts`, each
 * cited at its test. Evaluation-timing cases are node probes, quoted inline.
 */
describe("a parameter's type is inferred from its default", () => {
  // conformance: emitDefaultParametersFunctionExpression.ts — `var lambda1 = (y = "hello") => { }`
  // shape, with the numeric default that blocks src/lexer.ts:146.
  test("arrow: a numeric default gives `number`", async () => {
    await same('const f = (n = 1) => n + 1;\nconsole.log(f(5));\n');
  });

  // conformance: emitDefaultParametersFunctionExpression.ts — `var lambda1 = (y = "hello") => { }`.
  // `.length` is the point: a `number` guess would report "Property 'length' does not exist
  // on number", so this fails on anything but the string.
  test("arrow: a string default gives `string`", async () => {
    await same('const f = (y = "hello") => y.length;\nconsole.log(f("abcd"));\n');
  });

  /*
   * A PRE-EXISTING BUG this fix subsumes, found while scoping the arrow one.
   *
   * The signature pass already typed a named function's defaulted parameter correctly
   * (`params = p.annot ?? type(p.default)`) — but `checkFunction`, which types the BODY,
   * declared the very same parameter as `p.annot ?? "number"`, ignoring the default. So a
   * function's signature and its own body disagreed:
   *     function f(s = "abc") { return s.length; }   // [NT2001] Property 'length' does not exist on number
   *     function f(s = "abc") { return s + 1; }      // reached clang: '%t0' defined with type 'ptr' but expected 'double'
   * The second is worse than a bad diagnostic: a type error escaping the checker into a
   * raw clang failure. Both are the same one-line gap, and both are cases node runs fine
   * ("3", "abc1"). conformance: emitDefaultParametersFunction.ts — `function bar(y = 10) { }`.
   */
  test("named function: the BODY sees the type the default gives", async () => {
    await same('function f(s = "abc") { return s.length; }\nconsole.log(f());\nconsole.log(f("zzzzz"));\n');
  });

  /*
   * conformance: emitDefaultParametersMethod.ts —
   *     class C { public foo(x: string, t = false) { } public bar(t = false) { } }
   *     class D { constructor(y = "hello") { } }
   * A class member is desugared to an ordinary `FuncDecl` in the parser, so this is the
   * same code path; the test is here because "every parameter position, uniformly" is the
   * contract (the Stage-15 binding-pattern desugaring set that precedent) and a class body
   * is the one position a reader would expect to be handled elsewhere.
   */
  test("method and constructor: boolean and string defaults", async () => {
    await same(
      'class D {\n' +
      '  y: string;\n' +
      '  constructor(y = "hello") { this.y = y; }\n' +
      '  foo(x: string, t = false) { return t ? x + this.y : x; }\n' +
      '  bar(t = false) { return t; }\n' +
      '}\n' +
      'const d = new D();\n' +
      'console.log(d.foo("a", true));\n' +
      'console.log(d.foo("a", false));\n' +
      'console.log(d.bar(true));\n',
    );
  });

  /*
   * WHEN the default runs, not just what type it has. A default is an expression evaluated
   * at CALL time, once per call, and only when the argument is absent — it is not a
   * definition-time constant folded into the signature. node probe, verified:
   *     let calls = 0; function next(){ calls=calls+1; return calls }
   *     function f(n = next()){ return n }
   *     f() -> 1, f() -> 2, f(99) -> 99, calls -> 2
   * The `calls` line is the load-bearing one: it is 2, not 3, so passing an argument must
   * not evaluate the default at all. The parameter here is UNANNOTATED, so its type comes
   * from `next()`'s return type — inference and timing on the same program.
   */
  test("the default is evaluated at CALL time, once per call, and skipped when an argument is passed", async () => {
    await same(
      'let calls = 0;\n' +
      'function next() { calls = calls + 1; return calls; }\n' +
      'function f(n = next()) { return n; }\n' +
      'console.log(f());\n' +
      'console.log(f());\n' +
      'console.log(f(99));\n' +
      'console.log(calls);\n',
    );
  });
});

/*
 * THE ANNOTATION WINS — and therefore the default has to CONFORM to it.
 *
 * `function f(n: string = 1)` is `error TS2322: Type 'number' is not assignable to type
 * 'string'` in tsc. nativets typed the annotated default and RESHAPED it when it was
 * assignable, but did nothing at all when it was not, so the mismatch escaped the checker:
 *     function f(n: string = 1) { return n; }
 *     console.log(f());
 *     -> build error: clang failed: floating point constant invalid for type
 *            %t0 = call ptr @f(ptr 0x3FF0000000000000)
 * A raw clang error is the wrong failure mode for a program tsc rejects — the reader gets
 * LLVM IR instead of a diagnostic. It also demonstrates the annotation genuinely wins: the
 * slot is `ptr` (string), and the default was handed over as a raw double.
 */
describe("an annotation beats the default, and the default must fit it", () => {
  test("a default that does not fit the annotation is refused, not handed to clang", () => {
    expect(() => sourceToIR('function f(n: string = 1) { return n; }\nconsole.log(f());\n'))
      .toThrow(/parameter 'n' is declared string but its default is number/);
  });

  // The same rule in the same place for an ARROW. An arrow's annotated default was never
  // typed AT ALL before this lane — `typeArrow` did not look at `p.default` — so the
  // mismatch was simply invisible. It survives today only because a value-arrow's default
  // never fires (see the arity pin below); leaving it unchecked would make it a
  // miscompile the day it does.
  test("arrow: a default that does not fit the annotation is refused too", () => {
    expect(() => sourceToIR('const f = (n: string = 1) => n;\nconsole.log(f("a"));\n'))
      .toThrow(/parameter 'n' is declared string but its default is number/);
  });
});

/*
 * WHAT A DEFAULT MAY NOT BE. TypeScript answers `(xs = [])` with `any[]` and
 * `(x = undefined)` with `any` (or `undefined` under `strict`). Neither is a nativets
 * type, and picking one is a guess — so both are refused with a hint that names the two
 * ways out. Reject, never miscompile.
 */
describe("a default we cannot pin down to a type is REFUSED, not guessed", () => {
  // conformance-adjacent: `(xs = [])` is the parameter form of the empty-array ambiguity
  // NT1001 already owns for declarations. Same code, same hint, one layer down.
  test("`[]` — no element type, and no context to take one from", () => {
    expect(() => sourceToIR("const f = (xs = []) => xs.length;\nconsole.log(f([1]));\n"))
      .toThrow(/cannot infer the element type of an empty array literal/);
    expect(() => sourceToIR("function g(xs = []) { return xs.length; }\nconsole.log(g());\n"))
      .toThrow(/cannot infer the element type of an empty array literal/);
  });

  test("`undefined` and `null` carry no type", () => {
    expect(() => sourceToIR("const f = (x = undefined) => x;\nconsole.log(f(1));\n"))
      .toThrow(/cannot infer type of parameter 'x' from a default of `undefined`/);
    expect(() => sourceToIR("const f = (x = null) => x;\nconsole.log(f(1));\n"))
      .toThrow(/cannot infer type of parameter 'x' from a default of `null`/);
  });
});

/*
 * THE BOUNDARY THIS LANE DID NOT MOVE — pinned so the next reader does not have to
 * rediscover it, and so a future widening has a checkpoint.
 *
 * A parameter default is only half-supported for a VALUE ARROW. Its TYPE is now inferred
 * (everything above), but a nativets function type is `(number)=>number` — a flat list
 * with no notion of an optional parameter — so a short call to a closure has nothing to
 * consult, and `advance()` is refused on arity. A named function has a real signature
 * (`Sig.required`/`Sig.defaults`), which is why every "the default fires" case above is
 * written with `function`. Both refusals below are node-correct programs; both are
 * refusals, not wrong answers.
 */
describe("value-arrow defaults: still refused at the CALL, and deliberately so", () => {
  test("a short call to an arrow with a default is refused on arity", () => {
    expect(() => sourceToIR("const f = (n = 1) => n + 1;\nconsole.log(f());\n"))
      .toThrow(/'f' expects 1 arguments, got 0/);
  });

  // node: `f(undefined)` runs the default and prints 2. We refuse the ARGUMENT, so the
  // "explicit `undefined` triggers the default" rule is unreachable rather than wrong —
  // for named functions too, where the default itself does work.
  test("an explicit `undefined` argument is refused rather than triggering the default", () => {
    expect(() => sourceToIR("function f(n = 1) { return n + 1; }\nconsole.log(f(undefined));\n"))
      .toThrow(/expects number, got undefined/);
  });
});

describe("a parameter default is typed in the MODULE scope", () => {
  test("a default may name a module-level const", () => {
    expect(() => sourceToIR("const D = 7;\nfunction f(n: number = D): number { return n; }\nconsole.log(f());"))
      .not.toThrow();
  });

  /*
   * `function f(a, b = a)` is ordinary JavaScript — node evaluates the parameter list left
   * to right and prints 3 for `f(3)` (verified, exit 0). We REFUSE it deliberately:
   * codegen materializes defaults BEFORE the parameter allocas are stored, so accepting it
   * emits a load from an undefined `%a.addr` and clang rejects the module. A first draft of
   * the fix did exactly that:
   *     error: use of undefined value '%start.addr'
   * so this pin is what keeps a future widening of the scope honest — reject, never
   * miscompile. It was already GREEN before the fix (the builtins-only scope refused every
   * identifier, including this one); its value is as a regression guard, and it is
   * non-vacuous — declaring the parameters before typing the defaults makes it fail.
   */
  test("a default may NOT name a parameter to its left — refused, not miscompiled", () => {
    expect(() => sourceToIR("function f(a: number, b: number = a): number { return b; }\nconsole.log(f(3));"))
      .toThrow(/'a' is not defined/);
  });

  // Refused by the same rule, and must STAY refused however the one above is fixed:
  // node throws `ReferenceError: Cannot access 'a' before initialization` (TDZ), verified.
  test("a default may NOT name itself", () => {
    expect(() => sourceToIR("function f(a: number = a): number { return a; }\nconsole.log(f());"))
      .toThrow(/'a' is not defined/);
  });
});
