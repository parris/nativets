/*
 * A BRANCH THAT LEAVES THE FUNCTION DOES NOT MERGE ITS MOVES INTO THE JOIN.
 *
 * `IfStmt`/`SwitchStmt` in src/ownership.ts join their arms with `merge` (may-move,
 * join = OR) unconditionally, so an arm that `return`s or `throw`s — code the join is
 * NEVER reached from — still poisoned every name it consumed for the statements after
 * the `if`. Two defects fall out of that one omission, and they have to be fixed
 * together because the fix for the first is what makes the second observable:
 *
 *   B  A FALSE NT1601, live on main and nothing to do with exceptions:
 *          if (c) return a;      // moves `a` — and LEAVES
 *          return [a.length];    // refused: "use of moved value: `a`"
 *      node prints `3 3`; we refused to compile it.
 *
 *   A  A SILENT DOUBLE FREE. A `throw` of a linear local declared OUTSIDE the `try`
 *      handed the pointer to the catch binding — which ownership.ts makes an OWNER, and
 *      codegen's in-frame lowering stores into without touching the thrower's slot — while
 *      the local stayed an owner too. One block, two frees: exit 255, EMPTY stdout, no
 *      diagnostic, against node's `76`. Making the `throw` CONSUME its argument is the fix
 *      (the `condDrops`/`nullOnMove` drop flag then nulls the local's slot at the raise),
 *      and it is exactly what turns B's shape into a regression for `throw`:
 *      `if (c) { throw err; } return err.message.length;` is a program node accepts.
 *
 * WHAT IS DELIBERATELY *NOT* RELAXED, because ownership is the memory-safety guarantee:
 *
 *   - a NON-diverging branch (`if (c) { const b = a; } use(a);`) stays NT1601;
 *   - `break`/`continue` still merge. They leave the BLOCK, not the FUNCTION, and the
 *     loop-exit join is fed from exactly the state they would have been dropped from —
 *     so skipping them would accept a real use-after-move (`breakMustStayRefused`);
 *   - anything lexically inside a `try` still merges. A `return` there runs the
 *     `finally`, and a `throw` runs the `catch` and the `finally`; those are program
 *     points REACHED FROM the diverging branch, and they read this state.
 *
 * node is the oracle for stdout AND the exit code — bug A's whole signature is exit 255
 * with empty stdout, so "no output" is never on its own evidence of anything. The leak
 * probes are SCALED (two sizes, in a loop): a fixture whose frame exits proves nothing,
 * and LeakSanitizer is Linux-only, so on macOS a double free is silent without ASan.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Compile and run, and assert stdout AND exit code both equal `node`'s. */
async function matchesNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Assert the program is REFUSED with the given NT code — the safety direction. */
async function refused(source: string, code: string): Promise<void> {
  let msg = "";
  try { await compileAndRun(source); } catch (e) { msg = String(e); }
  expect(msg).toContain(code);
}

/** Emit with ASan forced on, build, run. Shape copied from test/exc-move.test.ts, where
 *  the reason lives: ASan only rewrites `define`s carrying `sanitize_address`, so the
 *  attribute is ASSERTED rather than assumed — an uninstrumented binary that reports
 *  nothing is not evidence. A double free is caught inside `free()` either way; a
 *  use-after-free READ is invisible without it. */
function runUnderAsan(source: string, tag: string): { status: number | null; stdout: string; stderr: string } {
  const prev = process.env["NATIVETS_ASAN"];
  process.env["NATIVETS_ASAN"] = "1";
  let ll = "";
  try { ll = emitIR(source); } finally {
    if (prev === undefined) delete process.env["NATIVETS_ASAN"];
    else process.env["NATIVETS_ASAN"] = prev;
  }
  expect(ll).toContain("attributes #99 = { sanitize_address }");
  for (const d of ll.split("\n").filter((l) => l.startsWith("define "))) expect(d.endsWith("#99 {")).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), `nativets-movediverge-${tag}-`));
  try {
    const llPath = join(dir, "module.ll");
    writeFileSync(llPath, ll);
    const bin = join(dir, "prog");
    const built = spawnSync("clang", [
      "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
      llPath, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(built.stderr.includes("error:")).toBe(false);
    const run = spawnSync(bin, [], { encoding: "utf8", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a diverging branch does not merge its moves", () => {
  test("B: a branch that returns the value does not poison the fall-through", async () => {
    await matchesNode(`
function g(c: boolean): number[] {
  const a: number[] = [1, 2, 3];
  if (c) return a;
  return [a.length];
}
console.log(g(true).length, g(false)[0]);
`);
  });

  test("the ELSE arm is the one that leaves", async () => {
    await matchesNode(`
function g(c: boolean): number[] {
  const a: number[] = [1, 2, 3];
  if (c) { console.log("hi"); } else { return a; }
  return [a.length];
}
console.log(g(false).length, g(true)[0]);
`);
  });

  test("BOTH arms leave, each moving the same value once", async () => {
    await matchesNode(`
function g(c: boolean): number[] {
  const a: number[] = [1, 2, 3];
  if (c) { return a; }
  return a;
}
console.log(g(true).length, g(false).length);
`);
  });

  test("a switch case that returns", async () => {
    await matchesNode(`
function g(c: number): number[] {
  const a: number[] = [1, 2, 3];
  switch (c) { case 1: return a; default: break; }
  return [a.length];
}
console.log(g(1).length, g(0)[0]);
`);
  });

  test("the diverging arm is nested two `if`s deep", async () => {
    await matchesNode(`
function g(c: boolean, d: boolean): number {
  const a: number[] = [1, 2, 3];
  if (c) { if (d) { const b: number[] = a; return b.length; } console.log("no"); }
  return a.length;
}
console.log(g(true, true), g(true, false), g(false, false));
`);
  });

  test("a returning branch inside a WHILE body, used after the loop", async () => {
    await matchesNode(`
function g(n: number): number {
  const a: number[] = [1, 2, 3];
  let i = 0;
  while (i < n) { if (i === 0) { const b: number[] = a; return b.length; } i = i + 1; }
  return a.length;
}
console.log(g(1), g(0));
`);
  });

  test("a branch that THROWS also leaves", async () => {
    await matchesNode(`
function g(c: boolean): number {
  const a: number[] = [1, 2, 3];
  if (c) { const b: number[] = a; throw new Error("n" + b.length); }
  return a.length;
}
console.log(g(false));
`);
  });
});

/* The safety direction. Each of these is a program `node` accepts and we refuse; every
 * one of them would be a use-after-free or a double free if `escapes` were widened by one
 * more condition, so they are pinned as REFUSALS on purpose. Relaxing any of them needs
 * the dataflow to grow a second, exceptional state — not a wider predicate. */
describe("the refusal still fires where the branch does NOT leave", () => {
  test("a non-diverging arm still poisons the join", async () => {
    await refused(`
function g(c: boolean): number {
  const a: number[] = [1, 2, 3];
  if (c) { const b: number[] = a; console.log(b.length); }
  return a.length;
}
console.log(g(true));
`, "NT1601");
  });

  test("a move carried out of a loop by BREAK still poisons the loop exit", async () => {
    await refused(`
function g(n: number): number {
  const a: number[] = [1, 2, 3];
  for (let i = 0; i < n; i++) { if (i === 0) { const b: number[] = a; console.log(b.length); break; } }
  return a.length;
}
console.log(g(1));
`, "NT1601");
  });

  test("an arm holding BOTH a break and a return keeps the merge", async () => {
    // The `return` alone would make this arm look diverging; the `break` path leaves it
    // with `a` moved and lands on the loop exit, which is where `a.length` is read.
    await refused(`
function g(n: number, d: boolean): number {
  const a: number[] = [1, 2, 3];
  for (let i = 0; i < n; i++) { if (i === 0) { const b: number[] = a; if (d) break; return b.length; } }
  return a.length;
}
console.log(g(1, true));
`, "NT1601");
  });

  test("a FINALLY that reads a value the returning branch moved", async () => {
    await refused(`
function g(c: boolean): number {
  const a: number[] = [1, 2, 3];
  try { if (c) { const b: number[] = a; return b.length; } } finally { console.log("fin", a.length); }
  return a.length;
}
console.log(g(true));
`, "NT1601");
  });

  test("a loop body that returns does not diverge — the loop may run zero times", async () => {
    await refused(`
function g(n: number): number {
  const a: number[] = [1, 2, 3];
  for (let i = 0; i < n; i++) { const b: number[] = a; return b.length; }
  return a.length;
}
console.log(g(0));
`, "NT1601");
  });
});

/* MEMORY. LeakSanitizer is Linux-only, so on macOS both a leak and a double free are
 * silent — the live counters are the portable instrument, and they are read in a LOOP at
 * TWO scales: a fixture that returns 0 because the frame exited proves nothing about a
 * leak proportional to work. A value moved only in a branch that leaves is no longer
 * `condDrops`, so it no longer nulls its slot on the way out; these pin that the drop
 * that DOES run still runs exactly once. */
describe("the newly-accepted programs allocate and free exactly once", () => {
  test("scaled: the fall-through path frees, the returning path hands off", async () => {
    // `__arrLive` is a nativets builtin node has no answer for, so this one is pinned
    // against exact values rather than run differentially. The stdout arithmetic IS
    // checked against node by the `B:` test above; what is new here is the counter, read
    // at TWO scales 4x apart — a leak proportional to work shows as a rising number, a
    // constant one is not a leak.
    const r = await compileAndRun(`
function g(c: boolean): number[] {
  const a: number[] = [1, 2, 3];
  if (c) return a;
  return [a.length];
}
function run(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) { const r: number[] = g(i % 2 === 0); t = t + r.length; }
  return t;
}
console.log(run(100));
console.log(__arrLive());
console.log(run(400));
console.log(__arrLive());
`);
    expect(r.stdout).toBe("200\n0\n800\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("ASan: no double free and no use-after-free on the diverging paths", () => {
    const r = runUnderAsan(`
function g(c: boolean): number[] {
  const a: number[] = [1, 2, 3];
  if (c) return a;
  return [a.length];
}
function h(c: boolean): number {
  const a: number[] = [1, 2, 3];
  if (c) { const b: number[] = a; return b.length; }
  return a.length;
}
let t = 0;
for (let i = 0; i < 200; i++) { t = t + g(i % 2 === 0).length + h(i % 3 === 0); }
console.log(t);
`, "divarr");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.stdout).toBe("1000\n"); // 100*3 + 100*1 from `g`, 200*3 from `h` — and node agrees
    expect(r.status).toBe(0);
  });
});
