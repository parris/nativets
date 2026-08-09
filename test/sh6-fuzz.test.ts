/*
 * THE RUNG-3 DIFFERENTIAL, RATCHETED.
 *
 * `test/sh6.test.ts` records three modules at rung 3 and backs two of them with a single
 * driver over a handful of inputs. This file is the other half of that evidence: the same
 * modules, compiled the same way, run against an ADVERSARIAL input set and compared to the
 * bun-run module byte for byte. See `test/sh6-fuzz.ts` for the method and for the full
 * ~550-input sweep, which is a script rather than a test because it links three binaries
 * and spawns two thousand processes.
 *
 * WHAT THIS FILE ASSERTS is not "they agree" — they do not — but the RECORDED SET of ways
 * they disagree. A new divergence reds it; a fixed one reds it too, and the fix updates
 * the table deliberately. That is the same ratchet discipline as the SH6 baseline, and it
 * is the only honest shape for a test whose subject currently fails.
 *
 * Every recorded row is the SAME DEFECT CLASS, and it is one the SH6 baseline has already
 * hit twice in other modules (`lexer.ts`'s `source[st.i + 1]`, `ast.ts`'s
 * `list[list.length - 1]`): an out-of-range STRING or ARRAY index that TypeScript types
 * `T | undefined` under `noUncheckedIndexedAccess` and nativets PANICS on by design
 * (the Stage 41 bounds rule). The `?? ""` written next to several of them is a DEAD GUARD
 * — the panic happens before it can run. `.at(i)` is the spelling that means the same
 * thing in both toolchains.
 *
 * These are SOURCE defects in the compiler's own modules, not compiler bugs, and they are
 * left unfixed on purpose: this lane measures, and the fixes belong with the modules.
 */

import { test, expect, describe } from "bun:test";
import { basename } from "node:path";

import { fuzz, minimize, normalize, isAscii } from "./sh6-fuzz.ts";

/**
 * The recorded frontier: `module | input | cause`, sorted. Rows are the adversarial set
 * only — the file corpus is in the script, and every divergence it finds reduces to one of
 * the causes below (the bare `//` alone accounts for 71 of the 501 files).
 */
const RECORDED: string[] = [
  /* ---- A. OUT-OF-RANGE INDEX: the compiled module ABORTS where bun does not ----
   *
   * Eleven of the twenty-five rows, four distinct sites, one defect. Every one is a
   * SOURCE defect in the compiler's own module, and the fix is `.at(i)` — not a compiler
   * change. They are left unfixed here on purpose: this lane measures. */

  // `//`, or `// ` — a line comment with an EMPTY body. `pragmaName` reads `body[a]` with
  // a === body.length. The compiled lexer ABORTS (SIGABRT); bun lexes the file fine.
  // THIS IS THE HEADLINE ROW. It is not exotic: 71 of the repo's 501 `.ts` files contain a
  // bare `//`, and 8 of the compiler's own 12 modules do — INCLUDING src/lexer.ts, so the
  // compiled lexer cannot lex its own source. Same function, duplicated into
  // coverage-preprocess.ts, so the same defect is there twice.
  "lexer.ts | comment-empty.ts | panic @ src/lexer.ts:95:11",
  "lexer.ts | comment-ws.ts | panic @ src/lexer.ts:95:11",
  "coverage-preprocess.ts | comment-empty.ts | panic @ src/coverage-preprocess.ts:141:11",
  "coverage-preprocess.ts | comment-ws.ts | panic @ src/coverage-preprocess.ts:141:11",
  // `"\` at end of input. `decodeEscapeAt`'s `raw[i + 1] ?? ""` — the `??` is a DEAD
  // GUARD; the panic happens where the `??` was supposed to answer.
  "lexer.ts | escape-trailing.ts | panic @ src/lexer.ts:193:16",
  // `/*` unterminated. `advance` reads `source[st.i]` one past the end. bun exits 0 here:
  // there is no LexError to match, the compiled side simply dies.
  "lexer.ts | unterminated-comment.ts | panic @ src/lexer.ts:276:17",
  // `"` at end of input. `source[st.i] !== quote` panics one statement BEFORE the
  // `LexError` it was written to raise, so this is the ERROR PATH itself breaking.
  "lexer.ts | unterminated-string-eof.ts | panic @ src/lexer.ts:463:17",
  "lexer.ts | nul-in-string.ts | panic @ src/lexer.ts:463:17",
  // EMPTY INPUT. `source[0] === "#" && source[1] === "!"` panics on a zero-length string,
  // so the compiled preprocessor cannot handle an empty file at all.
  "coverage-preprocess.ts | empty.ts | panic @ src/coverage-preprocess.ts:177:13",
  // A span whose line is PAST THE END of the source: `srcLines[s.line - 1] ?? ""` panics
  // before the `??`. bun renders a blank source line, which is what the code intends.
  "diagnostics.ts | case 20 line-past-end | panic @ src/diagnostics.ts:140:26",
  "diagnostics.ts | case 23 line-huge | panic @ src/diagnostics.ts:140:26",

  /* ---- B. A COMPILER BUG, and a silent wrong answer ----
   *
   * `srcLines[1.5]` is `undefined` in JS and ELEMENT 1 in nativets: a runtime non-integer
   * index is truncated instead of missing. Exit 0 on both sides, different answers. With a
   * LITERAL index the checker catches it (NT2002), so it only escapes when the index is
   * computed — which is exactly how `formatDiagnostic` computes it. Four-line repro, no
   * self-hosting involved:
   *   const xs: string[] = ["a","b","c"]; let i = 0; i = i + 1.5;
   *   console.log(xs[i] ?? "undefined");   // node: undefined   nativets: b */
  "diagnostics.ts | case 22 line-fractional | stdout",

  /* ---- C. DOCUMENTED runtime doors, reached through these modules ----
   *
   * `String.fromCharCode(0)` is the empty string and `readFileSync` truncates at the first
   * NUL byte — both are named in docs/divergences.md as open runtime doors that "a
   * self-compiled nativets cannot detect". These rows are what that costs in practice: a
   * `"\0"` in a source file loses its NUL, and a file with a NUL byte is lexed short. */
  "lexer.ts | escapes-all.ts | stdout",
  "lexer.ts | nul.ts | stdout",
  "coverage-preprocess.ts | nul.ts | stdout",
  "coverage-preprocess.ts | nul-in-string.ts | stdout",

  /* ---- D. The UTF-8-byte string model, showing through as BEHAVIOUR ----
   *
   * `.length` and `charCodeAt` counting bytes rather than UTF-16 code units is documented,
   * and the harness subtracts the pure length/column shift (see `normalize`). What it
   * cannot subtract is the model changing what the code DECIDES: a BOM is one whitespace
   * code unit to bun and three non-ASCII bytes to nativets, so the compiled lexer THROWS
   * on a file bun lexes; `leadingWhitespace` in diagnostics.ts open-codes ECMAScript's
   * WhiteSpace table by `charCodeAt` and matches none of it on bytes, so the caret lands
   * in the wrong column. Not new bugs — but they are the reason a self-hosted nativets
   * would misread its own non-ASCII source, which is a stronger statement than "lengths
   * differ", and no existing test makes it. */
  "lexer.ts | bom.ts | stdout",
  "coverage-preprocess.ts | bom.ts | stdout",
  "coverage-preprocess.ts | bom-inside.ts | stdout",
  "coverage-preprocess.ts | ls-ps.ts | stdout",
  "coverage-preprocess.ts | weird-space.ts | stdout",
  "coverage-preprocess.ts | unicode-ident.ts | stdout",
  "diagnostics.ts | case 30 unicode-whitespace | stdout",
  "diagnostics.ts | case 31 near-miss-whitespace | stdout",
  "diagnostics.ts | case 32 unicode-line | stdout",
];

/** Path-independent, machine-independent row key. */
const rowOf = (d: { module: string; input: string; cause: string }) =>
  `${d.module} | ${d.input.startsWith("case ") ? d.input : basename(d.input)} | ${d.cause.replace(/@ .*\/src\//, "@ src/")}`;

/** One sweep, two assertions — it links three binaries, so it is not run twice. */
let SWEEP: ReturnType<typeof fuzz> | undefined;
const sweep = () => (SWEEP ??= fuzz({ corpus: "none", skipHuge: true }));

describe("SH6 rung-3 differential fuzz (compiled module vs bun-run module)", () => {
  test("the recorded divergences, and no others", async () => {
    const report = await sweep();
    const rows = report.divergences.map(rowOf).sort();
    expect(rows).toEqual([...RECORDED].sort());
  }, 900_000);

  /**
   * THE ERROR PATH, positively. `lex` throws `LexError`, and the question this lane was
   * asked is whether the COMPILED module fails the same way: same stdout, same exit code,
   * stderr allowed to differ (a panic/abort line here, a stack trace under bun).
   *
   * The answer is SPLIT, and both halves need an assertion or the split is invisible:
   *   - Where `lex` actually REACHES its `throw`, the compiled module agrees exactly —
   *     same stdout, exit 1 on both sides. These are those inputs.
   *   - Where the malformed input runs off the END of the source first, an out-of-range
   *     index PANICS one step before the `throw`, and the exit code is SIGABRT instead of
   *     1. Those are the group-A rows in the table above, and they are the reason this
   *     cannot be summarised as "the error path matches".
   */
  test("the LexError path agrees on stdout AND exit code where it is reached", async () => {
    const report = await sweep();
    const lexAgreed = report.errorPathAgreements
      .filter((r) => r.startsWith("lexer.ts | "))
      .map((r) => r.slice("lexer.ts | ".length))
      .sort();
    expect(lexAgreed).toEqual([
      // `Unexpected character` — every one of these is a non-ASCII code point that neither
      // side accepts, and they agree on the message position too.
      "bom-inside.ts",
      "ls-ps.ts",
      "unicode-ident.ts",
      "weird-space.ts",
      // `Invalid \u escape` / `Invalid \x escape`
      "escape-bad-u.ts",
      "escape-bad-x.ts",
      // `Octal escape sequences are not allowed` (test262 Annex B.1.2)
      "escape-octal-01.ts",
      "escape-octal-1.ts",
      "escape-octal-7.ts",
      // `Unexpected character` — a `#` private field, which nativets does not lex.
      "private-field.ts",
      // The two unterminated forms that DO reach their throw, because the scan stops at a
      // newline rather than at end-of-input. Their end-of-input twins
      // (`unterminated-string-eof.ts`, `escape-trailing.ts`) panic instead, which is the
      // whole point of the split: the SAME error, one character later, aborts.
      "unterminated-string.ts",
      "unterminated-template.ts",
    ].sort());
  }, 900_000);

  /*
   * The harness's own moving parts, tested without spawning anything — a broken
   * normalizer or minimizer would turn this file into a green that means nothing.
   */
  test("normalize subtracts the UTF-8-length divergence and nothing else", () => {
    expect(normalize("src 10 5\n1:7 ident [5] const\n")).toBe("1: ident const\n");
    // It must NOT eat a length that is part of a token's VALUE.
    expect(normalize("1:1 str [8] [42] end\n")).toBe("1: str [42] end\n");
    expect(normalize("statements 1 stripped 0 erased 0\n")).toBe("statements 1 stripped 0 erased 0\n");
  });

  test("isAscii", () => {
    expect(isAscii(new TextEncoder().encode("plain"))).toBe(true);
    expect(isAscii(new TextEncoder().encode("em—dash"))).toBe(false);
  });

  test("minimize reduces to the interesting core", () => {
    // Everything containing "//" is interesting; the minimizer must land on exactly that.
    const min = minimize("aaa\nbbb//ccc\nddd\n", (c) => c.includes("//"));
    expect(min).toBe("//");
  });
});
