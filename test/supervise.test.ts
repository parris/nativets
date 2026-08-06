/*
 * B3 v2 (links / monitors / trapExit) + v3 (one_for_one supervision) — behavioral
 * tests (NOT node-differential; node has no BEAM scheduler). Same contract as
 * test/actors.test.ts: compile an actor `.ts` → run the binary → assert exact stdout.
 * The single cooperative v0 scheduler makes the interleaving a pure function of the
 * spawn/send/kill order, so stdout (and pids) are byte-stable and asserted exactly.
 *
 * v2: exit-signal propagation over links, trapExit (exit-as-message), monitors (DOWN).
 * v3: the canonical OTP kill-and-assert-restart (fresh known-good state, new pid) and
 * restart-intensity escalation (too many restarts in the window → supervisor exits).
 * Fault injection: __crash(reason) / __kill(pid). Crash records go to stderr, so stdout
 * stays assertable; one case pins the crash-record shape from stderr.
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

const CASES: { name: string; file: string; expected: string }[] = [
  // v2 — links / monitors / trapExit
  { name: "link propagates an abnormal exit (peer dies)", file: "link_propagates.ts", expected: "200\n" },
  { name: "trapExit converts an exit to a message (peer survives)", file: "trap_exit.ts", expected: "2\n42\n" },
  { name: "monitor delivers DOWN on exit", file: "monitor_down.ts", expected: "2\n" },
  // v3 — one_for_one supervision
  { name: "kill a supervised worker → restart to known-good state, new pid", file: "kill_and_restart.ts", expected: "2\n3\n0\n" },
  { name: "restart intensity exceeded → supervisor escalates (no restart)", file: "restart_intensity.ts", expected: "2\n3\n3\n999\n" },
];

async function buildAndRun(file: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "sup-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(src(file), bin, { target: "host" });
    const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("B3 v2/v3 actors — links, monitors, supervision (native, deterministic)", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await buildAndRun(c.file);
      expect(r.stdout).toBe(c.expected);
      expect(r.status).toBe(0);
    });
  }

  // The crash record (stderr) — a supervised crash emits one structured record with
  // the actor (pid+name), reason, supervisor, and the restart decision (§5 of the note).
  test("crash record carries pid/name, reason, supervisor, and decision", async () => {
    const r = await buildAndRun("kill_and_restart.ts");
    expect(r.stderr).toContain("nativets actor crash");
    expect(r.stderr).toContain('name="c"');
    expect(r.stderr).toContain("reason:");
    expect(r.stderr).toContain("supervisor:");
    expect(r.stderr).toContain("decision:");
    expect(r.stderr).toContain("RESTART");
  });

  // Escalation emits the intensity-exceeded decision on stderr.
  test("intensity-exceeded crash record names the escalation", async () => {
    const r = await buildAndRun("restart_intensity.ts");
    expect(r.stderr).toContain("INTENSITY EXCEEDED");
  });
});
