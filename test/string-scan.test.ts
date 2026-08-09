/*
 * STRING SCANNING IS LINEAR — the asymptotic gate.
 *
 * The idiom every scanner in this compiler is written in
 *
 *     while (i < s.length) { const c = s[i]!; … }
 *
 * used to be QUADRATIC. A nativets string is a bare NUL-terminated `char *`, so both
 * `.length` and `s[i]` called `strlen` and walked the whole string: two full walks per
 * character. Measured on the compiled `src/lexer.ts` before this file existed —
 *
 *     input            chars      nativets      bun
 *     parser.ts       206 KB        3.69 s     0.02 s
 *     checker.ts      348 KB       10.17 s     0.03 s
 *     checker.ts x4   1.39 MB     155.58 s     0.08 s
 *
 * — a fitted exponent of 1.98 and 100% of the `sample` profile in `_platform_strlen`.
 * At that rate a self-hosted lex of all of `src/` is ~2 minutes and growing with the
 * square, which no bootstrap survives.
 *
 * WHY THE GATE IS A COUNT, NOT A CLOCK. test/perf.test.ts already argues this at
 * length (rustc-perf's `instructions:u`, tsc's `--extendedDiagnostics` counts): wall
 * clock on a shared CI runner moves by +258% on a QUIET machine, so it can neither
 * prove nor disprove a 2x. `__strScanned()` is the deterministic instrument — the
 * number of bytes `strlen` actually walked answering length queries. It is exactly the
 * work this change removes, it is identical on every machine, and it separates O(n)
 * from O(n^2) by four orders of magnitude at n = 160,000.
 *
 * The second half is ALLOCATION. `s[i]` used to malloc a fresh one-character string per
 * access and hold it in the RC table; a probe measured 226-263 bytes of RSS per source
 * character, invisible to `__objLive`/`__arrLive`/`leaks`/LeakSanitizer alike because
 * the temps are REACHABLE from that table. One-byte strings are now 256 interned
 * statics, so a scan allocates nothing — asserted here as a live-count delta of 0.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";
import { runWithNode } from "./harness.ts";

/** 10 * 2^14 = 163,840 bytes, built by doubling so construction itself is linear. */
const BUILD = `
function big(): string {
  let s: string = "abcdefghij";
  let k: number = 0;
  while (k < 14) { s = s + s; k++; }
  return s;
}`;

describe("string scanning is linear in the string's length", () => {
  test("the `while (i < s.length) s[i]` scan walks O(n) bytes, not O(n^2)", async () => {
    const src = `${BUILD}
const s: string = big();
const n: number = s.length;
const before: number = __strScanned();
let i: number = 0;
let acc: number = 0;
while (i < s.length) { const c: string = s[i]!; if (c === "a") { acc = acc + 1; } i = i + 1; }
const scanned: number = __strScanned() - before;
console.log(n, acc);
// LINEAR: the whole scan may not walk more bytes than the string is long. It walks 0
// today (the length was already memoized by the \`s.length\` above); the budget is n so
// the gate states the asymptote rather than the current constant. QUADRATIC would be
// ~2*n*n = 5.4e10 here.
console.log(scanned <= n);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("163840 16384\ntrue\n");
    expect(r.exitCode).toBe(0);
  }, 120_000);

  test("indexing allocates nothing — one-byte strings are interned", async () => {
    const src = `${BUILD}
const s: string = big();
const before: number = __strLive();
let i: number = 0;
let acc: number = 0;
while (i < s.length) { const c: string = s[i]!; if (c === "j") { acc = acc + 1; } i = i + 1; }
console.log(acc, __strLive() - before);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("16384 0\n");
    expect(r.exitCode).toBe(0);
  }, 120_000);

  test("an interned one-byte string is still an ordinary string value (node oracle)", async () => {
    const src = `
const s: string = "hello".slice(0, 5);
const c: string = s[1]!;
const d: string = s[1]!;
console.log(c, d, c === d, c.length, c + d, c.toUpperCase(), c.charCodeAt(0));
const parts: string[] = s.split("");
console.log(parts.length, parts.join("-"), parts[0]!.length);
const e: string = "".padStart(0, "x");
console.log(JSON.stringify(e), e.length, e === "");`;
    const r = await compileAndRun(src);
    const oracle = await runWithNode(src);
    expect(r.stdout).toBe(oracle.stdout);
    expect(r.exitCode).toBe(oracle.exitCode);
  }, 120_000);
});
