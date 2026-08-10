/*
 * `.push` on a PARAMETER — the `@@mutable` opt-in, spelled per-parameter.
 *
 * The accumulator opt-in (docs/decorators.md, `test/push-accumulator.test.ts`) attaches
 * `@@mutable` to a `let`/`const` BINDING, so it could never reach a parameter — a
 * parameter is a borrow, the caller owns it, and there is no declaration in the callee to
 * hang the attribute on. Every `.push(…)` through a parameter was therefore NT1606, and
 * that ONE construct — `src/ast.ts`'s `setBlockDrops(list, names)`, which every module
 * imports — was the single first blocker of all nine remaining compiler modules.
 *
 * WHY A PER-PARAMETER MARKER AND NOT A NOMINAL TYPE. `@@mutable` on a record works
 * because it tags a NOMINAL type, and the tag travels with the signature so the calling
 * convention stays visible at the call site. An array type is STRUCTURAL (`T[]`) — there
 * is no name to tag — so that precedent does not transfer. A marker on the parameter
 * itself satisfies the same criterion directly and more precisely: it is part of the
 * signature, and it names WHICH parameter is appended to.
 *
 * THE SPELLING NEEDS NO NEW SYNTAX. The lexer already turns a line comment whose whole
 * body is `@@name` into the two tokens `@@` + `name`, at ANY position — including inside
 * a parameter list. So
 *
 *     function collect(
 *       //@@mutable
 *       out: string[],
 *     ): void { out.push("x"); }
 *
 * is a comment to TypeScript (bun keeps running `src/*.ts`) and an attribute to nativets,
 * exactly as the record/class pragma already is. node is therefore the oracle directly,
 * with no stripping.
 *
 * WHAT MAKES IT SOUND. The runtime append cannot dangle: `NtArray` is a stable header
 * (`{len, cap, data}`) and `nt_arr_push` reallocs `data` behind it, so the caller's
 * pointer stays valid and observes the growth. A parameter is a BORROW, so the callee
 * never frees it and the caller still drops exactly once. `.push`'s argument is CONSUMED
 * (guarded on the receiver's array type, not the method name), which is the rule that
 * closed the use-after-free `.push` once had. What is left is announced by the signature.
 *
 * Three things stay refused, and each has its own row below: a push through an UNMARKED
 * parameter (the Stage 29 rule, unchanged), a push through a parameter a CLOSURE captured
 * (the accumulator's one hole, which applies verbatim here), and passing an unmarked
 * parameter INTO a marked position (which would launder mutation through a signature that
 * does not announce it).
 *
 * node is the oracle for stdout AND exit code on every behavioural test, because a double
 * free presents as a NONZERO EXIT with CORRECT STDOUT.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

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
  expect(oracle.stdout.length).toBeGreaterThan(0);
}

describe("`.push` on a `@@mutable` PARAMETER — node is the oracle", () => {
  test("the callee appends and the CALLER observes it", async () => {
    await expectMatches(`
function collect(
  //@@mutable
  out: number[],
  n: number,
): void {
  for (let i = 0; i < n; i++) out.push(i);
}
//@@mutable
let acc: number[] = [];
collect(acc, 4);
console.log(acc.join(","), acc.length);
`);
  });
});

describe("memory: a `@@mutable` parameter is still a BORROW", () => {
  // The counters have no node counterpart, so these are BEHAVIOURAL (the test/actors.test.ts
  // contract): exact expected stdout, with exit code 0 asserted separately — a double free
  // is a nonzero exit with CORRECT stdout, so the exit code is the load-bearing half.
  test("__arrLive() returns to 0: the callee never frees, the caller drops once", async () => {
    const r = await compileAndRun(`
function fill(
  //@@mutable
  out: number[],
  n: number,
): void {
  for (let i = 0; i < n; i++) out.push(i);
}
function build(n: number): number {
  //@@mutable
  let xs: number[] = [];
  fill(xs, n);
  fill(xs, n);
  return xs.length;
}
console.log(build(300), build(300));
console.log(__arrLive(), __pvNodes());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("600 600\n0 0\n");
  });

  // Measured against a CONTROL rather than against zero: an array frees its HANDLE and
  // never what its slots point at (docs/decorators.md, "a residual leak at worst, never a
  // double free"), so 200 rounds × 5 pushed objects leave 1,000 object blocks live
  // whether the accumulator is a local or a parameter. The point of the pair is that the
  // two numbers are the SAME — a parameter receiver changes neither the array count nor
  // the object count — and that the exit code is 0 in both.
  test("200 rounds through a parameter leave exactly the counts the LOCAL accumulator leaves", async () => {
    const body = (fill: string) => `
${fill}
let sum = 0;
for (let r = 0; r < 200; r++) sum = sum + build(5);
console.log(sum);
console.log(__arrLive(), __objLive());
`;
    const viaParam = await compileAndRun(body(`
function fill(
  //@@mutable
  out: { n: number }[],
  n: number,
): void {
  for (let i = 0; i < n; i++) out.push({ n: i });
}
function build(n: number): number {
  //@@mutable
  let xs: { n: number }[] = [];
  fill(xs, n);
  return xs[n - 1]!.n;
}`));
    const control = await compileAndRun(body(`
function build(n: number): number {
  //@@mutable
  let xs: { n: number }[] = [];
  for (let i = 0; i < n; i++) xs.push({ n: i });
  return xs[n - 1]!.n;
}`));
    expect(viaParam.exitCode).toBe(0);
    expect(control.exitCode).toBe(0);
    expect(viaParam.stdout).toBe(control.stdout);
    expect(viaParam.stdout).toBe("800\n0 1000\n"); // pinned so a change in the control is visible too
  });
});

describe("the marker must TRAVEL: an unmarked parameter cannot be laundered into a marked one", () => {
  /*
   * This is not decoration. It is what makes the iterator-invalidation guard below
   * REACHABLE. `outer(xs: T[])` says nothing about mutation, so a caller of `outer` has
   * no reason to think its array is about to grow — and the guard fires at the call that
   * hands the array over, which is a call to `outer`, not to `fill`. Without the rule,
   * every announcement and every check could be routed around by one unmarked hop.
   */
  test("NT1607: passing a PLAIN parameter into a `@@mutable` position", () => {
    const got = rejectionOf(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(1); }
function outer(xs: number[]): void { fill(xs); }
//@@mutable
let a: number[] = [];
outer(a);
console.log(a.length);
`);
    expect(got?.code).toBe("NT1607");
  });

  test("marking the intermediate parameter too is the fix, and it runs", async () => {
    await expectMatches(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(1); }
function outer(
  //@@mutable
  xs: number[],
): void { fill(xs); fill(xs); }
//@@mutable
let a: number[] = [];
outer(a);
console.log(a.length);
`);
  });
});

describe("the rejection table — what the marker does NOT legalize", () => {
  const rows: { what: string; code: string; source: string }[] = [
    {
      what: "an UNMARKED parameter — the Stage 29 rule, unchanged (this row is the one the accumulator lane pinned)",
      code: "NT1606",
      source: `function add(xs: number[]): void { xs.push(1); }\nconst a: number[] = [];\nadd(a);\nconsole.log(a.length);\n`,
    },
    {
      what: "`@@mutable` on a parameter that is not an array",
      code: "NT1023",
      source: `function g(\n  //@@mutable\n  n: number,\n): void { console.log(n); }\ng(1);\n`,
    },
    {
      what: "an unknown attribute on a parameter — an attribute changes how code compiles, so a typo is an error, never a comment",
      code: "NT1023",
      source: `function g(\n  //@@mutabel\n  out: number[],\n): void { console.log(out.length); }\ng([1]);\n`,
    },
    {
      what: "`@@mutable` on a DESTRUCTURING parameter — it binds names the user did not write",
      code: "NT1023",
      source: `function g(\n  //@@mutable\n  [a, b]: number[],\n): void { console.log(a, b); }\ng([1, 2]);\n`,
    },
    {
      what: "`@@mutable` on a CONSTRUCTOR parameter — `new C(…)` is a call site the rules below do not resolve",
      code: "NT1023",
      source: `class C {\n  constructor(\n    //@@mutable\n    out: number[],\n  ) { out.push(1); }\n}\nconsole.log(1);\n`,
    },
    {
      what: "a marked parameter a CLOSURE in the CALLEE captures — the accumulator's one hole, verbatim",
      code: "NT1607",
      source: `function fill(\n  //@@mutable\n  out: number[],\n): void {\n  const f = (n: number): number => out.push(n);\n  console.log(f(1));\n}\n//@@mutable\nlet a: number[] = [];\nfill(a);\nconsole.log(a.length);\n`,
    },
    {
      what: "an argument that has been MOVED OUT — an array is linear, so a second name is a move",
      code: "NT1601",
      source: `function fill(\n  //@@mutable\n  out: number[],\n): void { out.push(1); }\n//@@mutable\nlet a: number[] = [];\nconst b = a;\nfill(a);\nconsole.log(b.length);\n`,
    },
    {
      // `out.pop()` USED TO BE THIS ROW and no longer belongs in it: a DISCARDED `.pop()`
      // is part of the opt-in now (test/pop-accumulator.test.ts), on a marked parameter
      // exactly as on a `@@mutable` local or field — the callee shrinks the caller's array
      // and the caller sees it, which is the same contract the append already had.
      // `.shift` takes its place because its refusal has a reason of its own: it removes
      // from the FRONT, so every remaining element moves, and there is no `nt_arr_shift`.
      what: "the OTHER in-place mutators — the opt-in is append/drop-last, here as everywhere",
      code: "NT1606",
      source: `function f(\n  //@@mutable\n  out: number[],\n): void { out.shift(); }\nf([1, 2]);\nconsole.log(1);\n`,
    },
  ];

  for (const r of rows) {
    test(`${r.code}: ${r.what}`, () => {
      expect(rejectionOf(r.source)?.code).toBe(r.code);
    });
  }

  test("an ARROW parameter cannot carry it — refused, never silently ignored", () => {
    // A silently-ignored attribute would be the worst outcome: the reader believes the
    // append is legal and the compiler believes it is not.
    const got = rejectionOf(`const f = (\n  //@@mutable\n  out: number[],\n): number => out.push(1);\nconsole.log(f([1]));\n`);
    expect(got).not.toBeNull();
    expect(got?.code).not.toBe("?");
  });
});

describe("shapes the marker DOES admit (measured, and matching node)", () => {
  test("a FIELD path argument — the array is owned by the record, and the append is in place", async () => {
    // This is the shape `src/ownership.ts` needs: `scoped(s.body, …)` hands an AST node's
    // statement list to `setBlockDrops`, which appends its `BlockDrops` marker to it.
    await expectMatches(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(7); }
//@@mutable
type Box = { xs: number[] };
const b: Box = { xs: [1] };
fill(b.xs);
console.log(b.xs.join(","));
`);
  });

  test("a for-of ELEMENT argument — a different array from the one being walked", async () => {
    await expectMatches(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(7); }
//@@mutable
let g: number[][] = [[1], [2]];
for (const row of g) fill(row);
console.log(g[0]!.length, g[1]!.length);
`);
  });

  test("a CAPTURED local as the argument — the callee writes while the binding is live", async () => {
    // Unlike a push written INSIDE the arrow (NT1607 above), this cannot outlive the
    // binding: the append happens during the call, with the owner still in scope.
    await expectMatches(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(1); }
//@@mutable
let xs: number[] = [];
const g = (): number => xs.length;
fill(xs);
console.log(g(), xs.length);
`);
  });
});

describe("iterator invalidation reaches ACROSS the call", () => {
  /*
   * The hazard is a WRONG ANSWER, not a dangling pointer: `nt_arr_get` re-reads `data`
   * every step so nothing points at freed storage, but the for-of reads the length ONCE.
   * node re-reads it, so node walks the grown array and nativets walks the old length.
   * This is exactly the divergence NT1603 already refuses for a direct `xs.push(v)`
   * inside `for (const x of xs)`; a marked parameter would have let a call slip past it.
   */
  test("NT1603: handing the iterated array to a `@@mutable` parameter", () => {
    const got = rejectionOf(`
function fill(
  //@@mutable
  out: number[],
): void { out.push(9); }
//@@mutable
let a: number[] = [1, 2, 3];
let once = true;
for (const x of a) { if (once) { once = false; fill(a); } console.log(x); }
console.log(a.length);
`);
    expect(got?.code).toBe("NT1603");
  });

  test("the same program written with a DIRECT push is the same refusal — the codes agree", () => {
    const got = rejectionOf(`
//@@mutable
let a: number[] = [1, 2, 3];
let once = true;
for (const x of a) { if (once) { once = false; a.push(9); } console.log(x); }
console.log(a.length);
`);
    expect(got?.code).toBe("NT1603");
  });

  /*
   * Found by running it: with the call-site rules keyed on a bare-identifier callee, a
   * METHOD call slipped straight past both of them and produced a silent wrong answer —
   * `1 2 3 4` against node's `1 2 3 1 4`, exit 0 on both sides. A method's parameters
   * carry an implicit `this` at index 0, so the call-site indices are shifted by one, and
   * the lookup is by the method's bare NAME (the same name-based over-approximation
   * `setterProps` already uses for `@@mutable` setters — over-refusal, never a wrong
   * answer).
   */
  test("NT1603: a METHOD's `@@mutable` parameter is checked at the call site too", () => {
    const got = rejectionOf(`
class B {
  add(
    //@@mutable
    out: number[],
  ): void { out.push(1); }
}
//@@mutable
let a: number[] = [1, 2, 3];
const b = new B();
let once = true;
for (const x of a) { if (once) { once = false; b.add(a); } console.log(x); }
console.log(a.length);
`);
    expect(got?.code).toBe("NT1603");
  });

  test("a for-of over a DIFFERENT array is untouched", async () => {
    await expectMatches(`
function fill(
  //@@mutable
  out: number[],
  v: number,
): void { out.push(v); }
//@@mutable
let src: number[] = [1, 2, 3];
//@@mutable
let dst: number[] = [];
for (const x of src) fill(dst, x * 2);
console.log(dst.join(","));
`);
  });
});
