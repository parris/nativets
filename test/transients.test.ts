/*
 * B2 step 4 — REFERENCE COUNTING + TRANSIENTS: closing the remaining leaks.
 *
 * Stage 38 gave arrays a refcounted persistent trie, but the drop pass only freed
 * TOP-LEVEL linear locals, so two shapes still leaked — and now leaked trie nodes
 * with them:
 *
 *   1. REASSIGNMENT — `a = [...a, i]` in a loop abandoned the previous version.
 *   2. TEMPORARIES  — an array produced and never bound (`xs.slice(0,3).join()`).
 *
 * and a third was refused rather than solved:
 *
 *   3. CONDITIONAL MOVES — a value moved on one branch only was conservatively
 *      treated as moved everywhere, so it was never freed (rustc uses a drop flag).
 *
 * The counters are the witnesses: `__arrLive()` (allocated − freed array handles),
 * `__pvNodes()` (live trie nodes), `__objLive()`, `__strLive()`. They must return to
 * ZERO once every owner is out of scope — a leak shows up as a positive number, a
 * double free would show up as a crash (and is what the ASan run below rules out).
 *
 * TRANSIENTS (the performance half): when a persistent vector's refcount is 1 the
 * value is UNIQUELY owned, so mutating it in place is unobservable — Clojure's
 * transient trick, made provable here by the linear ownership model. `x = [...x, e]`
 * consumes `x` (the ownership pass proves the old version is dead), so the append
 * writes into the tail instead of cloning it. Every observable stays byte-identical
 * to node, and old-version-unchanged still holds whenever a second reference exists
 * — that is exactly what the refcount is telling us.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, expectMatchesNode, emitIR } from "./harness.ts";
import { ownershipCheck } from "../src/driver.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The idiomatic immutable loop-append (node-runnable: `[...a, i]` is plain ES). */
const BUILD = `
function build(n: number): number[] {
  let a: number[] = [];
  for (let i = 0; i < n; i = i + 1) { a = [...a, i]; }
  return a;
}`;

/** An n-element array built WITHOUT loop reassignment, so it is a plain flat block
 *  that the first `.with` freezes into the trie (same helper as sharing.test.ts). */
const BIG = `
function big(n: number): number[] {
  return "x".repeat(n).split("").map((c: string) => 1);
}`;

describe("leak 1: reassignment drops the superseded version", () => {
  test("loop-append of 100 leaves no live array and no live trie node", async () => {
    const src = `${BUILD}
function work(n: number): number {
  const t: number[] = build(n);
  return t[0] + t[n - 1] + t.length;
}
console.log(work(100));
console.log(__arrLive(), __pvNodes());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("199\n0 0\n");
  });
});

describe("leak 2: block-scoped values are dropped at their own scope exit", () => {
  test("a loop-body local is freed every iteration, not leaked 50 times", async () => {
    const src = `
function work(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i = i + 1) {
    const t: number[] = [i, i + 1, i + 2];
    s = s + t.length + t[0];
  }
  return s;
}
console.log(work(50));
console.log(__arrLive(), __objLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1375\n0 0\n"); // 50*3 + (0+1+...+49)
  });

  test("a conditional block's local is freed on the path that created it", async () => {
    const src = `
function f(c: boolean): number {
  let s: number = 0;
  if (c) {
    const t: { a: number } = { a: 7 };
    s = s + t.a;
  } else {
    const u: number[] = [1, 2];
    s = s + u.length;
  }
  return s;
}
console.log(f(true), f(false));
console.log(__arrLive(), __objLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("7 2\n0 0\n");
  });

  test("a return from inside a nested block still frees that block's local", async () => {
    const src = `
function f(c: boolean): number {
  const outer: number[] = [1, 2, 3];
  if (c) {
    const inner: number[] = [4, 5];
    return outer.length + inner.length;
  }
  return outer.length;
}
console.log(f(true), f(false));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("5 3\n0\n");
  });

  test("a nested value moved OUT of its block is not double-freed", async () => {
    const src = `
function pick(c: boolean): number[] {
  let out: number[] = [];
  if (c) {
    const t: number[] = [1, 2, 3];
    out = t;            // moves: t must NOT be dropped at block exit
  }
  return out;
}
function run(): number { const v: number[] = pick(true); return v.length; }
console.log(run(), pick(false).length);
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3 0\n1\n"); // the unbound pick(false) temp is the residual
  });
});

describe("leak 4: unbound temporaries in a chain are freed", () => {
  test("a chained builder's intermediate arrays do not accumulate", async () => {
    // `"…".split("")` and `.map(…)` each mint a fresh array; only the last one is
    // bound. The intermediates are dead the moment the next link has read them.
    const src = `
function f(n: number): number {
  let s: number = 0;
  for (let i = 0; i < n; i = i + 1) {
    s = s + "a,b,c".split(",").length;
    s = s + [1, 2, 3].map((x: number): number => x * 2).filter((x: number): boolean => x > 2).length;
  }
  return s;
}
console.log(f(100));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("500\n0\n");
  });

  test("the receiver-preserving .reverse() is never freed under the caller", async () => {
    // `.reverse` returns its RECEIVER (it mutates in place, like node). Freeing the
    // temp after the call would hand back freed memory — the one exclusion.
    const src = `
const a: number[] = [1, 2, 3].reverse();
const b: string = "x,y,z".split(",").reverse().join("-");
console.log(a.join(","), b, a.length);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("3,2,1 z-y-x 3\n");
  });

  test("a chain over trie-backed arrays still matches node", async () => {
    const src = `${BUILD}
const s: number = build(100).slice(10, 20).map((x: number): number => x + 1).reduce((a: number, x: number): number => a + x, 0);
console.log(s, build(40).toSorted((x: number, y: number): number => y - x)[0]);
console.log(build(50).filter((x: number): boolean => x % 10 === 0).join(","));`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

describe("leak 3: a conditionally-moved value still gets dropped (drop flags)", () => {
  test("moved on one branch only — freed on the branch that kept it", async () => {
    // rustc compiles this with a runtime DROP FLAG. Our equivalent is cheaper and needs
    // no extra slot: a move NULLS the variable, and free(NULL) is a no-op — so the drop
    // can be emitted unconditionally and the pointer IS the flag.
    const src = `
function f(c: boolean): number {
  const a: number[] = [1, 2, 3];
  let b: number[] = [];
  if (c) { b = move(a); }
  return b.length;
}
console.log(f(true), f(false));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3 0\n0\n");
  });

  test("conditionally moved in a loop, over many iterations", async () => {
    const src = `
function f(n: number): number {
  let kept: number = 0;
  for (let i = 0; i < n; i = i + 1) {
    const t: { a: number } = { a: i };
    let sink: { a: number } = { a: -1 };
    if (i % 2 === 0) { sink = move(t); }
    kept = kept + sink.a;
  }
  return kept;
}
console.log(f(10));
console.log(__arrLive(), __objLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("15\n0 0\n"); // 0+2+4+6+8 evens, -1 five times => 20-5
  });

  test("a conditional move is still a use-after-move error on the other path", async () => {
    // The drop flag must not weaken the CHECK: reading a maybe-moved value stays NT1601.
    const src = `
const a: number[] = [1, 2, 3];
let b: number[] = [];
if (a.length > 0) { b = move(a); }
console.log(a.length, b.length);`;
    const diags = ownershipCheck(src);
    expect(diags.map((d) => d.code)).toEqual(["NT1601"]);
  });
});

describe("memory safety: an array literal OWNS its elements", () => {
  test("returning [o1, o2] does not free the objects it points at", async () => {
    // Regression: array-literal elements were BORROWS, so `return [o1, o2]` dropped
    // both objects at scope exit while the escaping array still held their pointers —
    // a genuine use-after-free (it printed 4e-323 instead of 111). Elements now MOVE
    // into the array, exactly like object-literal fields.
    const src = `
function mk(): { a: number }[] {
  const o1: { a: number } = { a: 111 };
  const o2: { a: number } = { a: 222 };
  return [o1, o2];
}
const xs: { a: number }[] = mk();
const filler: number[] = [9, 9, 9, 9, 9, 9, 9, 9];
console.log(xs[0].a, xs[1].a, filler.length);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("111 222 8\n");
  });

  test("a nested array literal keeps its inner arrays alive", async () => {
    const src = `
function grid(): number[][] {
  const row1: number[] = [1, 2, 3];
  const row2: number[] = [4, 5, 6];
  return [row1, row2];
}
const g: number[][] = grid();
const filler: string[] = "abcdefgh".split("");
console.log(g[0][2], g[1][0], g.length, filler.length);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("3 4 2 8\n");
  });
});

describe("transients: rc == 1 ⇒ mutate in place", () => {
  test("a consuming append to a trie-backed array writes the tail in place", async () => {
    // `a` is frozen into the trie by the first `.with`; the loop then reassigns it, so
    // each append owns the vector outright (rc 1) and writes into the tail. Only the
    // 1-in-32 tail promotions allocate, so 96 appends cost a handful of nodes, not 96
    // tail clones (which is what the persistent path charges).
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const before: number = __pvAllocs();
for (let i = 0; i < 96; i = i + 1) { a = [...a, i]; }
console.log(a.length, a[100], a[195]);
console.log(__pvTransients(), __pvAllocs() - before < 20);`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("196 0 95\n92 true\n"); // 92 of 96 appends mutated in place
  });

  test("a second reference into the tail's LEAF disables the transient", async () => {
    // `.with(50, …)` on a 100-element vector writes in the TREE and therefore shares
    // the tail leaf with the source. The refcount says 2, so the following consuming
    // append must clone instead of mutating — and the snapshot must be untouched.
    // node runs the same program (the counters are stripped for the oracle).
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const snap: number[] = a.with(50, 77);
a = [...a, 999];
console.log(snap.length, snap[50], snap[0], snap[99]);
console.log(a.length, a[100], a[50], a[0]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a snapshot taken in the tail keeps its own leaf while the source mutates", async () => {
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const snap: number[] = a.with(99, 77);   // clones the tail: a keeps rc 1 on its own
a = [...a, 1].with(0, 3);
console.log(snap.length, snap[99], snap[0], a.length, a[99], a[100], a[0]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("many alternating snapshots stay independent (node is the oracle)", async () => {
    const src = `${BIG}
let a: number[] = big(40).with(0, 0);
let sum: number = 0;
for (let i = 0; i < 30; i = i + 1) {
  const snap: number[] = a.with(0, i);
  a = [...a, i];
  sum = sum + snap[0] + snap.length + a.length;
}
console.log(sum, a.length, a[0], a[40], a[69]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the consuming append is refused when the source is mentioned twice", async () => {
    // `x = [...x, x[0]]` — the second read happens AFTER the spread, so the storage
    // must NOT be handed over. (Ownership proves nothing about read ORDER; codegen
    // checks it syntactically.) node is the oracle.
    const src = `${BUILD}
let a: number[] = build(40);
a = [...a, a[0], a.length];
console.log(a.length, a[40], a[41], a[0], a[39]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("loop-append of 10k allocates no trie nodes and leaks nothing", async () => {
    // The performance witness, expressed as ALLOCATIONS so it is machine-independent:
    // the builder block is moved (not copied) from version to version, so 10k appends
    // cost zero node allocations and zero abandoned handles. Before B2 step 4 the same
    // program leaked 10001 array handles and 10561 trie nodes.
    const src = `${BUILD}
function work(): number { const t: number[] = build(10000); return t[9999]; }
console.log(work());
console.log(__arrLive(), __pvNodes(), __pvAllocs());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("9999\n0 0 0\n");
  });
});

/*
 * The sanitizer gate. Freeing MORE aggressively is only an improvement if it is still
 * memory-safe, and the counters above cannot see a double free or a use-after-free —
 * they would happily balance to zero while the program read freed memory. So the same
 * generated program (loop reassignment, transients, block scopes, conditional moves,
 * chained temporaries and two live snapshots sharing trie nodes) is compiled with
 * ASan + UBSan and RUN: any invalid access aborts it, and -fno-sanitize-recover makes
 * every UB finding fatal. Mirrors the C-level pattern of test/runtime/pvec_test.c.
 */
describe("sanitizers: no double free, no use-after-free", () => {
  const PROGRAM = `${BUILD}
${BIG}
function churn(n: number): number {
  let total: number = 0;
  for (let i = 0; i < n; i = i + 1) {
    const t: number[] = [i, i + 1, i + 2];
    let sink: number[] = [];
    if (i % 2 === 0) { sink = move(t); }                      // conditional move (drop flag)
    total = total + sink.length + "a,b,c".split(",").length;  // block drop + temporary
  }
  return total;
}
let v: number[] = big(100).with(0, 5);          // trie-backed
const snap: number[] = v.with(50, 77);          // shares v's tail leaf
const snap2: number[] = v.with(99, 88);         // clones the tail
for (let i = 0; i < 200; i = i + 1) { v = [...v, i]; }   // consuming appends
const objs: { a: number }[] = [{ a: 1 }, { a: 2 }];
const built: number[] = build(2000);
// .reverse() returns its RECEIVER, so revAlias is a second NAME for rev, not a second
// owner. Freeing it through both names was a double free — this is the ASan gate on it.
const rev: number[] = [1, 2, 3];
const revAlias: number[] = rev.reverse();
console.log(v.length, v[0], v[299], snap[50], snap2[99], snap.length);
console.log(built.length, built[1999], objs[1].a, churn(50));
console.log(built.slice(0, 4).map((x: number): number => x * 2).join(","));
console.log(revAlias.join(",") + "|" + rev.join(",") + "|" + [4, 5, 6].reverse().join(","));`;

  test("ASan + UBSan run of a program exercising every new drop path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-asan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIR(PROGRAM));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        "-DNT_PVEC", ll, join(ROOT, "runtime/runtime.c"), join(ROOT, "runtime/nt_pvec.c"),
        "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      // LeakSanitizer is OFF, deliberately, and this is the reason CI was red on Linux
      // while every macOS run was green: ASan enables LSan by default on Linux and
      // macOS HAS NO LSan, so the gate silently meant two different things per platform.
      //
      // What it is meant to mean is the sentence above — no double free, no
      // use-after-free — which is what -fno-sanitize-recover + ASan's access checks
      // give us. It is NOT a leak gate, and must not be: nativets *deliberately* leaks
      // at the boundaries Stage 44 documents (a container frees its handle, not what
      // its slots point at; module-level bindings; temporaries in non-chain positions).
      // This PROGRAM hits them on purpose — `objs = [{a:1},{a:2}]` is exactly the
      // documented container-element case, and top-level bindings die with main's frame,
      // so LSan calls them unreachable. Leaks are gated separately and precisely by the
      // live counters (__arrLive/__objLive/__pvNodes/nt_str_live) asserted above.
      //
      // The knob below makes that platform difference REPRODUCIBLE ON DEMAND instead of
      // only in CI: `NATIVETS_ASAN_LEAKS=1` turns LSan back on. On Linux (i.e. inside
      // `scripts/docker-test.sh`) the run then reports `LeakSanitizer: detected memory
      // leaks` and exits 23, so this test goes red exactly the way ubuntu's job did; on
      // macOS the same command is a no-op, because there is no LSan to enable. That is
      // the difference itself, on demand, in one command — see docs/docker-linux.md.
      // On macOS the flag is not merely inert — ASan REFUSES it ("detect_leaks is not
      // supported on this platform") and exits — so the knob is a no-op there, with a
      // note, and this gate stays green on the host exactly as before.
      const wantLeaks = process.env.NATIVETS_ASAN_LEAKS === "1";
      if (wantLeaks && process.platform === "darwin") {
        console.warn("NATIVETS_ASAN_LEAKS=1 ignored: macOS has no LeakSanitizer. Run `scripts/docker-test.sh test/transients.test.ts` to see the Linux behavior.");
      }
      const detectLeaks = wantLeaks && process.platform !== "darwin" ? "1" : "0";
      const asanEnv = { ...process.env, ASAN_OPTIONS: `detect_leaks=${detectLeaks}` };
      const run = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: asanEnv });
      expect(run.stderr).not.toContain("AddressSanitizer");
      expect(run.stderr).not.toContain("runtime error");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("300 5 199 77 88 100\n2000 1999 2 225\n0,2,4,6\n3,2,1|3,2,1|6,5,4\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
