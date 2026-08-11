/*
 * BLOCK-SCOPED drops: how the ownership pass hands a nested block's RAII free set
 * to codegen.
 *
 * The set used to ride on the statement list as an EXPANDO property, typed with an
 * intersection (`Stmt[] & { blockDrops?: string[] }`). That is the one intersection
 * type in the whole of `src/`, and it is what stopped the compiler compiling its own
 * `src/ast.ts` — an array with extra properties has no runtime representation here
 * (`NtArray` is a fixed 4-field struct). It is now a synthesized trailing `BlockDrops`
 * statement in the list itself, so the drop point is an ordinary node.
 *
 * The behavior that must not move is observed through `__arrLive()` (arrays allocated
 * − freed), because compiler-inserted frees are otherwise invisible in output.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAndRun, expectMatchesNode } from "./harness.ts";
import { parse } from "../src/parser.ts";
import { setBlockDrops } from "../src/ast.ts";
import type { Stmt } from "../src/ast.ts";

describe("block-scoped drops", () => {
  // The self-host site. `src/ast.ts` is part of the compiler's own source, so the
  // subset it is written in is a hard constraint (docs/self-hosting.md) — the same
  // rule the comment at src/ast.ts:512 states for `Partial<MemberExpr> & {…}`.
  //
  // Asserted on the SOURCE, not on a parse of the whole file: `src/ast.ts` still has
  // further blockers past this one (`ForStmt.init: VarDecl | Expr | null` is next), so
  // "it parses" would stay red for reasons that are not this lane's. What must hold is
  // that no intersection type remains anywhere in the compiler's own source.
  // Asserted through the real parser rather than by scanning text, so `&&`, a bitwise
  // `&` and the word "intersection" in a comment cannot be mistaken for one: the
  // refusal renders an intersection's arms joined with " & ".
  test("no file in src/ is blocked by an intersection type", () => {
    const dir = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      try {
        parse(readFileSync(join(dir, f), "utf8"));
      } catch (e) {
        // Every OTHER refusal is some other lane's frontier, not this one's.
        const msg = (e as Error).message;
        if (msg.includes(" & ")) offenders.push(`${f}: ${msg.split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The hazard the marker representation introduces, and the reason `setBlockDrops`
  // replaces instead of appending: `loop()` walks a loop body up to five times to reach
  // its move fixpoint. An appending setter leaves five markers on the body and frees the
  // same array five times — a DOUBLE FREE, not a leak: the process dies on a signal and
  // the buffered stdout dies with it (observed: no output, exit 255, against node's
  // "9\n" and exit 0). The old expando was idempotent for free, being an assignment.
  test("a linear local in a loop body is freed once per iteration, not once per fixpoint walk", async () => {
    const src = `
function f(): number {
  let total = 0;
  for (let i = 0; i < 3; i = i + 1) {
    const a: number[] = [1, 2, 3];
    total = total + a.length;
  }
  return total;
}
console.log(f());`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0); // a double free aborts; node cannot observe that for us

    // …and the frees actually happened: every array allocated in the body is gone.
    const r = await compileAndRun(`${src}\nconsole.log(__arrLive());`);
    expect(r.stdout).toBe("9\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // The setter's invariant, tested at the accessor rather than through a program,
  // because the interesting orderings are not all reachable from source today.
  //
  // Insertion ALWAYS happens on the first walk: `scoped()` decides whether to set drops
  // at all from `declaredLinear(list) ∩ this.linear`, and neither `this.linear` nor
  // `aliasOf` is mutated during the walk (both are read-only constructor state —
  // `this.linear` is only ever `.has`), so the early return is walk-invariant. A first
  // walk that computes an EMPTY set still inserts a marker, and a later walk replaces
  // its contents in place. Asserted anyway: it is the invariant the representation
  // depends on, and it would silently become false if `linear` ever grew mid-walk.
  test("setBlockDrops inserts once and then replaces, whatever the order", () => {
    const stmt = (): Stmt => ({ kind: "ExprStmt", expr: { kind: "NumberLiteral", value: 1 } });
    const list: Stmt[] = [stmt(), stmt()];

    setBlockDrops(list, []); // first walk: nothing droppable yet — still a marker
    expect(list.length).toBe(3);
    expect(list[2]).toEqual({ kind: "BlockDrops", names: [] });

    setBlockDrops(list, ["a"]); // a later walk ACQUIRES a drop
    setBlockDrops(list, ["a", "b"]);
    setBlockDrops(list, ["b"]); // ...and can lose one again (moved out)

    expect(list.length).toBe(3); // still exactly one marker, never appended
    expect(list.filter((s) => s.kind === "BlockDrops").length).toBe(1);
    expect(list[list.length - 1]).toEqual({ kind: "BlockDrops", names: ["b"] }); // last write wins, and it stays LAST
  });

  /*
   * `setBlockDrops` used to open with
   *
   *     const last = list[list.length - 1];
   *     if (last !== undefined && ...)
   *
   * which reads as a defensive `undefined` guard and is nothing of the sort. On an EMPTY
   * list the index is `-1`, and node and nativets DISAGREE about that read: node answers
   * `undefined` and the function appends, while nativets PANICS on an out-of-range index
   * by design (Stage 41 — `docs/divergences.md`). Measured, not argued:
   *
   *     const xs: number[] = []; console.log(xs[xs.length - 1]);
   *     node     -> "undefined", exit 0
   *     nativets -> panic: index out of bounds: the length is 0 but the index is -1, exit 255
   *
   * So it was a source defect with a node divergence behind it, not dead code — and it
   * put `src/ast.ts` outside the subset it has to compile (docs/self-hosting.md).
   *
   * This test makes BUN agree with nativets: the array is proxied so that an out-of-range
   * index throws instead of answering `undefined`. That is the only way to hold the rule
   * under the oracle, because node's own answer is exactly the one we must not rely on.
   * It was RED on the `last !== undefined` spelling and is green on the `length` guard.
   */
  test("setBlockDrops never reads out of range — the index node and nativets disagree about", () => {
    const isIndexKey = (k: string): boolean => {
      if (k.length === 0) return false;
      let i = 0;
      if (k[0] === "-") { if (k.length === 1) return false; i = 1; }
      for (; i < k.length; i++) { const c = k.charCodeAt(i); if (c < 48 || c > 57) return false; }
      return true;
    };
    const guarded = (a: Stmt[]): Stmt[] =>
      new Proxy(a, {
        get(t, k, r) {
          if (typeof k === "string" && isIndexKey(k)) {
            const i = Number(k);
            if (i < 0 || i >= t.length) {
              throw new RangeError(`index out of bounds: the length is ${t.length} but the index is ${i}`);
            }
          }
          return Reflect.get(t, k, r);
        },
      });

    const empty = guarded([]);
    setBlockDrops(empty, ["a"]); // the EMPTY case: must append without ever touching [-1]
    expect(empty.length).toBe(1);
    expect(empty[0]).toEqual({ kind: "BlockDrops", names: ["a"] });

    setBlockDrops(empty, ["b"]); // and the replace path still finds the marker through the guard
    expect(empty.length).toBe(1);
    expect(empty[0]).toEqual({ kind: "BlockDrops", names: ["b"] });

    const stmt = (): Stmt => ({ kind: "ExprStmt", expr: { kind: "NumberLiteral", value: 1 } });
    const nonEmpty = guarded([stmt()]);
    setBlockDrops(nonEmpty, ["c"]); // a non-marker tail: append, still no out-of-range read
    expect(nonEmpty.length).toBe(2);
    expect(nonEmpty[1]).toEqual({ kind: "BlockDrops", names: ["c"] });
  });

  /*
   * A `try`/`catch`/`finally` BLOCK IS A BLOCK, and its linear locals were never freed.
   *
   * `scoped()` is called on all three lists, so `declaredLinear` did find the array — but
   * it is then intersected with `this.linear`, and `collectLinear` (which builds that set
   * for the whole frame) had no `TryStmt` case at all. Its sibling `collectVarTys`, a few
   * lines above it, does have one. So the name was never linear, the intersection was
   * empty, and the marker carried nothing: one array leaked per execution of the `try`.
   *
   * MEASURED IN A LOOP, at two scales, and that is the whole point of the shape. The same
   * body written straight-line reports 0 — not because it does not leak, but because the
   * frame exits and the counter is read after everything is already gone. A leak
   * proportional to work is only visible against work.
   */
  test("a linear local declared inside a try block is freed, once per execution", async () => {
    const body = (n: number): string => `
let acc = 0;
for (let i = 0; i < ${n}; i++) {
  try {
    const a: number[] = [1, 2, 3];
    acc = acc + a.length;
  } catch (e) {
    acc = acc + 1;
  }
}
console.log(acc);
console.log(__arrLive());`;
    const small = await compileAndRun(body(200));
    expect(small.exitCode).toBe(0);
    expect(small.stdout).toBe("600\n0\n");
    // …and it does not GROW with the work, which is the property a single scale cannot see.
    const large = await compileAndRun(body(1000));
    expect(large.exitCode).toBe(0);
    expect(large.stdout).toBe("3000\n0\n");
  });

  test("a linear local declared inside a catch and a finally block is freed too", async () => {
    const body = (n: number): string => `
function boom(i: number): number { if (i > -1) throw "x"; return i; }
let acc = 0;
for (let i = 0; i < ${n}; i++) {
  try {
    acc = acc + boom(i);
  } catch (e) {
    const c: number[] = [1, 2];
    acc = acc + c.length;
  } finally {
    const f: number[] = [3];
    acc = acc + f.length;
  }
}
console.log(acc);
console.log(__arrLive());`;
    const small = await compileAndRun(body(200));
    expect(small.exitCode).toBe(0);
    expect(small.stdout).toBe("600\n0\n");
    const large = await compileAndRun(body(1000));
    expect(large.exitCode).toBe(0);
    expect(large.stdout).toBe("3000\n0\n");
  });
});
