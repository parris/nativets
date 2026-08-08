/*
 * `as const` — the CONST ASSERTION.
 *
 * It is not a type assertion and `const` is not a type, but the parser treated it as
 * one: `expr as const` became an `AsExpr` retyped to the named type `const`, which —
 * like every unknown named type — erases to `number`. So `{ a: 1 } as const` had the
 * static type `number`, and the very next `o.a` was rejected with a diagnostic that
 * named neither the construct nor the cause:
 *
 *     const o = { a: 1 } as const;
 *     console.log(o.a);          // error[NT2001]: Property 'a' does not exist on number
 *
 * Only a NUMBER operand survived, and only by accident — its erasure and its real type
 * happened to coincide. Found while measuring the SH6 blocker chain for
 * src/diagnostics.ts, whose `export const NYI = { ... } as const` catalog is exactly
 * this shape and is blocker 2 of 6 for that module (docs/self-hosting.md).
 *
 * WHAT IT MEANS HERE. In TypeScript `as const` does two things: it keeps literal types
 * unwidened, and it makes the value deeply `readonly`. nativets already has both
 * unconditionally — values are immutable unless tagged `@@mutable`, and a string-literal
 * type is widened back to `string` for every type that is not a union tag (see
 * `parseType`, docs/self-hosting.md SH2). So the assertion has nothing left to change:
 * it is the IDENTITY, and the operand keeps its own inferred type. That is what these
 * tests pin, node being the oracle throughout — node erases the annotation, so every
 * case below runs under node unchanged.
 *
 * Cases follow `microsoft/TypeScript` tests/cases/conformance/expressions/typeAssertions/
 * constAssertions.ts, restricted to the operand forms nativets has values for.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("`as const` is the identity — the operand keeps its own type", () => {
  test("an OBJECT literal keeps its fields (the src/diagnostics.ts blocker)", async () => {
    await expectNode(`
const o = { a: 1, b: "x" } as const;
console.log(o.a, o.b);
`);
  });

  test("a NESTED object literal keeps its fields", async () => {
    await expectNode(`
const o = { p: { q: 2, r: "s" } } as const;
console.log(o.p.q, o.p.r);
`);
  });

  test("the shape src/diagnostics.ts actually uses: a catalog of records", async () => {
    await expectNode(`
const NYI = {
  ARRAY: { code: "NT1001", hint: "arrays need the heap value model" },
  CLOSURE: { code: "NT1003", hint: "closures need captured environments" },
} as const;
console.log(NYI.CLOSURE.code);
console.log(NYI.ARRAY.hint);
`);
  });

  test("a STRING literal keeps string, not number", async () => {
    await expectNode(`
const s = "hi" as const;
console.log(s.length, s.toUpperCase());
`);
  });

  test("an ARRAY literal keeps its element type and length", async () => {
    await expectNode(`
const xs = [1, 2, 3] as const;
console.log(xs.length, xs[0] + xs[2]);
`);
  });

  test("a NUMBER literal still works (the one case that accidentally did)", async () => {
    await expectNode(`
const n = 3 as const;
console.log(n + 1);
`);
  });

  test("a BOOLEAN literal keeps boolean", async () => {
    await expectNode(`
const b = true as const;
console.log(b ? "yes" : "no");
`);
  });

  test("it composes with a normal `as` on the same expression", async () => {
    await expectNode(`
const o = { a: 1 } as const as { a: number };
console.log(o.a);
`);
  });

  test("an `as const` value passes to a function expecting the widened type", async () => {
    await expectNode(`
type Spec = { code: string; hint: string };
function describeIt(s: Spec): string { return s.code + ": " + s.hint; }
const spec = { code: "NT1003", hint: "closures" } as const;
console.log(describeIt(spec));
`);
  });
});

describe("`as const` does not swallow a real type assertion", () => {
  test("`as` with an ordinary named type still retypes", async () => {
    await expectNode(`
type Ty = string;
const s = "abc" as Ty;
console.log(s.length);
`);
  });

  test("a binding actually NAMED const-ish is unaffected", async () => {
    await expectNode(`
const constant = { a: 1 };
console.log(constant.a);
`);
  });
});
