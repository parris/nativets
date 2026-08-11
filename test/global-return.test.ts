/*
 * A FUNCTION MAY NOT HAND OUT A MODULE-LEVEL BINDING.
 *
 *     const shared = { a: 1 };
 *     function getShared(): { a: number } { return shared; }
 *     const x = getShared();
 *     console.log(shared.a, x.a);          // node: "1 1", exit 0
 *
 * `shared` and `x` both became owners, so `main` emitted two consecutive
 * `nt_obj_free`s on ONE pointer. The compiled binary died in the allocator with exit
 * 133/134 and — the whole reason this went unnoticed — an EMPTY stdout AND an EMPTY
 * stderr, because the abort discards the buffered stream. A differential test that only
 * compares stdout sees two empty strings and passes whenever node also printed nothing,
 * so "no output" is never on its own evidence here: every case below asserts the EXIT
 * CODE too, and the double free itself is pinned by ASan (`attempting double-free`),
 * which does work on macOS where LeakSanitizer does not.
 *
 * WHICH RULE. Three were on the table:
 *
 *   1. REFUSE it — the module scope owns the binding and drops it at program end, so a
 *      function body only BORROWS it. This is what landed: same NT1604 band, same
 *      machinery, as a by-borrow parameter escaping via `return o`.
 *   2. Make the return a BORROW the caller does not own. That is a return-position
 *      borrow FEATURE, not a bug fix — every call site and every onward use would have
 *      to be proven not to outlive the module. The argument-temporary lane declined the
 *      identical license for exactly this reason.
 *   3. MOVE the global — wrong, and the one option that produces a wrong ANSWER rather
 *      than a refusal: node reads `shared.a` fine after the call (`readsAfterTheCall`).
 *
 * WHAT STAYS LEGAL is the other half of the rule and is asserted just as hard: reads
 * through the binding, a field OF it, a fresh value built from it, and strings — which
 * are refcounted, not linear, and were never affected.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, runWithNode, emitIR } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

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

/** The thrown diagnostic itself — the HINT does not survive `String(e)`, and the hint is
 *  the half of a refusal a reader acts on. */
function thrown(src: string): NTError | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e : null; }
}

/** Emit with ASan forced on, build, run. Shape borrowed from test/move-diverge.test.ts,
 *  where the reason lives: ASan only rewrites `define`s carrying `sanitize_address`, so
 *  the attribute is ASSERTED rather than assumed — an uninstrumented binary that reports
 *  nothing is not evidence. */
function runUnderAsan(source: string, tag: string): { status: number | null; stdout: string; stderr: string } {
  const prev = process.env["NATIVETS_ASAN"];
  process.env["NATIVETS_ASAN"] = "1";
  let ll = "";
  try { ll = emitIR(source); } finally {
    if (prev === undefined) delete process.env["NATIVETS_ASAN"];
    else process.env["NATIVETS_ASAN"] = prev;
  }
  expect(ll).toContain("attributes #99 = { sanitize_address }");
  const defines = ll.split("\n").filter((l) => l.startsWith("define "));
  expect(defines.length).toBeGreaterThan(0);
  for (const d of defines) expect(d.endsWith("#99 {")).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), `nativets-globret-${tag}-`));
  try {
    const llPath = join(dir, "module.ll");
    writeFileSync(llPath, ll);
    const bin = join(dir, "prog");
    const built = spawnSync("clang", [
      "-O1", "-g", "-fsanitize=address", "-fno-sanitize-recover=all",
      llPath, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(built.stderr.includes("error:")).toBe(false);
    const run = spawnSync(bin, [], { encoding: "utf8", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The refusals — every route a module-level binding can leave a frame. *
 * ------------------------------------------------------------------ */

describe("a module-level binding may not escape a function", () => {
  test("the original: returning a module-level object", async () => {
    await refused(`
const shared = { a: 1 };
function getShared(): { a: number } { return shared; }
const x = getShared();
console.log(shared.a, x.a);
`, "NT1604");
  });

  test("a module-level ARRAY behaves identically — it is linear for the same reason", async () => {
    await refused(`
const shared: number[] = [1, 2];
function get(): number[] { return shared; }
const x = get();
console.log(shared.length, x.length);
`, "NT1604");
  });

  test("laundering it through a local first does not help", async () => {
    await refused(`
const shared = { a: 1 };
function get(): { a: number } { const t = shared; return t; }
const x = get();
console.log(shared.a, x.a);
`, "NT1604");
  });

  /* The `return`-free half of the bug: binding the global to a local makes the LOCAL an
   * owner, and the function drops it at exit — the global is freed while `main` still
   * holds it, and freed again at program end. No `return` is involved at all. */
  test("binding it to a local is refused even when nothing is returned", async () => {
    await refused(`
const shared = { a: 1 };
function readIt(): number { const t = shared; return t.a; }
console.log(readIt(), shared.a);
`, "NT1604");
  });

  test("two frames deep is still one pointer", async () => {
    await refused(`
const shared = { a: 1 };
function inner(): { a: number } { return shared; }
function outer(): { a: number } { return inner(); }
const x = outer();
console.log(shared.a, x.a);
`, "NT1604");
  });

  test("smuggling it out inside an object literal", async () => {
    await refused(`
const shared = { a: 1 };
function get(): { w: { a: number } } { return { w: shared }; }
const x = get();
console.log(shared.a, x.w.a);
`, "NT1604");
  });

  test("smuggling it out inside an array literal", async () => {
    await refused(`
const shared = { a: 1 };
function get(): { a: number }[] { return [shared]; }
const x = get();
console.log(shared.a, x[0].a);
`, "NT1604");
  });

  test("a conditional return is still a return", async () => {
    await refused(`
const shared = { a: 1 };
function get(c: boolean): { a: number } { if (c) { return shared; } return { a: 2 }; }
const x = get(true);
console.log(shared.a, x.a);
`, "NT1604");
  });

  test("`let` is no different from `const` — the module frees it either way", async () => {
    await refused(`
let shared = { a: 1 };
function get(): { a: number } { return shared; }
const x = get();
console.log(shared.a, x.a);
`, "NT1604");
  });

  /* Discarding the result does not make it safe: the RULE is about the frame the value
   * leaves, and the call site is free to bind it tomorrow. (It also happens to be the one
   * case the argument-temporary lane deliberately left un-freed, so a caller-side fix
   * could never have covered it.) */
  test("even a discarded result is refused", async () => {
    await refused(`
const shared = { a: 1 };
function get(): { a: number } { return shared; }
get();
console.log(shared.a);
`, "NT1604");
  });

  /* An arrow's EXPRESSION body is a return, but it was walked as a pure borrow, so the
   * two spellings of one arrow disagreed: `=> { return shared; }` was already NT1601 and
   * `=> shared` compiled into the double free. */
  test("an arrow's expression body is a return too", async () => {
    await refused(`
const shared = { a: 1 };
const get = (): { a: number } => shared;
const x = get();
console.log(shared.a, x.a);
`, "NT16");
  });

  test("...and agrees with its own braced spelling", async () => {
    await refused(`
const shared = { a: 1 };
const get = (): { a: number } => { return shared; };
const x = get();
console.log(shared.a, x.a);
`, "NT16");
  });

  test("an arrow nested inside a function does not get a second opinion", async () => {
    await refused(`
const shared = { a: 1 };
function outer(): { a: number } {
  const g = (): { a: number } => shared;
  return g();
}
const x = outer();
console.log(shared.a, x.a);
`, "NT1604");
  });

  /*
   * CALLING THE ARROW TWICE — the hole every case above walked past.
   *
   * Each arrow test written when this rule landed reads the global AGAIN after the call
   * (`console.log(shared.a, x.a)`), and that later read is what trips NT1601: the
   * expression body CONSUMES `shared`, so the pass records one move and the second
   * mention is a use-after-move. Correct, but it masks the actual question. Delete that
   * read and call the arrow TWICE and the move accounting is simply wrong — a body that
   * moves a value runs once per CALL, so two calls hand the same pointer to two owners
   * and `main` frees it twice. Measured before the fix: node "1 1" exit 0, ours EMPTY
   * stdout and exit 133, for BOTH spellings.
   *
   * The annotation is not what separates the two — `(): {a:number} => shared` dies
   * identically. Every earlier arrow case merely happened to carry one.
   */
  test("an arrow called TWICE hands out two owners", async () => {
    await refused(`
const shared = { a: 1 };
const get = () => shared;
const x = get();
const y = get();
console.log(x.a, y.a);
`, "NT1604");
  });

  test("...and the annotation makes no difference to that", async () => {
    await refused(`
const shared = { a: 1 };
const get = (): { a: number } => shared;
const x = get();
const y = get();
console.log(x.a, y.a);
`, "NT1604");
  });

  /* A single call was equally unsound — it just could not be caught by counting moves,
   * because one call really is one move. The rule is about the BODY, not the call count. */
  test("...and a SINGLE call is refused too, for the same reason", async () => {
    await refused(`
const arr = [1, 2, 3];
const g = () => arr;
const a = g();
console.log(a.length);
`, "NT1604");
  });

  test("a class METHOD is not a different frame for this purpose", async () => {
    await refused(`
const shared = { a: 1 };
class Holder {
  get(): { a: number } { return shared; }
}
const h = new Holder();
const x = h.get();
console.log(shared.a, x.a);
`, "NT1604");
  });

  /* The route with no `return` and no local: assigning one module binding to ANOTHER from
   * inside a function. Both slots then name one pointer and the module frees it twice. */
  test("assigning a global to a global from inside a function", async () => {
    await refused(`
let a = { n: 1 };
let b = { n: 2 };
function swapIn(): void { b = a; }
swapIn();
console.log(a.n, b.n);
`, "NT1604");
  });

  /* SH1 merges the import graph into one Program, so a global reached across a module
   * boundary is the same binding under a mangled name — and had the same double free. */
  test("across a module boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-globret-xmod-"));
    try {
      writeFileSync(join(dir, "lib.ts"), `const shared = { a: 1 };
export function getShared(): { a: number } { return shared; }
`);
      const main = join(dir, "main.ts");
      writeFileSync(main, `import { getShared } from "./lib.ts";
const x = getShared();
console.log(x.a);
`);
      const run = spawnSync("bun", ["run", join(ROOT, "src/cli.ts"), "run", main], { encoding: "utf8" });
      expect(`${run.stdout ?? ""}${run.stderr ?? ""}`).toContain("NT1604");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------------------------------------------------------- *
 * The other half: what a module-level binding may STILL do.   *
 * ---------------------------------------------------------- */

describe("reading through a module-level binding stays legal", () => {
  test("a field read", async () => {
    await matchesNode(`
const shared = { a: 1 };
function readIt(): number { return shared.a; }
console.log(readIt(), shared.a);
`);
  });

  test("a for-of over a module-level array", async () => {
    await matchesNode(`
const items: number[] = [1, 2, 3];
function total(): number { let s = 0; for (const v of items) { s = s + v; } return s; }
console.log(total(), items.length);
`);
  });

  /* Strings are REFCOUNTED, not linear, so they were never part of this bug — asserted
   * rather than assumed, because "it happens to work" and "it cannot break" are
   * different claims and only one of them survives a refactor. */
  test("a module-level string may be returned", async () => {
    await matchesNode(`
const name = "hi";
function get(): string { return name; }
const x = get();
console.log(name, x);
`);
  });

  test("a FIELD of a module-level object may be returned", async () => {
    await matchesNode(`
const shared = { inner: { a: 1 } };
function get(): { a: number } { return shared.inner; }
const x = get();
console.log(shared.inner.a, x.a);
`);
  });

  test("a freshly built value may be returned", async () => {
    await matchesNode(`
const shared = { a: 1 };
function copyOf(): { a: number } { return { a: shared.a }; }
console.log(copyOf().a, shared.a);
`);
  });

  /* Option 3 ("move the global") would have compiled and printed the wrong thing here
   * rather than refusing — this is the assertion that rules it out. */
  test("readsAfterTheCall: the module binding is live after every call", async () => {
    await matchesNode(`
const shared = { a: 1 };
function readIt(): number { return shared.a; }
console.log(readIt());
console.log(shared.a);
console.log(readIt(), shared.a);
`);
  });

  /* A function that declares its OWN binding of the same name owns it, and must keep the
   * right to hand it out — the refusal is about the module's binding, not the spelling.
   *
   * `reader` is load-bearing and the test was VACUOUS without it: `checked.globals` holds
   * only the module bindings some function body actually READS, so with `get` alone the
   * global set is empty, the rule never runs, and deleting the shadow subtraction changes
   * nothing. `reader` puts `shared` in that table, which is what makes `get`'s local
   * collide with it. */
  test("a function's own binding that SHADOWS a global is still its own", async () => {
    await matchesNode(`
const shared = { a: 1 };
function reader(): number { return shared.a; }
function get(): { a: number } { const shared = { a: 2 }; return shared; }
console.log(reader(), get().a);
`);
  });

  /* The same collision one level down, where `alphaRenameShadows` — not the subtraction —
   * is what keeps the two apart: a nested-block `const` of a module name is renamed to
   * `shared.N`, so it can never be mistaken for the global. */
  test("a shadow in a nested BLOCK is its own binding too", async () => {
    await matchesNode(`
const shared = { a: 1 };
function reader(): number { return shared.a; }
function get(c: boolean): number {
  if (c) { const shared = { a: 2 }; return shared.a; }
  return 0;
}
console.log(reader(), get(true), get(false));
`);
  });

  /* A PARAMETER named like a global is the other pinned scope, and it is a by-borrow
   * parameter — so it must land in the parameter arm of NT1604, not the module arm. */
  test("a parameter that shadows a global is a parameter", async () => {
    await matchesNode(`
const shared = { a: 1 };
function reader(): number { return shared.a; }
function useIt(shared: { a: number }): number { return shared.a; }
console.log(reader(), useIt({ a: 7 }));
`);
    const e = thrown(`
const shared = { a: 1 };
function reader(): number { return shared.a; }
function steal(shared: { a: number }): { a: number } { return shared; }
console.log(reader(), steal({ a: 7 }).a);
`);
    expect(e?.diag.code).toBe("NT1604");
    expect(e?.diag.message).toContain("it is borrowed");
    expect(e?.diag.message).not.toContain("module-level binding");
  });

  /* Every rewrite the NT1604 hint suggests, compiled against node in one program. A hint
   * that does not compile is worse than no hint, and this file's band has shipped several. */
  test("the hint's advice compiles", async () => {
    await matchesNode(`
const shared = { a: 1 };
const items: number[] = [1, 2, 3];
function readField(): number { return shared.a; }
function sumItems(): number { let s = 0; for (const v of items) { s = s + v; } return s; }
function lengthOf(): number { return items.length; }
function copyOf(): { a: number } { return { a: shared.a }; }
function fresh(): { a: number } { const own = { a: 9 }; return own; }
console.log(readField(), sumItems(), lengthOf());
console.log(copyOf().a, fresh().a);
console.log(shared.a, items.length);
`);
  });

  test("the hint names a borrow that fits the TYPE", () => {
    const obj = thrown(`
const shared = { a: 1 };
function get(): { a: number } { return shared; }
console.log(get().a);
`);
    expect(obj?.diag.code).toBe("NT1604");
    expect(obj?.diag.hint).toContain("return shared.field");
    // Advice that does not compile is worse than none: an object has no `for-of`.
    expect(obj?.diag.hint).not.toContain("for (const v of shared)");

    const arr = thrown(`
const shared: number[] = [1];
function get(): number[] { return shared; }
console.log(get().length);
`);
    expect(arr?.diag.code).toBe("NT1604");
    expect(arr?.diag.hint).toContain("for (const v of shared)");
    expect(arr?.diag.hint).toContain("return shared.length");
  });
});

/* ------------------------------------------------ *
 * The leak/double-free instruments, at two scales.  *
 * ------------------------------------------------ */

describe("the accepted shapes neither leak nor double-free", () => {
  /* `__objLive` and friends are nativets-only probes, so node is NOT the oracle here —
   * the claim is that the two scales agree with EACH OTHER. A single-pass fixture proves
   * nothing: one leak per call and one double free per call both look like a clean run at
   * n=1, and on macOS LeakSanitizer does not exist to say otherwise. */
  test("live counts are identical at 10 and 1000 iterations", async () => {
    const r = await compileAndRun(`
const shared = { inner: { a: 1 } };
const items: number[] = [1, 2, 3];
function readIt(): number { return shared.inner.a; }
function total(): number { let s = 0; for (const v of items) { s = s + v; } return s; }
function scale(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { s = s + readIt() + total(); }
  return s;
}
console.log(scale(10));
console.log(__objLive(), __strLive(), __arrLive());
console.log(scale(1000));
console.log(__objLive(), __strLive(), __arrLive());
`);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("70");    // 10 * (1 + 6)
    expect(lines[2]).toBe("7000");  // 1000 * (1 + 6)
    expect(lines[3]).toBe(lines[1]); // the whole point: no drift with scale
  });

  /* THE PIN. This is the program the lane was opened on, minus the `return` — it must run
   * clean under ASan, which is what proves the refusal above removed a real double free
   * rather than merely hidden the shape that produced it. */
  test("ASan is clean on the accepted rewrite", () => {
    const r = runUnderAsan(`
const shared = { a: 1 };
function readIt(): number { return shared.a; }
const x = readIt();
console.log(shared.a, x);
`, "clean");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.stdout).toBe("1 1\n");
    expect(r.status).toBe(0);
  });
});
