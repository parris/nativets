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
 * The one hole those do not cover is a CLOSURE — an arrow copies the array POINTER into a
 * heap env this scope cannot null, and the closure may outlive the binding — so a push to
 * a captured accumulator is NT1607.
 *
 * node is the oracle for stdout AND exit code on every behavioural test here, because a
 * double free presents as a NONZERO EXIT with CORRECT STDOUT. The behaviours are mined
 * from test262 `test/built-ins/Array/prototype/push/` and cited per test.
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
  expect(ours.stdout.length).toBeGreaterThan(0);
}

describe("`.push` on a `@@mutable` accumulator — node is the oracle", () => {
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
