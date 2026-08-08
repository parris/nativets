/**
 * `delete o.k` — the refusal, and WHY it is a refusal rather than a feature.
 *
 * node's `delete` removes a key IN PLACE, and node distinguishes a key that is ABSENT
 * from one that is PRESENT-but-`undefined`. Measured (node v24, `test/fixtures/…` style
 * probe reproduced in each test's comment):
 *
 *   const o: {a?: number; b: number} = { a: 1, b: 2 };
 *   delete o.a          // → true   (a BOOLEAN, and `true` even for an absent key)
 *   "a" in o            // → false
 *   Object.keys(o)      // → ["b"]
 *
 *   const u: {a?: number; b: number} = { a: undefined, b: 2 };
 *   "a" in u            // → TRUE   ← present-undefined is NOT absent
 *   Object.keys(u)      // → ["a","b"]
 *
 * nativets cannot represent that distinction. An object is a flat i64 slot array whose
 * field list comes from the TYPE (`objectFields`, src/ast.ts); an omitted optional field
 * is still allocated (src/checker.ts, object-literal typing) and holds the same
 * `undefined` an explicit one does; and `Object.keys`/`for-in` lower to a
 * compile-time-constant string array (`buildStringArray`, src/codegen.ts). Making
 * `delete` mean what node means therefore needs a per-field PRESENCE BIT and a runtime
 * `Object.keys`/`for-in`/`in` — which is why `@@mutable` legalizes assigning a SLOT but
 * never changing a SHAPE (docs/decorators.md).
 *
 * So `delete` is refused, in every spelling, and this file pins that: the alternative is
 * a silent wrong answer, which CLAUDE.md ranks as the worst outcome available.
 *
 * Cases are DERIVED from node's observed behaviour on the probes quoted above. No
 * conformance suite was consulted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitIR } from "./harness.ts";
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";

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

describe("the `delete` refusal names its SOURCE POSITION", () => {
  /**
   * The refusal used to carry no `line:col` at all, which is not a cosmetic gap: this
   * lane's own blocker was "checker.ts is stopped by an NT1606 somewhere", and locating
   * `delete spec.typeParams` inside a 3000-line file was hand work. Every other parser
   * refusal names its position (`Expected ')' … at 2:17`); this one now does too.
   */
  test("a `delete` on line 3 says 3, not `undefined`", () => {
    const r = rejectionOf(`const o = { a: 1, b: 2 };\nconsole.log(o.b);\ndelete o.a;\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("3:1");
    expect(r?.message).not.toContain("undefined");
  });

  test("the position is the `delete` keyword, wherever the statement starts", () => {
    const r = rejectionOf(`const o = { a: 1, b: 2 };\nconsole.log(o.b);\n  const x = delete o.a;\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("3:13");
  });
});

describe("`delete xs[i]` on an ARRAY is refused with array-shaped advice", () => {
  /**
   * node's array `delete` punches a HOLE rather than removing an element. Measured:
   *
   *   const xs = [1, 2, 3];
   *   delete xs[0]        // → true
   *   xs.length           // → 3      ← length is UNCHANGED
   *   xs[0]               // → undefined
   *   Object.keys(xs)     // → ["1","2"]
   *   JSON.stringify(xs)  // → "[null,2,3]"
   *   delete xs[99]       // → true   (out of range is still a no-op returning true)
   *
   * nativets arrays are dense i64 slot arrays with no hole representation, so this is
   * refused too. The point of this test is the HINT: the record advice ("declare the
   * field optional (`k?: T`) and set it to `undefined`") is not merely unhelpful for an
   * array, it is wrong — an array has no optional fields, and the fix is `.filter` /
   * `.slice`, which keeps the dense shape node's `delete` explicitly does not.
   */
  test("the hint names the array replacement, not the optional-field one", () => {
    const r = rejectionOf(`const xs = [1, 2, 3];\ndelete xs[0];\nconsole.log(xs[1]);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("2:1");
    expect(r?.hint).toContain("filter");
    expect(r?.hint).not.toContain("k?: T");
  });

  test("a hole is named as the reason, since that is what node would produce", () => {
    const r = rejectionOf(`const xs = [1, 2, 3];\ndelete xs[0];\nconsole.log(xs[1]);\n`);
    expect(r?.message).toContain("hole");
  });

  test("a record key is still given the RECORD hint — the two do not collapse", () => {
    const r = rejectionOf(`const o = { a: 1, b: 2 };\ndelete o["a"];\nconsole.log(o.b);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("k?: T");
    expect(r?.hint).not.toContain("filter");
  });
});

describe("the compiler's own source no longer needs `delete` (route c)", () => {
  /**
   * The self-hosting blocker this lane was opened for: `src/checker.ts` stopped
   * STANDALONE (parse + check, no link) at the `delete` refusal, from
   * `specializeDecl`'s `delete spec.typeParams`.
   *
   * That `delete` was provably redundant. The line above it already clones with
   * `typeParams: undefined`, and every reader of the field in the tree is either
   * `s.typeParams?.length` (undefined-safe, and `undefined?.length` is falsy exactly
   * as an absent key would be) or `tmpl.typeParams!` on the TEMPLATE rather than the
   * specialization. Nothing anywhere asks `"typeParams" in spec`, and the AST is never
   * serialized, so absent and present-undefined are indistinguishable *here* — which is
   * precisely the distinction nativets cannot make in general, and the reason `delete`
   * stays refused rather than compiled.
   *
   * Asserted narrowly — "not blocked on THIS" — so that other lanes advancing
   * checker.ts's frontier do not make it fail.
   */
  function standaloneBlocker(rel: string): string | null {
    const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
    try {
      check(parse(src));
      return null;
    } catch (e) {
      const d = (e as { diag?: { code: string; message: string } }).diag;
      return d ? `${d.code}: ${d.message}` : String(e);
    }
  }

  test("src/checker.ts standalone is no longer stopped by the `delete` refusal", () => {
    const b = standaloneBlocker("src/checker.ts");
    expect(b ?? "").not.toContain("would remove a key in place");
  });

  test("src/checker.ts contains no `delete` statement at all", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/checker.ts"), "utf8");
    expect(/^\s*delete\s/m.test(src)).toBe(false);
  });
});
