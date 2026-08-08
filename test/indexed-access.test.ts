/*
 * Indexed access types — `T["key"]` in type position (TypeScript's "lookup type").
 *
 * An indexed access type is a pure type-layer construct: it erases completely, so
 * node is the oracle for every runtime-visible case here.
 *
 * The TypeScript conformance suite
 * (`tests/cases/conformance/types/typeRelationships/indexedAccessTypes/`) is NOT
 * vendored into this repo and no network was available, so the behavior list below
 * is DERIVED from the construct's specification rather than mined. The shapes chosen
 * mirror the ones that suite is known to cover: a lookup into an interface, into a
 * `type` alias, a lookup whose result is itself a record, a lookup through an array
 * element type, and the error paths (a key that does not exist, a non-literal index).
 *
 * What is supported is the shape the parser can resolve PRECISELY: a base type whose
 * structure is known in this file, indexed by a string LITERAL. Everything else is
 * refused as NT1029 rather than erased to a guess — see the refusal block below.
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
 * `needle` — so a case meant to prove "this lookup cannot be resolved" cannot pass by
 * being rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("indexed access types", () => {
  test("a lookup into an interface resolves to the field's type", async () => {
    await expectNode(`
interface Rec { a: string; b: number }
const s: Rec["a"] = "hi";
console.log(s);
`);
  });

  test("a lookup into a `type` alias resolves to the field's type", async () => {
    await expectNode(`
type Rec = { a: string; b: number };
const n: Rec["b"] = 21;
console.log(n * 2);
`);
  });

  /*
   * The PRECISION test, and the reason this is a resolution rather than an erasure.
   * `Rec["b"]` is `number`, so a string initializer must be REJECTED. If the lookup
   * silently erased to `number`-as-a-guess this would still pass, so the mirror case
   * above (`Rec["a"]` accepting a string) is what pins it down: one of the two would
   * fail under any single fixed erasure.
   */
  test("the resolved field type is enforced, not erased", () => {
    expectRejected(
      `
interface Rec { a: string; b: number }
const n: Rec["b"] = "not a number";
console.log(n);
`,
      "NT2001",
      "number",
    );
  });

  test("a lookup whose result is itself a record keeps that record's fields", async () => {
    await expectNode(`
interface Inner { x: number }
interface Outer { inner: Inner; name: string }
const i: Outer["inner"] = { x: 5 };
console.log(i.x);
`);
  });

  // The position that blocked the compiler's own source: a lookup as a PARAMETER type.
  test("a lookup works in parameter and return position", async () => {
    await expectNode(`
interface Cfg { width: number; label: string }
function widen(w: Cfg["width"]): Cfg["width"] { return w * 2; }
function label(): Cfg["label"] { return "ok"; }
console.log(widen(21), label());
`);
  });

  test("an array suffix still applies after a lookup", async () => {
    await expectNode(`
interface Rec { a: string; b: number }
const xs: Rec["a"][] = ["p", "q"];
console.log(xs.join(","));
`);
  });

  /* ---- refusals: the shapes that would have to be guessed (NT1029) ---- */

  test("a non-literal index is refused, not guessed", () => {
    expectRejected(
      `
interface Rec { a: string; b: number }
const s: Rec[number] = "hi";
console.log(s);
`,
      "NT1029",
      "not a string literal",
    );
  });

  test("a base whose fields this file does not know is refused", () => {
    expectRejected(
      `
const s: Missing["a"] = "hi";
console.log(s);
`,
      "NT1029",
      "not a record type whose fields are known in this file",
    );
  });

  test("a key the record does not have is refused", () => {
    expectRejected(
      `
interface Rec { a: string; b: number }
const s: Rec["nope"] = "hi";
console.log(s);
`,
      "NT1029",
      "has no field 'nope'",
    );
  });
});
