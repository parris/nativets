/*
 * B3 v0 actors — behavioral tests (NOT node-differential).
 *
 * Node has no BEAM scheduler, so `node file.ts` cannot define what an actor
 * program means (spawn/send/receive/self are nativets builtins node doesn't have).
 * Instead — exactly as docs/research/B3-actors.md §0 prescribes — these are native
 * BEHAVIORAL tests: under the single cooperative v0 scheduler the interleaving is a
 * pure function of spawn/send order, so stdout is byte-stable and asserted exactly.
 * The sources live under test/actors/ (deliberately OUTSIDE test/fixtures/**, whose
 * generic harness runs `node` on every case and would choke on the actor builtins).
 *
 * v0 scope: spawn(body, msg) -> pid, send(pid, msg), receive() -> msg, self() -> pid,
 * plus the __drain() test hook. Messages are numbers in v0 (Dyn is a follow-up).
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

// Each case: an actor source + its exact expected stdout (deterministic schedule).
const CASES: { name: string; file: string; expected: string }[] = [
  { name: "spawn + send + receive (echo)", file: "echo.ts", expected: "42\n" },
  { name: "self() yields distinct pids", file: "self.ts", expected: "0\n1\n2\n" },
  { name: "per-sender FIFO", file: "fifo.ts", expected: "1\n2\n3\n" },
  { name: "two-actor ping/pong (blocking receive wakeup)", file: "pingpong.ts", expected: "100\n200\n" },
  // v1 reduction-counted preemption (compiler-emitted safepoints). A cooperative-
  // only scheduler would let the non-blocking hog run to completion first; the
  // interleaving below only happens because the hog is PREEMPTED at loop back-edges.
  // Cooperative-only outputs are noted per case; the single fixed-budget scheduler
  // keeps the preempted schedule deterministic, so we assert exact stdout.
  { name: "preemption: no-starvation (hog yields to a tick actor)", file: "fairness.ts", expected: "1\n3\n2\n" }, // cooperative-only: 1\n2\n3\n
  { name: "preemption: two compute loops interleave", file: "interleave.ts", expected: "10\n20\n11\n21\n12\n22\n" }, // cooperative-only: 10\n11\n12\n20\n21\n22\n
];

describe("B3 v0 actors — behavioral (native, deterministic)", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), "actors-"));
      try {
        const bin = join(dir, "p");
        await buildBinary(src(c.file), bin, { target: "host" });
        const r = spawnSync(bin, [], { encoding: "utf8" });
        expect(r.stdout).toBe(c.expected);
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
