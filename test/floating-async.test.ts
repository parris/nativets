/*
 * FLOATING ASYNC CALLS (`NT1020`) — and the one exception, the `main();` entrypoint.
 *
 * Calling an `async` function without `await` returns a *Promise* under node and lets the
 * caller interleave. nativets runs the body to completion right there, so anything that
 * uses the value — or that expects other code to run while it is pending — silently
 * diverges. That is refused.
 *
 * THE EXCEPTION is `main();` as the LAST top-level statement. With nothing after it,
 * node's "suspend, run the rest, resume" and our "run it now" produce identical output,
 * so the canonical entrypoint is allowed. `parseProgram` decides that by asking whether a
 * given call IS the last statement's expression — an IDENTITY test on the AST node.
 *
 * WHY THESE EXIST NOW. That identity test used to read `body[body.length - 1]!.expr`,
 * binding an array element and then a linear field out of it — NT1605 twice, and one of
 * the refusals standing between `src/parser.ts` and self-hosting. Restructuring it (walk
 * `body` once, remember the entrypoint's INDEX in `identCalls`, compare indices) touches
 * the acceptance rule itself, and the rule had no direct test: `NT1020` appeared only in
 * the self-hosting instruments and in `fetch`/`modules` incidentally. A refactor that
 * quietly widened the exception — or dropped it — would have gone unnoticed in both
 * directions, so both directions are pinned here.
 *
 * `expectMatchesNode` is not usable for the REFUSED cases: node runs them fine, which is
 * the entire point of the refusal (docs/divergences.md). Those assert the diagnostic; the
 * accepted ones are differential against node as usual.
 */
import { test, expect, describe } from "bun:test";
import { expectMatchesNode, emitIR } from "./harness.ts";
import { NTError } from "../src/diagnostics.ts";

function rejection(source: string): { code: string; message: string } {
  try {
    emitIR(source);
  } catch (e) {
    if (e instanceof NTError) return { code: e.diag.code, message: e.diag.message };
    throw e;
  }
  throw new Error("expected a diagnostic, but the source compiled");
}

async function matches(source: string): Promise<string> {
  const { ours, oracle } = await expectMatchesNode(source);
  expect(oracle.exitCode).toBe(0);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

const MAIN = `async function main(): Promise<void> { console.log("ran"); }\n`;

describe("floating async calls", () => {
  test("f1. `main();` as the LAST statement is the allowed entrypoint", async () => {
    expect(await matches(`${MAIN}main();\n`)).toBe("ran\n");
  });

  test("f2. the SAME call with a statement after it is refused", () => {
    const r = rejection(`${MAIN}main();\nconsole.log("after");\n`);
    expect(r.code).toBe("NT1020");
    expect(r.message).toContain("main");
  });

  test("f3. `await main();` is fine anywhere — the divergence is the missing await", async () => {
    expect(await matches(`${MAIN}await main();\nconsole.log("after");\n`)).toBe("ran\nafter\n");
  });

  test("f4. the exception is ONE call, not 'any call on the last line'", () => {
    // `other()` is floating and `main()` is the entrypoint. Refusing on `other` is the
    // whole point: the exception is an identity test on a single node, so a second async
    // call must not ride along on it.
    const r = rejection(`${MAIN}async function other(): Promise<void> { console.log("o"); }\nother();\nmain();\n`);
    expect(r.code).toBe("NT1020");
    expect(r.message).toContain("other");
  });

  test("f5. an awaited call plus the entrypoint — both allowed, in order", async () => {
    expect(await matches(
      `${MAIN}async function other(): Promise<void> { console.log("o"); }\nawait other();\nmain();\n`,
    )).toBe("o\nran\n");
  });

  test("f6. a program whose last statement is NOT an expression still refuses the float", () => {
    const r = rejection(`${MAIN}main();\nfunction tail(): number { return 1; }\n`);
    expect(r.code).toBe("NT1020");
  });

  test("f7. an empty-bodied program is ordinary — index -1 is never read", async () => {
    expect(await matches(`console.log(1);\n`)).toBe("1\n");
  });
});
