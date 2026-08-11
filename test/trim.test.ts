/*
 * String.prototype.trimEnd / trimStart — and the WHITESPACE SET all three trims share.
 *
 * `trim` has been supported since the string batch; `trimEnd`/`trimStart` were
 * `NT1002`, and that was `src/ast.ts`'s last self-hosting blocker.
 *
 * The cases are borrowed from test262 rather than invented:
 *
 *   test/built-ins/String/prototype/trim/15.5.4.20-3-*.js
 *       one file per WhiteSpace / LineTerminator code point — \u0009 \u000b \u000c
 *       \u0020 \u00a0 \ufeff \u1680 \u2000..\u200a \u2028 \u2029 \u202f \u205f
 *       \u3000 \u000a \u000d. This is the set the ECMAScript grammar calls
 *       WhiteSpace + LineTerminator, and it is exactly `TrimString`'s.
 *   test/built-ins/String/prototype/trim{,End,Start}/u180e.js
 *       U+180E (MONGOLIAN VOWEL SEPARATOR) is NOT whitespace — it was Zs until
 *       Unicode 6.3 and is the one code point everybody's hand-written table gets
 *       wrong. It must survive a trim.
 *   test/built-ins/String/prototype/trimEnd/trimEnd.js, .../trimStart/trimStart.js
 *       only the named end is trimmed; the other end's whitespace is preserved.
 *
 * node is the oracle for every case: stdout byte-for-byte, plus exit code.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectMatchesNode } from "./harness.ts";
import { ourRun, nodeRun, isRefusal, isUtf8 } from "./fzq-fuzz.ts";

/**
 * ECMAScript WhiteSpace + LineTerminator, as `\uXXXX` escapes so this file stays
 * ASCII (a raw NBSP in a source file is invisible and gets normalized by tooling).
 * Kept in the same order as `isSpace` in `src/lexer.ts`, which is the OTHER copy of
 * this set — see the `agrees with the lexer's isSpace` test at the bottom, which is
 * what keeps the two from drifting.
 */
const WS: string[] = [
  "\\u0009", "\\u000a", "\\u000b", "\\u000c", "\\u000d", "\\u0020",
  "\\u00a0", "\\u1680",
  "\\u2000", "\\u2001", "\\u2002", "\\u2003", "\\u2004", "\\u2005",
  "\\u2006", "\\u2007", "\\u2008", "\\u2009", "\\u200a",
  "\\u2028", "\\u2029", "\\u202f", "\\u205f", "\\u3000", "\\ufeff",
];

/** Compile + run `code`, assert stdout AND exit code equal node's. */
async function matchesNode(code: string): Promise<void> {
  const { ours, oracle } = await expectMatchesNode(code);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("trimEnd", () => {
  test("removes trailing spaces", async () => {
    await matchesNode(`console.log(JSON.stringify("abc  ".trimEnd()));`);
  });

  test("leaves the LEADING whitespace alone (test262 trimEnd/trimEnd.js)", async () => {
    await matchesNode(`console.log(JSON.stringify("  abc  ".trimEnd()));`);
  });

  test("all-whitespace string trims to empty", async () => {
    await matchesNode(`console.log(JSON.stringify(" \\t\\n ".trimEnd()), " \\t\\n ".trimEnd().length);`);
  });

  test("no trailing whitespace is a no-op", async () => {
    await matchesNode(`console.log(JSON.stringify("abc".trimEnd()), JSON.stringify("".trimEnd()));`);
  });

  test("interior whitespace is never touched", async () => {
    await matchesNode(`console.log(JSON.stringify("a b\\tc  ".trimEnd()));`);
  });
});

describe("trimStart", () => {
  test("removes leading spaces", async () => {
    await matchesNode(`console.log(JSON.stringify("  abc".trimStart()));`);
  });

  test("leaves the TRAILING whitespace alone (test262 trimStart/trimStart.js)", async () => {
    await matchesNode(`console.log(JSON.stringify("  abc  ".trimStart()));`);
  });

  test("all-whitespace string trims to empty", async () => {
    await matchesNode(`console.log(JSON.stringify(" \\t\\n ".trimStart()), " \\t\\n ".trimStart().length);`);
  });
});

/*
 * The whitespace SET, one case per code point, for each of the three methods.
 *
 * This is the part that a hand-written trim gets wrong, and it did: before this
 * lane `js_str_trim` matched only ` \t\n\r`, so 21 of the 25 code points below were
 * silently left in place — `"\u00a0x\u00a0".trim()` returned the input, at exit 0,
 * with no diagnostic. A wrong answer, which is the worst outcome available.
 */
/*
 * ASSERT EQUALITY, NOT `.length` — test262 asserts the trimmed VALUE, and so must
 * this. An earlier draft printed `s.length`, which made every non-ASCII row red for
 * a reason that has nothing to do with trimming: nativets strings are UTF-8 BYTES,
 * so `"\u00a0x".length` is 3 here and 2 in node. That is the pre-existing, deliberate
 * §A.2 divergence (docs/divergences.md), and a trim test that trips over it is
 * measuring the wrong thing. The trimmed bytes themselves match node exactly, which
 * is what `===` and `JSON.stringify` below check.
 */
for (const m of ["trim", "trimEnd", "trimStart"] as const) {
  const want = m === "trim" ? `"x"` : m === "trimEnd" ? `W + "x"` : `"x" + W`;
  describe(`${m} — the WhiteSpace + LineTerminator set (test262 trim/15.5.4.20-3-*)`, () => {
    for (const ws of WS) {
      test(`U+${ws.slice(2).toUpperCase()}`, async () => {
        await matchesNode(
          `const W = "${ws}";\n` +
            `const s = (W + "x" + W).${m}();\n` +
            `console.log(s === ${want}, JSON.stringify(s));`,
        );
      });
    }
  });
}

describe("U+180E is NOT whitespace (test262 trim{,End,Start}/u180e.js)", () => {
  test("survives all three trims", async () => {
    await matchesNode(
      `const s = "\\u180e";\n` +
        `console.log(s.trim() === s, s.trimEnd() === s, s.trimStart() === s);`,
    );
  });
});

describe("the trims compose and chain", () => {
  test("trimStart().trimEnd() === trim()", async () => {
    await matchesNode(
      `const s = " \\t\\u00a0 hi \\u2003\\n";\n` +
        `console.log(s.trimStart().trimEnd() === s.trim(), JSON.stringify(s.trim()));`,
    );
  });
});

/*
 * ILL-FORMED UTF-8, AND THE ONE DECODER EVERY SCANNER SHARES.
 * ==========================================================
 *
 * §A.2 makes `.length` and `.slice` BYTE-oriented, which means ill-formed UTF-8 is
 * REACHABLE FROM ORDINARY SOURCE: `"\u2001".slice(0, 2)` is the first two bytes of a
 * three-byte character, `E2 80`, with no third byte. Concatenate `"Axx"` and the string
 * is `E2 80 41 78 78` — a 3-byte lead followed by a byte that is NOT a continuation.
 *
 * A decoder that sizes a sequence from its LEAD BYTE ALONE reads that as `E2 80 41` and
 * recombines it to U+2001 EM QUAD, which is in the trim whitespace set. `trim()` then
 * consumed all THREE bytes and the `A` was GONE — `"xx"` where node prints `"Axx"`, at
 * exit 0, with well-formed output either side. A silent wrong answer.
 *
 * THE POLICY, and it is the same in every consumer: an ill-formed sequence decodes as the
 * SINGLE RAW BYTE and advances ONE byte. Not U+FFFD. Two reasons —
 *   - it is LOSSLESS. `Array.from(s).join("") === s` and `s.split("").join("") === s` hold
 *     for every byte string; U+FFFD would rewrite the program's bytes to "correct" them,
 *     which is the failure mode of a decoder that guesses.
 *   - it AGREES WITH THE NEIGHBOURS. `.charCodeAt(i)` and `.at(i)` are defined as the raw
 *     byte by §A.2, so `codePointAt` returning U+FFFD where `charCodeAt` returns 226 would
 *     make two accessors disagree about the same position.
 * It is also already the answer `toUpperCase`/`toLowerCase` give (§A.4) — one policy, so the
 * consumers cannot drift apart.
 *
 * THE CENSUS behind that word "every", because fixing one of these silently is the failure
 * mode. The string ops split three ways:
 *   RE-FRAMING, i.e. decoders that group bytes — all were wrong, all are fixed and covered
 *     below: `trim`/`trimStart`/`trimEnd`, `codePointAt`, `Array.from(str)`.
 *   ALREADY SAFE by the same self-identifying argument, fixed earlier under §A.4:
 *     `toUpperCase`/`toLowerCase`.
 *   BYTE-ORIENTED, so they cannot re-frame anything by construction: `charCodeAt`, `.at`,
 *     `s[i]`, `slice`/`substring`, `split`, `indexOf`/`includes`, and `for…of` over a
 *     string. These are §A.2 proper and are unchanged here.
 * Refused, so they cannot miscompile anything: `normalize` and `localeCompare` (both
 * NYI.WEBAPI — they need ICU) and `[...str]` (NT2001). Ordering (`<`, `>`) is `js_str_cmp`,
 * a plain `strcmp` over the bytes, which has no decode step to get wrong.
 *
 * The one deliberate NON-member of the ill-formed set is a SURROGATE — see the WTF-8 test.
 *
 * NODE IS NOT THE ORACLE for the ill-formed cases: a JS `String` is UTF-16 and cannot hold
 * these bytes at all, so there is no comparison to make and the assertion is on OUR bytes.
 * node IS the oracle for the well-formed twin of each case, which is what pins the fix to
 * "reject the ill-formed framing" rather than "stop decoding".
 *
 * The comparison is RAW BYTES throughout. A `.toString()` compare decodes both sides to
 * U+FFFD and reports a match on exactly the inputs this block exists to catch.
 */
describe("ill-formed UTF-8 is never re-framed (the shared UTF-8 decoder)", () => {
  /** `E2 80 41 78 78` — a truncated U+2001 lead pair, then ASCII. */
  const ILL = `const s = "\\u2001".slice(0, 2) + "Axx";\n`;
  /** `E2 80 81 41 78 78` — the same text with the character intact. */
  const WELL = `const s = "\\u2001" + "Axx";\n`;

  /** Compile + run, refusing to let a compile refusal read as a pass. */
  async function bytesOf(source: string): Promise<{ stdout: Buffer; exitCode: number }> {
    const r = await ourRun(source);
    if (isRefusal(r)) throw new Error(`nativets refused:\n${r.refused}`);
    return { stdout: r.stdout, exitCode: r.exitCode };
  }

  /** Assert our raw stdout and exit code equal node's. */
  async function sameBytesAsNode(source: string): Promise<void> {
    const oracle = nodeRun(source);
    const ours = await bytesOf(source);
    // `latin1` is lossless byte-for-byte; it is used ONLY so a mismatch prints readably.
    expect(ours.stdout.toString("latin1")).toBe(oracle.stdout.toString("latin1"));
    expect(ours.exitCode).toBe(oracle.exitCode);
  }

  // ---- trim: the reported defect. -------------------------------------------------
  test("trim stops at a stray lead byte instead of eating the character after it", async () => {
    const ours = await bytesOf(ILL + `console.log(s.trim());\nconsole.log(s.trimStart());\n`);
    expect(ours.exitCode).toBe(0);
    // E2 80 41 78 78 \n twice: NOTHING is stripped — 0xE2 is not whitespace, and the
    // scan must not look past it. Before the fix this was `78 78 0a` twice.
    expect([...ours.stdout]).toEqual([
      0xe2, 0x80, 0x41, 0x78, 0x78, 0x0a,
      0xe2, 0x80, 0x41, 0x78, 0x78, 0x0a,
    ]);
    // Deliberately NOT valid UTF-8: we hand back the bytes we were given.
    expect(isUtf8(ours.stdout)).toBe(false);
  });

  test("trimEnd stops at a stray lead byte at the END of the string", async () => {
    // `78 78 41 E2 80` — scanning BACKWARD, the 0x80 is a continuation byte whose lead
    // 0xE2 wants three bytes and only has two. It is not whitespace and must not be eaten.
    const ours = await bytesOf(`const s = "xxA" + "\\u2001".slice(0, 2);\nconsole.log(s.trimEnd() === s);\n`);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout.toString("latin1")).toBe("true\n");
  });

  /*
   * The OVERLONG case needs a byte source that no encoder sits in front of. Neither a
   * string literal, nor `.slice`, nor `String.fromCharCode`, nor `atob` can produce a raw
   * `0xC0`: each of those goes through a UTF-8 ENCODER, which never emits `C0`/`C1`. A
   * `fromCharCode(0xc0)` test would therefore assert on the bytes `C3 80` and pass no
   * matter what the decoder did — green and VACUOUS.
   *
   * `readFileSync(p, "utf8")` is the one path that hands the runtime bytes verbatim, so
   * the file below is written as raw bytes and the reachability is real.
   */
  test("an OVERLONG encoding of U+0020 is not whitespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-overlong-"));
    try {
      const f = join(dir, "bytes.bin");
      writeFileSync(f, Buffer.from([0xc0, 0xa0, 0x41])); // overlong U+0020, then `A`
      const src =
        `import { readFileSync } from "node:fs";\n` +
        `const s = readFileSync(${JSON.stringify(f)}, "utf8");\n` +
        `console.log(s.trim() === s);\n`;
      // node reads the two bad bytes as two U+FFFD, which are not whitespace, so node
      // prints `true`. We read them as two raw bytes, which are not whitespace either,
      // so the raw-byte policy REACHES NODE'S ANSWER HERE — this one is a real oracle
      // comparison. Before the fix `C0 A0` decoded to U+0020 and trim stripped it: `false`.
      await sameBytesAsNode(src);

      // And ours-only, the byte underneath: 192, never 32.
      const ours = await bytesOf(
        `import { readFileSync } from "node:fs";\n` +
          `const s = readFileSync(${JSON.stringify(f)}, "utf8");\n` +
          `console.log(s.codePointAt(0), s.length);\n`,
      );
      expect(ours.stdout.toString("latin1")).toBe("192 3\n");

      // 0xF8 is a lead byte ONLY in the obsolete 5-byte UTF-8 that Unicode withdrew; it
      // is not a lead at all today. Sizing the sequence with `c >= 0xF0` instead of the
      // exact `(c & 0xF8) == 0xF0` reads `F8 90 80 80` as a FOUR-byte sequence and lands
      // on U+10000 — in range, so the overlong guard does not catch it. Each byte must
      // stand alone: five elements, and the first code point is 248.
      const g = join(dir, "f8.bin");
      writeFileSync(g, Buffer.from([0xf8, 0x90, 0x80, 0x80, 0x41]));
      const five = await bytesOf(
        `import { readFileSync } from "node:fs";\n` +
          `const s = readFileSync(${JSON.stringify(g)}, "utf8");\n` +
          `console.log(s.codePointAt(0), Array.from(s).length);\n`,
      );
      expect(five.stdout.toString("latin1")).toBe("248 5\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the well-formed twin still trims, byte-for-byte with node", async () => {
    await sameBytesAsNode(WELL + `console.log(s.trim());\nconsole.log(s.trimStart());\n`);
  });

  /*
   * A RAW BYTE IS NOT A CODE POINT — the trap the first fix walked into.
   *
   * Having the decoder hand back the raw byte of an ill-formed sequence is right for
   * `codePointAt` and `Array.from`, and WRONG the moment that byte is handed to
   * `nt_ws_cp`, which is a table of CODE POINTS and contains U+00A0 NBSP. NBSP encodes as
   * `C2 A0`, so the byte 0xA0 tested true as whitespace — and `" ".slice(1, 2)` is
   * ordinary source for exactly that byte, because §A.2 cuts bytes.
   *
   * The give-away was that the two ends disagreed: `trimStart` ATE the stray byte while
   * `trimEnd` kept it (the backward scan happens to reject it via its span check). One
   * `trim`, two answers for one byte, so one of them had to be wrong. An ill-formed byte
   * is never whitespace — the whitespace test now runs only on a decoded code point.
   */
  test("a lone 0xA0 is not NBSP — both ends of the trim agree", async () => {
    const ours = await bytesOf(
      // `A0` alone: the CONTINUATION byte of U+00A0, with its `C2` lead cut away.
      `const tail = "\\u00a0".slice(1, 2);\n` +
        `console.log((tail + "x").trimStart().length, ("x" + tail).trimEnd().length);\n` +
        `console.log((tail + "x" + tail).trim().length);\n`,
    );
    expect(ours.exitCode).toBe(0);
    // Nothing is stripped at either end, so every length is the input's own.
    // Before the fix: `1 2` and `2` — trimStart and trim ate the leading byte.
    expect(ours.stdout.toString("latin1")).toBe("2 2\n3\n");
  });

  test("a real NBSP still trims, byte-for-byte with node", async () => {
    // The twin that keeps the fix honest: rejecting the stray 0xA0 must not cost us
    // U+00A0 itself, which node does strip. Asserted on the trimmed CONTENT, not on
    // `.length` — a length here would be comparing UTF-8 bytes to UTF-16 units and would
    // be testing §A.2 rather than the trim.
    await sameBytesAsNode(
      `const s = "\\u00a0x\\u00a0";\n` +
        `console.log(s.trim() === "x", s.trimStart() === "x\\u00a0", s.trimEnd() === "\\u00a0x");\n`,
    );
  });

  // ---- codePointAt: the SIBLING copy of the same decoder. --------------------------
  test("codePointAt reports the raw byte of an ill-formed sequence, agreeing with charCodeAt", async () => {
    const ours = await bytesOf(
      ILL + `console.log(s.codePointAt(0), s.charCodeAt(0), s.codePointAt(1), s.codePointAt(2));\n`,
    );
    expect(ours.exitCode).toBe(0);
    // 226 128 65 — each byte for itself. Before the fix codePointAt(0) was 8193 (U+2001),
    // a code point the string does not contain, while charCodeAt(0) said 226.
    expect(ours.stdout.toString("latin1")).toBe("226 226 128 65\n");
  });

  test("codePointAt on the well-formed twin matches node", async () => {
    // Only index 0 is compared across the two: `codePointAt` takes a POSITION, and
    // positions are UTF-8 bytes here against node's UTF-16 units (§A.2), so index 3 means
    // a different character on each side and would be testing §A.2, not this decoder.
    await sameBytesAsNode(WELL + `console.log(s.codePointAt(0));\n`);
  });

  test("a lone surrogate still decodes as ITSELF — WTF-8 tolerance is load-bearing", async () => {
    // `String.fromCharCode(0xd800)` emits the WTF-8 bytes `ED A0 80`, and node's
    // `codePointAt` says 55296. A decoder that rejected surrogates as "not strict UTF-8"
    // would fall back to the raw byte and answer 237, breaking agreement with node. So
    // "ill-formed" here means truncated / non-continuation / overlong / out-of-range —
    // deliberately NOT "encodes a surrogate".
    await sameBytesAsNode(
      `const g = String.fromCharCode(0xd800);\n` +
        `console.log(g.codePointAt(0), Array.from(g).length);\n`,
    );
  });

  // ---- Array.from: the third copy — it FRAMES from the lead byte. ------------------
  test("Array.from frames an ill-formed sequence one byte at a time, losslessly", async () => {
    const ours = await bytesOf(
      ILL + `const a = Array.from(s);\n` +
        `console.log(a.length, a.join("") === s, a.indexOf("A"));\n`,
    );
    expect(ours.exitCode).toBe(0);
    // 5 elements — E2, 80, A, x, x. Before the fix it was 3: `E2 80 41` was glued into one
    // bogus "character", so `a.indexOf("A")` was -1 even though the byte was still there.
    expect(ours.stdout.toString("latin1")).toBe("5 true 2\n");
  });

  test("Array.from on the well-formed twin matches node, code point by code point", async () => {
    await sameBytesAsNode(
      WELL + `const a = Array.from(s);\n` + `console.log(a.length, a.join("") === s, a.indexOf("A"));\n`,
    );
  });

  /*
   * THE THREE SPELLINGS OF "ITERATE A STRING", AND WHICH UNIT EACH ONE USES.
   * =======================================================================
   *
   * `Array.from(s)`, `for (const c of s)` and `s.split("")` used to give TWO answers for
   * one ordinary string. On `"\u2001Axx"` — well formed, nothing exotic — node says 4, 4, 4
   * and we said 4, **6**, **6**: `Array.from` had been given code-point framing (above),
   * while the other two still walked bytes. Not a divergence anybody chose; §A.2 applied to
   * two of three doors.
   *
   * node's own three do NOT all agree, and that is what decides the fix. Measured:
   *
   *     "\u{1f600}".length            2      (UTF-16 code units)
   *     Array.from("\u{1f600}")       1      code POINT
   *     for…of "\u{1f600}"            1      code POINT — the same String iterator
   *     "\u{1f600}".split("")         2      code UNITS: two lone surrogates
   *
   * So there are two families, not one. `Array.from` and `for…of` are the SAME iterator
   * (`%Symbol.iterator%`, which is defined over code points) and must agree. `split("")` is
   * the LENGTH-INDEXED decomposition: node guarantees `s.split("").length === s.length` and
   * `s.split("").join("") === s` for every string, and it keeps that guarantee above the BMP
   * by handing back pieces that are not characters at all.
   *
   * §A.2 replaces node's code unit with the UTF-8 BYTE. Carrying both families over:
   *   - `for…of` joins `Array.from` at CODE POINTS — node-exact for every well-formed string,
   *     including astral ones, which is agreement we did not have before.
   *   - `split("")` stays at BYTES, because a byte is our code unit. That keeps
   *     `split("").length === length` and `split("").join("") === s`, the two identities node
   *     states for it; code-point framing would break BOTH while only matching node on the BMP.
   * The counts still differ from node above U+007F for `split`, exactly as `.length` does,
   * and for the same one reason — which is what §A.2 is.
   */
  describe("iteration is by CODE POINT; `split(\"\")` is by code unit, i.e. byte", () => {
    /** `E2 80 81 41 78 78` — U+2001 EM QUAD then ASCII. 4 code points, 6 bytes. */
    const S3 = `const s = "\\u2001Axx";\n`;

    test("`for…of` over a multi-byte string counts CODE POINTS, matching node", async () => {
      await sameBytesAsNode(
        S3 + `let n = 0;\nfor (const c of s) { n = n + 1; }\nconsole.log(n);\n`,
      );
    });
  });
});
