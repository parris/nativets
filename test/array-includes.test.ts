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
import { compileAndRun, runWithNode } from "./harness.ts";
import { readFileSync } from "node:fs";

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
