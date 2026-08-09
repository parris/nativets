/*
 * `interface B extends A` — interface INHERITANCE.
 *
 * An interface is erased STRUCTURALLY here: a declaration is nothing but a name bound
 * to a `Ty` string (`{a:number,b:number}`), and the field ORDER in that string IS the
 * slot order codegen geps with. So inheritance is field-set UNION at resolution time:
 * the base's fields first, in base order, then the derived declaration's own. A field
 * the derived declaration REDECLARES overrides the base's type but KEEPS the base's
 * slot, which is what makes the common discriminated-union idiom
 * (`interface Base { kind: string }` / `interface A extends Base { kind: "a" }`) line
 * its tag up at the same index in every member — the invariant SH2's
 * `unionDiscriminant` proves.
 *
 * Before this, the `extends` clause was PARSED AND DISCARDED (src/parser.ts), so `B`
 * resolved to its own fields alone. That is not merely a missing feature: it is a
 * silent wrong answer. `JSON.stringify({a:10,b:2} as B)` printed `{"b":2}` where node
 * prints `{"a":10,"b":2}`, exit 0 both sides — see "the base was DROPPED" below, which
 * is the regression guard for exactly that program.
 *
 * The TypeScript conformance suite (`tests/cases/conformance/interfaces/
 * interfaceDeclarations/`) is NOT vendored into this repo and no network was
 * available, so the behavior list here is DERIVED from the construct's specification
 * rather than mined. The shapes mirror the ones that suite is known to cover:
 * single-base inheritance, multiple bases, a chain, a base declared later in the file,
 * a member redeclared in the derived interface, and inheriting from a class.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/**
 * Assert the source is REFUSED with the given code, and that the message mentions
 * `needle` — so a case meant to prove "this base cannot be inherited" cannot pass by
 * being rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("interface extends", () => {
  test("a single base contributes its fields", async () => {
    await expectNode(`
interface A { a: number }
interface B extends A { b: number }
const x: B = { a: 1, b: 2 };
console.log(x.a + x.b);
`);
  });

  /*
   * THE REGRESSION GUARD for the silent wrong answer. `x.a` is never READ here, so
   * nothing forces the base's field to exist — a dropped base compiled cleanly and
   * printed `{"b":2}` with exit 0. Only a whole-object observation catches it.
   */
  test("the base was DROPPED — the whole object is observed, not one field", async () => {
    await expectNode(`
interface A { a: number }
interface B extends A { b: number }
const x: B = { a: 10, b: 2 };
console.log(JSON.stringify(x));
`);
  });

  test("multiple bases, in clause order", async () => {
    await expectNode(`
interface A { a: number }
interface B { b: number }
interface C extends A, B { c: number }
const x: C = { a: 1, b: 2, c: 3 };
console.log(JSON.stringify(x));
`);
  });

  test("a chain — C extends B extends A", async () => {
    await expectNode(`
interface A { a: number }
interface B extends A { b: number }
interface C extends B { c: number }
const x: C = { a: 1, b: 2, c: 3 };
console.log(JSON.stringify(x));
`);
  });

  /* Types are hoisted in TypeScript, and `hoistTypeDecls` (src/parser.ts) already
   * resolves a declaration whose dependency is declared lower in the file — the base
   * list rides that machinery unchanged, because it is resolved with `parseType`. */
  test("a base declared LATER in the file", async () => {
    await expectNode(`
interface B extends A { b: number }
interface A { a: number }
const x: B = { a: 1, b: 2 };
console.log(x.a + x.b);
`);
  });

  test("a `type` alias as the base", async () => {
    await expectNode(`
type A = { a: number };
interface B extends A { b: number }
const x: B = { a: 1, b: 2 };
console.log(x.a + x.b);
`);
  });

  test("a base that is itself recursive keeps its back-edge", async () => {
    await expectNode(`
interface N { v: number, next: N | null }
interface M extends N { tag: string }
const m: M = { v: 1, next: null, tag: "t" };
console.log(m.v, m.tag);
`);
  });

  /*
   * The ordering argument, made observable. `kind` is declared by the BASE, so it lands
   * at index 0 in both members even though they have different field counts — which is
   * what lets SH2's `unionDiscriminant` (src/ast.ts) prove the tag sits at the same slot
   * in every member and build the `U<…>`. Appending the base instead would put `kind` at
   * index 2 in one member and index 1 in the other, and the union would be REFUSED.
   */
  test("base-first ordering lines a discriminant up across members", async () => {
    await expectNode(`
interface Base { kind: string }
interface Add extends Base { kind: "add", lhs: number, rhs: number }
interface Neg extends Base { kind: "neg", arg: number }
type E = Add | Neg;
function ev(e: E): number { if (e.kind === "add") { return e.lhs + e.rhs; } return -e.arg; }
console.log(ev({ kind: "add", lhs: 2, rhs: 3 }), ev({ kind: "neg", arg: 7 }));
`);
  });

  /* A redeclared member overrides the base's type and keeps the base's SLOT, so the
   * field order is the base's. node erases both annotations, so it is the oracle. */
  test("a redeclared member overrides in place", async () => {
    await expectNode(`
interface A { a: number, k: string }
interface B extends A { a: number }
const x: B = { a: 1, k: "z" };
console.log(JSON.stringify(x));
`);
  });

  describe("refused rather than inherited (docs/divergences.md)", () => {
    /* An interface may extend a CLASS in TypeScript. Here a class instance type is
     * `C{…}` — tagged — and the tag is what method resolution keys on, so folding its
     * fields into an untagged record would silently drop every method. */
    test("a class base", () => {
      expectRejected(`
class P { x: number; constructor(x: number) { this.x = x; } }
interface I extends P { y: number }
const v: I = { x: 1, y: 2 };
console.log(v.x + v.y);
`, "NT1034", "'P' is not a plain record type");
    });

    /* `@@mutable` makes a record NOMINAL (docs/decorators.md) for exactly the reason a
     * class is: an undecorated record must never become mutable by sharing a shape. */
    test("a `@@mutable` record base", () => {
      expectRejected(`
@@mutable type C = { n: number };
interface D extends C { m: number }
const d: D = { n: 1, m: 2 };
console.log(d.n + d.m);
`, "NT1034", "'C' is not a plain record type");
    });

    /* A base with no field list at all. `Record<string, number>` is a Map here, not a
     * record — inheriting from it would inherit nothing, silently. */
    test("a base that is not a record", () => {
      expectRejected(`
interface B extends Record<string, number> { b: number }
const x: B = { b: 2 };
console.log(x.b);
`, "NT1034", "is not a plain record type");
    });
  });
});
