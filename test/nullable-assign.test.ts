/*
 * NULLABLE ASSIGNABILITY at a call / return boundary.
 *
 * TypeScript's assignability rules are the specification: `null` is assignable to
 * `T | null`, `undefined` to `T | undefined`, and a `T` to either. nativets refused
 * all three at a PARAMETER, because `fitsParam` was type IDENTITY — so `pick(null)`
 * against `pick(n: Node | null)` was an error on code node runs fine.
 *
 * There is NO `microsoft/TypeScript` checkout on this machine, so these cases are
 * DERIVED rather than mined. Each models a real line of this compiler's own source:
 *   - `src/checker.ts:93`   `class Scope { constructor(private parent: Scope | null = null) }`
 *                           — called as `new Scope(null)`, the compiler's symbol table;
 *   - `src/diagnostics.ts`  the `?Ustring` parameters that `docs/self-hosting.md`
 *                           records as "forces every fixture here to bind through an
 *                           annotated local".
 * node is the oracle for every runtime assertion below.
 *
 * The widening is only sound because codegen BOXES at the boundary: a nullable is a
 * heap block [tag, value], so passing a raw `string` where a `?Ustring` is expected
 * would hand the callee a string pointer to read a tag out of. `describe` block 0
 * pins the boundaries that were NOT boxing before this file existed.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Assert the source is REFUSED with the given code, and for the stated reason. */
function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic(err as NTError);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

describe("0 — every value-passing boundary BOXES into its declared type", () => {
  /*
   * PRE-EXISTING, found while widening `fitsParam`: the `return` inside a
   * `try`/`finally` stashes the value into the return slot WITHOUT coercing it to
   * the declared return type, unlike the ordinary return path. With a general-union
   * return type the stash stored a raw `string` pointer where a [tag,value] box was
   * expected — exit 255, empty stdout, where node prints "fin\nhi".
   */
  test("a `return` inside try/finally boxes into the declared union return type", async () => {
    await expectNode(`
function g(): string | boolean {
  try { return "hi"; } finally { console.log("fin"); }
}
console.log(g());
`);
  });

  // The same stash, with a NULLABLE declared return type — the shape this lane's
  // widening makes reachable for the first time (`return s` where s is a `string`).
  test("a `return` inside try/finally boxes into a nullable return type", async () => {
    await expectNode(`
function g(): string | undefined {
  try { return "hi"; } finally { console.log("fin"); }
}
const r = g();
console.log(r === undefined ? "none" : r);
`);
  });

  // A CLOSURE call went through a different emission path than a direct call, and
  // that one never coerced: it labelled the raw argument with the parameter's type.
  test("a closure call boxes its arguments", async () => {
    await expectNode(`
const f: (s: string | undefined) => string = (s) => s === undefined ? "none" : s;
console.log(f("abc"), f(undefined));
`);
  });

  // A function with a REST parameter emitted its FIXED parameters uncoerced.
  test("a rest function boxes its fixed parameters", async () => {
    await expectNode(`
function f(s: string | undefined, ...rest: number[]): string {
  return (s === undefined ? "none" : s) + ":" + rest.length;
}
console.log(f("abc", 1, 2), f(undefined, 3));
`);
  });
});

describe("1 — `null` is assignable to a `T | null` parameter", () => {
  // Models src/checker.ts:93 — `new Scope(null)` on the compiler's own symbol table.
  test("a null literal reaches a `Node | null` parameter", async () => {
    await expectNode(`
interface Node { v: number }
function pick(n: Node | null): number { return n === null ? -1 : n.v; }
console.log(pick(null), pick({ v: 7 }));
`);
  });

  test("a null literal reaches a CONSTRUCTOR parameter", async () => {
    await expectNode(`
class Scope {
  tag: string | null;
  constructor(tag: string | null = null) { this.tag = tag; }
  show(): string { return this.tag === null ? "root" : "child"; }
}
console.log(new Scope(null).show(), new Scope("x").show());
`);
  });

  /*
   * THE ACCEPTANCE GATE, verbatim from src/checker.ts:93 — the shape that was blocking
   * the recursive-type encoding lane. node cannot be the oracle here: it refuses a
   * PARAMETER PROPERTY outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, it needs codegen,
   * not type-stripping), so this asserts only that the NULL ARGUMENT is no longer what
   * stops it. A self-recursive field is still NT1030 — that refusal belongs to the
   * recursive-type lane, and is asserted here so this test cannot silently start
   * passing for the wrong reason.
   */
  test("`new Scope(null)` is no longer blocked by its null ARGUMENT", () => {
    // Non-recursive: compiles clean, parameter property and all.
    expect(() => sourceToIR(`
class Scope {
  constructor(private parent: string | null = null) {}
  depth(): number { return this.parent === null ? 0 : 1; }
}
console.log(new Scope(null).depth());
`)).not.toThrow();
    // Self-recursive: the ONLY remaining complaint is the recursive field.
    expectRejected(`
class Scope {
  constructor(private parent: Scope | null = null) {}
}
const s = new Scope(null);
console.log("ok");
`, "NT1030", "parent");
  });

  test("a null-typed VARIABLE reaches a `T | null` parameter", async () => {
    await expectNode(`
function pick(n: number | null): number { return n === null ? -1 : n; }
const z = null;
console.log(pick(z), pick(9));
`);
  });
});

describe("2 — a `string` is assignable to a `string | undefined` parameter", () => {
  // docs/self-hosting.md records the literal half; a later measurement found the
  // INFERRED-`const` half fails too, so only an annotated local ever passed.
  test("a string LITERAL reaches a `?Ustring` parameter", async () => {
    await expectNode(`
function f(s: string | undefined): string { return s === undefined ? "none" : s; }
console.log(f("abc"), f(undefined));
`);
  });

  test("a const whose type is INFERRED `string` reaches a `?Ustring` parameter", async () => {
    await expectNode(`
function f(s: string | undefined): string { return s === undefined ? "none" : s; }
const c = "abc";
console.log(f(c));
`);
  });

  test("a number reaches a `number | undefined` parameter, and a computed one too", async () => {
    await expectNode(`
function f(n: number | undefined): number { return n === undefined ? -1 : n * 2; }
const k = 3;
console.log(f(4), f(k + 1), f(undefined));
`);
  });

  test("a present value reaches a nullable RETURN type", async () => {
    await expectNode(`
function f(b: boolean): string | undefined {
  if (b) { return "yes"; }
  return undefined;
}
const a = f(true);
const c = f(false);
console.log(a === undefined ? "none" : a, c === undefined ? "none" : c);
`);
  });

  /*
   * ADJACENT AND NOT TAKEN, pinned so it is a known refusal rather than a surprise.
   * The same function written with a TERNARY is still refused: the ternary JOIN wants
   * its two branches to have one type and does not widen `string` + `undefined` into
   * `?Ustring`. That is a gap in the join, not in assignability — `fitsParam` never
   * sees it — so it is a separate behavior from this file's three.
   */
  test("REFUSED: a ternary does not JOIN a present arm with `undefined`", () => {
    expectRejected(`
function f(b: boolean): string | undefined { return b ? "yes" : undefined; }
console.log(f(true));
`, "NT2001", "Ternary branches differ");
  });
});

describe("3 — the widening does NOT over-accept", () => {
  // The whole risk of widening assignability is a program that should be refused
  // slipping through. These are the refusals that must survive.
  test("`null` is still refused for a NON-nullable parameter", () => {
    expectRejected(`
function f(n: number): number { return n; }
console.log(f(null));
`, "NT2001", "got null");
  });

  test("`undefined` is still refused for a NON-nullable parameter", () => {
    expectRejected(`
function f(s: string): string { return s; }
console.log(f(undefined));
`, "NT2001", "got undefined");
  });

  test("`null` is still refused for a `T | undefined` parameter (the WRONG arm)", () => {
    expectRejected(`
function f(s: string | undefined): string { return s === undefined ? "none" : s; }
console.log(f(null));
`, "NT2001", "got null");
  });

  test("`undefined` is still refused for a `T | null` parameter (the WRONG arm)", () => {
    expectRejected(`
function f(s: string | null): string { return s === null ? "none" : s; }
console.log(f(undefined));
`, "NT2001", "got undefined");
  });

  test("a WRONG base type is still refused for a nullable parameter", () => {
    expectRejected(`
function f(s: string | undefined): string { return s === undefined ? "none" : s; }
console.log(f(41));
`, "NT2001", "got number");
  });

  /*
   * The layout guard the widening must not breach. `{v:number}` is one raw double
   * slot; `{v?:number}` is a pointer to a nullable box. A NON-literal of the merely
   * structurally-compatible type has a layout already fixed by its own declaration
   * and nothing to rewrite, so it stays refused — accepting it compiles a
   * dereference of a double (exit 255, empty stdout).
   */
  test("a structurally-compatible NON-literal is still refused for a reshaping parameter", () => {
    expectRejected(`
interface Loose { v: number }
interface Tight { v?: number }
function f(o: Tight): number { return o.v === undefined ? -1 : o.v; }
const l: Loose = { v: 1 };
console.log(f(l));
`, "NT2001", "arg 0");
  });

  test("an OBJECT LITERAL still reshapes into a nullable object parameter", async () => {
    await expectNode(`
interface Tight { v?: number }
function f(o: Tight): number { return o.v === undefined ? -1 : o.v; }
console.log(f({ v: 1 }), f({}));
`);
  });
});
