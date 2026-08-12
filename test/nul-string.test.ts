/*
 * A NUL (U+0000) inside a string, and the silent wrong answer it used to be.
 *
 * nativets strings are NUL-terminated UTF-8 `const char*` in the C runtime
 * (`runtime.c`: `js_str_len` is `strlen`), so a NUL inside a string value truncates it.
 * `const s = "a\0b"; console.log(s.length)` printed `1`; node prints `3`. That is the
 * worst outcome available under the prime directive, and it had a guard on exactly ONE
 * door already — `NT1704`, for a `with { type: "text" }` import whose file contains a
 * NUL byte (test/textimport.test.ts). This file puts the same rule on the other doors
 * the compiler can see at COMPILE time: string and template LITERALS.
 *
 * The rule is `NT1705`: a string or template literal whose VALUE contains U+0000 is
 * refused. Every spelling reaches it, because the check is on the decoded value:
 * `\0`, `\x00`, `\u0000`, `\u{0}`, and a raw NUL byte pasted into the source.
 *
 * Runtime NULs (`String.fromCharCode(0)`, a byte read from the host FS) are NOT
 * closed by this rule and cannot be — see docs/divergences.md.
 *
 * Escape semantics were checked against node and test262
 * (test/language/literals/string/): `legacy-octal-escape-sequence.js` — `'\0'` is
 * `'\x00'`, and `\0` FOLLOWED by a digit is a LegacyOctalEscapeSequence (`'\01'` is
 * `'\x01'`, not NUL + "1"); `legacy-non-octal-escape-sequence-8-non-strict.js` —
 * `'\8'` is `'8'`. Both octal forms are strict-mode SyntaxErrors, and nativets
 * refuses them here rather than decoding them wrongly.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92); // a backslash, without writing one in a template

function codeOf(source: string): string | null {
  try { sourceToIR(source); return null; }
  catch (e) { return e instanceof NTError ? e.diag.code : `threw ${String((e as Error).message).slice(0, 80)}`; }
}

describe("a NUL in a literal is refused (NT1705), never silently truncated", () => {
  test('the \\0 escape — the original repro, which printed 1 where node prints 3', () => {
    expect(codeOf('const s = "a' + BS + '0b";\nconsole.log(s.length);\n')).toBe("NT1705");
  });

  test("the \\x00 escape — \\xHH already lexed (test/hex-escape.test.ts); 00 is the one value it may not produce", () => {
    expect(codeOf('const s = "a' + BS + 'x00b";\nconsole.log(s.length);\n')).toBe("NT1705");
    // At the very start and the very end of the value, not only in the middle.
    expect(codeOf('const s = "' + BS + 'x00tail";\nconsole.log(s.length);\n')).toBe("NT1705");
    expect(codeOf('const s = "head' + BS + 'x00";\nconsole.log(s.length);\n')).toBe("NT1705");
    // …and NOT `\X00`: only a LOWERCASE `x` starts a HexEscapeSequence, so node reads
    // `\X` as a NonEscapeSequence and the value is the three characters "X00". Checked
    // against node — refusing it would be refusing a perfectly representable string.
    expect(codeOf('const s = "' + BS + 'X00";\nconsole.log(s.length);\n')).toBe(null);
  });

  test("a raw NUL BYTE pasted into the source, which no escape syntax is involved in", () => {
    expect(codeOf('const s = "a' + NUL + 'b";\nconsole.log(s.length);\n')).toBe("NT1705");
    expect(codeOf("const s = `a" + NUL + "b`;\nconsole.log(s.length);\n")).toBe("NT1705");
  });

  /*
   * A template literal has its OWN escape decoder (`buildTemplate`), and it was a
   * different, smaller one than the lexer's: `\0` in a template decoded to the character
   * "0" and `\x00` to "x00" — wrong values that a `.length` check cannot even see
   * (`` `a\0b` `` was 3 characters either way, just the wrong three). The two decoders
   * now agree, which is what routes a template's NUL into the same refusal.
   */
  test("a template literal's own escapes reach the same rule", () => {
    expect(codeOf("const s = `a" + BS + "0b`;\nconsole.log(s.length);\n")).toBe("NT1705");
    expect(codeOf("const s = `a" + BS + "x00b`;\nconsole.log(s.length);\n")).toBe("NT1705");
    // After a substitution, too — the quasi that follows `${…}` is decoded separately.
    expect(codeOf("const n = 1;\nconst s = `${n}" + BS + "0`;\nconsole.log(s.length);\n")).toBe("NT1705");
  });

  /*
   * The Unicode escapes. Reaching this rule required IMPLEMENTING them first: `\u` was
   * not an escape the lexer knew, so it fell through to "the escaped character itself"
   * and `"aAb"` compiled to the seven characters `au0041b` where node gives `aAb`.
   * A silent wrong answer of exactly this family, on the same door, so it is fixed
   * rather than worked around — see the differential block below.
   */
  test("the \\u escapes, in both spellings", () => {
    expect(codeOf('const s = "a' + BS + 'u0000b";\nconsole.log(s.length);\n')).toBe("NT1705");
    expect(codeOf('const s = "a' + BS + 'u{0}b";\nconsole.log(s.length);\n')).toBe("NT1705");
    // `\u{...}` is variable-width, so the zero has more than one spelling.
    expect(codeOf('const s = "' + BS + 'u{00000}";\nconsole.log(s.length);\n')).toBe("NT1705");
    // …and in a template, through the shared decoder.
    expect(codeOf("const s = `a" + BS + "u0000b`;\nconsole.log(s.length);\n")).toBe("NT1705");
  });
});

/*
 * `\u` had to WORK before `\\u0000` could be refused, so the working half is asserted
 * against node here — a refusal built on a decoder that guesses would be worth nothing.
 *
 * `.length` is only asserted for ASCII cases: `String#length` is UTF-8 BYTE-oriented in
 * nativets (docs/divergences.md §A.2), so an emoji is 4 here and 2 in node. The printed
 * BYTES are node's either way, which is what these compare.
 */
describe("\\u escapes decode like node (differential)", () => {
  const cases: string[] = [
    // test262 language/literals/string/S7.8.4_A7.1_T1.js — the four-hex-digit form.
    'console.log("a' + BS + 'u0041b"); console.log("a' + BS + 'u0041b".length);',
    // Non-ASCII, printed not measured.
    'console.log("' + BS + 'u00e9' + BS + 'u4e2d");',
    // An astral character, both spellings — a surrogate PAIR of \uHHHH escapes and the
    // `\u{…}` form must produce the same bytes, as they do in node.
    'console.log("a' + BS + 'ud83d' + BS + 'ude00b");',
    'console.log("a' + BS + 'u{1F600}b");',
    'console.log("' + BS + 'u{41}' + BS + 'u{041}' + BS + 'u{0041}");',
    // Mixed with the escapes that already worked, and inside a template.
    'console.log(`x' + BS + 'u0041' + BS + 'x42' + BS + 'tz`);',
  ];
  for (const src of cases) {
    test(src.slice(0, 46), async () => {
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});

/*
 * The escapes NEXT DOOR, which this lane had to pin down before it could say what a
 * backslash-zero even means.
 *
 * Backslash-zero is a NULEscapeSequence ONLY when no decimal digit follows it. With one,
 * it is ECMAScript Annex B.1.2's LegacyOctalEscapeSequence: backslash-zero-one is
 * U+0001, NOT a NUL followed by "1". Backslash-1 through backslash-7 are the same
 * production, and nativets decoded backslash-1 as the CHARACTER "1" — charCodeAt 49,
 * where node says 1. A silent wrong answer of the same family, found while establishing
 * what backslash-zero means.
 *
 * THIS IS A DIVERGENCE, and the claim that stood here was wrong. It read: every one of
 * them is a strict-mode SyntaxError, and a TypeScript module IS strict, so node refuses
 * them too. The premise is true; the conclusion does not follow, because whether node
 * treats a `.ts` file as strict depends on THE FILE'S SHAPE — and it was verified against
 * node run as ESM while every fixture below is script-shaped. Measured:
 *
 *     $ node oct.ts          # no import/export: CommonJS, i.e. SLOPPY
 *     aAb                    # exit 0 — node DECODES the octal escape
 *     $ node oct.ts          # with `export {}` or "use strict": a module, i.e. strict
 *     SyntaxError: Legacy octal escape is not permitted in strict mode
 *
 * `node <file>` is this project's oracle literally, and a single-file fixture is the
 * sloppy shape — so nativets refuses a program node runs. The refusal is KEPT (refusing a
 * deprecated Annex B form is the safe direction, and the value half of the original
 * finding stands: we used to decode backslash-1 as the character "1"), but it is recorded
 * as a refusal in docs/divergences.md rather than claimed as agreement.
 *
 * test262 language/literals/string/legacy-octal-escape-sequence-strict.js pins the STRICT
 * behaviour, which is the shape these fixtures are not.
 *
 * Backslash-8 and backslash-9 are NOT octal: they are NonOctalDecimalEscapeSequence, and
 * test262 legacy-non-octal-escape-sequence-8-non-strict.js pins backslash-8 as "8", which
 * is already what we decode. They stay accepted.
 */
describe("the octal escapes next door", () => {
  // THE DIVERGENCE, RUN rather than asserted. Everything else here checks only the NT code,
  // which is what let the wrong claim above survive: a code assertion cannot notice that
  // node disagrees. This one asks node.
  test("node ACCEPTS it in the script shape these fixtures use — the divergence, measured", () => {
    const oracle = runWithNode('console.log("a' + BS + '101b");' + String.fromCharCode(10));
    expect(oracle.exitCode).toBe(0);
    expect(oracle.stdout).toBe("aAb" + String.fromCharCode(10));
    expect(codeOf('console.log("a' + BS + '101b");' + String.fromCharCode(10))).toBe("NT0001");
  });

  test("node REFUSES it once the file is a module — the same source, one `export` added", () => {
    const oracle = runWithNode("export {};" + String.fromCharCode(10) + 'console.log("a' + BS + '101b");' + String.fromCharCode(10));
    expect(oracle.exitCode).not.toBe(0);
    expect(oracle.stderr).toContain("octal");
  });

  test("backslash-1 .. backslash-7 are refused, not decoded as the digit character", () => {
    expect(codeOf('const s = "a' + BS + '1b";\nconsole.log(s.charCodeAt(1));\n')).toBe("NT0001");
    expect(codeOf('const s = "' + BS + '7";\nconsole.log(s.length);\n')).toBe("NT0001");
    expect(codeOf("const s = `a" + BS + "1b`;\nconsole.log(s.length);\n")).toBe("NT0001");
  });

  test("a zero FOLLOWED by a digit is octal too — the NUL rule would misname it", () => {
    expect(codeOf('const s = "a' + BS + '01b";\nconsole.log(s.length);\n')).toBe("NT0001");
    expect(codeOf('const s = "a' + BS + '08b";\nconsole.log(s.length);\n')).toBe("NT0001");
  });

  test("a BARE zero escape is still NUL; an escaped backslash is not octal; 8 and 9 still work", () => {
    expect(codeOf('const s = "a' + BS + '0b";\nconsole.log(s.length);\n')).toBe("NT1705");
    // src/codegen.ts writes LLVM's own escape syntax as an ESCAPED BACKSLASH followed by
    // hex digits. That must not be mistaken for an octal escape — it would refuse the
    // compiler's own source.
    expect(codeOf('const s = "' + BS + BS + '5C" + "' + BS + BS + '22";\nconsole.log(s);\n')).toBe(null);
    expect(codeOf('const s = "a' + BS + '8b";\nconsole.log(s.length);\n')).toBe(null);
  });
});
