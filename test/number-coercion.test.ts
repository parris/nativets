/*
 * `+x` / `Number(x)` where `x` is NOT already a number — the numeric sibling of
 * test/string-coercion.test.ts, and the same defect shape one layer along.
 *
 * On main `coerceToNumber` (src/codegen.ts) handled `number`, `string`, `boolean` and the
 * `null` LITERAL, and then fell through to a constant `NaN` for everything else. The
 * checker let every type through (`if (e.op === "+") return "number"`), so the fall-through
 * was reached by ordinary code and answered a number node does not print, at exit 0:
 *
 *     console.log(+new Date(1000));   // node 1000,  main NaN
 *     console.log(+[]);               // node 0,     main NaN
 *     console.log(+[1]);              // node 1,     main NaN
 *
 * `+new Date()` is the everyday "now, as a number" idiom, so this was not an exotic corner.
 * The asymmetry that hid it: unary `-` on a Date is REFUSED (NT2001 "Unary '-' needs
 * number, got Date") while its sibling `+` silently answered NaN — one door guarded, the
 * other open. `d.valueOf()` and `d.getTime()` spelled out were both already correct, which
 * is what pins it on the coercion rather than on Date.
 *
 * THE RULE, and why the allow-list is the one it is. ToNumber of a non-primitive is
 * `ToPrimitive(x, number)`, which for an ordinary object is `valueOf` (returns the object,
 * not a primitive) then `toString` — i.e. ToNumber of an object IS StringToNumber of its
 * STRING form. So a value coerces to a number exactly when it coerces to a string, and the
 * allow-list here is `checkStringCoercion`'s, unchanged:
 *
 *   | expression        | node    | here                                                |
 *   |-------------------|---------|-----------------------------------------------------|
 *   | `+[]`             | `0`     | IMPLEMENTED — Array#toString is join(","), `""` → 0 |
 *   | `+[1]`            | `1`     | IMPLEMENTED                                         |
 *   | `+["  12  "]`     | `12`    | IMPLEMENTED                                         |
 *   | `+[1, 2]`         | `NaN`   | IMPLEMENTED — `"1,2"` really is NaN                 |
 *   | `+(null as …)`    | `0`     | IMPLEMENTED — the nullable BOX, not just the literal|
 *   | `+new Date(1000)` | `1000`  | IMPLEMENTED — see below                             |
 *   | `+{ a: 1 }`       | `NaN`   | REFUSED (NT1039)                                    |
 *   | `+new Map()`      | `NaN`   | REFUSED (NT1039)                                    |
 *   | `+new Uint8Array` | joins   | REFUSED (NT1039)                                    |
 *
 * Date is the ONE type where the number hint diverges from the string hint, and that is
 * exactly why it is a specific rule rather than a general one: `ToPrimitive(d, number)`
 * runs `valueOf` FIRST and gets the time value, where `ToPrimitive(d, string)` runs
 * `toString` and gets `"Thu Jan 01 1970 …"`. nativets represents a Date AS its time value
 * (a `double`), so the numeric coercion is the identity — and `%d` in `console.log`
 * ALREADY had that rule (`genFormatNumber`, src/codegen.ts), which is the strongest
 * evidence that the missing one was an oversight and not a decision.
 *
 * WHY the object rows are refused even though node's answer is a constant `NaN`: the same
 * reason NT1032 refuses `"" + {a:1}` even though node's answer is a constant
 * `[object Object]`. The constant is only node-exact for a value with no own
 * `valueOf`/`toString`; node CALLS the method when a class defines one, so answering NaN
 * unconditionally would turn a loud build error into a silent wrong answer for exactly the
 * programs that bothered to define it. This compiler has no prototype chain to consult, so
 * it cannot tell the two apart at the coercion site.
 *
 * Every expected value below was measured against node v24 first, never assumed.
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

describe("IMPLEMENTED: a Date coerces to its time value, both spellings", () => {
  // node: `0`, `1000`, `-1000` — the pinned case from test/fuzz2-diff.test.ts.
  test("`+` on a temporary Date", async () => {
    await same(
      "console.log(+new Date(0));\nconsole.log(+new Date(1000));\nconsole.log(+new Date(-1000));\n",
    );
  });

  // node: `1000`, `1001`, `1000`, `1000`, `1000` — the spelled-out forms already agreed,
  // so this asserts the coercion joins them rather than replacing them.
  test("a NAMED Date, in arithmetic, and against .valueOf()/.getTime()", async () => {
    await same(
      "const d = new Date(1000);\nconsole.log(+d);\nconsole.log(+d + 1);\n" +
      "console.log(d.valueOf());\nconsole.log(d.getTime());\n",
    );
  });

  // node: `1000`. `Number()` shared the fault, so it has to share the fix.
  test("`Number(d)` is the same coercion", async () => {
    await same("const d = new Date(1000);\nconsole.log(Number(d));\n");
  });

  // node: `NaN` — an Invalid Date's time value IS NaN, so this row was accidentally
  // right on main and must stay right now that the path is real.
  test("an Invalid Date is NaN", async () => {
    await same("console.log(+new Date(NaN));\nconsole.log(Number(new Date(NaN)));\n");
  });

  // node: `Infinity`. `new Date(-0)` clips to POSITIVE zero (ToIntegerOrInfinity), so
  // the coerced value must not carry a sign either — `console.log` alone would hide it.
  test("`+new Date(-0)` is +0, probed with 1/x", async () => {
    await same("console.log(1 / +new Date(-0));\n");
  });

  // node: `true` — `+new Date()` is the everyday "now as a number" idiom, and a clock
  // read can only be tested behaviourally.
  test("`+new Date()` agrees with the clock", async () => {
    const ours = await compileAndRun(
      "const d = new Date();\nconsole.log(+d === d.getTime());\nconsole.log(+d > 1735689600000);\n",
    );
    expect(ours.stdout).toBe("true\ntrue\n");
    expect(ours.exitCode).toBe(0);
  });
});

describe("IMPLEMENTED: an array coerces through its string form, exactly as node does", () => {
  // node: `0 0` — ToString([]) is "", and StringToNumber("") is 0, not NaN.
  test("an EMPTY array is 0, both spellings", async () => {
    await same("const e: number[] = [];\nconsole.log(+e);\nconsole.log(Number(e));\n");
  });

  // node: `1 1` — a one-element array joins to "1" with no separator.
  test("a ONE-element array is that element", async () => {
    await same("const one = [1];\nconsole.log(+one);\nconsole.log(Number(one));\n");
  });

  // node: `NaN` — "1,2" is not a numeric string. This row already agreed on main, by
  // accident; it is here so the fix cannot pass by making everything a join.
  test("a MULTI-element array is NaN", async () => {
    await same("const two = [1, 2];\nconsole.log(+two);\n");
  });

  // node: `1`, `NaN`, `0` — the string and boolean element types go through the same
  // join, and their answers are their STRING forms', not their elements'.
  test("a string array and a boolean array", async () => {
    await same(
      'const s = ["1"];\nconsole.log(+s);\n' +
      'const a = ["a"];\nconsole.log(+a);\n' +
      "const b = [true];\nconsole.log(+b);\n" +
      "const es: string[] = [];\nconsole.log(+es);\n",
    );
  });

  // node: `1.5`, `1e+21`, `NaN`, `12` — the join uses node's number formatting and the
  // parse accepts surrounding whitespace, so both halves have to be node's.
  test("node's number formatting and whitespace rules survive the round trip", async () => {
    await same(
      "const f = [1.5];\nconsole.log(+f);\n" +
      "const big = [1e21];\nconsole.log(+big);\n" +
      "const nan = [NaN];\nconsole.log(+nan);\n" +
      'const w = ["  12  "];\nconsole.log(+w);\n',
    );
  });

  // node: `0 Infinity` — String([-0]) is "0" (util.inspect's `-0` is not ToString), so
  // the coerced value is POSITIVE zero. Only the division sees the difference.
  test("`+[-0]` is +0, not -0", async () => {
    await same("const z = [-0];\nconsole.log(+z);\nconsole.log(1 / +z);\n");
  });
});

describe("IMPLEMENTED: a nullable box coerces by its TAG, not to a blanket NaN", () => {
  // node: `0 0` — `null` is 0. The `null` LITERAL was already 0 on main; a `number | null`
  // binding holding it is a tagged box, and the box fell through to NaN.
  test("a `number | null` holding null is 0", async () => {
    await same("const n: number | null = null;\nconsole.log(+n);\nconsole.log(Number(n));\n");
  });

  // node: `NaN NaN` — `undefined` is NaN, which is a DIFFERENT answer from null's, so
  // the tag really has to be read.
  test("a `number | undefined` holding undefined is NaN", async () => {
    await same("const u: number | undefined = undefined;\nconsole.log(+u);\nconsole.log(Number(u));\n");
  });

  // node: `5 5`, `7` — a PRESENT box coerces to what it carries, through the base type's
  // own rule (so the string arm parses).
  test("a present box coerces to the value it carries", async () => {
    await same(
      "const p: number | null = 5;\nconsole.log(+p);\nconsole.log(Number(p));\n" +
      'const s: string | null = "7";\nconsole.log(+s);\n',
    );
  });
});

describe("the primitive rows that already agreed still agree", () => {
  // node: `12 0 16 1000 Infinity` and `1 0 0 NaN`.
  test("strings, booleans and the nullish literals", async () => {
    await same(
      'console.log(+"  12  ");\nconsole.log(+"");\nconsole.log(+"0x10");\n' +
      'console.log(+"1e3");\nconsole.log(+"Infinity");\n' +
      "console.log(+true);\nconsole.log(+false);\nconsole.log(+null);\nconsole.log(+undefined);\n",
    );
  });
});

describe("REFUSED: a value with no node-exact numeric form gets NT1039, never a NaN", () => {
  test("an object literal — node says NaN, via `[object Object]`", () => {
    const r = rejectionOf("const o = { a: 1 };\nconsole.log(+o);\n");
    expect(r?.code).toBe("NT1039");
    expect(r?.message).not.toContain("clang");
  });

  test("`Number(o)` is refused by the same rule", () => {
    const r = rejectionOf("const o = { a: 1 };\nconsole.log(Number(o));\n");
    expect(r?.code).toBe("NT1039");
  });

  test("a Map and a Set", () => {
    expect(rejectionOf('const m = new Map<string, number>().set("a", 1);\nconsole.log(+m);\n')?.code).toBe("NT1039");
    expect(rejectionOf("const s = new Set<number>().add(1);\nconsole.log(+s);\n")?.code).toBe("NT1039");
  });

  test("a class instance — the case a `valueOf` would change the answer for", () => {
    const r = rejectionOf(
      "class C { x: number; constructor(x: number) { this.x = x; } }\nconsole.log(+new C(1));\n",
    );
    expect(r?.code).toBe("NT1039");
  });

  // node joins a Uint8Array like an array (`+new Uint8Array([5])` is 5), which is the
  // opposite of the NaN main answered — refused for the same reason NT1032 refuses it.
  test("a Uint8Array", () => {
    const r = rejectionOf("const u = new Uint8Array(2);\nconsole.log(+u);\n");
    expect(r?.code).toBe("NT1039");
  });

  // An element type whose `join` is not node-exact here is refused for `+` exactly as it
  // is for `${…}` — the numeric path must not become a back door into a wrong join.
  test("a nested array, whose join is already refused for strings", () => {
    const r = rejectionOf("const n = [[1, 2], [3]];\nconsole.log(+n);\n");
    expect(r?.code).toBe("NT1039");
  });

  // A `JSON.parse` result carries its type at RUNTIME, so it has no static numeric form
  // — the hint names the narrowing rather than repeating the catalog's object advice.
  test("a `Dyn` is refused with the narrowing spelling", () => {
    const r = rejectionOf('const d = JSON.parse(`{"a": 1}`);\nconsole.log(+d.a);\n');
    expect(r?.code).toBe("NT1039");
    expect(r?.hint).toContain("as number");
  });

  test("narrowing the parse result makes it ordinary", async () => {
    await same('const d = JSON.parse(`{"a": "12"}`);\nconst s = d.a as string;\nconsole.log(+s);\n');
  });

  test("the refusal names the OPERATOR and the type", () => {
    const r = rejectionOf("const o = { a: 1 };\nconsole.log(+o);\n");
    expect(r?.message).toContain("+");
    expect(r?.message).toContain("{a:number}");
  });

  // The location has to be the offending operand, exactly as NT1032's is.
  test("the refusal locates the operand", () => {
    const r = rejectionOf("const x = 1;\nconst y = 2;\nconst o = { a: 1 };\nconsole.log(+o);\n");
    expect(r?.message).toContain("4:");
  });
});
