/*
 * TYPE QUERIES — `typeof x` and `keyof T` in TYPE position (`NT1033`).
 *
 * Both are REFUSED, and the argument is that neither can be answered where annotations
 * are resolved. `Ty` (src/ast.ts) is produced by the PARSER, before any inference has
 * run, so `typeof S` has no value environment to ask for S's type; and `keyof T` has no
 * `Ty` inhabitant at all — "one of these keys" is the same unrepresentable thing
 * `NT1029` refuses for `T[keyof T]`.
 *
 * The refusal has to live in the parser for the reason NT2003's comment gives: the
 * erasure is DESTRUCTIVE. Once `resolveNamed` answers `number` the spelling is gone from
 * the program and no later pass can tell it from a `number` the user wrote.
 *
 * WHAT IT REPLACED, and why "partly implemented" was rejected. `typeof` and `keyof` both
 * sat in the parser's `AMBIENT_TYPES` escape, which resolves a bare NAME. So the KEYWORD
 * was resolved as if it were the type — erasing to `number` — and the OPERAND was left in
 * the token stream, where it re-parsed as a stray expression statement. Two different
 * failures came out of that one bug:
 *
 *   - `type X = typeof S` where `S` is a value: the stray `S;` is a legal statement, so
 *     the program compiled and `X` silently meant `number`. Exit 0, wrong type.
 *   - `type K = keyof T`: the stray `T;` is not, so the program was rejected with
 *     `'T' is not defined` — a diagnostic naming a line the user did not write.
 *
 * Resolving `typeof S` only for a `const` with a literal initializer was considered and
 * rejected: it would put the accept/reject boundary on the SYNTAX of the initializer
 * (`const S = "a"` compiles, `const S = f()` silently erases), which is the same trade
 * docs/self-hosting.md rejected for a `new Map`-position-only entries form. A partial
 * answer that keeps the silent case is worse than no answer.
 *
 * The TypeScript conformance suite (`tests/cases/conformance/types/query/`) is NOT
 * vendored into this repo and no network was available, so these cases are DERIVED from
 * the construct's specification. They model the shapes that suite is known to cover: a
 * query over a `const`, over a function, in a parameter annotation, and `keyof` over a
 * record type.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/**
 * Assert the source is REFUSED with the given code, and that the message mentions
 * `needle` — so a case meant to prove "this type query cannot be resolved" cannot pass
 * by being rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("type queries (`typeof` / `keyof` in type position)", () => {
  /*
   * THE SILENT ONE. node runs this and prints 5; before NT1033 nativets compiled it too,
   * with `X` meaning `number` — so the program was rejected downstream with
   * `'f' arg 0 expects number, got string`, blaming the CALL for a type nobody wrote.
   * The refusal names `typeof S` instead.
   */
  test("`typeof` over a const is refused, at the query", () => {
    expectRejected(`
const S = "a";
type X = typeof S;
function f(v: X): number { return v.length; }
console.log(f("hello"));
`, "NT1033", "typeof S");
  });

  test("`typeof` over a function is refused", () => {
    expectRejected(`
function g(n: number): number { return n + 1; }
type F = typeof g;
const h: F = g;
console.log(h(1));
`, "NT1033", "typeof g");
  });

  test("`typeof` directly in a parameter annotation is refused", () => {
    expectRejected(`
const S = "a";
function f(v: typeof S): number { return v.length; }
console.log(f("hello"));
`, "NT1033", "typeof S");
  });

  /* The stray-statement half: this used to fail as `'T' is not defined`. */
  test("`keyof` is refused, and no longer blames a phantom statement", () => {
    expectRejected(`
type T = { a: number, b: number };
type K = keyof T;
function f(k: K): string { return k; }
console.log(f("a"));
`, "NT1033", "keyof T");
  });

  /*
   * `typeof` as an EXPRESSION is untouched — a different parse path entirely
   * (`parseUnary`). Guarded here because the refusal keys on the same keyword, and a
   * guard that leaked into expression position would break ordinary JavaScript.
   */
  test("`typeof` as an expression still works", async () => {
    const source = `
const s = "a";
const n = 1;
console.log(typeof s, typeof n, typeof true);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * `n < m` is not a type-argument list, but `tryCallTypeArgs` has to SPECULATE that it
   * might be, and it backtracks on any throw. A comparison against a name the refusal
   * would fire on must therefore still compile — the throw is what tells the speculation
   * this was not a type (src/parser.ts, `refuseUnknownName`).
   */
  test("the refusal does not leak into a speculative type-argument parse", async () => {
    const source = `
function cmp(a: number, b: number): boolean { return a < b; }
console.log(cmp(1, 2), cmp(2, 1));
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
