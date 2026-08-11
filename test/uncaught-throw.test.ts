/*
 * UNCAUGHT `throw` (NT1004's first relaxation).
 *
 * A `throw` is lowered as a BRANCH to its enclosing `try`'s catch block, so one that has
 * no `try` in the same function has, until now, been refused outright (NT1004) — the
 * refusal covered both the throw that CROSSES a frame (needs propagation the runtime does
 * not have) and the throw that is simply never caught by anybody, which needs nothing at
 * all: node prints the error to stderr and exits 1, and the pending-exception protocol
 * (`nt_exc_raise_msg` + `nt_exc_abort`) already does exactly that for a top-level host
 * failure.
 *
 * This file pins the second class. node is the oracle for stdout AND the exit code; the
 * stderr TEXT is a documented divergence (node prints a stack trace, we print one line) —
 * see docs/divergences.md, "An UNCAUGHT `throw` compiles".
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

async function differential(src: string): Promise<void> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("uncaught throw (differential vs node)", () => {
  test("top-level throw after output: stdout survives, exit 1", async () => {
    await differential(`console.log("before");\nthrow new Error("boom");\n`);
  });

  test("a function throws and the program has no `try` anywhere", async () => {
    await differential(`function f(n: number): number { if (n < 0) throw new Error("neg"); return n; }\nconsole.log(f(2));\nconsole.log(f(-1));\n`);
  });

  // A rethrow from a `catch` is NOT caught by its own `try`, and at top level nothing
  // else can catch it either — so it needs no propagation, only the abort.
  test("rethrow from a catch block at top level", async () => {
    await differential(`try { throw new Error("a"); } catch (e) { console.log("caught"); throw new Error("b"); }\n`);
  });

  // Same shape, and it pins the ORDER: the finalizer's output precedes the abort.
  test("throw from a finally block at top level", async () => {
    await differential(`try { console.log(1); } finally { console.log(2); throw new Error("b"); }\n`);
  });

  test("throw of a bare string", async () => {
    await differential(`console.log("a");\nthrow "plain";\n`);
  });

  // A throw whose value carries no message string has nothing to raise, so it keeps the
  // NT1004 refusal rather than inventing text — reject, never miscompile.
  test("`throw 42` is still refused (no message to raise)", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() => emitIR(`throw 42;\n`)).toThrow(/not inside a `try`/);
  });
});

/*
 * THE `catch (e)` BINDING TYPE — a PRE-EXISTING silent wrong answer, found on the way.
 *
 * `catch (e)`'s type is inferred by `Checker.inferThrowType`, which scans the try block for
 * the FIRST `throw` it can see, and codegen's `ThrowStmt` then stores the thrown value RAW
 * into that binding's slot — no coercion, no check. Two ways that goes wrong, and both did:
 *
 *   1. the scan does not descend into a `switch`, so a `throw new Error(…)` inside one left
 *      the binding at its `"string"` default and `console.log(e)` called `js_print_str` on an
 *      object block — `}@` on stdout, AT EXIT 0, where node prints `Error: boom`;
 *   2. two throws of DIFFERENT types in one block: the second one writes its value under the
 *      first one's type, so `e.message` read the first eight bytes of a string as a pointer.
 *
 * (1) is fixed by teaching the scan about `switch`. (2) cannot be fixed by inference — node's
 * `catch` binding is `any` and this compiler has no such type — so it is REFUSED at the store,
 * which is also the backstop that makes the whole class impossible rather than case-by-case.
 */
describe("the catch binding is typed from the throw, exactly or not at all", () => {
  test("a throw inside a `switch` inside the try (was `}@` at exit 0)", async () => {
    await differential([
      `function f(n: number): void {`,
      `  try {`,
      `    switch (n) {`,
      `      case 1: throw new Error("boom");`,
      `      default: console.log("none");`,
      `    }`,
      `  } catch (e) {`,
      `    console.log(e.message);`,
      `  }`,
      `}`,
      `f(1);`,
      `f(2);`,
      ``,
    ].join("\n"));
  });

  /*
   * A METHOD call's raise, which `calleesOf` deliberately did not collect.
   *
   * The exclusion was reasoned — a method resolves by PROPERTY name, and pulling in every
   * same-named method in the program would let two unrelated ones disagree and turn
   * `inferThrowType` into a refusal on a block whose real callee raises one type. But the
   * cost was paid on ordinary TypeScript: node prints `code E9` for the program below and
   * we refused it, `Property 'code' does not exist on string`, because the binding fell to
   * the `"string"` default.
   *
   * Resolved by UNANIMITY rather than by picking: every `FuncDecl` whose linked name ends
   * in `.<prop>` contributes, and disagreement DECLINES (falls back to today's default)
   * instead of refusing. So the over-approximation the comment warned about can only ever
   * cost the inference, never a program.
   */
  test("a raise from a METHOD call types the catch binding", async () => {
    await differential([
      `class MyErr extends Error {`,
      `  code: string;`,
      `  constructor(code: string) { super(code); this.code = code; }`,
      `}`,
      `class Runner {`,
      `  go(): void { throw new MyErr("E9"); }`,
      `}`,
      `const r = new Runner();`,
      `try {`,
      `  r.go();`,
      `} catch (e) {`,
      `  if (e instanceof MyErr) { console.log("code", e.code); } else { console.log("other"); }`,
      `}`,
      ``,
    ].join("\n"));
  });

  test("two same-named methods that DISAGREE decline — the refusal is unchanged", async () => {
    // The guard on the unanimity rule. `go` raises two different shapes across two
    // classes, so the inference must answer "cannot say" and leave the binding at today's
    // default — never PICK an arm, which would store a raise into a slot of the wrong
    // shape (the silent-wrong-answer class `ThrowStmt` and `emitExcCheck` refuse from the
    // other side).
    //
    // Asserted as a REFUSAL because that is the truth: this program is NT1004 both before
    // and after the change, and for a reason unrelated to the inference (a cross-frame
    // raise needs every call site inside a `try`). What matters is that it is the SAME
    // refusal — declining costs nothing that was working.
    const { emitIR } = await import("./harness.ts");
    const src = [
      `class A { go(): void { throw new Error("a"); } }`,
      `class B { go(): void { throw "b"; } }`,
      `const a = new A();`,
      `const b = new B();`,
      `try { a.go(); } catch (e1) { console.log("A", e1); }`,
      `try { b.go(); } catch (e2) { console.log("B", e2); }`,
      ``,
    ].join("\n");
    let code = "";
    try { emitIR(src); } catch (e) { code = (e as { diag?: { code: string } }).diag?.code ?? "throw"; }
    expect(code).toBe("NT1004");
  });

  test("two throws of DIFFERENT types in one try are refused, not stored raw", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR(`function f(n: number): void {\n  try {\n    if (n > 0) throw new Error("boom");\n    throw "plain";\n  } catch (e) {\n    console.log(e.message);\n  }\n}\nf(1);\nf(0);\n`),
    ).toThrow(/catch/i);
  });
});

/*
 * A `try` WITH A `finally` AND NO `catch` IS NOT A HANDLER — a pre-existing raw-clang-error
 * bug in the same lowering.
 *
 * `TryStmt` pushed `{catchLbl, …}` onto `tryHandlers` unconditionally, but only EMITTED the
 * block named by `catchLbl` when the try had a `catch`. So a `throw` (or any fallible host
 * call, through `emitExcCheck`) inside a `try { … } finally { … }` terminated its block with
 * `br label %catchN` where `%catchN` never exists — and the failure surfaced as
 *
 *     build error: clang failed (1): … error: use of undefined value '%catch1'
 *
 * naming a temp path and a line of our own IR. That is precisely the outcome CLAUDE.md
 * forbids (an NT**** with a hint, always), and it was reachable from three ordinary shapes:
 * a `throw` in a catch-less `try`, the same nested inside an outer `try`/`catch`, and a
 * `JSON.parse` failure in a catch-less `try`.
 *
 * node's semantics here are unambiguous — `finally` does not CATCH, it runs on the way out
 * and the exception keeps propagating — and reproducing that means running the finalizer on
 * the exceptional path, which the lexical (branch-to-catch) throw model has no way to do.
 * So it is REFUSED, with a message that says which construct it is. The refusal is strictly
 * better than the clang error, and it is where NT1004's boundary actually falls.
 */
describe("a catch-less `try` is not a handler (was: invalid IR, raw clang error)", () => {
  test("a `throw` inside `try { … } finally { … }` is NT1004, not a clang error", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR(`try {\n  console.log(1);\n  throw new Error("b");\n} finally {\n  console.log(2);\n}\n`),
    ).toThrow(/finally/);
  });

  test("nested: the inner catch-less `try` is refused even under an outer `catch`", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR(`try {\n  try {\n    throw "boom";\n  } finally {\n    console.log("inner");\n  }\n} catch (e) {\n  console.log(e);\n}\n`),
    ).toThrow(/finally/);
  });

  test("a fallible HOST call inside a catch-less `try` is refused the same way", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR(`try {\n  const v = JSON.parse("{oops");\n  console.log(1);\n} finally {\n  console.log(2);\n}\n`),
    ).toThrow(/finally/);
  });

  // THE HINT MUST COMPILE. It tells the reader to give the `try` a `catch`; this is that
  // program, run against node.
  test("the hint's advice — add a `catch` — compiles and matches node", async () => {
    await differential(`try {\n  console.log(1);\n  throw new Error("b");\n} catch (e) {\n  console.log(e.message);\n} finally {\n  console.log(2);\n}\n`);
  });

  test("the hint's advice compiles for the HOST-call shape too", async () => {
    await differential([
      `function f(): number {`,
      `  try {`,
      `    const v = JSON.parse("{oops");`,
      `    return 1;`,
      `  } catch (e) {`,
      `    console.log("caught");`,
      `    return 0;`,
      `  } finally {`,
      `    console.log("finally ran");`,
      `  }`,
      `}`,
      `console.log(f());`,
      ``,
    ].join("\n"));
  });

  // The catch-less `try` itself is untouched when nothing throws out of it, including the
  // `return`-through-`finally` path the mode slot exists for.
  test("`try`/`finally` with no exception still works, including `return`", async () => {
    await differential(`function f(n: number): number {\n  try {\n    return n * 2;\n  } finally {\n    console.log("cleanup");\n  }\n}\nconsole.log(f(3));\n`);
  });
});

/*
 * THE PAYLOAD THE PENDING FLAG CANNOT CARRY — and it was a SILENT WRONG ANSWER, which is
 * the one outcome this compiler exists not to produce.
 *
 * A raise crosses a frame on the runtime's pending-exception slot, which is one
 * `const char *`. So `emitExcCheck` can reconstruct a catch binding for exactly two
 * shapes: a `string`, and the one-field `{message:string}` it boxes the message into.
 * For ANY OTHER object type it stored nothing at all and branched to the handler anyway —
 * leaving the binding at whatever its uninitialised alloca held, and the handler then read
 * that as an object pointer.
 *
 * Measured on the program below, which has a two-field catch type and a `JSON.parse` that
 * really does raise into the same handler:
 *
 *     node     -> "Thrown\nSyntaxError\n", exit 0
 *     nativets -> "Thrown\n\xef\xbf\xbd\n",  exit 0     <- garbage, and a ZERO exit code
 *
 * Not a crash, not a diagnostic: a wrong answer that reported success. It is now NT1004.
 */
describe("a raise whose payload the catch binding cannot be rebuilt from is refused", () => {
  test("a fallible call under a catch type the flag cannot carry is NT1004", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR([
        `function run(k: number): string {`,
        `  try {`,
        `    if (k < 0) throw { message: "explicit", name: "Thrown" };`,
        `    const v = JSON.parse("{");`,
        `    return "parsed";`,
        `  } catch (e) {`,
        `    return e.name;`,
        `  }`,
        `}`,
        `console.log(run(-1));`,
        ``,
      ].join("\n")),
    ).toThrow(/cannot rebuild/);
  });

  // The two shapes that CAN be rebuilt are untouched — this is the regression guard on the
  // refusal being narrow, since widening it would take working programs down with it.
  //
  // Asserted on the EXPLICIT throw only. The same handler also catches the `JSON.parse`
  // failure, but there node hands it an `Error` where we hand it the rebuilt shape — so
  // `e.length` is `undefined` under node and a real length here, a divergence of the catch
  // binding's model (node's is `any`) and not of this refusal. The host-failure path is
  // still exercised below; it is only its BINDING that is not an oracle question.
  test("a string binding and an Error binding still compile and match node", async () => {
    const src = [
      `function s(k: number): string {`,
      `  try { if (k < 0) throw "explicit"; const v = JSON.parse("{"); return "parsed"; }`,
      `  catch (e) { return e; }`,
      `}`,
      `function m(k: number): string {`,
      `  try { if (k < 0) throw new Error("explicit"); const v = JSON.parse("{"); return "parsed"; }`,
      `  catch (e) { return e.message; }`,
      `}`,
      `console.log(s(-1));`,
      `console.log(m(-1));`,
      ``,
    ].join("\n");
    await differential(src);

    // …and the HOST-failure path through the very same handlers still compiles and runs:
    // it is the path the refusal above had to leave alone, so "it is not refused" is the
    // property, and the binding's text is deliberately not compared.
    const host = await compileAndRun(src.replace("console.log(s(-1));", "console.log(s(1).length > 0);").replace("console.log(m(-1));", "console.log(m(1).length > 0);"));
    expect(host.exitCode).toBe(0);
    expect(host.stdout).toBe("true\ntrue\n");
  });

  // THE HINT MUST NOT LIE. It offers two fixes; this is each of them, applied to the
  // refused program above and run against node.
  test("the hint's first fix — move the fallible call out of the `try` — compiles", async () => {
    await differential([
      `function run(k: number): string {`,
      `  try {`,
      `    if (k < 0) throw { message: "explicit", name: "Thrown" };`,
      `    return "parsed";`,
      `  } catch (e) {`,
      `    return e.name;`,
      `  }`,
      `}`,
      `console.log(run(-1));`,
      `console.log(run(1));`,
      ``,
    ].join("\n"));
  });

  test("the hint's second fix — a `try` per payload shape — compiles", async () => {
    await differential([
      `function run(k: number): string {`,
      `  try {`,
      `    if (k < 0) throw { message: "explicit", name: "Thrown" };`,
      `  } catch (e) {`,
      `    return e.name;`,
      `  }`,
      `  try {`,
      `    const v = JSON.parse("{");`,
      `    return "parsed";`,
      `  } catch (e2) {`,
      `    return "syntax";`,
      `  }`,
      `}`,
      `console.log(run(-1));`,
      `console.log(run(1));`,
      ``,
    ].join("\n"));
  });
});
