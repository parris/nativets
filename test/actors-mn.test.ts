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
const ROOT = join(HERE, "..");
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
    const r = spawnSync(bin, [], { encoding: "utf8", env, timeout: 60_000, killSignal: "SIGKILL" });
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

/* The v0..v5 behavioral suites already assert these byte-for-byte with the env unset. The
 * point here is the RESTRUCTURED runtime (SWITCHING state, per-scheduler queues, MPSC
 * intake): with one scheduler every one of those paths must collapse back to the old
 * cooperative schedule. `NATIVETS_SCHED_THREADS=1` is asserted explicitly too, so an
 * accidental "any value turns threads on" regression cannot hide. */
describe("B3 v6 — determinism preserved in single-threaded mode", () => {
  const DET: { file: string; expected: string }[] = [
    { file: "fifo.ts", expected: "1\n2\n3\n" },
    { file: "pingpong.ts", expected: "100\n200\n" },
    { file: "fairness.ts", expected: "1\n3\n2\n" },
    { file: "interleave.ts", expected: "10\n20\n11\n21\n12\n22\n" },
    { file: "selective.ts", expected: "200\n1\n2\n3\n" },
    { file: "selective_timeout.ts", expected: "-1\n7\n8\n" },
  ];
  for (const c of DET) {
    test(`${c.file} is byte-identical (unset, and =1)`, async () => {
      expect((await runWith(c.file, undefined)).stdout).toBe(c.expected);
      expect((await runWith(c.file, "1")).stdout).toBe(c.expected);
    });
  }
});

/* Multi-threaded PROPERTIES. Never an interleaving — only what the actor model promises. */
describe("B3 v6 — M:N properties (4 scheduler threads)", () => {
  test("fan-in: exactly-once delivery + per-sender FIFO", async () => {
    // 4 senders x 50 messages into one collector. The collector itself checks that each
    // sender's sequence numbers arrive in order, so the assertion is schedule-independent.
    const r = await runWith("mn_fanin.ts", "4");
    expect(r.stdout).toBe("count=200\nsum=5100\nordered=1\n");
    expect(r.status).toBe(0);
  });

  test("work actually migrates: several schedulers run actors, via stealing", async () => {
    const mt = await runWith("mn_parallel.ts", "4");
    expect(mt.stdout).toBe("used>=2:true\nused==1:false\nstole:true\n");
    const st = await runWith("mn_parallel.ts", undefined);
    expect(st.stdout).toBe("used>=2:false\nused==1:true\nstole:false\n");
  });

  test("stress: 6 actors x 40 string+record round trips, run repeatedly", async () => {
    // Repeated because a race is a probabilistic failure: one green run proves nothing.
    for (let i = 0; i < 5; i++) {
      const r = await runWith("mn_stress.ts", "4");
      expect(r.stdout).toBe("replies=6\nsum=4920\n");
      expect(r.status).toBe(0);
    }
  });

  test("supervision outcome survives parallelism (kill -> restart -> known-good state)", async () => {
    // The OTP property is the OUTCOME, not the schedule: the child crashes, the supervisor
    // restarts it under the same registered name, and it answers from reset state.
    for (let i = 0; i < 3; i++) {
      const r = await runWith("kill_and_restart.ts", "4");
      expect(r.stdout).toBe("2\n3\n0\n");
      expect(r.stderr).toContain("RESTART (one_for_one)");
      expect(r.status).toBe(0);
    }
  });

  test("restart intensity still escalates under threads", async () => {
    const r = await runWith("restart_intensity.ts", "4");
    expect(r.stderr).toContain("INTENSITY EXCEEDED");
    expect(r.stdout).toBe("2\n3\n3\n999\n");
    expect(r.status).toBe(0);
  });
});

/*
 * THE ASYNC-IO POLLER (v6.4). An actor parks on a FILE DESCRIPTOR and is resumed by kernel
 * readiness (kqueue on macOS/BSD, epoll on Linux) instead of holding a scheduler thread in
 * a blocking read. Gated at the C level over a real pipe(), because nativets has no TS
 * surface that hands a program an fd yet — `readLine` slurps all of stdin up front and
 * `fetch` is blocking libcurl, so neither is wired to the poller (see the ledger).
 * The assertion is the one that matters: the parked actor costs nothing, i.e. another
 * actor runs to completion while it waits.
 */
describe("B3 v6 — async-IO poller (kqueue/epoll)", () => {
  for (const threads of [undefined, "4"] as const) {
    test(`park on a fd + wake on readiness (${threads ?? "1"} scheduler thread(s))`, () => {
      const dir = mkdtempSync(join(tmpdir(), "mn-poll-"));
      try {
        const bin = join(dir, "poll_test");
        const b = spawnSync("clang", [
          "-O0", "-g", join(ROOT, "test/runtime/poll_test.c"), "-o", bin,
        ], { encoding: "utf8" });
        expect(b.stderr).toBe("");
        expect(b.status).toBe(0);
        const env = { ...process.env } as Record<string, string>;
        if (threads === undefined) delete env.NATIVETS_SCHED_THREADS;
        else env.NATIVETS_SCHED_THREADS = threads;
        const r = spawnSync(bin, [], { encoding: "utf8", env, timeout: 60_000, killSignal: "SIGKILL" });
        expect(r.stdout).toContain("PASS");
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

/*
 * THE THREADSANITIZER GATE. A race in a refcount is exactly the class of bug this project
 * exists not to have, and "it passed 40 runs" is not evidence — a race is probabilistic.
 *
 * It cannot be a compiled actor program: the scheduler's coroutines are ucontext FIBERS
 * that migrate between OS threads, and TSan's fiber support CHECK-fails on macOS the
 * moment a fiber resumes on a thread other than the one that suspended it. So the gate
 * drives what genuinely becomes SHARED under M:N — runtime.c's string RC side-table and
 * nt_pvec.c's node refcounts + the Stage-44 transient — from plain pthreads, through the
 * SAME `nt_rt_lock` hook nt_sched_init installs. See test/runtime/mn_rc_race_test.c.
 *
 * The negative control matters as much as the positive one: with the hook left out, the
 * identical workload must report races. Otherwise the green run proves nothing.
 */
describe("B3 v6 — ThreadSanitizer over the shared runtime structures", () => {
  const buildTsan = (dir: string) => {
    const bin = join(dir, "racetest");
    const r = spawnSync("clang", [
      "-O1", "-g", "-fsanitize=thread", "-DNT_PVEC",
      join(ROOT, "test/runtime/mn_rc_race_test.c"),
      join(ROOT, "runtime/runtime.c"), join(ROOT, "runtime/nt_pvec.c"),
      "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return bin;
  };

  test("no data races with the M:N lock hook installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-tsan-"));
    try {
      const r = spawnSync(buildTsan(dir), [], { encoding: "utf8" });
      expect(r.stderr).not.toContain("ThreadSanitizer: data race");
      expect(r.stdout).toContain("PASS");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("negative control: the same workload DOES race without the hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-tsan-"));
    try {
      // BOUNDED ON PURPOSE. Without the lock the RC side-table is corrupted by concurrent
      // rehashing, and `str_tab_slot`'s linear probe — which terminates only because an
      // empty slot is guaranteed to exist — can then spin forever. That non-termination is
      // itself part of the finding, but an unbounded child would outlive the test and burn
      // a core, so cap it and SIGKILL. TSan streams each race as it finds it, so the
      // assertion holds on whatever was captured before the cap.
      const r = spawnSync(buildTsan(dir), [], {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        env: { ...process.env, NT_RACE_TEST_NOHOOK: "1" } as Record<string, string>,
      });
      expect(r.stderr).toContain("ThreadSanitizer: data race");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
