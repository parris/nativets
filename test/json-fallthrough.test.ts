/*
 * `JSON.stringify` — the DEFAULT-TO-`null` fall-through, and what replaced it.
 *
 * `genJsonStringify` handled number/boolean/string/Date/nullable/array/object and
 * then ended with
 *
 *     return { v: this.mod.intern("null"), ty: "string" };
 *
 * — so every type nobody had thought about serialized as the literal `null`. That is
 * the same shape as the `truthyOf` fall-through documented in `docs/divergences.md`:
 * silent, and it absorbs each new box type as it is added. Measured against node,
 * SIX types were already wrong through it (`Map`, `Set`, `Uint8Array`, a function,
 * `Dyn`, and the `undefined` VALUE), and the nested ones are the dangerous kind —
 * `{"m":null,"ok":1}` sits inside an otherwise-correct object and looks fine.
 *
 * The fix is the fall-through itself: `genJsonStringify` is exhaustive now and
 * `internalError`s on an unknown type, and `checkJsonStringifyArg` in the checker
 * walks the SAME shape first so anything with no node-exact rendering is refused
 * with an `NT****` before codegen ever sees it. A seventh box type is a compile
 * error, not a seventh wrong answer.
 *
 * Every case here is measured against `node` on this machine, stdout AND exit code. Most
 * were DERIVED rather than borrowed; the ones that came from test262
 * (`test/built-ins/JSON/stringify/`) cite the file they came from at the case, per
 * CLAUDE.md's "Use reference tests". The suite is what found the `toJSON` hole below —
 * the derived cases did not, because a class instance is structurally an object here and
 * so it looked handled. The first block pins what already worked, because
 * `JSON.stringify` is load-bearing everywhere and the fall-through sits directly under it.
 *
 * SWEPT FROM test262 AND FOUND ALREADY CORRECT, so no case was added: `-0` is `"0"`
 * (`value-number-negative-zero.js`), NaN/±Infinity are `null` (`value-number-non-finite.js`,
 * closed by this lane), the control-character escape table incl. lowercase `\u001a`
 * (`value-string-escape-ascii.js`), a function is dropped (`value-function.js`), and the
 * whole `space` argument contract — clamped to 10, floored, `<1` means compact, a string
 * gap truncated to its first 10 code units (`space-number-range.js`, `space-number-float.js`,
 * `space-number.js`, `space-string-range.js`). OUT OF SUBSET, so not swept: BigInt, Symbol,
 * boxed primitives, Proxy, replacer functions/arrays (refused), circular structures (not
 * expressible), and sparse arrays (`[1, , 3]` is NT0001 at the parser).
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

interface Case { name: string; code: string }

/** Differential against node: stdout AND exit code, and non-vacuously non-empty. */
function differential(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const { ours, oracle } = await expectMatchesNode(c.code);
        expect(oracle.stdout).not.toBe(""); // the oracle really ran and really printed
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });
    }
  });
}

/** Compile-only: the NT code a source is rejected with, or null if it compiles. */
function rejectCode(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

/** Compile-only: the full message of the rejection, so the HINT is pinned too. */
function rejectMessage(src: string): string {
  try { sourceToIR(src); return "(compiled)"; } catch (e) { return e instanceof NTError ? e.diag.message : String(e); }
}

// ---------------------------------------------------------------------------
// Regression pins — everything that was ALREADY node-correct before the
// fall-through was touched. These are the safety net; they come first.
// ---------------------------------------------------------------------------

differential("JSON.stringify — scalars still match node", [
  { name: "number", code: `console.log(JSON.stringify(42));` },
  { name: "negative and fractional", code: `console.log(JSON.stringify(-1.5));` },
  { name: "negative zero is 0", code: `console.log(JSON.stringify(-0));` },
  { name: "exponent form", code: `console.log(JSON.stringify(1e21));` },
  { name: "string", code: `console.log(JSON.stringify("hi"));` },
  { name: "string with a quote and a backslash", code: `console.log(JSON.stringify("a\\"b\\\\c"));` },
  { name: "string with a newline and a tab", code: `console.log(JSON.stringify("a\\nb\\tc"));` },
  { name: "non-ascii string", code: `console.log(JSON.stringify("héllo ☃"));` },
  { name: "empty string", code: `console.log(JSON.stringify(""));` },
  { name: "true", code: `console.log(JSON.stringify(true));` },
  { name: "false", code: `console.log(JSON.stringify(false));` },
  { name: "the null literal", code: `console.log(JSON.stringify(null));` },
]);

differential("JSON.stringify — containers still match node", [
  { name: "flat object", code: `console.log(JSON.stringify({ a: 1, b: "x", c: true }));` },
  { name: "empty object", code: `const o: { } = { }; console.log(JSON.stringify(o));` },
  { name: "nested object", code: `console.log(JSON.stringify({ a: { b: { c: 1 } } }));` },
  { name: "array of numbers", code: `console.log(JSON.stringify([1, 2, 3]));` },
  { name: "empty array", code: `const a: number[] = []; console.log(JSON.stringify(a));` },
  { name: "array of objects", code: `console.log(JSON.stringify([{ a: 1 }, { a: 2 }]));` },
  { name: "object holding an array", code: `console.log(JSON.stringify({ xs: [1, 2], n: 3 }));` },
  { name: "array of strings needing escapes", code: `console.log(JSON.stringify(["a\\"b", "c\\nd"]));` },
  { name: "deeply nested mix", code: `console.log(JSON.stringify({ a: [{ b: [1, 2] }, { b: [3] }] }));` },
]);

differential("JSON.stringify — Date still matches node", [
  { name: "a Date is its quoted ISO string", code: `console.log(JSON.stringify(new Date(0)));` },
  { name: "an Invalid Date is null", code: `console.log(JSON.stringify(new Date("nope")));` },
  { name: "a Date in an object", code: `console.log(JSON.stringify({ at: new Date(86400000), n: 1 }));` },
  { name: "a Date in an array", code: `console.log(JSON.stringify([new Date(0)]));` },
]);

// The A2 nullable-box holes a lane closed earlier — `docs/divergences.md` records
// them. Re-pinned here so this lane cannot reintroduce them from underneath.
differential("JSON.stringify — the A2 nullable box still matches node", [
  { name: "T | null at the root, present", code: `const x: number | null = 1; console.log(JSON.stringify(x));` },
  { name: "T | null at the root, null", code: `const x: number | null = null; console.log(JSON.stringify(x));` },
  { name: "T | null as a field, present", code: `const x: string | null = "s"; console.log(JSON.stringify({ x: x, n: 1 }));` },
  { name: "T | null as a field, null", code: `const x: string | null = null; console.log(JSON.stringify({ x: x, n: 1 }));` },
  { name: "T | undefined as a field drops the key", code: `const x: number | undefined = undefined; console.log(JSON.stringify({ x: x, n: 1 }));` },
  { name: "T | undefined as a present field keeps it", code: `const x: number | undefined = 7; console.log(JSON.stringify({ x: x, n: 1 }));` },
  { name: "every field dropped is {}", code: `const x: number | undefined = undefined; console.log(JSON.stringify({ x: x }));` },
  // (`(number | null)[]` itself is NT1001 — an array OF a nullable is not in the value
  // model yet — so the nullable-inside-an-array pin goes through a record element.)
  { name: "T | null inside an array element", code: `const a: number | null = 1; const b: number | null = null; console.log(JSON.stringify([{ v: a }, { v: b }]));` },
]);

test("JSON.stringify of a `T | undefined` at the ROOT is still refused", () => {
  expect(rejectCode(`const x: number | undefined = undefined; console.log(JSON.stringify(x));`)).toBe("NT1005");
});

// ---------------------------------------------------------------------------
// Two bugs found while pinning, both PRE-EXISTING and both worse than a wrong
// answer: they emitted text that is not JSON at all, so the output does not even
// survive its own `JSON.parse`.
//
//   `JSON.stringify(NaN)`      was `NaN`   (node: `null`)
//   `JSON.stringify("ab")` was a RAW 0x01 byte (node: `"ab"`)
//
// Both come from reusing a general-purpose renderer inside JSON: `js_num_to_str`
// is `String(x)`, where `NaN` is right, and `js_json_quote` escaped only the five
// characters that have a short form. JSON has neither a non-finite number
// (RFC 8259 §6) nor a literal control character in a string (§7).
// ---------------------------------------------------------------------------

differential("JSON.stringify — a non-finite number is null, as in node", [
  { name: "NaN at the root", code: `console.log(JSON.stringify(0 / 0));` },
  { name: "Infinity at the root", code: `console.log(JSON.stringify(1 / 0));` },
  { name: "-Infinity at the root", code: `console.log(JSON.stringify(-1 / 0));` },
  { name: "NaN as an object field", code: `console.log(JSON.stringify({ n: 0 / 0, ok: 1 }));` },
  { name: "NaN as an array element", code: `console.log(JSON.stringify([0 / 0, 1 / 0]));` },
  { name: "a finite number is untouched", code: `console.log(JSON.stringify({ a: 1e21, b: -0, c: 0.1 }));` },
]);

// The control characters go in as `\xHH`, never `\uXXXX`: our lexer does not
// implement the `\u` escape and silently yields the LETTER `u` for it
// (`src/lexer.ts:289`, `ESCAPES[e] ?? e` — a third fall-through of this family,
// reported separately). `\xHH` is implemented and exact, so these cases test JSON
// quoting rather than the lexer.
differential("JSON.stringify — a control character is escaped, as in node", [
  { name: "U+0001 at the root", code: `console.log(JSON.stringify("a\\x01b"));` },
  { name: "U+001F, the last control character", code: `console.log(JSON.stringify("a\\x1fb"));` },
  { name: "backspace takes its short form", code: `console.log(JSON.stringify("a\\x08b"));` },
  { name: "form feed takes its short form", code: `console.log(JSON.stringify("a\\x0cb"));` },
  { name: "vertical tab has no short form", code: `console.log(JSON.stringify("a\\x0bb"));` },
  { name: "U+007F is NOT escaped", code: `console.log(JSON.stringify("a\\x7fb").length);` },
  { name: "the whole 0x01-0x1f range", code: `console.log(JSON.stringify("\\x01\\x02\\x03\\x04\\x05\\x06\\x07\\x08\\x09\\x0a\\x0b\\x0c\\x0d\\x0e\\x0f\\x10\\x11\\x12\\x13\\x14\\x15\\x16\\x17\\x18\\x19\\x1a\\x1b\\x1c\\x1d\\x1e\\x1f"));` },
  { name: "a control character in a field", code: `console.log(JSON.stringify({ k: "x\\x02y", n: 1 }));` },
  { name: "a control character in an array element", code: `console.log(JSON.stringify(["x\\x02y"]));` },
  { name: "an escape-heavy string round-trips through JSON.parse", code: `const s = JSON.stringify("a\\x01b\\"c\\\\d"); console.log(s); console.log(JSON.parse(s) as string);` },
]);

differential("JSON.stringify — the pretty-printed forms still match node", [
  { name: "indent 2", code: `console.log(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));` },
  { name: "indent 4", code: `console.log(JSON.stringify({ a: { b: 1 } }, null, 4));` },
  { name: "tab indent", code: `console.log(JSON.stringify({ a: 1 }, null, "\\t"));` },
  { name: "indented empty containers stay inline", code: `const o: { } = { }; const a: number[] = []; console.log(JSON.stringify({ o: o, a: a }, null, 2));` },
]);

// ---------------------------------------------------------------------------
// The fall-through itself.
//
// POSITION MATTERS in node, so each case is measured at the root, as an object
// FIELD and as an array ELEMENT. The element position turns out to be
// unreachable for every one of these types — `Map<…>[]`, `Uint8Array[]` and
// `((n: number) => number)[]` are all `NT1001` ("arrays of X is not supported
// yet"), which predates this lane — so the live positions are root and field,
// and each is pinned separately rather than assumed to follow from the other.
// ---------------------------------------------------------------------------

// A Map and a Set serialize as `{}` because neither has any own ENUMERABLE
// property — their contents live in internal slots that `JSON.stringify` never
// walks. That is not an approximation of node: `{}` is what node prints for
// EVERY Map and EVERY Set, whatever is in them, so it is exact by construction.
//
// NOTE — the "non-empty" cases below were, until the discarded-mutator refusal landed
// (NT1606, src/checker.ts `rejectDiscardedMutator`), NOT ACTUALLY NON-EMPTY. They were
// written in JS's discarding style (`const s = new Set(); s.add("a");`), which under
// nativets' PERSISTENT Map/Set is a no-op — so every one of them stringified an EMPTY
// collection while claiming to cover a full one. The assertion could not tell, because
// `{}` is node's answer either way, which is exactly why the defect survived here.
// They now use the chained form and genuinely carry entries, so the cases test what
// their names say. This is a strengthening, not a workaround.
differential("JSON.stringify — a Map/Set is {}, as in node", [
  { name: "an empty Set at the root", code: `const s = new Set<string>(); console.log(JSON.stringify(s));` },
  { name: "a non-empty Set at the root", code: `const s = new Set<string>().add("a").add("b"); console.log(JSON.stringify(s));` },
  { name: "an empty Map at the root", code: `const m = new Map<string, number>(); console.log(JSON.stringify(m));` },
  { name: "a non-empty Map at the root", code: `const m = new Map<string, number>().set("a", 1); console.log(JSON.stringify(m));` },
  { name: "a Set as an object field", code: `const s = new Set<string>().add("a"); console.log(JSON.stringify({ s: s, ok: 1 }));` },
  { name: "a Map as an object field", code: `const m = new Map<string, string>().set("a", "1"); console.log(JSON.stringify({ m: m, ok: 1 }));` },
  { name: "a Map as the ONLY field", code: `const m = new Map<string, string>().set("a", "1"); console.log(JSON.stringify({ m: m }));` },
  { name: "a Map and a Set, pretty-printed", code: `const s = new Set<string>(); const m = new Map<string, string>(); console.log(JSON.stringify({ s: s, m: m }, null, 2));` },
  { name: "a Map of a Map", code: `const inner = new Map<string, number>(); const m = new Map<string, string>().set("k", "v"); console.log(JSON.stringify({ a: m, b: inner }));` },
]);

// A Uint8Array has INDEX properties, and they are own and enumerable, so node
// walks them into an index-keyed object — `{"0":1,"1":255}`, not `[1,255]`.
differential("JSON.stringify — a Uint8Array is an index-keyed object, as in node", [
  { name: "zero-filled at the root", code: `const u = new Uint8Array(2); console.log(JSON.stringify(u));` },
  { name: "written bytes at the root", code: `const u = new Uint8Array(3); u[0] = 1; u[1] = 255; u[2] = 0; console.log(JSON.stringify(u));` },
  { name: "an empty Uint8Array is {}", code: `const u = new Uint8Array(0); console.log(JSON.stringify(u));` },
  { name: "as an object field", code: `const u = new Uint8Array(2); u[0] = 7; console.log(JSON.stringify({ u: u, ok: 1 }));` },
  { name: "as the ONLY object field", code: `const u = new Uint8Array(1); console.log(JSON.stringify({ u: u }));` },
  { name: "pretty-printed at the root", code: `const u = new Uint8Array(3); u[0] = 1; u[1] = 255; console.log(JSON.stringify(u, null, 2));` },
  { name: "pretty-printed empty stays inline", code: `const u = new Uint8Array(0); console.log(JSON.stringify(u, null, 2));` },
  { name: "pretty-printed as a nested field", code: `const u = new Uint8Array(2); u[1] = 9; console.log(JSON.stringify({ u: u, n: 1 }, null, 2));` },
  { name: "pretty-printed with a tab indent", code: `const u = new Uint8Array(2); console.log(JSON.stringify({ u: u }, null, "\\t"));` },
  { name: "a longer buffer", code: `const u = new Uint8Array(10); u[9] = 200; console.log(JSON.stringify(u));` },
]);

// A function is not JSON. node DROPS it, and drops it differently by position —
// exactly like `undefined`, which it becomes. At the root that means the
// undefined VALUE, which our `string`-typed `JSON.stringify` cannot return, so
// the root is refused (the `T | undefined` precedent, `docs/divergences.md`).
// As a FIELD the key is simply omitted, which is a COMPILE-TIME decision here —
// a field's type either is a function or is not — so that one is rendered.
differential("JSON.stringify — a function-typed field is omitted, as in node", [
  { name: "one function field among others", code: `const f = (x: number): number => x; console.log(JSON.stringify({ f: f, ok: 1 }));` },
  { name: "a function field first and last", code: `const f = (x: number): number => x; console.log(JSON.stringify({ f: f, ok: 1, g: f }));` },
  { name: "an object of ONLY function fields is {}", code: `const f = (x: number): number => x; console.log(JSON.stringify({ f: f }));` },
  { name: "pretty-printed with a dropped function field", code: `const f = (x: number): number => x; console.log(JSON.stringify({ f: f, ok: 1 }, null, 2));` },
  { name: "pretty-printed, all fields dropped", code: `const f = (x: number): number => x; console.log(JSON.stringify({ f: f }, null, 2));` },
  { name: "a nested object with a function field", code: `const f = (x: number): number => x; console.log(JSON.stringify({ inner: { f: f, n: 2 }, ok: 1 }));` },
]);

describe("JSON.stringify — what is REFUSED rather than guessed", () => {
  test("a function at the ROOT (node returns the undefined VALUE)", () => {
    expect(rejectCode(`const f = (x: number): number => x; console.log(JSON.stringify(f));`)).toBe("NT1005");
    expect(rejectMessage(`const f = (x: number): number => x; console.log(JSON.stringify(f));`)).toContain("undefined VALUE");
  });

  test("the undefined literal at the ROOT (node returns the undefined VALUE)", () => {
    expect(rejectCode(`console.log(JSON.stringify(undefined));`)).toBe("NT1005");
  });

  // Found while making the fall-through exhaustive, and the worst of the set: a
  // `JSON.parse` -> `JSON.stringify` ROUND TRIP silently produced `null`.
  test("a Dyn — the JSON.parse round trip — is refused, not `null`", () => {
    expect(rejectCode(`const d = JSON.parse("{\\"a\\":1}"); console.log(JSON.stringify(d));`)).toBe("NT1005");
    expect(rejectMessage(`const d = JSON.parse("{\\"a\\":1}"); console.log(JSON.stringify(d));`)).toContain("JSON.parse");
  });

  test("a Dyn nested in an object is refused too", () => {
    expect(rejectCode(`const d = JSON.parse("1"); console.log(JSON.stringify({ d: d, n: 1 }));`)).toBe("NT1005");
  });

  test("a URL has no renderer here and is refused", () => {
    expect(rejectCode(`const u = new URL("https://a.b/c"); console.log(JSON.stringify(u));`)).toBe("NT1005");
  });

  test("a URLSearchParams has no renderer here and is refused", () => {
    expect(rejectCode(`const p = new URLSearchParams("a=1"); console.log(JSON.stringify(p));`)).toBe("NT1005");
  });

  test("a TextEncoder has no renderer here and is refused", () => {
    expect(rejectCode(`const e = new TextEncoder(); console.log(JSON.stringify(e));`)).toBe("NT1005");
  });

  // test262 `built-ins/JSON/stringify/value-tojson-result.js`: `toJSON` REPLACES the
  // value — node calls it and serializes what it RETURNS, at every position. nativets
  // builds the serializer from the static FIELDS, so it ignored the method and emitted
  // the raw shape: `{"x":1}` where node gives `"P!"`. That is the SAME defect class this
  // lane closes (a type with no node-exact rule rendered anyway), and it survived the
  // first pass because a class instance is structurally an object and fell into the
  // object arm. Refused now, with the call named.
  const P = `class P { x: number; constructor(x: number) { this.x = x; } toJSON(): string { return "P!"; } }\n`;
  test("a class with a toJSON is refused, not serialized from its fields", () => {
    expect(rejectCode(P + `console.log(JSON.stringify(new P(1)));`)).toBe("NT1005");
    expect(rejectMessage(P + `console.log(JSON.stringify(new P(1)));`)).toContain("toJSON");
  });

  test("a toJSON class NESTED in an object is refused too", () => {
    expect(rejectCode(P + `console.log(JSON.stringify({ p: new P(1), n: 2 }));`)).toBe("NT1005");
  });

  test("an object literal with a toJSON FUNCTION field is refused", () => {
    // Without this the lane's own function-field DROP hides it: node gives `"X"`, and
    // dropping the key would give `{"a":1}` — a more plausible wrong answer than the
    // `{"toJSON":null,"a":1}` it replaced.
    expect(rejectCode(`const o = { toJSON: (): string => "X", a: 1 }; console.log(JSON.stringify(o));`)).toBe("NT1005");
  });

  test("a class WITHOUT a toJSON still serializes from its fields", () => {
    expect(rejectCode(`class Q { x: number; constructor(x: number) { this.x = x; } }\nconsole.log(JSON.stringify(new Q(1)));`)).toBe(null);
  });

  test("the refusal names the type and offers a fix", () => {
    const m = rejectMessage(`const u = new URL("https://a.b/c"); console.log(JSON.stringify(u));`);
    expect(m).toContain("URL");
    expect(m).toContain("JSON.stringify");
  });
});

// The `%j` specifier IS `JSON.stringify`, so it must accept exactly what the
// direct call accepts. It used to disagree: `%j` refused a Map/Set outright
// while the direct call rendered `null` for one. Both now route through the one
// predicate, so they agree by construction rather than by being kept in step.
describe("`%j` and the direct call agree", () => {
  const pairs: { name: string; direct: string; fmt: string }[] = [
    { name: "a Map", direct: `const m = new Map<string, number>(); console.log(JSON.stringify(m));`, fmt: `const m = new Map<string, number>(); console.log("%j", m);` },
    { name: "a Set", direct: `const s = new Set<string>(); console.log(JSON.stringify(s));`, fmt: `const s = new Set<string>(); console.log("%j", s);` },
    { name: "a Uint8Array", direct: `const u = new Uint8Array(2); console.log(JSON.stringify(u));`, fmt: `const u = new Uint8Array(2); console.log("%j", u);` },
    { name: "a Dyn", direct: `const d = JSON.parse("1"); console.log(JSON.stringify(d));`, fmt: `const d = JSON.parse("1"); console.log("%j", d);` },
    { name: "a URL", direct: `const u = new URL("https://a.b/"); console.log(JSON.stringify(u));`, fmt: `const u = new URL("https://a.b/"); console.log("%j", u);` },
    { name: "an object", direct: `console.log(JSON.stringify({ a: 1 }));`, fmt: `console.log("%j", { a: 1 });` },
    { name: "an array", direct: `console.log(JSON.stringify([1, 2]));`, fmt: `console.log("%j", [1, 2]);` },
    { name: "a number", direct: `console.log(JSON.stringify(1));`, fmt: `console.log("%j", 1);` },
  ];
  for (const p of pairs) {
    test(`${p.name}: accepted by both or refused by both`, () => {
      expect(rejectCode(p.fmt) === null).toBe(rejectCode(p.direct) === null);
    });
  }
});

// THE REGRESSION THIS PINS, in the CLAUDE.md style: `console.log("%j", undefined)`
// printed `undefined` — node-correct — and routing `%j` through the direct call's
// predicate turned it into an `NT1005` refusal. A fix that trades a correct answer for a
// wrong REJECTION is still a regression, and it nearly shipped inside a commit whose
// message says it closes eight silent wrong answers.
//
// node is why the two differ: `%j` does not RETURN the stringify result, it CONCATENATES
// it (`formatWithOptions` does `tempStr = tryStringify(arg)` and joins), so a value
// stringify DROPS prints the literal `undefined`. The direct call has a `string` result
// type here and the undefined VALUE does not fit in one, so it stays refused. Both
// directions are pinned, because pinning only one lets the other drift back.
describe("`%j` of undefined prints `undefined`, where the direct call is refused", () => {
  test("`%j` of undefined compiles", () => {
    expect(rejectCode(`console.log("%j", undefined);`)).toBe(null);
  });
  test("the direct call on the same value stays refused", () => {
    expect(rejectCode(`console.log(JSON.stringify(undefined));`)).toBe("NT1005");
  });
});

// (Only the `undefined` LITERAL is measured. A `void`-typed CALL is accepted by the same
//  arm, but it cannot be pinned against node here: `console.log(f())` for `f(): void`
//  prints `0` in nativets and `undefined` in node — a PRE-EXISTING wrong answer that has
//  nothing to do with JSON and predates this lane. Reported separately.)
differential("`%j` of undefined matches node", [
  { name: "%j of the undefined literal", code: `console.log("%j", undefined);` },
]);

differential("`%j` of a Map/Set/Uint8Array now matches node", [
  // Chained, not discarded — see the note on the `JSON.stringify` block above: the
  // discarding spelling built an EMPTY collection here and `{}` hid it.
  { name: "%j of a Map", code: `const m = new Map<string, number>().set("a", 1); console.log("%j", m);` },
  { name: "%j of a Set", code: `const s = new Set<string>().add("a"); console.log("%j", s);` },
  { name: "%j of a Uint8Array", code: `const u = new Uint8Array(2); u[0] = 3; console.log("%j", u);` },
  { name: "%j of an object holding a Map", code: `const m = new Map<string, number>(); console.log("%j", { m: m, n: 1 });` },
]);
