/*
 * A PERSISTENT collection held in a `@@mutable` class FIELD, updated by rebinding the
 * field — `c.set = c.set.add(x)` where `c` is not `this`.
 *
 * Why this file exists. `src/checker.ts` accumulated its `static` method table with
 * `c.statics.add(name)`, the discarded-result spelling. That is a SILENT NO-OP in the
 * subject language (`Set` is persistent here: `.add` returns a NEW set), and it worked
 * only because stage 0 of the bootstrap is bun, whose `Set.add` mutates in place. The
 * checker refuses the line — `NT1606`, and it was the first blocker of checker.ts,
 * codegen.ts and ownership.ts once `s.returnTy = …` cleared — but its HINT sent the
 * reader to the wrong fix:
 *
 *     `c.statics` is inside a CONTAINER, so do NOT write `c.statics = c.statics.add(…)`
 *     — this compiler refuses that assignment (an object field is NT1606 …).
 *     To assign the field in place instead, declare the record `@@mutable`.
 *
 * `Checker` IS `//@@mutable`, and the assignment the hint forbids is exactly the fix. The
 * hint's rebindable test was `Identifier` or `this.f` and asked nothing about the
 * receiver's TAG, so every `@@mutable` receiver reached through a NAME fell into the
 * container arm. These tests pin the behaviour the hint has to describe: the rebind
 * compiles, and it is node-exact.
 *
 * node is the oracle directly — `//@@mutable` is a comment to node.
 */

import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNodeAttrs, emitIR } from "./harness.ts";

/** Compile-only: the diagnostic a source is rejected with, or null. */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

async function expectMatchesNode(source: string) {
  const oracle = runWithNodeAttrs(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  expect(ours.stdout.length).toBeGreaterThan(0);
}

describe("a persistent Set in a @@mutable class field", () => {
  // The shape `src/checker.ts` now uses for `Checker.statics`: the receiver is a plain
  // local, NOT `this`, so it is the case the container arm of the hint used to claim was
  // refused.
  const REBIND = `
//@@mutable
class Box {
  names: Set<string> = new Set<string>();
}

function collect(): Box {
  const b = new Box();
  b.names = b.names.add("a");
  b.names = b.names.add("b");
  b.names = b.names.add("a");
  return b;
}

const b = collect();
console.log(\`\${b.names.size} \${b.names.has("a")} \${b.names.has("z")}\`);
`;

  test("`b.names = b.names.add(x)` compiles through a NAME receiver", () => {
    expect(rejectionOf(REBIND)).toBe(null);
  });

  test("…and matches node", async () => {
    await expectMatchesNode(REBIND);
  });

  // The same field on an UNDECORATED class is still refused — the rebind is legal because
  // of the tag, not because a field assignment became legal in general. Without this the
  // test above would pass just as well if `@@mutable` stopped meaning anything.
  test("an undecorated class still refuses the same field assignment", () => {
    const d = rejectionOf(REBIND.replace("//@@mutable\n", ""));
    expect(d).not.toBe(null);
    expect(d!.code).toBe("NT1606");
    expect(d!.message).toContain("objects are immutable");
  });

  // The discarded spelling stays refused, which is the whole point: it is a no-op here and
  // a working mutation under node/bun.
  test("the discarded `.add` is still NT1606", () => {
    const d = rejectionOf(REBIND.replace("b.names = b.names.add(\"a\");\n  b.names", "b.names.add(\"a\");\n  b.names"));
    expect(d).not.toBe(null);
    expect(d!.code).toBe("NT1606");
  });

  // The hint for that refusal must not forbid the fix. It used to say "do NOT write
  // `b.names = b.names.add(…)`" for exactly this receiver — advice that contradicts the
  // first two tests in this file.
  test("its hint does not forbid the rebind that this very file proves compiles", () => {
    const d = rejectionOf(`
//@@mutable
class Box {
  names: Set<string> = new Set<string>();
}
const b = new Box();
b.names.add("a");
console.log(b.names.size);
`);
    expect(d).not.toBe(null);
    expect(d!.code).toBe("NT1606");
    expect(d!.hint ?? "").not.toContain("do NOT write `b.names = b.names.add");
    expect(d!.hint ?? "").toContain("b.names = b.names.add");
  });
});
