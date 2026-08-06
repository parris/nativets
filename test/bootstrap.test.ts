/*
 * SH0 — the 3-stage BOOTSTRAP harness (self-hosting, measured).
 *
 * `docs/self-hosting.md` calls for standing this up "initially expected-to-fail".
 * Until now nothing did, so "how close is self-hosting?" was answered only by
 * `nativets coverage src/*.ts` — and that answer is MISLEADING. Coverage runs a
 * coverage-ONLY preprocess (`src/coverage-preprocess.ts`) that strips the module
 * preamble and regex literals so it can reach a feature histogram; it therefore
 * reports `parsed: true` and a dozen-ish blockers for modules that in reality do
 * not survive the LEXER.
 *
 * This file measures the real thing: the compiler's own pipeline, unpreprocessed.
 *
 * ---- Definition of done (docs/self-hosting.md) ----
 *   stage-1: `bun` runs the TS compiler, compiling src/ -> nativets-1 (native)
 *   stage-2: nativets-1 compiles src/ -> nativets-2
 *   stage-3: nativets-2 compiles src/ -> nativets-3
 * Self-hosted when nativets-2 and nativets-3 are BYTE-IDENTICAL (the classic fixed
 * point) and the differential suite passes when compiled by nativets-2.
 *
 * ---- What this file asserts today ----
 * Stage-1 does not build yet, so the gate is a RATCHET, in the same spirit as the
 * conformance corpora's minimum-supported count: each module's furthest pipeline
 * phase is recorded, and the test fails if any module goes BACKWARDS. Progress
 * shows up as a deliberate baseline update, and a new blocker introduced by new
 * compiler code is caught immediately — the "keeping the gap from growing" lint
 * that docs/self-hosting.md asks for.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

import { lex } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { sourceToIR } from "../src/driver.ts";

const SRC = new URL("../src/", import.meta.url);
const read = (m: string) => readFileSync(new URL(m, SRC), "utf8");

/** Pipeline phases, in order. A module's score is how far it gets. */
const PHASES = ["lex", "parse", "ir"] as const;
type Phase = (typeof PHASES)[number];
const rank = (p: Phase) => PHASES.indexOf(p);

/** The furthest phase `module` survives, plus the first error that stopped it. */
function phaseOf(module: string): { phase: Phase; error: string } {
  const source = read(module);
  try {
    lex(source);
  } catch (e) {
    return { phase: "lex", error: msg(e) };
  }
  try {
    parse(source);
  } catch (e) {
    return { phase: "parse", error: msg(e) };
  }
  try {
    // The whole-program link + check + ownership + codegen, entered at this module.
    sourceToIR(source, new URL(module, SRC).pathname);
  } catch (e) {
    return { phase: "ir", error: msg(e) };
  }
  return { phase: "ir", error: "" };
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.trim();

/**
 * BASELINE — the furthest phase each module reaches today. `lex` means it does not
 * even tokenize; `ir` with no error would mean it produced LLVM IR.
 *
 * The dominant blocker is REGEX LITERALS: nativets has no `RegExp` (a deliberate
 * Tier-C refusal, docs/divergences.md), and the lexer does not tokenize `/.../` at
 * all, so the first `\` inside one is an "Unexpected character". That is what stops
 * 8 of these 12 modules — a fact the coverage histogram cannot show, because its
 * preprocess removes regexes before measuring.
 */
const BASELINE: Record<string, Phase> = {
  "ast.ts": "lex",
  "lexer.ts": "lex",
  "diagnostics.ts": "lex",
  "parser.ts": "parse",
  "checker.ts": "parse",
  "codegen.ts": "parse",
  "coverage.ts": "ir",
  "ownership.ts": "lex",
  "driver.ts": "lex",
  "cli.ts": "lex",
  "modules.ts": "lex",
  "coverage-preprocess.ts": "lex",
};

describe("SH0: bootstrap frontier (ratchet — a module may improve, never regress)", () => {
  for (const [module, floor] of Object.entries(BASELINE)) {
    test(`${module} reaches at least '${floor}'`, () => {
      const { phase, error } = phaseOf(module);
      // A regression is a hard failure; the error text is surfaced so the cause is
      // in the output rather than requiring a re-run.
      expect(
        rank(phase) >= rank(floor) ? "ok" : `${module} REGRESSED to '${phase}': ${error}`,
      ).toBe("ok");
    });
  }

  test("the whole compiler does not self-compile yet (expected-to-fail; flip when it does)", () => {
    // stage-1 entered at the real CLI entry point, whose import graph pulls in every
    // module. When this stops throwing, self-hosting stage-1 is reached and this test
    // — and the BASELINE above — should be replaced by the real 3-stage fixed point.
    expect(() => sourceToIR(read("cli.ts"), new URL("cli.ts", SRC).pathname)).toThrow();
  });
});

describe("SH1 tail: an executable script lexes", () => {
  // `#!/usr/bin/env bun` heads our own cli.ts. A hashbang is not JavaScript — it is
  // TC39 "HashbangComment", which every engine strips — so it must not tokenize.
  test("a `#!` shebang on line 1 is skipped", () => {
    expect(() => lex('#!/usr/bin/env bun\nconsole.log("ok");\n')).not.toThrow();
    const toks = lex('#!/usr/bin/env node\nconst a = 1;\n');
    expect(toks.some((t) => t.value === "const")).toBe(true);
  });

  test("`#` anywhere else is still an error", () => {
    expect(() => lex('const a = 1;\n#!not a shebang\n')).toThrow();
  });

  test("a shebang does not shift reported line numbers", () => {
    // The skip runs through `advance`, so line/col stay truthful for diagnostics.
    const toks = lex("#!/usr/bin/env bun\nconst a = 1;\n");
    expect(toks.find((t) => t.value === "const")!.line).toBe(2);
  });
});

describe("SH0: what actually blocks stage-1, measured (not the coverage heuristic)", () => {
  test("regex literals are the dominant blocker — 8 of 12 modules die in the LEXER", () => {
    const stuckAtLex = Object.keys(BASELINE).filter((m) => phaseOf(m).phase === "lex");
    // Every one of these fails on the same construct.
    for (const m of stuckAtLex) {
      expect(phaseOf(m).error).toContain("Unexpected character");
    }
    // Recorded, so that shrinking this set is a visible, deliberate step.
    expect(stuckAtLex.length).toBe(8);
  });

  test("coverage's preprocess HIDES that wall (why the histogram reads optimistic)", async () => {
    const { coverage } = await import("../src/coverage.ts");
    // cli.ts does not survive the lexer, yet coverage reports it as fully parsed with
    // zero blockers — because the preprocess strips the regex literal first.
    expect(phaseOf("cli.ts").phase).toBe("lex");
    const r = coverage(read("cli.ts"));
    expect(r.parsed).toBe(true);
    expect(r.blockers.length).toBe(0);
  });
});
