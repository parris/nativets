/*
 * `Math.max(...xs)` / `Math.min(...xs)` — spreading an ARRAY VALUE into the two
 * variadic Math builtins (the shape src/diagnostics.ts needs:
 * `Math.max(...spans.map((s) => String(s.line).length))`).
 *
 * Scope is deliberately narrow: Math.max/Math.min over a `number[]`, which lowers to
 * a runtime FOLD. Spreading into an arbitrary user function's rest parameter is a
 * much larger feature and stays refused (NT1006).
 *
 * The interesting content here is the IDENTITY of the fold, which C's `fmax`/`fmin`
 * get WRONG for JS:
 *   - `Math.max()` on no values is -Infinity, `Math.min()` is +Infinity — so an
 *     EMPTY array must produce those, not 0 and not a crash.
 *   - NaN PROPAGATES (`Math.max(NaN, 1)` is NaN), where C's `fmax` deliberately
 *     ignores NaN and answers 1.
 *   - +0/-0 are ordered (`Math.max(-0, 0)` is +0, `Math.min(-0, 0)` is -0), where
 *     IEEE-754 maxNum leaves the ±0 case unspecified.
 *
 * Cases are DERIVED (from the ECMA-262 definitions of Math.max/Math.min and from
 * node directly) — no external suite was opened for them.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte (stdout AND exit code). */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Compile + run without node (uses a nativets-only probe), asserting exact stdout. */
async function expectOut(source: string, stdout: string): Promise<void> {
  const r = await compileAndRun(source);
  expect(r.stdout).toBe(stdout);
  expect(r.exitCode).toBe(0);
}

describe("Math.max/min — the JS fold identity (fixed arguments)", () => {
  // 1. NaN propagates. C's fmax(NaN, 1) is 1; JS's Math.max(NaN, 1) is NaN.
  test("NaN propagates through max and min", async () => {
    await expectNode(`
console.log(Math.max(NaN, 1));
console.log(Math.min(NaN, 1));
console.log(Math.max(1, NaN));
console.log(Math.min(1, NaN));
console.log(Math.max(1, 2, NaN, 3));
`);
  });

  // 2. +0 and -0 are ORDERED. `1/x` is the probe that tells them apart (console.log
  // prints -0 for the value, but `1/-0` is -Infinity and `1/+0` is +Infinity).
  test("+0 is larger than -0, in both argument orders", async () => {
    await expectNode(`
console.log(1 / Math.max(-0, 0));
console.log(1 / Math.max(0, -0));
console.log(1 / Math.min(-0, 0));
console.log(1 / Math.min(0, -0));
console.log(1 / Math.max(-0, -0));
console.log(1 / Math.min(0, 0));
`);
  });
});

describe("Math.max/min — spreading a number[] value", () => {
  // 3. the base case: a named array variable spread into max/min.
  test("spreads a named number[] into max and min", async () => {
    await expectNode(`
const xs: number[] = [3, 1, 2];
console.log(Math.max(...xs));
console.log(Math.min(...xs));
`);
  });

  // 4. the IDENTITY. An empty spread is `Math.max()` with no arguments at all, which
  // is -Infinity (and +Infinity for min) — NOT 0, and not a crash on an empty fold.
  test("an EMPTY spread is the identity, -Infinity / +Infinity", async () => {
    await expectNode(`
const none: number[] = [];
console.log(Math.max(...none));
console.log(Math.min(...none));
const drained: number[] = [1, 2, 3].filter((x: number) => x > 99);
console.log(Math.max(...drained), Math.min(...drained));
`);
  });

  // 5. NaN propagates THROUGH the runtime fold too, from any position.
  test("NaN anywhere in a spread propagates", async () => {
    await expectNode(`
const lead: number[] = [NaN, 1];
const tail: number[] = [1, NaN];
const mid: number[] = [1, NaN, 2];
console.log(Math.max(...lead), Math.min(...lead));
console.log(Math.max(...tail), Math.min(...tail));
console.log(Math.max(...mid), Math.min(...mid));
`);
  });

  // 6. ±0 stays ordered through the fold, including against the -Infinity seed.
  test("+0/-0 stay ordered through a spread", async () => {
    await expectNode(`
const zs: number[] = [-0, 0];
const sz: number[] = [0, -0];
console.log(1 / Math.max(...zs), 1 / Math.min(...zs));
console.log(1 / Math.max(...sz), 1 / Math.min(...sz));
const negz: number[] = [-0];
console.log(1 / Math.max(...negz), 1 / Math.min(...negz));
`);
  });

  // 7. spreads MIX with fixed arguments, in any position — the fold is left-to-right
  // from the identity, so position is not special.
  test("spread mixes with fixed arguments in any position", async () => {
    await expectNode(`
const xs: number[] = [2, 3];
console.log(Math.max(1, ...xs, 5));
console.log(Math.min(1, ...xs, 5));
console.log(Math.max(...xs, 99));
console.log(Math.max(99, ...xs));
const ys: number[] = [10, 20];
console.log(Math.max(...xs, ...ys));
console.log(Math.min(...xs, ...ys));
const empty: number[] = [];
console.log(Math.max(4, ...empty));
console.log(Math.min(4, ...empty));
`);
  });

  // 8. an array-literal spread `...[a, b]` has its length right here — it inlines,
  // so no array is built at all, and it composes with the runtime-length form.
  test("an array-literal spread inlines", async () => {
    await expectNode(`
console.log(Math.max(...[3, 1, 2]));
console.log(Math.min(...[3, 1, 2]));
console.log(Math.max(...[NaN, 1]));
console.log(1 / Math.max(...[-0, 0]));
console.log(1 / Math.min(...[-0, 0]));
const xs: number[] = [7];
console.log(Math.max(...[1, 2], ...xs));
`);
  });
});

describe("Math.max/min — the spread temporary is dropped", () => {
  // 9. `Math.max(...xs.map(f))` builds an array NO BINDING OWNS, so the ownership
  // pass never sees it and it would leak unless codegen frees it. `__arrLive()` is
  // the runtime's live-NtArray counter (see test/drops.test.ts); node cannot run it,
  // so this one asserts stdout directly rather than differentially.
  test("a spread TEMPORARY is freed, not leaked", async () => {
    await expectOut(`
const spans: number[] = [1, 22, 333];
const before = __arrLive();
console.log(Math.max(...spans.map((s: number) => s * 2)));
console.log(__arrLive() - before);
`, "666\n0\n");
  });

  // 10. the actual site that blocked self-compilation, in src/diagnostics.ts:
  //     Math.max(...spans.map((s) => String(s.line).length))
  test("the diagnostics.ts gutter-width shape compiles and runs", async () => {
    await expectNode(`
interface Span { line: number }
const spans: Span[] = [{ line: 7 }, { line: 1234 }, { line: 99 }];
const gutter = Math.max(...spans.map((s: Span) => String(s.line).length));
console.log(gutter);
`);
  });

  // 11. …and the same site does not leak the mapped array either.
  test("the diagnostics.ts shape does not leak its temporary", async () => {
    await expectOut(`
interface Span { line: number }
const spans: Span[] = [{ line: 7 }, { line: 1234 }, { line: 99 }];
const before = __arrLive();
const gutter = Math.max(...spans.map((s: Span) => String(s.line).length));
console.log(gutter);
console.log(__arrLive() - before);
`, "4\n0\n");
  });
});

describe("spread into a call — what stays REFUSED", () => {
  /** Assert compiling `src` fails with exactly `code`, and return the rendered text. */
  function expectRefusal(src: string, code: string): string {
    let err: NTError | undefined;
    try {
      sourceToIR(src);
    } catch (e) {
      err = e as NTError;
    }
    expect(err).toBeInstanceOf(NTError);
    expect(err!.diag.code).toBe(code);
    return formatDiagnostic(err!.diag, src);
  }

  // 12. Spreading into a REST parameter used to MISCOMPILE: `calleeArity` counted the
  // rest parameter as one ordinary parameter, so `total(...xs)` expanded to
  // `total(xs[0])` and printed 1 where node prints 6 — a silent wrong answer. General
  // variadics are out of scope, so the fix is to REFUSE, per the prime directive.
  test("spreading into a rest parameter is refused, not miscompiled", () => {
    const rendered = expectRefusal(`
function total(...ns: number[]): number { let s = 0; for (const n of ns) s += n; return s; }
const xs: number[] = [1, 2, 3];
console.log(total(...xs));
`, "NT1006");
    expect(rendered).toContain("spread");
  });

  // 13. spreading into an arbitrary variadic/method call stays refused.
  test("spreading into console.log is refused", () => {
    expectRefusal(`
const xs: number[] = [1, 2, 3];
console.log(...xs);
`, "NT1006");
  });

  // 14. Math.max only spreads a number[] — a string[] is a type error, not a fold
  // over garbage.
  test("Math.max cannot spread a string[]", () => {
    const rendered = expectRefusal(`
const xs: string[] = ["a", "b"];
console.log(Math.max(...xs));
`, "NT2001");
    expect(rendered).toContain("number[]");
  });
});
