/*
 * ARRAY OF NULLABLE ELEMENTS — `(string | null)[]`, `(number | undefined)[]`.
 *
 * The blocker was NOT the array element-type rule. It was an AMBIGUITY in the `Ty`
 * encoding: the nullable encoding is a PREFIX (`?N`/`?U`) and the array encoding is a
 * SUFFIX (`[]`), so the two compose to the same flat string —
 *
 *     makeNullable("null", "string")  + "[]"  === "?Nstring[]"    // (string | null)[]
 *     makeNullable("null", "string[]")        === "?Nstring[]"    // string[] | null
 *
 * — and `isNullableTy` anchors at the front, so the concatenation always READ as the
 * second. `(string|null)[]` was therefore typed `string[] | null`, which surfaced as
 * `NT2001 array elements must share a type (got string, null)` on the literal and, more
 * tellingly, as `'a' is possibly null` on `const a: (string|null)[] = ["x","y"]` — a
 * nullability diagnostic about a program containing no `null` at all.
 *
 * This is the identical collision `parseTypeAtom` (src/parser.ts) already refuses for an
 * array-of-functions vs a function-returning-an-array, and the fix is the one that
 * refusal's own comment prescribes: PARENTHESIZE the element (`(?Nstring)[]`, built by
 * `makeArrayTy` in src/ast.ts). `T[] | null` keeps its spelling byte for byte, so no
 * existing `Ty` string in the tree moves.
 *
 * node is the oracle for stdout AND exit code on every runtime case. Exit code is
 * asserted separately and deliberately: a double free here presents as a NONZERO exit
 * with CORRECT stdout, and this project has shipped exactly that.
 *
 * TypeScript conformance cases mapped from `microsoft/TypeScript`
 * `tests/cases/conformance/types/union/` (`unionTypeArrayPropertyAccess`,
 * `arrayLiteralsWithRecursiveGenerics`) and the `strictNullChecks` array fixtures; the
 * `null`-only-literal boundary is TypeScript's `null[]`, which we keep refusing.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/**
 * Assert the source is REFUSED with the given code, and that the message mentions
 * `needle` — so a case meant to pin one boundary cannot pass by being rejected for some
 * unrelated reason. Same helper shape as test/narrowing.test.ts, `.diag` and all.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic((err as NTError).diag);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

/** stdout AND exit code, both against node. */
async function sameAsNode(src: string) {
  const { ours, oracle } = await expectMatchesNode(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours;
}

describe("array of nullable elements", () => {
  test("a string|null array is built, read and printed like node", async () => {
    await sameAsNode(`
const a: (string | null)[] = ["x", null, "z"];
console.log(a.length);
console.log(a[0]);
console.log(a[1]);
console.log(a);`);
  });

  test("undefined behaves exactly as null does (?U vs ?N)", async () => {
    await sameAsNode(`
const b: (number | undefined)[] = [1, undefined, 3];
console.log(b[1]);
console.log(b);
let sum = 0;
for (const v of b) { if (v !== undefined) { sum = sum + v; } }
console.log(sum);`);
  });

  test("iterated, narrowed per element, and JSON-stringified", async () => {
    await sameAsNode(`
const a: (string | null)[] = ["x", null, "z"];
for (const s of a) { console.log(s === null ? "NULL" : s); }
console.log(JSON.stringify(a));`);
  });

  test("nullable elements of an OBJECT type, and nested arrays of them", async () => {
    await sameAsNode(`
const o: ({ k: number } | null)[] = [{ k: 1 }, null];
console.log(o);
const h: (number | null)[][] = [[1, null], [null]];
console.log(h);
console.log(JSON.stringify(h));`);
  });

  test("passed to a function, returned from one, and spread", async () => {
    await sameAsNode(`
function count(xs: (string | null)[]): number {
  let n = 0;
  for (const x of xs) { if (x !== null) { n = n + 1; } }
  return n;
}
function mk(): (string | null)[] { return ["a", null, "c"]; }
const m = mk();
console.log(count(m));
const g: (string | null)[] = [...m, null];
console.log(g.length, g);`);
  });

  test("an EMPTY literal takes the nullable element type from its annotation", async () => {
    await sameAsNode(`
const e: (string | null)[] = [];
console.log(e.length, e);`);
  });

  test("slice / filter / map / reverse over a nullable-element array", async () => {
    await sameAsNode(`
const a: (string | null)[] = ["b", null, "a"];
console.log(a.slice(1));
console.log(a.filter((x) => x !== null).length);
console.log(a.map((x) => (x === null ? 0 : 1)));
console.log([...a].reverse());`);
  });

  /*
   * THE ENCODING BUG ITSELF, as a program with no `null` value in it. Before the paren
   * element encoding this was `error[NT2001]: 'a' is possibly null` — the annotation had
   * been read as `string[] | null`, so the ARRAY, not an element, was the nullable thing.
   */
  test("an all-present (string|null)[] is not itself nullable", async () => {
    await sameAsNode(`
const a: (string | null)[] = ["x", "y"];
console.log(a.length);
console.log(a[0]);`);
  });

  /*
   * `T[] | null` MUST keep its old meaning — the two spellings are what the encoding was
   * conflating, so the fix is only correct if the other side still says what it said.
   */
  test("string[] | null still means a nullable ARRAY", async () => {
    await sameAsNode(`
function pick(n: number): string[] | null { if (n > 0) { return ["a", "b"]; } return null; }
const p = pick(1);
if (p !== null) { console.log(p.length, p[0]); }
const q = pick(-1);
console.log(q === null);`);
  });
});

/*
 * LEAK / DOUBLE-FREE. `__arrLive`/`__objLive` are runtime counters, so these are
 * compile-and-run only (node has no such builtins) — but the EXIT CODE is still the
 * assertion that matters most, because a double free is exit 134/139 with correct stdout.
 *
 * The recorded trap: `__arrLive` counts HEADERS and cannot see a leaked data block.
 */
describe("array-of-nullable drops", () => {
  test("the array headers are freed exactly once — no double free", async () => {
    const r = await compileAndRun(`
function f(): number {
  let t = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const a: (string | null)[] = ["x", null];
    if (a[0] !== null) { t = t + 1; }
  }
  return t;
}
console.log(f());
console.log(__arrLive());`);
    expect(r.stdout).toBe("100\n0\n");
    expect(r.exitCode).toBe(0); // a double free would be a nonzero exit with this same stdout
  });

  /*
   * The BOXES leak, and this test PINS that rather than fixing it. It is not new and it is
   * not array-specific: `isLinearTy` (src/ownership.ts) is
   * `isArrayTy || isObjectTy || isUnionTy || isTypeRefTy`, so a NULLABLE is never in any
   * drop set anywhere — 100 loose `string | null` locals in a loop already measure
   * `__objLive() === 100` with no array in sight. On top of that, `nt_arr_free` is
   * header-only, the `array/object ELEMENTS` item under **Still open** in ROADMAP Phase C.
   * A leak is the accepted class here; a double free is not.
   */
  test("the element BOXES leak — pinned, the pre-existing shallow-drop class", async () => {
    const r = await compileAndRun(`
function f(): number {
  let t = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const a: (string | null)[] = ["x", null];
    if (a[0] !== null) { t = t + 1; }
  }
  return t;
}
console.log(f());
console.log(__objLive());`);
    expect(r.stdout).toBe("100\n200\n"); // 2 boxes per iteration, none freed
    expect(r.exitCode).toBe(0);
  });

  test("BASELINE: a loose nullable leaks identically, with no array involved", async () => {
    const r = await compileAndRun(`
function mk(i: number): string | null { if (i > 50) { return "a"; } return null; }
function f(): number {
  let t = 0;
  for (let i = 0; i < 100; i = i + 1) { const x: string | null = mk(i); if (x !== null) { t = t + 1; } }
  return t;
}
console.log(f());
console.log(__objLive());`);
    expect(r.stdout).toBe("49\n100\n");
    expect(r.exitCode).toBe(0);
  });
});

/*
 * REFUSAL BOUNDARIES. Everything a nullable element newly makes reachable was swept
 * against node; nothing produced a wrong answer, and what is not node-exact is a named
 * refusal. These pin the boundary so it cannot silently become a wrong answer later.
 */
describe("nullable-element boundaries (refused, never guessed)", () => {
  /*
   * `[null]` with NO annotation stays NT1001, and that is the right answer rather than a
   * gap: its type is genuinely unknown (TypeScript infers `null[]`, which nativets has no
   * element representation for). Contextual typing from an annotation is the discriminator
   * — the very next test is the same literal, accepted.
   */
  test("`[null]` alone is still NT1001 — its type is genuinely unknown", () => {
    expectRejected(`const b = [null];\nconsole.log(b.length);`, "NT1001", "arrays of null");
  });

  test("...but WITH an annotation the same literal compiles", async () => {
    await sameAsNode(`const b: (string | null)[] = [null];\nconsole.log(b.length, b[0]);`);
  });

  /*
   * `Ty` has ONE nullish slot (`?U` or `?N`, never both), so `A | null | undefined` is
   * refused everywhere — this is that existing refusal reached through an element, not a
   * new one, and it must stay refused or the box's tag would have to mean three things.
   */
  test("a MIXED null AND undefined element stays refused (one nullish slot in Ty)", () => {
    expectRejected(`const a: (string | null | undefined)[] = ["x", null];\nconsole.log(a.length);`, "NT1009", "null");
  });

  test("a nullish literal is not assignable to the OTHER arm's element", () => {
    expectRejected(`const a: (string | null)[] = ["x", undefined];\nconsole.log(a.length);`, "NT2001", "undefined");
  });
});

/*
 * `.join()` — a PRE-EXISTING silent wrong answer, found by walking into it, fixed here.
 *
 * `joinFn` (src/codegen.ts) is a three-way dispatch (`num`/`bool`/`str`) whose DEFAULT is
 * `nt_arr_join_str`, i.e. `strlen` on the slot. `checkStringCoercion` (src/checker.ts) is
 * the allow-list that keeps `${arr}` / `String(arr)` / concatenation off that default —
 * and it is exactly the list `.join()` itself never consulted. So on `main` (942f48b),
 * with no nullable element anywhere near it:
 *
 *     [[1],[2]].join(";")       node `1;2`                  nativets `\x01;\x01`   exit 0 BOTH
 *     [{x:1},{x:2}].join(",")   node `[object Object],…`    nativets `,`           exit 0 BOTH
 *
 * Exit 0 on both sides with different stdout is the class CLAUDE.md calls the worst
 * outcome available. `.join()` now consults the same allow-list, which also covers the
 * nullable element (whose box pointer landed in the same default arm).
 */
describe(".join element allow-list", () => {
  test("number / string / boolean elements still join exactly like node", async () => {
    await sameAsNode(`
console.log([1, 2, 3].join("-"));
console.log(["a", "b"].join(""));
console.log([true, false].join(","));
console.log([1, 2].join());`);
  });

  test("an ARRAY element was `\\x01;\\x01` where node says `1;2` — now refused", () => {
    expectRejected(`const a: number[][] = [[1],[2]];\nconsole.log(a.join(";"));`, "NT1032", ".join() on number[][]");
  });

  test("an OBJECT element was `,` where node says `[object Object],…` — now refused", () => {
    expectRejected(`const a: {x:number}[] = [{x:1},{x:2}];\nconsole.log(a.join(","));`, "NT1032", ".join() on {x:number}[]");
  });

  test("a NULLABLE element lands in the same arm and is refused too", () => {
    expectRejected(`const a: (string|null)[] = ["b",null];\nconsole.log(a.join(","));`, "NT1032", ".join() on (?Nstring)[]");
  });
});
