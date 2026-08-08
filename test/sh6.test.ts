/*
 * SH6 — DIFFERENTIAL SELF-COMPILATION, measured.
 *
 * docs/self-hosting.md, milestone SH6: "Compile lexer -> parser -> checker -> codegen
 * -> ... each under nativets and differential-test its output against the `bun`-run
 * version (same discipline as everything else: the existing compiler is the oracle for
 * the self-hosted one)."
 *
 * This file is an INSTRUMENT, not a feature. Nothing else measures SH6: every
 * self-hosting lane's success is currently judged by the PROXY "the module reaches
 * `parse`", which answers a question nobody asked. The question that matters is whether
 * nativets compiles the compiler's own source into something that BEHAVES like the
 * bun-run compiler.
 *
 * ---- THE DIFFERENTIAL, precisely ----
 * The seam is `sourceToIR(source, entryPath)` in `src/driver.ts` — the pure
 * source -> LLVM IR text function that `build`, `run` and `emit` all go through.
 *
 *   For a given .ts input, the IR produced by the BUN-RUN compiler and the IR produced
 *   by a NATIVETS-COMPILED compiler must be IDENTICAL, byte for byte.
 *
 * Not "both compile". Not "both run". Not "both produce working binaries". Byte-for-byte
 * equal IR text, because that is the only statement of equivalence that cannot be passed
 * by accident. `bun` is to the self-hosted compiler exactly what `node` is to nativets:
 * the oracle, and when they disagree WE are wrong.
 *
 * ---- THE RUNG LADDER ----
 * Each of the twelve `src/*.ts` modules, plus the real entry point `src/cli.ts` (whose
 * import graph pulls in everything), records its FURTHEST rung:
 *
 *   rung 0  `sourceToIR` throws          — does not reach IR. The blocking error is recorded.
 *   rung 1  `sourceToIR` returns         — reaches IR.
 *   rung 2  that IR links via clang      — a native binary exists.
 *   rung 3  the binary runs and its output matches the bun-run equivalent.
 *
 * For `cli.ts` rung 3 IS the differential above: the binary is run as
 * `nativets-1 emit <input>` and its stdout must equal `bun run src/cli.ts emit <input>`,
 * which is the IR the oracle produced. That is stage-1 of the bootstrap.
 *
 * ---- IT IS EXPECTED-TO-FAIL TODAY, AND SAYS SO STRUCTURALLY ----
 * Not one module reaches IR right now, so nearly every row sits at rung 0. That is the
 * point. A harness that SKIPS what it cannot yet do measures nothing; one that RECORDS
 * how far each module got measures everything. Ratchet semantics, like
 * `test/bootstrap.test.ts` and the conformance corpora's minimum-supported counts: a
 * module may improve, never regress, and a regression is a hard failure naming the
 * module and the error.
 *
 * ---- WHAT THIS HARNESS CANNOT PROVE ----
 * SH6 green for all twelve modules is STILL NOT SH7, and nobody should read a green run
 * here as a working bootstrap:
 *
 *   1. Rung 3 is a differential over a CORPUS. A compiler can emit correct IR for every
 *      input we happen to test and still miscompile the input that matters — its own
 *      source. Passing corpus IR equality is necessary, not sufficient.
 *   2. Rungs 0-2 for a single module say nothing about the WHOLE compiler. A module that
 *      compiles in isolation may still fail in the merged whole-program link (SH1 merges
 *      the graph into one Program), and the merged program is what stage-1 actually is.
 *   3. Rung 3 for a plain module is WEAK by construction. `src/lexer.ts` is a library: it
 *      prints nothing, so "native output == bun output" compares empty to empty. Such a
 *      match is recorded as `weak` and must not be read as evidence the module works. The
 *      only non-weak module row is `cli.ts`, which has observable behaviour.
 *   4. SH7 is the THREE-STAGE FIXED POINT and is not attempted here: nativets-1 compiles
 *      src/ -> nativets-2, nativets-2 compiles src/ -> nativets-3, and self-hosting holds
 *      only when nativets-2 and nativets-3 are BYTE-IDENTICAL *and* the full differential
 *      suite passes when compiled by nativets-2. A compiler can emit correct IR for a
 *      corpus and still fail to reproduce itself.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { sourceToIR, buildBinary } from "../src/driver.ts";

const SRC = new URL("../src/", import.meta.url);
const pathOf = (m: string) => new URL(m, SRC).pathname;
const read = (m: string) => readFileSync(pathOf(m), "utf8");

/* ============================================================
 * The ladder
 * ============================================================ */

type Rung = 0 | 1 | 2 | 3;

interface Measured {
  rung: Rung;
  /** First line of the error that stopped it (empty once rung 3 is reached). */
  error: string;
  /** The NT diagnostic code parsed out of `error`, or "other". */
  code: string;
  /** Rung 3 reached, but both sides printed nothing — see caveat 3 in the header. */
  weak: boolean;
}

/** An entry the ladder is run on: a file, and the argv it is exercised with. */
interface Entry {
  /** Display name (a module file name under src/, or the control specimen's). */
  file: string;
  /** Absolute path to the entry file — what `import "./x.ts"` resolves against. */
  path: () => string;
  /** argv passed to BOTH the native binary and the bun-run oracle at rung 3. */
  argv: () => string[];
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.trim();
const codeOf = (error: string) => /\[(NT\d+)\]/.exec(error)?.[1] ?? (error ? "other" : "");

/**
 * Run the ladder for one entry.
 *
 * Deliberately lazy: rung 0 and rung 1 are decided by `sourceToIR` alone, which is pure
 * and takes milliseconds. clang is only invoked once a module has actually reached IR.
 * This is measured often, so linking thirteen binaries on every invocation to learn
 * something rung 0 already decided would be waste, not rigor.
 */
async function ladder(entry: Entry): Promise<Measured> {
  const path = entry.path();
  const source = readFileSync(path, "utf8");

  // rung 0 -> 1: does the compiler's own source reach LLVM IR?
  try {
    sourceToIR(source, path);
  } catch (e) {
    return { rung: 0, error: msg(e), code: codeOf(msg(e)), weak: false };
  }

  // rung 1 -> 2: does that IR link to a native binary?
  const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-"));
  try {
    const bin = join(dir, "nativets-1");
    try {
      await buildBinary(source, bin, { target: "host", entryPath: path });
    } catch (e) {
      return { rung: 1, error: msg(e), code: codeOf(msg(e)), weak: false };
    }

    // rung 2 -> 3: does it behave like the bun-run compiler? The oracle is `bun run`
    // over the SAME file with the SAME argv — bun is to the self-hosted compiler what
    // node is to nativets. stdout + exit code are compared, matching the fixture
    // differential's convention; stderr is not, because a compiled compiler's stack
    // traces and bun's are not the same text even when the compilers agree.
    const argv = entry.argv();
    const ours = spawnSync(bin, argv, { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
    const oracle = spawnSync("bun", ["run", path, ...argv], { encoding: "utf8", timeout: 120_000 });
    const oursOut = ours.stdout ?? "";
    const oracleOut = oracle.stdout ?? "";

    if (oursOut !== oracleOut) {
      return { rung: 2, error: `stdout differs from the bun-run compiler (${oursOut.length} vs ${oracleOut.length} bytes)`, code: "DIFF", weak: false };
    }
    if ((ours.status ?? -1) !== (oracle.status ?? -1)) {
      return { rung: 2, error: `exit code differs: ${ours.status} vs ${oracle.status}`, code: "DIFF", weak: false };
    }
    // A library module prints nothing, so an empty==empty match is not evidence.
    return { rung: 3, error: "", code: "", weak: oursOut.length === 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Memoized — several tests read the same rows, and rung 2/3 shell out. */
const measurements = new Map<string, Promise<Measured>>();
function measure(entry: Entry): Promise<Measured> {
  const key = `${entry.path()} ${entry.argv().join(" ")}`;
  let m = measurements.get(key);
  if (!m) measurements.set(key, (m = ladder(entry)));
  return m;
}

/* ============================================================
 * The differential corpus (used at rung 3 of the stage-1 entry)
 * ============================================================ */

/**
 * Inputs the compiled compiler is asked to compile. Kept tiny on purpose: the point of
 * the corpus is to catch a compiled compiler that emits DIFFERENT IR, and the smallest
 * program that exercises the pipeline does that as well as a large one while keeping
 * this measurement fast.
 *
 * When stage-1 lands, this corpus should be widened to the whole `test/fixtures/` tree —
 * per caveat 1 in the header, IR equality over three snippets is not IR equality over
 * everything the compiler can be handed.
 */
const CORPUS: Record<string, string> = {
  "hello.ts": 'console.log("hello, self-host");\n',
  "closures.ts": [
    "function makeCounter(): () => number {",
    "  let n = 0;",
    "  return () => { n = n + 1; return n; };",
    "}",
    "const c = makeCounter();",
    "console.log(c() + c());",
    "",
  ].join("\n"),
  "records.ts": [
    "const xs: number[] = [3, 1, 2];",
    "const o = { name: `n${xs.length}`, tags: xs.toSorted() };",
    "console.log(JSON.stringify(o));",
    "",
  ].join("\n"),
};

const corpusDir = (() => {
  const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-corpus-"));
  for (const [name, src] of Object.entries(CORPUS)) writeFileSync(join(dir, name), src);
  return dir;
})();

const corpusEntry = join(corpusDir, "hello.ts");

afterAll(() => rmSync(corpusDir, { recursive: true, force: true }));

/* ============================================================
 * BASELINE — the recorded frontier. May improve, never regress.
 * ============================================================ */

/**
 * The twelve modules, plus `cli.ts` a second time as the stage-1 entry (there it is
 * exercised as a COMPILER — `emit <input>` — rather than as a library, so it is a
 * genuinely different measurement of the same file).
 *
 * `rung` is the floor: the ratchet fails if a row drops below it. `code` is the blocker
 * as last measured, recorded for the gradient rather than as a floor — clearing one
 * blocker UNMASKS the next, so codes churn while rungs do not.
 */
const BASELINE: Record<string, { rung: Rung; code: string; blame: string }> = {
  // RE-MEASURED CENTRALLY after a twelve-lane round (2026-08-07). EVERY row changed except
  // lexer.ts and modules.ts. NT1017 is gone tree-wide (`export async function` landed);
  // NT0001 is down to one module, and it is a NEW one — codegen.ts got FURTHER when static
  // members landed and stopped on an unnamed parse error behind them.
  //
  // Read the blame column carefully: `driver.ts` and `cli.ts` used to blame themselves and
  // each other for NT1017; they now both blame `parser.ts`, whose `?.[]` they inherit
  // through the link. That is not a regression — they cleared their own blocker and the
  // link surfaced the deepest one they share.
  "ast.ts": { rung: 0, code: "NT1009", blame: "self" },
  // Was NT1014 (`new Set([...])` for REGEX_AFTER_KEYWORD) until the collections lane made
  // `new Set(iterable)` compile; the module now stops on the ESCAPES object literal.
  "lexer.ts": { rung: 0, code: "NT2001", blame: "self" },
  // Left NT1606 when `.sort()` on a FRESH receiver stopped being refused; now a variadic
  // spread, `Math.max(...spans.map(…))`.
  "diagnostics.ts": { rung: 0, code: "NT1006", blame: "self" },
  // Left NT0001 (`satisfies`); the code is unchanged at NT1009 but the FEATURE is not —
  // it is now optional element access `?.[]`, not a union.
  "parser.ts": { rung: 0, code: "NT1009", blame: "self" },
  // THE CRUX MOVED, then moved again. `Record<string, number | "var">` compiles, so
  // checker.ts left NT1009; it then stopped on `delete o.k` (NT1606), which the delete
  // lane established must STAY refused — node distinguishes an absent key from a
  // present-undefined one and a flat slot array cannot. Sharpening that refusal moved the
  // module on to NT1027, a regex literal.
  "checker.ts": { rung: 0, code: "NT1027", blame: "self" },
  // Left NT1015 (static members) and reached further — an unnamed parse error at 582:33.
  "codegen.ts": { rung: 0, code: "NT1023", blame: "self" },
  "coverage.ts": { rung: 0, code: "NT1009", blame: "ast.ts" },
  // Still inherits checker.ts's blocker, and has now followed it through THREE codes —
  // NT1009 -> NT1606 -> NT1027 — without ever having a blocker of its own under the link.
  // The long-standing "ownership.ts is credited with checker.ts's problem" attribution
  // trap, still visible. MEASURED, not predicted: the lane that moved checker.ts expected
  // this row to land on NT1014, and it did not — it tracks checker.ts exactly, because the
  // two errors are byte-identical. Always re-measure this column rather than inferring it.
  "ownership.ts": { rung: 0, code: "NT1027", blame: "checker.ts" },
  "driver.ts": { rung: 0, code: "NT1009", blame: "parser.ts" },
  "cli.ts": { rung: 0, code: "NT1009", blame: "parser.ts" },
  "modules.ts": { rung: 0, code: "NT1015", blame: "self" },
  "coverage-preprocess.ts": { rung: 0, code: "NT1009", blame: "ast.ts" },
};

/*
 * SH5 — compile-time text imports (`with { type: "text" }`). The blocker this file
 * called "structural" is gone: the parser accepts the import-attributes clause and the
 * linker inlines the file as a string constant, so `src/driver.ts` now parses all
 * twelve of its embedded C files (~305KB) and reaches `export async function` at
 * driver.ts:502. Every rung FLOOR held. Two rows moved WITHIN NT1017:
 *
 *   driver.ts  NT1017 @ 27:1  (text import)  ->  NT1017 @ 502:1 (`export async`)
 *   cli.ts     the same, inherited
 *
 * so the `code` column is unchanged while the frontier moved 475 lines deeper — which
 * is exactly why `code` is recorded for the gradient and never used as a floor.
 *
 * BASELINE HISTORY — recorded because the deltas are the measurement's whole output.
 *
 * First recorded (before SH4 and the regex removal landed):
 *   NT1027 x4 (lexer, diagnostics, ownership, coverage-preprocess) — regex literals
 *   NT1017 x3 (driver, cli, modules)             — `node:fs` and friends
 *   NT0001 x3, NT1009 x1, NT1015 x1
 *
 * After merging main (SH4 host FFI + the compiler's own source made regex-free), every
 * rung FLOOR held — no regressions — and five of the twelve moved to a different, deeper
 * blocker. What the movement shows:
 *
 *   - `NT1027` is an EMPTY bucket, as main claims. What sat behind it: `lexer.ts` then
 *     died on `new Set([...])` (NT1014) at src/lexer.ts:101 — the regex-lexing support
 *     table survived the removal of the regex literals themselves. (SUPERSEDED — the
 *     collections lane made `new Set(iterable)` compile; `lexer.ts` walked on to
 *     NT2001, the `ESCAPES` `Map<string, string>` initialized with an object literal.)
 *   - `NT1017` did NOT clear for `driver.ts`. SH4 cleared `node:fs`; what is left is
 *     `import runtimeSource from "../runtime/runtime.c" with { type: "text" }`
 *     (src/driver.ts:27) — the bun-specific text import that embeds the C runtime into
 *     the single executable. `cli.ts` inherits it. This is structural: a self-hosted
 *     nativets needs its own answer for embedding the runtime, and no host-FFI work
 *     removes it. (SUPERSEDED — SH5 gave it that answer; see the note above the
 *     history. The construct is now compiled, not refused.)
 *   - `diagnostics.ts` now dies with **NT2001**, the TYPE-ERROR band. That matters for
 *     the gradient: `coverage` deliberately counts only the NT1xxx band (an NT2xxx is
 *     "a real user error"), so this blocker is invisible to the coverage histogram by
 *     design, and only a pipeline measurement like this one sees it at all. It is also
 *     reported with NO span, and the identifier it names ('value') does not occur in
 *     `src/diagnostics.ts` — so it is currently unlocatable from the diagnostic alone.
 *
 * After the short-circuit-narrowing lane, `diagnostics.ts` moves **NT2001 -> NT1606**:
 * `formatDiagnostic`'s `if (!diag.spans || diag.spans.length === 0 || !source)` now
 * type-checks (a guard narrows every term to its right, and the narrowed thing may be a
 * dotted name), and what is behind it is `[...diag.spans].sort(…)` at src/diagnostics.ts
 * — the immutable-data refusal, an NT16xx and so still outside the coverage histogram.
 * The same lane fixed the two defects the note above describes: NT2001 now carries a
 * primary span and names the receiver as written (`'diag.spans'`, not `'value'`).
 */

/** As a library (no argv) — every module compiled as its own entry. */
const MODULES: Entry[] = Object.keys(BASELINE).map((file) => ({
  file,
  path: () => pathOf(file),
  argv: () => [],
}));

/** Stage-1: the real entry point, exercised as a COMPILER over the corpus. */
const STAGE1: Entry = { file: "cli.ts", path: () => pathOf("cli.ts"), argv: () => ["emit", corpusEntry] };

/** Recorded separately from BASELINE: this is a different measurement of cli.ts. */
// Stage-1 (cli.ts, the whole compiler through its real entry point) left NT1017 when
// `export async function` landed and now stops on parser.ts's `?.[]` at 1109:66 —
// inherited through the link, not cli.ts's own code. Still rung 0.
const STAGE1_BASELINE: { rung: Rung; code: string } = { rung: 0, code: "NT1009" };

describe("SH6: the instrument itself — the upper rungs are exercised, not dead code", () => {
  /**
   * Rungs 1, 2 and 3 are unreachable by every real row today, so without this they would
   * be untested code that only runs on the day a module finally reaches IR — the worst
   * possible moment to discover the measurement is broken. A control specimen (an
   * ordinary program that DOES compile, link, run and print) walks the identical ladder
   * function and must land on a non-weak rung 3. If this fails, no rung reported by this
   * file above 0 can be trusted.
   */
  test("a known-good program walks the whole ladder to a non-weak rung 3", async () => {
    const control: Entry = {
      file: "control specimen",
      path: () => join(corpusDir, "records.ts"),
      argv: () => [],
    };
    const m = await measure(control);
    expect({ rung: m.rung, weak: m.weak, error: m.error }).toEqual({ rung: 3, weak: false, error: "" });
  }, 300_000);
});

describe("SH6: rung ladder (ratchet — a module may improve, never regress)", () => {
  for (const entry of MODULES) {
    const floor = BASELINE[entry.file]!;
    test(`${entry.file} reaches at least rung ${floor.rung}`, async () => {
      const m = await measure(entry);
      expect(
        m.rung >= floor.rung
          ? "ok"
          : `${entry.file} REGRESSED from rung ${floor.rung} to rung ${m.rung}: ${m.error}`,
      ).toBe("ok");
    }, 300_000);
  }

  test(`stage-1 (cli.ts as a compiler) reaches at least rung ${STAGE1_BASELINE.rung}`, async () => {
    const m = await measure(STAGE1);
    expect(
      m.rung >= STAGE1_BASELINE.rung
        ? "ok"
        : `stage-1 REGRESSED to rung ${m.rung}: ${m.error}`,
    ).toBe("ok");
  }, 600_000);
});

describe("SH6: the frontier as it stands (expected-to-fail — flip these when it moves)", () => {
  /**
   * The headline number, and the one that contradicts the current picture.
   *
   * `docs/self-hosting.md` records "| **IR** | `coverage` only |", and
   * `test/bootstrap.test.ts` records `"coverage.ts": "ir"` in its BASELINE. Neither is
   * true: ZERO of the twelve modules produce IR. `coverage.ts` is the module whose own
   * source parses cleanly, but the SH1 link pulls in `ast.ts`, which does not — so
   * `sourceToIR` throws for it exactly like the other eleven.
   *
   * The reason the older instrument reads otherwise is a defect in its scale, not a
   * change in the compiler: `bootstrap.test.ts:phaseOf` returns the phase `"ir"` on BOTH
   * branches of its final try/catch, so "produced IR" and "died during the IR stage"
   * score identically. Its top rung cannot distinguish success from failure. This
   * ladder's rung 1 is exactly that distinction, which is why it exists.
   */
  test("no module reaches IR — the whole ladder is at rung 0", async () => {
    const rows = await Promise.all(MODULES.map(async (e) => [e.file, (await measure(e)).rung] as const));
    const reachedIR = rows.filter(([, r]) => r >= 1).map(([f]) => f);
    expect(reachedIR).toEqual([]);
  }, 300_000);

  /**
   * The gradient: which blocker stops each module. Recorded so shrinking a bucket is a
   * deliberate, reviewable step. A mismatch here is NOT necessarily a regression —
   * clearing a blocker unmasks the one behind it — it is a prompt to re-record.
   */
  test("the blocker each module dies on", async () => {
    const got: Record<string, string> = {};
    for (const e of MODULES) got[e.file] = (await measure(e)).code;
    const want: Record<string, string> = {};
    for (const [file, b] of Object.entries(BASELINE)) want[file] = b.code;
    expect(got).toEqual(want);
  }, 300_000);

  /**
   * ATTRIBUTION — which FILE the blocker actually lives in, which the diagnostic itself
   * does not say. `sourceToIR` compiles a whole PROGRAM (SH1 merges the import graph), so
   * a module can be stopped by a file it merely imports. Eleven modules are stopped by
   * their own source; `coverage.ts` alone is clean on its own and inherits `ast.ts`'s
   * blocker. Aiming a burn-down at `coverage.ts` would therefore be aiming it at the
   * wrong file — the same class of mistake `coverage`'s preprocess made.
   */
  test("blocker attribution: self vs inherited through the import graph", async () => {
    const got: Record<string, string> = {};
    for (const e of MODULES) got[e.file] = await blameOf(e.file);
    const want: Record<string, string> = {};
    for (const [file, b] of Object.entries(BASELINE)) want[file] = b.blame;
    expect(got).toEqual(want);
  }, 300_000);

  /**
   * The parse-based attribution this test used to do is now WRONG, and recording why
   * matters more than the fix: it is the same mistake twice.
   *
   * `coverage`'s preprocess made a module look blocker-free by stripping what blocked it.
   * "Reaches parse" then became the proxy every self-hosting lane was judged by. Both
   * measure a stage rather than the outcome. Today SIX modules parse their own source
   * cleanly — and four of them are still blocked, two by a dependency and two at the
   * CHECKER, after parse is over. A parse-clean module is not an unblocked module, so
   * attribution has to compare what the whole pipeline actually reports.
   */
  test("parsing clean is not being unblocked — six parse, none compiles", async () => {
    const { parse } = await import("../src/parser.ts");
    const parseClean: string[] = [];
    for (const e of MODULES) {
      try { parse(read(e.file)); parseClean.push(e.file); } catch { /* blocked at parse */ }
    }
    // SEVEN now, not six: `driver.ts` joined when `export async function` landed. The
    // point of this test is unchanged and is the uncomfortable one — parsing clean has
    // never once correlated with being closer to compiling.
    expect(parseClean.sort()).toEqual([
      "cli.ts", "coverage-preprocess.ts", "coverage.ts", "diagnostics.ts", "driver.ts",
      "lexer.ts", "ownership.ts",
    ]);
    // ...and not one of them reaches IR.
    for (const file of parseClean) {
      const m = await measure(MODULES.find((e) => e.file === file)!);
      expect(`${file} rung ${m.rung}`).toBe(`${file} rung 0`);
    }
  }, 300_000);

  /**
   * Stage-1 — the whole compiler, entered at its real entry point. When THIS reaches
   * rung 3 the differential below starts doing real work and self-hosting stage-1 is
   * reached; until then it records how far it got.
   */
  test("stage-1 does not build (records how far it got)", async () => {
    const m = await measure(STAGE1);
    expect({ rung: m.rung, code: m.code }).toEqual(STAGE1_BASELINE);
  }, 600_000);
});

/**
 * ATTRIBUTION — which FILE a module's blocker actually lives in, which the diagnostic
 * itself does not say. `sourceToIR` compiles a whole PROGRAM (SH1 merges the import
 * graph), so a module is routinely stopped by a file it merely imports: `cli.ts` reports
 * `driver.ts`'s `export async`, `ownership.ts` reports `checker.ts`'s union. Aiming a
 * burn-down at the reporting module would be aiming it at the wrong file.
 *
 * A module is blamed on a dependency when that dependency, compiled as its OWN entry,
 * produces the byte-identical error. Dependencies are walked post-order (deepest first),
 * matching the linker's own DFS, so the blame lands on the file that originates the
 * error rather than an intermediate that merely propagates it.
 */
async function blameOf(file: string): Promise<string> {
  const error = (await measure(MODULES.find((e) => e.file === file)!)).error;
  if (!error) return "self";
  for (const dep of depsOf(file)) {
    const d = MODULES.find((e) => e.file === dep);
    if (d && (await measure(d)).error === error) return dep;
  }
  return "self";
}

/** Transitive `./x.ts` imports, post-order (deepest first) — the linker's own order. */
function depsOf(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: string[] = [];
  for (const m of read(file).matchAll(/(?:from|import)\s+"\.\/([\w.-]+\.ts)"/g)) {
    const dep = m[1]!;
    // Only real compiler modules: `src/*.ts` carries commented-out import EXAMPLES
    // (`from "./m.ts"` in a doc comment), and a text scan cannot tell those from code.
    if (!(dep in BASELINE)) continue;
    out.push(...depsOf(dep, seen), dep);
  }
  return out;
}

/* ============================================================
 * The differential itself
 * ============================================================ */

describe("SH6: differential self-compilation (bun-run compiler is the oracle)", () => {
  /**
   * THE assertion this whole file exists for. Once `cli.ts` reaches rung 3, a compiled
   * compiler exists and every corpus input must lower to BYTE-IDENTICAL IR under both
   * compilers.
   *
   * This is not conditional-so-it-can-be-skipped: the rung is measured, and while it is
   * below 3 the test asserts the recorded fact that no compiled compiler exists, which
   * fails the moment that stops being true — at which point the differential below is
   * the gate, and the recorded baseline must be updated deliberately.
   */
  test("a nativets-compiled compiler emits IR identical to the bun-run compiler", async () => {
    const m = await measure(STAGE1);
    if (m.rung < 3) {
      // No compiled compiler exists, so there is nothing to compare — recorded, not
      // skipped. The expected string is hardcoded, so this reds the moment stage-1
      // improves, and the comparison below becomes the real gate.
      // Assert the RUNG, the CODE and the CONSTRUCT — deliberately NOT the line:column.
      // This used to pin `at 1109:66`, which meant any edit ABOVE that line in parser.ts
      // reddened this test without stage-1 having moved at all; the indexed-access lane
      // shifted it to 1169:66 by adding parsing code elsewhere. A position is not the
      // fact being recorded. The fact is: stage-1 is at rung 0, stopped on optional
      // element access inherited from parser.ts. That still reds the moment the CONSTRUCT
      // or the rung changes, which is what this test is for.
      expect(`stage-1 rung ${m.rung}, ${m.code}`)
        .toBe(`stage-1 rung ${STAGE1_BASELINE.rung}, ${STAGE1_BASELINE.code}`);
      expect(m.error).toContain("optional element access '?.[]'");
      return;
    }

    // Stage-1 exists. Build it once, then compile every corpus input with BOTH compilers
    // and compare the IR text byte for byte.
    const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-stage1-"));
    try {
      const bin = join(dir, "nativets-1");
      await buildBinary(read("cli.ts"), bin, { target: "host", entryPath: pathOf("cli.ts") });
      for (const name of Object.keys(CORPUS)) {
        const input = join(corpusDir, name);
        const selfHosted = spawnSync(bin, ["emit", input], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
        const oracle = sourceToIR(readFileSync(input, "utf8"), input);
        expect(selfHosted.status).toBe(0);
        expect(selfHosted.stdout).toBe(oracle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);

  /**
   * The oracle side of the differential, verified independently of self-hosting: the
   * seam really is `sourceToIR`, and `nativets emit` really is that function's output,
   * so "the compiled compiler's `emit` stdout == `sourceToIR`" is a meaningful equality
   * rather than a comparison of two things that were never the same to begin with.
   *
   * This is the only test here that passes today, and it is deliberately narrow: it
   * proves the MEASURING APPARATUS is sound, not that anything self-hosts.
   */
  test("the seam is sound: `bun run cli.ts emit x` == sourceToIR(x)", () => {
    for (const name of Object.keys(CORPUS)) {
      const input = join(corpusDir, name);
      const viaCli = spawnSync("bun", ["run", pathOf("cli.ts"), "emit", input], { encoding: "utf8", timeout: 120_000 });
      expect(viaCli.status).toBe(0);
      expect(viaCli.stdout).toBe(sourceToIR(readFileSync(input, "utf8"), input));
    }
  }, 120_000);

  /**
   * Rung 3 for a LIBRARY module is weak by construction (caveat 3): a module that prints
   * nothing matches a bun run that prints nothing. Recorded here so that a future green
   * row cannot be read as behavioural evidence. When modules do reach rung 3, this test
   * is the reminder that per-module EXERCISE entries (import the module, do real work,
   * print a digest) are what turn rung 3 into a real behavioural differential.
   */
  test("no module is claiming a non-weak rung 3 (none has reached rung 3 at all)", async () => {
    const strong: string[] = [];
    for (const e of MODULES) {
      const m = await measure(e);
      if (m.rung === 3 && !m.weak) strong.push(e.file);
    }
    expect(strong).toEqual([]);
  }, 300_000);
});
