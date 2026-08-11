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

describe("the refusal names the FIRST optional field, and only an optional one", () => {
  /**
   * WHICH field the message names is observable, and it is decided by a scan that used to
   * be `objectFields(ot).find(…)`. That `.find` is refused when the compiler compiles
   * itself (NT1001 — the found record would alias the array that owns it), so it is now a
   * loop that copies out the KEY and stops at the first hit. These pin the two properties
   * that rewrite had to preserve: FIRST wins, and a required field is never picked.
   *
   * The empty-key case (`{ "": T }`, where the scan's "nothing found" sentinel could
   * collide with a real key) is not testable from source today — this parser answers
   * `NT0001 Expected identifier` for a quoted key in a type position — which is why the
   * scan carries a separate `found` flag rather than treating `""` as absent.
   */
  test("two optional fields: the first one is named", () => {
    const r = rejectionOf(`type O = { a?: number; z?: number; b: number };\nconst o: O = { b: 2 };\nfor (const k in o) console.log(k);\n`);
    expect(r?.code).toBe("NT1010");
    expect(r?.message).toContain("'a'");
    expect(r?.message).not.toContain("'z'");
  });

  test("a required field BEFORE the optional one is not named", () => {
    const r = rejectionOf(`type O = { b: number; a?: number };\nconst o: O = { b: 2 };\nfor (const k in o) console.log(k);\n`);
    expect(r?.code).toBe("NT1010");
    expect(r?.message).toContain("'a'");
    expect(r?.message).not.toContain("'b'");
  });

  test("`T | null` is NOT optional — its key is always present, so enumeration is allowed", async () => {
    // node prints both keys: a `null` value still HAS its key. Only `| undefined` (which
    // is how `a?:` is encoded) makes presence a runtime question.
    const src = `type O = { a: number | null; b: number };\nconst o: O = { a: null, b: 2 };\nfor (const k in o) console.log(k);\n`;
    expect(rejectionOf(src)).toBeNull();
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
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

/**
 * Binary `in`, DECIDED AT COMPILE TIME — the `instanceof` split, applied to key presence.
 *
 * The refusal above (`Object.keys` on an optional field) is about a key set that is not a
 * function of the TYPE. `k in o` is the same question asked one key at a time, and that
 * changes the answer: for an object type with no optional field the presence set IS the
 * field set, exactly, so a LITERAL key is decidable statically — the identical move
 * `instanceof` makes ("a value's static type IS its class here"). What a static type
 * cannot decide — an optional field, a variable key — stays refused, as `NT1022` does for
 * `instanceof`.
 *
 * Semantics are node's, borrowed from **tc39/test262 `test/language/expressions/in/`**:
 *   - `S8.12.6_A1.js`      — `"fooProp" in {fooProp:"fooooooo"}` is true (own property)
 *   - `S8.12.6_A2_T1.js`   — `"valueOf" in {}` is **true**: `in` walks the PROTOTYPE CHAIN
 *   - `S8.12.6_A3.js`      — `__obj.hole = undefined`; `"hole" in __obj` is true and
 *                            `"notexist" in __obj` is false — presence, never truthiness
 *   - `S11.8.7_A3.js`      — a non-object right operand is a TypeError (`"length" in "s"`)
 * Each borrowed case is re-run against node below as a `.ts` fixture.
 */
describe("`k in o` with a LITERAL key and a static shape is folded, and equals node", () => {
  /** test262 S8.12.6_A1 (present) + S8.12.6_A3 CHECK#4 (absent), as one differential. */
  test("present and absent own keys", async () => {
    const source = `const o = { fooProp: "fooooooo", b: 2 };\nconsole.log("fooProp" in o);\nconsole.log("notexist" in o);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true\nfalse\n");
  });

  /**
   * test262 S8.12.6_A2_T1 — the case an own-fields-only lowering gets WRONG. nativets
   * objects have no prototype chain (`o.toString` is "Property 'toString' does not
   * exist"), so `in` would answer `false` here; node answers `true`. A literal key can be
   * checked against `Object.prototype`'s names, and is.
   */
  test("an INHERITED name is present — `in` walks the prototype chain", async () => {
    const source = `const o = { a: 1 };\nconsole.log("valueOf" in o);\nconsole.log("toString" in o, "hasOwnProperty" in o, "constructor" in o);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true\ntrue true true\n");
  });

  /**
   * test262 S8.12.6_A3 CHECK#3 — presence, not truthiness. A field holding `undefined`,
   * `0`, `""` or `false` is PRESENT. Folding from the field list gets this for free: no
   * value is ever consulted.
   */
  test("a field whose value is undefined / falsy is still present", async () => {
    const source = `const o = { hole: undefined, z: 0, e: "", f: false };\nconsole.log("hole" in o, "z" in o, "e" in o, "f" in o, "notexist" in o);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true true true true false\n");
  });

  /**
   * The OBJECT operand is still EVALUATED — the fold replaces the answer, not the
   * effects. (The key operand cannot have any: a non-literal key is refused below.)
   */
  test("side effects on the object operand still happen", async () => {
    const source =
      `function o(): { a: number } { console.log("o"); return { a: 1 }; }\n` +
      `console.log("a" in o());\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("o\ntrue\n");
  });
});

describe("what a static type CANNOT decide is refused, with the reason", () => {
  /**
   * The optional field — the same non-answer `Object.keys` has, but asked one key at a
   * time, so the refusal is strictly NARROWER: only the optional key itself is refused.
   */
  test("the optional key has no answer", () => {
    const r = rejectionOf(`type O = { a?: number; b: number };\nconst o: O = { b: 2 };\nconsole.log("a" in o);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.message).toContain("optional");
    expect(r?.hint).toContain("compile time");
    expect(r?.hint).toContain("undefined");
  });

  test("a REQUIRED key of the SAME type still answers — `Object.keys` refuses this shape outright", async () => {
    const source = `type O = { a?: number; b: number };\nconst o: O = { b: 2 };\nconsole.log("b" in o, "zz" in o);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true false\n");
  });

  /** A key we cannot see cannot be checked against the prototype chain. */
  test("a non-literal key is refused, and the hint says why the prototype chain blocks it", () => {
    const r = rejectionOf(`const o = { a: 1 };\nconst k = "a";\nconsole.log(k in o);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.message).toContain("non-literal");
    expect(r?.hint).toContain("PROTOTYPE CHAIN");
    expect(r?.hint).toContain("m.has(k)");
  });

  /**
   * The trap worth naming loudly. `"a" in m` after `m.set("a", 1)` is **false** in node —
   * `in` tests the Map OBJECT's properties, never its entries. Lowering it to `.has`
   * would be a silent wrong answer, so it is refused and `.has` is named as the fix.
   */
  test("a Map right operand is refused, naming `.has`", () => {
    const r = rejectionOf(`const m = new Map<string, number>();\nconsole.log("a" in m);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.hint).toContain("m.has(k)");
    expect(r?.hint).toContain("false");
  });

  test("node really does answer false there — the divergence this refusal avoids", () => {
    const oracle = runWithNode(`const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log("a" in m, m.has("a"));\n`);
    expect(oracle.stdout).toBe("false true\n");
  });

  /** An array's key set is its INDICES, and its length is not static. */
  test("an array right operand is refused", () => {
    const r = rejectionOf(`const xs = [1, 2, 3];\nconsole.log("0" in xs);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.hint).toContain("INDEX presence");
  });

  /** test262 S11.8.7_A3 — node throws a TypeError; there is nothing to test against. */
  test("a primitive right operand is refused, citing node's TypeError", () => {
    const r = rejectionOf(`const s = "string";\nconsole.log("length" in s);\n`);
    expect(r?.code).toBe("NT1002");
    expect(r?.hint).toContain("TypeError");
  });
});

describe("binary `in` gets a real diagnostic, not a parse error", () => {
  test("`for (const k in o)` still parses — the for-in header is not the operator", async () => {
    const source = `const o = { a: "1", b: "2" };\nfor (const k in o) console.log(k);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0);
  });
});
