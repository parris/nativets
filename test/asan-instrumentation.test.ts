/*
 * THE SANITIZER GATE ONLY WATCHED THE RUNTIME — the generated code was never instrumented.
 *
 * Several test files build a program with `clang -fsanitize=address,undefined` and assert
 * the run is clean, and their comments call that "the only assertion here that can see a
 * double free or a use-after-free" (test/hof-drops.test.ts, test/drops.test.ts,
 * test/transients.test.ts, test/closure-env-drops.test.ts). Half of that was not true.
 *
 * AddressSanitizer is an LLVM PASS, and it only rewrites functions carrying the
 * `sanitize_address` function attribute. Clang stamps that attribute on code it compiles
 * FROM SOURCE — which is `runtime/*.c`, and nothing else. The `.ll` nativets emits is
 * handed to the same clang driver already in IR form, with no attribute on any `define`,
 * so every load and store the compiler generates was left bare.
 *
 * The asymmetry that produces is exactly backwards from what the lane is for:
 *
 *   | fault                  | detected before? | why                                    |
 *   |------------------------|------------------|----------------------------------------|
 *   | double free            | YES              | caught inside `free()`, an allocator    |
 *   |                        |                  | interceptor — it never asks who called  |
 *   | heap-use-after-free    | NO               | needs a poison check on the READ, and   |
 *   |                        |                  | the read is in uninstrumented codegen   |
 *
 * A use-after-free READ that hands back stale memory at exit 0 is the silent-wrong-answer
 * class CLAUDE.md names as the worst outcome available, and it was the single fault the
 * gate could not see. It is also the fault an ownership lane is most likely to introduce:
 * every rule in ownership.ts exists to stop one name reading what another name freed.
 *
 * MEASURED, with an element-freeing drop spliced into `emitDrops` (lane-elemfree's probe):
 *
 *   type B = { v: number };
 *   function f(): number {
 *     const o = { inner: { v: 5 } };
 *     let t = 0;
 *     { const xs: B[] = [o.inner]; t = xs[0].v; }   // block drop frees o.inner
 *     return t + o.inner.v;                          // reads it back
 *   }
 *
 *   node                    -> 10
 *   nativets + element free ->  5, exit 0, ASan reported CLEAN
 *   the same binary, with `sanitize_address` on the defines
 *                           -> heap-use-after-free, exit 134
 *
 * `NATIVETS_ASAN=1` turns the attribute on (src/codegen.ts, `asanOn`). It is inert without
 * `-fsanitize=address`, so it costs nothing but a line of IR; it is opt-in only so that IR
 * snapshots do not move under every other lane.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { emitIR } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Emit IR with `NATIVETS_ASAN` forced on/off, restoring whatever it was. */
function emitWithAsan(source: string, on: boolean): string {
  const prev = process.env["NATIVETS_ASAN"];
  if (on) process.env["NATIVETS_ASAN"] = "1";
  else delete process.env["NATIVETS_ASAN"];
  try {
    return emitIR(source);
  } finally {
    if (prev === undefined) delete process.env["NATIVETS_ASAN"];
    else process.env["NATIVETS_ASAN"] = prev;
  }
}

/** Build `ll` under ASan+UBSan and run it. */
function buildAndRun(ll: string, tag: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), `nativets-asan-${tag}-`));
  try {
    const llPath = join(dir, "module.ll");
    writeFileSync(llPath, ll);
    const bin = join(dir, "prog");
    const built = spawnSync("clang", [
      "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
      llPath, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(built.stderr.includes("error:")).toBe(false);
    expect(built.status).toBe(0);
    const run = spawnSync(bin, [], {
      encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ASan instrumentation of the generated code", () => {
  const PROG = `
function f(): number { const o = { a: 1, b: 2 }; return o.a + o.b; }
console.log(f());
console.log(__objLive());`;

  test("OFF by default — no attribute, so nothing in the emitted IR is instrumented", () => {
    const ir = emitWithAsan(PROG, false);
    expect(ir).not.toContain("sanitize_address");
    expect(ir).not.toContain("#99");
  });

  test("NATIVETS_ASAN=1 stamps every `define` and appends the attribute group", () => {
    const ir = emitWithAsan(PROG, true);
    const defines = ir.split("\n").filter((l) => l.startsWith("define "));
    expect(defines.length).toBeGreaterThan(0);
    for (const d of defines) expect(d.endsWith("#99 {")).toBe(true);
    expect(ir).toContain("attributes #99 = { sanitize_address }");
  });

  test("the instrumented IR still builds, runs, and gives the same answer", () => {
    const r = buildAndRun(emitWithAsan(PROG, true), "same");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("3\n0\n"); // node prints 3
  });

  /*
   * THE POINT OF THE FILE. A use-after-free in nativets-SHAPED code — `nt_obj_new`, a
   * store, `nt_obj_free`, then a load of the freed slot, which is exactly what a future
   * per-type element destructor gets wrong when two names own one element.
   *
   * Hand-written IR rather than a compiled program, deliberately: no nativets source
   * produces this today (the ownership pass is doing its job), so pinning the GATE must
   * not wait on a live compiler bug. If it did, this test would be pinning the bug.
   */
  const UAF = (attr: string, attrDef: string) => `; ModuleID = 'uaf'
declare ptr @nt_obj_new(double)
declare void @nt_obj_free(ptr)
declare void @js_print_num(double)
declare void @js_print_newline()

define i32 @main(i32 %argc, ptr %argv)${attr} {
entry:
  %o = call ptr @nt_obj_new(double 1.000000e+00)
  store double 7.000000e+00, ptr %o
  call void @nt_obj_free(ptr %o)
  %v = load double, ptr %o
  call void @js_print_num(double %v)
  call void @js_print_newline()
  ret i32 0
}
${attrDef}
`;

  test("WITHOUT the attribute a use-after-free READ is invisible — the gap this closes", () => {
    const r = buildAndRun(UAF("", ""), "uafoff");
    expect(r.stderr).not.toContain("heap-use-after-free");
    expect(r.status).toBe(0); // reads freed memory and exits 0: the silent wrong answer
  });

  test("WITH the attribute the same read is caught as heap-use-after-free", () => {
    const r = buildAndRun(UAF(" #99", "attributes #99 = { sanitize_address }"), "uafon");
    expect(r.stderr).toContain("heap-use-after-free");
    expect(r.status).not.toBe(0);
  });

  /*
   * The half that ALREADY worked, pinned so the table in the header stays honest: a
   * double free is caught either way, because the detection lives in `free()` rather than
   * at the call site. This is why every earlier ASan finding in this repo was a double
   * free or a crash, and never a stale read.
   */
  const DF = (attr: string, attrDef: string) => `; ModuleID = 'df'
declare ptr @nt_obj_new(double)
declare void @nt_obj_free(ptr)

define i32 @main(i32 %argc, ptr %argv)${attr} {
entry:
  %o = call ptr @nt_obj_new(double 1.000000e+00)
  call void @nt_obj_free(ptr %o)
  call void @nt_obj_free(ptr %o)
  ret i32 0
}
${attrDef}
`;

  test("a DOUBLE FREE was already caught without the attribute (free() intercepts it)", () => {
    const r = buildAndRun(DF("", ""), "dfoff");
    expect(r.stderr).toContain("double-free");
    expect(r.status).not.toBe(0);
  });
});
