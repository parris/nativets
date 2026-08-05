/*
 * B3 v4 actors — selective receive, timeouts, and richer (string) messages.
 * BEHAVIORAL tests (NOT node-differential), same contract as test/actors.test.ts:
 * compile an actor `.ts` → run the native binary → assert exact stdout. The single
 * cooperative scheduler + a VIRTUAL clock for timeouts keep the interleaving a pure
 * function of the program, so stdout is byte-stable and asserted exactly.
 *
 * Surface under test (all plain TS calls — no new syntax):
 *   receive()                      blocking FIFO receive            -> T
 *   receive(ms)                    receive with a timeout           -> T | undefined
 *   receiveMatch(pred)             selective receive (save queue)   -> T
 *   receiveMatch(pred, ms)         selective receive with timeout   -> T | undefined
 *   send(pid, "text") / spawn(body, "text")   string messages (deep-copied on send)
 *
 * T is `number` by default and comes from the declared type (`const m: string = receive()`)
 * or, for receiveMatch, from the predicate's parameter type.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildBinary } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(join(HERE, "actors", name), "utf8");

async function buildAndRun(file: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "actors-v4-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(src(file), bin, { target: "host" });
    const r = spawnSync(bin, [], { encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES: { name: string; file: string; expected: string }[] = [
  // --- 1. receive(ms): a timeout is observably `undefined`, not a sentinel number ---
  { name: "receive(ms) times out with undefined; a waiting message does not", file: "timeout.ts", expected: "7\n-1\n" },
];

describe("B3 v4 actors — selective receive / timeouts / string messages", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await buildAndRun(c.file);
      expect(r.stdout).toBe(c.expected);
      expect(r.status).toBe(0);
    });
  }
});
