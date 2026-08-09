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

import { expectMatchesNode } from "./harness.ts";

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
