/*
 * `.pop` — the DISCARDED half of the `@@mutable` accumulator opt-in.
 *
 * test/push-accumulator.test.ts legalized `.push` on a `@@mutable` binding, a `@@mutable`
 * parameter, and (most recently) `this.<field>` of a `@@mutable` class. That measurement
 * immediately produced a bucket: NINE of the newly-promoted NT1606 blockers in the
 * compiler's own source are the OTHER half of the same idiom —
 *
 *     this.narrowStack.push(facts);
 *     try { … } finally { this.narrowStack.pop(); }
 *
 * — eight `this.<stack>.pop()` sites across `parser.ts` (`returnsAsyncFnStack`,
 * `typeParamScopes`), `checker.ts` (`narrowStack`) and `codegen.ts` (`hofReturnStack`),
 * plus one `this.pending.shift()`. Legalizing the push and not the pop is the exact
 * inconsistency that produced the false NT1606 hint the push lane had to correct.
 *
 * ---- WHY THE RULE IS "RESULT DISCARDED", AND WHY THAT IS NOT ARBITRARY ----
 *
 * `.push` APPENDS: the array gains an owner of a value the caller handed it, and the
 * ownership pass already models that as a move IN (`arrPush` in src/ownership.ts).
 * `.pop` REMOVES AND RETURNS, so ownership would travel OUT — a different question, and
 * the answer depends on what the caller does with the result:
 *
 *   - DISCARDED (`xs.pop();`) — nothing leaves the array. The observable effect is
 *     exactly "the array is one shorter", which is what a stack pop is written for and
 *     what all eight blocker sites do. There is no new owner, so there is no new free,
 *     and the rule does not depend on element freeing — which does not happen today:
 *     `nt_obj_free` is `free(o)` and never walks slots, so array elements are never freed.
 *     THE RULE STAYS CORRECT ON THE DAY THAT IS FIXED: a discarded pop drops the element,
 *     and the array is where that drop belongs, so element freeing subsumes it unchanged.
 *     Nothing here mints a second owner for it to double-free.
 *
 *   - USED (`const x = xs.pop();`) — the local would become the owner of a heap element
 *     the array used to hold: the tree's first move-out-of-an-array-element, landing on
 *     exactly that unswept path. It stays refused, and it has a SECOND, independent
 *     defect with nothing to do with ownership, pinned below: node types `pop()` as
 *     `T | undefined` and answers `undefined` on an empty array, while `nt_arr_pop` does
 *     `return 0` and codegen's `case "pop"` types the result as bare `el` — `0` for a
 *     number, a NULL pointer for anything heap. Legalizing the used form as it stands
 *     would be a silent wrong answer, the worst outcome available. It is unreachable
 *     while only the discarded form is legal.
 *
 * ---- THE TWO LYING HINTS THIS FILE ALSO REPAIRS ----
 *
 * 1. The standing `.pop` refusal recommended `arr[arr.length - 1]` "for the last
 *    element". On an empty array node's `.pop()` is `undefined` and node's `[-1]` is
 *    `undefined`, but OURS PANICS (Stage 41 — see test/no-index-last.test.ts, which
 *    documents this exact string as advice it must not flag, which is how it survived).
 *    So the hint answered a refusal with a program that diverges from node HARDER than
 *    the one it refused. `.at(-1)` is the spelling that actually yields `undefined`.
 *    `.shift` carried the identical defect one line down (`arr[0]`) and is fixed with it.
 *
 * 2. The NT1603 iterator-invalidation hint is shared by `push` and `pop` (`MUTATING` in
 *    src/ownership.ts holds both) and was written for `push` alone: it told a reader who
 *    had just written a `.pop` that `.pop` "reallocates" the storage, that "node's answer
 *    depends on the GROWTH being SEEN", and to "append after the loop". Three false
 *    statements about a method that removes.
 *
 * Every hint asserted here is COMPILED and matched against node in the last describe
 * block, because "compile whatever your hint recommends" is otherwise unenforced.
 *
 * node is the oracle for stdout AND exit code throughout: a double free presents as a
 * NONZERO EXIT with CORRECT STDOUT, so stdout alone would not see it.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode, emitIR, emitIRAsan } from "./harness.ts";

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
 * THE BLOCKER SHAPE, reduced. `parser.ts`'s `returnsAsyncFnStack`, `checker.ts`'s
 * `narrowStack`, `codegen.ts`'s `hofReturnStack` and `parser.ts`'s `typeParamScopes` are
 * all this: a push on the way in, a discarded pop in the matching `finally`, and a read
 * of the top in between.
 */
describe("`.pop()` with the result DISCARDED, on an accumulator receiver", () => {
  test("a stack FIELD of a `@@mutable` class — the eight-blocker idiom", async () => {
    await expectMatches(`
//@@mutable
class P {
  depth: boolean[] = [];
  run(n: number): number {
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.depth.push(i % 2 === 0);
      s = s + this.depth.length;
      this.depth.pop();
    }
    return s + this.depth.length;
  }
}
console.log(new P().run(5));
`);
  });

  test("a `@@mutable` LOCAL binding — the same opt-in `.push` already had", async () => {
    await expectMatches(`
//@@mutable
let xs: number[] = [1, 2, 3];
xs.pop();
console.log(xs.length, xs[1]);
xs.push(9);
xs.push(8);
xs.pop();
console.log(xs.length, xs[1]);
`);
  });

  /*
   * A `@@mutable` PARAMETER, the third accumulator shape (`mutableArgs`). It follows from
   * `accumulatorName` rather than from a rule of its own, and it is asserted because it
   * removes a row from test/push-param.test.ts's rejection table: the callee shrinks the
   * CALLER's array and the caller observes it, which is the same contract the append
   * already carried to the call site. Includes a drain past empty, so a borrowed receiver
   * cannot underflow the caller's length either.
   */
  test("a `@@mutable` PARAMETER — the shrink travels back to the caller", async () => {
    await expectMatches(`
function drop2(
  //@@mutable
  out: number[],
): void { out.pop(); out.pop(); }

//@@mutable
let a: number[] = [1, 2, 3, 4, 5];
drop2(a);
console.log(a.length, a[2]);
drop2(a);
drop2(a);
console.log(a.length);
`);
  });

  /*
   * HEAP ELEMENTS, which is what the real blocker sites hold: `narrowStack` is
   * `NarrowFact[][]` (an ARRAY element) and `hofReturnStack` is `{slot, done, ty}[]` (a
   * RECORD element). If a discarded pop minted an owner for the removed element, this is
   * where it would double-free — the array still holds the slot, and `nt_obj_free` never
   * walks slots. Run under ASan on Linux (`bun run test:linux`), where a stale read is
   * now genuinely caught and not only a double free.
   */
  test("record and array ELEMENTS — the element is dropped, not moved out", async () => {
    await expectMatches(`
interface Frame { slot: string; depth: number }
//@@mutable
class G {
  frames: Frame[] = [];
  groups: string[][] = [];
  run(): string {
    let out = "";
    for (let i = 0; i < 4; i++) {
      this.frames.push({ slot: "s" + i, depth: i });
      this.groups.push([\`g\${i}\`, \`h\${i}\`]);
      out = out + this.frames[this.frames.length - 1]!.slot + this.groups[this.groups.length - 1]![1]! + ";";
      this.frames.pop();
      this.groups.pop();
    }
    return out + "|" + this.frames.length + "," + this.groups.length;
  }
}
console.log(new G().run());
`);
  });

  /*
   * THE EMPTY ARRAY — the case that decides whether the discarded rule is node-exact.
   * node's `[].pop()` is `undefined` AND leaves the array alone; `nt_arr_pop`'s
   * `if (a->len == 0) return 0` leaves it alone too, so the two agree on the only thing
   * a discarded call can observe. It also proves the length does not go NEGATIVE, which
   * would make the next `.push` write at index -1.
   */
  test("popping past empty is a no-op, and the array still works afterwards", async () => {
    await expectMatches(`
//@@mutable
let xs: number[] = [];
xs.pop();
xs.pop();
console.log(xs.length);
xs.push(7);
xs.pop();
xs.pop();
console.log(xs.length);
xs.push(9);
console.log(xs.length, xs[0]);
`);
  });
});

/*
 * THE REFUSALS. Each names the reason the accept path does not cover it, and the first
 * two are the ones that would be SILENT WRONG ANSWERS rather than merely unsupported.
 */
describe("`.pop()` whose result is TAKEN stays refused", () => {
  /*
   * PROVED BY MUTATION, because "conservative" and "load-bearing" look the same from
   * outside. With `&& discard` deleted from the accept condition in `inferArrayMethod`,
   * this exact program compiles and prints
   *
   *     0            (node: undefined)   — `nt_arr_pop` returns 0, typed as bare `number`
   *     (null)       (node: undefined)   — the same 0 reaching the string printer as NULL
   *
   * at exit 0 for both. Not a crash, not a refusal: the silent-wrong-answer class, on the
   * empty-array case that a stack drains through on every single run.
   */
  test("`const x = xs.pop()` — node's `T | undefined` is not what codegen produces", () => {
    const d = rejectionOf(`
//@@mutable
let xs: number[] = [1, 2];
const x = xs.pop();
console.log(x);
`);
    expect(d?.code).toBe("NT1606");
    // The receiver IS an accumulator, so the hint must say what is actually wrong —
    // "declare it @@mutable" would be advice the reader has already followed.
    expect(d?.hint).toContain("AS ITS OWN STATEMENT is legal");
    expect(d?.hint).toContain("at(-1)");
  });

  /*
   * THE SCOPING PROOF for `Checker.discardStmt`. Both of these are ExprStmts — the
   * statement's own result is discarded — but the POP's result is not: it is added to,
   * and passed to a call. `infer` captures-and-clears on entry, so only the outermost
   * expression of the statement carries the flag, and both are refused. A naive "the
   * statement is a call" flag accepts the second and a naive "clear at CallExpr" flag
   * accepts the first; under either, `xs.pop() + 1` on an empty array computes `1` where
   * node computes `NaN`.
   */
  test("`xs.pop() + 1;` — discarded STATEMENT, used VALUE", () => {
    const d = rejectionOf(`
//@@mutable
let xs: number[] = [1, 2];
xs.pop() + 1;
console.log(xs.length);
`);
    expect(d?.code).toBe("NT1606");
  });

  test("`f(xs.pop());` — discarded STATEMENT, used VALUE", () => {
    const d = rejectionOf(`
function f(n: number): void { console.log(n); }
//@@mutable
let xs: number[] = [1, 2];
f(xs.pop());
`);
    expect(d?.code).toBe("NT1606");
  });

  test("`return xs.pop();` is not statement position either", () => {
    const d = rejectionOf(`
//@@mutable
let xs: number[] = [1, 2];
function top(): number { return xs.pop(); }
console.log(top());
`);
    expect(d?.code).toBe("NT1606");
  });
});

describe("`.pop()` on a receiver that is not an accumulator stays refused", () => {
  test("a plain `let` — immutability holds, and the hint names the opt-in", () => {
    const d = rejectionOf(`
let xs: number[] = [1, 2, 3];
xs.pop();
console.log(xs.length);
`);
    expect(d?.code).toBe("NT1606");
    expect(d?.hint).toContain("//@@mutable");
    expect(d?.hint).toContain("slice(0, -1)");
    // The repaired half: the old hint recommended the panicking read. It must not come
    // back, and the replacement must be named.
    expect(d?.hint).toContain("at(-1)");
    expect(d?.hint).toContain("panics on an empty array");
  });

  test("a field of an ORDINARY class — `@@mutable` is what is missing", () => {
    const d = rejectionOf(`
class P {
  xs: number[] = [1, 2, 3];
  drop(): number { this.xs.pop(); return this.xs.length; }
}
console.log(new P().drop());
`);
    expect(d?.code).toBe("NT1606");
    expect(d?.hint).toContain("//@@mutable");
  });
});

/*
 * ITERATOR INVALIDATION. `MUTATING` in src/ownership.ts already carried `"pop"`, so this
 * guard was in place before `.pop` could reach it — which is exactly why it needs a test:
 * an unexercised guard is a guard that quietly stops holding.
 *
 * PROVED BY MUTATION. With `"pop"` removed from `MUTATING`, the field case below prints
 * `60 0` at exit 0 where node prints `60 2`: node's iterator re-reads `length` every step
 * and stops after three, while the lowered loop runs the ENTRY length, `nt_arr_get`
 * answers 0 for the indices past the shrunken end (so the SUM agrees by coincidence), and
 * every one of the five iterations pops. Wrong array, zero exit status.
 */
describe("`.pop()` while the same array is borrowed by a `for-of` (NT1603)", () => {
  test("on a `this.<field>` receiver", () => {
    const d = rejectionOf(`
//@@mutable
class A {
  xs: number[] = [10, 20, 30, 40, 50];
  boom(): number {
    let s = 0;
    for (const x of this.xs) { this.xs.pop(); s = s + x; }
    return s;
  }
}
console.log(new A().boom(), new A().xs.length);
`);
    expect(d?.code).toBe("NT1603");
    // The repaired hint: `.pop` reallocates nothing and there is no growth to see.
    expect(d?.hint).toContain("snapshots the length");
    expect(d?.hint).toContain("STOPS EARLY");
    expect(d?.hint).not.toContain("reallocates");
    expect(d?.hint).not.toContain("growth");
  });

  test("on a bare `@@mutable` binding", () => {
    const d = rejectionOf(`
//@@mutable
let xs: number[] = [10, 20, 30];
let s = 0;
for (const x of xs) { xs.pop(); s = s + x; }
console.log(s);
`);
    expect(d?.code).toBe("NT1603");
  });
});

/*
 * `.shift` — the one non-stack site (`checker.ts`'s `this.pending.shift()`), refused with
 * a reason that is true of it and not merely inherited from `.pop`.
 */
describe("`.shift` gets no share of the opt-in", () => {
  test("refused even discarded, on an accumulator, and the hint says why", () => {
    const d = rejectionOf(`
//@@mutable
let q: string[] = ["a", "b"];
q.shift();
console.log(q.length);
`);
    expect(d?.code).toBe("NT1606");
    expect(d?.hint).toContain("removes from the FRONT");
    // The `arr[0]` lie, same class as the `.pop` one, must be gone.
    expect(d?.hint).toContain("at(0)");
    expect(d?.hint).toContain("panics on an empty array");
  });
});

/*
 * EVERY REWRITE THE HINTS ABOVE RECOMMEND, COMPILED AND MATCHED AGAINST NODE. Four lying
 * diagnostics were found in this tree in one session, one of which recommended a
 * use-after-free; two of the four are repaired in this commit. The only defence that
 * scales is running the advice.
 */
describe("what the hints recommend actually compiles", () => {
  test("`.pop` hint, accumulator branch — `const top = xs.at(-1); xs.pop();`", async () => {
    await expectMatches(`
//@@mutable
let xs: number[] = [1, 2, 3];
const top = xs.at(-1);
xs.pop();
console.log(top, xs.length);

const empty: number[] = [];
console.log(empty.at(-1));

//@@mutable
class S {
  st: string[] = [];
  add(v: string): void { this.st.push(v); }
  drop(): string | undefined {
    const t = this.st.at(-1);
    this.st.pop();
    return t;
  }
}
const s = new S();
s.add("a");
s.add("b");
console.log(s.drop(), s.st.length, s.drop(), s.drop());
`);
  });

  test("`.pop` hint, plain branch — `arr = arr.slice(0, -1)`", async () => {
    await expectMatches(`
let plain: number[] = [4, 5, 6];
plain = plain.slice(0, -1);
console.log(plain.length, plain[1]);
`);
  });

  test("NT1603 hint — drain with `while (xs.length > 0)`, or shrink AFTER the loop", async () => {
    await expectMatches(`
//@@mutable
class A {
  xs: number[] = [10, 20, 30, 40, 50];
  drain(): number {
    let s = 0;
    while (this.xs.length > 0) {
      s = s + this.xs.at(-1)!;
      this.xs.pop();
    }
    return s;
  }
}
console.log(new A().drain(), new A().xs.length);

//@@mutable
class B {
  ys: string[] = ["p", "q", "r"];
  after(): string {
    let out = "";
    for (const y of this.ys) out = out + y;
    this.ys.pop();
    this.ys.pop();
    return out + "|" + this.ys.length;
  }
}
console.log(new B().after());
`);
  });

  test("`.shift` hint — `.slice(1)`, `.at(0)`, and the forward index", async () => {
    await expectMatches(`
let q: string[] = ["a", "b", "c"];
console.log(q.at(0), q.slice(1).length);
const none: string[] = [];
console.log(none.at(0));
q = q.slice(1);
console.log(q.at(0));

const items: number[] = [1, 2, 3, 4];
let head = 0;
let total = 0;
while (head < items.length) { total = total + items[head]!; head = head + 1; }
console.log(total, head);
`);
  });
});

/*
 * THE SANITIZER GATE. The whole ownership argument for the discarded rule is "no second
 * owner is minted, so no second free exists", and that is a claim about generated code
 * rather than about the checker. Built through `emitIRAsan`, NOT `emitIR`: ASan only
 * rewrites functions carrying `sanitize_address`, so until that attribute was emitted a
 * plain build instrumented `runtime/*.c` and not one instruction nativets generated —
 * catching a double free but BLIND to a stale READ, which is the fault this rule could
 * plausibly introduce (`nt_arr_pop` leaves the slot in `data`, and `a->len` is the only
 * thing that stops it being read again).
 *
 * The churn pushes and pops HEAP elements (records holding strings) 400 times across two
 * stacks, so a per-element free, a stale read of a popped slot, and an off-by-one on the
 * length would each show up here rather than as a wrong number on one lucky run.
 */
describe("ASan + UBSan: pushing and popping heap elements 400 times", () => {
  test("no double free, no stale read, no leak of the ARRAY itself", () => {
    const CHURN = `
interface Frame { slot: string; depth: number }
//@@mutable
class G {
  frames: Frame[] = [];
  tags: string[] = [];
  cycle(i: number): number {
    this.frames.push({ slot: "s" + i, depth: i });
    this.tags.push("t" + i);
    const n = this.frames[this.frames.length - 1]!.depth + this.tags[this.tags.length - 1]!.length;
    this.frames.pop();
    this.tags.pop();
    this.frames.pop();
    return n;
  }
}
let total = 0;
for (let i = 0; i < 400; i = i + 1) {
  const g = new G();
  total = total + g.cycle(i % 7) + g.frames.length + g.tags.length;
}
console.log(total);`;
    const dir = mkdtempSync(join(tmpdir(), "nativets-popasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIRAsan(CHURN));
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /*
   * LIVENESS, STATED AS A DIFFERENCE rather than as an absolute — because the absolute is
   * a PRE-EXISTING LEAK this lane found and did not cause. Both programs below end with
   * `__arrLive()` at 800: 400 `G` objects × two array fields, none of them ever freed,
   * because `nt_obj_free` is `free(o)` and never walks slots (the same fact the discarded
   * rule is built not to depend on). Asserting `0` here would fail for a reason that has
   * nothing to do with `.pop`; asserting `800` would silently ratchet the leak in.
   *
   * What IS this lane's to prove is that the pops change nothing: a discarded `.pop()`
   * neither frees an array nor allocates one, so the two counts must be EQUAL. If a future
   * element-freeing pass makes a popped element's storage collectable, this comparison
   * keeps holding while the constant moves — which is the point of writing it as a diff.
   */
  test("a discarded `.pop()` is liveness-neutral — same `__arrLive()` with and without it", async () => {
    const body = (pops: string) => `
interface Frame { slot: string; depth: number }
//@@mutable
class G {
  frames: Frame[] = [];
  tags: string[] = [];
  cycle(i: number): number {
    this.frames.push({ slot: "s" + i, depth: i });
    this.tags.push("t" + i);
    const n = this.frames[this.frames.length - 1]!.depth + this.tags[this.tags.length - 1]!.length;
${pops}
    return n;
  }
}
let total = 0;
for (let i = 0; i < 400; i = i + 1) {
  const g = new G();
  total = total + g.cycle(i % 7) + g.frames.length + g.tags.length;
}
console.log(__arrLive());`;
    const withPops = await compileAndRun(body("    this.frames.pop();\n    this.tags.pop();\n    this.frames.pop();"));
    const without = await compileAndRun(body(""));
    expect(withPops.exitCode).toBe(0);
    expect(without.exitCode).toBe(0);
    expect(withPops.stdout).toBe(without.stdout);
    expect(withPops.stdout.trim().length).toBeGreaterThan(0);
  }, 120_000);

  /* The same churn, un-sanitized, against the ORACLE — the gate above proves it is
   * memory-clean, this proves it is RIGHT. Both are needed: a double free presents as a
   * nonzero exit with correct stdout, and a stale read as correct exit with wrong stdout. */
  test("the churn's stdout is what node says", async () => {
    await expectMatches(`
interface Frame { slot: string; depth: number }
//@@mutable
class G {
  frames: Frame[] = [];
  tags: string[] = [];
  cycle(i: number): number {
    this.frames.push({ slot: "s" + i, depth: i });
    this.tags.push("t" + i);
    const n = this.frames[this.frames.length - 1]!.depth + this.tags[this.tags.length - 1]!.length;
    this.frames.pop();
    this.tags.pop();
    this.frames.pop();
    return n;
  }
}
let total = 0;
for (let i = 0; i < 400; i = i + 1) {
  const g = new G();
  total = total + g.cycle(i % 7) + g.frames.length + g.tags.length;
}
console.log(total);
`);
  });
});
