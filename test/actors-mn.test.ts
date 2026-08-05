/*
 * B3 v6 — M:N scheduler threads, lock-free MPSC mailboxes, work stealing.
 *
 * THE DETERMINISM CONTRACT. Every other actor test asserts EXACT stdout, which is only
 * meaningful because ONE cooperative scheduler makes the interleaving a pure function of
 * the program. True M:N parallelism destroys that, so the mode is OPT-IN:
 *
 *   NATIVETS_SCHED_THREADS unset / =1  ->  the deterministic single-threaded scheduler
 *                                          (byte-identical to v0..v5; the default)
 *   NATIVETS_SCHED_THREADS=N (N>1)     ->  N OS scheduler threads, work-stealing
 *
 * So the tests below come in two flavours:
 *   - determinism regression: the SAME sources the v0..v5 suites assert, re-run here to
 *     prove the restructured runtime did not perturb the single-threaded schedule;
 *   - multi-threaded PROPERTIES: only what is genuinely guaranteed under parallelism —
 *     per-pair send ORDER, total message counts, sums, eventual completion, supervision
 *     outcomes. Never a specific interleaving.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { buildBinary } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(join(HERE, "actors", name), "utf8");

/** Compile `file` once and run it with the given scheduler-thread count. */
async function runWith(
  file: string,
  threads: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "actors-mn-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(src(file), bin, { target: "host" });
    const env = { ...process.env, ...extraEnv } as Record<string, string>;
    if (threads === undefined) delete env.NATIVETS_SCHED_THREADS;
    else env.NATIVETS_SCHED_THREADS = threads;
    const r = spawnSync(bin, [], { encoding: "utf8", env });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("B3 v6 — scheduler mode gate", () => {
  test("default is the deterministic single-threaded scheduler", async () => {
    const r = await runWith("schedulers.ts", undefined);
    expect(r.stdout).toBe("1\n");
    expect(r.status).toBe(0);
  });

  test("NATIVETS_SCHED_THREADS=4 starts four scheduler threads", async () => {
    const r = await runWith("schedulers.ts", "4");
    expect(r.stdout).toBe("4\n");
    expect(r.status).toBe(0);
  });
});
