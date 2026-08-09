/*
 * CLOSURE ENVIRONMENT DROPS.
 *
 * Every arrow BOUND to a value allocates a heap env — `nt_obj_new(1 + caps.length)`,
 * a bare slot block holding `[fn_ptr, cap0, …]` — and until this file nothing ever
 * freed one. One leak per arrow evaluated, so an arrow bound inside a loop leaked once
 * per ITERATION: unbounded. stdout is correct throughout, so only `__objLive()` (objects
 * allocated − freed) can see it, and `__arrLive()` cannot see it at all — the env is an
 * object, which is why `test/hof-drops.test.ts` measuring arrays alone missed it.
 *
 * The history is load-bearing. `isArrayTy` used to answer TRUE for a function type
 * (`"()=>number[]"` ends with `[]`), so closures WERE in the scope drop set — freed with
 * `nt_arr_free`, which reinterprets the bare slot block as an `NtArray{len,cap,data,pv}`
 * and frees two words past its end. A wild free: `const g = () => arr` died at exit 255.
 * Making function types answer *function* removed closures from the drop set entirely
 * and turned the corruption into this leak. So the fix here has two halves, and BOTH
 * are required:
 *   1. free the env as the OBJECT it is (`nt_obj_free`), never as an array;
 *   2. only where the binding is provably UNIQUELY OWNED.
 *
 * (2) is syntactic and deliberately narrow: a `const f = <arrow literal>` whose name is
 * used only as the callee of a direct call `f(…)`. Any other mention — returned, stored
 * in an array/object/field, passed as an argument, aliased by `const g = f`, mentioned
 * inside another arrow body, reassigned — disqualifies the binding and it keeps leaking.
 * That keeps the sanctioned escaping-counter idiom (`makeCounter`) working: its env
 * outlives the scope and must not be freed there.
 *
 * The env is freed SHALLOWLY, and that is the correct depth, not a shortcut: capture
 * slots are snapshots of values the ENCLOSING scope still owns and still drops, so
 * walking them would be a double free. A capture is therefore never leaked BY the env.
 *
 * Exit codes are asserted everywhere on purpose: a double free presents as a NONZERO
 * EXIT WITH CORRECT STDOUT, which is exactly how the wild free above hid.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every shape in this file at once, run in a loop so a stale env would be reused and a
 *  double free would land on a block something else already owns: the dropped shapes
 *  (a plain call, a loop-local, an array-returning closure) next to the escaping ones
 *  (returned, aliased, argument, captured-by-a-closure). node prints 4950 and 4. */
const CLOSURE_CHURN = `
function apply(g: (n: number) => number, x: number): number { return g(x); }
function build(): () => number {
  const inner = (k: number): number => k + 1;
  const outer = (): number => inner(1);
  return outer;
}
function run(): number {
  let total = 0;
  let i = 0;
  while (i < 100) {
    const f = (k: number): number => k + i;
    const alias = f;
    const arrs = (): number[] => [i, i];
    total = total + f(0) + apply(alias, 0) - i - arrs().length + 2;
    i = i + 1;
  }
  return total;
}
console.log(run());
console.log(build()() + build()());`;

describe("closure environment drops", () => {
  // THE BUG, in its smallest form. The arrow captures NOTHING, so this is not about
  // captures — it is one env per bound arrow, unconditionally. node prints 2.
  test("a bound arrow's env is freed at scope exit", async () => {
    const r = await compileAndRun(`
function run(): void {
  const f = (k: number): number => k + 1;
  console.log(f(1));
}
run();
console.log(__objLive());`);
    expect(r.stdout).toBe("2\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // THE UNBOUNDED CASE, and the reason this outranked the other Phase-C leaks: the
  // binding is per-ITERATION, so the leak grew with the loop — 100 envs for 100 turns.
  // The env is freed at the block's fall-through exit, so the count is 1 live at most.
  // node prints 4950.
  test("an arrow bound inside a loop frees its env every iteration", async () => {
    const r = await compileAndRun(`
function run(): number {
  let total = 0;
  let i = 0;
  while (i < 100) {
    const f = (k: number): number => k + i;
    total = total + f(0);
    i = i + 1;
  }
  return total;
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("4950\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // Three bound arrows leaked three envs; all three are the same shape, so all three go.
  // node prints 6.
  test("several bound arrows in one scope all free", async () => {
    const r = await compileAndRun(`
function run(): number {
  const a = (k: number): number => k + 1;
  const b = (k: number): number => k + 2;
  const c = (k: number): number => k + 3;
  return a(0) + b(0) + c(0);
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("6\n0\n");
    expect(r.exitCode).toBe(0);
  });

  /* --------------------------------------------------------------
   * CONTROLS. Everything below must NOT be freed. Each is a shape where a second
   * pointer to the env outlives the binding, so the assertion is a live count that
   * stays NONZERO — a leak, deliberately kept. The exit code is the real assertion:
   * were any of these dropped, stdout would still be right and the status would not.
   * -------------------------------------------------------------- */

  // THE SANCTIONED ESCAPING IDIOM (`test/fixtures/stage11/counter.ts`, bound form). The
  // env outlives `makeCounter`, so the scope that built it must not free it: `return inc`
  // is the disqualifying mention. node prints "1 2 3". 1 = the escaped env.
  test("control: an escaping counter's env is NOT freed", async () => {
    const r = await compileAndRun(`
function makeCounter(): () => number {
  let count = 0;
  const inc = (): number => { count++; return count; };
  return inc;
}
const c = makeCounter();
console.log(c(), c(), c());
console.log(__objLive());`);
    expect(r.stdout).toBe("1 2 3\n1\n");
    expect(r.exitCode).toBe(0);
  });

  // An ALIAS names the same env. Freeing through both handles is a double free, so the
  // mention disqualifies the binding and one env leaks. node prints 5.
  test("control: an aliased closure (`const g = f`) is NOT freed", async () => {
    const r = await compileAndRun(`
function run(): number {
  const f = (k: number): number => k + 4;
  const g = f;
  return g(1);
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("5\n1\n");
    expect(r.exitCode).toBe(0);
  });

  // Passed as an ARGUMENT: the callee could store or return the pointer, which this pass
  // analyses one scope at a time and cannot see. Conservative — a widening would need
  // the callee's own escape summary. node prints 6.
  test("control: a closure passed as an argument is NOT freed", async () => {
    const r = await compileAndRun(`
function apply(g: (n: number) => number, x: number): number { return g(x); }
function run(): number {
  const f = (k: number): number => k + 5;
  return apply(f, 1);
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("6\n1\n");
    expect(r.exitCode).toBe(0);
  });

  // Captured by a SECOND closure that escapes: `g`'s env holds `f`'s pointer, and `g`
  // outlives the scope, so freeing `f` there would hand the caller a dangling call
  // target. A mention inside an arrow body disqualifies for exactly this reason.
  // node prints 8. 2 = both envs.
  test("control: a closure another ESCAPING closure captures is NOT freed", async () => {
    const r = await compileAndRun(`
function build(): () => number {
  const f = (k: number): number => k + 7;
  const g = (): number => f(1);
  return g;
}
const h = build();
console.log(h());
console.log(__objLive());`);
    expect(r.stdout).toBe("8\n2\n");
    expect(r.exitCode).toBe(0);
  });

  /*
   * SHADOWING — found by this lane, and the reason `shadowedNames` used to exist.
   * Codegen gave a name ONE frame slot per function (`addLocal` returned early if the
   * name was known), so an inner `const f` OVERWROTE the outer's env pointer. The inner
   * block's drop then freed a block the outer name still calls through: this program
   * exited 255 before the guard, and exited 0 with BOTH envs leaked after it.
   *
   * The slot sharing was a MISCOMPILE independent of closures — the plain-value form is
   *
   *   const a: number = 1;
   *   if (a > 0) { const a: number = 2; console.log(a); }
   *   console.log(a);            // node: 2 then 1.  nativets used to print 2 then 2.
   *
   * — so stdout could not be asserted here at all without enshrining a wrong answer.
   * `alphaRenameShadows` (src/checker.ts, test/shadowing.test.ts) gives the two `f`s
   * different names, so there is nothing left to disqualify: node's answer IS asserted
   * now, and BOTH envs are freed rather than both leaked.
   */
  test("a SHADOWED closure binding gets its own slot, and both envs are freed", async () => {
    const src = `
function run(): number {
  const f = (k: number): number => k + 1;
  let out = f(1);
  if (out > 0) {
    const f = (k: number): number => k + 20;
    out = out + f(1);
  }
  return out + f(1);
}
console.log(run());`;
    const oracle = runWithNode(src);
    const r = await compileAndRun(`${src}\nconsole.log(__objLive());`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(oracle.stdout.trim()); // 2 + 21 + 2 = 25
    expect(r.stdout.trim().split("\n").at(-1)).toBe("0"); // neither env leaks
  });

  /* --------------------------------------------------------------
   * ANTI-REGRESSION for the WILD FREE this leak was the fix for. Both shapes freed a
   * closure env with `nt_arr_free` when `isArrayTy("()=>number[]")` answered true, which
   * frees `NtArray`'s `data`/`pv` words two slots past a block that has neither. The
   * first died at exit 255; the second printed the RIGHT ANSWER under the CLI and died
   * under the test harness from byte-identical IR. The env is an object and is freed
   * with `nt_obj_free` or not at all — so the EXIT CODE is the whole assertion here.
   * -------------------------------------------------------------- */

  test("anti-regression: `const g = () => arr` (a closure returning an array) exits clean", async () => {
    const r = await compileAndRun(`
function run(): number {
  const arr: number[] = [1, 2, 3];
  const g = (): number[] => arr;
  return g().length;
}
console.log(run());`);
    expect(r.stdout).toBe("3\n");
    expect(r.exitCode).toBe(0);
  });

  test("anti-regression: `() => [[n]]` (a nested-array closure) exits clean", async () => {
    const r = await compileAndRun(`
function run(): number {
  const n = 7;
  const g = (): number[][] => [[n]];
  return g()[0][0];
}
console.log(run());`);
    expect(r.stdout).toBe("7\n");
    expect(r.exitCode).toBe(0);
  });

  /*
   * The sanitizer gate — the only assertion here that can see a double free or a
   * use-after-free directly. `__objLive()` balancing to zero proves nothing about WHICH
   * block was freed, and a wild free two words past a block does not move the count at
   * all. Same construction as test/hof-drops.test.ts: ASan + UBSan, `-fno-sanitize-recover`
   * so every finding is fatal, LSan off (it does not exist on macOS, and the controls
   * above leak deliberately). The leak half is gated by `__objLive()` in the tests above.
   */
  test("ASan + UBSan: the closure-env drop paths are free of double frees and use-after-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-closenvasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIR(CLOSURE_CHURN));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        ll, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      const run = spawnSync(bin, [], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      expect(run.stderr).not.toContain("AddressSanitizer");
      expect(run.stderr).not.toContain("runtime error");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("4950\n4\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
