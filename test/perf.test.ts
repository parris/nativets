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
 * WHY THIS SHAPE HERE. CI runners for this repo are shared and heavily loaded. Measured
 * on this machine at load average ~600, the SAME `sourceToIR` call over 20 warm iterations
 * spread 230%-790% between its median and its max (primes.ts 0.67ms median / 5.40ms max).
 * A wall-clock assertion at any tolerance that would catch a real 2x regression would fire
 * constantly here, and a flaky gate gets deleted. So:
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
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

interface Baseline {
  note: string;
  ir: Record<string, IrStats>;
  link?: Record<string, LinkStats>;
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
    out[name] = irStats(sourceToIR(readFileSync(join(EXAMPLES, name), "utf8")));
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
export interface LinkStats {
  bytes: number;
  /** Live heap values at exit: arrays, objects, RC'd strings, persistent-vector nodes. */
  arrLive: number;
  objLive: number;
  strLive: number;
  pvNodes: number;
  /** CUMULATIVE persistent-vector node allocations — total work, not residue. */
  pvAllocs: number;
}

const LINK_THRESHOLD_PCT = 15;

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
        bytes: statSync(bin).size,
        arrLive: arrLive!, objLive: objLive!, strLive: strLive!, pvNodes: pvNodes!, pvAllocs: pvAllocs!,
      };
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
const baseline = loadBaseline();

describe("perf: baseline regeneration", () => {
  test.skipIf(!UPDATE)("writes the measured metrics to the baseline", () => {
    saveBaseline({
      note:
        "nativets performance baseline — DETERMINISTIC metrics only (see test/perf.test.ts for the methodology and the reference projects it came from). " +
        "Regenerate with NATIVETS_PERF_UPDATE=1 bun test test/perf.test.ts, and review the diff: an unexplained jump is the regression this file exists to catch.",
      ir: measured,
      link: measuredLink,
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

  // A metric whose baseline is missing must FAIL, not silently pass: a gate that can
  // quietly stop measuring is worse than no gate, because it still looks green.
  test("the baseline covers every link-corpus program", () => {
    expect(
      LINK_CORPUS.filter((n) => baseline?.link?.[n] === undefined),
      `Link-corpus programs missing from the baseline. ${REGEN}`,
    ).toEqual([]);
  });

  test("binary size is within the significance threshold", () => {
    if (!baseline?.link) return;
    const before: Record<string, number> = {};
    for (const [k, v] of Object.entries(baseline.link)) before[k] = v.bytes;
    const after: Record<string, number> = {};
    for (const [k, v] of Object.entries(measuredLink)) after[k] = v.bytes;
    reportAndAssert(compareMetric("binBytes", before, after, LINK_THRESHOLD_PCT), LINK_THRESHOLD_PCT);
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
    if (!baseline?.link) return;
    const diffs: string[] = [];
    for (const name of LINK_CORPUS) {
      const b = baseline.link[name];
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
        `structural-sharing fast path:\n${diffs.join("\n")}\n\n  If intended: ${REGEN}`,
    ).toEqual([]);
  });

  test("the baseline records counters for every link-corpus program", () => {
    expect(
      LINK_CORPUS.filter((n) => baseline?.link?.[n]?.strLive === undefined),
      `Link-corpus programs missing counter data in the baseline. ${REGEN}`,
    ).toEqual([]);
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
