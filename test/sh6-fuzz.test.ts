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
 * ---- GROUP A IS NOW ZERO, and that is what this file was built to make possible ----
 * Eleven of the twenty-five rows first recorded here were ONE defect class, and one the
 * SH6 baseline had already hit twice in other modules (`lexer.ts`'s `source[st.i + 1]`,
 * `ast.ts`'s `list[list.length - 1]`): an out-of-range STRING or ARRAY index that
 * TypeScript types `T | undefined` under `noUncheckedIndexedAccess` and nativets PANICS on
 * by design (the Stage 41 bounds rule). Three of the six sites carried a `?? ""` that the
 * panic never reached — a DEAD GUARD, unreachable under a panic-on-OOB model and invisible
 * to tsc, which sees a live `T | undefined`.
 *
 * All six sites are fixed, in the modules rather than in the compiler, and every fix is a
 * `length` test that never FORMS the out-of-range index (`.at(i)` is the other sanctioned
 * spelling — see test/no-index-last.test.ts):
 *
 *   src/lexer.ts:95               `pragmaName`'s `body[a]` on a bare `//`
 *   src/coverage-preprocess.ts    the duplicated copy of the same function
 *   src/lexer.ts  `decodeEscapeAt`  `raw[i + 1] ?? ""` on a trailing `"\`
 *   src/lexer.ts  `advance`         `source[st.i]` past the end of an unterminated `/*`
 *   src/lexer.ts  the string scan   `source[st.i] !== quote` at end of input
 *   src/coverage-preprocess.ts    `source[0] === "#"` on an EMPTY file
 *   src/diagnostics.ts            `srcLines[s.line - 1] ?? ""` for a span past the end
 *
 * TWO INPUTS MOVED OUT OF GROUP A AND INTO THE ERROR-PATH AGREEMENT SET below rather than
 * merely disappearing — `unterminated-string-eof.ts` and `escape-trailing.ts` now REACH
 * their `LexError` and match bun on stdout and exit code. That is the split this file
 * documents closing on one side: the error path no longer depends on which character the
 * input ends with.
 *
 * ---- GROUP B, the compiler bug, is NOT fixed and is still live ----
 * A runtime non-integer array index TRUNCATES instead of missing: `xs[1.5]` is `undefined`
 * in JS and element 1 here, exit 0 on both sides — a silent wrong answer, which is the
 * worst outcome this project recognises. `diagnostics.ts` no longer reaches it (its guard
 * spells out node's own rule with `Number.isInteger`), so the row is gone from the table —
 * but the DEFECT is untouched and applies to every computed index in every program:
 *
 *   const xs: string[] = ["a","b","c"]; let i = 0; i = i + 1.5;
 *   console.log(xs[i] ?? "undefined");   // node: undefined   nativets: b
 *
 * A LITERAL non-integer index is refused by NT2002; a computed one is not. Fixing it is a
 * codegen + runtime change AND a decision (panic, like out-of-range, or refuse), so it is
 * reported here rather than smuggled into this lane.
 *
 * What REMAINS recorded below is groups C and D only: documented runtime doors (NUL
 * handling) and the documented UTF-8-byte string model showing through as behaviour.
 * Neither is a defect in these modules, and both are named in docs/divergences.md.
 */

import { test, expect, describe } from "bun:test";
import { basename } from "node:path";

import { fuzz, minimize, normalize, isAscii } from "./sh6-fuzz.ts";

/**
 * The recorded frontier: `module | input | cause`, sorted. Rows are the adversarial set
 * only — the file corpus is in the script, and every divergence it finds reduces to one of
 * the causes below.
 *
 * 25 rows when this table was written, 14 now, and the eleven that left were all ONE
 * bucket. The full 553-input sweep moved with them: 84 / 82 / 6 divergences down to 18
 * total, of which NONE is a `src/*.ts` file — the four that remain from the file corpus are
 * `test/selfhost-ratchet.test.ts` (×2), `test/sh6-fuzz.ts` and `test/textimport.test.ts`,
 * every one a documented NUL or UTF-8-byte door. The bare `//` used to account for 71 of
 * the 501 files on its own.
 */
const RECORDED: string[] = [
  /* ---- A. OUT-OF-RANGE INDEX — EMPTY, and it must stay empty ----
   *
   * Eleven rows, six distinct sites, one defect, all fixed; see the header. This is the
   * bucket that mattered: `//` alone appeared in 71 of the repo's 501 `.ts` files and in
   * 8 of the compiler's own 12 modules — INCLUDING src/lexer.ts, so the compiled lexer
   * could not lex its own source while its SH6 row read rung 3. A new entry in this bucket
   * is a self-hosting regression, not a curiosity. */

  /* ---- B. THE COMPILER BUG — no longer REACHED here, and not fixed ----
   *
   * `diagnostics.ts | case 22 line-fractional` used to sit here. `formatDiagnostic` now
   * spells out node's rule (`Number.isInteger`), so it no longer reaches the defect — but
   * a runtime non-integer array index still truncates for every other program in the tree.
   * See the header for the four-line repro. Do not read this empty bucket as "fixed". */

  /* ---- C. DOCUMENTED runtime doors, reached through these modules ----
   *
   * `String.fromCharCode(0)` is the empty string and `readFileSync` truncates at the first
   * NUL byte — both are named in docs/divergences.md as open runtime doors that "a
   * self-compiled nativets cannot detect". These rows are what that costs in practice: a
   * `"\0"` in a source file loses its NUL, and a file with a NUL byte is lexed short. */
  "lexer.ts | escapes-all.ts | stdout",
  "lexer.ts | nul.ts | stdout",
  // MOVED HERE FROM GROUP A. It used to abort at `src/lexer.ts:463`; with the string scan's
  // end-of-input guard in place it now runs to completion and what is left is the
  // documented NUL door — the same divergence its `nul.ts` sibling already showed. A row
  // changing GROUP is the useful signal this table gives: the abort is gone, the
  // documented divergence behind it is not.
  "lexer.ts | nul-in-string.ts | stdout",
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

/** The compiler's own twelve modules, separately — see the test below for why. */
let SRC_SWEEP: ReturnType<typeof fuzz> | undefined;
const srcSweep = () => (SRC_SWEEP ??= fuzz({ corpus: "src", skipHuge: true }));

describe("SH6 rung-3 differential fuzz (compiled module vs bun-run module)", () => {
  /**
   * THE ASSERTION RUNG 3 IS ACTUALLY ABOUT, and the one that was missing.
   *
   * `test/sh6.test.ts` recorded `lexer.ts` and `coverage-preprocess.ts` at rung 3 for
   * several rounds, and both drivers behind that row fed the module HAND-WRITTEN SNIPPETS.
   * A self-compiled `src/lexer.ts` could not lex `src/` — it aborted on 8 of the compiler's
   * own 12 modules, including `src/lexer.ts` itself — and no test could see it, because no
   * driver had ever handed a rung-3 module a real source file. A green row is worth what
   * its inputs are worth.
   *
   * So: the compiler's own twelve modules, no adversarial inputs, ZERO divergences. It is
   * the claim "at rung 3" has to mean before it means anything for SH7.
   *
   * IT COSTS ~60 s TODAY, and the reason is worth recording rather than hiding by shrinking
   * the corpus: `nt_str_index` calls `strlen` per access, so a compiled `lex` is QUADRATIC
   * in file size and `src/checker.ts` alone dominates this test. The corpus is all twelve
   * anyway — a representative subset would have been the third time in this file's history
   * that a cheaper proxy replaced the question — and it drops to seconds when the
   * string-indexing lane lands. `diagnostics.ts` is not in it: it renders shapes, not
   * files, and the sweep below covers it.
   */
  test("the compiled modules process the compiler's OWN SOURCE identically — zero divergences", async () => {
    const report = await srcSweep();
    expect(report.divergences.map(rowOf).sort()).toEqual([]);
    // The corpus must actually BE the twelve modules. A filter that silently matched
    // nothing would make the assertion above vacuous — which is the exact failure mode
    // this whole section exists to remove, so it is asserted rather than assumed.
    // (`diagnostics.ts` is not file-driven: its inputs are rendered diagnostic shapes.)
    expect({ lex: report.counts["lexer.ts"], prep: report.counts["coverage-preprocess.ts"] })
      .toEqual({ lex: 12, prep: 12 });
  }, 900_000);

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
   * The answer WAS split, and the split is now CLOSED — which is why the list below grew
   * by exactly the two inputs that used to be group-A rows:
   *   - Where `lex` reaches its `throw`, the compiled module agrees exactly: same stdout,
   *     exit 1 on both sides. It always did.
   *   - Where the malformed input ran off the END of the source first, an out-of-range
   *     index PANICKED one step before the `throw` and the exit was SIGABRT instead of 1.
   *     `"abc\n` matched and `"abc` did not — the same error, one character apart. The
   *     end-of-input guards in `advance` and the string scan removed that asymmetry, so
   *     `unterminated-string-eof.ts` and `escape-trailing.ts` now appear HERE.
   *
   * Keep both halves distinguishable: this list is the "reaches its throw" half, and group
   * A of the table above is the "aborts first" half. An input moving between them is the
   * measurement, and an input arriving in group A is a regression.
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
      // The unterminated forms whose scan stops at a NEWLINE. These always agreed.
      "unterminated-string.ts",
      "unterminated-template.ts",
      // ...and their END-OF-INPUT twins, which used to abort one statement before the
      // `throw` and now reach it. These two rows moving here from group A is the whole
      // result of this section: the error path no longer depends on the last character.
      "unterminated-string-eof.ts",
      "escape-trailing.ts",
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
