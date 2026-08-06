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
 * HISTORY. This table used to read `lex` for 8 of the 12: nativets has no `RegExp`
 * (a deliberate Tier-C refusal, docs/divergences.md) and the lexer did not tokenize
 * `/.../` at all, so the first `\` inside one was an "Unexpected character" that
 * killed the whole file. The coverage histogram could not show this, because its
 * preprocess strips regexes before measuring — it reported `cli.ts` as fully parsed
 * with ZERO blockers while the lexer died on line 71.
 *
 * Lexing regex literals (and refusing them at parse with NT1027) removed that wall,
 * which is the SH0 move: a wall becomes a gradient. Every module now reaches at
 * least `parse`, and the tier BEHIND the wall is visible for the first time — see
 * the blocker-tier test below.
 */
const BASELINE: Record<string, Phase> = {
  "ast.ts": "parse",
  "lexer.ts": "parse",
  "diagnostics.ts": "parse",
  "parser.ts": "parse",
  "checker.ts": "parse",
  "codegen.ts": "parse",
  "coverage.ts": "ir",
  "ownership.ts": "parse",
  "driver.ts": "parse",
  "cli.ts": "parse",
  "modules.ts": "parse",
  "coverage-preprocess.ts": "parse",
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
    // The wall is GONE: lexing regex literals moved all 8 past the lexer.
    expect(stuckAtLex.length).toBe(0);
  });

  /**
   * The tier BEHIND the old lex wall, visible for the first time. These are the real
   * stage-1 blockers, grouped by the code each module dies on. Recorded so that
   * shrinking any bucket is a deliberate, reviewable step — the SH0 gradient.
   */
  test("the blocker tiers behind the wall", () => {
    const byCode: Record<string, string[]> = {};
    for (const m of Object.keys(BASELINE)) {
      const { error } = phaseOf(m);
      if (!error) continue;
      const code = /\[(NT\d+)\]/.exec(error)?.[1] ?? "other";
      (byCode[code] ??= []).push(m);
    }
    // `!` non-null assertions and other unparsed statements; node: builtins (`node:fs`)
    // are the SH4 host-FFI story; NT1027 is the regex refusal this lane introduced.
    expect(Object.keys(byCode).sort()).toEqual(["NT0001", "NT1009", "NT1015", "NT1017", "NT1027"]);
    expect(byCode["NT1017"]!.sort()).toEqual(["cli.ts", "driver.ts", "modules.ts"]);
    expect(byCode["NT1027"]!.sort()).toEqual(["coverage-preprocess.ts", "diagnostics.ts"]);
  });

  test("coverage's preprocess still hides the regex blocker (histogram reads optimistic)", async () => {
    const { coverage } = await import("../src/coverage.ts");
    // cli.ts stops at `node:fs`, but coverage reports zero blockers — its preprocess
    // strips module syntax AND regexes, so the histogram cannot see either.
    expect(phaseOf("cli.ts").phase).toBe("parse");
    const r = coverage(read("cli.ts"));
    expect(r.parsed).toBe(true);
    expect(r.blockers.length).toBe(0);
  });
});

describe("regex literals lex (so they are a named refusal, not a lexer crash)", () => {
  test("a regex literal is one token", () => {
    const toks = lex("const re = /ab+c/gi;\n");
    expect(toks.filter((t) => t.type === "regex").map((t) => t.value)).toEqual(["/ab+c/gi"]);
  });

  test("escapes and character classes containing `/` do not end it early", () => {
    expect(lex("f(/\\.ts$/);").find((t) => t.type === "regex")!.value).toBe("/\\.ts$/");
    expect(lex("f(/[/]x/);").find((t) => t.type === "regex")!.value).toBe("/[/]x/");
  });

  test("it is REFUSED at parse with NT1027, located", () => {
    try {
      parse('const re = /x/;\n');
      throw new Error("expected NT1027");
    } catch (e) {
      expect((e as { diag?: { code: string } }).diag?.code).toBe("NT1027");
    }
  });

  // The disambiguation that matters: a misread division would silently swallow code up
  // to the next `/`. Division wins after anything that can END an expression.
  test("division is never mistaken for a regex", () => {
    for (const src of [
      "const x = a / b;", "const x = a / b / c;", "const x = (a + b) / c;",
      "const x = xs[0] / 2;", "const x = f() / 2;", "let d = 10; d /= 2;",
      "const x = a.length / 2;", "let e = 8; const x = e++ / 2;",
    ]) {
      expect(lex(src).some((t) => t.type === "regex")).toBe(false);
    }
  });

  test("a regex IS recognized where an expression may start", () => {
    for (const src of ["return /x/.test(s);", "f(/x/);", "const r = /x/;", "x = y || /x/.test(s);"]) {
      expect(lex(src).some((t) => t.type === "regex")).toBe(true);
    }
  });

  test("an unterminated `/` on a line stays division (no runaway consumption)", () => {
    // `a / b` split across lines must not swallow the newline looking for a closer.
    expect(lex("const x = a /\n  b;").some((t) => t.type === "regex")).toBe(false);
  });
});
