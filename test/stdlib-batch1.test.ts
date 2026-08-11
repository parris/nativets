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

/** The full diagnostic a source is rejected with — message and hint, not just the code. */
function rejectDiag(src: string): { code: string; message: string; hint: string } {
  try { sourceToIR(src); } catch (e) {
    if (e instanceof NTError) return { code: e.diag.code, message: e.diag.message, hint: e.diag.hint ?? "" };
    throw e;
  }
  throw new Error(`expected a refusal, but this compiled:\n${src}`);
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
    /*
     * The ZERO-ARGUMENT `.slice()`. `"abc".slice()` is the whole string and `[1,2].slice()`
     * is a copy — ordinary TypeScript that nativets rejected with
     * `[NT2001] '.slice' expects 1..2 args, got 0`, i.e. an NT2xxx TYPE error blaming a
     * program that is correctly typed (`slice(start?, end?)` — both optional in
     * lib.es5.d.ts; `start` defaults to 0, ES 22.1.3.22 / 23.1.3.28).
     *
     * The arity table follows TYPESCRIPT, not node's runtime laxity, and the two disagree
     * here: node also accepts `"abc".substring()` / `.charAt()` / `.at()`, but
     * lib.es5.d.ts declares those first parameters REQUIRED, so tsc reports TS2554 and
     * NT2001 is the right answer. Pinned below so the two halves cannot drift.
     *
     * `.slice()` is also the idiom that makes an immutable sort legal: `slice` is in
     * `FRESH_ARRAY_CALLS` (src/ast.ts), so `xs.slice().sort()` — the shape this repo's own
     * test files use — is a fresh receiver and permitted.
     */
    name: ".slice() with NO arguments — the whole receiver (ES 22.1.3.22 / 23.1.3.28)",
    code: `
const s = "nativets";
console.log(s.slice(), "".slice(), s.slice() === s, s.slice().length);
const xs = [3, 1, 2];
console.log(xs.slice().length, xs.slice().join(","));
console.log(xs.slice().sort().join(","), xs.join(","));
const ys: string[] = [];
console.log(ys.slice().length);
`,
  },
  {
    /*
     * `.startsWith(search, position)` CLAMPS position to [0, length] before comparing —
     * ES 22.1.3.23 step 5, `start = clamp(pos, 0, len)`, then `if start + searchLen > len
     * return false`. The runtime instead had `if (pos > n || pos + m > n) return 0;`, and
     * that first clause is the bug: with an EMPTY needle past the end the spec compares
     * "" against "" at the clamped index and answers TRUE, while we answered false.
     * `.endsWith` next to it already clamped (`if (end > n) end = n;`), which is what
     * makes this an oversight rather than a decision.
     *
     * BORROWED: tc39/test262 `built-ins/String/prototype/startsWith/` —
     * `searchstring-found-with-position` and the empty-search-string cases. Both sides
     * exit 0, so this was a silent wrong answer, not a refusal.
     */
    name: ".startsWith position is CLAMPED to the length (test262 startsWith/position)",
    code: `
const s = "nativets";
console.log(s.startsWith("", s.length), s.startsWith("", s.length + 1), s.startsWith("", 99));
console.log("".startsWith("", 0), "".startsWith("", 5), "".endsWith("", 5));
console.log(s.startsWith("ts", 6), s.startsWith("ts", 7), s.startsWith("ts", 99));
console.log(s.startsWith("nat", -1), s.startsWith("nat", -99), s.startsWith("", -1));
console.log(s.endsWith("", 99), s.endsWith("", 0), s.endsWith("nativets", 99));
`,
  },
  {
    /*
     * `.lastIndexOf(search, position)` — the second argument. `.indexOf` already took a
     * `fromIndex`; its mirror was capped at one argument, so the backwards search from a
     * point (`line.lastIndexOf("(", at)` — a shape this repo's own `test/tsc.test.ts`
     * uses) was rejected as `[NT2001] '.lastIndexOf' expects 1..1 args, got 2`.
     *
     * ES 22.1.3.11 is deliberately NOT symmetric with `.indexOf`: `position` is where the
     * match may START (not end), it is CLAMPED to [0, len], and an OMITTED-or-NaN position
     * means +Infinity, not 0 — so `lastIndexOf(x)` searches the whole string while
     * `lastIndexOf(x, 0)` searches only position 0. Getting that backwards is the natural
     * bug and every case below separates the two.
     *
     * BORROWED: tc39/test262 `built-ins/String/prototype/lastIndexOf/` —
     * `position-tointeger-*` and the NaN-position cases (`S15.5.4.8_A4_T*`).
     */
    name: ".lastIndexOf(search, position) — position is a START, clamped, NaN means +Infinity",
    code: `
const s = "abcabc";
console.log(s.lastIndexOf("b"), s.lastIndexOf("b", 4), s.lastIndexOf("b", 3));
console.log(s.lastIndexOf("b", 2), s.lastIndexOf("b", 1), s.lastIndexOf("b", 0));
console.log(s.lastIndexOf("b", 99), s.lastIndexOf("b", -1), s.lastIndexOf("b", -99));
console.log(s.lastIndexOf("abc", 0), s.lastIndexOf("abc", 2), s.lastIndexOf("abc", 3));
console.log("aaa".lastIndexOf("aa", 0), "aaa".lastIndexOf("aa", 1), "aaa".lastIndexOf("aa", 9));
console.log("abc".lastIndexOf("", 0), "abc".lastIndexOf("", 1), "abc".lastIndexOf("", 99));
console.log("abc".lastIndexOf("", -1), "".lastIndexOf("", 0), "".lastIndexOf("", 9));
console.log("abc".lastIndexOf("d", 1), "abc".lastIndexOf("abcd", 9));
console.log(s.lastIndexOf("b", 0 / 0), "abc".lastIndexOf("a", 0 / 0));
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
  /*
   * `.indexOf(search, fromIndex)` — the 2-argument form (ECMA-262 22.1.3.9). Only the
   * 1-argument form existed, so `t.indexOf('"', i + 1)` — ordinary JS, and the shape a
   * scanner is written with — was `'.indexOf' expects 1..1 args, got 2`. It was the
   * first blocker for eight of the twelve compiler modules (`src/ast.ts`'s
   * `widenLiteralTys`).
   *
   * The edges are the whole feature, and each row is one: `fromIndex` past the match,
   * past the END, NEGATIVE (clamps to 0), and fractional; plus the EMPTY needle, which
   * answers the clamped position itself and so is the one case that can return `len`.
   * node is the oracle for every value.
   */
  {
    name: ".indexOf(search, fromIndex) — clamping, negatives, and the empty needle",
    code: `
const s = "abcabc";
console.log(s.indexOf("b", 0), s.indexOf("b", 2), s.indexOf("b", 4), s.indexOf("b", 5));
console.log(s.indexOf("b", -3), s.indexOf("b", 99), s.indexOf("abc", 1), s.indexOf("z", 1));
console.log(s.indexOf("", 3), s.indexOf("", 6), s.indexOf("", 99), s.indexOf("", -1));
console.log(s.indexOf("c", 2.7), "".indexOf("", 0), "".indexOf("x", 0));
console.log(s.indexOf("abc"), s.indexOf("abc", 0));
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
    /*
     * `Array#indexOf(x, fromIndex)` / `Array#lastIndexOf(x, fromIndex)` — the second
     * argument, optional in lib.es5.d.ts and so not a type error, but capped at one here
     * (`[NT2001] .indexOf expects 1 args`).
     *
     * The two clamp DIFFERENTLY and that is the whole content of the feature
     * (ES 23.1.3.17 / 23.1.3.20): a negative fromIndex counts from the end for BOTH, but
     * on underflow `indexOf` restarts at 0 while `lastIndexOf` gives up and returns -1;
     * `indexOf` past the end is -1 while an OMITTED `lastIndexOf` index means len-1. Each
     * line below separates one of those from the plausible wrong answer.
     *
     * BORROWED: tc39/test262 `built-ins/Array/prototype/indexOf/` and `lastIndexOf/` —
     * the `fromIndex-*` families (`15.4.4.14-9-*` / `15.4.4.15-8-*`).
     */
    name: "Array#indexOf / #lastIndexOf take a fromIndex, and clamp it differently",
    code: `
const a = [1, 2, 3, 2, 1];
console.log(a.indexOf(2), a.indexOf(2, 0), a.indexOf(2, 2), a.indexOf(2, 4));
console.log(a.indexOf(1, -1), a.indexOf(1, -5), a.indexOf(1, -99), a.indexOf(1, 99));
console.log(a.lastIndexOf(2), a.lastIndexOf(2, 2), a.lastIndexOf(2, 0));
console.log(a.lastIndexOf(1, -1), a.lastIndexOf(1, -5), a.lastIndexOf(1, -99));
console.log(a.lastIndexOf(1, 99), a.lastIndexOf(9, 2));
const s = ["a", "b", "a", "b"];
console.log(s.indexOf("b", 2), s.indexOf("b", 4), s.lastIndexOf("a", 1), s.lastIndexOf("a", -3));
const e: number[] = [];
console.log(e.indexOf(1, 0), e.indexOf(1, -1), e.lastIndexOf(1, 0), e.lastIndexOf(1, -1));
`,
  },
  {
    /*
     * A NON-INTEGER fromIndex is TRUNCATED TOWARD ZERO FIRST (ToIntegerOrInfinity), and
     * only then tested for underflow — so on a 5-element array `-5.5` becomes `-5`, which
     * is index 0, NOT an underflow. Comparing the raw double against `-len` instead gets
     * `lastIndexOf(x, -5.5)` wrong by returning -1 where node returns 0; the `indexOf`
     * side happens to land on the same answer, which is exactly why it needs its own case.
     * The infinities are the other end of the same step.
     *
     * BORROWED: tc39/test262 `Array/prototype/lastIndexOf/` `fromIndex-*` (the
     * `-Infinity` / non-integer members of the family).
     */
    name: "Array fromIndex is truncated toward zero BEFORE the underflow test",
    code: `
const a = [1, 2, 3, 2, 1];
console.log(a.indexOf(1, -5.5), a.lastIndexOf(1, -5.5));
console.log(a.indexOf(1, -4.5), a.lastIndexOf(1, -4.5));
console.log(a.indexOf(2, 1.9), a.lastIndexOf(2, 3.9));
console.log(a.indexOf(1, -0.5), a.lastIndexOf(1, -0.5));
console.log(a.indexOf(1, -6.5), a.lastIndexOf(1, -6.5));
console.log(a.indexOf(1, -1 / 0), a.lastIndexOf(1, -1 / 0));
console.log(a.indexOf(1, 1 / 0), a.lastIndexOf(1, 1 / 0));
console.log(a.indexOf(1, 0 / 0), a.lastIndexOf(1, 0 / 0));
`,
  },
  {
    /*
     * The EMPTY receiver, with a fromIndex strictly between -1 and 0. ES 23.1.3.20 step 6
     * is `k = min(n, len - 1)` for a non-negative n, and that `min` is not decoration:
     * `-0.5` truncates toward zero to `0`, which is `>= 0` and therefore takes the
     * non-negative branch, so without the clamp the backward scan starts at index 0 of a
     * ZERO-LENGTH array. That is a read one past the end — it SEGFAULTED for a string
     * receiver (a garbage pointer handed to strcmp) and silently returned a wrong answer
     * for a number one.
     *
     * It is a narrow window and it was a bug in this lane's own first draft: every
     * INTEGER fromIndex escapes it (a negative one takes the `len + n` branch, and `0`
     * itself is caught by the `fromd >= len` guard when len is 0), so only a FRACTIONAL
     * negative index on an EMPTY array reaches it. `.indexOf` is immune for a structural
     * reason — its loop is bounded by `i < len` — which is why the pair is tested here
     * and not just the one that crashed.
     */
    name: "an empty receiver with a fractional negative fromIndex (the min(n, len-1) clamp)",
    code: `
const e: number[] = [];
const es: string[] = [];
for (const f of [-0.5, -0.25, -0.75, -1, 0, 1, -1.5, 0 / 0, 1 / 0, -1 / 0]) {
  console.log(f, e.indexOf(1, f), e.lastIndexOf(1, f), es.indexOf("a", f), es.lastIndexOf("a", f));
}
const one = [7];
const oneS = ["a"];
for (const f of [-0.5, -0.25, -1, 0, 0.5, 1]) {
  console.log(f, one.indexOf(7, f), one.lastIndexOf(7, f), oneS.indexOf("a", f), oneS.lastIndexOf("a", f));
}
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

differential("stdlib batch 1: Object.entries / Object.fromEntries match node", [
  {
    name: "Object.entries(o) — [key, value] pairs in insertion order (string-valued objects)",
    code: `
const o = { name: "ada", role: "eng" };
const e = Object.entries(o);
console.log(e.length, e[0][0], e[0][1], e[1][0], e[1][1]);
for (const kv of e) { console.log(kv[0] + "=" + kv[1]); }
console.log(e[1].join(":"), e.length === Object.keys(o).length);
`,
  },
  {
    name: "Object.fromEntries([[k, v], ...]) with literal keys — the inverse of entries",
    code: `
const o = Object.fromEntries([["a", 1], ["b", 2]]);
console.log(o.a, o.b, o.a + o.b);
const s = Object.fromEntries([["name", "ada"]]);
console.log(s.name, Object.keys(s).join(","));
console.log(JSON.stringify(Object.fromEntries([["x", 10], ["y", 20]])));
`,
  },
]);

differential("stdlib batch 1: Number statics match node", [
  {
    name: "Number constants — MAX/MIN_SAFE_INTEGER, EPSILON, MAX/MIN_VALUE, infinities",
    code: `
console.log(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
console.log(Number.EPSILON);
console.log(Number.MAX_VALUE, Number.MIN_VALUE);
console.log(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
console.log(Number.MAX_SAFE_INTEGER + 1 === Number.MAX_SAFE_INTEGER + 2);
console.log(0.1 + 0.2 - 0.3 < Number.EPSILON);
`,
  },
  {
    name: "Number.isNaN / Number.parseInt / Number.parseFloat (no coercion; same as the globals)",
    code: `
console.log(Number.isNaN(NaN), Number.isNaN(1), Number.isNaN(0 / 0));
console.log(Number.parseInt("42px"), Number.parseInt("ff", 16), Number.parseInt("zz"));
console.log(Number.parseFloat("3.5x"), Number.parseFloat("nope"));
console.log(Number.isInteger(4), Number.isFinite(1 / 0), Number.isSafeInteger(2 ** 53));
`,
  },
]);

/*
 * The `Math.*` DATA properties. `Math` was reachable only as a call callee
 * (`Math.floor(x)`), so a member READ had no path of its own and fell through to the
 * generic identifier resolution, which reported `NT2001 'Math' is not defined` — a
 * message that is FALSE, since `Math.floor(1.5)` on the line above compiles. This
 * mirrors the `Number.*` constants above, whose member-read path already existed.
 *
 * BORROWED: tc39/test262 `built-ins/Math/{E,PI,LN2,LN10,LOG2E,LOG10E,SQRT2,SQRT1_2}/`
 * — one directory per constant, each with a `value.js` asserting the exact double and a
 * `prop-desc.js` asserting it is non-writable/non-configurable (so folding the read to a
 * literal is observationally right — nothing can ever change it). The expected output is
 * node's, not transcribed.
 */
differential("stdlib batch 1: the Math constants match node", [
  {
    name: "all eight Math data properties, read as values",
    code: `
console.log(Math.E, Math.PI);
console.log(Math.LN2, Math.LN10);
console.log(Math.LOG2E, Math.LOG10E);
console.log(Math.SQRT2, Math.SQRT1_2);
`,
  },
  {
    name: "a Math constant flows through every position an ordinary number does",
    code: `
console.log(String(Math.PI));
console.log(Number(Math.E));
console.log(\`\${Math.PI}\`);
console.log((Math.PI).toFixed(3));
const x = Math.PI;
console.log(x * 2, Math.floor(Math.PI), Math.max(Math.E, Math.PI));
`,
  },
]);

/*
 * The other half of the Math-constant path: what must STAY refused, and with what words.
 *
 * `MATH_CONSTS` is a `Map` for a behavioural reason, and this pins it. Were it a plain
 * object, `Math.constructor` would read through `Object.prototype`, answer a FUNCTION,
 * satisfy the `!== undefined` guard, and fold to `NaN` — exit 0, wrong output, the
 * silent-wrong-answer class. `NUMBER_CONSTS` shipped exactly that bug (six inherited
 * names; see `test/record-dict.test.ts`), so the same six are pinned here.
 */
describe("stdlib batch 1: a non-constant Math member is REFUSED, never folded", () => {
  const REFUSED: string[] = [
    `console.log(Math.constructor);`,     // node: [Function: Object]
    `console.log(Math.toString);`,        // node: [Function: toString]
    `console.log(Math.hasOwnProperty);`,  // node: [Function: hasOwnProperty]
    `console.log(Math.valueOf);`,         // node: [Function: valueOf]
    `console.log(Math.NOPE);`,            // node: undefined
    `console.log(Math.pi);`,              // node: undefined — the constants are CASE-sensitive
    `console.log(Math.floor);`,           // node: [Function: floor] — a method as a VALUE
  ];
  for (const src of REFUSED) {
    test(`refused: ${src.trim()}`, () => { expect(rejectCode(src)).toBe("NT1002"); });
  }

  test("a user binding named Math SHADOWS the builtin, as in node", async () => {
    const { ours, oracle } = await expectMatchesNode(`
const Math = { PI: 1, floor: 2 };
console.log(Math.PI, Math.floor);
`);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * A builtin named as a bare VALUE. `'Math' is not defined` was a FALSE sentence — the
 * same one `Math.PI` used to produce — and it points a reader at a missing import rather
 * than at the unimplemented feature. It is also filed in the wrong band: `src/coverage.ts`
 * counts only NT1xxx into its blocker histogram, so as an NT2xxx ("the user's type
 * error") every one of these was invisible to the burn-down meant to find it. Same
 * argument the `process.*` host reads were re-banded under.
 *
 * The hint ASSERTS that the compiler implements the name's members, so every namespace
 * listed has a member proven against node above or in the fixtures; a name with no member
 * support (`Promise`) keeps the honest `not defined`.
 */
describe("stdlib batch 1: a known builtin used as a value says so, and is not called undefined", () => {
  for (const name of ["Math", "JSON", "console", "Number", "String", "Object", "Array", "Date"]) {
    test(`\`const v = ${name}\` names the real gap`, () => {
      const d = rejectDiag(`const v = ${name};\nconsole.log(typeof v);\n`);
      expect(d.code).toBe("NT1002");
      expect(d.message).toContain(`'${name}'`);
      expect(d.message).not.toContain("is not defined");
      expect(d.hint).toContain(`${name}.`);
    });
  }

  test("a genuinely unknown name is still NT2001 'is not defined'", () => {
    const d = rejectDiag(`const v = nosuchthing;\nconsole.log(v);\n`);
    expect(d.code).toBe("NT2001");
    expect(d.message).toBe("'nosuchthing' is not defined");
  });

  test("a builtin with no implemented members keeps the honest 'not defined'", () => {
    // The hint the branch above emits would be a LIE for a name whose members are all
    // missing, so `Promise` must not be in the set until one of them lands.
    expect(rejectDiag(`const v = Promise;\nconsole.log(v);\n`).code).toBe("NT2001");
  });
});

/*
 * `Math.round` — ECMAScript 21.3.2.28, which is NOT `floor(x + 0.5)`.
 *
 * The runtime shipped `double js_math_round(double x) { return floor(x + 0.5); }` with
 * the comment "JS semantics", and nothing in the corpus ever tested it beyond
 * `Math.round(3.5)` (test/corpus/gap_cases.json) — a value on which the two agree. The
 * addition is the bug: `x + 0.5` is a DOUBLE add, so it rounds, and for large or
 * near-half x it rounds into the next integer BEFORE the floor sees it.
 *
 * BORROWED: tc39/test262 `built-ins/Math/round/` — `S15.8.2.15_A1` (the -0 results) and
 * the `exponent-boundaries` / large-integer cases; the `0.49999999999999994` value is
 * V8's own regression case for exactly this `floor(x+0.5)` formulation (it is the
 * largest double below 0.5, and `x + 0.5` rounds it up to exactly 1.0).
 *
 * Every expected value below was MEASURED from node, and the four integer answers are
 * ordinary wrong answers, not sign-of-zero pedantry: `Math.round(Number.MAX_SAFE_INTEGER)`
 * returned MAX_SAFE_INTEGER + 1. Both sides exit 0 — the silent-wrong-answer class.
 */
differential("stdlib batch 1: Math.round matches node (ES 21.3.2.28, NOT floor(x+0.5))", [
  {
    name: "halves round toward +Infinity; the classic cases",
    code: `
console.log(Math.round(0.5), Math.round(-0.5), Math.round(1.5), Math.round(-1.5));
console.log(Math.round(2.5), Math.round(-2.5), Math.round(8.5), Math.round(-8.5));
console.log(Math.round(3.5), Math.round(-3.5), Math.round(0.1), Math.round(-0.1));
`,
  },
  {
    name: "0.49999999999999994 — `x + 0.5` rounds UP to 1.0 before the floor (V8's regression case)",
    code: `
console.log(Math.round(0.49999999999999994));
console.log(Math.round(-0.49999999999999994));
console.log(Math.round(0.5 - Number.EPSILON / 4));
`,
  },
  {
    name: "large integers are returned unchanged — `x + 0.5` is not exact past 2**52",
    code: `
console.log(Math.round(4503599627370496));
console.log(Math.round(4503599627370497));
console.log(Math.round(-4503599627370497));
console.log(Math.round(9007199254740991));
console.log(Math.round(Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER);
console.log(Math.round(1e21), Math.round(-1e21));
`,
  },
  {
    name: "negative zero is PRESERVED: -0.5 <= x < 0 rounds to -0, and so does -0 itself",
    code: `
console.log(Math.round(-0), Math.round(-0.5), Math.round(-0.1), Math.round(-1e-323));
console.log(1 / Math.round(-0.5), 1 / Math.round(-0.2), 1 / Math.round(-0));
console.log(1 / Math.round(0), 1 / Math.round(0.1));
`,
  },
  {
    name: "NaN and the infinities pass through",
    code: `
console.log(Math.round(NaN), Math.round(Infinity), Math.round(-Infinity));
console.log(Math.round(1 / 0), Math.round(-1 / 0));
`,
  },
]);

differential("stdlib batch 1: Number#toFixed matches node (exact decimal rounding)", [
  {
    name: "toFixed — ties round UP on the magnitude, binary-inexact values do NOT",
    code: `
console.log((1.25).toFixed(1), (1.35).toFixed(1), (2.5).toFixed(0), (0.5).toFixed(0));
console.log((1.005).toFixed(2), (1.045).toFixed(2), (8.345).toFixed(2));
console.log((3.14159).toFixed(0), (3.14159).toFixed(2), (3.14159).toFixed(5), (3.14159).toFixed(8));
console.log((0).toFixed(0), (0).toFixed(3), (-0).toFixed(2));
console.log((-1.25).toFixed(1), (-0.0001).toFixed(2), (-2.5).toFixed(0));
console.log((123.456).toFixed(), (99.99).toFixed(1), (9.995).toFixed(2));
`,
  },
  {
    name: "toFixed — big/small magnitudes, NaN and Infinity, and money-style formatting",
    code: `
console.log((1e21).toFixed(2), (1.7e22).toFixed(0));
console.log((NaN).toFixed(2), (1 / 0).toFixed(2), (-1 / 0).toFixed(2));
console.log((1234567.891).toFixed(2), (0.000001).toFixed(7), (1e-7).toFixed(10));
const price = 19.999;
console.log("$" + price.toFixed(2), (price * 3).toFixed(2));
let total = 0;
for (let i = 0; i < 10; i++) { total += 0.1; }
console.log(total.toFixed(2), total.toFixed(17));
`,
  },
]);

differential("stdlib batch 1: Number#toString(radix) matches node", [
  {
    name: "toString() and toString(radix) — integers, fractions, negatives, every common radix",
    code: `
console.log((255).toString(16), (255).toString(2), (255).toString(8), (255).toString(36));
console.log((0).toString(2), (1).toString(2), (-255).toString(16));
console.log((3735928559).toString(16), (1e9).toString(36));
console.log((0.5).toString(2), (0.1).toString(2));
console.log((1 / 3).toString(3), (3.75).toString(2), (-2.5).toString(8));
console.log((123).toString(), (12.5).toString(), (255).toString(10));
console.log((2 ** 60).toString(16), (2 ** 60).toString(2));
`,
  },
]);

differential("stdlib batch 1: btoa / atob (base64) match node", [
  {
    name: "btoa/atob — round trip, every padding length, the empty string",
    code: `
console.log(btoa("hello"), btoa("hi"), btoa("h"), btoa(""));
console.log(atob("aGVsbG8="), atob("aGk="), atob("aA=="), atob(""));
console.log(atob(btoa("nativets: TS to native")) === "nativets: TS to native");
console.log(btoa("Man"), btoa("Ma"), btoa("M"));
console.log(btoa("nativets").length, atob("bmF0aXZldHM="));
`,
  },
]);

differential("stdlib batch 1: structuredClone (type-directed deep copy) matches node", [
  {
    name: "structuredClone — scalars pass through, objects/arrays are NEW (not the same reference)",
    code: `
console.log(structuredClone(5), structuredClone("hi"), structuredClone(true));
const arr = [1, 2, 3];
const ca = structuredClone(arr);
console.log(ca.join("-"), ca.length, ca === arr);
const words = ["a", "b"];
const cw = structuredClone(words);
console.log(cw.join("|"), cw === words);
`,
  },
  {
    name: "structuredClone — DEEP: nested objects and arrays are cloned, not shared",
    code: `
const o = { name: "ada", scores: [1, 2, 3], inner: { x: 1, y: 2 } };
const c = structuredClone(o);
console.log(c.name, c.scores.join(","), c.inner.x + c.inner.y);
console.log(c === o, c.inner === o.inner, c.scores === o.scores);
console.log(JSON.stringify(c));
console.log(JSON.stringify(c) === JSON.stringify(o));
const rows = [{ id: 1 }, { id: 2 }];
const cr = structuredClone(rows);
console.log(cr.length, cr[0].id + cr[1].id, cr === rows, cr[0] === rows[0]);
`,
  },
]);

describe("stdlib batch 1: Date.now() — non-deterministic, so bounded not equal", () => {
  // node cannot be the oracle for a clock read, so this is a BEHAVIORAL test:
  // Date.now() must be a plausible epoch-ms value and must never go backwards.
  test("Date.now() is monotonic and in a plausible epoch-ms range", async () => {
    const { compileAndRun } = await import("./harness.ts");
    const r = await compileAndRun(`
const a = Date.now();
let spin = 0;
for (let i = 0; i < 200000; i++) { spin += i; }
const b = Date.now();
console.log(a);
console.log(b);
console.log(b >= a, spin > 0);
`);
    const [a, b, flags] = r.stdout.trim().split("\n");
    expect(r.exitCode).toBe(0);
    expect(flags).toBe("true true");
    expect(Number(a)).toBeGreaterThan(1.7e12);   // after 2023-11
    expect(Number(a)).toBeLessThan(4e12);        // before 2096
    expect(Number(b)).toBeGreaterThanOrEqual(Number(a));
    expect(Number.isInteger(Number(a))).toBe(true); // whole milliseconds, like node
  });
});

describe("stdlib batch 1: non-ASCII strings — the documented UTF-8-byte divergence", () => {
  // docs/divergences.md §A.2: our strings are UTF-8 BYTES, node's are UTF-16 code
  // units. So for non-ASCII the INDEX SPACE differs, and node cannot be the oracle.
  // These are BEHAVIORAL assertions that pin what we actually do — never silently.
  test("indices/charCodeAt are byte-based; codePointAt still decodes the code point", async () => {
    const { compileAndRun } = await import("./harness.ts");
    const r = await compileAndRun(`
console.log("café".length);          // 5 bytes (node: 4 UTF-16 units)
console.log("é".charCodeAt(0));      // 195 = first UTF-8 byte (node: 233)
console.log("é".codePointAt(0));     // 233 = the code point (node: 233 — same)
console.log("é".length);             // 2 bytes (node: 1)
console.log("abc".charCodeAt(1));    // ASCII is identical to node
console.log(String.fromCharCode(233) === "é"); // encode side round-trips
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(["5", "195", "233", "2", "98", "true", ""].join("\n"));
  });
});

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

/*
 * ARITY FOLLOWS TYPESCRIPT, NOT node's runtime laxity — and the two genuinely disagree.
 *
 * node accepts `"abc".substring()`, `.charAt()` and `.at()`, defaulting the index to 0.
 * lib.es5.d.ts declares all three first parameters REQUIRED, so `tsc` reports TS2554 and
 * the right nativets answer is NT2001, a type error about the USER's program. `.slice`,
 * `.lastIndexOf` and `Array#indexOf`/`#lastIndexOf` are the opposite: tsc accepts the
 * short/long forms, so refusing them was nativets reporting a type error against
 * correctly-typed code.
 *
 * Both halves are pinned because the tempting simplification — "node runs it, so accept
 * it" — quietly admits the FIRST list, i.e. makes nativets accept programs `tsc` rejects.
 * That would not be caught anywhere else: `test/tsc.test.ts` checks `src/` and the
 * `*.test.ts` harness, never the fixture strings inside them.
 */
describe("stdlib batch 1: method ARITY matches TypeScript's lib, in both directions", () => {
  const TSC_REQUIRES_IT: string[] = [           // tsc: TS2554 -> nativets: NT2001
    `console.log("abc".substring());`,
    `console.log("abc".charAt());`,
    `console.log("abc".at());`,
    `console.log([1, 2].at());`,
  ];
  for (const src of TSC_REQUIRES_IT) {
    test(`refused (tsc requires the argument): ${src.trim()}`, () => {
      expect(rejectCode(src)).toBe("NT2001");
    });
  }

  const TSC_ACCEPTS_IT: string[] = [            // tsc: clean -> nativets must compile
    `console.log("abc".slice());`,
    `console.log([1, 2].slice().length);`,
    `console.log("abcabc".lastIndexOf("b", 2));`,
    `console.log([1, 2, 1].indexOf(1, 1));`,
    `console.log([1, 2, 1].lastIndexOf(1, 1));`,
  ];
  for (const src of TSC_ACCEPTS_IT) {
    test(`accepted (tsc accepts it): ${src.trim()}`, () => {
      expect(rejectCode(src)).toBeNull();
    });
  }

  test("too MANY arguments stays a type error — tsc rejects that too", () => {
    expect(rejectCode(`console.log("abc".slice(0, 1, 2));`)).toBe("NT2001");
    expect(rejectCode(`console.log([1, 2].slice(0, 1, 2).length);`)).toBe("NT2001");
    expect(rejectCode(`console.log([1, 2].indexOf(1, 0, 3));`)).toBe("NT2001");
  });
});
