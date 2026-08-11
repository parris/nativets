/*
 * `.forEach` with an INLINE ARROW — `.map`'s loop with the result discarded.
 *
 * `.forEach` was refused unconditionally by `inferArrayMethod`, before any look at the
 * argument, with the message "needs first-class function values". A census of `src/` run
 * through the compiler's OWN parser (line-based grep undercounts the multi-line
 * spellings) says that message was wrong for most sites: of 110 `.forEach` calls, 78 pass
 * an inline arrow and only 32 are point-free (`e.args.forEach(go)`). An inline arrow is
 * the shape `.map`/`.filter`/`.reduce` already inline into a loop — it needs no function
 * value at all, so the refusal named a missing feature the site did not use.
 *
 * The point-free spelling DOES need first-class functions and stays refused; only the
 * message changes, to one that names which half is which. `lane-fnvalue` owns the other
 * half.
 *
 * `.forEach`'s callback runs for EFFECT, so the load-bearing tests here are ownership,
 * not the loop: an inlined body is a scope, a `return` in it means "next element" and not
 * "leave the function", and a value the body allocates has to be freed exactly once.
 * `__arrLive()`/`__objLive()` read that directly — stdout is correct across the whole
 * leak, so it proves nothing on its own (see test/hof-drops.test.ts).
 */

import { test, expect, describe } from "bun:test";

import { compileAndRun, expectMatchesNode } from "./harness.ts";
import { ownershipCheck, sourceToIR } from "../src/driver.ts";

/** The NT codes the ownership pass refuses a program with (`[]` if it compiles). */
function ownCodes(source: string): string[] {
  return ownershipCheck(source).map((d) => d.code);
}

/** `{code, message, hint}` for a program the FRONTEND refuses, or null if it compiles. */
function refusal(source: string): { code: string; message: string; hint?: string } | null {
  try {
    sourceToIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    if (!d) throw e;
    return d;
  }
}

describe(".forEach with an inline arrow", () => {
  test("expression body, called for effect", async () => {
    const src = `
const xs: number[] = [1, 2, 3];
xs.forEach((x) => console.log(x));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("1\n2\n3\n");
  });

  /* A bare `return` in a `.forEach` callback is the classic mis-read: it skips to the
   * NEXT element, it does not leave the enclosing function. The enclosing `console.log`
   * after the loop is what tells the two apart. */
  test("`return` in a block body skips to the next element", async () => {
    const src = `
function run(): number {
  let seen = 0;
  const xs: number[] = [1, 2, 3, 4, 5];
  xs.forEach((x) => {
    if (x % 2 === 0) { return; }
    console.log(x);
  });
  return seen;
}
console.log(run());
console.log("after");
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("1\n3\n5\n0\nafter\n");
  });
});

describe(".forEach point-free stays refused, with a message that is TRUE", () => {
  const POINT_FREE = `
function go(x: number): void { console.log(x); }
const xs: number[] = [1, 2, 3];
xs.forEach(go);
`;

  test("`xs.forEach(go)` is still NT1003 — that one DOES need a function value", () => {
    const d = refusal(POINT_FREE);
    expect(d?.code).toBe("NT1003");
    // The message must name WHICH shape is unsupported. The old one said `.forEach`
    // itself needed function values, which was false for 78 of the 110 sites in `src/`.
    expect(d?.message).toContain("not an inline arrow");
  });

  /* A hint is advice the compiler gives; if the advice does not compile the diagnostic is
   * worse than none. Two lanes this session found NT1606's hint recommending a silent
   * wrong answer — one of them a use-after-free. So: run the hint. */
  test("the hint's advice COMPILES and matches node", async () => {
    const d = refusal(POINT_FREE);
    expect(d?.hint).toContain("xs.forEach((x) => go(x))");
    const advised = `
function go(x: number): void { console.log(x); }
const xs: number[] = [1, 2, 3];
xs.forEach((x) => go(x));
`;
    const { ours, oracle } = await expectMatchesNode(advised);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
    expect(oracle.stdout).toBe("1\n2\n3\n");
  });

  /* node passes (elem, index, array). `(elem, index)` is now BOUND — see
   * test/hof-index.test.ts, which owns that boundary and its refusal messages. The
   * assertion that used to live here ("a two-parameter callback is refused") was correct
   * for its time and is deliberately retired rather than deleted: the refusal it pinned
   * was safe but named a TYPE error on valid TypeScript, and it blocked 17 of the
   * compiler's own functions. What survives of it is the half that is still true — the
   * index must be BOUND, never left to read an unwritten slot, which is what this checks
   * against node here rather than restating the old refusal. */
  test("a two-parameter callback binds the index, and agrees with node", async () => {
    const src = `
const xs: number[] = [1, 2, 3];
xs.forEach((x, i) => console.log(x + i));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("1\n3\n5\n");
  });
});

/*
 * NT1018 — found while landing `.forEach`, but PRE-EXISTING and worse in `.map`.
 *
 * Codegen routes an inlined callback's `return` to the per-element join through
 * `hofReturnStack`, but that arm is gated on `finallyStack.length === 0`. A live
 * `finally` therefore wins and the `return` compiles as a FUNCTION return: it abandons
 * the loop AND returns from the caller. Exit 0 with wrong stdout — the silent wrong
 * answer, which is the outcome this project ranks worst.
 *
 * `.map` had it before `.forEach` existed (the `.map` case below returned after ONE
 * element where node yields three), so the refusal goes in `typeArrowBody`, the single
 * entry every inlined HOF body passes through, rather than only on the new path.
 */
describe("NT1018 — `return` from under a `finally` in an inlined callback", () => {
  const EACH = `
function run(): number {
  const xs: number[] = [1, 2, 3];
  xs.forEach((x) => {
    try {
      if (x === 2) { return; }
      console.log("body " + x);
    } finally { console.log("fin " + x); }
  });
  return 0;
}
console.log(run());
`;

  const MAP = `
function run(): number {
  const xs: number[] = [1, 2, 3];
  const m: number[] = xs.map((x) => {
    try {
      if (x === 2) { return 99; }
      return x;
    } finally { console.log("fin " + x); }
  });
  return m.length;
}
console.log(run());
`;

  test(".forEach: refused rather than returning from the enclosing function", () => {
    expect(refusal(EACH)?.code).toBe("NT1018");
  });

  test(".map: the SAME pre-existing hole is refused by the same guard", () => {
    expect(refusal(MAP)?.code).toBe("NT1018");
  });

  test("a `finally` with NO return in it still compiles", async () => {
    const src = `
const xs: number[] = [1, 2, 3];
xs.forEach((x) => {
  try { console.log("body " + x); } finally { console.log("fin " + x); }
});
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a `return` in a try WITHOUT a finally still compiles", async () => {
    const src = `
const xs: number[] = [1, 2, 3];
xs.forEach((x) => {
  try { if (x === 2) { return; } console.log(x); } catch (e) { console.log("no"); }
});
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout).toBe("1\n3\n");
  });

  /* Both remedies the hint names, compiled and checked against node. */
  test("hint remedy 1 — move the try/finally into a named helper", async () => {
    expect(refusal(MAP)?.hint).toContain("named helper");
    const src = `
function step(x: number): number {
  try {
    if (x === 2) { return 99; }
    console.log("body " + x);
    return x;
  } finally { console.log("fin " + x); }
}
const xs: number[] = [1, 2, 3];
console.log(xs.map((x) => step(x)).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
    expect(oracle.stdout).toBe("body 1\nfin 1\nfin 2\nbody 3\nfin 3\n1,99,3\n");
  });

  test("hint remedy 2 — assign to a local, return it after the try/finally", async () => {
    expect(refusal(MAP)?.hint).toContain("after the `try`/`finally` ends");
    const src = `
const xs: number[] = [1, 2, 3];
const m: number[] = xs.map((x) => {
  let r = 0;
  try {
    if (x === 2) { r = 99; } else { console.log("body " + x); r = x; }
  } finally { console.log("fin " + x); }
  return r;
});
console.log(m.join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
    expect(oracle.stdout).toBe("body 1\nfin 1\nfin 2\nbody 3\nfin 3\n1,99,3\n");
  });
});

/*
 * `.forEach` runs for EFFECT, so this is the load-bearing half. Read `__arrLive()` /
 * `__objLive()`, never stdout: the HOF-body leak a prior lane fixed had completely
 * correct stdout, and macOS cannot see it at all (test/hof-drops.test.ts).
 *
 * The CONTROLS come first and matter more than the leak: freeing a value the body only
 * CAPTURED, or freeing the receiver twice, is a use-after-free rather than a leak.
 */
describe(".forEach ownership — an inlined body is a scope", () => {
  test("a nested-block local inside the body is freed per iteration", async () => {
    const src = `
function run(): number {
  const src: number[] = [1, 2, 3, 4];
  src.forEach((x) => {
    let n = 0;
    if (x > 1) { const a: number[] = [x, x, x]; n = a[0] + a.length; }
    console.log(n);
  });
  return src.length;
}
console.log(run());
console.log(__arrLive());
console.log(__objLive());
`;
    // `__arrLive`/`__objLive` are nativets builtins node has no answer for, so these
    // counter cases compile-and-run only — the node-differential cases are above.
    const ours = await compileAndRun(src);
    expect(ours.exitCode).toBe(0);
    // 0/5/6/7, then 4, then BOTH counters at zero — the per-iteration arrays are freed.
    expect(ours.stdout).toBe("0\n5\n6\n7\n4\n0\n0\n");
  });

  /* CONTROL. The body CAPTURES `keep`; the enclosing scope owns it. If the inlined body
   * were treated as owning it, `keep` would be freed on the first iteration and read
   * through on the second — a use-after-free, not a leak. */
  test("a value the body only CAPTURES is not freed by the body", async () => {
    const src = `
function run(): number {
  const keep: number[] = [10, 20, 30];
  const xs: number[] = [0, 1, 2];
  xs.forEach((i) => { console.log(keep[i] + keep.length); });
  return keep[0];
}
console.log(run());
console.log(__arrLive());
`;
    const ours = await compileAndRun(src);
    expect(ours.exitCode).toBe(0);
    // The third line still reads `keep` — a body that freed it would read freed storage.
    expect(ours.stdout).toBe("13\n23\n33\n10\n0\n");
  });

  test("a chained receiver's temporary array is freed", async () => {
    const src = `
function run(): number {
  const xs: number[] = [1, 2, 3];
  xs.map((x) => x * 10).forEach((y) => console.log(y));
  return 0;
}
console.log(run());
console.log(__arrLive());
`;
    const ours = await compileAndRun(src);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("10\n20\n30\n0\n0\n");
  });

  test("string locals in the body are refcounted, not leaked", async () => {
    const src = `
function run(): number {
  const xs: string[] = ["a", "bb", "ccc"];
  xs.forEach((s) => { const t: string = s + "!"; console.log(t); });
  return xs.length;
}
console.log(run());
console.log(__arrLive());
console.log(__objLive());
`;
    const ours = await compileAndRun(src);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("a!\nbb!\nccc!\n3\n0\n0\n");
  });

  /* Two `.forEach` bodies in one frame, both naming `t` at DIFFERENT types. Inlined
   * callbacks share the enclosing flat frame, so without `freshenHofArrow` the second
   * reads a string slot as a double (see genForEach). */
  test("sibling callbacks reusing a name at different types do not collide", async () => {
    const src = `
function run(): number {
  const ns: number[] = [1, 2];
  const ss: string[] = ["x", "y"];
  ns.forEach((v) => { const t: number = v * 100; console.log(t); });
  ss.forEach((v) => { const t: string = v + "!"; console.log(t); });
  return 0;
}
console.log(run());
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("100\n200\nx!\ny!\n0\n");
  });

  /* THE SAME COLLISION ONE AST NODE DEEPER, and it was live — a silent wrong answer, not a
   * refusal. `for (const [k, v] of map)` binds TWO names, `name` and `name2`, and the
   * freshening walk handled only `name`: `collectBoundNames` never added `name2` to the
   * bound set and `subStmt`'s `ForOfStmt` case never renamed it. So the value half kept its
   * source spelling in every inlining. The first callback fixed `v`'s slot as a double, the
   * second reused that slot for a string ptr, and the program printed
   *
   *   10:a2.139169827e-314b2.139169828e-314   where node prints   10:axby
   *
   * at exit 0 — the one outcome this compiler refuses to have. The KEY half was already
   * safe, which is what kept it hidden: any test that only reads `k` passes either way.
   * Both types differ here on purpose, so a shared slot cannot come out looking plausible. */
  test("the VALUE half of a Map-entry for-of is freshened too, not just the key", async () => {
    const src = `
const nums: Map<string, number> = new Map<string, number>().set("a", 1).set("b", 2);
const strs: Map<string, string> = new Map<string, string>().set("a", "x").set("b", "y");
const one: number[] = [10, 20].map((n) => {
  let acc = 0;
  for (const [k, v] of nums) { acc = acc + v + k.length; }
  return n + acc;
});
const two: string[] = [10, 20].map((n) => {
  let acc = "";
  for (const [k, v] of strs) { acc = acc + k + v; }
  return \`\${n}:\${acc}\`;
});
console.log(one.join(","));
console.log(two.join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("15,25\n10:axby,20:axby\n");
  });

  test("nested .forEach iterates the cross product in node's order", async () => {
    const src = `
const rows: number[] = [1, 2];
const cols: number[] = [10, 20];
rows.forEach((r) => { cols.forEach((c) => { console.log(r * c); }); });
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout).toBe("10\n20\n20\n40\n");
  });

  /* An inlined callback writing a captured `let` is a plain store into the same flat
   * frame — no env, no escape. Already true of `.map`; `.forEach` inherits it rather
   * than widening anything. */
  test("writing a captured `let` from the body matches node", async () => {
    const src = `
function run(): number {
  let sum = 0;
  const src: number[] = [1, 2, 3, 4];
  src.forEach((x) => { sum = sum + x; });
  return sum;
}
console.log(run());
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout).toBe("10\n");
  });

  /* THE BOUNDARY THAT MOVED. This test used to pin `.push` to a `@@mutable` accumulator
   * from an inlined callback as NT1607 ("a closure captures it"), noting in the same
   * breath that the reasoning does not hold for an inlined arrow — there is no env and
   * nothing that can outlive the binding — and leaving the relaxation to another lane.
   * That lane measured it: the premise really was false, the refusal is now restricted to
   * arrows that GET an env, and both spellings compile. See test/push-accumulator.test.ts
   * for the full split, including the closure shapes that keep the refusal because for
   * them the premise is real.
   *
   * What this test still pins is the EQUALITY it was written to pin — `.forEach` behaves
   * exactly as `.map` does here, inheriting the rule rather than dodging or widening it. */
  test("`.push` to a @@mutable accumulator now compiles — same as .map, not special to forEach", async () => {
    const each = `
function run(): number {
  @@mutable let out: number[] = [];
  const xs: number[] = [1, 2, 3];
  xs.forEach((x) => { out.push(x * 2); });
  return out.length;
}
console.log(run());
`;
    const map = `
function run(): number {
  @@mutable let out: number[] = [];
  const xs: number[] = [1, 2, 3];
  const m: number[] = xs.map((x) => { out.push(x * 2); return x; });
  return m.length;
}
console.log(run());
`;
    expect(ownCodes(each)).toEqual([]);
    expect(ownCodes(map)).toEqual([]); // the control: the same answer, as it always was
    // …and the accepted program is the right one. Asserted against a literal rather than
    // against node, because these fixtures use the BARE `@@mutable` attribute, which is a
    // syntax error to node — the node-oracle duty for this shape lives in
    // test/push-accumulator.test.ts, which uses the `//@@mutable` comment spelling.
    const ours = await compileAndRun(each);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("3\n");
  });

  test("an empty array runs the body zero times", async () => {
    const src = `
const xs: number[] = [];
xs.forEach((x) => console.log(x));
console.log("done");
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout).toBe("done\n");
  });
});
