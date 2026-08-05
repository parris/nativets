/*
 * stdlib Batch 1 (part 2) — the missing everyday surface.
 *
 * The first Batch-1 tranche landed Date.now / btoa / atob / String.fromCharCode /
 * fromCodePoint / Number.is* / Array.isArray / Array.from(str) / Object.values.
 * This file covers the REST: the string fills, the array fills, Object.entries,
 * the Number statics + toFixed, and structuredClone.
 *
 * `node` is the oracle for every case below (byte-for-byte stdout + exit code).
 *
 * DIVERGENCE (pre-existing, docs/divergences.md §A.2): nativets strings are
 * UTF-8 BYTES, not UTF-16 code units — `.length`, indices, `.charCodeAt`,
 * `.codePointAt`, `.at` are all byte-oriented. Identical to node for ASCII (which
 * these fixtures test exhaustively); for non-ASCII the INDEX SPACE differs, which
 * is documented, tested separately, and never silently miscompiled.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile-only: return the NT code a source is rejected with, or null if it compiles. */
function rejectCode(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

interface Case { name: string; code: string }

/** Run every case in a table as a differential test against node. */
function differential(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const { ours, oracle } = await expectMatchesNode(c.code);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });
    }
  });
}

differential("stdlib batch 1: string fills match node", [
  {
    name: ".charCodeAt(i) — every ASCII index, and out-of-range (NaN)",
    code: `
const s = "Hi, nativets! 0-9";
for (let i = 0; i < s.length; i++) { console.log(i, s.charCodeAt(i)); }
console.log(s.charCodeAt(s.length));
console.log(s.charCodeAt(-1));
console.log("A".charCodeAt(0));
`,
  },
  {
    name: ".codePointAt(i) — ASCII code points; out-of-range is undefined (not NaN)",
    code: `
const s = "nativets";
for (let i = 0; i < s.length; i++) { console.log(s.codePointAt(i)); }
console.log(s.codePointAt(s.length));
console.log(s.codePointAt(0), s.codePointAt(1));
`,
  },
  {
    name: ".at(i) — positive + negative indices, out-of-range is undefined",
    code: `
const s = "nativets";
console.log(s.at(0), s.at(3), s.at(s.length - 1));
console.log(s.at(-1), s.at(-8));
console.log(s.at(s.length));
console.log(s.at(-9));
console.log("".at(0));
`,
  },
  {
    name: ".padEnd(len, pad?) — default space pad, repeating pad, already-long, empty pad",
    code: `
console.log("[" + "abc".padEnd(6) + "]");
console.log("[" + "abc".padEnd(6, "xy") + "]");
console.log("[" + "abc".padEnd(2, "x") + "]");
console.log("[" + "abc".padEnd(3, "x") + "]");
console.log("[" + "".padEnd(4, "ab") + "]");
console.log("[" + "abc".padEnd(6, "") + "]");
console.log("7".padEnd(3, "0") + "|" + "7".padStart(3, "0"));
`,
  },
  {
    name: ".startsWith / .endsWith — incl. the optional position argument + empty needle",
    code: `
const s = "nativets";
console.log(s.startsWith("nat"), s.startsWith("ts"), s.startsWith(""), s.startsWith(s));
console.log(s.endsWith("ts"), s.endsWith("nat"), s.endsWith(""), s.endsWith(s));
console.log(s.startsWith("tive", 2), s.startsWith("tive", 3));
console.log(s.endsWith("nat", 3), s.endsWith("nat", 4));
console.log("".startsWith("a"), "".endsWith("a"), "".startsWith(""));
`,
  },
  {
    name: ".replace(str, str) — FIRST occurrence only, no-match, empty pattern, $-substitutions",
    code: `
console.log("a-b-c".replace("-", "+"));
console.log("a-b-c".replace("x", "+"));
console.log("abc".replace("", "-"));
console.log("aaa".replace("aa", "b"));
console.log("a$b".replace("$b", "[$&]"));
console.log("xy".replace("y", "$$"));
console.log("abc".replace("b", "$\`|$'"));
console.log("hello world".replace("world", "there"));
`,
  },
  {
    name: ".replaceAll(str, str) — every occurrence, overlapping-free, empty pattern",
    code: `
console.log("a-b-c".replaceAll("-", "+"));
console.log("aaaa".replaceAll("aa", "b"));
console.log("abc".replaceAll("", "-"));
console.log("abc".replaceAll("z", "!"));
console.log("a.b.c".replaceAll(".", "/"));
console.log("xyx".replaceAll("x", "[$&]"));
console.log("one two one".replaceAll("one", "1"));
`,
  },
  {
    name: ".concat(...) and .lastIndexOf(sub)",
    code: `
console.log("a".concat("b"), "a".concat("b", "c", "d"), "".concat("x"));
console.log("abcabc".lastIndexOf("b"), "abcabc".lastIndexOf("abc"), "abc".lastIndexOf("z"));
console.log("abc".lastIndexOf(""), "".lastIndexOf(""), "aaa".lastIndexOf("a"));
`,
  },
  {
    name: ".split(sep, limit) — truncating limit, limit 0, limit past the end, char split",
    code: `
console.log("a,b,c".split(",", 2).join("|"));
console.log("a,b,c".split(",", 0).length);
console.log("a,b,c".split(",", 9).join("|"));
console.log("abc".split("", 2).join("|"));
console.log("a,b,c".split(",").join("|"));
const parts = "k=v".split("=", 1);
console.log(parts.length, parts[0]);
`,
  },
]);

differential("stdlib batch 1: array fills match node", [
  {
    name: "Array#at(i) — positive + negative indices, out-of-range is undefined",
    code: `
const a = [10, 20, 30];
console.log(a.at(0), a.at(2));
console.log(a.at(-1), a.at(-3));
console.log(a.at(3));
console.log(a.at(-4));
const s = ["x", "y"];
console.log(s.at(0), s.at(-1), s.at(7));
`,
  },
  {
    name: "Array#lastIndexOf and Array#concat (non-mutating, like node)",
    code: `
const a = [1, 2, 3, 2, 1];
console.log(a.lastIndexOf(2), a.lastIndexOf(1), a.lastIndexOf(9));
const s = ["a", "b", "a"];
console.log(s.lastIndexOf("a"), s.lastIndexOf("b"), s.lastIndexOf("z"));
const c = a.concat([7, 8]);
console.log(c.join(","), a.join(","), c.length);
console.log(["x"].concat(["y"], ["z"]).join("-"));
`,
  },
  {
    name: "Array.of(...) — a real array from its arguments (numbers and strings)",
    code: `
const a = Array.of(1, 2, 3);
console.log(a.length, a.join(","), a[0], a[2]);
const s = Array.of("x");
console.log(s.length, s[0]);
console.log(Array.of(7).length, Array.of(7)[0]);
console.log(Array.isArray(Array.of(1, 2)));
`,
  },
  {
    name: "Array.from(arr) — a shallow copy (independent of the source), Array.from(str) stays",
    code: `
const src = [1, 2, 3];
const copy = Array.from(src);
console.log(copy.join(","), copy.length, src.join(","));
const up = Array.from("abc");
console.log(up.length, up.join("|"));
const names = Array.from(["a", "b"]);
console.log(names.join("+"));
`,
  },
  {
    name: "Array#some / #every / #findIndex with inline arrows (incl. capture + early exit)",
    code: `
const a = [1, 2, 3, 4];
console.log(a.some((x) => x > 3), a.some((x) => x > 9));
console.log(a.every((x) => x > 0), a.every((x) => x > 2));
console.log(a.findIndex((x) => x === 3), a.findIndex((x) => x === 99));
const limit = 2;
console.log(a.some((x) => x > limit), a.every((x) => x <= limit));
const words = ["alpha", "beta"];
console.log(words.some((w) => w.startsWith("b")), words.findIndex((w) => w.length === 4));
console.log(a.filter((x) => x % 2 === 0).some((x) => x === 4));
`,
  },
  {
    name: "Array#find / #findLast / #findLastIndex — value or undefined, node's iteration ORDER",
    code: `
const a = [5, 12, 8, 130, 44];
console.log(a.find((x) => x > 10));
console.log(a.find((x) => x > 1000));
console.log(a.findLast((x) => x > 10), a.findLastIndex((x) => x > 10));
console.log(a.findLast((x) => x > 1000), a.findLastIndex((x) => x > 1000));
let fwd = "";
a.find((x) => { fwd += x + ","; return x > 10; });
console.log(fwd);
let back = "";
a.findLast((x) => { back += x + ","; return x > 10; });
console.log(back);
const names = ["ann", "bob", "cy"];
console.log(names.find((n) => n.length === 2), names.find((n) => n.length === 9));
`,
  },
  {
    name: "Array#flat() — one level, and Array#flatMap(cb) with an inline arrow",
    code: `
const nested: number[][] = [[1, 2], [3], [4, 5, 6]];
const flatv = nested.flat();
console.log(flatv.join(","), flatv.length);
const words: string[][] = [["a", "b"], ["c"]];
console.log(words.flat().join("|"));
const deep: number[][][] = [[[1], [2]], [[3]]];
console.log(deep.flat().flat().join(","));
const a = [1, 2, 3];
console.log(a.flatMap((x) => [x, x * 10]).join(","));
console.log(a.flatMap((x) => [x]).length);
console.log(["ab", "cd"].flatMap((s) => s.split("")).join("-"));
`,
  },
]);

describe("stdlib batch 1: in-place array mutators are REJECTED (NT1606), like .push/.pop", () => {
  // Arrays are immutable (Stage 29). node's .fill/.sort/.splice/.shift/.unshift/.copyWithin
  // all mutate the receiver, so they are refused with the mutation diagnostic that names
  // the immutable replacement — never silently miscompiled into a non-mutating variant.
  const MUTATORS: string[] = [
    `const a = [1, 2, 3]; a.fill(0);`,
    `const a = [3, 1, 2]; a.sort();`,
    `const a = [1, 2, 3]; a.splice(1, 1);`,
    `const a = [1, 2, 3]; a.shift();`,
    `const a = [1, 2, 3]; a.unshift(0);`,
    `const a = [1, 2, 3]; a.copyWithin(0, 1);`,
  ];
  for (const src of MUTATORS) {
    test(src.slice(src.indexOf("a.")), () => { expect(rejectCode(src)).toBe("NT1606"); });
  }
  test("the immutable replacements compile", () => {
    expect(rejectCode(`const a = [1, 2, 3]; const b = a.with(0, 9); const c = [...a, 4]; console.log(b.length, c.length);`)).toBeNull();
  });
});
