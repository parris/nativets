/*
 * TUPLE TYPES — `[T, U]` in type position (`NT1037`).
 *
 * nativets has no tuple type. `parseTupleType` (src/parser.ts) modelled `[T, U, …]` as
 * `T[]`: it kept the FIRST element's type and DISCARDED every other one. That erasure is
 * destructive in exactly the way NT1033's comment describes — once `[number, string]` has
 * become `number[]`, no later pass can tell it from a `number[]` the user wrote — and it
 * produced diagnostics that BLAMED THE WRONG LINE on TypeScript that `tsc` accepts and
 * node runs:
 *
 *     function second(t: [number, string]): string { return t[1]; }
 *     // was: error[NT2001] return type number does not match declared string
 *
 * The declared return type IS `string`. The `number` came from our own erasure, so the
 * message accused the user's correct code of a mismatch we had just invented.
 *
 * WHY REFUSE RATHER THAN KEEP ERASING. The erasure was recorded as a LATENT miscompile —
 * safe only because a heterogeneous array literal cannot be built (`NT2001 array elements
 * must share a type`), so the one construct that could witness the discarded type is
 * caught downstream. That is a guarantee held up by an unrelated check in another pass; if
 * it ever loosens, `t[1]` starts reading a `string` at a `number` type, which is a silent
 * wrong answer — the worst outcome available. A refusal is always acceptable, so the
 * refusal is taken now, while the gap is still theoretical.
 *
 * WHY ONLY THE HETEROGENEOUS ONES. `[T, T]` erases to `T[]` and every element really does
 * have type `T`, so nothing is misreported — only the arity is lost, and reading past the
 * end already panics (Stage 41). Refusing those too would cost `src/checker.ts` four
 * in-subset sites (`[Expr, Expr][]`, `(): [Ty, Ty]`) for no soundness gain, and would take
 * that module further from self-hosting rather than closer. The refusal is drawn exactly
 * at the set where the erasure can misreport a type.
 *
 * The TypeScript conformance suite (`tests/cases/conformance/types/tuple/`) is NOT
 * vendored into this repo and no network was available, so these cases are DERIVED from
 * the construct's specification and modelled on the shapes that suite covers: a tuple
 * return type, a tuple parameter, a tuple variable annotation, an `as` cast to a tuple,
 * and an array-of-tuple.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("tuple types", () => {
  /*
   * THE LYING DIAGNOSTIC. `tsc` accepts this and node runs it; we used to reject it with
   * `NT2001 return type number does not match declared string`, a mismatch that existed
   * only because we had thrown `string` away. The refusal now names the tuple instead.
   */
  test("a heterogeneous tuple return type is refused, at the tuple", () => {
    expectRejected(`
function second(t: [number, string]): string {
  return t[1];
}
console.log(typeof second);
`, "NT1037", "[number, string]");
  });

  test("a heterogeneous tuple parameter is refused", () => {
    expectRejected(`
function take(t: [string, number]): void { console.log(t[0]); }
take(["a", 1]);
`, "NT1037", "[string, number]");
  });

  test("a heterogeneous tuple variable annotation is refused", () => {
    expectRejected(`
const p: [string, number] = ["a", 1];
console.log(p[0]);
`, "NT1037", "[string, number]");
  });

  /* An `as` cast reaches the same `parseType`, and is the direction NT1036 flags as the
   * one that is not conservative: a cast INTO an erased type is a free widening. */
  test("an `as` cast to a heterogeneous tuple is refused", () => {
    expectRejected(`
const xs = ["a", "b"];
const p = xs as [string, number];
console.log(p[0]);
`, "NT1037", "[string, number]");
  });

  test("an array of heterogeneous tuples is refused", () => {
    expectRejected(`
const rows: [string, number][] = [];
console.log(rows.length);
`, "NT1037", "[string, number]");
  });

  /*
   * THE HINT, COMPILED. NT1037 tells the reader to spell the pair as a named record; that
   * advice is executed here against node rather than merely asserted, because a hint that
   * does not compile is a lie that reading cannot catch.
   */
  test("the record spelling the hint recommends compiles and matches node", async () => {
    const source = `
interface Pair { first: number; second: string; }
function make(n: number, s: string): Pair {
  return { first: n, second: s };
}
const p = make(7, "hi");
console.log(p.first);
console.log(p.second);
const { first, second } = make(1, "x");
console.log(first, second);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * HOMOGENEOUS tuples are still accepted — the erasure to `T[]` reports no wrong type
   * there. `src/checker.ts` depends on this (`as [Expr, Expr][]`, `(): [Ty, Ty]`), so a
   * refusal that over-reached to `[T, T]` would push that module further from
   * self-hosting while buying nothing.
   */
  test("a homogeneous tuple still compiles, and runs like node", async () => {
    const source = `
function firstOf(t: [string, string]): string { return t[0]; }
const pair: [string, string] = ["a", "b"];
console.log(firstOf(pair));
const rows: [number, number][] = [[1, 2], [3, 4]];
console.log(rows[1][0]);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * The refusal keys on TYPE position only. Array literals and array destructuring share
   * the `[`/`,`/`]` shape in EXPRESSION position and are ordinary JavaScript — a guard
   * that leaked there would break the language.
   */
  test("the refusal does not leak into expression position", async () => {
    const source = `
const xs = [1, 2, 3];
const [a, b] = xs;
console.log(a + b);
const nested = [[1, 2], [3, 4]];
console.log(nested[0][1]);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
