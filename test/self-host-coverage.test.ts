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
  "modules.ts", "coverage-preprocess.ts",
];

describe("SH0: coverage survives the compiler's own module syntax", () => {
  test("ast.ts — reaches deep analysis, not a Tier-0 parse death at ~line 10", () => {
    const r = coverage(src("ast.ts"));
    expect(r.parsed).toBe(true);
    // Before SH0 this was 0 (died on `type` at line 8). Now dozens of statements
    // are analyzed — proof we're well past the preamble.
    expect(r.statements).toBeGreaterThan(20);
  });

  test("lexer.ts — `class LexError extends Error {}` now COMPILES (SH3.5, extends-Error)", () => {
    const r = coverage(src("lexer.ts"));
    expect(r.parsed).toBe(true);
    expect(r.statements).toBeGreaterThan(0);
    // SH3 added minimal classes (fields + constructor + methods) so `class` is no longer a
    // blanket NT1012; SH3.5 adds `extends Error` (+ access modifiers + parameter properties),
    // so lexer's `class LexError extends Error {}` no longer surfaces an NT1015 inheritance
    // blocker at all — the class fully parses/typechecks (any remaining blocker is elsewhere).
    expect(r.blockers.some((b) => b.code === "NT1012")).toBe(false);
    expect(r.blockers.some((b) => b.code === "NT1015")).toBe(false);
  });

  test("parser.ts — SH3.6 cleared the class field-initializer NT1015; M3 cleared NT1013", () => {
    // SH3.5 cleared modifier/extends NT1015; SH3.6 then cleared class *field initializers*
    // (`private pos = 0;`). M3 (monomorphization) then cleared the NT1013 that stood behind
    // them — see the whole-tree assertion below for why that NT1013 was never real.
    const r = coverage(src("parser.ts"));
    expect(r.parsed).toBe(true);
    expect(r.blockers.some((b) => b.code === "NT1015")).toBe(false);
    expect(r.blockers.some((b) => b.code === "NT1012")).toBe(false);
    expect(r.blockers.some((b) => b.code === "NT1013")).toBe(false);
  });

  test("generics are no longer a self-host blocker anywhere in src/ (M3)", () => {
    // SH2 made generic type ARGUMENTS erase; M3 makes generic FUNCTION DEFINITIONS
    // monomorphize. Re-measured after M3, NO src module reports an NT1013 — and the ones
    // that used to were MISATTRIBUTIONS: `coverage` re-labelled any unparsed statement whose
    // text matched `Name<…>` as "generic type arguments", so `class Parser { … this.pos++ }`
    // and `async function guard<T>` (blocked on `await`) both showed up as generics. That
    // heuristic is gone (see `classifyParseFailure`), so this assertion is now meaningful.
    for (const f of SRC_MODULES) {
      const r = coverage(src(f));
      const nt1013 = r.blockers.filter((b) => b.code === "NT1013");
      expect({ file: f, nt1013 }).toEqual({ file: f, nt1013: [] });
    }
  });

  test("generic FUNCTION DEFINITIONS compile — one specialization per instantiation (M3)", () => {
    // The capability itself, on a focused snippet: a generic used at two different types,
    // inference through an array parameter, and explicit call-site type args.
    const r = coverage(
      "const m = new Map<string, number>();\n" +
      "const s = new Set<number>();\n" +
      "function id<T>(x: T): T { return x; }\n" +
      "function first<T>(xs: T[]): T { return xs[0]; }\n" +
      "const ns: number[] = [1, 2];\n" +
      "console.log(id(3) + first(ns));\n" +
      "console.log(id<string>(\"a\") + id(\"b\"));\n"
    );
    expect(r.parsed).toBe(true);
    expect(r.compiles).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("NT0001 is CLEARED across the whole tree — no unparsed statement remains", () => {
    // The NT0001 "unparsed statement" bucket was the #1 self-host blocker at x11 once
    // Stage 36 cleared NT1013. It was never one feature; the six causes were extracted
    // from real statements and closed one at a time (see test/selfhost-parse.test.ts):
    // paren-vs-arrow lookahead, nested template literals, radix/separator numeric
    // literals, `++`/`--` on a member or index target, `instanceof`, binding patterns in
    // parameters — plus parenthesized types and `delete`. Whole tree: ZERO.
    //
    // The bucket is now EMPTY. The last two entries were both blockers an earlier
    // burn-down had unmasked, and each left the bucket a different way:
    //   - `parser.ts`: the mutable-records lane put `//@@mutable` on `class Parser`, so it
    //     parsed past `this.pos++` and reached `… satisfies ExportTable`. The `satisfies`
    //     lane implemented the operator, so that statement PARSES now — genuinely gone.
    //   - `checker.ts`: `t.replace(/[^A-Za-z0-9_]/g, "_")`. Regex literals now LEX and are
    //     refused as **NT1027**, so that blocker is named (with its pattern and position)
    //     instead of being an anonymous "unparsed statement" — it moved buckets, it did
    //     not go away. See the NT1027 row in the histogram test below.
    //
    // An empty NT0001 bucket is the meaningful invariant: every remaining blocker in the
    // tree is a NAMED feature with a code, so it can be burned down deliberately.
    const UNMASKED: Record<string, number> = {};
    for (const f of SRC_MODULES) {
      const r = coverage(src(f));
      const nt0001 = r.blockers.filter((b) => b.code === "NT0001").length;
      expect({ file: f, nt0001 }).toEqual({ file: f, nt0001: UNMASKED[f] ?? 0 });
    }
  });

  test("NT1606 field mutation is DOWN to one: `delete o.k`, the one `@@mutable` refuses", () => {
    // Before the mutable-records lane this was the #1 blocker at x8: `o.f = v` / `o.f++`
    // on a value the compiler treats as a plain record (objects are immutable since Stage
    // 29). Three of those were class-field mutations, cleared by putting `@@mutable` on
    // `Parser`/`FnGen`/`Analyzer` — in the `//@@mutable` PRAGMA spelling, because this
    // source must satisfy bun AND nativets at once. Five were plain-RECORD mutations
    // (`s.returnTy = ret`), cleared by extending `@@mutable` to `type`/`interface`.
    //
    // The one that remains is `delete o.k` in `specializeDecl`, and it is deliberate: a
    // record's SHAPE is its type here (fields are static slots), so removing a key is a
    // different feature from assigning one. It is refused with that in the hint.
    const nt1606: { file: string; feature: string }[] = [];
    for (const f of SRC_MODULES) {
      for (const b of coverage(src(f)).blockers) if (b.code === "NT1606") nt1606.push({ file: f, feature: b.feature });
    }
    expect(nt1606.length).toBe(1);
    expect(nt1606[0]!.file).toBe("checker.ts");
    expect(nt1606[0]!.feature).toContain("delete o.k");
  });

  test("the re-measured frontier: no single code dominates any more", () => {
    // The histogram now also counts a FEATURE blocker the CHECKER reports (NT1xxx only —
    // see src/coverage.ts). Without that, moving a rejection from the parser to the
    // checker (which is exactly what `o.f = v` did when `@@mutable` records arrived) would
    // have looked like the blocker vanishing. So this list is bigger than the pre-lane one
    // and, unlike it, is not parse-stage-only.
    const hist = new Map<string, number>();
    for (const f of SRC_MODULES) {
      for (const b of coverage(src(f)).blockers) hist.set(b.code, (hist.get(b.code) ?? 0) + b.count);
    }
    // NT1027 (a regex literal) is new only as a NAME: it was inside the NT0001 bucket
    // until regex literals started lexing. Naming it is what makes it burnable-down.
    // NT0001 itself is no longer on this list at all — see the test above.
    expect([...hist.keys()].sort()).toEqual(["NT1003", "NT1009", "NT1014", "NT1015", "NT1027", "NT1606"]);
    // NT1606 is no longer the largest bucket — that is the lane's whole result.
    for (const [code, n] of hist) if (code !== "NT1606") expect(n).toBeGreaterThanOrEqual(hist.get("NT1606")!);
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
