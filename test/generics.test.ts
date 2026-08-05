/*
 * M3 — generic functions by MONOMORPHIZATION (NT1013).
 *
 * `function f<T>(x: T): T` is no longer erased-to-number: the checker collects every
 * concrete type-argument tuple `f` is instantiated with (explicit `f<string>(…)` type
 * args, or inferred by unifying the parameter annotations against the argument types),
 * emits ONE specialized `FuncDecl` per distinct instantiation under a mangled name,
 * and rewrites each call to its specialization. A generic with zero instantiations
 * emits nothing.
 *
 * node runs every case here unmodified (it just strips the type annotations), so node
 * stays the oracle — these are differential tests.
 */
import { test, expect, describe } from "bun:test";
import { expectMatchesNode, compileAndRun, emitIR } from "./harness.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile-only: return the NT diagnostic a source is REJECTED with (never miscompiled). */
function rejection(source: string): { code: string; message: string } {
  try {
    emitIR(source);
  } catch (e) {
    if (e instanceof NTError) return { code: e.diag.code, message: e.diag.message };
    throw e;
  }
  throw new Error("expected a diagnostic, but the source compiled");
}

/** Differential: our binary must match `node <source>` byte-for-byte. */
async function matches(source: string): Promise<string> {
  const { ours, oracle } = await expectMatchesNode(source);
  expect(oracle.exitCode).toBe(0); // the oracle itself must be well-formed
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("M3 monomorphization: generic functions", () => {
  test("1. a generic used at ONE type (number) works", async () => {
    const out = await matches(`
function id<T>(x: T): T { return x; }
console.log(id(5));
console.log(id(3) + id(4));
`);
    expect(out).toBe("5\n7\n");
  });

  test("2. the SAME generic at number AND string → two specializations, both correct", async () => {
    const out = await matches(`
function id<T>(x: T): T { return x; }
console.log(id(41) + 1);
console.log(id("hello") + "!");
console.log(id(true));
`);
    expect(out).toBe("42\nhello!\ntrue\n");
    // Two distinct specializations are emitted (and the generic itself is NOT).
    const ir = emitIR(`function id<T>(x: T): T { return x; }\nconsole.log(id(1));\nconsole.log(id("a"));\n`);
    expect(ir).not.toContain("define double @id(");
    expect(ir).toContain("@id$number(");
    expect(ir).toContain("@id$string(");
  });

  test("3. inference through an ARRAY parameter: first<T>(xs: T[]): T", async () => {
    const out = await matches(`
function first<T>(xs: T[]): T { return xs[0]; }
function last<T>(xs: T[]): T { return xs[xs.length - 1]; }
const ns: number[] = [3, 1, 4];
const ss: string[] = ["a", "b", "c"];
console.log(first(ns));
console.log(first(ss));
console.log(last(ns) + last(ss));
`);
    expect(out).toBe("3\na\n4c\n");
  });

  test("4. TWO type parameters: pair<A, B>(a: A, b: B): string", async () => {
    const out = await matches(`
function pair<A, B>(a: A, b: B): string { return "(" + a + ", " + b + ")"; }
console.log(pair(1, "x"));
console.log(pair("y", 2));
console.log(pair(true, 3));
console.log(pair(4, 5));
`);
    expect(out).toBe("(1, x)\n(y, 2)\n(true, 3)\n(4, 5)\n");
  });

  test("5. EXPLICIT call-site type arguments pin the instantiation", async () => {
    const out = await matches(`
function id<T>(x: T): T { return x; }
function nothing<T>(): number { return 7; }
console.log(id<string>("x"));
console.log(id<number>(9));
console.log(nothing<string>());
`);
    expect(out).toBe("x\n9\n7\n");
  });

  test("6. generic over a CALLBACK and a generic-typed array: mapAll<T, U>(xs: T[], f: (t: T) => U): U[]", async () => {
    const out = await matches(`
function mapAll<T, U>(xs: T[], f: (t: T) => U): U[] {
  return xs.map((x) => f(x));
}
const ns: number[] = [1, 2, 3];
console.log(mapAll(ns, (n: number) => n * 2).join(","));
console.log(mapAll(ns, (n: number) => "#" + n).join("|"));
const ws: string[] = ["ab", "cde"];
console.log(mapAll(ws, (w: string) => w.length).join("-"));
`);
    expect(out).toBe("2,4,6\n#1|#2|#3\n2-3\n");
  });

  test("6b. an UNANNOTATED callback gets its parameter type from the resolved instantiation", async () => {
    const out = await matches(`
function mapAll<T, U>(xs: T[], f: (t: T) => U): U[] { return xs.map((x) => f(x)); }
const ns: number[] = [1, 2, 3];
console.log(mapAll(ns, (n) => n * 2).join(","));
console.log(mapAll(ns, (n) => "#" + n).join("|"));
`);
    expect(out).toBe("2,4,6\n#1|#2|#3\n");
  });

  test("8. RECURSION inside a generic reuses its own instantiation (no infinite expansion)", async () => {
    const out = await matches(`
function countFrom<T>(xs: T[], i: number): number {
  if (i >= xs.length) return 0;
  return 1 + countFrom(xs, i + 1);
}
function showAll<T>(xs: T[], i: number): string {
  if (i >= xs.length) return "";
  return "[" + xs[i] + "]" + showAll(xs, i + 1);
}
const ns: number[] = [5, 6, 7];
const ss: string[] = ["a", "b"];
console.log(countFrom(ns, 0));
console.log(countFrom(ss, 0));
console.log(showAll(ns, 0) + showAll(ss, 0));
`);
    expect(out).toBe("3\n2\n[5][6][7][a][b]\n");
    // exactly ONE specialization per (function, type-tuple) — the self-call reuses it.
    const ir = emitIR(`function countFrom<T>(xs: T[], i: number): number {
  if (i >= xs.length) return 0;
  return 1 + countFrom(xs, i + 1);
}
const ns: number[] = [1];
console.log(countFrom(ns, 0));
`);
    expect(ir.match(/define double @countFrom\$/g)?.length).toBe(1);
  });
});

describe("M3: heap type arguments, ownership and drops", () => {
  test("10. T bound to an OBJECT / ARRAY type works like any concrete type", async () => {
    const out = await matches(`
function label<T>(x: T): string { return "<" + JSON.stringify(x) + ">"; }
function wrap<T>(x: T): T[] { const out: T[] = [x]; return out; }
console.log(label({ x: 1, y: 2 }));
console.log(label(7));
console.log(label("s"));
console.log(wrap(5).length);
console.log(wrap("a")[0]);
`);
    expect(out).toBe(`<{"x":1,"y":2}>\n<7>\n<"s">\n1\na\n`);
  });

  test("11. deterministic DROP still fires inside every specialization (no leak)", async () => {
    const out = await matches(`
function build<T>(a: T, b: T): number { const tmp: T[] = [a, b]; return tmp.length; }
console.log(build(1, 2));
console.log(build("a", "b"));
`);
    expect(out).toBe("2\n2\n");
    // `__arrLive()` is the runtime's live-NtArray counter (see test/drops.test.ts) and has
    // no node equivalent, so this half is behavioral, not differential: every array a
    // specialization builds is freed at its scope exit, exactly once.
    const live = await compileAndRun(`
function build<T>(a: T, b: T): number { const tmp: T[] = [a, b]; return tmp.length; }
build(1, 2);
build("a", "b");
console.log(__arrLive());
`);
    expect(live.stdout).toBe("0\n");
  });

  test("12. the OWNERSHIP pass analyzes specializations like ordinary functions", () => {
    // `firstOf<T>` is fine at T = number (a Copy element) but moves out of an array
    // element at T = an object type — reported per SPECIALIZATION, exactly as if the
    // concrete function had been written by hand (rustc E0508 ≈ NT1605).
    expect(emitIR(`function firstOf<T>(xs: T[]): T { return xs[0]; }
const ns: number[] = [9, 8];
console.log(firstOf(ns));
`)).toContain("@firstOf$number(");
    const r = rejection(`function firstOf<T>(xs: T[]): T { return xs[0]; }
const ps = [{ x: 1 }, { x: 2 }];
console.log(firstOf(ps).x);
`);
    expect(r.code).toBe("NT1605");
  });
});

describe("M3: generic ARROWS (values, not declarations)", () => {
  test("7. an inline generic arrow takes its CONTEXTUAL type; a standalone one erases to number", async () => {
    // An arrow is a value with no call site to specialize on, so `<T>` on an arrow is not
    // monomorphized. Used as an argument it now takes the contextual parameter type (so a
    // generic arrow works at string); standalone it keeps the pre-M3 erasure to `number`.
    const out = await matches(`
function apply<T, U>(f: (t: T) => U, x: T): U { return f(x); }
console.log(apply(<T>(v: T): T => v, "ctx"));
const identity = <T>(x: T): T => x;
console.log(identity(99));
`);
    expect(out).toBe("ctx\n99\n");
  });
});

describe("M3: reject-don't-miscompile at the edges of monomorphization", () => {
  test("9a. a type argument that CANNOT be inferred is NT1013 with a hint to pass it", () => {
    const r = rejection(`function make<T>(): number { return 1; }\nconsole.log(make());\n`);
    expect(r.code).toBe("NT1013");
    expect(r.message).toContain("cannot infer type argument 'T'");
    // ...and passing it explicitly is accepted.
    expect(emitIR(`function make<T>(): number { return 1; }\nconsole.log(make<string>());\n`)).toContain("@make$string(");
  });

  test("9b. POLYMORPHIC recursion (self-call at a bigger type) is NT1013, not an infinite loop", () => {
    const r = rejection(`
function grow<T>(x: T): number {
  const boxed: T[] = [x];
  if (boxed.length > 100) return grow(boxed);
  return boxed.length;
}
console.log(grow(1));
`);
    expect(r.code).toBe("NT1013");
    expect(r.message).toContain("polymorphic recursion");
  });

  test("9c. a generic used as a VALUE is NT1013 (specialization happens at the call site)", () => {
    const r = rejection(`function id<T>(x: T): T { return x; }\nconst f = id;\nconsole.log(f(3));\n`);
    expect(r.code).toBe("NT1013");
    expect(r.message).toContain("used as a value");
  });

  test("9d. a generic CLASS stays a clean NT1015 (classes are not monomorphized)", () => {
    const r = rejection(`class Box<T> { constructor(readonly v: T) {} }\nconsole.log(1);\n`);
    expect(r.code).toBe("NT1015");
  });

  test("9e. a generic nobody calls emits NOTHING (zero instantiations)", () => {
    const ir = emitIR(`function unused<T>(x: T): T { return x; }\nconsole.log(1);\n`);
    expect(ir).not.toContain("@unused");
  });

  test("9f. an argument that mismatches the RESOLVED instantiation is an ordinary type error", () => {
    const r = rejection(`function same<T>(a: T, b: T): T { return a; }\nconsole.log(same(1, "x"));\n`);
    expect(r.code).toBe("NT2001");
  });
});
