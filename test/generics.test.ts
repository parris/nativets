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

describe("M3: the parameter-list edges `instantiate` decides positionally", () => {
  /*
   * `instantiate` reads the parameter list three ways — clamping the argument index to the
   * last pattern for a REST parameter, counting the FIXED (non-rest, non-default) params,
   * and flagging whether the specialization is variadic. All three were spelled with
   * `patterns.at(-1)` / `spec.params.at(-1)?.rest`, which the compiler refuses on itself
   * (NT1001: `.at` on an array of records hands back an element that aliases its owner),
   * and the clamp additionally produced index -1 on a ZERO-parameter template — `undefined`
   * to node, a PANIC here, the class test/no-index-last.test.ts exists for.
   *
   * These pin the observable behaviour those reads decide, so the rewrite to a walk and an
   * explicit `idx < 0` guard is checked against node rather than against itself.
   */
  test("10a. a generic REST parameter: zero, some, and a second instantiation", async () => {
    const out = await matches(`
function joinAll<T>(sep: string, ...xs: T[]): string {
  let out = "";
  for (let i = 0; i < xs.length; i++) out = i === 0 ? \`\${xs[i]!}\` : \`\${out}\${sep}\${xs[i]!}\`;
  return out;
}
console.log(joinAll<number>("-", 1, 2, 3));
console.log(joinAll<string>(",", "a", "b"));
console.log(joinAll<number>("-"));
`);
    expect(out).toBe("1-2-3\na,b\n\n");
  });

  test("10b. a generic DEFAULT parameter is still optional at the call site", async () => {
    const out = await matches(`
function firstOr<T>(d: T, xs: T[] = []): T { return xs.length > 0 ? xs[0]! : d; }
console.log(firstOr<number>(9, [4, 5]));
console.log(firstOr<number>(9));
`);
    expect(out).toBe("4\n9\n");
  });

  test("10c. a ZERO-parameter template given an argument is an arity error, not a panic", () => {
    // The clamp has no pattern to fall back on here. It must reach the ordinary arity
    // check — a self-hosted compiler that read index -1 would abort instead.
    const r = rejection(`function f<T>(): number { return 1; }\nconsole.log(f<number>(1));\n`);
    expect(r.code).toBe("NT2001");
    expect(r.message).toContain("expects 0..0 args, got 1");
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

  /*
   * The shapes AROUND a generic method that are still refused. Each used to be — or would
   * naturally become — a message naming the wrong construct, which is what CLAUDE.md's
   * "a code with a hint that names the real problem" forbids. In particular a generic
   * method was once reported as `class field 't' needs a type annotation`: the parser
   * reads the member name, tests for `(`, and a `<` fails that test, so it fell into the
   * FIELD branch. Derived from the real blocker at src/modules.ts:122 — no conformance
   * suite is available in this repo, so these are DERIVED, not mined.
   */
  test("9d-bis. a generic STATIC method is refused, naming the real construct", () => {
    const r = rejection(`class C { static t<T>(x: T): T { return x; } }\nconsole.log(C.t(5));\n`);
    expect(r.code).toBe("NT1013");
    expect(r.message).not.toContain("needs a type annotation");
    expect(r.message).toContain("generic STATIC method");
  });

  test("9d-ter. type parameters on a constructor / a field name the real construct", () => {
    expect(rejection(`class C { constructor<T>(x: T) {} }\nconsole.log(1);\n`).message).toContain("Type parameters on a constructor");
    expect(rejection(`class C { t<number>; }\nconsole.log(1);\n`).message).toContain("Type parameters on class field");
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

/*
 * Generic METHODS on a class — the same monomorphization, not a second mechanism.
 *
 * A method already lowers to the top-level `FuncDecl` `C.m(this, …params)` (parser), so a
 * generic method is that same FuncDecl carrying `typeParams`. The checker's existing
 * template registration picks it up with no special case; the only receiver-specific bits
 * are that the template's leading `this` matches no argument (`recvOffset`) and that the
 * call is retargeted by rewriting the callee's PROPERTY rather than its name, since
 * codegen rebuilds the symbol as `${classTag(receiver)}.${property}`.
 *
 * Generic CLASSES (`class Box<T>`) remain out of scope and refused — see 9d above.
 *
 * node runs every case unmodified (it just strips the annotations), so node stays the
 * oracle. Cases are DERIVED — no TypeScript conformance suite is available in this repo.
 */
describe("M3 monomorphization: generic methods", () => {
  test("m1. a generic method at ONE type", async () => {
    const out = await matches(`
class C {
  t<T>(x: T): T { return x; }
}
const c = new C();
console.log(c.t(5));
`);
    expect(out).toBe("5\n");
  });

  test("m2. the SAME method at TWO types specializes twice", async () => {
    const out = await matches(`
class C {
  t<T>(x: T): T { return x; }
}
const c = new C();
console.log(c.t(5));
console.log(c.t("a"));
`);
    expect(out).toBe("5\na\n");
  });

  test("m3. two type parameters, inferred independently", async () => {
    const out = await matches(`
class Pair {
  first<A, B>(a: A, b: B): A { return a; }
}
const p = new Pair();
console.log(p.first(1, "x"));
console.log(p.first("y", 2));
`);
    expect(out).toBe("1\ny\n");
  });

  test("m4. explicit call-site type arguments pin the instantiation", async () => {
    const out = await matches(`
class C {
  t<T>(x: T): T { return x; }
}
const c = new C();
console.log(c.t<string>("a"));
`);
    expect(out).toBe("a\n");
  });

  // NB: a parameter property (`constructor(private p: string)`) is NOT erasable syntax, so
  // node refuses to run it and it cannot appear in a differential case — hence the plain
  // field + explicit assignment here. See the header of test/classes.test.ts.
  test("m5. the method body may use `this` (the receiver still flows)", async () => {
    const out = await matches(`
class Tagger {
  prefix: string;
  constructor(p: string) { this.prefix = p; }
  tag<T>(x: T): string { return this.prefix + x; }
}
const t = new Tagger("v=");
console.log(t.tag(7));
console.log(t.tag("s"));
`);
    expect(out).toBe("v=7\nv=s\n");
  });

  test("m6. a constrained type parameter — the constraint is erased, as for functions", async () => {
    // This is the exact shape of the real blocker, src/modules.ts:122
    // (`private t<T extends Ty | undefined>(t: T): T`).
    const out = await matches(`
type Ty = string;
class Renamer {
  t<T extends Ty | undefined>(x: T): T { return x; }
}
const r = new Renamer();
console.log(r.t("a"));
console.log(r.t(undefined));
`);
    expect(out).toBe("a\nundefined\n");
  });

  test("m7. two RECEIVERS of the same class share one specialization per type", async () => {
    const out = await matches(`
class C {
  t<T>(x: T): T { return x; }
}
const a = new C();
const b = new C();
console.log(a.t(1));
console.log(b.t(2));
`);
    expect(out).toBe("1\n2\n");
  });

  test("m8. a generic method nobody calls emits NOTHING", () => {
    const ir = emitIR(`class C {\n  t<T>(x: T): T { return x; }\n}\nconsole.log(1);\n`);
    // `@C.t(` is the symbol a NON-generic `t` would define (verified: the same class with
    // `t(x: number)` emits `define double @C.t(ptr %this, double %x)`), so this assertion
    // can genuinely fail — the template must not be emitted as written.
    expect(ir).not.toContain("@C.t(");
  });

  test("m9. each specialization is emitted, and each still takes the receiver", () => {
    const ir = emitIR(`
class C {
  t<T>(x: T): T { return x; }
}
const c = new C();
console.log(c.t(5));
console.log(c.t("a"));
`);
    // One specialization per instantiation, mangled off the dotted method symbol — and
    // `ptr %this` first in BOTH, which is the whole receiver question this lane had to
    // answer. The unspecialized template must not survive.
    expect(ir).toContain("define double @C.t$number(ptr %this, double %x)");
    expect(ir).toContain("define ptr @C.t$string(ptr %this, ptr %x)");
    expect(ir).not.toContain("@C.t(");
    // `#T` is the marker for an unsubstituted type parameter; one reaching codegen is the
    // failure monomorphization exists to prevent. (Belt-and-braces: the checker's own
    // `mapTypesDeep` guard would throw first, which would also turn this test red.)
    expect(ir).not.toContain("#T");
  });

  test("m10. an uninferable type parameter is refused, naming the method", () => {
    const r = rejection(`class C {\n  t<T>(): number { return 1; }\n}\nconst c = new C();\nconsole.log(c.t());\n`);
    expect(r.code).toBe("NT1013");
    expect(r.message).toContain("generic method");
  });

  test("m11. an argument mismatching the RESOLVED instantiation is an ordinary type error", () => {
    const r = rejection(`class C {\n  same<T>(a: T, b: T): T { return a; }\n}\nconst c = new C();\nconsole.log(c.same(1, "x"));\n`);
    expect(r.code).toBe("NT2001");
  });
});
