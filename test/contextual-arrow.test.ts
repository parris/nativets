/*
 * CONTEXTUAL TYPING of an arrow's parameters from the annotation it is assigned to.
 *
 *     const defaultRead: ReadModule = (p) => readFileSync(p, "utf8");   // src/modules.ts:41
 *
 * `[NT2001] cannot infer type of arrow parameter 'p'`, and it was src/modules.ts's first
 * standalone blocker. tsc types `p` as `string` from `ReadModule`; node runs the program.
 *
 * The machinery already existed and exactly ONE path dropped it. `typeArrow(arrow,
 * expected, scope)` consumes `expected` correctly, and the declaration checker already
 * threads the annotation in as `this.type(d.init, scope, d.annot)` — but the dispatch was
 *     case "ArrowFunction": return this.typeArrow(e, undefined, scope);
 * so the hint reached `infer` and was thrown away. Both call sites that DID pass an
 * expected type (an argument in a call, `typeArg`) worked, which is why a contextually
 * typed CALLBACK has always compiled and a contextually typed BINDING never has.
 *
 * WHAT IS PINNED HERE is the precedence rule, all three arms — an explicit parameter
 * annotation beats the context, the context beats a default, and a default applies when
 * there is neither — plus the four ways the context can FAIL to supply a type, each of
 * which must refuse rather than guess.
 *
 * Cases are DERIVED from the src/modules.ts:41 blocker and from tsc's behavior on each
 * shape (quoted at the test). The TypeScript conformance suite's contextual-typing
 * directory (tests/cases/conformance/expressions/contextualTyping/) is about function
 * ARGUMENTS, which already worked here; nothing there covers the dropped-hint bug.
 */

import { test, expect, describe } from "bun:test";

import { sourceToIR } from "../src/driver.ts";
import { compileAndRun, runWithNode } from "./harness.ts";

async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("an arrow takes its parameter types from the annotation it is assigned to", () => {
  // The blocker itself, reduced: an inline function-type annotation.
  test("an inline function-type annotation types the parameter", async () => {
    await same('const f: (path: string) => number = (p) => p.length;\nconsole.log(f("abcd"));\n');
  });

  // The blocker as WRITTEN — through a `type` alias, which is how src/modules.ts:41 and
  // most of the compiler's own source spell it.
  test("a `type` alias for a function type does the same", async () => {
    await same(
      'type ReadModule = (path: string) => number;\n' +
      'const read: ReadModule = (p) => p.length;\n' +
      'console.log(read("abc"));\n',
    );
  });

  test("every parameter, not just the first", async () => {
    await same(
      'const f: (a: string, b: number) => string = (x, y) => x + y;\n' +
      'console.log(f("n=", 4));\n',
    );
  });
});

/*
 * PRECEDENCE — annotation, then context, then default. All three arms, because the
 * comment in `typeArrow` now claims exactly this and a claim in a comment is worth
 * nothing without a test that fails when it stops being true.
 */
describe("precedence: annotation > contextual type > default", () => {
  // An explicit parameter annotation BEATS the context. Observable because the two
  // disagree in a way the body can see: `x.length` is only legal on the annotation.
  // (tsc agrees the annotation wins, and then rejects the assignment — see the refusal
  // block below, which pins that we reject it too rather than silently preferring one.)
  test("an explicit parameter annotation wins over the context", async () => {
    await same(
      'const f: (a: string) => number = (x: string) => x.length;\n' +
      'console.log(f("abcd"));\n',
    );
  });

  // The CONTEXT beats the default. `n` is `string` here, so `n + n` concatenates; if the
  // default won it would be `number` and print 2 instead of "aa".
  test("the contextual type wins over a default", async () => {
    await same(
      'const f: (a: string) => string = (n = "z") => n + n;\n' +
      'console.log(f("a"));\n',
    );
  });

  // …and with neither, the default supplies it (the parameter-default lane's rule, pinned
  // here too because this path now runs through the same expression).
  test("the default applies when there is no annotation and no context", async () => {
    await same('const f = (n = 1) => n + 1;\nconsole.log(f(5));\n');
  });
});

/*
 * WHERE THE CONTEXT CANNOT SUPPLY A TYPE. Accepting more programs is the whole point of
 * this change, so the risk is guessing on the ones it must not accept. Every shape below
 * is REFUSED, and refusal is the right answer for each: three are programs tsc also
 * rejects, and the fourth (an arrow with fewer parameters than its target) is legal
 * TypeScript that nativets declines for an unrelated, pre-existing reason.
 */
describe("a context that cannot type the parameter refuses, never guesses", () => {
  // tsc: "Target signature provides too few arguments. Expected 2 or more, but got 1."
  // Our answer names the parameter that has no context, which is the actionable half.
  test("the arrow has MORE parameters than the target signature", () => {
    expect(() => sourceToIR('const f: (a: string) => number = (p, q) => p.length + q;\nconsole.log(f("a"));\n'))
      .toThrow(/cannot infer type of arrow parameter 'q'/);
  });

  // Legal TypeScript (JS ignores extra arguments) and node runs it. We refuse it, and NOT
  // because of this change: a nativets function type is compared exactly, so `(string)=>
  // number` is not assignable to `(string,number)=>number`. Pinned as the boundary — the
  // contextual hint now flows, and the arity rule behind it did not move.
  test("the arrow has FEWER parameters than the target signature — still refused", () => {
    expect(() => sourceToIR('const f: (a: string, b: number) => number = (p) => p.length;\nconsole.log(f("a", 1));\n'))
      .toThrow(/'f' declared \(string,number\)=>number but initialized with \(string\)=>number/);
  });

  // tsc: "Type '(x: number) => number' is not assignable to type '(a: string) => number'."
  // The annotation wins (so the arrow is `(number)=>number`), and the DECLARATION check
  // behind it is what catches the mismatch — the hint never silently overrides a written
  // parameter type.
  test("a parameter annotated incompatibly with the context", () => {
    expect(() => sourceToIR('const f: (a: string) => number = (x: number) => x;\nconsole.log(f("a"));\n'))
      .toThrow(/declared \(string\)=>number but initialized with \(number\)=>number/);
  });

  // A hint that is not a function type at all supplies nothing, so the parameter falls
  // back to "no context" and the pre-existing NT2001 stands. NT2001 is still the right
  // code for all of these: they are our type rules rejecting a program, not a feature we
  // have not built. Nothing here needs a new NT1xxx.
  test("a non-function annotation supplies no context", () => {
    expect(() => sourceToIR("const f: number = (p) => p;\nconsole.log(f);\n"))
      .toThrow(/cannot infer type of arrow parameter 'p'/);
  });
});
