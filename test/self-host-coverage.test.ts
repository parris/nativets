/*
 * Self-hosting milestone SH0 — the coverage gradient over the compiler's OWN source.
 *
 * Today `nativets coverage src/*.ts` dies at parse time on ~line 10 of every file:
 * the module preamble (`#!` shebang, `import`/`export`, `type`/`interface` aliases,
 * regex literals) is outside the accepted single-file, module-less subset, so the
 * tool can't even tokenize far enough to say anything useful.
 *
 * SH0 teaches `coverage` a coverage-ONLY preprocess (`src/coverage-preprocess.ts`) that
 * survives that preamble, so it reaches a real FEATURE-level blocker histogram (NT1xxx
 * by frequency) — turning "self-hosting" from a Tier-0 wall into a measurable gradient.
 *
 * These tests pin the survival (coverage now REACHES analysis on the src modules) and
 * guard that ordinary-program coverage is unchanged by the preprocess.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { coverage } from "../src/coverage.ts";
import { preprocessForCoverage } from "../src/coverage-preprocess.ts";

const src = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const SRC_MODULES = [
  "ast.ts", "lexer.ts", "diagnostics.ts", "parser.ts", "checker.ts",
  "codegen.ts", "coverage.ts", "ownership.ts", "driver.ts", "cli.ts",
];

describe("SH0: coverage survives the compiler's own module syntax", () => {
  test("ast.ts — reaches deep analysis, not a Tier-0 parse death at ~line 10", () => {
    const r = coverage(src("ast.ts"));
    expect(r.parsed).toBe(true);
    // Before SH0 this was 0 (died on `type` at line 8). Now dozens of statements
    // are analyzed — proof we're well past the preamble.
    expect(r.statements).toBeGreaterThan(20);
  });

  test("lexer.ts — its `class` now surfaces the deferred-feature blocker NT1015 (SH3)", () => {
    const r = coverage(src("lexer.ts"));
    expect(r.parsed).toBe(true);
    expect(r.statements).toBeGreaterThan(0);
    // SH3 adds minimal classes (fields + constructor + methods), so `class` is no longer
    // a blanket NT1012. `class LexError extends Error {}` flows to the real parser, which
    // accepts the class shape but reports its still-deferred feature — inheritance — as
    // NT1015 (a real semantic blocker, not swallowed by a preamble parse error).
    expect(r.blockers.some((b) => b.code === "NT1015")).toBe(true);
    expect(r.blockers.some((b) => b.code === "NT1012")).toBe(false);
  });

  test("generic type arguments now PARSE + ERASE — no longer an NT1013 blocker (SH2)", () => {
    // codegen.ts is generic-heavy (`Extract<Expr, {...}>`, `Record<K,V>`, `Map<K,V>`).
    // SH2 makes generic type arguments parse and erase to a supported shape, so they no
    // longer die on/surface as NT1013 — the histogram advances past them to the next
    // real blocker (classes, etc.).
    const r = coverage(src("codegen.ts"));
    expect(r.parsed).toBe(true);
    expect(r.blockers.some((b) => b.code === "NT1013")).toBe(false);
  });

  test("every src module reaches analysis (no file dies on the module preamble)", () => {
    for (const f of SRC_MODULES) {
      const r = coverage(src(f));
      // parsed past the shebang/import/type/interface preamble into real statements.
      expect({ file: f, parsed: r.parsed }).toEqual({ file: f, parsed: true });
      expect({ file: f, gotStatements: r.statements > 0 }).toEqual({ file: f, gotStatements: true });
    }
  });
});

describe("SH0 preprocess: strips module/type surface, neutralizes lexer hazards", () => {
  test("shebang + import + regex + class are handled without a tokenizer crash", () => {
    const source = [
      "#!/usr/bin/env bun",
      `import { parse } from "./parser.ts";`,
      "import type { Ty } from './ast.ts';",
      "export type Alias = number;",
      "interface Shape { x: number; }",
      "class Box { }",
      `export const rx = /a\\.b/g.test("x");`,
      "export function f(n: number): number { return n + 1; }",
    ].join("\n");
    const pre = preprocessForCoverage(source);
    // Minimal classes now compile, so `class` is NO LONGER pre-stripped as an NT1012
    // blocker — it flows to the real parser as an ordinary statement (which handles it,
    // or surfaces the real next blocker NT1015 for a deferred class feature). Meanwhile
    // import/type/interface/shebang are still erased and the regex still neutralized.
    expect(pre.stripped.some((b) => b.code === "NT1012")).toBe(false);
    const joined = pre.statements.map((s) => s.text).join("\n");
    expect(joined).not.toContain("import");
    expect(joined).not.toContain("interface");
    expect(joined).toContain("class Box");
    expect(joined).toContain("function f");
    // regex literal was neutralized (no stray backslash reaches the real lexer).
    expect(joined).not.toContain("/a");
  });
});

describe("SH0 regression: ordinary-program coverage is unchanged", () => {
  test("a fully-supported program still reports compiles=true with no blockers", () => {
    const r = coverage(`function add(a: number, b: number): number { return a + b; } console.log(add(2, 3));`);
    expect(r.parsed).toBe(true);
    expect(r.compiles).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("a supported program using arrows/closures/optional-chaining is NOT flagged (Stages 13/21)", () => {
    const r = coverage(`const nums: number[] = [1, 2, 3]; const doubled = nums.map((x) => x * 2); console.log(doubled.length);`);
    expect(r.compiles).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("a rejected construct still surfaces its NT code (immutability reject preserved)", () => {
    const r = coverage(`const a: number[] = [1, 2]; a.push(3);`);
    expect(r.compiles).toBe(false);
    expect(r.firstError?.code).toBe("NT1606");
  });
});
