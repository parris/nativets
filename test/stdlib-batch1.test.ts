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
