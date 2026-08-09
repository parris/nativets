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

  test("two throws of DIFFERENT types in one try are refused, not stored raw", async () => {
    const { emitIR } = await import("./harness.ts");
    expect(() =>
      emitIR(`function f(n: number): void {\n  try {\n    if (n > 0) throw new Error("boom");\n    throw "plain";\n  } catch (e) {\n    console.log(e.message);\n  }\n}\nf(1);\nf(0);\n`),
    ).toThrow(/catch/i);
  });
});
