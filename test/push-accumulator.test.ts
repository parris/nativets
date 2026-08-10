/*
 * `.push` — the `@@mutable` ACCUMULATOR opt-in.
 *
 * Arrays are immutable (Stage 29) and `.push` has been refused with NT1606 since. It is
 * still refused. What changed is that ONE receiver shape is now legal: a `let`/`const`
 * binding carrying the `@@mutable` attribute (`//@@mutable` in its comment spelling, so
 * one source satisfies bun and nativets at once — docs/decorators.md).
 *
 * WHY, since the sanctioned `xs = [...xs, v]` is already O(1) amortized HERE. Because it
 * is not O(1) under BUN, and bun is stage 0 — it runs `src/*.ts` and the whole test suite
 * today. 30,000 appends, measured on this tree:
 *
 *     idiom                       bun        nativets
 *     xs = [...xs, v]           760 ms          4 ms
 *     xs.push(v)                  2 ms          0 ms
 *     builder + .build()        632 ms         20 ms
 *
 * `lex`'s `tokens` reaches ~35,000 elements on `src/checker.ts` alone, so the immutable
 * spelling would have made the suite unusable. See docs/ROADMAP.md for the standing
 * performance follow-up: the eventual immutable-first answer is a transient BUILDER that
 * is fast in both toolchains, and this opt-in is the deliberate interim trade.
 *
 * WHAT MAKES IT SOUND, since `@@mutable` means real in-place mutation in a linear memory
 * model. Exclusive access is not a new analysis — three facts the compiler already has
 * establish it, and the rejection table below pins each:
 *
 *   - an array is LINEAR: `const b = xs` MOVES, so a second live handle cannot exist and
 *     a push after one is the ordinary NT1601;
 *   - a PARAMETER is a borrow and cannot carry the attribute (it is on a `let`/`const`);
 *   - `this.f`, `xs[0]` and `f()` name no binding, so they never match the opt-in.
 *
 * The one hole those do not cover is a CLOSURE WITH AN ENV — a BOUND arrow copies the
 * array POINTER into a heap env this scope cannot null, and the closure may outlive the
 * binding — so a push to such a captured accumulator is NT1607.
 *
 * That rule used to be stated over "any arrow", which was wrong for the shape people
 * actually write: an INLINED HOF callback (`xs.forEach((x) => out.push(x))`) gets no env
 * at all — codegen emits its statements into the enclosing frame as a loop — so the
 * premise did not hold and the refusal cost a correct program for nothing. The two
 * describe blocks that follow are the split: what the relaxation buys, and the closure
 * shapes that keep the refusal because for THEM the premise is real (proved by mutation —
 * with the guard off, the returned-closure case is an ASan `heap-use-after-free` in
 * `nt_arr_push`, and the reassigned-binding case is a silent wrong answer at exit 0).
 *
 * node is the oracle for stdout AND exit code on every behavioural test here, because a
 * double free presents as a NONZERO EXIT with CORRECT STDOUT. The behaviours are mined
 * from test262 `test/built-ins/Array/prototype/push/` and cited per test.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** Both sides must agree on stdout AND exit code, and the program must print something. */
async function expectMatches(source: string) {
  const ours = await compileAndRun(source);
  const oracle = runWithNode(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  expect(ours.stdout.length).toBeGreaterThan(0);
}

/*
 * THE INLINED-HOF ARROW. `.forEach`/`.map`/… take an INLINE arrow literal (the checker
 * requires one — `inferForEach`, `inferHof`) and codegen emits its body straight into
 * the enclosing frame as a loop (`genForEach`, `genMap`). No `nt_obj_new` env is
 * allocated, no pointer is snapshotted, and the body cannot outlive the statement it is
 * written in: it IS the statement. So the closure rule's premise — "an arrow copies the
 * array pointer into an env this scope cannot null, and the closure may outlive the
 * binding" — is simply false here, and the shape below is exactly the `for-of` loop two
 * tests down, which has always compiled.
 */
describe("`.push` into an accumulator captured by an INLINED HOF arrow", () => {
  test("`src.forEach((x) => { out.push(x) })` — the most idiomatic accumulator shape", async () => {
    await expectMatches(`
const src: number[] = [1, 2, 3];
//@@mutable
const out: number[] = [];
src.forEach((x) => { out.push(x * 2); });
console.log(out.join(","), out.length);
`);
  });

  /*
   * EVERY inlined HOF, in ONE program, with the accumulator recording the callback's own
   * call order. The order is the load-bearing half: `.some`/`.find`/`.findIndex` STOP at
   * the first hit and `.every` stops at the first miss, so a lowering that ran the body
   * the wrong number of times would print a different log even with the right result.
   * `.toSorted`'s comparator is deliberately absent — it is a real closure (see below).
   */
  test("all nine inlined HOFs append to the same accumulator, in node's call order", async () => {
    await expectMatches(`
const src: number[] = [1, 2, 3, 4];
//@@mutable
const log: string[] = [];
const m = src.map((x) => { log.push("m" + String(x)); return x * 2; });
const f = src.filter((x) => { log.push("f" + String(x)); return x > 2; });
const r = src.reduce((acc: number, x: number) => { log.push("r" + String(x)); return acc + x; }, 0);
const fm = src.flatMap((x) => { log.push("x" + String(x)); return [x, -x]; });
const s = src.some((x) => { log.push("s" + String(x)); return x > 2; });
const e = src.every((x) => { log.push("e" + String(x)); return x > 0; });
const fd = src.find((x) => { log.push("d" + String(x)); return x === 3; });
const fi = src.findIndex((x) => { log.push("i" + String(x)); return x === 3; });
console.log(m.join(","), f.join(","), r, fm.join(","));
console.log(s, e, fd, fi);
console.log(log.join("|"), log.length);
`);
  });

  test("a STRING accumulator (the elements are heap values the array takes over)", async () => {
    await expectMatches(`
const src: string[] = ["a", "b"];
//@@mutable
const out: string[] = [];
src.forEach((x) => { out.push(x + "!"); });
console.log(out.join(","), out.length);
`);
  });

  test("NESTED inlined callbacks both append to an accumulator of the outer scope", async () => {
    await expectMatches(`
const a: number[] = [1, 2];
const b: number[] = [10, 20];
//@@mutable
const out: number[] = [];
a.forEach((x) => { b.forEach((y) => { out.push(x + y); }); });
console.log(out.join(","), out.length);
`);
  });

  /*
   * Appending to the array BEING iterated. node snapshots `length` before the walk, so the
   * callback runs exactly 3 times and never sees what it appended; `hofLoop` reads
   * `nt_arr_len` once into the pre-loop block, which is the same rule. Included because it
   * is the one shape where the accumulator and the receiver are the SAME allocation, and
   * `nt_arr_push` may reallocate `a->data` underneath the very loop that is reading it —
   * safe only because the NtArray HEADER is mutated in place and `arr_at` re-reads it.
   */
  test("`xs.forEach((x) => xs.push(x))` — length is snapshotted, exactly as node does", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [1, 2, 3];
xs.forEach((x) => { xs.push(x); });
console.log(xs.join(","), xs.length);
`);
  });

  test("an accumulator of ARRAYS: each callback-local row MOVES into it and reads back", async () => {
    await expectMatches(`
function build(): number {
  const src: number[] = [1, 2, 3];
  //@@mutable
  const out: number[][] = [];
  src.forEach((x) => { const row: number[] = [x, x + 1]; out.push(row); });
  return out.length + out[2][1];
}
console.log(build(), build());
`);
  });

  test("the accumulator is handed OUT of the function by move, and dropped by its new owner", async () => {
    await expectMatches(`
function doubled(src: number[]): number[] {
  //@@mutable
  const out: number[] = [];
  src.forEach((x) => { out.push(x * 2); });
  return out;
}
const r = doubled([1, 2, 3, 4]);
console.log(r.join(","), r.length);
`);
  });
});

/*
 * THE CONTROLS — the closure shapes that keep the refusal, and WHY each one has to.
 *
 * These are the load-bearing half of the relaxation above: the rule was narrowed from
 * "any arrow mentions it" to "an arrow WITH AN ENV mentions it", and if the second set
 * were empty the first row here would be a use-after-free rather than a diagnostic.
 * Proved by mutation — with the guard forced off, this exact source compiles and ASan
 * reports `heap-use-after-free ... READ of size 8 ... in nt_arr_push runtime.c`, freed by
 * `nt_arr_free`. The second row is the same guard catching a SILENT WRONG ANSWER instead:
 * with the guard off it exits 0 and prints `9 1` where node prints `9,1 2`.
 */
describe("closures that still get an ENV keep the NT1607 refusal", () => {
  test("a returned closure OUTLIVES the accumulator's scope — the use-after-free", () => {
    const got = rejectionOf(`
function mk(): (n: number) => number {
  //@@mutable
  const out: number[] = [];
  return (n: number) => out.push(n);
}
const g = mk();
console.log(g(1), g(2));
`);
    expect(got?.code).toBe("NT1607");
  });

  test("a bound arrow holds a STALE pointer once the binding is reassigned", () => {
    const got = rejectionOf(`
//@@mutable
let out: number[] = [];
const f = (n: number): number => out.push(n);
out = [9];
f(1);
console.log(out.join(","), out.length);
`);
    expect(got?.code).toBe("NT1607");
  });

  /* `.toSorted(cmp)` is NOT an inlined HOF: the comparator goes through `Module.cmpShim`,
   * which loads a `fn_ptr` out of a real `[fn_ptr, caps…]` env. It is a closure in every
   * sense the rule cares about, which is why `INLINED_HOFS` leaves it out. */
  test("the `.toSorted` COMPARATOR gets a real env, so it is not an inlined callback", () => {
    const got = rejectionOf(`
const src: number[] = [3, 1, 2];
//@@mutable
const log: number[] = [];
const out = src.toSorted((a: number, b: number) => { log.push(a); return a - b; });
console.log(out.join(","), log.length);
`);
    expect(got?.code).toBe("NT1607");
  });

  test("an inlined push is still refused when SOME OTHER arrow in the scope captures the name", () => {
    const got = rejectionOf(`
const src: number[] = [1, 2];
//@@mutable
const out: number[] = [];
const peek = (): number => out.length;
src.forEach((x) => { out.push(x); });
console.log(out.join(","), peek());
`);
    expect(got?.code).toBe("NT1607");
    // …and it says so, instead of prescribing the spelling the author already used.
    expect(got?.message).toContain("ANOTHER arrow");
    expect(got?.hint).toContain("the `.push` itself is fine");
  });

  /*
   * THE METHOD-NAME COLLISION, which is the trap this whole relaxation could have fallen
   * into: `INLINED_HOFS` matches on the method NAME, and a user class may declare its own
   * `.forEach` taking a real function value. `isInlinedHofArrow` therefore also requires
   * the RECEIVER to be an array — the same test `genExpr` uses to route into
   * `genArrayMethod` at all — and that guard is load-bearing, not decorative: with it
   * removed, this exact source compiles, because the arrow drops out of `envArrowNames`
   * and takes the whole refusal with it. Here the arrow really is a closure with an env
   * (`liftArrow` + `nt_obj_new`), so the premise holds and the refusal is right.
   */
  test("a USER CLASS's own `.forEach` is not an inlined HOF — the receiver type decides", () => {
    const got = rejectionOf(`
class Box {
  items: number[] = [];
  forEach(f: (n: number) => number): void {
    for (const x of this.items) f(x);
  }
}
const b = new Box();
//@@mutable
const out: number[] = [];
b.forEach((x) => { out.push(x); });
console.log(out.length);
`);
    expect(got?.code).toBe("NT1607");
  });

  test("a bound arrow inside an INLINED body re-raises the boundary (nesting is honoured)", () => {
    const got = rejectionOf(`
const src: number[] = [1, 2];
//@@mutable
const out: number[] = [];
src.forEach((x) => { const g = (): number => out.push(x); console.log(g()); });
console.log(out.join(","));
`);
    expect(got?.code).toBe("NT1607");
  });

  /* Advice a diagnostic gives has to be true, so both hints are compiled here. */
  test("the BOUND-arrow hint's prescribed fix compiles and matches node", async () => {
    await expectMatches(`
const src: number[] = [1, 2, 3];
//@@mutable
const out: number[] = [];
src.forEach((x) => { out.push(x); });
console.log(out.join(","), out.length);
`);
  });

  test("the OTHER-arrow hint's prescribed fix compiles and matches node", async () => {
    await expectMatches(`
const src: number[] = [1, 2];
//@@mutable
const out: number[] = [];
src.forEach((x) => { out.push(x); });
console.log(out.join(","), out.length);
`);
  });
});

/*
 * MEMORY for the newly-accepted shape. An inlined callback allocates no env, so the
 * counters must land exactly where the `for-of` spelling lands — that equality is the
 * claim, since the accepted program IS the loop it desugars to.
 */
describe("memory: an inlined-HOF accumulator drops exactly like the `for-of` loop", () => {
  test("__arrLive()/__objLive() return to 0 after the scope exits", async () => {
    const r = await compileAndRun(`
function build(n: number): number {
  const src: number[] = [1, 2, 3];
  //@@mutable
  const out: number[] = [];
  src.forEach((x) => { out.push(x * n); });
  return out.length + out[0];
}
console.log(build(2), build(3));
console.log(__arrLive(), __objLive(), __strLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("5 6\n0 0 0\n");
  });

  test("200 build-and-drop rounds through `.forEach` exit 0 and leak no headers", async () => {
    const r = await compileAndRun(`
function build(n: number): number[] {
  const src: number[] = [1, 2, 3, 4, 5];
  //@@mutable
  const out: number[] = [];
  src.forEach((x) => { out.push(x * n); });
  return out;
}
let sum = 0;
for (let k = 0; k < 200; k++) {
  const a = build(k);
  sum = sum + a[4];
}
console.log(sum, __arrLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("99500 0\n");
  });

  /*
   * The `.forEach` spelling and the `for-of` spelling must leak the SAME amount — here,
   * the 6 inner rows that `nt_obj_free`/`nt_arr_free` never walk (array ELEMENTS are not
   * freed today; `lane-elemfree` owns that). Asserting the shared number rather than 0 is
   * deliberate: it pins the equality that makes this relaxation a desugaring rather than a
   * new leak, and it will fail loudly — on BOTH halves at once — when element freeing lands.
   */
  test("the element leak is identical to the `for-of` spelling's (pre-existing, not new)", async () => {
    const body = (loop: string) => `
function build(): number {
  const src: number[] = [1, 2, 3];
  //@@mutable
  const out: number[][] = [];
  ${loop}
  return out.length + out[2][1];
}
console.log(build(), build());
console.log(__arrLive());
`;
    const hof = await compileAndRun(body(`src.forEach((x) => { const row: number[] = [x, x + 1]; out.push(row); });`));
    const forOf = await compileAndRun(body(`for (const x of src) { const row: number[] = [x, x + 1]; out.push(row); }`));
    expect(hof.exitCode).toBe(0);
    expect(forOf.exitCode).toBe(0);
    expect(hof.stdout).toBe(forOf.stdout);
    expect(hof.stdout).toBe("7 7\n6\n");
  });

  /*
   * The sanitizer gate — the only assertion here that can see a double free or a
   * use-after-free (the counters above balance to zero just as happily while the program
   * reads freed memory). Same construction as test/hof-drops.test.ts: ASan + UBSan,
   * `-fno-sanitize-recover` so every finding is fatal, LSan off (macOS has none).
   */
  test("ASan + UBSan: the inlined-HOF accumulator path is free of UAF and double frees", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-pushasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIR(`
function build(n: number): number[] {
  const src: number[] = [1, 2, 3, 4, 5];
  //@@mutable
  const out: number[] = [];
  src.forEach((x) => { out.push(x * n); });
  //@@mutable
  const rows: number[][] = [];
  out.forEach((x) => { const row: number[] = [x, x]; rows.push(row); });
  return out;
}
let sum = 0;
for (let k = 0; k < 50; k++) { const a = build(k); sum = sum + a[4]; }
//@@mutable
const self: number[] = [1, 2, 3];
self.forEach((x) => { self.push(x); });
console.log(sum, self.length);
`));
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
      expect(run.stdout).toBe("6125 6\n"); // node agrees: 5·Σ(0..49) = 6125, and 3 + 3 appends
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("`.push` on a `@@mutable` accumulator — node is the oracle", () => {
  /**
   * PAST THE 32-ELEMENT PERSISTENT-VECTOR THRESHOLD, which every other case here is under.
   *
   * Below 32 an array is a flat block and `a->data[i]` is a correct read; at 32 `arr_freeze`
   * frees the flat block and NULLs `data`, so a routine that did not go through `arr_at`
   * segfaults on exactly the inputs a small test never reaches — the bug class `lane-stdlib`
   * found in `.lastIndexOf` / `.concat` / `.flat`. `src/*.ts` now leans on this path for 43
   * accumulators, and `lex`'s `tokens` reaches ~35,000, so the threshold is pinned here for
   * BOTH spellings and for both element kinds, with reads on either side of the boundary.
   */
  test("500 appends cross the 32-element threshold — `.push` and the spread, numbers and strings", async () => {
    await expectMatches(`
//@@mutable
let a: number[] = [];
for (let i = 0; i < 500; i++) { a.push(i); }
//@@mutable
let c: string[] = [];
for (let i = 0; i < 500; i++) { c.push(String(i * 3)); }
let b: string[] = [];
for (let i = 0; i < 500; i++) { b = [...b, String(i)]; }
console.log(a.length, a[0], a[31], a[32], a[499]);
console.log(c.length, c[31], c[32], c[499]);
console.log(b.length, b[31], b[32], b[499]);
console.log(a.slice(30, 34).join(","), b.slice(30, 34).join(","), a.indexOf(400), c.join("").length);
`);
  });

  test("appends in a loop; the pragma is a comment to node", async () => {
    await expectMatches(`
//@@mutable
let xs: number[] = [];
for (let i = 0; i < 5; i++) { xs.push(i * 2); }
console.log(xs.join(","), xs.length);
`);
  });

  // test262 test/built-ins/Array/prototype/push/S15.4.4.7_A2_T1: "Array.prototype.push
  // returns the new length of the array".
  test("the return value is the NEW length (test262 S15.4.4.7_A2)", async () => {
    await expectMatches(`
//@@mutable
const xs: string[] = [];
console.log(xs.push("a"), xs.push("b"), xs.push("c"));
console.log(xs.join("|"));
`);
  });

  // test262 test/built-ins/Array/prototype/push/S15.4.4.7_A1_T1: push with NO arguments
  // is legal and leaves the array alone, still returning its length.
  test("`push()` with no arguments returns the current length and appends nothing (test262 S15.4.4.7_A1)", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [];
console.log(xs.push());
xs.push(7);
console.log(xs.push(), xs.length, xs[0]);
`);
  });

  // test262 test/built-ins/Array/prototype/push/S15.4.4.7_A3: multiple arguments are
  // appended LEFT TO RIGHT, and the return value counts all of them.
  test("multiple arguments append left to right (test262 S15.4.4.7_A3)", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [];
console.log(xs.push(1, 2, 3));
console.log(xs.push(4, 5));
console.log(xs.join(","), xs.length);
`);
  });

  test("an OBJECT element is reshaped to the declared element type, exactly as a spread would", async () => {
    await expectMatches(`
type Tok = { type: string; value: string };
//@@mutable
const toks: Tok[] = [];
toks.push({ type: "ident", value: "x" });
toks.push({ type: "punct", value: "(" });
for (const t of toks) console.log(t.type, t.value);
console.log(toks.length);
`);
  });

  test("a `const` accumulator is still a `const` BINDING — the array grows, the name never rebinds", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [1, 2, 3];
xs.push(4);
console.log(xs.length, xs[3], xs[0]);
`);
  });

  test("the finished array is handed out by MOVE, and is an ordinary immutable array again", async () => {
    await expectMatches(`
function build(n: number): number[] {
  //@@mutable
  let xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i * i);
  return xs;
}
const a = build(4);
console.log(a.join(","), a.length);
`);
  });

  test("interleaved reads see the appends (an accumulator is not a snapshot)", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [];
for (let i = 0; i < 4; i++) {
  xs.push(i);
  console.log(xs.length, xs[xs.length - 1]);
}
`);
  });

  /*
   * `xs.push(v)` STORES `v`, so it CONSUMES it — the same move `[...xs, v]` makes. This
   * was a REAL USE-AFTER-FREE while the argument was merely borrowed (the shape every
   * other call wants): a linear value pushed inside a function stayed owned by its local,
   * the local freed it at scope exit, and the array went on pointing at it.
   *
   *   function fill(): number { const a: number[] = [4, 5]; g.push(a); return a.length; }
   *   console.log(fill(), g[0].length);   // printed "2 3" — exit 0, WRONG ANSWER
   */
  test("a pushed linear element MOVES into the array, and reading it after is NT1601", () => {
    const got = rejectionOf(`
//@@mutable
let xs: number[][] = [];
const a: number[] = [1, 2];
xs.push(a);
console.log(a.length);
`);
    expect(got?.code).toBe("NT1601");
  });

  test("the same shape is refused for the spread idiom, which is where the rule comes from", () => {
    const got = rejectionOf(`
let xs: number[][] = [];
const a: number[] = [1, 2];
xs = [...xs, a];
console.log(a.length);
`);
    expect(got?.code).toBe("NT1601");
  });

  test("nested accumulation: each pushed array is owned by the accumulator and read back correctly", async () => {
    await expectMatches(`
function fill(): number[][] {
  //@@mutable
  let g: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const a: number[] = [i, i + 1];
    g.push(a);
  }
  return g;
}
const r = fill();
console.log(r.length, r[0][1], r[2][0]);
`);
  });

  test("a for-of over the accumulator while pushing is iterator invalidation (NT1603)", () => {
    const got = rejectionOf(`
//@@mutable
let xs: number[] = [1, 2, 3];
for (const v of xs) { xs.push(v); }
console.log(xs.length);
`);
    expect(got?.code).toBe("NT1603");
  });

  test("both spellings compile — `@@mutable` and `//@@mutable` produce byte-identical IR", () => {
    const body = `
let xs: number[] = [];
xs.push(1);
xs.push(2);
console.log(xs.join(","));
`;
    expect(emitIR(`@@mutable\n${body}`)).toBe(emitIR(`//@@mutable\n${body}`));
  });
});

/*
 * MEMORY. A double free is a NONZERO EXIT with CORRECT STDOUT, so both are asserted
 * everywhere above; here the live-value counters are asserted directly.
 *
 * `__arrLive()` counts HEADERS, and the growth path's abandoned blocks are invisible to
 * it — that is exactly how `nt_arr_push` once leaked 87% of all leaked bytes (a block per
 * doubling) with every counter reading zero. The byte-level check is LeakSanitizer, run
 * by test/transients.test.ts on Linux; this lane also ran `leaks -atExit` on macOS over
 * 2 x 5,000 appends and got "0 leaks" for both the push and the spread spellings.
 */
describe("memory: the accumulator drops exactly once", () => {
  // The counters have no node counterpart, so these are BEHAVIOURAL (the test/actors.test.ts
  // contract): exact expected stdout, and exit code 0 asserted separately — a double free
  // is a nonzero exit with correct stdout, so the exit code is the load-bearing half.
  test("__arrLive() returns to 0 after the accumulator's scope exits", async () => {
    const r = await compileAndRun(`
function build(n: number): number {
  //@@mutable
  let xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  return xs.length;
}
console.log(build(300), build(300));
console.log(__arrLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("300 300\n0\n");
  });

  test("2,000 appends leak no headers and allocate no trie nodes", async () => {
    // The flat DOUBLING path, exercised ~9 times over. This is where nt_arr_push once
    // abandoned a block per doubling — 87% of all leaked bytes, and invisible to every
    // counter, which is why __pvNodes is asserted here but LeakSanitizer is the real gate.
    // Note the representation: nt_arr_push never calls arr_freeze, so a push-built array
    // stays FLAT (__pvNodes 0), while a spread-built one becomes a trie past the
    // threshold. Same values either way; test/transients.test.ts covers the trie side.
    const r = await compileAndRun(`
function build(n: number): number {
  //@@mutable
  let xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  return xs.length;
}
console.log(build(2000));
console.log(__arrLive(), __pvNodes());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2000\n0 0\n");
  });

  test("the moved-out array is freed by its NEW owner, once", async () => {
    const r = await compileAndRun(`
function build(n: number): number[] {
  //@@mutable
  let xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  return xs;
}
function total(): number {
  const a = build(50);
  return a.length;
}
console.log(total(), total());
console.log(__arrLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("50 50\n0\n");
  });

  // The shape a double free would actually show up in: many scopes, many appends, and a
  // value handed out of each. 200 iterations because a single run can get lucky.
  test("200 build-and-drop rounds exit 0 with correct stdout", async () => {
    const r = await compileAndRun(`
function build(n: number): number[] {
  //@@mutable
  let xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  return xs;
}
let sum = 0;
for (let k = 0; k < 200; k++) {
  const a = build(40);
  sum = sum + a[39];
}
console.log(sum, __arrLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("7800 0\n");
  });
});

/*
 * THE REJECTION TABLE — every `.push` receiver shape that STAYS refused, pinned by code.
 * This is the whole soundness argument, and each row names which of the three facts (or
 * the closure rule) does the work.
 */
describe("`.push` receiver shapes that stay REFUSED", () => {
  const rows: { what: string; code: string; source: string }[] = [
    {
      what: "an UNDECORATED local — the Stage 29 rule is unchanged",
      code: "NT1606",
      source: `let xs: number[] = [];\nxs.push(1);\nconsole.log(xs.length);\n`,
    },
    {
      what: "a PARAMETER (a borrow: the caller owns and drops it, and it cannot carry the attribute)",
      code: "NT1606",
      source: `function add(xs: number[]): void { xs.push(1); }\nconst a: number[] = [];\nadd(a);\nconsole.log(a.length);\n`,
    },
    {
      what: "a `this.<field>` array — a field names no binding whose ownership this scope can establish",
      code: "NT1606",
      source: `//@@mutable\nclass B { xs: number[] = []; add(n: number): B { this.xs.push(n); return this; } }\nconst b = new B();\nb.add(1);\nconsole.log(b.xs.length);\n`,
    },
    {
      what: "a container ELEMENT (`g[0].push(v)`)",
      code: "NT1606",
      source: `//@@mutable\nlet g: number[][] = [[1]];\ng[0].push(2);\nconsole.log(g[0].length);\n`,
    },
    {
      what: "a CAPTURED accumulator — the arrow's env holds a second pointer that may outlive the binding",
      code: "NT1607",
      source: `//@@mutable\nlet xs: number[] = [];\nconst f = (n: number): number => xs.push(n);\nconsole.log(f(3), xs.length);\n`,
    },
    {
      what: "an accumulator that has been MOVED OUT (a second name is a move, never an alias)",
      code: "NT1601",
      source: `//@@mutable\nlet xs: number[] = [];\nconst b = xs;\nxs.push(1);\nconsole.log(b.length);\n`,
    },
    {
      what: "`@@mutable` on a binding that is not an array",
      code: "NT1023",
      source: `//@@mutable\nlet n: number = 1;\nn = 2;\nconsole.log(n);\n`,
    },
    {
      what: "`@@mutable` on a declaration that binds more than one name",
      code: "NT1023",
      source: `//@@mutable\nlet a: number[] = [], b: number[] = [];\na.push(1);\nconsole.log(a.length, b.length);\n`,
    },
    {
      what: "a `@wrapper` on a variable declaration",
      code: "NT1023",
      source: `function w(x: number): number { return x; }\n@w\nlet a: number[] = [];\nconsole.log(a.length);\n`,
    },
  ];

  for (const r of rows) {
    test(`${r.code}: ${r.what}`, () => {
      const got = rejectionOf(r.source);
      expect(got?.code).toBe(r.code);
    });
  }

  test("the NT1606 hint names the opt-in AND its limits (advice a diagnostic gives has to be true)", () => {
    const got = rejectionOf(`let xs: number[] = [];\nxs.push(1);\nconsole.log(xs.length);\n`);
    expect(got?.code).toBe("NT1606");
    expect(got?.hint).toContain("@@mutable");
    expect(got?.hint).toContain("never on a field, a parameter or an element");
  });

  test("the hint's prescribed fix COMPILES AND RUNS — the one the NT1606 hint spells out", async () => {
    await expectMatches(`
//@@mutable
let acc: number[] = [];
for (let i = 0; i < 3; i++) acc.push(i);
console.log(acc.join(","));
`);
  });

  test("the OTHER in-place mutators are untouched by the opt-in", () => {
    for (const m of ["pop()", "shift()", "unshift(1)", "splice(0, 1)", "fill(0)", "copyWithin(0, 1)"]) {
      const got = rejectionOf(`//@@mutable\nlet xs: number[] = [1, 2, 3];\nxs.${m};\nconsole.log(xs.length);\n`);
      expect(got?.code).toBe("NT1606");
    }
  });
});

/*
 * The interaction the opt-in has to keep honest: an accumulator's length is NOT static,
 * even when it is a `const` bound to a literal. Recording it would let the NT2002
 * compile-time bounds check reject an index that is in range after the appends.
 */
describe("a `@@mutable` accumulator has no statically-known length", () => {
  test("indexing past the LITERAL length is accepted and correct once the appends land", async () => {
    await expectMatches(`
//@@mutable
const xs: number[] = [1, 2];
xs.push(3);
xs.push(4);
console.log(xs[3], xs[2], xs.length);
`);
  });

  test("an UNDECORATED const keeps the NT2002 compile-time rejection", () => {
    const got = rejectionOf(`const xs: number[] = [1, 2];\nconsole.log(xs[3]);\n`);
    expect(got?.code).toBe("NT2002");
  });
});
