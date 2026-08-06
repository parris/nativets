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
    const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES: { name: string; file: string; expected: string }[] = [
  // --- 1. receive(ms): a timeout is observably `undefined`, not a sentinel number ---
  { name: "receive(ms) times out with undefined; a waiting message does not", file: "timeout.ts", expected: "7\n-1\n" },

  // --- 2. selective receive: the save queue keeps the skipped messages, in order ---
  { name: "receiveMatch picks out of the middle; skipped messages stay queued in order", file: "selective.ts", expected: "200\n1\n2\n3\n" },
  { name: "a selective receive that never matches times out and consumes nothing", file: "selective_timeout.ts", expected: "-1\n7\n8\n" },
  { name: "a match arriving while blocked resumes the scan at the first new message", file: "selective_late.ts", expected: "9\n1\n2\n" },

  // --- 3. string messages (deep-copied on send) ---
  { name: "string spawn arg + string send + selective receive on a text tag", file: "strings.ts", expected: "hello, world\njob:compile\nnoise\n" },
  { name: "a sent string is deep-copied (survives the sender's local being freed)", file: "string_copy.ts", expected: "msg-1\n" },
];

describe("B3 v4 actors — selective receive / timeouts / string messages", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await buildAndRun(c.file);
      expect(r.stdout).toBe(c.expected);
      expect(r.status).toBe(0);
    });
  }

  // Messages are statically typed but share one 8-byte slot, so the kind travels with
  // the message: a receive compiled for `number` that meets a string FAILS LOUDLY
  // rather than reinterpreting the pointer (reject-don't-miscompile, at runtime).
  test("a message-kind mismatch is a hard runtime error, never a miscompile", async () => {
    const r = await buildAndRun("kind_mismatch.ts");
    expect(r.stdout).toBe("");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("received a string message but this receive expects number");
  });

  // The example app (examples/router.ts): a supervised request router exercising the
  // whole v4 surface at once — string messages, priority (selective) receive with a
  // save queue, reply timeouts, supervision + restart, and name-based addressing.
  // Not in test/examples.test.ts because that harness runs `node` as the oracle and
  // node has no BEAM scheduler; the cooperative schedule makes stdout byte-stable.
  test("examples/router.ts — supervised request router (selective receive + timeouts + strings)", async () => {
    const file = join(HERE, "..", "examples", "router.ts");
    const dir = mkdtempSync(join(tmpdir(), "router-"));
    try {
      const bin = join(dir, "p");
      await buildBinary(readFileSync(file, "utf8"), bin, { target: "host" });
      const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
      expect(r.stdout).toBe(readFileSync(`${file}.expected`, "utf8"));
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('"c4 /boom"');       // the crash record names the request
      expect(r.stderr).toContain("RESTART (one_for_one)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // §5 of the actors note: ONE crash record per crash, carrying pid+name, the reason,
  // the TRIGGERING MESSAGE (v4: now printable for string messages) and the decision.
  test("a crash record names the triggering (string) message and the restart decision", async () => {
    const r = await buildAndRun("crash_message.ts");
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toContain("nativets actor crash");
    expect(r.stderr).toContain('name="w"');
    expect(r.stderr).toContain("triggering-message:");
    expect(r.stderr).toContain('"boom"'); // the message that killed it, verbatim
    expect(r.stderr).toContain("RESTART (one_for_one)");
  });
});
