/*
 * `toUpperCase` / `toLowerCase` — the covered range, swept EXHAUSTIVELY against node.
 *
 * The defect this file closes: both methods were a byte-wise ASCII shift, so every
 * non-ASCII letter came back UNMAPPED (`"é".toUpperCase()` === `"é"`, node `"É"`). The
 * output is well-formed UTF-8 either way, so nothing signalled the miss — a silent wrong
 * answer, the worst outcome available.
 *
 * `docs/divergences.md` §A.2 does NOT cover this. §A.2 is about the UNIT strings are
 * MEASURED and SLICED in (UTF-8 bytes vs node's UTF-16 code units); case mapping is a
 * question of WHICH CHARACTER a character maps to, and `é` → `É` is two bytes to two bytes
 * in either encoding. So it was a defect, not a decision.
 *
 * WHAT IS COVERED, and why the boundary sits where it does: `runtime/` is libc-only so it
 * cross-links to macOS/Linux/iOS/Android/Windows/wasm, which rules out `towupper` (locale
 * dependent — the answer would vary by environment) and rules out shipping the full Unicode
 * case tables (2981 cased code points, plus the context-sensitive and locale-sensitive
 * rules). U+0000–U+017F — ASCII, Latin-1 Supplement, Latin Extended-A — is 360 of those
 * code points and reduces to six arithmetic rules per direction plus eight exceptions, so
 * it is exact at a trivial size. Everything from U+0180 up is left UNMAPPED and documented
 * (docs/divergences.md §A.4).
 *
 * The comparison is on RAW BYTES and the exit code, never on decoded text: a utf8-decoding
 * compare turns mangled bytes into U+FFFD on both sides and reports a match.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { ourRun, nodeRun, isRefusal, isUtf8 } from "./fzq-fuzz.ts";
import { emitIR } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run both sides and assert byte-for-byte stdout equality plus equal exit codes. */
async function expectSameBytes(source: string): Promise<void> {
  const oracle = nodeRun(source);
  const ours = await ourRun(source);
  if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
  expect({ utf8: isUtf8(ours.stdout) }).toEqual({ utf8: isUtf8(oracle.stdout) });
  // `latin1` is a byte-exact, lossless rendering of a Buffer — it is used ONLY so a
  // mismatch prints readably; it never merges two distinct byte strings the way utf8 does.
  expect(ours.stdout.toString("latin1")).toBe(oracle.stdout.toString("latin1"));
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** `"\uXXXX"` for a BMP code point — keeps the generated fixture pure ASCII. */
function esc(cp: number): string {
  return "\\u" + cp.toString(16).padStart(4, "0");
}

/**
 * One `console.log` per code point in `[from, to]`, for each of the named methods.
 * `U+0000` is skipped throughout: a NUL in a string literal is `NT1705` by design
 * (docs/divergences.md), so it is a refusal on our side and not a case-mapping case.
 */
function sweep(from: number, to: number, methods: readonly string[]): string {
  const lines: string[] = [];
  for (let cp = from; cp <= to; cp++) {
    if (cp === 0) continue;
    // `""` means the bare literal — the identity, with no method call in the way.
    for (const m of methods) lines.push(`console.log("${esc(cp)}"${m ? "." + m : ""});`);
  }
  return lines.join("\n") + "\n";
}

describe("case mapping — the escape path itself", () => {
  /*
   * RUNG 0. Before any case-mapping claim can be trusted, the LEXER has to agree with node
   * about what `"é"` even is. If the escape decoded to the wrong bytes, every case
   * assertion below would be blaming the runtime for a lexer defect. Nothing is called
   * here — the bare literal is printed, so this compares only the decoded literal.
   */
  it("decodes every \\uXXXX escape in U+0001-U+017F to node's bytes", async () => {
    await expectSameBytes(sweep(0x01, 0x17f, [""]));
  });
});

describe("case mapping — the covered range", () => {
  /*
   * RUNG 1. Latin-1 Supplement. Includes the two that escape the arithmetic:
   * `µ` U+00B5 uppercases to GREEK CAPITAL MU U+039C (out of the block entirely), and
   * `ÿ` U+00FF to `Ÿ` U+0178. Includes `ß` U+00DF → `"SS"`, which is the case that makes
   * the mapping LENGTH-CHANGING and so forbids any in-place implementation.
   */
  it("maps every code point in Latin-1 Supplement (U+0080-U+00FF) as node does", async () => {
    await expectSameBytes(sweep(0x80, 0xff, ["toUpperCase()", "toLowerCase()"]));
  });

  /*
   * RUNG 2. Latin Extended-A. Three more length-changing or block-escaping cases:
   * `ı` U+0131 → `I` (2 bytes to 1), `ſ` U+017F → `S` (2 to 1), `ŉ` U+0149 → `ʼN`
   * (U+02BC U+004E, 2 bytes to 3), and `İ` U+0130 → `i` + COMBINING DOT ABOVE U+0307
   * (2 bytes to 3). `ĸ` U+0138 and `ŀ`/`Ŀ` sit inside the block but outside the pair
   * arithmetic, which is exactly what an exhaustive sweep is for.
   */
  it("maps every code point in Latin Extended-A (U+0100-U+017F) as node does", async () => {
    await expectSameBytes(sweep(0x100, 0x17f, ["toUpperCase()", "toLowerCase()"]));
  });

  /*
   * RUNG 3. ASCII, re-asserted exhaustively. It was the ONLY correct range before this
   * change and it must stay correct: a decoder that mis-frames a lead byte would break
   * `[` `\` `]` `^` `_` and `` ` `` (0x5B-0x60), the six code points sitting between the
   * upper and lower runs that a careless range test folds into them.
   */
  it("maps every ASCII code point (U+0001-U+007F) as node does", async () => {
    await expectSameBytes(sweep(0x01, 0x7f, ["toUpperCase()", "toLowerCase()"]));
  });
});

describe("case mapping — the boundary at U+0180, and what is NOT mapped", () => {
  /*
   * The documented boundary (docs/divergences.md §A.4). These are all CASED in node and
   * deliberately NOT mapped here, so this test asserts our answer differs — it is the
   * divergence's own regression test, and it will fail the day someone widens the range
   * without widening the doc.
   */
  it("leaves Greek, Cyrillic and Latin Extended-B unmapped, and says so", async () => {
    const src = [
      'console.log("\\u03b1\\u03b2\\u03b3".toUpperCase());', // αβγ — node ΑΒΓ, ours unchanged
      'console.log("\\u0434\\u0430".toUpperCase());',        // да  — node ДА, ours unchanged
      'console.log("\\u0180".toUpperCase());',               // ƀ   — node Ƀ,  ours unchanged
      "",
    ].join("\n");
    const ours = await ourRun(src);
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    expect(ours.exitCode).toBe(0);
    // The input, byte-for-byte: unmapped, not mangled. Well-formed UTF-8 either way.
    expect(ours.stdout.toString("utf8")).toBe("αβγ\nда\nƀ\n");
    expect(isUtf8(ours.stdout)).toBe(true);
    // ...and node really does differ here, so the divergence is REAL and still needed.
    expect(nodeRun(src).stdout.toString("utf8")).toBe("ΑΒΓ\nДА\nɃ\n");
  });

  /*
   * An uncovered code point must survive INTACT even when it shares a string with covered
   * ones — the failure mode of a hand-rolled UTF-8 walker is dropping or duplicating a
   * continuation byte at the hand-off, which shows up only in a MIXED string.
   */
  it("passes uncovered code points through intact when mixed with covered ones", async () => {
    await expectSameBytes([
      // Latin-1 é, then a 3-byte CJK, then a 4-byte astral emoji, then Latin Extended-A.
      'console.log("a\\u00e9\\u4e2d\\ud83d\\ude00\\u0107z".toUpperCase());',
      'console.log("A\\u00c9\\u4e2d\\ud83d\\ude00\\u0106Z".toLowerCase());',
      // A 4-byte sequence whose bytes, read as Latin-1, look like cased letters.
      'console.log("\\ud83c\\udf10".toUpperCase());',
      'console.log("\\ud83c\\udf10".toLowerCase());',
      "",
    ].join("\n"));
  });
});

describe("case mapping — shapes that break a naive implementation", () => {
  /*
   * The empty string, and characters with NO case at all (digits, punctuation, symbols,
   * a combining mark, and the two Latin Extended-A code points that are genuinely caseless).
   */
  it("returns the empty string and caseless characters unchanged", async () => {
    await expectSameBytes([
      'console.log("".toUpperCase() + "|");',
      'console.log("".toLowerCase() + "|");',
      'console.log("0123456789 !@#$%^&*()".toUpperCase());',
      'console.log("\\u00a9\\u00ae\\u00b0\\u00d7\\u00f7".toUpperCase());', // © ® ° × ÷
      'console.log("\\u00a9\\u00ae\\u00b0\\u00d7\\u00f7".toLowerCase());',
      'console.log("\\u0138\\u0301".toUpperCase());',                     // ĸ + combining acute
      "",
    ].join("\n"));
  });

  /*
   * The LENGTH-CHANGING mappings, isolated and then repeated. `ß` → `SS` grows by a
   * character; run enough of them together that an implementation which sized its output
   * from the INPUT length would overrun rather than merely truncate.
   */
  it("handles the length-changing mappings, including many in one string", async () => {
    await expectSameBytes([
      'console.log("\\u00df".toUpperCase());',            // ß  -> SS
      'console.log("stra\\u00dfe".toUpperCase());',       // straße -> STRASSE
      'console.log("\\u0131".toUpperCase());',            // ı  -> I   (2 bytes -> 1)
      'console.log("\\u017f".toUpperCase());',            // ſ  -> S   (2 bytes -> 1)
      'console.log("\\u0149".toUpperCase());',            // ŉ  -> ʼN  (2 bytes -> 3)
      'console.log("\\u0130".toLowerCase());',            // İ  -> i̇   (2 bytes -> 3)
      'console.log("\\u00df".repeat(64).toUpperCase());', // 64 growths in one result
      'console.log("\\u0130".repeat(64).toLowerCase());', // the worst growth ratio, 1.5x
      "",
    ].join("\n"));
  });

  /*
   * `.length` on the RESULT. §A.2 makes our length UTF-8 bytes and node's UTF-16 units, so
   * these two disagree by design — but the mapping must still produce a string whose length
   * is CONSISTENT with its own bytes, which is what a stale memoized length would break
   * (the rc side table caches byte length per pointer and resets it on registration).
   */
  it("gives the mapped result a length consistent with its own bytes", async () => {
    const src = [
      'const u = "\\u00e9\\u00df\\u0130".toUpperCase();',
      "console.log(u);",
      "console.log(u.length);",
      "console.log(u.slice(0, 2) + \"|\" + u.slice(2));",
      "",
    ].join("\n");
    const ours = await ourRun(src);
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    // É S S İ -> 2 + 1 + 1 + 2 = 6 UTF-8 bytes. node would say 5 (UTF-16 units), §A.2.
    expect(ours.stdout.toString("utf8")).toBe("ÉSSİ\n6\nÉ|SSİ\n");
    expect(ours.exitCode).toBe(0);
  });

  /*
   * Past the runtime's internal size thresholds: one-byte strings are INTERNED and the rc
   * table memoizes byte length per POINTER, so a 20 KB result exercises a different
   * allocation path from every case above.
   *
   * The whole mapped string is compared, never its `.length` or a `.slice` of it — those
   * two ARE §A.2 divergences (we count and cut UTF-8 bytes, node counts UTF-16 units), so
   * putting either on the wire here would fail for a reason that has nothing to do with
   * case mapping.
   */
  it("maps a string far past any internal size threshold", async () => {
    await expectSameBytes([
      'const big = "\\u00e9a\\u00df\\u0107".repeat(4000);',
      "console.log(big.toUpperCase());",
      "console.log(big.toLowerCase());",
      "",
    ].join("\n"));
  });
});

/*
 * THE TWO TESTS BELOW EXIST BECAUSE THE ONES ABOVE DID NOT CATCH THESE MUTANTS.
 *
 * Seven deliberate defects were spliced into `nt_case_impl` / `nt_case_map` to check the
 * suite bites. Five died on the sweeps above. Two SURVIVED, and both are worse than the
 * defect this file was opened for:
 *
 *  - sizing the output buffer from the INPUT length (`out_n += len` instead of the mapped
 *    width). Every length-growing mapping then writes past the allocation — `"İ".repeat(64)
 *    .toLowerCase()` overruns by 64 bytes. The bytes WRITTEN are still the right answer, so
 *    stdout matches node exactly and every assertion above passes over a heap overflow.
 *
 *  - widening the covered-lead test from `0xC2..0xC5` to `>= 0xC2`, so the first two bytes
 *    of a 3- or 4-byte sequence get recombined into a bogus code point. Most of the time
 *    that lands outside the mapped range and the bytes are copied through unchanged, which
 *    is why `中` and `😀` in the mixed-string test did not notice. `U+4000` does: its lead
 *    pair recombines to U+0100 `Ā`, which IS mapped, so `"䀀".toLowerCase()` returns
 *    three bytes that decode to something else entirely.
 *
 * A stdout compare can see neither. They need a memory check and a systematic pass-through
 * sweep respectively.
 */
describe("case mapping — the mutants a stdout compare cannot see", () => {
  /** Build a nativets program under ASan+UBSan and run it (cf. test/asan-instrumentation.test.ts). */
  function runSanitized(source: string): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "nativets-case-asan-"));
    try {
      const llPath = join(dir, "module.ll");
      writeFileSync(llPath, emitIR(source));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        llPath, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.stderr.includes("error:")).toBe(false);
      expect(built.status).toBe(0);
      const run = spawnSync(bin, [], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /*
   * `runtime/*.c` is compiled FROM SOURCE here, so clang stamps `sanitize_address` on it
   * and the store inside `nt_case_impl` is instrumented — no `NATIVETS_ASAN` needed, since
   * the write under test is the runtime's own and not the generated code's.
   *
   * Every length-CHANGING mapping is exercised, in bulk, because a one-byte overrun of a
   * malloc'd block is invisible without a redzone: the answer printed is correct.
   */
  it("writes the mapped result INSIDE its allocation (ASan, the growth cases)", () => {
    const r = runSanitized([
      'console.log("\\u0130".repeat(64).toLowerCase());', // İ -> i+U+0307, 2 bytes -> 3, the worst ratio
      'console.log("\\u0149".repeat(64).toUpperCase());', // ŉ -> ʼN,       2 bytes -> 3
      'console.log("\\u00df".repeat(64).toUpperCase());', // ß -> SS
      'console.log("\\u0131".repeat(64).toUpperCase());', // ı -> I,        2 bytes -> 1 (shrinks)
      'console.log("\\u017f".repeat(64).toUpperCase());', // ſ -> S,        2 bytes -> 1
      'console.log("a\\u0130b\\u00dfc\\u0149".repeat(300).toLowerCase().length);',
      'console.log("a\\u0130b\\u00dfc\\u0149".repeat(300).toUpperCase().length);',
      "",
    ].join("\n"));
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.stderr).not.toContain("runtime error");
    expect(r.status).toBe(0);
  });

  /*
   * Every code point from U+0180 to U+FFFF is UNCOVERED (docs/divergences.md §A.4) and must
   * therefore come back BYTE-IDENTICAL from both methods. Comparing against ourselves
   * rather than node is the point: node maps ~2600 of these, so this is the divergence's
   * own regression test, and it is also the only shape that catches a walker which
   * mis-frames a lead byte — which needs a code point whose bytes RECOMBINE into the
   * covered range, not merely a multi-byte one.
   *
   * Surrogates are skipped: they are not scalar values and cannot appear in a literal.
   */
  it("returns every uncovered code point U+0180-U+FFFF byte-identical", async () => {
    const lines: string[] = [];
    let chunk: string[] = [];
    let n = 0;
    const flush = (): void => {
      if (chunk.length === 0) return;
      const id = `c${n++}`;
      lines.push(`const ${id} = "${chunk.join("")}";`);
      lines.push(`console.log(${id}.toUpperCase() === ${id});`);
      lines.push(`console.log(${id}.toLowerCase() === ${id});`);
      chunk = [];
    };
    for (let cp = 0x180; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      chunk.push(esc(cp));
      if (chunk.length === 256) flush();
    }
    flush();
    const ours = await ourRun(lines.join("\n") + "\n");
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    expect(ours.exitCode).toBe(0);
    // Assert the COUNT as well as the content — a program that printed nothing at all
    // would otherwise satisfy a "no false" check vacuously.
    const out = ours.stdout.toString("utf8").split("\n").filter((l) => l !== "");
    // Assert the COUNTS, not just the absence of a `false`: a program that printed nothing
    // would satisfy an all-true check vacuously.
    expect({ chunks: n, lines: out.length }).toEqual({ chunks: chunkCount(), lines: 2 * chunkCount() });
    // Report WHICH chunk broke, not merely that one did — 256 code points is a small
    // enough window to read off the range by hand.
    const bad = out.indexOf("false");
    // Chunk k holds the 256 code points at ordinal k*256 of the surrogate-SKIPPING
    // enumeration, so the start below is exact up to U+D800 and shifts by 2048 after it.
    const where = bad < 0 ? "none" :
      `chunk ${bad >> 1} of ${chunkCount()} (${bad % 2 === 0 ? "toUpperCase" : "toLowerCase"}), ` +
      `starting near U+${(0x180 + (bad >> 1) * 256).toString(16)}`;
    expect({ firstMismatch: where }).toEqual({ firstMismatch: "none" });
  });

  /** U+0180..U+FFFF minus the 2048 surrogates, in chunks of 256 — 247 chunks, 63104 code points. */
  function chunkCount(): number {
    return Math.ceil((0xffff - 0x180 + 1 - 2048) / 256);
  }

  /*
   * ILL-FORMED UTF-8, and it is REACHABLE — this is §A.2 handing a problem to this file.
   * Because `.slice` cuts BYTES, `"é".slice(0, 1)` is an ordinary expression that yields
   * the LEAD BYTE of a two-byte character on its own. Concatenate an `A` after it and the
   * string is `C3 41`: a covered lead followed by a byte that is not a continuation.
   *
   * A walker that trusts the lead byte alone decodes that pair as U+00C1 `Á`, lowercases it
   * to U+00E1, and writes `C3 A1` — the `A` is EATEN and replaced. Same byte count, still
   * exit 0. So the check that the second byte really is a continuation is load-bearing on
   * input a program can actually produce, and the only defensible answer is to touch
   * neither byte's identity: copy the stray lead through, lower the `A` as the ASCII it is.
   *
   * node is not the oracle here — its `String` cannot hold a lone surrogate-free ill-formed
   * byte at all, so there is no comparison to make; the assertion is on our own bytes.
   */
  it("never re-frames a stray lead byte, and still maps the ASCII after it", async () => {
    const ours = await ourRun([
      'const half = "\\u00e9".slice(0, 1);', // the lead byte of é, alone — ill-formed
      'const s = half + "A";',
      "console.log(s.toLowerCase());",
      'const t = half + "a";',
      "console.log(t.toUpperCase());",
      "",
    ].join("\n"));
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    expect(ours.exitCode).toBe(0);
    // C3 61 0A  C3 41 0A — the stray lead survives untouched, the ASCII beside it maps.
    expect([...ours.stdout]).toEqual([0xc3, 0x61, 0x0a, 0xc3, 0x41, 0x0a]);
    // ...and it is deliberately NOT valid UTF-8: we do not invent a replacement character.
    expect(isUtf8(ours.stdout)).toBe(false);
  });
});
