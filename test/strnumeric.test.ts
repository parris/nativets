/*
 * StringNumericLiteral — `Number(string)` / unary `+` on a string / `parseFloat`.
 *
 * ECMA-262 7.1.4.1 defines TWO grammars, and the difference between them is the whole
 * point of this file:
 *
 *   Number(string)  StringNumericLiteral  = StrWhiteSpace? StrNumericLiteral StrWhiteSpace?
 *                   StrNumericLiteral     = NonDecimalIntegerLiteral | StrDecimalLiteral
 *                   ...whole-string match: any trailing garbage is NaN, blank is 0.
 *
 *   parseFloat      StrDecimalLiteral only, LONGEST PREFIX: trailing garbage is ignored,
 *                   and there is no `0b`/`0o`/`0x` production at all.
 *
 * Both used to be `strtod` with a four-character whitespace trim, and strtod is neither
 * grammar. It is wider in four separate places, each of which produced a plausible
 * number at exit 0 where node produces NaN:
 *
 *     Number("infinity")   Infinity   node NaN   -- strtod matches inf/infinity ANY case
 *     Number("0x1p3")      8          node NaN   -- C99 hex floats have no JS spelling
 *     Number("-0x10")      -16        node NaN   -- no sign in the NonDecimal production
 *     parseFloat("0x1f")   31         node 0     -- no hex in StrDecimalLiteral at all
 *
 * and narrower in two:
 *
 *     Number("0b101")      NaN        node 5     -- 0b/0o were simply missing
 *     Number("\u00a0") NaN        node 0     -- 21 of the 25 WhiteSpace code points
 *
 * Cases are taken from test262: `test/language/types/number/S8.5_A*`, the ToNumber-of-
 * String battery `S9.3.1_A2` (StrWhiteSpace) / `A4.1`,`A4.2` (Infinity) / `A6`
 * (HexIntegerLiteral) / `A7` (exponent), and `test/built-ins/parseFloat/S15.1.2.3_A*`.
 * `node` is the oracle for every one: byte-for-byte stdout plus exit code.
 *
 * Non-ASCII whitespace is written with `\u` escapes, never as a raw byte — a raw NBSP
 * in a fixture is invisible in a diff and the next editor to touch the file normalises
 * it away.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";

interface Case { name: string; code: string }

/** Every line of `code` is one `console.log`; node decides what it should print. */
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

const log = (...exprs: string[]): string => exprs.map((e) => `console.log(${e});`).join("\n") + "\n";

differential("StringNumericLiteral: StrWhiteSpace is the full ECMAScript set", [
  {
    // test262 S9.3.1_A2 — a string of ONLY whitespace is 0, over all 25 code points.
    // The old four-character set answered NaN for 21 of them.
    name: "a whitespace-only string is 0, for every WhiteSpace and LineTerminator",
    code: log(
      'Number("\\u0009")', 'Number("\\u000b")', 'Number("\\u000c")', 'Number("\\u0020")',
      'Number("\\u00a0")', 'Number("\\ufeff")', 'Number("\\u000a")', 'Number("\\u000d")',
      'Number("\\u2028")', 'Number("\\u2029")', 'Number("\\u1680")', 'Number("\\u2000")',
      'Number("\\u200a")', 'Number("\\u202f")', 'Number("\\u205f")', 'Number("\\u3000")',
      'Number("\\u000b\\u00a0\\ufeff\\u3000")',
    ),
  },
  {
    // The same set must be strippable from BOTH ends, and must not swallow a digit.
    name: "leading and trailing whitespace is stripped, the number between it is not",
    code: log(
      'Number("\\u00a01\\u00a0")', 'Number("\\ufeff2.5\\u2029")', 'Number("\\u000b1")',
      'Number(" \\t\\n\\r")', 'Number("")', 'Number("  12  ")',
      'parseFloat("\\u00a01.5")', 'parseFloat("\\u3000-2e2rest")',
    ),
  },
  {
    // U+180E stopped being Zs in Unicode 6.3; test262 (trim/u180e.js) pins that it is
    // NOT whitespace. The runtime shares one table with `.trim()`, so pin it here too.
    name: "U+180E is not whitespace, in Number as in trim",
    code: log('Number("\\u180e")', 'Number("\\u180e1")', 'JSON.stringify("\\u180e".trim())'),
  },
]);

differential("StringNumericLiteral: `Infinity` is spelled exactly that way", [
  {
    // test262 S9.3.1_A4.1 / A4.2 (and parseFloat S15.1.2.3_A6). strtod took every one
    // of the rejected spellings, which is the direction that keeps a bad program going.
    name: "only the exact spelling is Infinity; inf / infinity / INFINITY are NaN",
    code: log(
      'Number("Infinity")', 'Number("+Infinity")', 'Number("-Infinity")',
      'Number("infinity")', 'Number("INFINITY")', 'Number("inf")', 'Number("Infinit")',
      'Number("Infinityx")', 'Number("  Infinity  ")',
      'parseFloat("infinity")', 'parseFloat("inf")', 'parseFloat("Infinityx")',
      'parseFloat("-Infinity!")',
    ),
  },
  {
    // strtod also spells NaN. `Number("nan")` was already NaN, but only by coincidence
    // of the answer — `parseFloat("nanny")` shows it was really being PARSED.
    name: "`nan` is not a numeric literal either",
    code: log('Number("nan")', 'Number("NaN")', 'parseFloat("nan")', 'parseFloat("nanny")'),
  },
]);

differential("StringNumericLiteral: the 0b / 0o / 0x productions", [
  {
    // ES2015 added 0b/0o to StringNumericLiteral; this runtime knew only 0x.
    name: "Number accepts binary, octal and hex, in both prefix cases",
    code: log(
      'Number("0b101")', 'Number("0B11")', 'Number("0o17")', 'Number("0O7")',
      'Number("0x1f")', 'Number("0X1F")', 'Number("0b0")', 'Number("0x00ff")',
    ),
  },
  {
    // Digits must be IN the radix, and there has to be at least one.
    name: "a malformed non-decimal literal is NaN, not a partial read",
    code: log(
      'Number("0b")', 'Number("0o")', 'Number("0x")', 'Number("0b2")', 'Number("0o18")',
      'Number("0xg")', 'Number("0b101.1")', 'Number("0x1f ")', 'Number("0b 1")',
    ),
  },
  {
    // The old code let strtod see the whole string, so C99's hex-float `p` exponent and
    // a leading sign both came back as numbers. StrNumericLiteral has neither.
    name: "no hex-float exponent, and no sign in front of a non-decimal prefix",
    code: log(
      'Number("0x1p3")', 'Number("0x1P3")', 'Number("0x1.8p1")',
      'Number("-0x10")', 'Number("+0x10")', 'Number("-0b1")', 'Number("+0o7")',
    ),
  },
  {
    // Beyond 64 significant bits the digits must round ONCE, not once per digit.
    name: "a non-decimal literal wider than a double is correctly rounded",
    code: log(
      'Number("0xFFFFFFFFFFFFFFFFFF")',
      'Number("0b1111111111111111111111111111111111111111111111111111111111111111")',
      'Number("0x20000000000000")',   // 2^53
      'Number("0x20000000000001")',   // 2^53 + 1 -> ties to 2^53
      'Number("0x20000000000003")',   // 2^53 + 3 -> ties UP, to 2^53 + 4
      'Number("0o' + "7".repeat(400) + '")',   // overflows to Infinity
      // Past 65536 dropped bit-places the fold stops counting, because the answer cannot
      // be anything but Infinity from there and an unbounded count is signed overflow.
      // 20000 hex digits is ~80000 places, so this is the saturating branch.
      'Number("0x1' + "f".repeat(20000) + '")',
    ),
  },
  {
    /*
     * The digits that fall off the bottom of the 64-bit fold still decide the LAST bit,
     * whenever what is left sits exactly on a tie. Each literal below is one such tie:
     * ties-to-even rounds the retained bits DOWN, and only the nonzero tail — carried as
     * a sticky bit — pushes it back up to the value node prints. Found by sweeping the
     * fold against Python's correctly-rounded int->float over random wide literals;
     * without the sticky bit every one of these is off by one ulp, silently.
     */
    name: "digits below the 64-bit fold still break a tie in the last place",
    code: log(
      'Number("0x85f2dd6ac97954004")',
      'Number("0x8f0d3f8da47ff4007e")',
      'Number("0x84b73c19213a7400a52d")',
      'Number("0b110111100101011011010100001011111000110001000111101001000000000001")',
      'Number("0o160307004555451361200073147036")',
    ),
  },
]);

differential("StringNumericLiteral: StrDecimalLiteral shape", [
  {
    // test262 S8.5_A* / S9.3.1_A5-A7 — where a decimal literal is allowed to stop.
    name: "the mantissa needs a digit on one side of the point, the exponent needs one after `e`",
    code: log(
      'Number("1.")', 'Number(".5")', 'Number("+.5")', 'Number("-1.")', 'Number("1.5e3")',
      'Number(".")', 'Number("+")', 'Number("-")', 'Number("e5")', 'Number(".e1")',
      'Number("1e")', 'Number("1e+")', 'Number("1e2")', 'Number("1E-2")',
    ),
  },
  {
    name: "no numeric separators, no whitespace inside, no double sign",
    code: log('Number("1_0")', 'Number("1 2")', 'Number("- 1")', 'Number("--1")', 'Number("+-1")'),
  },
  {
    // Signed zero survives, and the extremes saturate the way node's does.
    name: "signed zero, overflow and underflow",
    code: log('Number("-0")', 'Number("-0.0")', 'Number("1e999")', 'Number("-1e999")', 'Number("1e-999")'),
  },
]);

differential("parseFloat is a prefix read of StrDecimalLiteral", [
  {
    // test262 S15.1.2.3_A2 — trailing garbage is ignored rather than fatal.
    name: "the longest valid prefix wins and the rest is dropped",
    code: log(
      'parseFloat("1.5abc")', 'parseFloat("1e")', 'parseFloat("1e+")', 'parseFloat("3.14 15")',
      'parseFloat("-2.5e3xyz")', 'parseFloat(".5.5")', 'parseFloat("1.")',
    ),
  },
  {
    // The prefixes belong to Number alone: parseFloat reads `0` and stops at the letter.
    name: "no 0x / 0b / 0o prefix — parseFloat stops at the letter",
    code: log(
      'parseFloat("0x1f")', 'parseFloat("0x10")', 'parseFloat("  0x10  ")',
      'parseFloat("0b101")', 'parseFloat("0o17")', 'parseFloat("0xg")',
      // What it stops on is the digit `0`, which keeps the SIGN — console.log shows -0.
      'parseFloat("-0x10")', 'parseFloat("+0x10")',
    ),
  },
  {
    name: "no prefix at all is NaN",
    code: log('parseFloat("")', 'parseFloat("  ")', 'parseFloat(".")', 'parseFloat("+")', 'parseFloat("abc")'),
  },
]);

differential("unary + and ToNumber share one implementation", [
  {
    // `+x` and `Number(x)` are the same operation; they must not drift apart.
    name: "unary + on a string goes through the same grammar",
    code: log(
      '+"0b101"', '+"infinity"', '+"0x1p3"', '+"\\u000b"', '+"  1.5  "', '+"1e"',
    ),
  },
]);
