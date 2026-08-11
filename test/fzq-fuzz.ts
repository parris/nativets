/*
 * fzq — the node-differential fuzz driver (lane-fuzz).
 *
 * NOT a `.test.ts`: this is the search tool. Findings it turns up get pinned as ordinary
 * cases in `test/fuzz-diff.test.ts`. Run it directly:
 *
 *     bun run test/fzq-fuzz.ts one <file.ts>     # one program, raw-byte diff vs node
 *     bun run test/fzq-fuzz.ts sweep <family> [n]
 *
 * TWO deliberate departures from `test/harness.ts`:
 *
 * 1. **Buffers, not strings.** `harness.ts` decodes stdout as utf8. The worst defect found
 *    in this repo to date printed RAW HEAP BYTES that are not valid UTF-8 at exit 0, and a
 *    utf8-decoding compare turns those into U+FFFD on BOTH sides and reports a match. We
 *    compare `Buffer`s and separately assert decodability.
 *
 * 2. **Batching.** A compile+run is ~100 ms warm and ~2.2 s cold, so one case per program
 *    caps a sweep at a few thousand. Instead N independent cases go into ONE program, one
 *    `console.log` each, and the outputs are compared line-for-line — 100x more values per
 *    unit time, which is the whole point (the defect shape being hunted is narrow in VALUES,
 *    not in features). A batch that refuses to compile is BISECTED down to the offending
 *    case, which is then reported as a refusal and dropped rather than failing the sweep.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary, sourceToIR } from "../src/driver.ts";

export interface RawResult { stdout: Buffer; stderr: Buffer; exitCode: number; signal: string | null }
export type OurResult = RawResult | { refused: string };

const BOUNDED = { timeout: 60_000, killSignal: "SIGKILL" } as const;

export function isRefusal(r: OurResult): r is { refused: string } {
  return (r as { refused?: string }).refused !== undefined;
}

/** Compile and run under nativets, capturing RAW bytes. A compile refusal is a value, not a throw. */
export async function ourRun(source: string): Promise<OurResult> {
  const dir = mkdtempSync(join(tmpdir(), "fzq-run-"));
  try {
    const bin = join(dir, "prog");
    try {
      await buildBinary(source, bin, { target: "host" });
    } catch (e) {
      return { refused: String((e as Error)?.message ?? e) };
    }
    const p = spawnSync(bin, [], BOUNDED);
    return {
      stdout: p.stdout ?? Buffer.alloc(0), stderr: p.stderr ?? Buffer.alloc(0),
      exitCode: p.status ?? -1, signal: p.signal ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The oracle, capturing RAW bytes. */
export function nodeRun(source: string): RawResult {
  const dir = mkdtempSync(join(tmpdir(), "fzq-oracle-"));
  try {
    const file = join(dir, "case.ts");
    writeFileSync(file, source);
    const p = spawnSync("node", [file], BOUNDED);
    return {
      stdout: p.stdout ?? Buffer.alloc(0), stderr: p.stderr ?? Buffer.alloc(0),
      exitCode: p.status ?? -1, signal: p.signal ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Is this buffer valid UTF-8? Round-tripping through the decoder is the cheapest exact test. */
export function isUtf8(b: Buffer): boolean {
  return Buffer.compare(Buffer.from(b.toString("utf8"), "utf8"), b) === 0;
}

/** Split on \n, keeping raw bytes per line. */
function lines(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) { out.push(b.subarray(start, i)); start = i + 1; }
  }
  if (start < b.length) out.push(b.subarray(start));
  return out;
}

/** A single fuzz case: a label, and an expression whose value is printed. */
export interface Case { label: string; stmt: string }

export interface Mismatch { label: string; stmt: string; node: string; ours: string; kind: string }

/**
 * A case that STOPPED its batch — one side (or both) terminated there, so no later case in
 * that program ever ran. These must be isolated and skipped, otherwise a sweep silently
 * covers a fraction of what it claims: the first sweep here reported "ran 300" for batches
 * that had in fact stopped at case 21, because both sides truncated identically and the
 * line-for-line compare therefore agreed.
 */
export interface Stopper { label: string; stmt: string; nodeExit: number; ourExit: number; nodeStderr: string; ourStderr: string }

function batchSource(cases: Case[], prelude: string): string {
  const body = cases.map((c) => c.stmt).join("\n");
  return prelude + (prelude ? "\n" : "") + body + "\n";
}

/**
 * Run one batch, comparing line for line. Returns mismatches plus the cases that had to be
 * dropped (a compile refusal, bisected out).
 */
export async function runBatch(
  cases: Case[],
  prelude = "",
): Promise<{
  mismatches: Mismatch[];
  refused: { label: string; stmt: string; why: string }[];
  stoppers: Stopper[];
  ran: number;
}> {
  const mismatches: Mismatch[] = [];
  const refused: { label: string; stmt: string; why: string }[] = [];
  const stoppers: Stopper[] = [];
  let live = cases.slice();
  let ran = 0;

  for (;;) {
    if (live.length === 0) return { mismatches, refused, stoppers, ran };
    const src = batchSource(live, prelude);
    const r = await ourRun(src);
    if (isRefusal(r)) {
      const bad = await bisectRefusal(live, prelude);
      refused.push({ label: live[bad]!.label, stmt: live[bad]!.stmt, why: r.refused.split("\n")[0] ?? "" });
      live = live.slice(0, bad).concat(live.slice(bad + 1));
      continue;
    }
    const nr = nodeRun(src);
    const nl = lines(nr.stdout);
    const ol = lines(r.stdout);
    const n = Math.min(nl.length, ol.length);
    for (let i = 0; i < n; i++) {
      const a = nl[i]!, b = ol[i]!;
      if (Buffer.compare(a, b) !== 0) {
        const c = live[i] ?? { label: `line${i}`, stmt: "?" };
        mismatches.push({
          label: c.label, stmt: c.stmt,
          node: a.toString("latin1"), ours: b.toString("latin1"),
          kind: isUtf8(b) ? "value" : "NON-UTF8",
        });
      }
    }
    ran += n;
    // Did the program stop early on either side? One line per case is the contract, so
    // fewer lines than cases means the case at index `n` terminated the program.
    if (n < live.length) {
      const c = live[n]!;
      stoppers.push({
        label: c.label, stmt: c.stmt,
        nodeExit: nr.exitCode, ourExit: r.signal ? -1 : r.exitCode,
        nodeStderr: nr.stderr.toString("utf8").split("\n").slice(0, 3).join(" | ").slice(0, 200),
        ourStderr: (r.signal ? `[signal ${r.signal}] ` : "") + r.stderr.toString("utf8").split("\n").slice(0, 3).join(" | ").slice(0, 200),
      });
      live = live.slice(n + 1);
      continue;
    }
    if (nr.exitCode !== r.exitCode) {
      mismatches.push({
        label: "<exit>", stmt: "(whole batch)",
        node: `exit ${nr.exitCode}`, ours: `exit ${r.exitCode}`, kind: "exit",
      });
    }
    return { mismatches, refused, stoppers, ran };
  }
}

/**
 * Split cases into those nativets ACCEPTS and those it refuses, one case per program.
 *
 * This runs `sourceToIR` — the pure front end, no clang, ~1 ms — so screening 10,000 cases
 * costs ~10 s. Doing it by bisecting a failing BATCH instead costs O(k log n) full builds and
 * was measured at >1000 builds per 400-case chunk on the number sweep, i.e. unusable. A
 * refusal is a compile-time fact, so the cheap door answers it exactly.
 */
export function screen(cases: Case[], prelude = ""): {
  ok: Case[];
  refused: { label: string; stmt: string; why: string }[];
} {
  const ok: Case[] = [];
  const refused: { label: string; stmt: string; why: string }[] = [];
  for (const c of cases) {
    try {
      sourceToIR(prelude + (prelude ? "\n" : "") + c.stmt + "\n");
      ok.push(c);
    } catch (e) {
      refused.push({ label: c.label, stmt: c.stmt, why: String((e as Error)?.message ?? e).split("\n")[0] ?? "" });
    }
  }
  return { ok, refused };
}

/** Find the index of ONE case whose presence makes the batch refuse. -1 if none isolated. */
async function bisectRefusal(cases: Case[], prelude: string): Promise<number> {
  if (cases.length === 1) return 0;
  let lo = 0, hi = cases.length;
  // Invariant: cases[lo..hi) contains a refusing case when run with prelude.
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const left = cases.slice(lo, mid);
    const r = await ourRun(batchSource(left, prelude));
    if (isRefusal(r)) { hi = mid; } else { lo = mid; }
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "one" && arg) {
    const src = readFileSync(arg, "utf8");
    const nr = nodeRun(src);
    const or = await ourRun(src);
    console.log("=== node ===");
    console.log("exit", nr.exitCode, "utf8:", isUtf8(nr.stdout));
    console.log(JSON.stringify(nr.stdout.toString("latin1")));
    if (nr.stderr.length) console.log("stderr:", nr.stderr.toString("utf8").slice(0, 800));
    console.log("=== ours ===");
    if (isRefusal(or)) { console.log("REFUSED:", or.refused.slice(0, 900)); return; }
    console.log("exit", or.exitCode, "utf8:", isUtf8(or.stdout));
    console.log(JSON.stringify(or.stdout.toString("latin1")));
    if (or.stderr.length) console.log("stderr:", or.stderr.toString("utf8").slice(0, 800));
    console.log("=== match:", Buffer.compare(nr.stdout, or.stdout) === 0 && nr.exitCode === or.exitCode, "===");
    return;
  }
  console.log("usage: bun run test/fzq-fuzz.ts one <file.ts>");
}

if (import.meta.main) await main();
