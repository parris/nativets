/*
 * `[true, false].join(",")` — node prints `true,false`; we printed NOTHING.
 *
 * `genArrayMethod` (src/codegen.ts) splits array methods on ONE bit:
 *
 *     const numeric = el === "number";
 *
 * — number on one side, "everything else" on the other, and "everything else" means
 * the STRING runtime. `boolean` is not a string, so `.join` reached `nt_arr_join_str`,
 * which does
 *
 *     const char *s = (const char *)(intptr_t) arr_at(a, i);  strlen(s);
 *
 * on a slot holding `zext i1` — the integers 0 and 1. `strlen((char *)1)` reads from
 * address 1. Same class of defect as the arrow bug in the commit before this one, from
 * the opposite direction: there a function was mistaken for an array, here a boolean
 * element is mistaken for a pointer. Both are a slot reinterpreted as the wrong thing,
 * and both kill the process with no diagnostic.
 *
 * The fix is a third join, `nt_arr_join_bool`, because there is nothing to reuse: node
 * spells these `true`/`false`, `nt_arr_join_num` would print `1`/`0`, and the boolean
 * slot is not a pointer. That also RETIRES the reason `"" + [true, false]` was refused
 * (NT1032) — test/string-coercion.test.ts documented that refusal as "routing `+` into
 * a join that is already wrong would launder that bug into a second construct". The
 * join is no longer wrong, so the launder-risk is gone and the coercion is implemented
 * here, with node as the oracle on every case rather than by analogy to `number[]`.
 *
 * Cases are DERIVED from test262's `built-ins/Array/prototype/join/` (empty array →
 * empty string; single element → no separator; a custom separator; `undefined`
 * separator → `,`) with `boolean` elements substituted, each re-measured against node.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

/** node is the oracle: same stdout AND same exit code. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("`.join` on a boolean array", () => {
  // node: `true,false`
  test("the reported case", async () => {
    await same('console.log([true, false].join(","));\n');
  });

  // node: `true-false` — the separator is the argument, not a hard-coded `,`.
  test("a custom separator", async () => {
    await same('console.log([true, false].join("-"));\n');
  });

  // node: `true,false`. test262 `join/S15.4.4.5_A1_T1`: an OMITTED separator is `,`.
  test("no separator argument", async () => {
    await same('console.log([true, false].join());\n');
  });

  // node: `` (empty). test262 `join/S15.4.4.5_A1.1_T1`.
  test("an empty boolean array is the empty string", async () => {
    await same('const b: boolean[] = [];\nconsole.log("[" + b.join(",") + "]");\n');
  });

  // node: `true` — one element carries no separator.
  test("a one-element array carries no separator", async () => {
    await same('console.log([true].join(","));\n');
  });

  // node: `truefalse` — an empty separator concatenates.
  test("an empty separator", async () => {
    await same('console.log([true, false].join(""));\n');
  });

  // node: `false,false,true` — the values are read per slot, not assumed.
  test("the values come from the slots, in order", async () => {
    await same(`const b = [false, false, true];
console.log(b.join(","));
`);
  });

  // node: `true,false,true` — a COMPUTED element joins like a literal one. (`.push`
  // is NT1606 here; the accumulating spelling is the one the diagnostic points at.)
  test("computed elements, accumulated", async () => {
    await same(`let b: boolean[] = [];
b = [...b, 1 < 2];
b = [...b, 1 > 2];
b = [...b, true];
console.log(b.join(","));
`);
  });

  // The neighbours must not have moved: `number[]`/`string[]` still take their own join.
  test("number and string arrays are untouched", async () => {
    await same('console.log([1, 2].join(","), ["a", "b"].join(","));\n');
  });
});

/*
 * With the join correct, `"" + [true, false]` is node-exact, and the reason
 * test/string-coercion.test.ts gave for refusing it ("routing `+` into a join that is
 * already wrong would launder that bug into a second construct") no longer holds. The
 * refusal is narrowed here — and only here, and only for `boolean[]`. Every other
 * NT1032 case stays refused; that file still owns those, and this is measured against
 * node rather than reasoned by analogy with `number[]`.
 */
describe("`\"\" + boolean[]` — the NT1032 refusal this retires", () => {
  // node: `b=true,false`
  test("`+` with a boolean array", async () => {
    await same('const b = [true, false];\nconsole.log("b=" + b);\n');
  });

  // node: `t=true,false`
  test("template interpolation", async () => {
    await same('const b = [true, false];\nconsole.log(`t=${b}`);\n');
  });

  // node: `true,false`
  test("`String(b)`", async () => {
    await same('const b = [true, false];\nconsole.log(String(b));\n');
  });

  // node: `e=` — the empty case, through the coercion rather than through `.join`.
  test("an empty boolean array coerces to the empty string", async () => {
    await same('const e: boolean[] = [];\nconsole.log("e=" + e);\n');
  });
});
