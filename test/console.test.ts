/*
 * Stage 49 — the rest of the `console` surface: FORMAT SPECIFIERS and the
 * stderr methods.
 *
 * TWO DEFECTS THIS CLOSES.
 *
 * (1) Format specifiers were IGNORED. `console.log("a %s b", "x")` printed
 *     `a %s b x` where node prints `a x b` — a silent wrong answer, the same
 *     class of defect as Stage 47's bare newline. node's
 *     `formatWithOptionsInternal` (lib/internal/util/inspect.js) consumes
 *     `%s %d %i %f %j %o %O %c %%` from a LEADING STRING argument when further
 *     arguments follow; anything not consumed is appended space-separated.
 *
 * (2) `console.error` did not exist — it failed with `NT2001: 'console' is not
 *     defined`. It (and `warn`) now write to STDERR, `info`/`debug` to stdout,
 *     all sharing the whole `console.log` path (inspect + specifiers).
 *
 * node is the oracle byte-for-byte, on BOTH streams.
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

/** Every case here is DIFFERENTIAL: our stdout AND stderr must equal node's, exactly. */
function differential(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const { ours, oracle } = await expectMatchesNode(c.code);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.stderr).toBe(oracle.stderr);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 1. `%s` — String(), except a compound goes through inspect at depth 0.
 * ------------------------------------------------------------------ */

differential("%s", [
  { name: "the regression: a string mid-sentence", code: `console.log("a %s b", "x");` },
  { name: "a number", code: `console.log("n=%s", 42);` },
  { name: "a boolean", code: `console.log("%s", true);` },
  { name: "negative zero prints -0", code: `console.log("%s", -0);` },
  { name: "an object at DEPTH 0 (nested becomes [Object])", code: `console.log("%s", { a: { b: { c: 1 } } });` },
  { name: "an array", code: `console.log("%s", [1, 2, 3]);` },
  { name: "two specifiers", code: `console.log("%s-%s", "a", "b");` },
  { name: "extra args are appended space-separated", code: `console.log("%s", "a", "b", "c");` },
  { name: "a specifier with no argument stays LITERAL", code: `console.log("%s %s", 1);` },
]);

/* ------------------------------------------------------------------ *
 * 2. `%d` / `%i` / `%f` — ToNumber / parseInt / parseFloat, which are
 *    three DIFFERENT conversions. `%d` of `true` is 1; `%i` of it is NaN
 *    (parseInt("true")); `%d` of "" is 0 but `%f` of it is NaN.
 * ------------------------------------------------------------------ */

differential("%d / %i / %f", [
  { name: "the regression: %d mid-word", code: `console.log("n=%d!", 42);` },
  { name: "%d of a numeric string is ToNumber", code: `console.log("%d", "12");` },
  { name: "%d of a non-numeric string is NaN", code: `console.log("%d", "12px");` },
  { name: "%d of a padded string trims", code: `console.log("%d", " 12 ");` },
  { name: "%d of an empty string is 0", code: `console.log("%d", "");` },
  { name: "%d of a boolean is 1/0", code: `console.log("%d %d", true, false);` },
  { name: "%d of null is 0, of undefined is NaN", code: `console.log("%d %d", null, undefined);` },
  { name: "%d of an object is NaN", code: `console.log("%d", { a: 1 });` },
  { name: "%d keeps -0", code: `console.log("%d", -0);` },
  { name: "%i truncates", code: `console.log("%i", 42.9);` },
  { name: "%i reads a 0x prefix", code: `console.log("%i", "0x1f");` },
  { name: "%i of a prefix-numeric string", code: `console.log("%i", "12px");` },
  { name: "%i of a boolean is NaN (parseInt of \"true\")", code: `console.log("%i", true);` },
  { name: "%f parses a float prefix", code: `console.log("%f", "1.5e2xyz");` },
  { name: "%f of a boolean is NaN", code: `console.log("%f", true);` },
  { name: "%f of null is NaN", code: `console.log("%f", null);` },
  { name: "%d of a Date is its time value", code: `console.log("%d", new Date(1234));` },
]);

/* ------------------------------------------------------------------ *
 * 3. `%j`, `%O`, `%o`, `%c`, `%%`.
 * ------------------------------------------------------------------ */

differential("%j / %O / %c / %%", [
  { name: "%j of an object", code: `console.log("%j", { a: 1, b: "x" });` },
  { name: "%j of an array", code: `console.log("%j", ["a", "b"]);` },
  { name: "%j of a string quotes it", code: `console.log("%j", "hi");` },
  { name: "%j of undefined is the literal undefined", code: `console.log("%j", undefined);` },
  { name: "%O is inspect at the DEFAULT depth", code: `console.log("%O", { a: { b: { c: 1 } } });` },
  { name: "%O of a string QUOTES it", code: `console.log("%O", "hi");` },
  { name: "%o of a scalar is %O", code: `console.log("%o %o", 1, "s");` },
  { name: "%c consumes its argument and prints nothing", code: `console.log("%cstyled", "color:red");` },
  { name: "%c then a trailing argument", code: `console.log("%c", "color:red", "after");` },
  { name: "%% collapses when arguments follow", code: `console.log("100%% done", 1);` },
  { name: "%% is LITERAL with no further argument", code: `console.log("100%% done");` },
  { name: "%d%% — a percentage", code: `console.log("%d%%", 50);` },
]);

/* ------------------------------------------------------------------ *
 * 4. The scan's edge cases, straight out of `formatWithOptionsInternal`.
 * ------------------------------------------------------------------ */

differential("the scan", [
  { name: "a trailing % is never a specifier", code: `console.log("a%", 1);` },
  { name: "an unknown specifier is left literal", code: `console.log("%z", 1);` },
  { name: "a lone %% with an argument", code: `console.log("%%", 1);` },
  { name: "%%%s — the escape then a specifier", code: `console.log("%%%s", "a");` },
  { name: "%%s is an escape, not a specifier", code: `console.log("%%s", "a");` },
  { name: "adjacent specifiers", code: `console.log("%s%s", "a", "b", "c");` },
  { name: "a NON-leading format string is not scanned", code: `console.log("x", "%s", "y");` },
  { name: "a non-string leading argument is not scanned", code: `console.log(1, "%s", "y");` },
  { name: "a single argument is never formatted", code: `console.log("%s");` },
  { name: "a template literal with no substitution is a literal format", code: "console.log(`a %s b`, \"x\");" },
  { name: "specifiers inside a longer sentence", code: `console.log("user %s has %d points (%s)", "ada", 42, true);` },
]);

/* ------------------------------------------------------------------ *
 * 5. The other console methods, and THE STREAM EACH ONE WRITES TO —
 *    node maps warn/error to stderr and log/info/debug to stdout. The
 *    differential above compares both streams, so a method landing on the
 *    wrong one fails here even though the text matches.
 * ------------------------------------------------------------------ */

differential("console.error / warn / info / debug", [
  { name: "the regression: console.error exists", code: `console.error("boom");` },
  { name: "console.error takes many arguments", code: `console.error("a", 1, true, null);` },
  { name: "console.error inspects a compound (Stage 47 path)", code: `console.error({ a: 1, b: [1, 2] });` },
  { name: "console.error formats specifiers", code: `console.error("%s failed with %d", "job", 7);` },
  { name: "console.warn is stderr too", code: `console.warn("careful %s", "now");` },
  { name: "console.info is stdout", code: `console.info("fyi %d", 1);` },
  { name: "console.debug is stdout", code: `console.debug("dbg %s", "x");` },
  { name: "the streams are independent", code: `console.log("out1");\nconsole.error("err1");\nconsole.log("out2");\nconsole.error("err2");` },
  { name: "error of a nullable", code: `const x: string | undefined = undefined;\nconsole.error(x, "then");` },
  { name: "error of a Map", code: `const m = new Map<string, number>().set("a", 1);\nconsole.error(m);` },
  { name: "error of a class instance", code: `class P { x: number; constructor(x: number) { this.x = x; } }\nconsole.error(new P(3));` },
  { name: "error of a JSON.parse result", code: `console.error(JSON.parse('{"a":[1,2]}'));` },
]);

test("stdout and stderr stay in ORDER when merged", async () => {
  const { ours, oracle } = await expectMatchesNode(
    `console.log("1");\nconsole.error("2");\nconsole.log("3");\nconsole.error("4");`,
  );
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.stderr).toBe(oracle.stderr);
});

describe("the rest of the console surface is refused, not ignored", () => {
  for (const m of ["table", "group", "dir", "time", "count", "assert", "trace", "groupEnd"]) {
    test(`console.${m}`, () => {
      expect(rejectCode(`console.${m}("x");`)).toBe("NT1026");
    });
  }
});

/* ------------------------------------------------------------------ *
 * 6. A NON-LITERAL format string. The specifier scan is a compile-time
 *    pass over the literal, so a runtime string in the format position is
 *    the one case it cannot decide. Printing the arguments space-separated
 *    is node-correct only while the string holds no specifier — so that is
 *    exactly what the runtime guard checks, and it REFUSES rather than
 *    print a line node would have formatted.
 * ------------------------------------------------------------------ */

differential("a non-literal format string with no specifier is unaffected", [
  { name: "a plain label", code: `const label = "count:";\nconsole.log(label, 42);` },
  { name: "a computed label", code: `const k = "a" + "b";\nconsole.log(k, [1, 2]);` },
  { name: "a bare percent is not a specifier", code: `const s = "50% off";\nconsole.log(s, 1);` },
  { name: "an unknown specifier is not one either", code: `const s = "%z";\nconsole.log(s, 1);` },
  { name: "a single non-literal argument is never formatted", code: `const s = "a %s b";\nconsole.log(s);` },
  { name: "a non-string first argument is never scanned", code: `const n = 1;\nconsole.log(n, "%s", "y");` },
]);

describe("a non-literal format string that DOES hold a specifier is refused at runtime", () => {
  test("it panics instead of printing node's unformatted line", async () => {
    const { ours } = await expectMatchesNode(`const s = "a %s b";\nconsole.log(s, "x");`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("panic: console format specifier in a non-literal format string");
    expect(ours.exitCode).not.toBe(0);
  });
  test("stdout written earlier is flushed before the panic", async () => {
    const { ours } = await expectMatchesNode(`console.log("before");\nconst s = "%d";\nconsole.log(s, 1);`);
    expect(ours.stdout).toBe("before\n");
    expect(ours.exitCode).not.toBe(0);
  });
  test("`%%` counts too — node collapses it once arguments follow", async () => {
    const { ours } = await expectMatchesNode(`const s = "100%% done";\nconsole.log(s, 1);`);
    expect(ours.exitCode).not.toBe(0);
  });
  // node decides whether to scan by `typeof args[0] === 'string'`, so for a nullable
  // and for a JSON.parse result that is a RUNTIME fact — the guard is fed a pointer
  // that is null exactly when node would not have scanned.
  test("a nullable string that IS present is guarded", async () => {
    const { ours } = await expectMatchesNode(`let s: string | undefined = "%s!";\nconsole.log(s, "x");`);
    expect(ours.exitCode).not.toBe(0);
  });
  test("a nullable string that is absent is not scanned", async () => {
    const { ours, oracle } = await expectMatchesNode(`let s: string | undefined = "%s!";\ns = undefined;\nconsole.log(s, "x");`);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
  });
  test("a Dyn holding a string is guarded", async () => {
    const { ours } = await expectMatchesNode(`console.log(JSON.parse('"%s!"'), "x");`);
    expect(ours.exitCode).not.toBe(0);
  });
  test("a Dyn holding a non-string is not scanned", async () => {
    const { ours, oracle } = await expectMatchesNode(`console.log(JSON.parse('42'), "x");`);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Specifiers over the compound types Stage 47 taught us to render.
 * ------------------------------------------------------------------ */

differential("specifiers over compound types", [
  { name: "%s of a class instance", code: `class P { x: number; constructor(x: number) { this.x = x; } }\nconsole.log("%s", new P(3));` },
  { name: "%s of a Map", code: `const m = new Map<string, number>().set("a", 1);\nconsole.log("%s", m);` },
  { name: "%s of a Set", code: `const s = new Set<number>().add(1).add(2);\nconsole.log("%s", s);` },
  { name: "%O of a Map", code: `const m = new Map<string, number>().set("a", 1);\nconsole.log("%O", m);` },
  { name: "%s of a nullable that is present", code: `const x: string | undefined = "here";\nconsole.log("[%s]", x);` },
  { name: "%s of a nullable that is undefined", code: `let x: string | undefined = "here";\nx = undefined;\nconsole.log("[%s]", x);` },
  { name: "%d of a nullable number", code: `let x: number | null = 5;\nconsole.log("%d", x);\nx = null;\nconsole.log("%d", x);` },
  { name: "%s of a JSON.parse scalar", code: `console.log("%s", JSON.parse('"txt"'));` },
  { name: "%s of a JSON.parse object cuts at depth 0", code: `console.log("%s", JSON.parse('{"a":{"b":1}}'));` },
  { name: "%O of a JSON.parse object", code: `console.log("%O", JSON.parse('{"a":{"b":1}}'));` },
  { name: "%s of a Date", code: `console.log("%s", new Date(0));` },
  { name: "%j of a Date", code: `console.log("%j", new Date(0));` },
  { name: "%s of an array of objects", code: `console.log("%s", [{ a: 1 }, { a: 2 }]);` },
]);

describe("a conversion with no faithful form is refused, never approximated", () => {
  const M = `const m = new Map<string, number>().set("a", 1);\n`;
  test("%o of a compound (node's showHidden)", () => {
    expect(rejectCode(`console.log("%o", [1, 2, 3]);`)).toBe("NT1026");
  });
  test("%j of a Map", () => {
    expect(rejectCode(M + `console.log("%j", m);`)).toBe("NT1026");
  });
  test("%d of an array (ToPrimitive)", () => {
    expect(rejectCode(`console.log("%d", [1, 2]);`)).toBe("NT1026");
  });
  test("%f of an array", () => {
    expect(rejectCode(`console.log("%f", [1, 2]);`)).toBe("NT1026");
  });
  test("%s of a function value keeps the Stage 47 refusal", () => {
    expect(rejectCode(`const f = (x: number): number => x;\nconsole.log("%s", f);`)).toBe("NT1025");
  });
  test("%c of a function value is fine — the argument is discarded", () => {
    expect(rejectCode(`const f = (x: number): number => x;\nconsole.log("%c!", f);`)).toBe(null);
  });
  test("%d of a Map is node's NaN, not a refusal", () => {
    expect(rejectCode(M + `console.log("%d", m);`)).toBe(null);
  });
});

/* ------------------------------------------------------------------ *
 * 8. `console.log(u8)` — the old NT1016, now closed. node's typed-array
 *    layout IS the array layout with the length folded into the opening
 *    brace, so the Stage-47 builder renders it unchanged: grouped into
 *    right-aligned columns past six entries, `... n more items` past 100.
 * ------------------------------------------------------------------ */

differential("Uint8Array", [
  { name: "empty", code: `console.log(new Uint8Array(0));` },
  { name: "three bytes", code: `const u = new Uint8Array(3);\nu[0] = 1; u[1] = 2; u[2] = 3;\nconsole.log(u);` },
  { name: "six bytes stay on one line", code: `const u = new Uint8Array(6);\nfor (let i = 0; i < 6; i++) u[i] = i + 1;\nconsole.log(u);` },
  { name: "SEVEN bytes group into columns", code: `const u = new Uint8Array(7);\nfor (let i = 0; i < 7; i++) u[i] = i + 1;\nconsole.log(u);` },
  { name: "40 bytes, right-aligned columns", code: `const u = new Uint8Array(40);\nfor (let i = 0; i < 40; i++) u[i] = i;\nconsole.log(u);` },
  { name: "120 bytes — ... 20 more items", code: `const u = new Uint8Array(120);\nfor (let i = 0; i < 120; i++) u[i] = i;\nconsole.log(u);` },
  { name: "the TextEncoder result", code: `const u = new TextEncoder().encode("hi!");\nconsole.log(u);` },
  { name: "nested in an object", code: `const u = new Uint8Array(3);\nu[0] = 1; u[1] = 2; u[2] = 3;\nconsole.log({ b: u });` },
  { name: "below the depth cut it is [Uint8Array]", code: `const u = new Uint8Array(2);\nu[0] = 1; u[1] = 2;\nconsole.log({ a: { b: { c: u } } });` },
  { name: "%O of one", code: `const u = new Uint8Array(2);\nu[0] = 1; u[1] = 2;\nconsole.log("%O", u);` },
  { name: "on stderr", code: `const u = new Uint8Array(2);\nu[0] = 9; u[1] = 8;\nconsole.error(u);` },
]);

test("`%s` of a Uint8Array is refused — node prints String(u8), not the inspect form", () => {
  expect(rejectCode(`const u = new Uint8Array(2);\nconsole.log("%s", u);`)).toBe("NT1026");
});
test("a TextEncoder handle is still refused", () => {
  expect(rejectCode(`console.log(new TextEncoder());`)).toBe("NT1025");
});

/* ------------------------------------------------------------------ *
 * 9. Arguments are evaluated left to right, exactly once — including the
 *    one `%c` throws away.
 * ------------------------------------------------------------------ */

differential("evaluation order", [
  {
    name: "every argument is evaluated once, in order",
    code: `let n = 0;
function tick(label: string): string { n = n + 1; return label + n; }
console.log("%s %s", tick("a"), tick("b"), tick("c"));
console.log(n);`,
  },
  {
    name: "%c still evaluates the argument it discards",
    code: `let n = 0;
function tick(): number { n = n + 1; return n; }
console.log("%c%d", tick(), tick());
console.log(n);`,
  },
]);
