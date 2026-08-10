/*
 * `"a=" + x` / `${x}` / `String(x)` where `x` is NOT a primitive.
 *
 * On main every one of these escaped as a CLANG error:
 *
 *     console.log("a=" + [1, 2, 3]);
 *     build error: clang failed (1): … error: '%t4' defined with type 'ptr' but expected 'i1'
 *
 * `coerceToString` (src/codegen.ts) handles `string`, `number`, `undefined`, `null` and a
 * nullable box, and then FALLS THROUGH to the boolean path — `zext i1 <ptr>` — for
 * everything else. The checker let those types through, so an internal representation
 * mismatch became the user's error message. CLAUDE.md's promise is an `NT****` code with
 * a hint; a clang diagnostic naming an SSA register is the opposite of that.
 *
 * DECIDED PER TYPE, each measured against node first (node v24) rather than assumed:
 *
 *   | expression                | node          | here                                  |
 *   |---------------------------|---------------|---------------------------------------|
 *   | `"" + [1, 2, 3]`          | `1,2,3`       | IMPLEMENTED — node's Array#toString IS |
 *   | `"" + ["a", "b"]`         | `a,b`         |   join(","), and `nt_arr_join_num` /   |
 *   | `"" + ([] as number[])`   | `` (empty)    |   `nt_arr_join_str` already exist      |
 *   | `"" + { a: 1 }`           | `[object Object]` | REFUSED (NT1032)                  |
 *   | `"" + new Map()`          | `[object Map]`    | REFUSED (NT1032)                  |
 *   | `"" + new Set()`          | `[object Set]`    | REFUSED (NT1032)                  |
 *   | `"" + [true, false]`      | `true,false`  | IMPLEMENTED — see below                |
 *   | `"" + [[1, 2], [3]]`      | `1,2,3`       | REFUSED (NT1032)                       |
 *   | `"" + new Uint8Array(…)`  | `1,2`         | REFUSED (NT1032)                       |
 *
 * WHY the `[object …]` forms are refused rather than implemented, even though they are
 * one interned constant away: the constant is only node-exact for a value with no own
 * `toString`. node calls `toString()` when the class defines one (`class C { toString() {
 * return "hi"; } }; "" + new C()` is `hi`, measured), so emitting the constant
 * unconditionally would turn a loud build error into a SILENT wrong answer for exactly
 * the programs that bothered to define the method — trading the worst outcome available
 * for the second-worst. And `[object Object]` carries no information the user wanted:
 * the hint points at `JSON.stringify`, which is what the program meant.
 *
 * WHY `boolean[]` WAS refused, and no longer is: `nt_arr_join_str` read each slot as a
 * `ptr`, so `[true, false].join(",")` printed EMPTY where node prints `true,false` — a
 * pre-existing defect in `.join` ITSELF, and routing `+` into a join that is already
 * wrong would have laundered it into a second construct. The refusal was therefore
 * about the join, not about the coercion. `nt_arr_join_bool` closed the join
 * (test/boolean-array-join.test.ts, which also owns the `+`/`${…}`/`String(…)` cases
 * against node), so the reason expired and the row above moved. The other rows did not:
 * each of those is refused for its OWN reason, stated below, and none of them is
 * "a runtime function is missing".
 *
 * Cases are DERIVED from node's observed output on each probe above (quoted per test),
 * cross-checked against test262's `built-ins/Array/prototype/toString` and
 * `join/` (empty array → empty string; a one-element array → no separator).
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** node is the oracle: same stdout, same exit code. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("IMPLEMENTED: an array coerces to node's `Array#toString` (join with `,`)", () => {
  // node: `a=1,2,3`
  test("`+` with a number array", async () => {
    await same('const a = [1, 2, 3];\nconsole.log("a=" + a);\n');
  });

  // node: `t=1,2,3`
  test("template interpolation of a number array", async () => {
    await same('const a = [1, 2, 3];\nconsole.log(`t=${a}`);\n');
  });

  // node: `1,2,3`
  test("`String(a)`", async () => {
    await same('const a = [1, 2, 3];\nconsole.log(String(a));\n');
  });

  // node: `s=a,b`
  test("a string array", async () => {
    await same('const a = ["a", "b"];\nconsole.log("s=" + a);\n');
  });

  // node: `e=` — an empty array is the EMPTY string, not `[]`.
  // test262 `built-ins/Array/prototype/join/S15.4.4.5_A1.1_T1`.
  test("an empty array is the empty string", async () => {
    await same('const e: number[] = [];\nconsole.log("e=" + e);\n');
  });

  // node: `1` — a one-element array has no separator in it.
  test("a one-element array carries no separator", async () => {
    await same('const a = [1];\nconsole.log("" + a);\n');
  });

  // node: `x=1,2,3=y` — the array's string is spliced in like any other operand.
  test("the array on the LEFT of the `+`, and both sides", async () => {
    await same('const a = [1, 2, 3];\nconsole.log("x=" + a + "=y");\n');
  });

  // node: `1.5,0,1e+21,NaN` — the numeric formatting is node's, not printf's.
  test("node's number formatting inside the join", async () => {
    await same('const a = [1.5, -0, 1e21, NaN];\nconsole.log("" + a);\n');
  });
});

describe("REFUSED: a value with no node-exact string form gets NT1032, never clang", () => {
  /*
   * The bug as reported. What matters is not only that it is refused but that the user
   * never sees `'%t4' defined with type 'ptr' but expected 'i1'`.
   */
  test("an object literal — node says `[object Object]`", () => {
    const r = rejectionOf('const o = { a: 1 };\nconsole.log("o=" + o);\n');
    expect(r?.code).toBe("NT1032");
    expect(r?.message).not.toContain("clang");
    expect(r?.hint).toContain("JSON.stringify");
  });

  // node: `m=[object Map]`
  test("a Map", () => {
    const r = rejectionOf(
      'const m = new Map<string, number>().set("a", 1);\nconsole.log("m=" + m);\n',
    );
    expect(r?.code).toBe("NT1032");
  });

  // node: `s=[object Set]`
  test("a Set, through a template literal", () => {
    const r = rejectionOf('const s = new Set<number>().add(1);\nconsole.log(`s=${s}`);\n');
    expect(r?.code).toBe("NT1032");
  });

  // node: `1,2,3` (each inner array stringifies in turn)
  test("a nested array", () => {
    const r = rejectionOf('const n = [[1, 2], [3]];\nconsole.log("n=" + n);\n');
    expect(r?.code).toBe("NT1032");
  });

  // node: `[object Object],[object Object]`
  test("an array of objects", () => {
    const r = rejectionOf('const a = [{ x: 1 }, { x: 2 }];\nconsole.log("a=" + a);\n');
    expect(r?.code).toBe("NT1032");
  });

  test("`String(o)` is refused by the same rule", () => {
    const r = rejectionOf('const o = { a: 1 };\nconsole.log(String(o));\n');
    expect(r?.code).toBe("NT1032");
  });

  test("a class instance", () => {
    const r = rejectionOf('class C { x: number; constructor(x: number) { this.x = x; } }\nconsole.log("c=" + new C(1));\n');
    expect(r?.code).toBe("NT1032");
  });

  test("the refusal names the TYPE it could not stringify", () => {
    const r = rejectionOf('const o = { a: 1 };\nconsole.log("o=" + o);\n');
    expect(r?.message).toContain("string concatenation");
  });
});

describe("the primitives that already worked still work", () => {
  test("number, boolean, string, and a nullable", async () => {
    await same(
      'const n = 1;\nconst b = true;\nconst s = "s";\nconst u: string | undefined = undefined;\n' +
      'console.log("" + n + b + s + u);\nconsole.log(`${n}${b}${s}${u}`);\n',
    );
  });

  test("an array ELEMENT, which was never the broken case", async () => {
    await same('const a = [1, 2, 3];\nconsole.log(`${a[0]}`);\n');
  });

  test("`.join` itself is untouched", async () => {
    await same('const a = [1, 2, 3];\nconsole.log(a.join("-"));\n');
  });
});

describe("a `JSON.parse` result (`Dyn`) is refused with the narrowing spelling", () => {
  /*
   * node: `v=x`. On main this was the SAME clang error, not a wrong answer — a `Dyn`'s
   * string form depends on a runtime tag, and `coerceToString` had no case for it either.
   * The fix at the source is one cast, so the hint names it rather than repeating the
   * catalog's `JSON.stringify` advice.
   */
  test("`${d.f}` on an untyped parse result", () => {
    const r = rejectionOf('const d = JSON.parse(`{"a": 1, "b": "x"}`);\nconsole.log(`v=${d.b}`);\n');
    expect(r?.code).toBe("NT1032");
    expect(r?.hint).toContain("as string");
  });

  test("narrowing the field makes it ordinary", async () => {
    await same(
      'const d = JSON.parse(`{"a": 1, "b": "x"}`);\nconst s = d.b as string;\nconsole.log(`v=${s}`);\n',
    );
  });

  test("typing the whole parse does the same", async () => {
    await same(
      'type T = { a: number; b: string };\n' +
      'const d = JSON.parse(`{"a": 1, "b": "x"}`) as T;\n' +
      'console.log(`v=${d.b}` + d.a);\n',
    );
  });
});

describe("the refusal's LOCATION is the offending expression, or absent — never wrong", () => {
  // A concatenation's operands carry file-absolute positions, so it names one.
  test("`+` names the operand's line and column", () => {
    const r = rejectionOf('const x = 1;\nconst y = 2;\nconst o = { a: 1 };\nconsole.log("v=" + o);\n');
    expect(r?.message).toContain("4:");
  });

  /*
   * A template SUBSTITUTION used to be re-lexed from its own source fragment
   * (`parseExpressionFrom`, src/parser.ts), so every node inside it carried a
   * fragment-relative `loc` — this one was reported at `1:1`, three lines off. The
   * workaround was to pass NO position, on the grounds that a wrong line is worse than a
   * missing one, and to note that the real fix was to thread the fragment offset.
   *
   * THREADED. `parseExpressionFrom` now takes the origin of the fragment and rebases its
   * token stream onto it, so a substitution's nodes carry file-absolute positions like any
   * others and the checker passes `exprLoc` here as every other caller does. `o` really is
   * at line 4, column 18 — `console.log(` is 12 characters, then `` ` ``, `v`, `=`, `$`,
   * `{`. The exact column is asserted rather than just the line: an off-by-one in the
   * rebase (the fragment starts one past the backtick, and only its FIRST line takes the
   * column shift) is precisely the kind of error a line-only check would wave through.
   */
  test("a template substitution reports the substitution's own line and column", () => {
    const r = rejectionOf('const x = 1;\nconst y = 2;\nconst o = { a: 1 };\nconsole.log(`v=${o}`);\n');
    expect(r?.code).toBe("NT1032");
    expect(r?.message).toContain("4:18");
  });

  /*
   * The MULTI-LINE case, which is the half the single-line test cannot see: only relative
   * line 1 of a fragment takes the column shift, because every later line starts at
   * column 1 in the fragment and in the file alike. Getting that wrong shows up only when
   * a substitution spans lines — as they do throughout `src/`, which is full of multi-line
   * template diagnostics.
   */
  test("a substitution spanning lines locates on its OWN line, not the template's", () => {
    const r = rejectionOf('const o = { a: 1 };\nconst s = `head ${\n  o\n} tail`;\nconsole.log(s);\n');
    expect(r?.code).toBe("NT1032");
    // `o` is on line 3, indented two spaces — so column 3, NOT a column measured from the
    // `${` back on line 2.
    expect(r?.message).toContain("3:3");
  });
});
