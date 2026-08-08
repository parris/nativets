/**
 * KEY PRESENCE — why enumerating an object with an OPTIONAL field is refused.
 *
 * This is the same root cause as the `delete` refusal (`test/delete-refusal.test.ts`):
 * nativets decides an object's key set at COMPILE TIME, from its type. An object is a
 * flat i64 slot array whose field list comes from `objectFields` (src/ast.ts); an
 * omitted optional field is still allocated; and `Object.keys`/`for-in` lower to a
 * constant string array (`buildStringArray`, src/codegen.ts).
 *
 * node decides it at RUNTIME, per value. So this program disagreed silently — measured
 * on node before the fix, both sides exiting 0:
 *
 *   type O = { a?: number; b: number };
 *   const o: O = { b: 2 };
 *   Object.keys(o)                  // node ["b"]        nativets ["a","b"]   ← WRONG
 *   for (const k in o) …            // node "b"          nativets "a","b"     ← WRONG
 *
 * A value's presence set is not a function of its type, so there is no compile-time
 * answer to give: `f({})` and `f({a: 1})` reach the same `Object.keys(o)` with the same
 * static type and different correct answers. Rather than keep printing a wrong key list,
 * the five enumerating constructs are REFUSED when the object type carries an optional
 * field — reject, never miscompile.
 *
 * Cases are DERIVED from node probes quoted inline. No conformance suite was consulted.
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

describe("Object.keys over an object with an OPTIONAL field is refused", () => {
  test("the silently-wrong program is now rejected, with the reason and a workaround", () => {
    const r = rejectionOf(`type O = { a?: number; b: number };\nconst o: O = { b: 2 };\nconsole.log(JSON.stringify(Object.keys(o)));\n`);
    expect(r?.code).toBe("NT1002");
    // WHY: presence is static here, so there is no compile-time answer.
    expect(r?.message).toContain("optional");
    expect(r?.hint).toContain("compile time");
    // The workaround must be named.
    expect(r?.hint).toContain("undefined");
  });
});

describe("for-in over an object with an OPTIONAL field is refused", () => {
  /**
   *   type O = { a?: number; b: number };
   *   const o: O = { b: 2 };
   *   for (const k in o) console.log(k);   // node: "b" only; nativets printed "a" then "b"
   *
   * Same root cause, different construct and therefore a different code — for-in has its
   * own NT1010 bucket, and reusing it keeps the tree's NT-code set unchanged.
   */
  test("the silently-wrong for-in is now rejected", () => {
    const r = rejectionOf(`type O = { a?: number; b: number };\nconst o: O = { b: 2 };\nfor (const k in o) console.log(k);\n`);
    expect(r?.code).toBe("NT1010");
    expect(r?.message).toContain("optional");
    expect(r?.hint).toContain("compile time");
  });
});

describe("the sibling enumerating forms are refused too", () => {
  /** All four `Object.*` enumerators read the same compile-time key list, so all four lie. */
  test.each(["values", "entries", "getOwnPropertyNames"])("Object.%s", (p) => {
    const r = rejectionOf(`type O = { a?: string; b: string };\nconst o: O = { b: "x" };\nconsole.log(JSON.stringify(Object.${p}(o)));\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.message).toContain("optional");
  });
});

describe("an object with NO optional field keeps working — all five constructs", () => {
  /**
   * THE REGRESSION RISK. The refusal above must not cost the common shape anything, so
   * each of these is checked DIFFERENTIALLY: compile + run, and assert stdout and exit
   * code equal `node`'s on the same source.
   */
  const cases: [string, string][] = [
    ["Object.keys", `console.log(JSON.stringify(Object.keys(o)));`],
    ["Object.values", `console.log(JSON.stringify(Object.values(o)));`],
    ["Object.entries", `console.log(JSON.stringify(Object.entries(o)));`],
    ["Object.getOwnPropertyNames", `console.log(JSON.stringify(Object.getOwnPropertyNames(o)));`],
    ["for-in", `for (const k in o) console.log(k);`],
  ];
  test.each(cases)("%s", async (_name, body) => {
    const source = `type O = { a: string; b: string };\nconst o: O = { a: "1", b: "2" };\n${body}\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0);
  });

  /**
   * `a: T | null` is a `?N` field: its key is ALWAYS present in node, so the static key
   * list is already correct and must stay accepted. Only the `?U` arm is ambiguous.
   */
  test("a `T | null` field is NOT refused — its key is always present", async () => {
    const source = `type O = { a: string | null; b: string };\nconst o: O = { a: null, b: "2" };\nconsole.log(JSON.stringify(Object.keys(o)));\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout.trim()).toBe(`["a","b"]`);
  });
});

describe("binary `in` gets a real diagnostic, not a parse error", () => {
  /**
   * `"a" in o` is the OTHER way node exposes key presence, so it is refused for the same
   * reason. What it used to produce, though, was `error[NT0001]: Expected ')' but found
   * 'in'` — the parser falling off the end of an expression, blaming a paren. That names
   * neither the construct nor the reason, and `coverage` bucketed it as a syntax error.
   */
  test("`\"a\" in o` names the construct and the reason", () => {
    const r = rejectionOf(`const o = { a: 1, b: 2 };\nconsole.log("a" in o);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.message).toContain("in");
    expect(r?.message).toContain("2:17");
    expect(r?.hint).toContain("compile time");
  });

  test("it is no longer reported as a syntax error", () => {
    const r = rejectionOf(`const o = { a: 1, b: 2 };\nconsole.log("a" in o);\n`);
    expect(r?.code).not.toBe("NT0001");
    expect(r?.message).not.toContain("Expected ')'");
  });

  test("`for (const k in o)` still parses — the for-in header is not the operator", async () => {
    const source = `const o = { a: "1", b: "2" };\nfor (const k in o) console.log(k);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0);
  });
});
