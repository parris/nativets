/*
 * Performance regression gate.
 *
 * METHODOLOGY — copied from compilers that already solved this, not invented here:
 *
 *  - **rustc-perf** benchmarks rustc on every merge and gates PRs on it. Its default
 *    metric is `instructions:u`, NOT wall time, for one stated reason: "Instructions is
 *    the default because it has the least variation" (collector/README.md). It runs 3
 *    iterations and keeps the MINIMUM, and a result only counts as a regression if it is
 *    an outlier against the historical series (IQR fencing: `> Q3 + 3*IQR`), then buckets
 *    the change into magnitudes (very small … very large) to decide whether to report.
 *    Lesson taken: pick a metric with ~zero variance; express the gate as a percentage
 *    delta with an explicit significance threshold; classify magnitude so a developer can
 *    see drift building up before it trips.
 *
 *  - **TypeScript** benchmarks `tsc` in a separate `microsoft/typescript-benchmarking`
 *    repo via `ts-perf`, on dedicated hardware, over fixed real-world scenarios
 *    (`cases/scenarios/vscode`, `Compiler-Unions`, `self-compiler`). Alongside times it
 *    reports `--extendedDiagnostics` COUNTS — Types, Instantiations, Symbols, Memory —
 *    and those counts are what reviewers actually argue about, because timings under a
 *    second are not reproducible. Lesson taken: the durable signal is a count of work the
 *    compiler did, and the benchmark corpus should be real programs, checked in.
 *
 *  - **Bun** keeps `bench/` (mitata) with comparative micro-benchmarks against node/deno.
 *    It PRINTS a table (avg/min/max, ratio vs the fastest); nothing in CI fails on it.
 *    Lesson taken: wall clock belongs in a report, not an assertion.
 *
 *  - **Erlang/OTP** `estone_SUITE` runs ~20 weighted micros with FIXED loop counts, sums
 *    them into one normalised score (ESTONES, via `?STONEFACTOR`), and emits it as a
 *    `benchmark_data` ct_event for a dashboard to trend — the test itself passes as long
 *    as it completes inside its `timetrap`. Lesson taken: fixed work per benchmark (so
 *    runs are comparable), a composite tracked number, and a timeout as the only hard
 *    time-based assertion.
 *
 * WHY THIS SHAPE HERE. CI runners for this repo are shared and loaded. The SAME
 * `sourceToIR` call, 20 warm iterations, measured TWICE — once while the machine was
 * contaminated by orphaned spinner processes (load average ~600) and again after they
 * were reaped (load ~4.8):
 *
 *                   max/median @ load 596     max/median @ load 4.8
 *     primes.ts            +705%                     +114%
 *     matrix.ts            +520%                     +124%
 *     maze.ts              +230%                      +37%
 *     tictactoe.ts         +423%                     +258%
 *     infixcalc.ts         +792%                      +75%
 *
 * Both columns are reported deliberately. The first set is what a contaminated box does;
 * the second is this project's REALISTIC floor. A tolerance loose enough to survive even
 * the quiet column (+258%) is far too loose to catch a real 2x (+100%) regression, so
 * wall clock fails as a gate on a good day, never mind a bad one — and a gate that can go
 * red because someone left a spinner running is a gate that gets deleted. So:
 *
 *   GATED  (deterministic): emitted-IR instruction/function count per program.
 *   GATED  (deterministic): compiled binary size.
 *   GATED  (deterministic): runtime allocation counters (__arrLive/__objLive/__strLive/…).
 *   REPORT (noisy):         compile wall clock, min & median of N, printed, never asserted.
 *
 * Baselines live in `test/corpus/perf_baseline.json` so a regression is a reviewable diff,
 * like the other corpora. Regenerate with:
 *
 *     NATIVETS_PERF_UPDATE=1 bun test test/perf.test.ts
 *
 * and READ the diff — an intentional +3% from a new feature is fine, an unexplained +40%
 * is the bug this file exists to catch.
 *
 * OPERATIONAL NOTES.
 *  - The baseline measures the CORPUS as well as the compiler, so editing an
 *    `examples/*.ts` program legitimately moves its numbers. Regenerate, and check the
 *    diff only touches the program you edited.
 *  - After merging parallel lanes, regenerate ONCE at the end of the round, not per
 *    merge — the same rule CLAUDE.md already gives for the IR snapshots.
 *  - This is a REGRESSION gate, not a benchmark: it answers "did this change make things
 *    worse", not "how fast are we". Nothing here measures a compiled program's runtime
 *    speed (see the limits noted on each metric).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, loadavg, cpus } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceToIR, buildBinary } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "examples");
const BASELINE = join(HERE, "corpus", "perf_baseline.json");
const UPDATE = !!process.env.NATIVETS_PERF_UPDATE;

/* ============================================================
 * The corpus.
 *
 * Real programs already in the repo (`examples/`), like TypeScript's `cases/scenarios`
 * — a synthetic micro-benchmark tells you about the micro-benchmark. Every entry is a
 * self-contained app that terminates on its own with no stdin/argv/network, so the work
 * per run is FIXED (estone's rule) and the counts are comparable across runs.
 * ============================================================ */

/** Compile-only corpus: no toolchain, no execution — pure `source -> IR`. Cheap, so it is wide. */
const IR_CORPUS = [
  "base64.ts", "brainfuck.ts", "calculator.ts", "csv.ts", "diff.ts", "infixcalc.ts",
  "jobs.ts", "json-pretty.ts", "life.ts", "markdown.ts", "matrix.ts", "maze.ts",
  "primes.ts", "roman.ts", "router.ts", "rpn.ts", "rule110.ts", "stackvm.ts",
  "sudoku.ts", "tictactoe.ts", "todo.ts", "units.ts", "vigenere.ts", "wordfreq.ts",
];

/**
 * Link-and-run corpus: a narrower slice, because each entry invokes `clang` and then
 * executes the binary. Chosen to span the runtime surfaces that a regression would most
 * plausibly bloat — persistent-vector arrays, dense array churn, objects, strings, and
 * the Map/Set (HAMT) path — rather than to be exhaustive.
 */
const LINK_CORPUS = [
  "primes.ts",     // numeric + persistent-vector node allocation
  "matrix.ts",     // nested number[] work
  "sudoku.ts",     // heavy array allocation churn (backtracking)
  "life.ts",       // long-lived grid + string building
  "maze.ts",       // objects + strings + BFS
  "wordfreq.ts",   // Map/Set (HAMT) + objects
  "stackvm.ts",    // string-heavy interpreter loop
  "json-pretty.ts", // objects + JSON
];

/* ============================================================
 * ANCHORS — the two places this project has a MEASURED before/after from a real fix.
 *
 * The corpus above answers "did anything drift". These two answer "is the specific win
 * we already paid for still there", which is a sharper question and the one a regression
 * gate is actually for. Both come from Stage 44 (B2 step 4, transients + refcounting).
 *
 * Why these are not duplicates of the existing suite: `test/sharing.test.ts` already pins
 * the path-copy node costs exactly (`"2 2 3 4"`) and `test/transients.test.ts` pins the
 * 10k loop-append at `0 0 0`. What is NOT covered anywhere is (a) **peak RSS**, the metric
 * the original 87.9 MB -> 5.3 MB result was stated in, and (b) the **200k scale**, 20x
 * beyond the largest existing case. Those are the new signal; the node costs are carried
 * here too, but as BASELINE DATA rather than a second hardcoded string, so a change shows
 * up as a reviewable diff instead of an edited assertion.
 * ============================================================ */

/** Builds an n-element array by immutable loop-append — the transient fast path. */
const BUILD_HELPER = `
function build(n: number): number[] {
  let a: number[] = [];
  for (let i = 0; i < n; i = i + 1) { a = [...a, i]; }
  return a;
}`;

/** An n-element array built WITHOUT loop reassignment: a flat block the first `.with` freezes. */
const BIG_HELPER = `
function big(n: number): number[] {
  return "x".repeat(n).split("").map((c: string) => 1);
}`;

interface Anchor {
  name: string;
  what: string;
  source: string;
  /** Exact expected stdout of the counter line, when the anchor asserts one directly. */
  measuresRss: boolean;
}

const ANCHORS: Anchor[] = [
  {
    name: "append-200k",
    what:
      "200k immutable loop-appends. Before Stage 44 this peaked at 87.9 MB with 200001 " +
      "abandoned handles and 217660 trie-node allocations; after, 5.3 MB and 0/0/0. The " +
      "consuming append (nt_arr_extend_own) is only reachable because ownership proves the " +
      "old value dead, so losing it silently is exactly the regression worth a sentinel.",
    source: `${BUILD_HELPER}
function work(): number { const t: number[] = build(200000); return t[199999]; }
console.log(work());
console.log("__nt_perf", __arrLive(), __objLive(), __strLive(), __pvNodes(), __pvAllocs());`,
    measuresRss: true,
  },
  {
    name: "with-path-copy",
    what:
      "Structural sharing: nodes allocated by ONE `.with` at n=100/1000/2000/40000 " +
      "(shift/5+1 — path copying, not a full copy), then the O(1) leading-spread append. " +
      "Exact integers straight out of __pvAllocs(), so zero noise.",
    source: `${BIG_HELPER}
function upd(n: number): number {
  const a: number[] = big(n);
  const v1: number[] = a.with(0, 5);   // freezes: one-time O(n) build
  const before: number = __pvAllocs();
  const v2: number[] = v1.with(1, 6);  // path copy only
  const cost: number = __pvAllocs() - before;
  return cost + 0 * (v2[1] + a[0]);
}
const c1: number = upd(100);
const c2: number = upd(1000);
const c3: number = upd(2000);
const c4: number = upd(40000);
const a2: number[] = big(2000);
const f: number[] = [...a2, 1];
const b2: number = __pvAllocs();
const g: number[] = [...f, 2];
const appendCost: number = __pvAllocs() - b2;
console.log("__nt_anchor", c1, c2, c3, c4, appendCost, g.length);`,
    measuresRss: false,
  },
];

/**
 * Peak RSS of a child process.
 *
 * Measured, not assumed, and measured on BOTH a contaminated and a quiet machine: 8 runs
 * of the 200k anchor spread **1.24%** at load average ~300 (5.03-5.09 MB) and **0.62%**
 * at load ~4.8 (5.03-5.06 MB) — against 230-790% / 37-258% for wall clock on the same
 * box. Load barely moves it, which is the entire argument for gating RSS and not time.
 * (The 1.24% figure is the one the fence is sized against: CI is the loaded case.)
 * It is still allocator- and page-size-dependent, so
 * it is keyed by platform like binary size, and its fence is wide (25%): the regression it
 * exists to catch is 5.3 MB -> 87.9 MB, a 16x jump, not a few percent.
 *
 * There is no portable libc-free way to read a child's peak RSS from JS, so this shells
 * out to `/usr/bin/time`: `-l` on macOS reports BYTES, GNU `-f %M` on Linux reports KB.
 * Returns null when neither is available, and the caller then reports that it is not
 * measuring rather than passing quietly.
 */
export function peakRssBytes(bin: string): { rss: number | null; stdout: string; exitCode: number } {
  if (process.platform === "darwin") {
    const p = spawnSync("/usr/bin/time", ["-l", bin], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
    const m = (p.stderr ?? "").match(/(\d+)\s+maximum resident set size/);
    return { rss: m ? Number(m[1]) : null, stdout: p.stdout ?? "", exitCode: p.status ?? -1 };
  }
  // GNU time: %M is peak RSS in kilobytes.
  const p = spawnSync("/usr/bin/time", ["-f", "%M", bin], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  const m = (p.stderr ?? "").trim().split("\n").pop()?.match(/^(\d+)$/);
  return { rss: m ? Number(m[1]) * 1024 : null, stdout: p.stdout ?? "", exitCode: p.status ?? -1 };
}

/** Peak RSS is near-deterministic but not exact; this catches step changes, not percent. */
const RSS_THRESHOLD_PCT = 25;

/* ============================================================
 * Metrics.
 * ============================================================ */

export interface IrStats { instrs: number; funcs: number; bytes: number }

/**
 * Count emitted LLVM IR — our stand-in for rustc-perf's `instructions:u` and
 * TypeScript's Instantiations count. It is a pure function of (source, compiler), so
 * it has EXACTLY zero run-to-run variance; every difference is a real change we made.
 *
 * `instrs` counts instruction lines only: no blanks, comments, labels, `declare`s,
 * globals, or braces — so adding a runtime `declare` or a string constant does not
 * masquerade as generated-code growth.
 */
export function irStats(ir: string): IrStats {
  let instrs = 0;
  let funcs = 0;
  for (const raw of ir.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith(";")) continue;
    if (l.startsWith("define ")) { funcs++; continue; }
    if (l.startsWith("declare ") || l.startsWith("@") || l.startsWith("target ")) continue;
    if (l === "}" || l === "{") continue;
    if (/^[A-Za-z0-9._$-]+:/.test(l)) continue; // basic-block label
    instrs++;
  }
  return { instrs, funcs, bytes: ir.length };
}

/* ============================================================
 * Comparison — rustc-perf's model, minus the history it cannot have here.
 *
 * rustc-perf decides significance from the VARIANCE of a metric's historical series
 * (IQR fencing). We have no series database, but we also have no variance: these metrics
 * are exactly reproducible, so "is it noise?" is not the question. The question is only
 * "is it big enough to demand an explanation?", which is rustc-perf's *magnitude* half.
 * So: a fixed per-metric significance threshold, and magnitude buckets relative to it.
 * ============================================================ */

/** Per-metric significance thresholds, in percent. Exceeding one fails the test. */
const THRESHOLD_PCT = {
  irInstrs: 10,
  irFuncs: 10,
  irBytes: 12, // text bytes move on cosmetic emit changes too; a looser fence
} as const;

export type Magnitude = "very small" | "small" | "medium" | "large" | "very large";

/** rustc-perf-style bucketing: how far past the significance threshold a change went. */
export function magnitude(deltaPct: number, thresholdPct: number): Magnitude {
  const over = Math.abs(deltaPct) / thresholdPct;
  if (over < 0.25) return "very small";
  if (over < 0.5) return "small";
  if (over < 1) return "medium";
  if (over < 2) return "large";
  return "very large";
}

export interface Change { name: string; metric: string; before: number; after: number; deltaPct: number; magnitude: Magnitude; significant: boolean }

/** Compare one metric across the corpus and classify every non-zero change. */
export function compareMetric(
  metric: string,
  before: Record<string, number>,
  after: Record<string, number>,
  thresholdPct: number,
): Change[] {
  const out: Change[] = [];
  for (const name of Object.keys(after)) {
    const b = before[name];
    if (b === undefined) continue; // new benchmark: nothing to compare against
    const a = after[name]!;
    if (a === b) continue;
    const deltaPct = b === 0 ? (a === 0 ? 0 : Infinity) : (100 * (a - b)) / b;
    out.push({
      name, metric, before: b, after: a, deltaPct,
      magnitude: magnitude(deltaPct, thresholdPct),
      significant: Math.abs(deltaPct) > thresholdPct,
    });
  }
  return out.sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct));
}

/**
 * Corpus-wide totals, with a TIGHTER fence than any single program.
 *
 * rustc-perf's relevance rule: "a large number of small or very small changes" is high
 * relevance even when no individual benchmark is dramatic. That case is exactly what a
 * per-benchmark threshold misses — a change that adds ~9% of IR to all 24 programs is a
 * serious codegen regression, but every program passes a 10% fence individually. This was
 * observed for real while validating this file: a one-instruction-per-store perturbation
 * moved `irBytes` +3%..+13% across the corpus and tripped only 1 of 24 per-program fences.
 * The aggregate catches it. A narrow, genuinely-local change moves the total by well under
 * this, because it is diluted across the whole corpus.
 */
const AGGREGATE_THRESHOLD_PCT = 3;

export function total(m: Record<string, number>): number {
  return Object.values(m).reduce((a, b) => a + b, 0);
}

/** The developer-facing report. Mirrors perf.rust-lang.org's compare table. */
export function renderChanges(changes: Change[], thresholdPct: number): string {
  if (changes.length === 0) return "  (no changes)";
  const rows = changes.map((c) => {
    const dir = c.deltaPct > 0 ? "regression" : "improvement";
    const pct = Number.isFinite(c.deltaPct) ? `${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(2)}%` : "new";
    return `  ${c.significant ? "!!" : "  "} ${c.name.padEnd(18)} ${c.metric.padEnd(9)} ${String(c.before).padStart(7)} -> ${String(c.after).padStart(7)}  ${pct.padStart(9)}  ${dir}, ${c.magnitude}`;
  });
  return [
    ...rows,
    ``,
    `  significance threshold: ${thresholdPct}%   ("!!" = past the threshold)`,
  ].join("\n");
}

/* ============================================================
 * Baseline I/O — a checked-in JSON corpus, like test/corpus/cases.json.
 * ============================================================ */

/**
 * Which metrics are platform-independent, and which are not — the difference decides
 * whether one checked-in number can gate every CI runner.
 *
 * CI here is a macOS + Linux matrix (`.github/workflows/ci.yml`). IR text and allocation
 * counts are pure functions of the program: same source, same compiler, same numbers on
 * every host. **Binary size is not** — Mach-O and ELF are not comparable at all, and even
 * two clang versions on one OS differ — so a single checked-in size would fail on Linux
 * every single time, which is precisely how a gate earns its way into being deleted.
 * Sizes are therefore keyed by platform, and a platform with no recorded baseline reports
 * loudly that it is not measuring rather than passing quietly.
 */
const PLATFORM = `${process.platform}-${process.arch}`;

interface Baseline {
  note: string;
  ir: Record<string, IrStats>;
  /** Platform-independent: allocation counts are facts about the program, not the host. */
  alloc?: Record<string, AllocStats>;
  /** Platform-DEPENDENT: keyed by `${process.platform}-${process.arch}`. */
  binarySize?: Record<string, Record<string, number>>;
  /** `__text` section bytes — the quantization-free code-size metric the gate uses. */
  textSize?: Record<string, Record<string, number>>;
  /** Anchor probe lines — platform-independent exact strings. */
  anchors?: Record<string, string>;
  /** Anchor peak RSS, platform-keyed (allocator + page size differ). */
  anchorRss?: Record<string, Record<string, number>>;
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE)) return null;
  return JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
}

function saveBaseline(b: Baseline): void {
  writeFileSync(BASELINE, `${JSON.stringify(b, null, 2)}\n`);
}

const REGEN = `Run  NATIVETS_PERF_UPDATE=1 bun test test/perf.test.ts  to accept, and review the diff.`;

/* ============================================================
 * Measurement.
 * ============================================================ */

function measureIR(): Record<string, IrStats> {
  const out: Record<string, IrStats> = {};
  for (const name of IR_CORPUS) {
    try {
      out[name] = irStats(sourceToIR(readFileSync(join(EXAMPLES, name), "utf8")));
    } catch (e) {
      // Legibility: this runs at module load, so a bare throw here would surface as an
      // unattributed file-level error. Say which program and that it is a CORRECTNESS
      // failure (examples.test.ts owns that), not a performance one.
      throw new Error(
        `perf corpus: examples/${name} no longer compiles, so it cannot be measured.\n` +
          `This is a correctness regression (see test/examples.test.ts), not a perf one.\n` +
          `Underlying error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      );
    }
  }
  return out;
}

/**
 * Compiled binary size.
 *
 * Deterministic for a fixed toolchain (verified: two builds of the same source produce
 * byte-identical sizes for all 8 corpus programs), but NOT across clang versions, and CI
 * may not run the clang this baseline was taken with. So its fence is deliberately loose:
 * it exists to catch step changes — "we started linking nt_actor.c / raylib into every
 * program", which is a >15% jump — not to police kilobytes.
 */
/** Live heap values at exit, plus cumulative trie-node allocations. */
export interface AllocStats {
  arrLive: number;
  objLive: number;
  strLive: number;
  pvNodes: number;
  /** CUMULATIVE persistent-vector node allocations — total work, not residue. */
  pvAllocs: number;
}

export interface LinkStats extends AllocStats { bytes: number; textBytes: number }

/**
 * The size of the emitted CODE, free of page quantization.
 *
 * The on-disk file size (`bytes`) cannot gate code size: the linker rounds `__TEXT` to a
 * 16,384-byte page on macOS, so it under-reports real growth by ~5x inside a page and
 * over-reports by ~25x at a boundary. Both were measured — 660 bytes of real code produced
 * a +16,640 on-disk jump, and 11,800 bytes of real growth showed as +2,416 on disk.
 *
 * THROWS rather than falling back to the file size when `size` is unavailable. A gate that
 * quietly degrades to an unreliable metric is worse than one that fails: it keeps reporting
 * green while measuring something else, which is the failure this repo keeps re-learning.
 */
function textSectionBytes(bin: string): number {
  const mach = spawnSync("size", ["-m", bin], { encoding: "utf8" });
  if (mach.status === 0) {
    const m = /Section __text:\s*(\d+)/.exec(mach.stdout ?? "");
    if (m) return Number(m[1]);
  }
  const elf = spawnSync("size", ["-A", bin], { encoding: "utf8" });
  if (elf.status === 0) {
    const m = /^\.text\s+(\d+)/m.exec(elf.stdout ?? "");
    if (m) return Number(m[1]);
  }
  throw new Error(
    `could not read the __text section of ${bin} via \`size\` (tried -m for Mach-O and -A for ELF). ` +
      `Code size cannot be gated on the on-disk file size — it is page-quantized. Install binutils/cctools.`,
  );
}

const LINK_THRESHOLD_PCT = 15;
/** `__text` is exact, so it does not need the slack a page-quantized metric does. */
const TEXT_THRESHOLD_PCT = 3;

/**
 * The runtime-counter probe.
 *
 * Appended to each corpus program, so the counters are read after the program's own
 * top-level work (including its scope-exit drops) has finished. These builtins are
 * nativets-only debug hooks, which is fine: this file is not differential-tested, and
 * they are the same hooks `test/drops*.test.ts` and `test/str-rc.test.ts` already assert
 * on. `__pvAllocs` is CUMULATIVE (total trie nodes ever allocated), so it is a genuine
 * measure of work done — the closest thing here to TypeScript's Instantiations count.
 * The `*Live` counters are residue, and so are a sharp leak-regression detector: Stage 44
 * drove several of these to 0, and this pins them there.
 */
const COUNTER_PROBE =
  '\nconsole.log("__nt_perf", __arrLive(), __objLive(), __strLive(), __pvNodes(), __pvAllocs());\n';

/** Allocation counters are integer facts about the program, so they must match EXACTLY. */
const COUNTER_KEYS = ["arrLive", "objLive", "strLive", "pvNodes", "pvAllocs"] as const;

async function measureLink(): Promise<Record<string, LinkStats>> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-perf-"));
  try {
    const out: Record<string, LinkStats> = {};
    for (const name of LINK_CORPUS) {
      const src = readFileSync(join(EXAMPLES, name), "utf8");

      // Size is measured on the UNMODIFIED program: that is the artifact a user ships.
      const bin = join(dir, `${name}.bin`);
      await buildBinary(src, bin, { target: "host" });

      // Counters need the probe, so they get their own build.
      const probed = join(dir, `${name}.probe`);
      await buildBinary(src + COUNTER_PROBE, probed, { target: "host" });
      const proc = spawnSync(probed, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
      const line = (proc.stdout ?? "").split("\n").filter((l) => l.startsWith("__nt_perf")).pop();
      if (!line) throw new Error(`${name}: probe produced no counter line (exit ${proc.status})`);
      const [, arrLive, objLive, strLive, pvNodes, pvAllocs] = line.split(" ").map(Number) as number[];

      out[name] = {
        // ON-DISK SIZE IS PAGE-QUANTIZED, and both failure directions are live. The linker
        // rounds `__TEXT` to a 16,384-byte page on macOS, so this number moves in ~16KB
        // steps regardless of how much code actually changed:
        //   - a ~1.1KB change reports as ~+17KB and trips the 15% gate (measured: the
        //     checked-`as` lane's `__text` grew 107,468 -> 108,596 while the `__TEXT`
        //     SEGMENT grew exactly 16,384 and on-disk grew 16,640);
        //   - and the dangerous direction: a genuine ~15KB regression that lands inside an
        //     already-allocated page reports as FREE.
        // The trap is that quantization LOOKS like corroboration — "nearly identical
        // +17,776..+17,952 across eight unrelated programs" reads as a fixed runtime cost,
        // which is exactly the wrong conclusion. The constant is the page size, not a cost.
        // The quantization-free number is `textBytes` below, which is what the gate uses;
        // this one is kept INFORMATIONAL so a page step is still visible when explaining a
        // build, and never asserted on.
        bytes: statSync(bin).size,
        textBytes: textSectionBytes(bin),
        arrLive: arrLive!, objLive: objLive!, strLive: strLive!, pvNodes: pvNodes!, pvAllocs: pvAllocs!,
      };
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface AnchorStats {
  /** The anchor program's own counter/probe line — exact, zero noise. */
  line: string;
  /** Peak RSS in bytes, or null when this anchor does not measure it / it is unavailable. */
  rssBytes: number | null;
}

async function measureAnchors(): Promise<Record<string, AnchorStats>> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-anchor-"));
  try {
    const out: Record<string, AnchorStats> = {};
    for (const a of ANCHORS) {
      const bin = join(dir, a.name);
      await buildBinary(a.source, bin, { target: "host" });
      const r = peakRssBytes(bin);
      if (r.exitCode !== 0) throw new Error(`anchor ${a.name}: exited ${r.exitCode}`);
      const line = r.stdout.split("\n").filter((l) => l.startsWith("__nt_")).pop();
      if (!line) throw new Error(`anchor ${a.name}: produced no probe line`);
      out[a.name] = { line, rssBytes: a.measuresRss ? r.rss : null };
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ============================================================
 * The gate.
 * ============================================================ */

const measured = measureIR();
const measuredLink = await measureLink();
const measuredAnchors = await measureAnchors();
const baseline = loadBaseline();

describe("perf: baseline regeneration", () => {
  test.skipIf(!UPDATE)("writes the measured metrics to the baseline", () => {
    const alloc: Record<string, AllocStats> = {};
    const sizes: Record<string, number> = {};
    const textSizes: Record<string, number> = {};
    for (const [name, s] of Object.entries(measuredLink)) {
      alloc[name] = { arrLive: s.arrLive, objLive: s.objLive, strLive: s.strLive, pvNodes: s.pvNodes, pvAllocs: s.pvAllocs };
      sizes[name] = s.bytes;
      textSizes[name] = s.textBytes;
    }
    saveBaseline({
      note:
        "nativets performance baseline — DETERMINISTIC metrics only (see test/perf.test.ts for the methodology and the reference projects it came from). " +
        "Regenerate with NATIVETS_PERF_UPDATE=1 bun test test/perf.test.ts, and review the diff: an unexplained jump is the regression this file exists to catch.",
      ir: measured,
      alloc,
      // MERGE, never clobber: regenerating on macOS must not delete the Linux runner's
      // recorded sizes (and vice versa) — that would silently disarm the gate there.
      binarySize: { ...(baseline?.binarySize ?? {}), [PLATFORM]: sizes },
      textSize: { ...(baseline?.textSize ?? {}), [PLATFORM]: textSizes },
      anchors: Object.fromEntries(Object.entries(measuredAnchors).map(([k, v]) => [k, v.line])),
      anchorRss: {
        ...(baseline?.anchorRss ?? {}),
        [PLATFORM]: Object.fromEntries(
          Object.entries(measuredAnchors)
            .filter(([, v]) => v.rssBytes !== null)
            .map(([k, v]) => [k, v.rssBytes!]),
        ),
      },
    });
    if (baseline) {
      const ch = compareMetric("irInstrs", mapOf(baseline.ir, "instrs"), mapOf(measured, "instrs"), THRESHOLD_PCT.irInstrs);
      console.log(`\nperf baseline updated. IR instruction changes:\n${renderChanges(ch, THRESHOLD_PCT.irInstrs)}\n`);
    }
    expect(existsSync(BASELINE)).toBe(true);
  });
});

describe.skipIf(UPDATE)("perf: emitted IR size (deterministic)", () => {
  test("a baseline exists", () => {
    expect(baseline, `No perf baseline at ${BASELINE}. ${REGEN}`).not.toBeNull();
  });

  test("every corpus program still compiles to IR", () => {
    for (const name of IR_CORPUS) expect(measured[name]!.instrs).toBeGreaterThan(0);
  });

  test("IR instruction count is within the significance threshold", () => {
    if (!baseline) return;
    const ch = compareMetric("irInstrs", mapOf(baseline.ir, "instrs"), mapOf(measured, "instrs"), THRESHOLD_PCT.irInstrs);
    reportAndAssert(ch, THRESHOLD_PCT.irInstrs);
  });

  test("emitted function count is within the significance threshold", () => {
    if (!baseline) return;
    const ch = compareMetric("irFuncs", mapOf(baseline.ir, "funcs"), mapOf(measured, "funcs"), THRESHOLD_PCT.irFuncs);
    reportAndAssert(ch, THRESHOLD_PCT.irFuncs);
  });

  test("IR text size is within the significance threshold", () => {
    if (!baseline) return;
    const ch = compareMetric("irBytes", mapOf(baseline.ir, "bytes"), mapOf(measured, "bytes"), THRESHOLD_PCT.irBytes);
    reportAndAssert(ch, THRESHOLD_PCT.irBytes);
  });

  test("corpus-wide IR totals are within the aggregate threshold", () => {
    if (!baseline) return;
    const over: string[] = [];
    const lines: string[] = [];
    for (const key of ["instrs", "funcs", "bytes"] as const) {
      const b = total(mapOf(baseline.ir, key));
      const a = total(mapOf(measured, key));
      const pct = b === 0 ? 0 : (100 * (a - b)) / b;
      lines.push(`  ${key.padEnd(7)} ${String(b).padStart(8)} -> ${String(a).padStart(8)}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
      if (Math.abs(pct) > AGGREGATE_THRESHOLD_PCT) over.push(`${key} ${pct.toFixed(2)}%`);
    }
    expect(
      over,
      `Corpus-wide IR total moved past ${AGGREGATE_THRESHOLD_PCT}% — a broad codegen change,\n` +
        `even if no single program crossed its own threshold:\n${lines.join("\n")}\n\n  If intended: ${REGEN}`,
    ).toEqual([]);
  });
});

describe.skipIf(UPDATE)("perf: compiled binary size (deterministic per toolchain)", () => {
  test("every link-corpus program still builds", () => {
    for (const name of LINK_CORPUS) expect(measuredLink[name]!.bytes).toBeGreaterThan(0);
  });

  const textBaseline = baseline?.textSize?.[PLATFORM];
  const sizeBaseline = baseline?.binarySize?.[PLATFORM];

  /*
   * THE GATE IS `__text`, NOT THE FILE SIZE — and the reason is a measured failure of the
   * old gate, not a preference. The linker rounds `__TEXT` to a 16,384-byte page on macOS,
   * so on-disk size is wrong in BOTH directions:
   *
   *   660 bytes of real code  ->  +16,640 on disk   (over-reports ~25x, at a boundary)
   *   11,800 bytes of real code -> +2,416 on disk   (under-reports ~5x, inside a page)
   *
   * The over-report is noise and merely trips the gate; the UNDER-report is the dangerous
   * one, because a genuine ~15KB regression landing in page slack reads as nearly free.
   *
   * The trap that cost a round here: quantization LOOKS like corroboration. Eight unrelated
   * programs moving by "+17,776 to +17,952" reads as a fixed runtime cost and was recorded
   * as one; the constant was just the page size, and the real cost was ~1.1KB — sixteen
   * times smaller. A near-constant delta across unrelated inputs is evidence of an ARTIFACT
   * until something quantization-free says otherwise.
   */
  test("code size (__text) is within the significance threshold", () => {
    if (!textBaseline) {
      // Not a silent pass: say out loud that this platform is unmeasured, and how to fix it.
      console.log(
        `\n  perf: no __text baseline for platform "${PLATFORM}" — code size is NOT being gated here.\n` +
          `  Sizes are platform-specific (Mach-O vs ELF), so this is expected on a runner that\n` +
          `  has never recorded one. To start gating it here: ${REGEN}\n`,
      );
      return;
    }
    // Once a platform HAS a baseline, a program missing from it is a lost metric, not an
    // expected gap — fail rather than skip.
    expect(
      LINK_CORPUS.filter((n) => textBaseline[n] === undefined),
      `Programs missing from the "${PLATFORM}" __text baseline. ${REGEN}`,
    ).toEqual([]);

    const after: Record<string, number> = {};
    for (const [k, v] of Object.entries(measuredLink)) after[k] = v.textBytes;
    reportAndAssert(compareMetric("textBytes", textBaseline, after, TEXT_THRESHOLD_PCT), TEXT_THRESHOLD_PCT);
  });

  test("on-disk size is REPORTED, never asserted (it is page-quantized)", () => {
    if (!sizeBaseline) return;
    const after: Record<string, number> = {};
    for (const [k, v] of Object.entries(measuredLink)) after[k] = v.bytes;
    const changes = compareMetric("binBytes", sizeBaseline, after, LINK_THRESHOLD_PCT);
    const moved = changes.filter((c) => c.significant);
    if (moved.length) {
      console.log(
        `\n  perf: on-disk binary size moved (INFORMATIONAL — page-quantized, not a gate):\n` +
          `${renderChanges(changes, LINK_THRESHOLD_PCT)}\n` +
          `  Cross-check the __text gate above before concluding anything about code size.\n`,
      );
    }
    expect(true).toBe(true); // never asserts — see the block comment above
  });
});

describe.skipIf(UPDATE)("perf: runtime allocation counters (deterministic)", () => {
  /*
   * These are EXACT, unlike every metric above. An allocation count is an integer fact
   * about a fixed-work program, not a measurement — it has no units to be a few percent
   * off in. `arrLive`/`objLive`/`strLive` at exit are what the drop and RC passes are
   * supposed to drive to zero (Stages 9/23/30/44), so a change of +1 is exactly the leak
   * a percentage fence would hide. `pvAllocs` is cumulative work: Stage 44's transients
   * took 200k loop-appends from 217660 node allocations to 0, and nothing should quietly
   * put them back.
   */
  test("allocation counters match the baseline exactly", () => {
    if (!baseline?.alloc) return;
    const diffs: string[] = [];
    for (const name of LINK_CORPUS) {
      const b = baseline.alloc[name];
      const a = measuredLink[name]!;
      if (!b) continue;
      for (const key of COUNTER_KEYS) {
        if (b[key] === undefined) continue;
        if (a[key] !== b[key]) {
          const dir = a[key] > b[key] ? "regression" : "improvement";
          diffs.push(`  ${name.padEnd(16)} ${key.padEnd(9)} ${String(b[key]).padStart(7)} -> ${String(a[key]).padStart(7)}  (${dir})`);
        }
      }
    }
    expect(
      diffs,
      `Runtime allocation counts changed. These are exact integer facts about a\n` +
        `fixed-work program, so any change is real — a leak, a lost drop, or a lost\n` +
        `structural-sharing fast path.\n\n` +
        `NOTE: these are platform-INDEPENDENT by construction (they count our own\n` +
        `allocations, driven by deterministic programs). If this fires only on one OS,\n` +
        `that is a portability defect to investigate, NOT noise to widen the fence:\n` +
        `${diffs.join("\n")}\n\n  If intended: ${REGEN}`,
    ).toEqual([]);
  });

  test("the baseline records counters for every link-corpus program", () => {
    expect(
      LINK_CORPUS.filter((n) => baseline?.alloc?.[n]?.strLive === undefined),
      `Link-corpus programs missing counter data in the baseline. ${REGEN}`,
    ).toEqual([]);
  });
});

describe.skipIf(UPDATE)("perf: anchors (measured wins from real fixes)", () => {
  for (const a of ANCHORS) {
    describe(a.name, () => {
      test("the probe line is unchanged", () => {
        const before = baseline?.anchors?.[a.name];
        expect(before, `Anchor "${a.name}" missing from the baseline. ${REGEN}`).toBeDefined();
        if (before === undefined) return;
        expect(
          measuredAnchors[a.name]!.line,
          `Anchor "${a.name}" changed.\n\n  ${a.what}\n\n` +
            `  before: ${before}\n  after:  ${measuredAnchors[a.name]!.line}\n\n  If intended: ${REGEN}`,
        ).toBe(before);
      });

      test.skipIf(!a.measuresRss)("peak RSS is within the significance threshold", () => {
        const before = baseline?.anchorRss?.[PLATFORM]?.[a.name];
        const after = measuredAnchors[a.name]!.rssBytes;
        if (after === null) {
          console.log(`\n  perf: peak RSS unavailable here (/usr/bin/time not usable) — anchor "${a.name}" RSS NOT gated.\n`);
          return;
        }
        if (before === undefined) {
          console.log(
            `\n  perf: no peak-RSS baseline for platform "${PLATFORM}" — anchor "${a.name}" RSS NOT gated.\n` +
              `  RSS is allocator/page-size dependent, so this is expected on a new runner. To gate it: ${REGEN}\n`,
          );
          return;
        }
        const deltaPct = (100 * (after - before)) / before;
        const mb = (b: number) => (b / 1048576).toFixed(2);
        console.log(
          `\n  anchor ${a.name}: peak RSS ${mb(before)}MB -> ${mb(after)}MB ` +
            `(${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%, threshold ${RSS_THRESHOLD_PCT}%)\n`,
        );
        expect(
          Math.abs(deltaPct) <= RSS_THRESHOLD_PCT,
          `Peak RSS moved ${deltaPct.toFixed(2)}% (${mb(before)}MB -> ${mb(after)}MB), past ${RSS_THRESHOLD_PCT}%.\n\n` +
            `  ${a.what}\n\n` +
            `  RSS is near-deterministic here (measured 1.24% spread over 8 runs at load\n` +
            `  average ~300), so this is a real change, not load noise.\n\n  If intended: ${REGEN}`,
        ).toBe(true);
      });
    });
  }
});

/* ============================================================
 * Wall clock — REPORTED, never asserted.
 *
 * This is Bun's `bench/` posture (mitata prints a table; nothing in CI fails on it) and
 * estone's (a score emitted for a dashboard to trend; the suite passes as long as it
 * finishes inside its timetrap). rustc-perf collects wall time too, but its own docs say
 * instruction counts are the default *because they vary least* — and it runs on dedicated
 * hardware, which this repo does not have.
 *
 * The measured justification, taken on this machine at load average ~600 while five
 * agents shared it: over 20 warm iterations of the SAME `sourceToIR` call,
 *
 *     primes.ts     min 0.36ms   median 0.67ms   max 5.40ms    (max/median +705%)
 *     matrix.ts     min 1.16ms   median 3.29ms   max 20.37ms   (max/median +520%)
 *     maze.ts       min 1.06ms   median 1.25ms   max 4.14ms    (max/median +230%)
 *     tictactoe.ts  min 1.17ms   median 1.29ms   max 6.76ms    (max/median +423%)
 *     infixcalc.ts  min 1.21ms   median 1.48ms   max 13.23ms   (max/median +792%)
 *
 * Any tolerance loose enough to survive that (>8x) is far too loose to catch a real 2x
 * compile-time regression, so an assertion here would be theatre that fails randomly.
 * We print min and median — rustc-perf keeps the MINIMUM of its iterations for the same
 * reason: the minimum is the sample least contaminated by other load.
 * ============================================================ */

const TIMING_ITERATIONS = 7;

/**
 * Environment sanity — REPORTED, never enforced.
 *
 * This exists because of a real incident: 22 orphaned `while :; do :; done` shells were
 * reparented to init when the `kill %1 %2 …` meant to reap them silently missed, and they
 * burned ~50% CPU each for 14-18 hours, peaking the load average at 758. Nobody noticed
 * for the better part of a day. Every timing taken in that window was worthless and every
 * deterministic metric in this file was completely unaffected.
 *
 * So each timing report carries the load average it was taken under. A future reader
 * comparing two runs can then tell a real regression from a busy box instead of guessing,
 * and an absurd load is called out at the moment it would otherwise silently poison a
 * number. It is NOT a gate: the machine being busy is not the compiler's fault, and
 * failing here would reintroduce exactly the load-sensitive red this file avoids.
 */
export function environmentNote(): { line: string; suspect: boolean } {
  const [one, five, fifteen] = loadavg();
  const cores = cpus().length || 1;
  const perCore = one! / cores;
  const suspect = perCore > 2;
  return {
    line:
      `load average ${one!.toFixed(2)} / ${five!.toFixed(2)} / ${fifteen!.toFixed(2)} ` +
      `over ${cores} cores (${perCore.toFixed(2)} per core)` +
      (suspect ? "  <-- BUSY: treat every timing below as noise, not signal" : ""),
    suspect,
  };
}

export function minAndMedian(samples: number[]): { min: number; median: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { min: s[0]!, median: s[Math.floor(s.length / 2)]! };
}

describe.skipIf(UPDATE)("perf: compile wall clock (REPORT ONLY — never fails)", () => {
  test("reports compile time per program", () => {
    const envBefore = environmentNote();
    const rows: string[] = [];
    let totalMin = 0;
    for (const name of IR_CORPUS) {
      const src = readFileSync(join(EXAMPLES, name), "utf8");
      sourceToIR(src); // warm
      const samples: number[] = [];
      for (let i = 0; i < TIMING_ITERATIONS; i++) {
        const t0 = Bun.nanoseconds();
        sourceToIR(src);
        samples.push((Bun.nanoseconds() - t0) / 1e6);
      }
      const { min, median } = minAndMedian(samples);
      totalMin += min;
      rows.push(`  ${name.padEnd(18)} min ${min.toFixed(2).padStart(7)}ms   median ${median.toFixed(2).padStart(7)}ms   ${(measured[name]!.instrs / min).toFixed(0).padStart(6)} IR-instr/ms`);
    }
    const envAfter = environmentNote();
    console.log(
      `\ncompile wall clock (informational — NOT a gate; see the block comment for why):\n` +
        `  before: ${envBefore.line}\n  after:  ${envAfter.line}\n\n` +
        `${rows.join("\n")}\n  ${"corpus total (min)".padEnd(18)} ${totalMin.toFixed(1)}ms over ${IR_CORPUS.length} programs\n` +
        (envBefore.suspect || envAfter.suspect
          ? `\n  The machine was BUSY during this run. The deterministic gates above are\n` +
            `  unaffected (they survived a 130x load change unchanged); these timings are not.\n`
          : ""),
    );
    // NOT ASSERTED ON TIME — not even a generous "must finish" bound. A perf test that
    // *can* go red under load gets ignored and then deleted, at which point it is worse
    // than nothing, so nothing here is allowed to fail on a clock. estone's timetrap
    // already exists for free: bun's own per-test timeout (`--timeout 60000` in CI) kills
    // a genuine hang without this file owning a threshold that load can trip.
    // The assertion is the deterministic one: every program was actually measured.
    expect(rows.length).toBe(IR_CORPUS.length);
  });
});

function mapOf<K extends keyof IrStats>(stats: Record<string, IrStats>, key: K): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) out[k] = v[key];
  return out;
}

/** Print every change (drift is information), fail only on significant ones. */
function reportAndAssert(changes: Change[], thresholdPct: number): void {
  const significant = changes.filter((c) => c.significant);
  if (changes.length > 0) {
    console.log(`\n${significant.length ? "SIGNIFICANT " : ""}perf changes:\n${renderChanges(changes, thresholdPct)}\n`);
  }
  expect(
    significant.map((c) => `${c.name} ${c.metric} ${c.before}->${c.after}`),
    `Significant performance change.\n${renderChanges(changes, thresholdPct)}\n\n  If intended: ${REGEN}`,
  ).toEqual([]);
}
