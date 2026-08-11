/*
 * `Array.prototype.includes` — SameValueZero, not `===`.
 *
 * ES2016 added `.includes` on SameValueZero (ECMA-262 23.1.3.16 -> 7.2.11), which differs
 * from the strict equality `indexOf` uses at exactly ONE pair of values: `NaN` equals
 * `NaN`. It agrees with `===` everywhere else, INCLUDING `+0`/`-0`, which SameValueZero
 * treats as equal (that is the "Zero" in the name — SameValue, by contrast, distinguishes
 * them, and implementing SameValue here would break `[-0].includes(0)`).
 *
 * `nt_arr_includes_num` compared with C `==`, which is IEEE-754 equality: false for every
 * NaN operand. So `[NaN].includes(NaN)` printed `false` where node prints `true` — a
 * silent wrong answer at exit 0, found by the fuzz lane and pinned in
 * `test/fuzz-diff.test.ts`.
 *
 * Every case here is differential against node, the specification.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";
import { readFileSync } from "node:fs";

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

/** Compile+run ours and assert stdout AND exit code match `node` on the same source. */
async function matchesNode(src: string): Promise<string> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("Array#includes is SameValueZero", () => {
  // The defect itself: NaN is the one value SameValueZero finds and `===` does not.
  test("NaN is found; indexOf (strict equality) still does not find it", async () => {
    expect(await matchesNode([
      "const a = [NaN, 1];",
      "console.log(a.includes(NaN));", // true — SameValueZero
      "console.log(a.indexOf(NaN));",  // -1  — strict equality, unchanged
      "console.log([1, 2].includes(NaN));",
      "console.log([1, 2].indexOf(NaN));",
      "",
    ].join("\n"))).toBe("true\n-1\nfalse\n-1\n");
  });

  // The "Zero" half. SameValue would print `false true` on the first line and regress
  // node; SameValueZero and `===` both print `true true`.
  test("+0 and -0 are the same value, in both directions", async () => {
    expect(await matchesNode([
      "const neg = [-0];",
      "console.log(neg.includes(0), neg.includes(-0));",
      "const pos = [0];",
      "console.log(pos.includes(-0), pos.includes(0));",
      "console.log(neg.indexOf(0), pos.indexOf(-0));",
      "",
    ].join("\n"))).toBe("true true\ntrue true\n0 0\n");
  });

  // NaN must not become a wildcard: a NaN needle finds nothing in a NaN-free array, and a
  // non-NaN needle is not answered by a NaN element.
  test("a NaN needle matches only NaN, and NaN matches only a NaN needle", async () => {
    expect(await matchesNode([
      "console.log([0, -0, Infinity, -Infinity].includes(NaN));",
      "console.log([NaN].includes(0));",
      "console.log([NaN].includes(Infinity));",
      "console.log([Infinity].includes(Infinity), [Infinity].includes(-Infinity));",
      "",
    ].join("\n"))).toBe("false\nfalse\nfalse\ntrue false\n");
  });

  // Every NaN is one value: `0/0` and `Number.NaN` are the same needle as the literal.
  test("NaN from arithmetic and Number.NaN are the same value", async () => {
    expect(await matchesNode([
      "const a = [0 / 0];",
      "console.log(a.includes(NaN), a.includes(Number.NaN));",
      "console.log([Number.NaN].includes(0 / 0));",
      'console.log([Number("x")].includes(NaN));',
      "",
    ].join("\n"))).toBe("true true\ntrue\ntrue\n");
  });

  // The loop must not read off the end when there is no end to read: an empty array is
  // false for every needle, NaN included.
  test("an empty array contains nothing, NaN included", async () => {
    expect(await matchesNode([
      "const e: number[] = [];",
      "console.log(e.includes(NaN), e.includes(0), e.includes(-0));",
      "const s: string[] = [];",
      'console.log(s.includes(""), s.includes("a"));',
      "",
    ].join("\n"))).toBe("false false false\nfalse false\n");
  });

  // Strings take the other runtime routine; SameValueZero and `===` agree on strings, so
  // this is here to prove the numeric fix left it alone.
  test("string elements are unaffected", async () => {
    expect(await matchesNode([
      'const s = ["a", "b", "NaN", ""];',
      'console.log(s.includes("a"), s.includes("c"));',
      'console.log(s.includes("NaN"), s.includes(""));',
      'console.log(s.indexOf("NaN"), s.indexOf("z"));',
      "",
    ].join("\n"))).toBe("true false\ntrue true\n2 -1\n");
  });

  /*
   * PAST THE 32-ELEMENT THRESHOLD. Above 32 elements an array is a persistent vector
   * whose tail is not contiguous with its trie, and three array routines have segfaulted
   * there by indexing the storage directly — `arr_at` is the only legal read. The scan
   * must find a NaN in the TRIE part (index 0), in the TAIL (last), and nowhere else.
   */
  test("finds NaN past the 32-element persistent-vector threshold", async () => {
    expect(await matchesNode([
      "let head: number[] = [NaN];",
      "for (let i = 0; i < 50; i++) head = [...head, i];",
      "console.log(head.length, head.includes(NaN), head.includes(49), head.includes(50));",
      "let tail: number[] = [];",
      "for (let i = 0; i < 50; i++) tail = [...tail, i];",
      "tail = [...tail, NaN];",
      "console.log(tail.length, tail.includes(NaN), tail.includes(0), tail.includes(-1));",
      "let clean: number[] = [];",
      "for (let i = 0; i < 40; i++) clean = [...clean, i];",
      "console.log(clean.length, clean.includes(NaN));",
      "let strs: string[] = [];",
      'for (let i = 0; i < 40; i++) strs = [...strs, "k" + i];',
      'console.log(strs.length, strs.includes("k39"), strs.includes("k40"));',
      "",
    ].join("\n"))).toBe(
      "51 true true false\n51 true true false\n40 false\n40 true false\n",
    );
  });

  // The sibling lookups already used SameValueZero (Set/Map, via nt_hamt's ntk_eq) or
  // deliberately did not (indexOf/lastIndexOf, strict equality). Pin that so a later
  // "consistency" edit cannot quietly move one of them.
  test("Set#has / Map#has / Map#get keep SameValueZero; lastIndexOf keeps ===", async () => {
    expect(await matchesNode([
      "const s = new Set<number>([NaN, 1, NaN, -0]);",
      "console.log(s.has(NaN), s.has(0), s.size);",
      'const m = new Map<number, string>().set(NaN, "n").set(-0, "z");',
      "console.log(m.has(NaN), m.get(NaN), m.has(0), m.get(0), m.size);",
      "console.log([NaN, 1, NaN].lastIndexOf(NaN));",
      "",
    ].join("\n"))).toBe("true true 3\ntrue n true z 2\n-1\n");
  });

  /*
   * MUTATION GUARD. The fix is one `isnan` pair inside `nt_arr_includes_num`; the tests
   * above are what proves it, but they run a compiled binary, so a reader cannot see from
   * them that `indexOf` was left on `==` deliberately. Assert the shape directly: the
   * includes routine mentions `isnan` and the indexOf routine does not. Read with
   * `readFileSync`, never a shell `grep` (project memory: the shimmed grep on some setups
   * silently drops matching lines, which would make this vacuous).
   */
  /*
   * BOOLEAN ELEMENTS — the third slot shape, which had no arm.
   *
   * `.includes` split two ways (`el === "number" ? _num : _str`), exactly the split
   * `.join` already learned was wrong: a `boolean[]` slot holds `zext i1`, so it is
   * neither a `double` nor a `ptr`. It took the `_str` arm and emitted
   * `call i32 @nt_arr_includes_str(ptr %t3, ptr true)` — an `i1` in a `ptr` parameter,
   * which is not valid IR at all. That reached the user as a raw clang
   * "constant expression type mismatch" with no NT code and no hint. A two-way choice
   * written twice is how the third case gets missed twice; see `joinFn` in codegen.ts.
   */
  test("boolean elements are found by value, not by pointer", async () => {
    expect(await matchesNode([
      "const a = [true, false];",
      "console.log(a.includes(true), a.includes(false));",
      "const t = [true, true];",
      "console.log(t.includes(true), t.includes(false));",
      "const f = [false, false];",
      "console.log(f.includes(true), f.includes(false));",
      "const e: boolean[] = [];",
      "console.log(e.includes(true), e.includes(false));",
      "",
    ].join("\n"))).toBe("true true\ntrue false\nfalse true\nfalse false\n");
  });

  // A computed needle and a computed element must agree with the literals — the runtime
  // compares slots, so anything that is not exactly 0/1 in the slot would show up here.
  test("boolean needles and elements from expressions", async () => {
    expect(await matchesNode([
      "const n = 1;",
      "const a = [n > 0, n < 0];",
      "console.log(a.includes(n === 1), a.includes(n !== 1));",
      "console.log([!true].includes(false), [!false].includes(false));",
      "",
    ].join("\n"))).toBe("true true\ntrue false\n");
  });

  // Past the persistent-vector threshold the tail is not contiguous with the trie, so a
  // boolean scan must go through `arr_at` like its siblings.
  test("boolean scan past the 32-element threshold", async () => {
    expect(await matchesNode([
      "let a: boolean[] = [];",
      "for (let i = 0; i < 50; i++) a = [...a, false];",
      "console.log(a.length, a.includes(true), a.includes(false));",
      "a = [...a, true];",
      "console.log(a.length, a.includes(true));",
      "",
    ].join("\n"))).toBe("50 false true\n51 true\n");
  });

  /*
   * NON-PRIMITIVE ELEMENTS ARE REFUSED, not answered by strcmp.
   *
   * `.lastIndexOf` has carried the guard `el !== "number" && el !== "string"` since it
   * landed; `.includes` and `.indexOf` never grew it. So a `number[][]` fell through to
   * `nt_arr_includes_str`, which ran `strcmp` over the bytes of an `NtArray` struct —
   * both an out-of-bounds read (it walks to the first zero byte) and, when it happened
   * to match, a SILENT WRONG ANSWER at exit 0:
   *
   *   [[1],[2]].includes([1])  node: false   ours: true
   *   [[1],[2]].indexOf([1])   node: -1      ours: 0
   *
   * node's answer is reference identity (SameValueZero on objects), which we do not
   * model. So this is a refusal, documented in docs/divergences.md — never a guess.
   * The three siblings now agree.
   */
  test("includes/indexOf/lastIndexOf all refuse a non-primitive element type", async () => {
    const cases: Array<[string, string]> = [
      ["const a: number[][] = [[1], [2]];\nconst o: number[] = [1];\nconsole.log(a.includes(o));\n", ".includes"],
      ["const a: number[][] = [[1], [2]];\nconst o: number[] = [1];\nconsole.log(a.indexOf(o));\n", ".indexOf"],
      ["const a: number[][] = [[1], [2]];\nconst o: number[] = [1];\nconsole.log(a.lastIndexOf(o));\n", ".lastIndexOf"],
    ];
    for (const [src, what] of cases) {
      // node runs every one of these fine — that is why answering them wrongly was worse
      // than refusing them.
      expect([what, runWithNode(src).exitCode]).toEqual([what, 0]);
      const r = rejectionOf(src);
      expect([what, r?.code, r?.message.includes(what)]).toEqual([what, "NT1001", true]);
    }
  });

  // The primitive element types stay ACCEPTED — the guard must not swallow them.
  test("number, string and boolean elements are still accepted by all three", async () => {
    expect(await matchesNode([
      "console.log([1, 2].includes(2), [1, 2].indexOf(2), [1, 2].lastIndexOf(1));",
      'console.log(["a"].includes("a"), ["a"].indexOf("a"), ["a"].lastIndexOf("a"));',
      "console.log([true].includes(true));",
      "",
    ].join("\n"))).toBe("true 1 0\ntrue 0 0\ntrue\n");
  });

  test("the SameValueZero branch is in includes only, not in indexOf", () => {
    const c = readFileSync(new URL("../runtime/runtime.c", import.meta.url), "utf8");
    const bodyOf = (name: string): string => {
      const at = c.indexOf(`${name}(NtArray *a`);
      expect([name, at >= 0]).toEqual([name, true]);
      const open = c.indexOf("{", at);
      return c.slice(open, c.indexOf("\n}", open));
    };
    expect({
      includes: bodyOf("nt_arr_includes_num").includes("isnan"),
      indexOf: bodyOf("nt_arr_indexof_num").includes("isnan"),
      lastIndexOf: bodyOf("nt_arr_last_indexof_num").includes("isnan"),
    }).toEqual({ includes: true, indexOf: false, lastIndexOf: false });
  });
});
