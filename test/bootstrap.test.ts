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

/**
 * Pipeline phases a module can COMPLETE, in order. A module's score is the last one
 * it finished — so `lexed` means it tokenized and then failed to parse, and `ir` means
 * `sourceToIR` RETURNED. `ir` is exactly SH6 rung 1 (test/sh6.test.ts), which carries
 * the same measurement further (rung 2 links, rung 3 differentials against bun).
 *
 * The scale used to be failure-POINT named (`lex`/`parse`/`ir`) and its top rung was
 * unreachable-by-failure: see the "phase scale itself is honest" tests below.
 */
const PHASES = ["none", "lexed", "parsed", "ir"] as const;
type Phase = (typeof PHASES)[number];
const rank = (p: Phase) => PHASES.indexOf(p);

/** The furthest phase `module` completes, plus the first error that stopped it. */
function phaseOf(module: string): { phase: Phase; error: string } {
  const source = read(module);
  try {
    lex(source);
  } catch (e) {
    return { phase: "none", error: msg(e) };
  }
  try {
    parse(source);
  } catch (e) {
    return { phase: "lexed", error: msg(e) };
  }
  try {
    // The whole-program link + check + ownership + codegen, entered at this module.
    sourceToIR(source, new URL(module, SRC).pathname);
  } catch (e) {
    return { phase: "parsed", error: msg(e) };
  }
  return { phase: "ir", error: "" };
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.trim();

/**
 * BASELINE — the furthest phase each module completes today. `none` means it does not
 * even tokenize; `ir` means it produced LLVM IR.
 *
 * NOTHING IS AT `ir`. Not one of the twelve modules produces IR, and the five rows that
 * used to claim it were an artifact of the broken top rung, not progress. Read this
 * table as "how far short", never as "how far along".
 *
 * HISTORY. This table used to read `none` for 8 of the 12: nativets has no `RegExp`
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
  "ast.ts": "lexed",
  // RATCHET MOVE (regex removal): the scanner's seven character-class regexes are now
  // spelled-out predicates. lexer.ts parses and stops in the checker on NT1014 — `new
  // Set([...])` for REGEX_AFTER_KEYWORD, which predates this change and was masked by it.
  "lexer.ts": "parsed",
  // RATCHET MOVE (regex removal): `formatDiagnostic`'s `^\s*` was the module's first
  // blocker. Rewritten as a character scan, it now parses and stops on the next thing
  // behind it — NT2001, `diag.spans.length` in `!diag.spans || diag.spans.length === 0`,
  // i.e. nullable narrowing does not flow across `||`.
  "diagnostics.ts": "parsed",
  "parser.ts": "lexed",
  "checker.ts": "lexed",
  "codegen.ts": "lexed",
  "coverage.ts": "parsed",
  // RATCHET MOVE (regex removal): `/\$inner$/` was ownership.ts's first blocker. Now it
  // lexes and parses, and stops where the whole-program link takes it — NT1009, the
  // scalar union in checker.ts, i.e. the same crux as checker.ts itself.
  "ownership.ts": "parsed",
  "driver.ts": "lexed",
  "cli.ts": "lexed",
  "modules.ts": "lexed",
  // RATCHET MOVE (regex removal): the coverage preprocess is itself now regex-free, so
  // the module whose job is to make `src/` measurable is measurable too. It parses and
  // stops on the SAME NT0001 as ast.ts — the template-literal TYPE — which it sees
  // through the whole-program link.
  "coverage-preprocess.ts": "parsed",
};

describe("the phase scale itself is honest", () => {
  /*
   * REGRESSION. `phaseOf` used to return `phase: "ir"` on BOTH branches of its last
   * try/catch — the catch AND the success path — so its top rung could not tell
   * "produced LLVM IR" from "entered the IR pipeline and threw". Every module that
   * merely lexed and parsed scored `ir`, the BASELINE below recorded `ir` for five of
   * them, and docs/self-hosting.md then repeated that as "coverage.ts reaches IR".
   * None of them reach IR. Nothing reaches IR.
   *
   * The scale is now COMPLETED phases, which is what "furthest phase reached" always
   * meant to a reader: a module scores `parsed` when it parsed and then failed, and
   * scores `ir` only when `sourceToIR` RETURNED. `ir` here is exactly SH6 rung 1
   * (test/sh6.test.ts) — one vocabulary, two granularities, no third opinion.
   */
  test("`ir` means sourceToIR returned, and carries no error", () => {
    for (const module of Object.keys(BASELINE)) {
      const { phase, error } = phaseOf(module);
      expect(phase === "ir" ? error : "").toBe("");
    }
  });

  test("a module that throws inside sourceToIR does not score `ir`", () => {
    // diagnostics.ts lexes and parses, then dies in the checker. Under the old scale
    // it scored `ir`; the honest answer is `parsed`.
    const { phase, error } = phaseOf("diagnostics.ts");
    expect(phase).toBe("parsed");
    expect(error).toContain("NT");
  });
});

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
    const stuckAtLex = Object.keys(BASELINE).filter((m) => phaseOf(m).phase === "none");
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
    // NT1017 (`node:fs`) is the SH4 host-FFI story; NT1027 is the regex refusal; the
    // NT0001 survivors are a template-literal TYPE (`\`${string}[]\`` in ast.ts, which
    // coverage.ts sees through the link) and `satisfies` in parser.ts.
    expect(Object.keys(byCode).sort()).toEqual(
      ["NT0001", "NT1009", "NT1014", "NT1015", "NT1017", "NT2001"],
    );
    // MEASURED AFTER THE MERGE, not carried over from either branch: SH4 landed between
    // this lane's base and here, so `modules.ts` is past the host FFI and stops on
    // NT1015 instead. driver.ts's NT1017 is a DIFFERENT one — the bun text-asset import
    // `import runtimeSource from "…/runtime.c" with {type:"text"}`, a bundler feature
    // rather than a `node:` module, and an open SH7 question (the self-hosted compiler
    // still has to embed its runtime somehow).
    expect(byCode["NT1017"]!.sort()).toEqual(["cli.ts", "driver.ts"]);
    // Unmasked by the lexer rewrite: `new Set([...])` for REGEX_AFTER_KEYWORD.
    expect(byCode["NT1014"]!.sort()).toEqual(["lexer.ts"]);
    // NT1027 grew from 2 modules to 4 when `!` stopped blocking lexer.ts and ownership.ts:
    // clearing a blocker UNMASKS what sat behind it. The count going up is the ratchet
    // working, not a regression — the phase table above is what must never go backwards.
    // NT1027 is now GONE: every regex the compiler's own source used has been rewritten
    // as character scanning (nativets has no RegExp, so its source may not use one).
    // `test/no-regex.test.ts` is the shrink-only lint that keeps it that way.
    expect(byCode["NT1027"]).toBeUndefined();
    expect(byCode["NT1009"]!.sort()).toEqual(["checker.ts", "ownership.ts"]);
    // Unmasked by that rewrite: diagnostics.ts now gets all the way to the checker.
    expect(byCode["NT2001"]!.sort()).toEqual(["diagnostics.ts"]);
    expect(byCode["NT0001"]!.sort()).toEqual(
      ["ast.ts", "coverage-preprocess.ts", "coverage.ts", "parser.ts"],
    );
  });

  test("coverage's preprocess still hides the regex blocker (histogram reads optimistic)", async () => {
    const { coverage } = await import("../src/coverage.ts");
    // The enduring claim, stated so it survives the frontier moving: coverage reports
    // cli.ts as CLEAN — parsed, zero blockers — while the real pipeline still refuses it.
    // Its preprocess strips module syntax (and, before the removal, regexes), so the
    // histogram cannot see what actually stops the module.
    //
    // Deliberately NOT asserted here: which phase cli.ts reaches, or which code stops it.
    // Both move as blockers clear (SH4 pushed cli.ts past `node:fs` and therefore past
    // parse), and an assertion on them makes this test fail for the *good* reason —
    // progress — which trains people to edit it rather than read it. The gap between
    // "coverage says clean" and "the compiler refuses it" is the invariant.
    const r = coverage(read("cli.ts"));
    expect(r.parsed).toBe(true);
    expect(r.blockers.length).toBe(0);
    expect(() => sourceToIR(read("cli.ts"), new URL("cli.ts", SRC).pathname)).toThrow();
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

  // BORROWED: tc39/test262 test/language/literals/regexp/7.8.5-1.js — "A
  // RegularExpressionBackslashSequence may not contain a LineTerminator." Skipping the
  // escaped character blindly scanned straight past the newline and swallowed the next
  // line; test262 found that, a hand-written case would not have.
  test("test262 7.8.5-1: a backslash sequence may not contain a line terminator", () => {
    expect(() => lex("const a = /\\\n n/;")).toThrow();
  });

  // BORROWED: tc39/test262 test/language/literals/regexp/S7.8.5_A2.1_T1.js — patterns
  // that are legal and must lex as ONE token (spaces, punctuation, unicode escapes).
  test("test262 S7.8.5_A2.1_T1: ordinary patterns lex as one token", () => {
    for (const [src, want] of [
      ["const a = /aa/;", "/aa/"],
      ["const a = /,;/;", "/,;/"],
      ["const a = /  /;", "/  /"],
      ["const a = /a\\u0041/;", "/a\\u0041/"],
    ] as const) {
      expect(lex(src).find((t) => t.type === "regex")!.value).toBe(want);
    }
  });

  test("an unterminated `/` on a line stays division (no runaway consumption)", () => {
    // `a / b` split across lines must not swallow the newline looking for a closer.
    expect(lex("const x = a /\n  b;").some((t) => t.type === "regex")).toBe(false);
  });
});

describe("postfix `!` — TypeScript's non-null assertion", () => {
  // node/tsc ERASE `!`, so every accepted case here is node-differential: the same
  // source runs unchanged under node.
  test("it parses in every postfix position", () => {
    for (const src of [
      "const a = xs[0]!;", "const a = o.f!;", "const a = o!.f;",
      "const a = f()!;", "const a = xs[0]![1]!;", "const a = m.get(k)!.length;",
    ]) expect(() => parse(src)).not.toThrow();
  });

  test("it does not disturb prefix `!`, `!=` or `!==`", () => {
    for (const src of ["const a = !b;", "const a = !!b;", "const a = x != y;", "const a = x !== y;"]) {
      expect(() => parse(src)).not.toThrow();
    }
  });

  // TypeScript forbids a line terminator before `!`, so this stays two statements
  // rather than silently becoming `a!b.c()`.
  test("a newline before `!` is NOT a postfix assertion", () => {
    expect(() => parse("const a = b\n!c;")).toThrow();
  });
});

/*
 * BORROWED CORPUS — the TypeScript conformance suite (microsoft/TypeScript,
 * tests/cases/compiler/). CLAUDE.md's rule is to mine the reference's suite rather than
 * invent cases; these are its actual non-null-assertion tests, mapped to node-runnable
 * nativets source. node ERASES `!`, so node remains the byte-for-byte oracle.
 *
 * Mining these immediately found two shapes the hand-written cases missed —
 * `x!++` and `m! && m[0]` — both recorded below.
 */
describe("borrowed: TypeScript conformance non-null assertion cases", () => {
  test("nonNullReferenceMatching.ts — `!` mid-chain, parenthesized, and on a paren expr", () => {
    for (const src of [
      "const a = o.b!.c;",            // this.props.thumbYProps!.elementRef
      "const a = (o.b!.c);",          // (this.props.thumbYProps!.elementRef)
      "const a = ((o).b!.c)!;",       // ((this.props).thumbYProps!.elementRef)!
    ]) expect(() => parse(src)).not.toThrow();
  });

  test("nonNullFullInference.ts — `last!;` stands alone as an expression statement", () => {
    expect(() => parse("let last = 1;\nlast;\nlast!;")).not.toThrow();
  });

  test("nonnullAssertionPropegatesContextualType.ts — `f(...)!` into a typed binding", () => {
    expect(() => parse('const r: number = m.get("k")!;')).not.toThrow();
  });

  // constWithNonNull.ts is `x!++`. `!` yields a VALUE, not an lvalue, so incrementing
  // THROUGH an assertion has no meaning here. It is refused at parse — a located error,
  // never a miscompile — and recorded so the refusal is deliberate rather than accidental.
  test("constWithNonNull.ts — `x!++` is REFUSED, not miscompiled", () => {
    expect(() => parse("let x = 1;\nx!++;")).toThrow();
  });

  // narrowingWithNonNullExpression.ts asserts `m!` narrows m for the REST of the
  // expression (`m! && m[0]`). nativets narrows the EXPRESSION, not the binding — it has
  // no control-flow narrowing — so the second `m` is still nullable. `m![0]` is the
  // working spelling. Recorded as a known gap, not silently passed.
  test("narrowingWithNonNullExpression.ts — `!` does NOT narrow later uses (known gap)", () => {
    expect(() => parse("const a = m! && m[0];")).not.toThrow(); // parses
    // but the second `m` keeps its nullable type — see docs/self-hosting.md.
  });
});
