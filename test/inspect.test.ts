/*
 * Stage 47 — `console.log` of a COMPOUND value (node's `util.inspect`).
 *
 * THE DEFECT THIS CLOSES. `console.log({ a: 1, b: "x" })` used to print a BARE
 * NEWLINE and exit 0: `emitPrint` fell through to `js_print_str` on the object's
 * heap POINTER, whose first byte is usually 0. A silent wrong answer — the same
 * class of defect as the out-of-bounds `0` fixed in Stage 41, and worse than the
 * honest refusals around it (`console.log(arr)` was `NT1001`, a `Uint8Array`
 * `NT1016`). The rule this file enforces is: **no input prints nothing.**
 *
 * WHAT IS TESTED. node is the oracle byte-for-byte. The formatting is a port of
 * node's `lib/internal/util/inspect.js` at console.log's defaults (breakLength 80,
 * compact 3, depth 2, maxArrayLength 100), split between codegen (the type-directed
 * walk that renders each entry — the `JSON.stringify` walk's shape) and
 * `runtime/runtime.c`'s `nt_insp_*` builder (the width / line-breaking decision,
 * which needs the rendered widths and so can only happen at runtime).
 *
 * The multi-line threshold is the part a naive implementation gets wrong, so the
 * boundary is pinned from both sides: node lines entries up on ONE line only while
 * `output.length + indentationLvl + braces[0].length + 10 + output.length +
 * Σ entry lengths <= 80` — which for `{ k0: 'v0', … }` breaks between SIX and SEVEN
 * entries, and for a class instance depends on the CLASS NAME (node counts it as
 * part of the opening brace). Both are asserted below at n and n+1.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile-only: the NT code a source is rejected with, or null if it compiles. */
function rejectCode(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

interface Case { name: string; code: string }

/** Every case here is DIFFERENTIAL: our stdout must equal `node <case>`'s, exactly. */
function differential(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const { ours, oracle } = await expectMatchesNode(c.code);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 1. Flat objects — the exact case that printed nothing.
 * ------------------------------------------------------------------ */

differential("flat objects", [
  { name: "the regression: { a: 1, b: 'x' }", code: `const o = { a: 1, b: "x" };\nconsole.log(o);` },
  { name: "an object literal inline", code: `console.log({ a: 1, b: "x" });` },
  { name: "single field", code: `console.log({ only: 42 });` },
  { name: "empty object", code: `console.log({});` },
  { name: "booleans / all scalar kinds", code: `console.log({ n: 1, s: "s", b: true, c: false });` },
  // node QUOTES a nested string but prints a top-level one bare — the split
  // between `genInspect` and `emitPrint`.
  { name: "nested strings are quoted, a top-level string is not", code: `console.log("plain");\nconsole.log({ s: "plain" });` },
  // Keys are bare only for node's keyStrRegExp (/^[a-zA-Z_][a-zA-Z_0-9]*$/ — `$` is NOT in it).
  { name: "a key needing quotes", code: `console.log({ "a-b": 1 });` },
  { name: "a $-prefixed key is quoted (node's keyStrRegExp excludes $)", code: `console.log({ $x: 4 });` },
  { name: "underscore and digits stay bare", code: `console.log({ _a1: 1, B2: 2 });` },
]);

/* ------------------------------------------------------------------ *
 * 2. Arrays — note the INNER spaces, and `[]` with no spaces when empty.
 * ------------------------------------------------------------------ */

differential("arrays", [
  { name: "[ 1, 2, 3 ]", code: `const a: number[] = [1, 2, 3];\nconsole.log(a);` },
  { name: "empty array is []", code: `const a: number[] = [];\nconsole.log(a);` },
  { name: "[ 'a', 'b' ]", code: `const a: string[] = ["a", "b"];\nconsole.log(a);` },
  { name: "booleans", code: `console.log([true, false, true]);` },
  // Six entries stay on one line; SEVEN trigger node's groupArrayElements column layout.
  { name: "six entries: one line", code: `console.log([1, 2, 3, 4, 5, 6]);` },
  { name: "seven entries: column-grouped", code: `console.log([1, 2, 3, 4, 5, 6, 7]);` },
  // node right-aligns (padStart) only when EVERY element is a number; strings pad left.
  { name: "numeric grouping is right-aligned", code: `let a: number[] = [];\nfor (let i = 0; i < 30; i++) a = [...a, i];\nconsole.log(a);` },
  { name: "string grouping is left-aligned", code: `let a: string[] = [];\nfor (let i = 0; i < 12; i++) a = [...a, "s" + i];\nconsole.log(a);` },
  { name: "wide numbers", code: `let a: number[] = [];\nfor (let i = 0; i < 40; i++) a = [...a, i * 7919];\nconsole.log(a);` },
]);

/* ------------------------------------------------------------------ *
 * 3. Nesting — objects of arrays, arrays of objects, and node's depth cut-off.
 * ------------------------------------------------------------------ */

differential("nesting", [
  { name: "object in object", code: `console.log({ a: { b: 1 } });` },
  { name: "array of objects", code: `console.log([{ a: 1 }, { a: 2 }]);` },
  { name: "object of arrays", code: `console.log({ xs: [1, 2, 3], ys: ["a", "b"], zs: [true] });` },
  { name: "array of arrays", code: `console.log([[1, 2], [3]]);` },
  { name: "three levels still render", code: `console.log({ a: { b: { c: 1 } } });` },
  // node's default `depth` is 2: a compound BELOW it prints as a placeholder.
  { name: "depth 3 object becomes [Object]", code: `console.log({ a: { b: { c: { d: 1 } } } });` },
  { name: "depth 3 array becomes [Array]", code: `console.log([[[[1]]]]);` },
  { name: "an EMPTY compound prints even past the depth cut", code: `const e: number[] = [];\nconsole.log({ a: { b: { c: e } } });` },
  { name: "mixed deep shape", code: `console.log({ a: [{ b: [1, 2] }] });` },
]);

/* ------------------------------------------------------------------ *
 * 4. The multi-line rule — pinned at the boundary from BOTH sides.
 * ------------------------------------------------------------------ */

differential("the multi-line threshold", [
  // 6 entries of 8 chars: 6 + 0 + 1 + 10 + 6 + 48 = 71 <= 80 -> one line.
  { name: "six 8-char entries fit on one line (71 <= 80)", code: `console.log({ k0: "v0", k1: "v1", k2: "v2", k3: "v3", k4: "v4", k5: "v5" });` },
  // 7 entries: 7 + 0 + 1 + 10 + 7 + 56 = 81 > 80 -> one entry per line, indent 2.
  { name: "seven 8-char entries wrap (81 > 80)", code: `console.log({ k0: "v0", k1: "v1", k2: "v2", k3: "v3", k4: "v4", k5: "v5", k6: "v6" });` },
  // The CLASS NAME counts: node folds it into braces[0], so a longer name wraps sooner.
  {
    name: "a long class name pushes the same fields over the edge",
    code: `class Ab { f0: string; f1: string; f2: number; f3: string;\n  constructor() { this.f0 = "xxx"; this.f1 = "hello world"; this.f2 = 42; this.f3 = "another"; } }\n` +
      `class LongerClassNameHere { f0: string; f1: string; f2: number; f3: string;\n  constructor() { this.f0 = "xxx"; this.f1 = "hello world"; this.f2 = 42; this.f3 = "another"; } }\n` +
      `console.log(new Ab());\nconsole.log(new LongerClassNameHere());`,
  },
  // Indentation counts too: the same object wraps sooner one level down.
  { name: "indentation level shifts the boundary", code: `console.log({ w: { k0: "v0", k1: "v1", k2: "v2", k3: "v3", k4: "v4", k5: "v5" } });` },
  // A nested value that itself wrapped forces the parent to wrap (the `\n` check).
  { name: "a wrapped child forces the parent to wrap", code: `console.log({ a: 1, b: { k0: "v0", k1: "v1", k2: "v2", k3: "v3", k4: "v4", k5: "v5", k6: "v6" } });` },
  { name: "arrays of objects at the boundary", code: `console.log([{ name: "aa", n: 1 }, { name: "bb", n: 2 }]);\nconsole.log([{ name: "aaaaaaa", n: 111 }, { name: "bbbbbbb", n: 222 }, { name: "ccccccc", n: 333 }]);` },
]);

/* ------------------------------------------------------------------ *
 * 5. Scalars inside a compound — including the -0 / String() split.
 * ------------------------------------------------------------------ */

differential("scalars inside compounds", [
  { name: "null / undefined / booleans / -0 / NaN / Infinity", code: `console.log({ a: null, b: undefined, c: true, d: -0, e: NaN, f: -Infinity });` },
  // util.inspect's formatNumber prints -0; String(-0) is "0". console.log uses inspect.
  { name: "top-level -0 prints as -0, not 0", code: `console.log(-0);\nconsole.log(0);\nconsole.log(\`\${-0}\`);` },
  { name: "-0 in an array", code: `console.log([-0, 0, NaN, Infinity]);` },
  { name: "nullable fields", code: `const o: { a?: number; b: string } = { a: 1, b: "x" };\nconsole.log(o);` },
  { name: "a null-valued field", code: `const n: number | null = null;\nconsole.log({ n: n });` },
  // NOTE: `1e-7` / `1e-5` / very large integers are a PRE-EXISTING `js_number_to_string`
  // divergence (`1e-07` vs node's `1e-7`, `1e-05` vs `0.00001`, exact-vs-shortest digits)
  // that has nothing to do with inspect — it is identical through `String(x)` — so it is
  // excluded here rather than pinned to the wrong answer. See docs/divergences.md.
  { name: "large / small number formats survive", code: `console.log([1.5, 0.25, 100000, 9007199254740991]);` },
]);

/* ------------------------------------------------------------------ *
 * 5b. String quoting — node picks the quote that needs the least escaping.
 * ------------------------------------------------------------------ */

differential("string quoting inside compounds", [
  { name: "an apostrophe switches to double quotes", code: `console.log({ s: "it's" });` },
  { name: "a double quote stays single-quoted", code: `console.log({ s: 'a"b' });` },
  { name: "both quotes fall back to backticks", code: "console.log({ s: `q'\\\"x` });" },
  { name: "control characters are escaped", code: `console.log({ s: "a\\nb\\tc" });` },
  { name: "a backslash is escaped", code: `console.log({ s: "a\\\\b" });` },
  { name: "a template-literal marker keeps single quotes", code: `console.log(["a\${b}"]);` },
]);

/* ------------------------------------------------------------------ *
 * 6. Class instances — node prints `ClassName { field: value }`.
 * ------------------------------------------------------------------ */

const POINT = `class Point { x: number; y: string;\n  constructor(x: number, y: string) { this.x = x; this.y = y; } }\n`;

differential("class instances", [
  { name: "Point { x: 1, y: 'z' }", code: `${POINT}console.log(new Point(1, "z"));` },
  { name: "in an array", code: `${POINT}console.log([new Point(1, "z"), new Point(2, "w")]);` },
  { name: "as a field", code: `${POINT}console.log({ p: new Point(1, "z") });` },
  { name: "an empty class prints Name {}", code: `class Empty { constructor() {} }\nconsole.log(new Empty());` },
]);

/* ------------------------------------------------------------------ *
 * 7. Map / Set — `Map(1) { 'a' => 1 }`, `Set(2) { 1, 2 }`.
 *
 * nativets Map/Set are IMMUTABLE (Stage 25), so these use the documented
 * use-the-returned-handle pattern, whose observable output matches node.
 * ------------------------------------------------------------------ */

differential("Map and Set", [
  { name: "Map(1) { 'a' => 1 }", code: `console.log(new Map<string, number>().set("a", 1));` },
  { name: "Map(0) {}", code: `console.log(new Map<string, number>());` },
  { name: "Set(2) { 1, 2 }", code: `console.log(new Set<number>().add(1).add(2));` },
  { name: "Set(0) {}", code: `console.log(new Set<number>());` },
  { name: "string set", code: `console.log(new Set<string>().add("a").add("b"));` },
  { name: "number keys", code: `console.log(new Map<number, string>().set(1, "one").set(2, "two"));` },
  { name: "insertion order is node's", code: `console.log(new Map<string, number>().set("z", 1).set("a", 2).set("m", 3));` },
  { name: "a Map inside an object", code: `console.log({ m: new Map<string, number>().set("a", 1) });` },
  { name: "a Map that wraps", code: `console.log(new Map<string, number>().set("key0", 1).set("key1", 2).set("key2", 3).set("key3", 4).set("key4", 5).set("key5", 6));` },
]);

/* ------------------------------------------------------------------ *
 * 8. Multiple arguments, and compounds mixed with scalars.
 * ------------------------------------------------------------------ */

differential("multiple arguments", [
  { name: "string, object, number", code: `const o = { a: 1, b: "x" };\nconsole.log("x", o, 1);` },
  { name: "two compounds", code: `console.log({ a: 1 }, [1, 2]);` },
  { name: "scalars keep their spacing", code: `console.log(1, true, null, undefined, "s");` },
  { name: "no arguments prints a bare newline", code: `console.log();\nconsole.log("after");` },
]);

/* ------------------------------------------------------------------ *
 * 9. Dyn — `console.log(JSON.parse(...))`, deferred since Stage 20 ("util.inspect,
 * deferred"), where a compound printed the literal `[object]`. Same algorithm, but
 * the shape is only known at runtime, so the walk lives in the runtime.
 * ------------------------------------------------------------------ */

differential("Dyn (JSON.parse results)", [
  { name: "an object", code: `console.log(JSON.parse('{"a":1,"b":[1,2,3],"c":{"d":"x"}}'));` },
  { name: "an array", code: `console.log(JSON.parse("[1,2,3]"));` },
  { name: "empty compounds", code: `console.log(JSON.parse("[]"));\nconsole.log(JSON.parse("{}"));` },
  { name: "scalars still print bare", code: `console.log(JSON.parse('"str"'));\nconsole.log(JSON.parse("42"));\nconsole.log(JSON.parse("null"));\nconsole.log(JSON.parse("true"));` },
  { name: "the depth cut applies", code: `console.log(JSON.parse('{"a":{"b":{"c":{"d":1}}}}'));` },
  { name: "array of objects", code: `console.log(JSON.parse('[{"k":"v"},{"k":"w"}]'));` },
  { name: "quoting and null inside", code: `console.log(JSON.parse("{\\"n\\":null,\\"t\\":true,\\"s\\":\\"it's\\"}"));` },
  { name: "a grouped numeric array", code: `console.log(JSON.parse("[1,2,3,4,5,6,7,8,9,10]"));` },
]);

/* ------------------------------------------------------------------ *
 * 10. Date — node's util.inspect of a Date IS its ISO string, at any nesting.
 * ------------------------------------------------------------------ */

differential("Date inside compounds", [
  { name: "top level", code: `console.log(new Date(0));` },
  { name: "as a field (unquoted, unlike a string)", code: `console.log({ d: new Date(0) });` },
  { name: "in an array", code: `console.log([new Date(0), new Date(86400000)]);` },
]);

/* ------------------------------------------------------------------ *
 * 11. maxArrayLength — node shows 100 entries then `... n more items`.
 * ------------------------------------------------------------------ */

differential("maxArrayLength", [
  { name: "exactly 100 shows everything", code: `let a: number[] = [];\nfor (let i = 0; i < 100; i++) a = [...a, i];\nconsole.log(a);` },
  { name: "101 shows `... 1 more item` (singular)", code: `let a: number[] = [];\nfor (let i = 0; i < 101; i++) a = [...a, i * 7];\nconsole.log(a);` },
  { name: "150 shows `... 50 more items` (plural)", code: `let a: number[] = [];\nfor (let i = 0; i < 150; i++) a = [...a, i];\nconsole.log(a);` },
]);

/* ------------------------------------------------------------------ *
 * 12. THE INVARIANT: nothing prints nothing.
 *
 * Every value that reaches `console.log` either renders exactly like node or is
 * REFUSED with a code. This is the property the stage exists to restore, so it is
 * asserted directly: run a spread of shapes and require non-empty output that
 * equals node's.
 * ------------------------------------------------------------------ */

test("no compound value prints an empty line", async () => {
  const code = [
    POINT,
    `const arr: number[] = [1, 2, 3];`,
    `const empty: number[] = [];`,
    `console.log({ a: 1 });`,
    `console.log(arr);`,
    `console.log(empty);`,
    `console.log({});`,
    `console.log(new Point(1, "z"));`,
    `console.log(new Map<string, number>().set("a", 1));`,
    `console.log(new Set<number>().add(1));`,
    `console.log(JSON.parse('{"a":1}'));`,
    `console.log([{ a: 1 }]);`,
    `console.log({ a: [1] });`,
  ].join("\n");
  const { ours, oracle } = await expectMatchesNode(code);
  expect(ours.stdout).toBe(oracle.stdout);
  // The defect was a BARE NEWLINE per compound — assert no line is empty.
  const lines = ours.stdout.split("\n").slice(0, -1);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l === "")).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 13. What is still refused — and with which code. Never a raw pointer.
 * ------------------------------------------------------------------ */

describe("refusals (reject, never print nothing)", () => {
  // node names a function from the binding it was assigned to (`[Function: f]`);
  // our lambda-lifted arrows carry no such name.
  test("a function value is NT1025", () => {
    expect(rejectCode(`const f = (x: number): number => x + 1;\nconsole.log(f);`)).toBe("NT1025");
  });
  test("a function value NESTED in an object is NT1025", () => {
    expect(rejectCode(`const f = (x: number): number => x + 1;\nconsole.log({ f: f });`)).toBe("NT1025");
  });
  // A bare Uint8Array keeps its own long-standing code (node's column-grouped
  // typed-array layout); nested, it is NT1025 like the other opaque handles.
  test("a bare Uint8Array is still NT1016", () => {
    expect(rejectCode(`const u = new Uint8Array(3);\nconsole.log(u);`)).toBe("NT1016");
  });
  test("a nested Uint8Array is NT1025", () => {
    expect(rejectCode(`const u = new Uint8Array(3);\nconsole.log({ u: u });`)).toBe("NT1025");
  });
  test("a TextEncoder handle is NT1025", () => {
    expect(rejectCode(`console.log(new TextEncoder());`)).toBe("NT1025");
  });
  test("a bare URL is still NT1024", () => {
    expect(rejectCode(`console.log(new URL("https://a.b/c"));`)).toBe("NT1024");
  });
  test("a nested URL is NT1025", () => {
    expect(rejectCode(`const u = new URL("https://a.b/c");\nconsole.log({ u: u });`)).toBe("NT1025");
  });
  // A function BELOW node's depth cut is never rendered, so it does not block.
  test("a function below the depth cut does not block", () => {
    expect(rejectCode(`const f = (x: number): number => x + 1;\nconsole.log({ a: { b: { c: { f: f } } } });`)).toBe(null);
  });
});

/* ------------------------------------------------------------------ *
 * 14. Non-console.log paths are untouched — inspect quoting must not leak into
 * string coercion, template literals or JSON.stringify.
 * ------------------------------------------------------------------ */

differential("inspect formatting does not leak", [
  { name: "template literals and String() are unchanged", code: `const s = "it's";\nconsole.log(\`[\${s}]\`);\nconsole.log(String(-0));\nconsole.log("" + -0);` },
  { name: "JSON.stringify is unchanged", code: `console.log(JSON.stringify({ a: 1, b: "x" }));\nconsole.log(JSON.stringify([1, 2, 3]));` },
  { name: "join is unchanged", code: `console.log(["a", "b"].join(","));` },
]);
