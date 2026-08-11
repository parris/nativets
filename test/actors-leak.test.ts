/*
 * ACTOR MESSAGE LIFETIME — one owner, one free, on every path.
 *
 * `send` deep-copies the message (strings in the runtime, records/arrays in codegen's
 * type-driven walk). That copy IS the isolation guarantee and it is correct; what was
 * missing was everything after it. The ownership story these tests pin:
 *
 *   send -> mailbox   the sender HANDS THE COPY OVER. `slotNoRetain` packs the pointer with
 *                     no retain and the sender's own local keeps the ownership it had, so
 *                     the copy's owner is the mailbox NODE from the moment it is enqueued.
 *   in the mailbox    the node owns it. A message the SAVE QUEUE skipped was never
 *                     dequeued and is still the mailbox's — exactly one owner, no change.
 *   receive -> frame  the pop frees the NODE and never the payload: ownership transfers to
 *                     the receiving local, whose ordinary scope-exit drop frees it.
 *   never received    the actor dies with a non-empty mailbox and there IS no next owner,
 *                     so `actor_die` frees what is left (runtime/nt_actor.c mbox_discard).
 *   refused send      an unknown/dead pid drops the message — but a STRUCTURED copy already
 *                     exists by then (codegen made it), so `nt_send_struct` frees it.
 *   timed-out receive nothing is dequeued, so nothing changes hands and there is nothing
 *                     to free.
 *
 * MEASURED AT TWO SCALES, always. A residue that is CONSTANT is conservative
 * over-retention; a residue that scales with the message count is the unbounded leak, and
 * a long-running actor system is the one workload where that is fatal. LeakSanitizer is
 * Linux-only, so `__objLive()`/`__strLive()` are the only instrument that sees this on
 * macOS. The counters are also load-bearing in the other direction: the string control at
 * the bottom asserts a residue that is STILL there, so a future change cannot make these
 * pass by disabling the counters.
 *
 * Every actor probe runs SINGLE- and MULTI-THREADED. The two are genuinely different
 * programs: single-threaded `__drain` means a receiver cannot die before its sends, which
 * hides both halves of the send-vs-die handoff entirely.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";
import { emitIRAsan, runWithNode } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Every spawned child is bounded, and killed hard — an actor bug is as likely to hang. */
const BOUNDED = { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" } as const;

/** Build to a native binary and run it at `threads` scheduler threads. The BINARY is used
 *  rather than `cli.ts run`, which remaps SIGABRT to 255 and would hide a real exit code. */
async function runAt(source: string, threads: string): Promise<{ stdout: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-actorleak-"));
  try {
    const bin = join(dir, "prog");
    await buildBinary(source, bin, { target: "host" });
    const env = { ...process.env, NATIVETS_SCHED_THREADS: threads };
    const p = spawnSync(bin, [], { ...BOUNDED, env });
    return { stdout: p.stdout ?? "", exitCode: p.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse `label small big` lines into a map, so a probe can report several counters. */
function residues(stdout: string): Map<string, { small: number; big: number }> {
  const out = new Map<string, { small: number; big: number }>();
  for (const line of stdout.trim().split("\n")) {
    const parts = line.split(" ");
    if (parts.length !== 3) continue;
    out.set(parts[0]!, { small: Number(parts[1]), big: Number(parts[2]) });
  }
  return out;
}

/** The shared worker/driver preamble every probe below builds on. */
const PRELUDE = [
  `function fire(w: number, i: number): void { const req = { a: i, b: i }; send(w, req); }`,
  `function drive(w: number, n: number): void {`,
  `  for (let i = 0; i < n; i++) { fire(w, i); }`,
  `  __drain();`,
  `}`,
  `function show(what: string, small: number, big: number): void {`,
  `  console.log(what + " " + small + " " + big);`,
  `}`,
].join("\n");

/** Two rounds of `body(n)` at 100 and 1000, reporting the live-object delta of each. */
function scaled(label: string, call: string): string {
  return [
    `const ${label}0 = __objLive(); ${call}(100);`,
    `const ${label}1 = __objLive(); ${call}(1000);`,
    `const ${label}2 = __objLive();`,
    `show("${label}", ${label}1 - ${label}0, ${label}2 - ${label}1);`,
  ].join("\n");
}

/* The three paths on which a message changes hands, in one program so they share a
 * scheduler and a counter baseline. `half` consumes only half of what it is sent, so its
 * actor dies with a non-empty mailbox AND (multi-threaded) races later sends against its
 * own death — the two halves of the send-vs-die handoff, which single-threaded cannot
 * reach because `__drain` runs the worker only after every send has landed. */
const PATHS = [
  PRELUDE,
  // delivered: the receiving frame becomes the one owner.
  `const allW = (n: number): void => {`,
  `  for (let i = 0; i < n; i++) { const m: { a: number; b: number } = receive(); }`,
  `};`,
  `function delivered(n: number): void { const w = spawn(allW, n); drive(w, n); }`,
  // undelivered: the actor dies holding the rest.
  `const halfW = (n: number): void => {`,
  `  const half = n / 2;`,
  `  for (let i = 0; i < half; i++) { const m: { a: number; b: number } = receive(); }`,
  `};`,
  `function undelivered(n: number): void { const w = spawn(halfW, n); drive(w, n); }`,
  // refused: every send targets a pid that has already finished and died.
  `const noneW = (n: number): void => { };`,
  `function refused(n: number): void { const w = spawn(noneW, n); __drain(); drive(w, n); }`,
  scaled("delivered", "delivered"),
  scaled("undelivered", "undelivered"),
  scaled("refused", "refused"),
].join("\n");

/** Assert every reported counter is FLAT across the 10x — the leak-free shape. */
function expectFlat(stdout: string, labels: string[]): void {
  const rows = residues(stdout);
  for (const l of labels) {
    const r = rows.get(l);
    expect({ [l]: r !== undefined }).toEqual({ [l]: true });
    // 10x the messages must not mean 10x the residue.
    expect({ [l]: r!.big }).toEqual({ [l]: r!.small });
  }
}

describe("actor message lifetime — the residue does not scale with the traffic", () => {
  /*
   * THE PINNED BUG (test/fuzz2-diff.test.ts): exactly one object leaked per message
   * DELIVERED, at every scale — 100 messages left 100 objects, 1000 left 1000. The copy's
   * ownership was already right; the receiving frame simply never dropped it, because an
   * actor body is necessarily an ARROW (`spawn` takes a closure) and codegen suppressed
   * every drop inside a lifted arrow. The same body written as a `function` was clean,
   * which is what pinned it on the frame rather than on the message ABI.
   */
  test("single-threaded: delivered, undelivered and refused all stay flat", async () => {
    const r = await runAt(PATHS, "1");
    expect(r.exitCode).toBe(0);
    expectFlat(r.stdout, ["delivered", "undelivered", "refused"]);
  });

  /*
   * The same program with real parallelism, which is a different program: the receiver can
   * now die WHILE the sender is still sending. Both halves of that handoff are pinned here
   * — the refused send freeing the copy codegen already made, and the producer re-reading
   * the status after publishing so a message that lands during the discard is still freed.
   * Before those, this probe leaked 42 objects per 100 messages and 497 per 1000.
   */
  test("multi-threaded (4 schedulers): the same three paths stay flat", async () => {
    const r = await runAt(PATHS, "4");
    expect(r.exitCode).toBe(0);
    expectFlat(r.stdout, ["delivered", "undelivered", "refused"]);
  });

  /* Work stealing across more schedulers than cores widens the send-vs-die window. */
  test("multi-threaded (8 schedulers): the same three paths stay flat", async () => {
    const r = await runAt(PATHS, "8");
    expect(r.exitCode).toBe(0);
    expectFlat(r.stdout, ["delivered", "undelivered", "refused"]);
  });

  /*
   * SELECTIVE RECEIVE. The save queue is the case worth pinning: a message the predicate
   * rejects is re-queued rather than consumed, so it must stay the MAILBOX's — one owner,
   * still, and freed by whoever eventually takes it (or by `actor_die`). The predicate is
   * a hoisted binding on purpose: an arrow written INLINE at the call site allocates a
   * closure env per call that nothing frees, which is the separate argument-position
   * temporary defect (`test/fuzz2-diff.test.ts`) and would mask this counter.
   */
  test("receiveMatch: the save queue keeps exactly one owner", async () => {
    const src = [
      PRELUDE,
      // Odd `a` is skipped on the first pass and matched on the second, so most messages
      // really do sit in the save queue rather than being taken in arrival order.
      `const evenFirst = (x: { a: number; b: number }): boolean => x.a % 2 === 0;`,
      `const anyMsg = (x: { a: number; b: number }): boolean => true;`,
      `const selW = (n: number): void => {`,
      `  const half = n / 2;`,
      `  for (let i = 0; i < half; i++) { const m: { a: number; b: number } = receiveMatch(evenFirst); }`,
      `  for (let i = 0; i < half; i++) { const m: { a: number; b: number } = receiveMatch(anyMsg); }`,
      `};`,
      `function selective(n: number): void { const w = spawn(selW, n); drive(w, n); }`,
      scaled("selective", "selective"),
    ].join("\n");
    const r = await runAt(src, "1");
    expect(r.exitCode).toBe(0);
    expectFlat(r.stdout, ["selective"]);
  });

  /*
   * A TIMED receive that expires dequeues nothing, so nothing changes hands and there is
   * nothing for it to free. Counted on `__strLive` rather than `__objLive` because the
   * `T | undefined` box a timeout yields is an object that nothing frees — a general
   * nullable-box defect with no actor in it at all (a plain function returning
   * `T | undefined` leaks two objects per call the same way), which would swamp this.
   */
  test("a timed-out receive consumes nothing and leaks no message", async () => {
    const src = [
      `const toW = (n: number): void => {`,
      `  for (let i = 0; i < n; i++) { const m: { a: string } | undefined = receive(1); }`,
      `};`,
      `function timeouts(n: number): void { const w = spawn(toW, n); __drain(); }`,
      `function show(what: string, small: number, big: number): void {`,
      `  console.log(what + " " + small + " " + big);`,
      `}`,
      `const t0 = __strLive(); timeouts(100);`,
      `const t1 = __strLive(); timeouts(1000);`,
      `const t2 = __strLive();`,
      `show("timeout", t1 - t0, t2 - t1);`,
    ].join("\n");
    const r = await runAt(src, "1");
    expect(r.exitCode).toBe(0);
    expectFlat(r.stdout, ["timeout"]);
  });

  /* The control the pinned bug shipped with: a number message allocates nothing, so its
   * residue was flat even while every record message leaked. Kept so a regression in the
   * counters themselves cannot make the tests above pass. */
  test("a NUMBER message allocates nothing (the control)", async () => {
    const src = [
      `const numW = (n: number): void => {`,
      `  for (let i = 0; i < n; i++) { const m: number = receive(); }`,
      `};`,
      `function nums(n: number): void {`,
      `  const w = spawn(numW, n);`,
      `  for (let i = 0; i < n; i++) { send(w, i); }`,
      `  __drain();`,
      `}`,
      `function show(what: string, small: number, big: number): void {`,
      `  console.log(what + " " + small + " " + big);`,
      `}`,
      `const n0 = __objLive(); nums(100);`,
      `const n1 = __objLive(); nums(1000);`,
      `const n2 = __objLive();`,
      `show("numbers", n1 - n0, n2 - n1);`,
    ].join("\n");
    const r = await runAt(src, "1");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("numbers 0 0");
  });
});

/*
 * THE SHALLOW-FREE CONTROL, and it is deliberately an assertion that a leak IS STILL
 * THERE. `nt_obj_free` is `free(o)` — it never walks slots — so freeing a message copy's
 * outer record reclaims the record and not the heap strings its slots point at. That is a
 * separate, documented issue in the object model, NOT in the message ABI, and this test
 * exists so the two are never conflated: the OBJECT counter must be flat (the message
 * lifetime is fixed) while the STRING counter still scales (the object model is not).
 *
 * Measured with no actors anywhere, the same residue decomposes into two pre-existing
 * defects that fully account for it: a record with one string slot leaves exactly one
 * string per record (100 per 100, 1000 per 1000 — the shallow free), and a string local
 * declared inside a LOOP is released once at frame exit rather than per iteration (99 per
 * 100, 999 per 1000 — string RC is frame-scoped). Neither has an actor in it.
 *
 * If this test starts failing because the string counter went flat, that is good news:
 * delete the negative assertion, do not weaken it.
 */
test("a STRING-valued message: objects flat, strings still leaking (shallow free)", async () => {
  const src = [
    `const strW = (n: number): void => {`,
    `  for (let i = 0; i < n; i++) { const m: { a: string; b: number } = receive(); }`,
    `};`,
    `function fireStr(w: number, i: number): void { const req = { a: "m" + i, b: i }; send(w, req); }`,
    `function strs(n: number): void {`,
    `  const w = spawn(strW, n);`,
    `  for (let i = 0; i < n; i++) { fireStr(w, i); }`,
    `  __drain();`,
    `}`,
    `function show(what: string, small: number, big: number): void {`,
    `  console.log(what + " " + small + " " + big);`,
    `}`,
    `const o0 = __objLive(); const s0 = __strLive(); strs(100);`,
    `const o1 = __objLive(); const s1 = __strLive(); strs(1000);`,
    `const o2 = __objLive(); const s2 = __strLive();`,
    `show("obj", o1 - o0, o2 - o1);`,
    `show("str", s1 - s0, s2 - s1);`,
  ].join("\n");
  const r = await runAt(src, "1");
  expect(r.exitCode).toBe(0);
  const rows = residues(r.stdout);
  // The message copy itself: freed, at both scales.
  expect({ obj: rows.get("obj")!.big }).toEqual({ obj: rows.get("obj")!.small });
  // Its string slots: NOT freed, and the residue tracks the traffic. Asserted as the
  // ~10x it is, so this cannot silently pass on a residue that merely changed shape.
  const str = rows.get("str")!;
  expect(str.small).toBeGreaterThan(0);
  expect(str.big).toBeGreaterThan(str.small * 5);
});

/*
 * NODE IS THE SPECIFICATION, so the counters are not allowed to be the only evidence: an
 * actor program's stdout and EXIT CODE must equal node's. Run from the compiled binary,
 * because `cli.ts run` remaps SIGABRT to 255 and would hide a real one.
 *
 * `receive`/`spawn` do not exist in node, so the oracle runs the same computation with the
 * message passing spelled as a direct call — the VALUES are what is being compared, and a
 * message copy that were freed too early would show up here as garbage, which is the
 * silent-wrong-answer class this repo cares most about.
 */
test("an actor program agrees with node on stdout and exit code", async () => {
  const ours = [
    `const sumW = (n: number): void => {`,
    `  let acc = 0;`,
    `  for (let i = 0; i < n; i++) {`,
    `    const m: { a: number; b: string } = receive();`,
    `    acc = acc + m.a;`,
    `    if (i === n - 1) { console.log(m.b + " " + acc); }`,
    `  }`,
    `};`,
    `function fireOne(w: number, i: number): void { const req = { a: i, b: "tag" + i }; send(w, req); }`,
    `const w = spawn(sumW, 50);`,
    `for (let i = 0; i < 50; i++) { fireOne(w, i); }`,
    `__drain();`,
  ].join("\n");
  const oracle = [
    `let acc = 0;`,
    `for (let i = 0; i < 50; i++) {`,
    `  const m: { a: number; b: string } = { a: i, b: "tag" + i };`,
    `  acc = acc + m.a;`,
    `  if (i === 49) { console.log(m.b + " " + acc); }`,
    `}`,
  ].join("\n");
  const node = runWithNode(oracle);
  const r = await runAt(ours, "1");
  expect(r.stdout).toBe(node.stdout);
  expect(r.exitCode).toBe(node.exitCode);
});

/*
 * ASAN — the risk direction this lane creates. Freeing a message is one edit away from
 * freeing one the receiver still holds, and a use-after-free READ is invisible without
 * instrumentation: exit 0 with stale bytes. macOS has no LeakSanitizer but ASan works, and
 * ASan is an LLVM PASS that only rewrites functions carrying `sanitize_address` — so the
 * attribute is ASSERTED PRESENT below rather than assumed. An uninstrumented binary that
 * "reports nothing" is not evidence of anything.
 *
 * BUILT AT -O0 ON PURPOSE. At -O1 an unrelated, PRE-EXISTING fault reproduces identically
 * on a clean tree: `wait_for_more` reads a NULL `g_current` immediately after
 * `yield_to_sched`, i.e. the compiler caches the thread-local's address across a
 * `swapcontext` that migrates the coroutine to another OS thread. That is an M:N scheduler
 * bug, not a message-lifetime one, and pinning it here would only make this file red for
 * someone else's reason — but it does mean -O1 + threads is not an available instrument.
 */
function runUnderAsan(source: string, tag: string, threads: string): { status: number | null; stdout: string; stderr: string } {
  const ll = emitIRAsan(source);
  expect(ll).toContain("attributes #99 = { sanitize_address }");
  for (const d of ll.split("\n").filter((l) => l.startsWith("define "))) expect(d.endsWith("#99 {")).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), `nativets-actorasan-${tag}-`));
  try {
    const llPath = join(dir, "module.ll");
    writeFileSync(llPath, ll);
    // The actor runtime quote-includes its own header, and runtime.c the pvec one.
    for (const f of ["nt_actor.c", "nt_actor.h", "nt_pvec.c", "nt_pvec.h"]) {
      copyFileSync(join(ROOT, "runtime", f), join(dir, f));
    }
    const bin = join(dir, "prog");
    const built = spawnSync("clang", [
      "-O0", "-g", "-fsanitize=address", "-fno-omit-frame-pointer", "-DNT_PVEC",
      llPath, join(ROOT, "runtime/runtime.c"), join(dir, "nt_actor.c"), join(dir, "nt_pvec.c"),
      "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(built.stderr.includes("error:")).toBe(false);
    expect(built.status).toBe(0);
    const run = spawnSync(bin, [], {
      ...BOUNDED,
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", NATIVETS_SCHED_THREADS: threads },
    });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("actor message lifetime under AddressSanitizer", () => {
  test("single-threaded: no use-after-free, no double free", () => {
    const r = runUnderAsan(PATHS, "st", "1");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.status).toBe(0);
    expectFlat(r.stdout, ["delivered", "undelivered", "refused"]);
  });

  test("4 schedulers: no use-after-free, no double free", () => {
    const r = runUnderAsan(PATHS, "mt", "4");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.status).toBe(0);
    expectFlat(r.stdout, ["delivered", "undelivered", "refused"]);
  });
});
