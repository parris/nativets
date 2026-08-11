/*
 * Wave 3 — differential sweep over the shapes the earlier fuzz waves barely touch:
 * generics, classes, destructuring and spread. `bun run test/fuzz3-shapes.ts`.
 *
 * A SCRIPT, not a `.test.ts`, matching `fzq-fuzz.ts` and `sh6-fuzz.ts`: a sweep is run
 * deliberately and its FINDINGS become named tests (that is what `fuzz-diff.test.ts` is).
 * As of the run that added this file it found NOTHING — 52 programs, zero mismatches,
 * zero stoppers — so there are no findings to pin, and the negative result is the point:
 * these shapes are correct on the subset that compiles.
 *
 * PER-GROUP PRELUDES. A single refused prelude refuses every case under it, and the
 * sweep then reports "0 mismatches" over ZERO programs — the exact vacuity this project
 * has been bitten by. The first run of this file did precisely that: one `get` accessor
 * in a shared prelude took all 59 cases out, and the summary line still said 0 mismatches.
 * Each group now screens its own prelude and reports RAN counts, so a group that measured
 * nothing says so.
 */
import { screen, runBatch, type Case } from "./fzq-fuzz.ts";
import { sourceToIR } from "../src/driver.ts";

interface Group { name: string; prelude: string; cases: Case[] }
const groups: Group[] = [];
const mk = (name: string, prelude: string, build: (add: (l: string, s: string) => void) => void): void => {
  const cases: Case[] = [];
  build((label, stmt) => cases.push({ label, stmt }));
  groups.push({ name, prelude, cases });
};

mk("destructuring-array", "", (add) => {
  const ARRS = ["[1,2,3]", "[1]", "[0,-0,NaN]", '["a","b"]'];
  ARRS.forEach((a, i) => {
    add(`da-pair${i}`, `{ const [p, q] = ${a}; console.log(p, q); }`);
    add(`da-def${i}`, `{ const [p = 9, q = 8, r = 7] = ${a}; console.log(p, q, r); }`);
    add(`da-rest${i}`, `{ const [h, ...t] = ${a}; console.log(h, t.length, t.join("|")); }`);
    add(`da-skip${i}`, `{ const [, s] = ${a}; console.log(s); }`);
  });
  add("da-nest", "{ const [[a, b], [c]] = [[1, 2], [3]]; console.log(a, b, c); }");
  add("da-swap", "{ let a = 1; let b = 2; [a, b] = [b, a]; console.log(a, b); }");
  add("da-str", '{ const [c1, c2] = "hi"; console.log(c1, c2); }');
  add("da-empty", "{ const e: number[] = []; const [p = 4] = e; console.log(p); }");
});

mk("destructuring-object", "", (add) => {
  add("do-basic", "{ const { a, b } = { a: 1, b: 2 }; console.log(a, b); }");
  add("do-rename", "{ const { a: x, b: y } = { a: 1, b: 2 }; console.log(x, y); }");
  add("do-default", "{ const o: { a: number; b?: number } = { a: 1 }; const { a, b = 5 } = o; console.log(a, b); }");
  add("do-nest", "{ const { p: { q } } = { p: { q: 7 } }; console.log(q); }");
  add("do-param", "{ function f2({ a, b }: { a: number; b: number }): number { return a - b; } console.log(f2({ a: 5, b: 3 })); }");
  add("do-arrowparam", "{ const f3 = ({ a }: { a: number }): number => a * 2; console.log(f3({ a: 4 })); }");
  add("do-forof", '{ let s = ""; for (const { a } of [{ a: 1 }, { a: 2 }]) { s += a; } console.log(s); }');
  add("do-str", '{ const { a } = { a: "x" }; console.log(a); }');
});

mk("spread", "", (add) => {
  add("sp-mid", '{ const a = [1, 2]; console.log([0, ...a, 3].join(",")); }');
  add("sp-two", '{ const a = [1]; const b = [2]; console.log([...a, ...b].join(",")); }');
  add("sp-empty", '{ const e: number[] = []; console.log([...e, 1, ...e].join(",")); }');
  add("sp-selfdup", "{ const a = [1, 2]; console.log([...a, ...a].length); }");
  add("sp-str", '{ console.log([..."abc"].join("-")); }');
  add("sp-nest", "{ const a = [1]; console.log([[...a], [...a]].length); }");
  add("sp-obj", "{ const o = { a: 1 }; const p = { ...o, b: 2 }; console.log(p.a, p.b); }");
  add("sp-objover", "{ const o = { a: 1, b: 9 }; const p = { ...o, b: 2 }; console.log(p.a, p.b); }");
  add("sp-objorder", "{ const o = { a: 1 }; const p = { b: 2, ...o, a: 3 }; console.log(p.a, p.b); }");
  add("sp-strspread", '{ const a = ["x"]; console.log([...a, "y"].join("")); }');
});

mk("classes", `
class Base { v: number; constructor(v: number) { this.v = v; } double(): number { return this.v * 2; } describe(): string { return "B" + this.v; } }
`, (add) => {
  add("cl-field", "{ const b = new Base(3); console.log(b.v); }");
  add("cl-method", "{ const b = new Base(3); console.log(b.double()); }");
  add("cl-describe", "{ const b = new Base(3); console.log(b.describe()); }");
  add("cl-neg", "{ const b = new Base(-0); console.log(b.v, b.double()); }");
  add("cl-nan", "{ const b = new Base(NaN); console.log(b.v, b.describe()); }");
  add("cl-arr", '{ const xs = [new Base(1), new Base(2)]; let s = ""; for (const x of xs) { s += x.describe() + ","; } console.log(s); }');
  add("cl-eq", "{ const a = new Base(1); const b = new Base(1); console.log(a.v === b.v); }");
  add("cl-log", "{ const b = new Base(7); console.log(b); }");
});

/* Generic FUNCTIONS and generic CLASSES are separate groups on purpose: a generic class
 * is refused (NT1015), and with `Box` in the shared prelude the twelve generic-FUNCTION
 * cases measured nothing at all. Split so the supported half is actually swept. */
mk("generics-class", `
class Box<T> { value: T; constructor(value: T) { this.value = value; } unwrap(): T { return this.value; } }
`, (add) => {
  add("g-box-num", "{ const b = new Box<number>(4); console.log(b.unwrap()); }");
  add("g-box-str", '{ const b = new Box<string>("z"); console.log(b.unwrap()); }');
});

mk("generics-fn", `
function idg<T>(x: T): T { return x; }
function firstOf<T>(xs: T[]): T { return xs[0]; }
function lenOf<T extends { length: number }>(x: T): number { return x.length; }
function pairOf<A, B>(a: A, b: B): string { return String(a) + "/" + String(b); }
function lastOf<T>(xs: T[]): T { return xs[xs.length - 1]; }
`, (add) => {
  add("g-id-num", "console.log(idg(5));");
  add("g-id-str", 'console.log(idg("s"));');
  add("g-id-bool", "console.log(idg(true));");
  add("g-id-neg0", "console.log(idg(-0));");
  add("g-id-nan", "console.log(idg(NaN));");
  add("g-first", "console.log(firstOf([7, 8, 9]));");
  add("g-first-str", 'console.log(firstOf(["a", "b"]));');
  add("g-constraint-arr", "console.log(lenOf([1, 2, 3]));");
  add("g-constraint-str", 'console.log(lenOf("abcd"));');
  add("g-pair", 'console.log(pairOf(1, "x"));');
  add("g-pair-bool", "console.log(pairOf(true, -0));");
  add("g-last", "console.log(lastOf([1, 2, 3]));");
  add("g-last-str", 'console.log(lastOf(["a", "b"]));');
  add("g-id-empty", 'console.log(idg(""));');
  add("g-first-nan", "console.log(firstOf([NaN, 1]));");
  add("g-first-neg0", "console.log(firstOf([-0, 1]));");
  add("g-len-empty", 'console.log(lenOf(""));');
  add("g-len-emptyarr", "{ const e: number[] = []; console.log(lenOf(e)); }");
  add("g-nested-id", "console.log(idg(idg(idg(3))));");
});

let totalRan = 0, totalMis = 0, totalStop = 0;
for (const g of groups) {
  console.log(`\n===== ${g.name} (${g.cases.length} cases)`);
  if (g.prelude.trim() !== "") {
    try {
      sourceToIR(g.prelude + "\nconsole.log(1);\n");
    } catch (e) {
      console.log(`  PRELUDE REFUSED — this group measured NOTHING: ${String((e as Error).message).split("\n")[0]}`);
      continue;
    }
  }
  const { ok, refused } = screen(g.cases, g.prelude);
  const byWhy = new Map<string, number>();
  for (const r of refused) byWhy.set(r.why.slice(0, 84), (byWhy.get(r.why.slice(0, 84)) ?? 0) + 1);
  console.log(`  accepted ${ok.length} / refused ${refused.length}`);
  for (const [w, n] of [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${n}x ${w}`);
  if (ok.length === 0) { console.log("  (nothing to run)"); continue; }
  const res = await runBatch(ok, g.prelude);
  totalRan += res.ran; totalMis += res.mismatches.length; totalStop += res.stoppers.length;
  console.log(`  RAN ${res.ran} of ${ok.length}; mismatches ${res.mismatches.length}; stoppers ${res.stoppers.length}`);
  for (const m of res.mismatches) {
    console.log(`    MISMATCH [${m.label}] ${m.kind}\n       stmt: ${m.stmt.slice(0, 150)}\n       node: ${m.node.slice(0, 110)}\n       ours: ${m.ours.slice(0, 110)}`);
  }
  for (const s of res.stoppers) {
    console.log(`    STOPPER  [${s.label}] node exit ${s.nodeExit} / ours ${s.ourExit}\n       stmt: ${s.stmt.slice(0, 150)}\n       ourStderr: ${s.ourStderr.slice(0, 150)}`);
  }
}
console.log(`\n==== TOTAL ran ${totalRan}, mismatches ${totalMis}, stoppers ${totalStop}`);
