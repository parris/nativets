/*
 * B3 v5 actors — STRUCTURED messages (records / arrays), the one thing v4 deferred.
 *
 * BEHAVIORAL tests (NOT node-differential), same contract as test/actors.test.ts and
 * test/actors-v4.test.ts: compile an actor `.ts` → run the native binary → assert exact
 * stdout. The single cooperative scheduler keeps the interleaving a pure function of the
 * program, so stdout is byte-stable and asserted exactly.
 *
 * Why v4 refused objects: a message rides in ONE 8-byte slot plus a coarse kind tag, and
 * sender and receiver are typed INDEPENDENTLY — so a slot + a coarse tag cannot tell two
 * record types apart across actors. v5 closes that with two things, both from codegen:
 *
 *   1. DEEP COPY ON SEND — the type-driven walk (the Stage-40 `structuredClone` walk,
 *      extended to copy string leaves) runs at the send/spawn site, so the receiver
 *      shares nothing with the sender's heap. Isolation is the actor model's point, and
 *      our immutability makes the copy semantically invisible.
 *   2. A SHAPE TAG ON THE WIRE — the message carries its canonical type encoding; a
 *      receive compiled for another shape is a hard runtime reject (exit 70) naming both
 *      shapes, never a reinterpreted pointer. A SELECTIVE receive treats a foreign shape
 *      like a foreign kind: skipped, left queued in order (the save queue).
 *
 * Anything with no sound copy (a closure, a Map/Set/Uint8Array/Response handle) is
 * refused at COMPILE time with NT1021 instead.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildBinary, sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(join(HERE, "actors", name), "utf8");

async function buildAndRun(file: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "actors-msg-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(src(file), bin, { target: "host" });
    const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The NT code a source is rejected with (or null if it compiles). */
function codeOf(source: string): string | null {
  try { sourceToIR(source); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

const CASES: { name: string; file: string; expected: string }[] = [
  // --- 1. a record travels between actors, typed by the receiver's annotation ---
  { name: "an object record can be sent and received", file: "struct_send.ts", expected: "work 42\n" },
  { name: "a structured message is DEEP-COPIED on send (it outlives the sender's scope)", file: "struct_copy.ts", expected: "1\n999\nown:5\n" },

  // --- 2. tagged unions — how every real actor program dispatches ---
  { name: "tagged-union dispatch: a `kind` discriminator drives an actor state machine", file: "struct_dispatch.ts", expected: "total=7\ndone\n" },
  { name: "selective receive on the tag; the skipped records stay queued in order", file: "struct_selective.ts", expected: "urgent 9\nnormal 1\nnormal 2\n" },
  { name: "two record types in one mailbox: a foreign SHAPE is skipped, not misread", file: "struct_mixed.ts", expected: "B hello\nA x1\nA y2\n" },

  // --- 3. arrays fall out of the same machinery (the walk already handles them) ---
  { name: "arrays as messages: number[], string[] and an array of records", file: "struct_array.ts", expected: "sum=10\na|b\n1:one\n2:two\n" },
  { name: "a structured spawn argument is the actor's (private) initial state", file: "struct_spawn.ts", expected: "w1 up to 3\nw2 up to 9\n" },
];

describe("B3 v5 actors — structured messages", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await buildAndRun(c.file);
      expect(r.stdout).toBe(c.expected);
      expect(r.status).toBe(0);
    });
  }

  // The shape tag is the whole reason objects can travel at all: a receive compiled for
  // `{a:number}` that meets `{b:string}` FAILS LOUDLY rather than reading the wrong slots.
  test("a SHAPE mismatch is a hard runtime error naming both shapes, never a miscompile", async () => {
    const r = await buildAndRun("shape_mismatch.ts");
    expect(r.stdout).toBe("");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("received a structured message of shape");
    expect(r.stderr).toContain("{b:string}");
    expect(r.stderr).toContain("{a:number}");
  });

  // ONE crash record per crash, carrying pid+name, the reason, the TRIGGERING MESSAGE and
  // the supervisor's decision — now rendered for structured messages (the runtime has no
  // types, so codegen hands it a per-shape JSON renderer used only while printing).
  test("a crash record renders the structured triggering message + its shape", async () => {
    const r = await buildAndRun("struct_crash.ts");
    expect(r.stdout).toBe("ok/1\n");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("nativets actor crash");
    expect(r.stderr).toContain('name="w"');
    expect(r.stderr).toContain("triggering-message:");
    expect(r.stderr).toContain('{"op":"boom","id":42}');   // the message that killed it
    expect(r.stderr).toContain("(shape {op:string,id:number})");
    expect(r.stderr).toContain("RESTART (one_for_one)");
  });

  // Reject-don't-miscompile: a message type with no sound deep copy never ships.
  describe("message types with no sound copy are NT1021, not a shared pointer", () => {
    test("a function value captures the SENDER's environment", () => {
      expect(codeOf("const f = (n: number): number => n;\nsend(1, f);")).toBe("NT1021");
    });
    test("a Map/Set handle has no deep-copy walk", () => {
      expect(codeOf("const m = new Map<string, number>();\nsend(1, m);")).toBe("NT1021");
      expect(codeOf("const s = new Set<string>();\nsend(1, s);")).toBe("NT1021");
    });
    test("a record with a function leaf is refused too (the check is recursive)", () => {
      expect(codeOf("send(1, { a: 1, f: (n: number): number => n });")).toBe("NT1021");
    });
    test("a receive annotated with an un-copyable type is refused at the receive", () => {
      expect(codeOf("const m: Map<string, number> = receive();")).toBe("NT1021");
    });
    // A NULLABLE is a two-slot tagged BOX. Sending one used to put the box pointer on the
    // wire for a receiver expecting a T (it printed `got ` for a "hello") — the exact
    // class of reinterpretation this lane exists to prevent. A message is always present.
    test("a nullable message is refused: the box pointer would go on the wire", () => {
      expect(codeOf('const s: string | undefined = "x";\nsend(1, s);')).toBe("NT1021");
      expect(codeOf("const o: { a: number } | undefined = { a: 1 };\nsend(1, o);")).toBe("NT1021");
      expect(codeOf("const p = receiveMatch((m: string | undefined): boolean => true);")).toBe("NT1021");
    });
  });

  // The example app: a supervised job router whose protocol is a RECORD (a tagged union
  // with a reply-to pid), which is what makes it read like OTP code rather than a numeric
  // toy. Not in test/examples.test.ts because that harness uses `node` as the oracle and
  // node has no BEAM scheduler; the cooperative schedule makes stdout byte-stable.
  test("examples/jobs.ts — supervised job router over tagged-union records", async () => {
    const file = join(HERE, "..", "examples", "jobs.ts");
    const dir = mkdtempSync(join(tmpdir(), "jobs-"));
    try {
      const bin = join(dir, "p");
      await buildBinary(readFileSync(file, "utf8"), bin, { target: "host" });
      const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
      expect(r.stdout).toBe(readFileSync(`${file}.expected`, "utf8"));
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('"op":"render"');        // the record that killed it
      expect(r.stderr).toContain("RESTART (one_for_one)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
