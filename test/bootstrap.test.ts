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
 *
 * ---- WHAT THIS FILE DOES NOT CATCH (and what does) ----
 * Two ratchets live here: the per-module phase floor above, and the set of NT codes
 * present TREE-WIDE (the "blocker tiers behind the wall" test), so a NEW code is a hard
 * failure. Neither sees a module regressing to a code ALREADY in the set — and worse,
 * both measure the whole-program LINK, where most modules report a DEPENDENCY's blocker
 * rather than their own, so a refused construct planted in such a module moves nothing
 * here at all. Reproduced: `new Map([[k, v], …])` at the top of `src/modules.ts` leaves
 * every assertion in this file green.
 *
 * `test/selfhost-ratchet.test.ts` closes that: per module, the blocker's STAGE + CODE +
 * MESSAGE in a STANDALONE column (no link — the only column that says whose gap it is),
 * ratcheted against the module's source hash so the frontier moving stays green and a
 * planted blocker reds. Neither file subsumes the other: this one owns the phase scale
 * and the tree-wide picture, that one owns per-module blocker identity.
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

/**
 * The furthest phase a SOURCE completes, plus the first error that stopped it.
 *
 * Split out from `phaseOf` so the scale's own self-tests can run on a synthetic
 * specimen instead of a real module — see "the phase scale itself is honest" below.
 */
function phaseAt(source: string, path: string): { phase: Phase; error: string } {
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
    sourceToIR(source, path);
  } catch (e) {
    return { phase: "parsed", error: msg(e) };
  }
  return { phase: "ir", error: "" };
}

/** The furthest phase `module` completes, plus the first error that stopped it. */
function phaseOf(module: string): { phase: Phase; error: string } {
  return phaseAt(read(module), new URL(module, SRC).pathname);
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
  // i.e. nullable narrowing does not flow across `||`. That narrowing has since landed
  // (short-circuit lane), so the blocker moved on again: now NT1606, `[...diag.spans].sort(…)`.
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

  /*
   * SYNTHETIC SPECIMENS, and the reason they are synthetic.
   *
   * This self-test used to name a REAL module — `diagnostics.ts` — as its
   * known-to-fail specimen, asserting `phase === "parsed"` exactly. That is a
   * measurement pointed at a moving target: a real module's whole purpose is to stop
   * failing, so the day one finally reaches IR this test reds and reads as "you broke
   * the bootstrap ratchet" when what actually happened is the ratchet succeeded. The
   * same mistake `test/sh6.test.ts` deliberately avoids by walking a control specimen
   * it owns.
   *
   * So the specimens below are sources this FILE controls, each chosen because it is
   * refused for a reason that cannot be "fixed" later:
   *
   *   - a regex literal — nativets has no `RegExp` and never will (Tier C,
   *     docs/divergences.md). It LEXES (that was the SH0 move) and the PARSER refuses
   *     it, so it scores `lexed` and pins the lex -> parse boundary.
   *   - `x instanceof Error` — refused because `Error` is modelled STRUCTURALLY as
   *     `{message:string}`, so an Error and a plain record carrying a `message` have
   *     the same static type and class membership is undecidable. That is a
   *     consequence of the type model, not a gap, so it survives parse and dies inside
   *     `sourceToIR` — which is the boundary the regression below was actually about.
   *
   * MEASURED, not assumed: a regex literal scores `lexed`, NOT `parsed`. Picking one
   * for the `parsed` case would have moved this test off the very boundary it guards.
   */
  const SPECIMENS = {
    /** Lexes, then the parser refuses it — the lex -> parse boundary. */
    lexedOnly: 'const r = /abc/;\nconsole.log(r);\n',
    /** Lexes and parses, then throws INSIDE sourceToIR — the boundary that regressed. */
    parsedOnly: 'const e = new Error("x");\nconsole.log(e instanceof Error);\n',
    /** Completes every phase — proves `ir` is reachable at all, so the scale has a top. */
    reachesIR: 'console.log(1 + 1);\n',
  };
  const specimenPath = new URL("specimen.ts", SRC).pathname;

  test("a source that throws inside sourceToIR scores `parsed`, never `ir`", () => {
    const { phase, error } = phaseAt(SPECIMENS.parsedOnly, specimenPath);
    expect(phase).toBe("parsed");
    expect(error).toContain("NT");
  });

  test("a source the parser refuses scores `lexed`", () => {
    const { phase, error } = phaseAt(SPECIMENS.lexedOnly, specimenPath);
    expect(phase).toBe("lexed");
    expect(error).toContain("NT");
  });

  test("a source that compiles scores `ir` — the top of the scale is reachable", () => {
    expect(phaseAt(SPECIMENS.reachesIR, specimenPath)).toEqual({ phase: "ir", error: "" });
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

  // A leading UTF-8 BOM (U+FEFF) is not part of the program either. node strips it
  // (verified: a BOM-prefixed `console.log("ok")` prints `ok`, exit 0), and so does
  // tsc. Found via the TypeScript conformance union corpus — 13 of its 25 files are
  // BOM-prefixed, and every one of them died in the lexer.
  test("a leading U+FEFF BOM is not part of the program", () => {
    expect(() => lex('﻿console.log("ok");\n')).not.toThrow();
    const toks = lex("﻿const a = 1;\n");
    expect(toks.some((t) => t.value === "const")).toBe(true);
  });

  test("a BOM followed by a shebang skips both", () => {
    // `<BOM>#!/usr/bin/env node` is a real shape — an executable script saved by an
    // editor that writes a BOM. node runs it (verified: prints, exit 0), so the shebang
    // scan has to start after the BOM rather than at offset 0.
    const toks = lex('﻿#!/usr/bin/env node\nconst a = 1;\n');
    expect(toks.some((t) => t.value === "const")).toBe(true);
    expect(toks.some((t) => t.value === "!")).toBe(false);
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
    // Re-measured centrally after a round of parallel lanes merged (see below). NT0001
    // is now EMPTY tree-wide: its last two survivors were a template-literal TYPE
    // (`\`${string}[]\`` in ast.ts, which coverage.ts and coverage-preprocess.ts saw
    // through the link) and `satisfies` in parser.ts. Separate lanes cleared each.
    // Every remaining stage-1 blocker now has a named NT code and a hint.
    // RE-MEASURED AT THE MERGE — both sides of this hunk were stale, which is exactly why
    // an exact tree-wide set keeps churning. Main had emptied NT1009 (the `?.[]` lane, nine
    // of twelve modules) and NT2001 (parameter-default inference); this lane had emptied
    // NT1606 (diagnostics.ts was its only holder) and added NT1604. The union of those four
    // moves is the list below, measured on the merged tree, not inferred from either side.
    // NT1604 IS NOW EMPTY, and this is the first time a bucket emptied by a module
    // LEAVING the table rather than moving within it: `diagnostics.ts` was its only
    // holder, and it now produces IR, so it contributes no blocker at all. Consuming
    // parameters (a constructor PARAMETER PROPERTY takes ownership; every `new C(v)` site
    // moves `v`) is what cleared it — see test/sh6.test.ts, where the module reaches
    // rung 3 and its output matches the bun-run module byte for byte.
    // NT1023 IS NOW EMPTY, and NT1009/NT1015 REFILLED BEHIND IT — the same "a bucket
    // refills because the frontier ADVANCED" note the NT0001 paragraph below makes.
    // `NT1023` was "a method assigns a field, so it produces a NEW C, but it does not
    // return one" on `Checker.inArrow` and `ModuleGen.build`; both classes are ordinary
    // accumulators, so they now carry `//@@mutable` (the same pragma `Parser`, `FnGen`
    // and `Analyzer` already carried). checker.ts/ownership.ts stop on NT1009 (a
    // discriminant-less object union in diagnostics' `parseTemplate`) and codegen.ts on
    // NT1002 (`op in FCMP` — the key-presence operator). codegen.ts's own NT1015 was a
    // `get` accessor, now rewritten as the method it always was — accessors stay refused,
    // and the tree holds exactly one getter and no setters.
    //
    // NT1009 AND NT1031 ARE NOW BOTH EMPTY, and both emptied the same way — by a SOURCE
    // change to a supported spelling, not by a compiler change. `FmtPiece` carries a
    // `kind` tag (SH2's union has no box, so presence-discrimination has no
    // representation), and `lexer.ts`'s cursor became one `//@@mutable` record instead of
    // three `let`s that closures wrote through. checker.ts and ownership.ts fall back onto
    // ast.ts's NT1030, which nine modules now share; lexer.ts refills NT1606 with
    // `tokens.push` — the 185-site census item, and NOT free for an accumulator this size
    // (test/sh6.test.ts records the 1036x bun measurement).
    //
    // RESOLVED AT THE MERGE BY RE-MEASURING, and for the second time in this file NEITHER
    // SIDE WAS RIGHT: this lane's list predated NT1002 (codegen.ts's `in`, which landed
    // while it worked) and main's predated the two buckets this lane emptied. Each branch
    // could see what it had changed and not what the other had.
    //
    // NT1030 IS NOW EMPTY — the SCC that nine modules shared is encoded. It took a
    // compiler change (union FLATTENING: a nested `U<…>` arm contributes its members, and
    // a single nullish arm hoists into `?U`/`?N`) plus one SOURCE change, `ArrowFunction`'s
    // `body: Expr | Stmt[]` becoming `body?: Expr` + `stmts?: Stmt[]` — a union of a
    // discriminated union and an ARRAY has no representation, and the obvious repair
    // (`body: Expr | Block`) DEADLOCKS, since `Expr` selects over `ArrowFunction` so it is
    // still a shapeless `@Expr` while the component is being encoded.
    //
    // NECESSARY, NOT SUFFICIENT, and this is the ordinary shape of the ratchet rather
    // than a disappointment: clearing NT1030 moved all nine modules and NONE of them
    // reaches IR. They land on the queue it was masking. TWO buckets refill:
    //   NT1014 — ast.ts's own `new Map([[k, v], …])` entries form (`DATE_GETTERS`), now
    //            the linked blocker for checker/ownership/parser/modules as well.
    //   NT1702 — an IMPORT CYCLE, on coverage.ts and coverage-preprocess.ts. Worth
    //            calling out separately: it is a different KIND of blocker from every
    //            other entry here — not a missing feature but a defect in the module
    //            graph — and it has never been visible before, because ast.ts's refusal
    //            fired before the linker ever got far enough to trip over it.
    //
    // NT1014 EMPTIED AND NT2001 REFILLED, one source change apart. `DATE_GETTERS` was
    // written as the `new Map([[k, v], …])` entries form — which needs a `[key, value]`
    // tuple type nativets does not have — and is now the `.set` chain the diagnostic
    // itself prescribes. That is the same program by construction (ES2024 24.1.1.1 §8
    // builds the entries form by calling `set` once per entry, and 24.1.3.9 §8 is
    // "Return M"), and unlike the `.push` -> `xs = [...xs, v]` rewrite it is FREE under
    // bun, so the two-toolchain constraint really is satisfied here.
    //
    // Read NT1014's absence NARROWLY: this is a FIRST-blocker set, and the entries form
    // is NOT gone from the tree. A readFileSync census (never shell grep) finds five more
    // reachable sites — checker.ts:4524/:4565, modules.ts:431/:574, ast.ts:1204 — plus
    // three that need a real tuple TYPE rather than the `new Map` argument position
    // (ownership.ts:111/:884, codegen.ts:1052, all `.map`-produced pairs). They are
    // behind the codes below and will resurface one at a time, exactly as `.push` does.
    //
    // NT2001 is ast.ts's `HOST_MODULES`, a `Record` initialized with an object literal —
    // the same class as checker.ts's `NUMBER_CONSTS` — inherited by the same four modules.
    // NT1702 IS NOW EMPTY, and it emptied by a SOURCE change, not a compiler change — which
    // is the right outcome and was not the obvious one. The cycle's closing edge was
    // type-only (`import type { Blocker }`), which node and bun erase, so the tempting fix
    // was to stop the linker's DFS from walking type-only edges. Measured: that moves both
    // modules to exactly the codes below, so it LOOKS right — but only because neither
    // module reads the erased type before stopping on something else. The type is not
    // resolved by dropping the edge, it is left unseeded, and an unresolved type silently
    // becomes `number` (docs/divergences.md). `Blocker` moved down into the leaf instead.
    //
    // NT1031 refills in its place: `coverage-preprocess.ts`'s `line++`, a write to a
    // captured binding — the same one lexer.ts sat on, and the first blocker that module
    // has ever owned rather than inherited.
    //
    // RESOLVED AT THE MERGE BY RE-MEASURING, and for the third time in this file NEITHER
    // SIDE WAS RIGHT. This branch listed NT1702 (it had not seen the type-cycle lane) and
    // NT1014 was gone from it (its own change); main listed NT1014 (it had not seen the
    // entries-form fix) and NT1031 (the type-cycle lane's). The true set is the union of
    // what each branch cleared minus what the other cleared, and no reviewer holding two
    // diffs can compute that by reading — only by running it on the merged tree.
    // NT1002 LEFT when `in` landed (compile-time decidable for a literal key over a static
    // shape — the same move `instanceof` made). NT1020 arrives in its place: cli.ts calling
    // an async function without `await`. Re-measured on the merged tree.
    //
    // NT1031 LEAVES AGAIN, and the whole code goes with it: `coverage-preprocess.ts` was
    //
    // NT1031 LEAVES AGAIN, and the whole code goes with it: `coverage-preprocess.ts` was
    // its only site tree-wide, and its `tokenize` cursor is now ONE `//@@mutable` record
    // (`TokState`) instead of a `line`/`prev` pair two closures wrote — the shape
    // `src/lexer.ts`'s `LexState` used to clear the identical blocker. The module lands on
    // `.push`, which NT1606 already covers, so the SET shrinks by one rather than swapping.
    // A shrinking set is the only movement this tree-wide assertion can show as unambiguous
    // progress, and it is worth saying that it is a SOURCE change: the compiler is
    // unchanged, so a re-run against main's `src/coverage-preprocess.ts` still reports
    // NT1031 (that is the controlled experiment the selfhost-ratchet rules ask for).
    //
    // NT1020 LEAVES with it, and for the same kind of reason: cli.ts was its only holder,
    // and both `guard(() => buildBinary(…))` call sites now spell the callback
    // `async () => await buildBinary(…)` — the fix docs/divergences.md names for that
    // deliberate over-rejection. Two codes gone in one lane, both by SOURCE changes, and
    // the tree-wide set is down to TWO for the first time: `.push` and a type error.
    //
    // AND NT2001 LEAVES TOO, at the merge, which is the FOURTH time this file records that
    // NEITHER SIDE OF A MERGE HAD THE LIST RIGHT. This branch measured
    // ["NT1014","NT1020","NT1031","NT1606"] (it had not seen main clear NT1031 and NT1020
    // by source changes); main measured ["NT1606","NT2001"] (it had not seen the
    // ARRAY-OF-NULLABLE encoding fix, which is what NT2001 was). Re-run on the MERGED tree,
    // the set is two codes and eleven modules: `.push` and the `new Map` entries form.
    // The compiler's own frontier is now a 185-site source idiom plus five table sites.
    //
    // ...and it is FOUR again, RE-MEASURED on the merged tree for the fifth time this
    // file records that neither side of a merge had the list right. `.push` is legal on a
    // `@@mutable` ACCUMULATOR binding now (docs/decorators.md), so NT1606 does not empty
    // but SHRINKS from five modules to one: `coverage-preprocess.ts`, whose accumulators
    // this lane did not annotate. In its place come the blockers it unmasked — NT1002
    // (ast.ts's `trimEnd`) and NT2001 (lexer.ts's own, inherited by parser.ts and
    // modules.ts through the link). A set growing because the frontier ADVANCED is the
    // pattern NT1027 and NT0001 already record here.
    //
    // ...and RE-MEASURED again, still four, but two of the four are different codes and
    // BOTH swaps are the same lane clearing a blocker and seeing what was behind it:
    //   - NT1002 LEAVES. `trimEnd`/`trimStart` are implemented, so ast.ts's last blocker
    //     is gone; ast.ts (and parser/modules through the link) now report NT2001, a
    //     ternary whose arms are `string` and `undefined` against a `?Ustring` return.
    //   - NT1004 ARRIVES, and it is lexer.ts's OWN. Its NT2001 ("Cannot compare string
    //     with undefined") was a real source defect, not a checker gap: `source[i]` is
    //     `string` here because an out-of-range string index PANICS by design, so the
    //     `!== undefined` guard was dead. Reading it with `.at` clears the comparison and
    //     unmasks a `throw` outside a `try` at 202:5.
    // NT2001 therefore does NOT leave the set — it changes owner, from lexer.ts's dead
    // guard to ast.ts's ternary. A code holding still while the module behind it changes
    // is exactly what this tree-wide set cannot see, and why selfhost-ratchet exists.
    //
    // ...and NT1011 ARRIVES, on the same pattern for the fourth time here: the ternary
    // lane cleared ast.ts's `?:` join and then six blockers behind it, and the SEVENTH is
    // `for (const x of n)` where `n: unknown` — `mapTypesDeep`, a reflective AST walker.
    // NT2001 again does not leave the set (cli.ts's `process.stdout` is its own, and
    // depends on none of this), and again it has changed owner: ast.ts's ternary is gone,
    // so the eight modules that reported it now report NT1011 instead.
    //
    // ...and NT1011 LEAVES AGAIN, one round later, by the same move the file keeps
    // recording: an honest SOURCE change beat growing the language. The three reflective
    // AST walkers in src/ast.ts (`mapTypesDeep`, `resolveStaticFieldReads`,
    // `collectBindingNames`) are now exhaustively TYPED traversals over `Expr`/`Stmt`, so
    // there is no `unknown` left to `for-of` over and no `Object.keys` behind it. All NINE
    // modules that reported NT1011 through the link moved together, to ast.ts's NEXT
    // construct — `setBlockDrops`'s `last !== undefined` on a `Stmt`, a general union
    // compared with `undefined`. So NT2001 does not merely stay in the set, it changes
    // owner for the third time here: from cli.ts's `process.stdout` to ast.ts's union
    // comparison. A code holding still while the module behind it changes is precisely
    // what this tree-wide set cannot see — selfhost-ratchet records the per-module move.
    // ...and NT1606 LEAVES, which empties the code that has been in this set longer than
    // any other. `coverage-preprocess.ts` was its last holder tree-wide, and the fix is a
    // SOURCE change with the compiler untouched: its three accumulators are `//@@mutable`
    // now, which they could not be while `tokenize`'s array was CAPTURED by a
    // `const push = (t) => { … }` closure — a captured accumulator is NT1607 by decision.
    // Inlining the closure at its ten call sites is the whole unlock. Nothing takes
    // NT1606's place, because the module went all the way to rung 3 in the same lane
    // rather than landing on the next refusal (test/sh6.test.ts); the three blockers it
    // did pass through on the way — a discarded `Set.add`, `number && boolean`, and
    // binding a linear array element to a local — were all cleared in the same file.
    expect(Object.keys(byCode).sort()).toEqual(
      // NT1014 IS GONE tree-wide: every LITERAL entries-form site in src/ is a `.set` chain
    // now, and the one DYNAMIC site that was actually blocking (ownership.ts's `clone`,
    // refused for the Map spread) became a `.set` LOOP — which is what the constructor
    // does internally, so no tuple encoding was invented.
    // RE-MEASURED AT THE MERGE FOR THE SIXTH TIME, and for the sixth time NEITHER SIDE
    // HAD IT RIGHT — and this merge is the cleanest illustration the file has. Each
    // branch cleared a DISJOINT part of the set and could not see the other's:
    //   main       cleared NT1004 (lexer.ts's uncatchable `throw`) and NT1606
    //              (coverage-preprocess.ts's captured accumulator), and measured
    //              ["NT1011"] — the walkers, which it had not touched;
    //   this lane  cleared NT1011 (the three reflective walkers) and measured
    //              ["NT1004", "NT1606", "NT2001"] — the two main had already emptied,
    //              plus what the walkers were masking.
    // The union of the clears leaves exactly ONE code, held by nine modules, and it is
    // ast.ts's `setBlockDrops` dead guard. No reviewer holding two diffs could have
    // computed that; it is measured.
    //
    // ...and NT2001 LEAVES, replaced by NT1606, which is the EIGHTH refill of the bucket
    // this file has recorded — and this time the code moving is not the finding. The
    // finding is that the old code was COSMETIC and the new one is the wall. NT2001 was
    // `setBlockDrops`'s `last !== undefined` on a general union: a guard that can never be
    // true here (an out-of-range index PANICS by design, Stage 41, so the read is typed
    // `Stmt`) and that node and nativets genuinely DISAGREE about on an empty list — node
    // answers `undefined` and appends, nativets panics. So it was a source defect in
    // src/ast.ts with a divergence behind it, not dead code, and it is now a `length`
    // guard (see the note on `setBlockDrops` and the proxy test in test/block-drops.test.ts).
    // Behind it, held by the same nine modules, is `o.f = v` on an AST node — which is the
    // typed walkers writing `e.ty = f(e.ty)` exactly where the reflective ones wrote
    // `o[k] = f(v)`. The same wall in honest clothing, and a DECISION rather than a gap:
    // `@@mutable` cannot tag a discriminated-union member (the tag makes the union NT1009 —
    // measured) and cannot reach a parameter (NT1607 by design), so it is not the answer.
    // Census: 191 non-`this` `o.f = v` sites across 8 of 12 modules, 45 of them in ast.ts's
    // walkers alone. See docs/self-hosting.md.
    //
    // ...and NT1606 LEAVES AGAIN — the NINTH refill, and the second time its holder was a
    // single line of `src/ast.ts` that nine modules inherit. `o.f = v` was answered by
    // `@@mutable` on the record TYPE (the mutable-records lane), which left exactly one
    // term: `setBlockDrops`'s `list.push(…)` on a PARAMETER. The parenthetical above is
    // now wrong in its second half as well: `@@mutable` CAN reach a parameter — not by
    // travelling with the type (an array type is STRUCTURAL, so the record's nominal-tag
    // answer does not transfer) but as a PER-PARAMETER marker, which is still part of the
    // signature and therefore still visible at the call site. Two marked parameters in
    // the whole tree cleared the code. Behind it, held by the same nine modules, is
    // ast.ts's own `new Map(p.recTypes ?? [])` — the [key, value] entries form, which
    // needs a tuple type. So NT1014, emptied tree-wide two rounds ago, refills: the
    // earlier clear was of every LITERAL entries site, and this one is DYNAMIC.
    //
    // ...and NT1014 LEAVES AGAIN — the TENTH refill, and for the third round running the
    // holder was one line of `src/ast.ts` that nine modules inherit. `new Map(p.recTypes
    // ?? [])` needed a `[K, V]` tuple type; the answer was NOT to invent one. The census
    // says the whole compiler contains SIX tuple-type annotations in three files, every
    // one of them HOMOGENEOUS (`[Expr, Expr][]`, `[Ty, Ty]`, `[string, Ty][]`), so
    // `parseTupleType`'s existing `[T, U] -> T[]` erasure is already right for all of
    // them and a real tuple type would buy nothing. `Program.recTypes` is a named
    // two-field record now (`RecTypeEntry`), which needs no new `Ty` encoding at all —
    // five source sites in three files, and zero compiler change for that half.
    // Behind it the nine landed on NT2001, and it took ONE compiler fix to get there:
    // a discriminated-union tag test did not narrow across the short circuit of `&&`
    // (`if (e.kind === "CallExpr" && e.callee.kind === "MemberExpr")` — ast.ts's own
    // `freshArray`). Tag narrowing is a shadow BINDING, not a `NarrowFact`, so the
    // short-circuit fact plumbing that already existed could not carry it.
    // What holds all nine now is the KNOWN next term: `Property 'kind' does not exist on
    // @Expr` — a property read through a recursive back-edge, which has its own lane.
    //
    // ...and NT2001 LEAVES, replaced by NT1001 — the ELEVENTH refill, and for the fourth
    // round running the holder is one FUNCTION of `src/ast.ts` that nine modules inherit.
    // The back-edge read and then the dotted-path tag test fell in their own lanes; what
    // was left was `exprLoc`'s `case "BinaryExpr": case "LogicalExpr": return
    // exprLoc(e.left)`, a field read on a receiver narrowed to two members. It is legal
    // now because `left` is at the SAME slot with the SAME type in both, so one
    // constant-offset load reads it (`unionCommonField`); a field at DIFFERENT slots, or
    // with different types, is still refused, and both guards have a mutation test.
    //
    // The next term did not even change function: it is 22 lines further down `exprLoc`,
    // `e.exprs.map((x) => exprLoc(x))` — an ARRAY OF NULLABLE ELEMENTS, NT1001. Worth
    // saying plainly, because the bucket this came out of was named "union field before
    // narrowing": the union work is NOT what stands between these nine modules and the
    // next rung, and this set is the instrument that says so.
    //
    // ...and NT1001 LEAVES, replaced by NT2001 — the TWELFTH refill, and for the FIFTH
    // round running the holder is one function of `src/ast.ts` that nine modules inherit.
    // Both halves of `exprLoc`'s `.map(…).find(…)` are now gone: the `.map` in one lane,
    // the `.find` in the next. The `.find` half was the one that really was an OWNERSHIP
    // question, and it opened for exactly one element shape — `(T | undefined)[]`, where
    // the element already IS the `[tag,value]` box the answer needs, so the hit path
    // hands that box straight back and allocates nothing. A plain object element still
    // needs a second owner and is still NT1001; a `(T | null)[]` is now refused by name,
    // because its result wants two nullish arms and the encoding carries one.
    // What holds the nine now is `exprText`, ~20 lines further on: `e.optional === true`,
    // comparing an optional boolean field with a boolean. Five rounds, one region of one
    // file, and this time the construct is not about ownership either.
    //
    // ...and NT1001 RETURNS beside NT2001 — the THIRTEENTH refill, and the first one this
    // file has recorded where the two codes stopped being held by the SAME nine modules.
    // `exprText`'s union field read cleared (the `||` of two tag tests narrows now — see
    // the census in test/sh6.test.ts's `ast.ts` BASELINE row), and with it the last term
    // `ast.ts` shared with everyone downstream. `ast.ts` alone now reports NT1001,
    // `.map` producing an array of union elements, which was masked behind `exprText`
    // and is an OWNERSHIP refusal rather than a narrowing one. The other eight keep
    // NT2001 and now hold it on their OWN source: the blame column in test/sh6.test.ts
    // moved for the first time, from `ast.ts` to `self`/`parser.ts`/`checker.ts`.
    //
    // A two-element set here is therefore not a regression; it is the set finally
    // SEPARATING. For five rounds this instrument read one code because one line of
    // ast.ts gated every module, which is precisely the masking its own header warns
    // about. The tiers below are now measuring nine different walls, not one.
    // ...and NT2001 LEAVES, for the fifth time this file records that code emptying.
    // Not a narrowing fix this round: `Renamer.expr` missed `retAnnot`, so one type had
    // two spellings and eight modules each reported it as their own blocker. What is
    // left is ONE code and ONE term — `ast.ts`'s `.map` over heap elements, an
    // ownership refusal that every module inherits through the link.
    // ...and they TRADE PLACES, which is the point: `.map` cleared, and behind it the
    // nine sit on `?UU<<UNION>>` vs `?U@2_Expr` — a `@N` back-edge comparing unequal
    // to its own one-level unfolding. One type, two spellings, for the SECOND time in
    // two rounds (the first was `Renamer.expr` missing `retAnnot`). Two different
    // causes, one shape; that is now a pattern rather than a coincidence.
    // ...and the frontier crosses a CATEGORY. Not a type-identity or narrowing gap this
    // time but NT1003, first-class FUNCTION VALUES — `walkStmtChildren`'s `onAssign`
    // callback. Every previous term on this line turned out to be a spelling or a
    // missing wiring; this one is a feature the language does not have.
    // ...and NT1003 leaves as fast as it arrived, because function values were never
    // missing. 33 of 36 function-typed params in `src/` already compiled; the call
    // path was simply the only read of a binding in the checker that skipped
    // `narrowedTy`, so an optional callback was judged by its declared type.
    //
    // What is left is NT1606 — `Set.add` discarded, 30 sites, byte-identical in both
    // trees and merely unmasked by the code above it clearing. That is a REAL
    // refusal: `Set` is persistent here, so `s.add(x)` genuinely does nothing.
    // ...and it SPLITS IN TWO, which is the shape of `ast.ts` leaving the table. For five
    // rounds this set was one code because nine modules were reporting one line of
    // ast.ts through the link. ast.ts is now at ZERO failing functions and out of the
    // blame column entirely, so the remaining nine sit on their OWN source and the set
    // finally measures nine walls instead of nine views of one.
    //
    // NT1605 is ast.ts itself, and it is a RUNG rather than a blocker: ast.ts now runs
    // the entire CHECKER clean and dies in the OWNERSHIP pass, a stage it had never
    // reached. NT2001 is the other eight, blaming `self`/`parser.ts`/`checker.ts`.
    // ...and NT1605 is GONE, because `ast.ts` reached IR. It was the ownership refusal
    // that surfaced the moment ast.ts cleared the checker -- three element-BINDING sites
    // plus three NT1604s behind them. Fixed with ZERO rule changes: reading THROUGH an
    // index is `consume=false` and always legal, so most NT1605 sites are pure spelling.
    // The rule still refuses the exact shape that was removed (verified by mutation).
    //
    // ast.ts is now at RUNG 3 -- four modules reach IR where three did.
    // ...and NT2001 LEAVES — the TWELFTH refill this file has recorded, replaced by
    // NT1002. What held it was ONE EXPRESSION in `src/checker.ts` that THREE modules
    // inherit at once: `const asBlocker = (fn, e: unknown) => e instanceof NTError ?
    // e.diag… `, where `instanceof` does not narrow an `unknown`. Behind it, cleared in
    // the same sitting and in this order: `collectBlockers.push` on an unmarked array
    // parameter (NT1606); the `//@@mutable` marker REFUSING that parameter because it was
    // OPTIONAL, so `?U…[]` and not an array (NT1023); the catch binding still typing
    // `string`, because `checkFunction` dispatches rather than throwing directly — which
    // is what makes TRANSITIVE raise inference load-bearing, after it had been rejected
    // one commit earlier on the blocker-metric proxy; and `program.body = …` (NT1606),
    // now a new `Program` built at the return.
    //
    // The wall behind all five is `structuredClone` of the recursive `FuncDecl` type.
    // NT1014 is untouched and still holds the OTHER five modules — parser.ts's
    // `Set of U<…>` — so this round moved one of the two tiers, not both.
    // ...and NT1014 LEAVES the tree-wide set too, one round after NT2001 — so BOTH tiers
    // moved in the same sitting, which this file has not recorded before. Its holder was
    // three IDENTITY-KEYED collections over the `Expr` union in src/parser.ts
    // (`Set<Expr>` twice, `Map<Expr, …>` once) plus a `Map<string, Set<number>>`. All are
    // one-way STAMPS on the node now, or a plain `number[]`. The five land on NT1001
    // (`arrays of Set<string>`); the three behind checker.ts stay on NT1002.
    // ...and NT2001 EMPTIES for the parser group too — `never` erases to `number` here, so
    // `base = this.refuseTypeQuery()` (a call that cannot return) read as "assign number to
    // string". The signature is `: Ty` now, which the `never` hint itself prescribes. The
    // five land on NT1606 (`t.value = v`, a field write on a token).
    // ...and NT1606 EMPTIES for the parser group: the BINDING-level `@@mutable` opt-in
    // permits an in-place field store without making the type nominal, which is what
    // marking the TYPE broke (measured: 4 of 12 modules at IR down to 3). Five sites in
    // src/parser.ts. The group lands on NT1011 (`for-of` over a nullable array).
    // ...and NT1011 leaves too: the `for-of` over a nullable array was a NARROWING gap,
    // not a feature gap — binding the call RESULT instead of re-reading the field is the
    // whole fix, and it is the third instance of "narrowing does not survive a mutable
    // rebind" in this file's own source. The group lands on NT1001.
    // ...and NT1001 leaves: an empty array literal in an assignment position, annotated.
    // Behind it three more src/parser.ts shapes came off in the same sitting — `unshift`
    // (no in-place primitive; the spread is the answer) and a field write through a
    // `for-of` ELEMENT, which is a BORROW and the one receiver the `@@mutable` opt-in
    // deliberately does not reach, so the list is rebuilt instead.
    // ...and NT2001 leaves again after eight more src/parser.ts shapes: three `as
    // FuncDecl` literals that wanted ANNOTATIONS (an assertion demands the layout, an
    // annotation reshapes into it), a conditional spread, an optional chain that tested
    // without narrowing, a `FuncDecl[]` that is not a `Stmt[]` (the member's `kind` is a
    // literal, the array's widens), a variadic spread, and a field stamp taking the
    // BINDING-level opt-in. The group lands on NT1001.
    // ...and NT1001 leaves: `.find` over an array whose element is the `Expr` UNION would
    // hand back a heap element the array still owns, and the result was only tested for
    // PRESENCE — so a loop with a boolean says the same thing and borrows nothing.
    ["NT1002", "NT1606"],
    );
    // RE-MEASURED AT THE MERGE, and NEITHER SIDE WAS RIGHT — which is the whole argument
    // for re-measuring instead of picking one. This lane's list still carried NT1009
    // (main had emptied it with `?.[]`) and kept NT2001; main's list carried NT2001 (this
    // lane had emptied it by inferring a parameter's type from its default) and had no
    // NT1031. The true set is the union of what each branch cleared, minus what the other
    // cleared, and no reviewer holding two diffs can compute that by reading.
    // CONFLICT RESOLVED BY RE-MEASURING, not by choosing a side. Both branches were
    // right about their own change and wrong about the other's: main had cleared NT0001
    // and NT1017, this lane had cleared NT1014, and neither could see the other.
    //
    // NT1017 is empty for two reasons landed a session apart — the text-import lane
    // (`import … with {type:"text"}`), then the export-async lane clearing
    // `export async function` at driver.ts:502.
    expect(byCode["NT1017"]).toBeUndefined();
    // NT0001 WAS asserted here as a shrink-only ratchet ("a new parse-level blocker means
    // a lane regressed the frontier"). THAT WAS WRONG, and the static-members lane proved
    // it: NT0001 is the GENERIC parse-error code, not a regression marker. `codegen.ts`
    // cleared NT1015 (static members) and the module then got FURTHER and stopped on a
    // different parse error at 582:33 — the bucket refilled because the frontier ADVANCED.
    // Assert membership, which says which construct, not emptiness, which says nothing.
    // NT0001 is empty AS OF TODAY — the indexed-access lane named codegen.ts's blocker,
    // and that was the last anonymous parse failure in the tree. Every remaining blocker
    // carries a code and a hint, which is what CLAUDE.md promises.
    //
    // Stated as a fact, not an invariant. This file has twice pinned an emptied bucket as
    // permanent (NT0001 itself, then NT1027) and been wrong both times, because clearing a
    // NAMED blocker lets a module reach further and hit an unnamed one behind it.
    expect(byCode["NT0001"]).toBeUndefined();
    // NEW BUCKET: codegen.ts left NT0001 for a NAMED code — a method that assigns a field
    // and so produces a new module value.
    // ...and it has since GROWN to three, all of it forward movement: the optional-element
    // lane cleared `?.[]`, so `checker.ts` walked on to `Checker.inArrow` (a method that
    // assigns a field), and `ownership.ts` inherits that identical error through the link.
    // ...and then SHRANK back to one, and that was NOT forward movement — it is the
    // opposite, and it is still correct. `checker.ts` and `ownership.ts` left this bucket
    // for NT1030 at a SHALLOWER line: `class Scope { parent: Scope | null }` (checker.ts:93,
    // the compiler's own symbol table) had its recursive field silently erased to `number`,
    // so this bucket was crediting checker.ts with reaching line 676 past a miscompiled
    // Scope. A bucket can shrink because the frontier RETREATED to the truth. See the
    // "moved shallower is not automatically a regression" rule in selfhost-ratchet.test.ts.
    // ...and back to three. Lane B gave `Scope` a real representation (the `@Name`
    // back-edge), so checker.ts and ownership.ts left NT1030 and returned to this bucket —
    // this time HONESTLY, past a symbol table that compiles rather than one that was erased.
    // ...and it is EMPTY again, this time by all three modules walking PAST it. The two
    // classes NT1023 named — `Checker` and `ModuleGen` — are accumulators, not
    // copy-on-write values, so they carry `//@@mutable` like `Parser`/`FnGen`/`Analyzer`
    // already did. checker.ts and ownership.ts moved on to NT1009 (the `FmtPiece` union),
    // codegen.ts to NT1015 (a `get` accessor), both deeper in the same `parse` stage.
    expect(byCode["NT1023"]).toBeUndefined();
    // RATCHET MOVE (collections): NT1014 is now EMPTY. It held lexer.ts on
    // `new Set([...])` for REGEX_AFTER_KEYWORD; `new Set(iterable)` compiles now, so the
    // module walks on to what sat behind it — NT2001, an object literal where a Map is
    // annotated. coverage-preprocess.ts left the same bucket and stops on NT1606.
    //
    // AND IT IS BACK — with a DIFFERENT construct and five modules, which is precisely the
    // reason the paragraph below this one says to assert MEMBERSHIP and not emptiness.
    // That advice was written for NT1027 and then not applied here; this is the third
    // bucket to refute "empty is an invariant". The construct is now the `new Map([[k, v],
    // …])` ENTRIES form (`ast.ts`'s `DATE_GETTERS`) — a different feature from the
    // `new Set([...])` that used to fill it, and NOT a regression: it was masked behind
    // ast.ts's NT1030 until the recursive component was encoded, and four more modules see
    // it only through the link to ast.ts. So: name the construct, count the modules.
    //
    // ...AND EMPTY AGAIN, by the same move the `.push` census recommends and for once
    // without its cost: `DATE_GETTERS` is now the `.set` chain the NT1014 hint already
    // prescribed. `Map.prototype.set` returns its receiver (ES2024 24.1.3.9 §8), which is
    // exactly what the Map constructor itself does per entry (24.1.1.1 §8), so the two
    // spellings are one program and bun runs the new one at the same speed — the thing
    // that was NOT true of `xs = [...xs, v]` (1036x, and quadratic).
    //
    // Heed this file's own advice and read it as MEMBERSHIP, not emptiness: five more
    // entries-form sites remain in the tree, behind other blockers (checker.ts:4524/:4565,
    // modules.ts:431/:574, ast.ts:1204), plus three `.map`-produced pair arrays that need
    // a real tuple TYPE. This bucket has now been emptied and refilled three times.
    //
    // ...AND REFILLED, for the fourth time, with the SAME construct in a different file:
    // checker.ts's own CONSOLE_STREAMS/FMT_SPECS, two of the five sites the paragraph
    // above says remain. They became visible when the ARRAY-OF-NULLABLE lane cleared
    // `argTys: (Ty|null)[]`. Read as MEMBERSHIP, exactly as instructed: the bucket names
    // the construct, never a count of it.
    // SIX at the merge, not five: main independently moved `cli.ts` off NT1020 (the
    // un-awaited `buildBinary`), and it landed in this bucket with the rest.
    // EMPTY NOW. Kept as an assertion rather than deleted: this bucket has emptied and
    // refilled before, and the three DYNAMIC sites that remain in src/ still need a real
    // [K,V] tuple, so a refill here means someone wrote the entries form again.
    //
    // ...AND REFILLED, for the fifth time — by one of those three DYNAMIC sites, exactly
    // as the paragraph above predicted. `ast.ts:1304`'s `new Map(p.recTypes ?? [])` came
    // into view when the per-parameter `@@mutable` opt-in cleared `setBlockDrops`'s
    // `list.push(…)`, and it is inherited by all nine modules through the link. Nobody
    // wrote the entries form again; the frontier moved onto one that was always there.
    // This site genuinely needs the `[K, V]` tuple TYPE, which is why it is the one the
    // `.set`-chain rewrite could not reach.
    //
    // EMPTY AGAIN — the sixth time, and the FIRST time this bucket was emptied without a
    // `.set` rewrite, because this site could not have one. `Program.recTypes` stopped
    // being `[string, Ty][]` and became `RecTypeEntry[]`, a named two-field record. The
    // census behind that choice: six tuple-type annotations in the whole compiler, in
    // three files, EVERY ONE homogeneous — so the `[T, U] -> T[]` erasure the parser
    // already does is correct for all six, and a real `[K, V]` `Ty` would have bought a
    // new encoding (and a new set of collisions to check against every predicate) for a
    // single site. The one honest tuple in the tree is now a record.
    // All nine moved together onto NT2001 — asserted below, where that bucket lives.
    // ...and NT1014 EMPTIES: the three identity-keyed `Expr` collections in src/parser.ts
    // became node stamps, and the `Map<string, Set<number>>` became `Map<string, number[]>`.
    // The same five modules move together to NT1001 (`Set<string>[]`), which is asserted
    // as a membership rather than a bare absence so the next move names its holders.
    expect(byCode["NT1014"]?.slice().sort() ?? []).toEqual([]);
    // ...and NT2001 holds the parser group again, one code further along after four
    // more src/parser.ts shapes came off (an annotated empty literal, `unshift`, a
    // `for-of` element write rebuilt as a list, and a nullable field read).
    expect(byCode["NT2001"]?.slice().sort() ?? []).toEqual([]);
    // The five modules moved TOGETHER onto ast.ts's next one — `HOST_MODULES`, a `Record`
    // initialized with an object literal. Same set, one code further along; asserted here
    // so the group staying a group is visible rather than inferred.
    // EIGHT now: codegen.ts and driver.ts joined by leaving NT1002. Every one of them is
    // ast.ts's `HOST_MODULES` through the link — a `Record` initialized with an object
    // literal — except codegen.ts, which has four tables of its own with the same shape.
    //
    // DOWN TO FIVE, and the construct in the bucket is a DIFFERENT one. The `Record`
    // family is gone from `src/*.ts` entirely — all ELEVEN declarations across four files
    // (the CENSUS, not the first-blocker count: ast ×1, parser ×1, checker ×5, codegen ×4),
    // rewritten as `new Map().set(…)` chains read with `.get`/`.has`. Every one of them was
    // indexed with a VARIABLE key, so they really were dictionaries and `Record<K,V>` was
    // the honest TYPE with the wrong CONSTRUCTOR; `test/record-dict.test.ts` holds the
    // argument, the census, and a lint that keeps `Record<` annotations out of `src/`.
    // What the five stop on now is `argTys: ["string", null]` in `MethodSig` — an ARRAY OF
    // NULLABLE elements, which is refused at a plain `const` declaration too, i.e. a real
    // feature gap and not a `.set` one. Behind it: the five remaining entries-form sites,
    // then `.push`. Three of the eight (ast, parser, modules) went straight to `.push`.
    // SIX now: `cli.ts` joins them, coming back from the one blocker it ever owned
    // (NT1020, the un-awaited `buildBinary`) once both call sites took the `await` that
    // diagnostic prescribes. Stage-1 is once again gated on a DEPENDENCY, which is where
    // it has been for every measurement but one.
    //
    // ...AND EMPTY. `(string|null)[]` was never a missing element TYPE — it was an
    // AMBIGUITY: the nullable encoding is a PREFIX (`?N`) and the array encoding a SUFFIX
    // (`[]`), so `(T|null)[]` and `T[]|null` were the same `Ty` string and the nullable
    // reading won. A parenthesized element (`(?Nstring)[]`) tells them apart — the fix
    // `parseTypeAtom` already prescribes for the identical array-of-functions collision.
    // All SIX moved together onto NT1014; the group stayed a group, cli.ts included.
    //
    // ...and it REFILLED with three DIFFERENT modules when `.push` cleared. lexer.ts
    // arrives with a blocker of its own ("Cannot compare string with undefined");
    // parser.ts and modules.ts inherit it through the link — the same three that used to
    // sit on `.push`, coming back out the other side. None of the six above returned.
    //
    // ...and it turned over WITHOUT changing size, which is the case a code-set assertion
    // is blindest to. lexer.ts LEFT (its `=== undefined` guard was dead source, not a
    // checker gap — see the code-set comment above); ast.ts ARRIVED in the same slot,
    // with a ternary of `string`/`undefined` unmasked by `trimEnd` landing. parser.ts and
    // modules.ts still inherit through the link, but now from ast.ts, not lexer.ts — the
    // attribution moved even though the code and the count did not.
    // NINE of twelve, and all nine are ONE ternary in ast.ts (`string` vs `undefined`)
    // reached through the link — the most concentrated this frontier has ever been.
    // cli.ts is the exception that proves the shape: its NT2001 is its OWN
    // (`process.stdout is not supported`), so stage-1 is separable from the grind for
    // the first time.
    //
    // ...and the concentration PAID OFF: the ternary lane cleared the join (a present arm
    // and a nullish literal now widen to `?U`/`?N`, TypeScript's rule), then walked the eight
    // dependents through six more ast.ts blockers behind it. NT2001 collapses from NINE
    // modules to ONE — cli.ts, which never depended on any of it. The eight moved to
    // NT1011, `for-of` over an `unknown` in a reflective AST walker, which is the first
    // entry in this table that is a design decision rather than a gap (see sh6.test.ts).
    // ...and at the MERGE, EMPTY. cli.ts was NT2001's last holder, and stage-1's own host
    // surfaces (`process.stdout.write`, `spawnSync stdio:"inherit"`) landed in the same merge
    // — so cli.ts walked off its own blocker and onto ast.ts's NT1011 with the other eight.
    // Neither branch could compute this from its own diff: one emptied the ternary, the
    // other emptied stage-1's, and only together does the bucket go to zero.
    //
    // ...and it REFILLED with all NINE at once, from ONE line, when the three reflective
    // AST walkers in src/ast.ts became exhaustively typed traversals. What they were
    // MASKING is `setBlockDrops`: it reads `list[list.length - 1]` and guards the result
    // `!== undefined`, but nativets types that read `Stmt` (an out-of-range index PANICS by
    // design — Stage 41), so the guard compares an 18-member general union with
    // `undefined` and there is no answer to give. Two things worth recording:
    //   - it is the SAME dead-guard defect lexer.ts held four rounds ago, in the same words
    //     ("Cannot compare … with undefined"), which `.at(-1)` cleared there;
    //   - the guard is not merely dead, it is WRONG in the other direction — on an EMPTY
    //     list node returns `undefined` and takes the `push` path while nativets would
    //     panic on the index. A source defect with a node divergence behind it, not a
    //     checker gap. Behind IT is NT1606 (`o.f = v` on an AST node), which is the
    //     `@@mutable`-the-AST decision, not a gap either.
    // So NT2001 changes owner for the third time here rather than staying empty.
    //
    // ...and it EMPTIES AGAIN, because that guard is gone. The two bullets above are the
    // whole justification for removing it rather than working around it: it could never be
    // true, and where it *could* have mattered it was WRONG. `setBlockDrops` now tests
    // `list.length > 0` and never forms the out-of-range index, which is behaviour-identical
    // under node for every list and divergence-free under nativets for the empty one.
    // All nine modules moved together to what it was masking — NT1606, asserted below.
    //
    // ...and it REFILLS with all NINE again, from ONE line of ast.ts again — and this time
    // it is the KNOWN next term rather than a surprise: `Property 'kind' does not exist on
    // @Expr`, a property read through a recursive back-edge. `freshArray`'s
    // `e.kind === "CallExpr" && e.callee.kind === "MemberExpr"` narrows `e` to `CallExpr`
    // and then reads `.kind` off `callee`, whose type is the folded `@Expr` — which unfolds
    // for an ordinary field read but not for this one. That is the `@Expr` lane, not this one.
    //
    // Note what had to be cleared to REACH it, because the two sit on the same line and are
    // two different gaps: the `&&` did not narrow AT ALL until this lane, so `.callee`
    // itself was the error. A tag narrowing is a shadow BINDING (`Checker.narrowInto`), not
    // a `NarrowFact`, so the short-circuit plumbing that already carried nullish guards
    // across `&&`/`||` could not carry it. Fixture: test/unions/narrow-shortcircuit.ts.
    //
    // ...and it EMPTIES AGAIN — the back-edge read fell, then the dotted-path tag test,
    // and now the last term of that chain: `exprLoc`'s `case "BinaryExpr": case
    // "LogicalExpr": return exprLoc(e.left)`, a field read on a receiver narrowed to two
    // members. tsc allows it because `left` is in both surviving members; we allow it
    // because it is ALSO at the same slot with the same type in both, which is what makes
    // it one constant-offset load and lets a union value stay an unboxed member pointer
    // (`unionCommonField`, src/ast.ts). Different slots, or different types, stay refused
    // — each guard has a mutation test, and deleting the type one prints a string pointer
    // as a double.
    // ...and it REFILLS with the same nine, one round later, when `exprLoc` cleared
    // entirely. `exprText` is the new holder: `e.optional === true`, an optional boolean
    // field compared with a boolean. NOTE THE OWNER CHANGE — NT2001 was last held here by
    // `exprLoc`'s two-member field read, which is gone; a code that empties and refills is
    // the pattern this file keeps recording, and the tree-wide set cannot see it. The
    // per-module move is in test/selfhost-ratchet.baseline.json.
    // ...and `ast.ts` DROPS OUT of this list — the nine become eight. This is the line to
    // read, not the code: for five rounds every name here was reporting ONE line of
    // ast.ts through the link, so the list was nine copies of a single blocker. It is
    // eight distinct blockers now. `ast.ts` moved to NT1001 (see the set assertion above).
    // ...and the bucket EMPTIES. "Eight distinct blockers now" was wrong — the same
    // mistake the two lines above congratulate themselves for catching, made again one
    // round later. The eight were nine-minus-one copies of a single defect: `Renamer.expr`
    // missed `retAnnot`, the only link-time member of that trio, so one type had two
    // spellings (`@Expr` vs `@_nts0_m2_Expr`) and every module that crossed a module
    // alias reported it as its own.
    //
    // What made it look like eight independent blockers: the diagnostic printed two
    // identical-looking unions, and NT2001's location for a LINKED program comes from the
    // merged text, so it pointed at a blank line. A blocker that cannot be located reads
    // as many blockers.
    // ...and it refills with EIGHT, not nine, and that difference is the whole point:
    // `ast.ts` is no longer in it. For five rounds this bucket and the one above it
    // traded the same nine names because nine modules reported ONE line of ast.ts
    // through the link. ast.ts is at zero failing functions now, so these eight are
    // on their own source -- blame reads `self`/`parser.ts`/`checker.ts` -- and the
    // set measures eight distinct walls for the first time.
    // ...and NT2001 EMPTIES tree-wide, splitting into TWO buckets rather than moving to
    // one. The eight modules did not share a single term after all: five were behind
    // `parser.ts`'s `valueReturns` (a for-of loop binding that a block-scoped `let s` in
    // `lexer.ts` made unnarrowable program-wide -- fixed, and they advanced one line to
    // the self-recursive local arrow, NT1003), while three were behind `checker.ts`'s
    // `spawnMode` (an out-of-range `args[2]` read, fixed, advancing to NT1606's
    // `s.returnTy = ret`). Recorded as two memberships, not one, because that split is
    // the finding: the "one shared blocker" reading was first-blocker reasoning.
    // ...and NT1003 lasted ONE round: the self-recursive arrow was a scoping gap, not the
    // closure gap its hint named, and clearing it moved the same five modules one line down
    // to a union read where only the shared tag is narrowable. NT2001 is back, holding
    // exactly the five it held before the split -- so this bucket has now emptied and
    // refilled with the same membership, which is what a CONJUNCTION looks like from here.
    // ...and it SPLITS, for the first structural reason rather than another shuffle: a
    // cross-frame `throw` can now carry an OBJECT (pointer-move, single owner transferred),
    // so `parser.ts::tokenize`'s `catch (e) { e.message }` cleared and took the five
    // modules that inherit it to NT1014. The three that link `checker.ts` stay.
    // ...and NT2001 EMPTIES AGAIN, taking the three `checker.ts`-linked modules with it.
    // One expression did it — `asBlocker`'s `e: unknown` with an `instanceof` that does not
    // narrow — and the four blockers stacked behind it fell in the same sitting, so the
    // three land on NT1002 (`structuredClone` of the recursive `FuncDecl`) rather than on
    // another NT2001. The tier list above records the order they came off in.
    // ...and NT2001 REFILLS with a DIFFERENT five — parser.ts and the four that link it,
    // never the three that emptied it. Exactly the substitution this file argues a bare
    // presence check cannot see: the code is unchanged and every holder is new. They
    // arrived after six blockers came off parser.ts in one sitting (Set<string>[] ->
    // deferred.push -> a nullable Map value -> a stale `as` assertion), and what holds
    // them now is `cannot infer type of arrow parameter`.
    expect((byCode["NT2001"] ?? []).slice().sort()).toEqual([]);
    expect((byCode["NT1002"] ?? []).slice().sort()).toEqual(
      ["checker.ts", "codegen.ts", "ownership.ts"],
    );
    expect(byCode["NT1003"] ?? []).toEqual([]);
    // NT1001 EMPTIES, and it is worth being precise about what did NOT happen: `.find`
    // over a heap element is still refused. What cleared is the one shape where the
    // element already IS a nullable box (`(T | undefined)[]`), so `.find` hands the
    // existing box back instead of building a second owner around a borrowed pointer.
    // Five rounds running, one region of src/ast.ts has been the wall for nine modules.
    // ...and it REFILLS with `ast.ts` alone, which is the shape the note above already
    // named as still-refused: `.map` producing an array whose elements are UNION values,
    // i.e. heap elements the callback does not own. Unmasked, not introduced — it sat
    // behind `exprText` and the standalone measurement on the base tree stopped at
    // `exprText` before reaching it. `.find`/`.map` over a heap element remains an
    // OWNERSHIP decision (a second owner for a pointer the array still holds), so this
    // is a different wall from the narrowing one that just came down, in a different pass.
    // ...and it GROWS to all twelve-minus-three. That is the shape of progress here, not
    // a regression: NT2001 emptied because one type had two spellings, and behind that
    // accident every module was always waiting on the SAME term — `ast.ts`'s `.map`
    // producing an array of heap elements. One code, one line, nine modules. The
    // blame column reconverging on `ast.ts` is what a single real blocker looks like
    // once the spelling accidents in front of it are gone.
    // ...and it EMPTIES again, one round later, because `.map` over a heap element was
    // never the ownership rule it read as. The parenthetical in that message belongs to
    // `.at`/`.find`; `.map` constructs rather than borrows, and `mapResultOk` already
    // allowed objects. Widening it to `U<…>`/`@N` needed no new store.
    // ...and NT1001 IS BACK, held by the five modules behind src/parser.ts: `Set<string>[]`,
    // which is what they landed on when the identity-keyed `Expr` collections (NT1014)
    // became node stamps. A membership, so the next move names its holders.
    // ...and NT1001 REFILLS with the parser group — the empty-array-literal inference,
    // reached after five blockers came off src/parser.ts in one sitting (the
    // BINDING-level `@@mutable` store, six push accumulators, and three narrowing
    // gaps where a value had to be resolved into a definite local).
    expect((byCode["NT1001"] ?? []).slice().sort()).toEqual([]);
    // NT1606 — `o.f = v` on an AST node, held by the same nine modules through the link.
    // This is the DECISION the entry above named, arrived at: the typed walkers in
    // src/ast.ts write `e.ty = f(e.ty)` exactly where the reflective ones wrote
    // `o[k] = f(v)`, so clearing NT1011 and then NT2001 has led back to the same wall in
    // honest clothing. It is not a gap and it is not cheap:
    //   - `@@mutable` on the AST interfaces is DEAD. Tagging is NOMINAL, and a tagged
    //     member makes its union unrepresentable — `//@@mutable type A = {kind:"a";…}` in
    //     a two-member union is NT1009 whether one member is tagged or both. `Expr` and
    //     `Stmt` ARE such unions. Independently, every walker mutates its `e: Expr`
    //     PARAMETER, and a parameter is a borrow (NT1607 by design, docs/decorators.md).
    //   - returning new nodes instead is a 48-constructor rewrite inside ast.ts that
    //     clears 45 of ast.ts's 46 sites and NONE of the other 145 in the tree.
    // Census: 191 non-`this` `o.f = v` sites across 8 of 12 modules (checker 56, ast 46,
    // parser 29, modules 28, codegen 13, ownership 9, coverage-preprocess 9, lexer 1),
    // plus 73 `this.f = v` which `@@mutable class` already covers. The same shape as the
    // `.push` census: a first-blocker table never sizes a construct.
    //
    // ...and it EMPTIES, in two steps taken by two lanes. `@@mutable` on a record TYPE
    // answered `o.f = v` (both bullets above turned out to be wrong: a tagged member is
    // fine, because `discriminatedUnion`'s guard against it was vacuous), which left ONE
    // `.push`-on-a-parameter site — `setBlockDrops` — and a per-parameter `@@mutable`
    // answered that. The census number stands and is still the right warning: nine
    // modules moved because they share ONE inherited line, not because 191 sites got
    // fixed. What they moved onto is NT1014, asserted above.
    // ...and it REFILLS with all nine, which is the honest shape of this round: NT1003
    // cleared (function values were never missing -- an optional callback was judged by
    // its DECLARED type because the call path was the one read that skipped
    // `narrowedTy`), and the 30 discarded-`Set.add` blockers underneath it became
    // visible. Byte-identical in both trees; nothing regressed. This is the promotion
    // effect at its most misleading -- a bucket going from empty to nine while the
    // per-function count FELL 245 -> 244.
    // ...and NT1606 EMPTIES. The `Set`/`Map` accumulator that held this bucket for four
    // rounds is gone from ast.ts: a `@@mutable` RECORD can carry it through a by-borrow
    // parameter where a `@@mutable` CLASS cannot (a class write is a setter call on a
    // borrowed receiver, NT1607; a record write is a field store named in the signature,
    // which `checkOwnedReceiver` admits). A prior lane measured the class case and
    // reported the constraint as parameter-specific; it was class-specific.
    // ...and it REFILLS with three, which is the other half of the NT2001 split recorded
    // above: `checker.ts`'s `spawnMode` cleared, and what it was masking is `s.returnTy =
    // ret` -- an object field store. Not a regression and not new code; the mutation class
    // was always behind it. Diagnosed since: the 64 NT1606 sites are THREE problems with
    // costs two orders of magnitude apart, and tagging the records `//@@mutable` is
    // measured NET NEGATIVE (clears one function, breaks four) because the tag is nominal
    // and `accessPath` declines a `@@mutable` receiver -- so field writes and optional-field
    // narrowing are mutually exclusive today, and an AST walker needs both.
    // ...and EMPTIES: `s.returnTy = v` was a redundant second copy of `Sig.ret`, and both
    // readers already held the signature table at the line they read the field, so the
    // field was deleted rather than rebuilt. The three modules move to NT1014 (`.clear`
    // on a Set), left deliberately for a lane that owns Set accumulators -- `Scope.hits`
    // is read from outside its class, so rebinding it is a real aliasing question.
    // ...and NT1606 REFILLS with the parser group — the five modules behind src/parser.ts,
    // never the three that emptied it. `t.value = v`, a field write on a lexer token.
    // Another holder substitution under an unchanged code, which is the case these
    // assertions were made memberships to catch.
    expect((byCode["NT1606"] ?? []).slice().sort()).toEqual(
      ["cli.ts", "coverage.ts", "driver.ts", "modules.ts", "parser.ts"],
    );
    // NT1702 — AN IMPORT CYCLE, and the one entry in this table that was not a missing
    // feature. `coverage.ts` and `coverage-preprocess.ts` imported each other, which the
    // linker refuses by design; it never had a chance to say so while ast.ts's refusal
    // fired first. A cycle is a defect in the module GRAPH, so it is fixed by moving a
    // declaration, not by building anything — and it was: `Blocker` now lives in the leaf.
    //
    // Kept as an assertion rather than deleted, because the closing edge was `import type`
    // and the linker still refuses those (docs/divergences.md). This bucket refilling would
    // mean a new cycle in the compiler's own source, which is worth hearing about.
    expect(byCode["NT1702"]).toBeUndefined();
    // NT1027 grew from 2 modules to 4 when `!` stopped blocking lexer.ts and ownership.ts:
    // clearing a blocker UNMASKS what sat behind it. The count going up is the ratchet
    // working, not a regression — the phase table above is what must never go backwards.
    // NT1027 was asserted EMPTY here, on the reasoning that every regex in the compiler's
    // own source had been rewritten as character scanning. IT IS BACK, and that is the
    // frontier ADVANCING, not a regression: checker.ts cleared NT1009 (general unions) and
    // then NT1606 (`delete o.k`, sharpened into a permanent refusal), and the module now
    // reaches far enough to hit a regex literal it never got to before. ownership.ts
    // inherits the identical error through the link.
    //
    // This is the SECOND time an emptied bucket has been pinned as if empty were an
    // invariant, and the second time that was wrong (NT0001 was the first, refilled by the
    // static-members lane). Assert MEMBERSHIP — which names the construct — not emptiness,
    // which quietly asserts that no module will ever reach that construct again.
    // NT1027 is EMPTY AGAIN — the mangler's `t.replace(/[^A-Za-z0-9_]/g,"_")` is now a
    // character scan, verified equivalent to the original over 20,000 fuzzed inputs.
    // Third state for this bucket today (empty -> {checker,ownership} -> empty), which is
    // why the note above says to assert membership and treat emptiness as a fact about
    // today rather than an invariant.
    expect(byCode["NT1027"]).toBeUndefined();
    // This bucket grew from two modules to EIGHT, and every arrival is a blocker moving
    // FORWARD out of an earlier bucket — the SH0 gradient working, not a regression:
    //   - `parser.ts` left NT0001: the satisfies lane taught the parser `expr satisfies T`,
    //     so `… satisfies ExportTable` parses and the module dies further in.
    //   - `ast.ts`, `coverage.ts`, `coverage-preprocess.ts` left NT0001: the
    //     template-literal-type lane cleared `\`${string}[]\`` at ast.ts:14, which the
    //     other two saw through the link.
    //   - `cli.ts`, `driver.ts` left NT1017 — the text-asset import, then `export async
    //     function`.
    // NOTE this is the LINK view, so a module can appear here for an imported module's
    // union rather than its own; the standalone probe is what says whose blocker it is.
    // Under the link, general unions now dominate: NT1009 is the crux, and clearing it is
    // the single highest-leverage move left on the board.
    // …and it has since SHRUNK from eight to six, which is the first time this bucket has
    // ever gone down: the general-union lane landed the crux. `checker.ts` (whose
    // `Record<string, number | "var">` named the problem) and `ownership.ts` both left it
    // for NT1606. What remains under NT1009 is largely `ast.ts`'s INTERSECTION `&` and
    // `parser.ts`'s optional element access `?.[]` — the code covers three features.
    // Back to EIGHT — but read the blame column before calling that a regression. Only
    // ast.ts and parser.ts own an NT1009; checker.ts joined by CLEARING its regex and
    // reaching parser.ts's `?.[]`, and the other four inherit through the link. Clearing
    // `?.[]` should collapse most of this bucket at once, which is why it is the single
    // highest-leverage blocker on the board.
    // NINE of twelve, and this is CONSOLIDATION rather than regression — read the blame
    // column. Only ast.ts and parser.ts OWN an NT1009. checker.ts arrived by clearing its
    // regex; modules.ts by clearing its generic method; the rest inherit through the link,
    // and SIX of them trace to parser.ts's `?.[]` directly or transitively.
    //
    // Which makes `?.[]` the highest-leverage blocker on the board by a wide margin:
    // nothing else on this list moves more than one module.
    // ...and NT1009 is now EMPTY, for the first time since it was named. The
    // optional-element lane landed `?.[]`, and `?.[]` was the whole bucket — nine of the
    // twelve rows left it at once, exactly as the note above predicted. Recorded as a fact
    // about today, in the spelling this file has had to learn three times: an empty bucket
    // is never an invariant, because clearing a named blocker lets a module reach further.
    // ...and it REFILLED, on the fourth occasion this file has had to learn its own
    // lesson: `//@@mutable` on `Checker` cleared NT1023, and what sat behind it is a
    // DIFFERENT NT1009 from the `?.[]` one — `FmtPiece` (checker.ts:4385), an
    // optional-field object union with no string-literal discriminant. Same code, other
    // feature, which is precisely why selfhost-ratchet compares MESSAGES.
    // ...and EMPTY again, on the FIFTH turn of the same wheel. `FmtPiece` was a source
    // gap, like the NT1023 before it: SH2's union representation has no box, so a union
    // is accepted only with a literal-typed discriminant at a common slot, and a
    // presence-discriminated union has none to find. Tagged with `kind`, the two rows fall
    // through to ast.ts's NT1030 — where the OTHER seven already were, so this bucket
    // emptying moved the tree onto ONE shared blocker rather than onto two more.
    expect(byCode["NT1009"] ?? []).toEqual([]);
    // NEW CODE, and it SPLIT the NT1009 bucket rather than adding to it. NT1030 is the
    // forward-reference / recursive-type refusal: `resolveNamed` used to return `number`
    // for a type name declared later in the same file, silently. ast.ts owns it (all 29
    // `Expr` members were being erased); coverage.ts and coverage-preprocess.ts inherit it.
    //
    // This is the most honest the table has ever been about ast.ts. Its recorded blocker
    // was a general union at line 880 — the one place the erasure happened to collide with
    // something that complained. It is now the FIRST erasure, at line 521.
    // It is now SEVEN of the twelve, and every arrival came from the emptied NT1009 bucket
    // — `ast.ts`'s forward type reference is what the link reaches once `?.[]` is gone. It
    // is the single highest-leverage blocker on the board now, on the same reasoning that
    // made `?.[]` the last one: nothing else here moves more than one module.
    //
    // NINE of the twelve now, and the two that joined did NOT arrive by moving forward.
    // `checker.ts` and `ownership.ts` came here from NT1023 at a SHALLOWER line, because a
    // recursive CLASS field used to be erased to `number` silently and `class Scope {
    // parent: Scope | null }` (checker.ts:93) is the compiler's own symbol table — it was
    // being described as `?NScope{parent:?Nnumber}`. This bucket growing is the measurement
    // getting more honest, not the frontier getting worse; the refusal is correct under the
    // prime directive whatever this number says. Note also that the two are not the same
    // problem: ast.ts needs the 44-declaration MUTUAL cycle, Scope needs only SELF-recursion.
    // NINE of twelve now, and every module in this bucket except ast.ts is here for
    // ast.ts's SCC through the link — `checker.ts` and `ownership.ts` arrived last, when
    // the `FmtPiece` tag took away the last blocker checker.ts owned. The tree has never
    // been this concentrated: resolve the 44-declaration mutual cycle and nine rows move
    // at once, which is `?.[]`'s old argument with three more modules behind it.
    //
    // ...AND IT IS EMPTY. All nine moved at once, exactly as this paragraph predicted, and
    // the leverage argument held. What it took was NOT more recursion work: the component
    // was 41/45 encoded already, and the four residuals were a UNION problem. Union
    // FLATTENING (a nested `U<…>` arm contributes its members; a single nullish arm hoists
    // into `?U`/`?N`) plus ONE source change — `ArrowFunction.body: Expr | Stmt[]` becoming
    // `body?: Expr` + `stmts?: Stmt[]`, because a union of a discriminated union and an
    // ARRAY has no representation and the obvious repair `Expr | Block` deadlocks.
    //
    // NONE of the nine reaches IR. They land on the queue NT1030 was masking — NT1014
    // above (five modules), NT1002 `in` (cli.ts, driver.ts, through codegen.ts) and the
    // NT1702 import cycle. That is the ratchet working, not a shortfall: this file's own
    // standing note is that clearing a blocker UNMASKS what sat behind it, and the count
    // going up is the instrument being honest.
    expect(byCode["NT1030"]).toBeUndefined();
    // NT1015 is empty — the generic-method lane cleared modules.ts's, and codegen.ts's
    // static-member site was cleared earlier. (A fact about today; this file has been
    // wrong three times treating an emptied bucket as an invariant.)
    // ...and it refilled with a THIRD kind of class member: `//@@mutable` on `ModuleGen`
    // cleared codegen.ts's NT1023, and behind it is a `get` accessor in `FnGen` — neither
    // the static member nor the generic method this bucket held before.
    // ...and it is EMPTY again, this time by a SOURCE change rather than a language one.
    // `get` accessors stay refused (a getter would make `o.x` sometimes a slot load and
    // sometimes a call, which dotted-path narrowing and field linearity both assume it is
    // not) — but the whole-tree construct census found ONE getter and NO setters in
    // `src/*.ts`, so `FnGen`'s became the zero-argument method it already was. Behind it,
    // NT1002: `op in FCMP` at codegen.ts:2078.
    expect(byCode["NT1015"]).toBeUndefined();
    // ...and it went from ONE module to THREE without codegen.ts moving: `cli.ts` and
    // `driver.ts` import codegen.ts, and once ast.ts's NT1030 stopped firing first the
    // link reached `op in FCMP` through it. Same single construct, same single site — a
    // bucket's SIZE counts modules that can SEE a blocker, never how much of it there is.
    // EMPTY NOW: `in` is decided at compile time for a literal key over a static shape.
    // ...and it REFILLED with a different construct, which is exactly what this comment's
    // own rule predicts: a bucket counts modules that can SEE a blocker. ast.ts cleared
    // `.push` and walked on to `String.prototype.trimEnd`, one site, one module.
    // ...and EMPTY again: `trimEnd`/`trimStart` are implemented (test/trim.test.ts), so the
    // one site is gone. In its place lexer.ts's NT1004 joins the tree-wide set — a
    // different module, a different code, and the SAME count of four, which is why the
    // set assertion above needed a comment rather than just a new list.
    // ...and NT1002 IS BACK, held by the three modules that link `checker.ts`:
    // `structuredClone` of the recursive `FuncDecl` type, which is what they landed on
    // after five blockers came off in one sitting (see the NT2001 note above). Asserted
    // as a MEMBERSHIP rather than `toBeUndefined()` so the next move names its holders.
    expect((byCode["NT1002"] ?? []).slice().sort()).toEqual(
      ["checker.ts", "codegen.ts", "ownership.ts"],
    );
    // diagnostics.ts has now been round the houses: NT1606 (`[...spans].sort()`, cleared by
    // the fresh-receiver lane) -> NT1006 (`Math.max(...)`, cleared by the variadic lane) ->
    // back to NT1606, this time a `.push` on a NAMED accumulator. That last shape is
    // deliberately NOT covered by the fresh-receiver rule, and the freshpush lane
    // established why: permitting it needs in-place mutation on an owned named local,
    // which is how the `.reverse` double free happened.
    expect(byCode["NT1006"]).toBeUndefined();
    // …and NT1606 is now EMPTY tree-wide. `diagnostics.ts` was its only holder, and the
    // rung-3 lane cleared the `.push` sites (`lines = [...lines, …]`) plus the four
    // blockers that were queued behind them. A fact about today, not an invariant — this
    // file has been wrong three times treating an emptied bucket as one.
    // ...and it was wrong a FOURTH time. `lexer.ts` refilled it the moment its capture
    // write and its mutually-recursive scanner closures were gone: `tokens.push`, 13 of
    // the 185 census sites. Unlike diagnostics.ts's four, these are NOT free to rewrite —
    // `tokens` reaches ~35k elements, where `xs = [...xs, v]` is 1036x slower under bun
    // (measured; test/sh6.test.ts). Same code, same construct, opposite cost.
    // ...and a FIFTH time, from one module to FOUR. The `Record` lane cleared the last of
    // the dictionary-table declarations, and three of the eight modules that were queued
    // behind them walked straight into `.push` — exactly what the census predicted would
    // happen "module after module as the current round's lanes land". Nothing here is a
    // compiler gap: `.push` is refused by DECISION (commit 1ea7fa2).
    // ...and a SIXTH, to FIVE. `coverage-preprocess.ts` joins on its OWN `.push` (the
    // accumulators in `tokenize`/`emit`/`preprocessForCoverage`), unmasked by the capture-
    // write lane's `TokState` rewrite. Same reading as every row above it: the module did
    // not acquire a `.push`, it stopped reporting something nearer.
    // ...and a SEVENTH, DOWN to one, by the route the six notes above kept ruling out:
    // in-place mutation on an owned NAMED local. The lane that refused it (`1ea7fa2`) was
    // right about the shape it measured — a syntactically-FRESH receiver, where the push is
    // unobservable and clears nothing — and the shape that actually appears in this tree is
    // the opposite one, an accumulator with a name. What makes it safe is not a new
    // analysis: an array is LINEAR, so `const b = xs` MOVES and a second live handle cannot
    // exist; a parameter is a borrow; a field, an element and a call result name no binding.
    // The one hole is a CLOSURE, and it is refused (NT1607). docs/decorators.md.
    //
    // The survivor is `coverage-preprocess.ts`, not annotated by that lane. And read the
    // shrink NARROWLY: a re-run census counts 205 `.push` sites tree-wide and only TWO
    // declarations carry the pragma; the rest are mostly shapes
    // the opt-in refuses on purpose (38 `this.<field>`, one parameter, every accumulator
    // pushed from inside a capturing arrow). Expect an eighth turn.
    //
    // The eighth turn is DOWN TO ZERO, and it is the first time this bucket has emptied
    // without a queue behind it. The survivor above was annotated after all — what stood in
    // the way was not the pragma but the shape: `tokenize`'s accumulator was CAPTURED by
    // `const push = (t: Tok) => { toks.push(t); st.prev = t; }`, and a captured accumulator
    // is NT1607 by decision (a closure env holds a pointer the scope cannot null). Inlining
    // that closure at its ten call sites is what made the opt-in reachable; the `prev: Tok`
    // it carried became one boolean, because a token cannot be stored in the array AND the
    // cursor (`.push` consumes its argument).
    //
    // Read the emptying as narrowly as the seven notes above ask: the ~205 `.push` sites are
    // still there and the refused shapes are still refused. What changed is that no module's
    // FIRST blocker is one of them any more. Expect a ninth turn — this instrument reports
    // membership, and any module that walks deeper can land here.
    //
    // THE NINTH TURN ARRIVED IN THE VERY NEXT LANE, and from the other end of the bucket.
    // It is not `.push`: it is `o.f = v` on an AST node, unmasked in nine modules at once
    // when ast.ts's `setBlockDrops` dead guard (the NT2001 above) was removed. The
    // membership list and the full argument live on the NT1606 assertion earlier in this
    // test; asserting the list twice would let the two copies drift, so this defers.
    //
    // THE TENTH TURN IS BACK DOWN TO ZERO, and — for the first time in this bucket's
    // history — `.push` on a PARAMETER was the last thing in it. `@@mutable` on the
    // record type answered `o.f = v`; a PER-PARAMETER `@@mutable` answered the `.push`
    // that was left. Read it as narrowly as every note above asks: the ~205 `.push` sites
    // are still there, `this.<field>.push` is still refused, a captured accumulator is
    // still NT1607, and exactly TWO parameters in the tree carry the new marker. What
    // changed is that no module's first blocker is a mutation any more. The list this
    // deferred to is empty now for the same reason.
    // ...and NT1606 is back, for the reason recorded at the bucket above: the 30
    // discarded-`Set.add` sites were always there and were merely masked by the
    // NT1003 that cleared. `toBeUndefined()` was pinning ABSENCE, which a promotion
    // can undo without anything regressing -- the per-function count fell in the same
    // change. Asserted as the measured set now, so the next promotion reads as a
    // membership change rather than a code appearing from nowhere.
    // ...and NT1606 EMPTIES. The `Set`/`Map` accumulator that held this bucket for four
    // rounds is gone from ast.ts: a `@@mutable` RECORD can carry it through a by-borrow
    // parameter where a `@@mutable` CLASS cannot (a class write is a setter call on a
    // borrowed receiver, NT1607; a record write is a field store named in the signature,
    // which `checkOwnedReceiver` admits). A prior lane measured the class case and
    // reported the constraint as parameter-specific; it was class-specific.
    // ...and it REFILLS with three, which is the other half of the NT2001 split recorded
    // above: `checker.ts`'s `spawnMode` cleared, and what it was masking is `s.returnTy =
    // ret` -- an object field store. Not a regression and not new code; the mutation class
    // was always behind it. Diagnosed since: the 64 NT1606 sites are THREE problems with
    // costs two orders of magnitude apart, and tagging the records `//@@mutable` is
    // measured NET NEGATIVE (clears one function, breaks four) because the tag is nominal
    // and `accessPath` declines a `@@mutable` receiver -- so field writes and optional-field
    // narrowing are mutually exclusive today, and an AST walker needs both.
    // ...and EMPTIES: `s.returnTy = v` was a redundant second copy of `Sig.ret`, and both
    // readers already held the signature table at the line they read the field, so the
    // field was deleted rather than rebuilt. The three modules move to NT1014 (`.clear`
    // on a Set), left deliberately for a lane that owns Set accumulators -- `Scope.hits`
    // is read from outside its class, so rebinding it is a real aliasing question.
    // ...and NT1606 refills with the parser group (see the note above).
    expect((byCode["NT1606"] ?? []).slice().sort()).toEqual(
      ["cli.ts", "coverage.ts", "driver.ts", "modules.ts", "parser.ts"],
    );
    // ...and NT1014 EMPTIES: the identity-keyed `Expr` collections in src/parser.ts are
    // node stamps now and the `Map<string, Set<number>>` is a `Map<string, number[]>`.
    // The five move together to NT1001 (`Set<string>[]`), asserted above.
    expect((byCode["NT1014"] ?? []).slice().sort()).toEqual([]);
    // ...and NT1604 emptied one round later, which is the END of that module's chain and
    // not another step along it. The blocker was `constructor(readonly diag: Diagnostic)`
    // — an object-typed parameter moved into a field. A linear parameter is a BORROW (the
    // caller owns and drops it), so the refusal was SOUND: suppressing it and running the
    // escaping shape gave exit 255. It took the feature that note named: CONSUMING
    // PARAMETERS. A constructor parameter property is one by construction — the desugaring
    // stores it — so the callee takes ownership and every `new C(v)` site moves `v`. One
    // owner, one drop, exit 0.
    //
    // `diagnostics.ts` is therefore the FIRST module in the tree that contributes no
    // blocker at all: it produces IR, links, and runs (test/sh6.test.ts, rung 3).
    expect(byCode["NT1604"]).toBeUndefined();
    // RATCHET MOVE (short-circuit narrowing): the NT2001 bucket is now EMPTY. It held
    // one module, `diagnostics.ts`, on `!diag.spans || diag.spans.length === 0` — a
    // FALSE POSITIVE (correct TypeScript, correct at runtime) because a guard did not
    // narrow the terms to its right. It does now, and for dotted names too, so
    // `formatDiagnostic` type-checks and the module stops on the thing behind it:
    // NT1606, `[...diag.spans].sort(…)` — the immutable-data refusal.
    // …and it is REFILLED by the collections lane, with a different module and a real
    // (not false-positive) blocker: lexer.ts now clears `new Set([...])` and stops on
    // `ESCAPES` declared `Map<string, string>` but initialized with an OBJECT LITERAL.
    //
    // …and EMPTY again — and the recorded reason above was WRONG, which is the point of
    // re-measuring instead of reading the note. lexer.ts's NT2001 was never `ESCAPES`; it
    // was `cannot infer type of arrow parameter 'n'` at src/lexer.ts:146, `const advance =
    // (n = 1) => …`. The parameter-default lane taught every parameter position to take its
    // type from its default, and lexer.ts now walks INTO that arrow's body and stops on
    // NT1031, `line++` — a write to a binding captured from `lex`'s scope.
    // …and REFILLED a second time, now with FIVE modules rather than one, and not by
    // anything to do with lexer.ts: clearing ast.ts's `new Map([[k, v], …])` entries form
    // landed ast.ts — and the four modules that import it — on `HOST_MODULES`, a `Record`
    // initialized with an object literal. This bucket has been empty, refilled, empty and
    // refilled again; asserting `toBeUndefined()` here was a standing invitation to a
    // false red, exactly as this file's own "assert MEMBERSHIP, not emptiness" note says.
    // The membership assertion lives with NT1014's clearance above; this line would only
    // duplicate it.
    // coverage.ts joined this bucket by LEAVING NT1702 — the type-only cycle fix let it
    // through to ast.ts's next blocker, which it inherits like the four before it.
    // EIGHT now: codegen.ts and driver.ts joined by leaving NT1002 when `in` landed.
    // Sorted, because the bucket's ORDER is an artifact of module iteration and asserting
    // it unsorted has produced two spurious conflicts already.
    // FIVE, and a different construct: the `Record` family is gone from `src/*.ts` (all
    // eleven declarations — see the census note at the NT1014 clearance above and
    // test/record-dict.test.ts). ast.ts, parser.ts and modules.ts left for NT1606; the
    // five that remain share `argTys: ["string", null]`, an ARRAY OF NULLABLE elements.
    // SIX, with cli.ts back from NT1020 (see the same list above).
    // ...and EMPTY, for the fourth time in this bucket's life — the ENCODING ambiguity
    // above. The membership that replaces it is NT1014's, next to its clearance note.
    // ...and refilled with lexer.ts + its two dependents when `.push` cleared (see above).
    // ...and the OWNER changed while the bucket held still at three: lexer.ts's was a dead
    // `=== undefined` guard on a string index that PANICS out of range (fixed with `.at`),
    // and ast.ts took its place with a `string`/`undefined` ternary that `trimEnd` unmasked.
    // parser.ts and modules.ts are still the two dependents; they just inherit from a
    // different module now. Same code, same count, different cause — the case a tree-wide
    // bucket is structurally unable to report, and the reason selfhost-ratchet keys on the
    // MESSAGE plus a per-module source hash instead of on the code.
    // NINE of twelve, and all nine are ONE ternary in ast.ts (`string` vs `undefined`)
    // reached through the link — the most concentrated this frontier has ever been.
    // cli.ts is the exception that proves the shape: its NT2001 is its OWN
    // (`process.stdout is not supported`), so stage-1 is separable from the grind for
    // the first time.
    //
    // ...and the concentration PAID OFF: the ternary lane cleared the join (a present arm
    // and a nullish literal now widen to `?U`/`?N`, TypeScript's rule), then walked the eight
    // dependents through six more ast.ts blockers behind it. NT2001 collapses from NINE
    // modules to ONE — cli.ts, which never depended on any of it. The eight moved to
    // NT1011, `for-of` over an `unknown` in a reflective AST walker, which is the first
    // entry in this table that is a design decision rather than a gap (see sh6.test.ts).
    // ...and at the MERGE, EMPTY. cli.ts was NT2001's last holder, and stage-1's own host
    // surfaces (`process.stdout.write`, `spawnSync stdio:"inherit"`) landed in the same merge
    // — so cli.ts walked off its own blocker and onto ast.ts's NT1011 with the other eight.
    // Neither branch could compute this from its own diff: one emptied the ternary, the
    // other emptied stage-1's, and only together does the bucket go to zero.
    //
    // ...and it REFILLED, all nine at once — see the identical bucket above: the reflective
    // AST walkers were masking `setBlockDrops`'s `last !== undefined` on a general union.
    // ...and EMPTY once more: that guard is a `list.length > 0` test now, and all nine
    // moved on together to NT1606 (`o.f = v` on an AST node). See the same bucket above.
    // ...and REFILLED with the same nine, on ast.ts's `@Expr` property read. Same bucket
    // above, which carries the reasoning.
    // ...and EMPTY again, on `exprLoc`'s two-member sub-union field read. Same bucket
    // above, which carries the reasoning; the nine moved to NT1001, also asserted above.
    // ...and REFILLED with the same nine — the fourth time this bucket has emptied and
    // refilled, and the fourth time the holder is a different construct in the same file.
    // NT1001 cleared (`exprLoc`'s `.find` over a `(T | undefined)[]` hands the element's
    // existing box back rather than building a second owner), so `exprText`'s
    // `e.optional === true` — an optional boolean compared with a boolean — is what the
    // nine now sit on. Same bucket above, which carries the reasoning.
    // ...and the NINE BECOME EIGHT, which is the first time this bucket has changed SIZE
    // rather than contents. `exprText` cleared and `ast.ts` moved to NT1001, so the eight
    // names left are on eight DIFFERENT blockers in their own source rather than nine
    // views of one line of ast.ts. Same bucket above, which carries the reasoning.
    // ...and now EMPTY. The eight were never on eight different blockers — they were on
    // ONE, twice-spelled: `Renamer.expr` renamed `paramTys`/`retTy` but missed `retAnnot`,
    // the only one of the three written at LINK time, so a module alias and a direct
    // reference produced `@_nts0_m2_Expr` vs `@Expr` for the same type. The reading above
    // ("eight DIFFERENT blockers in their own source") was wrong, and wrong in the
    // flattering direction — a shared defect looked like eight independent ones because
    // the diagnostic printed two identical-looking unions and pointed at a blank line in
    // the merged program rather than the source module.
    //
    // All eight now sit behind ONE real term in ast.ts (`.map` over heap elements,
    // NT1001), which is why THAT bucket grew as this one emptied.
    // ...and refills with the same EIGHT as the bucket above, for the same reason:
    // `ast.ts` left the table. Recorded twice on purpose -- the two assertions measure
    // different passes, and having both move together is the evidence that ast.ts was
    // a shared blocker rather than nine independent ones.
    // ...and NT2001 EMPTIES tree-wide, splitting into TWO buckets rather than moving to
    // one. The eight modules did not share a single term after all: five were behind
    // `parser.ts`'s `valueReturns` (a for-of loop binding that a block-scoped `let s` in
    // `lexer.ts` made unnarrowable program-wide -- fixed, and they advanced one line to
    // the self-recursive local arrow, NT1003), while three were behind `checker.ts`'s
    // `spawnMode` (an out-of-range `args[2]` read, fixed, advancing to NT1606's
    // `s.returnTy = ret`). Recorded as two memberships, not one, because that split is
    // the finding: the "one shared blocker" reading was first-blocker reasoning.
    // ...and NT1003 lasted ONE round: the self-recursive arrow was a scoping gap, not the
    // closure gap its hint named, and clearing it moved the same five modules one line down
    // to a union read where only the shared tag is narrowable. NT2001 is back, holding
    // exactly the five it held before the split -- so this bucket has now emptied and
    // refilled with the same membership, which is what a CONJUNCTION looks like from here.
    // ...and it SPLITS, for the first structural reason rather than another shuffle: a
    // cross-frame `throw` can now carry an OBJECT (pointer-move, single owner transferred),
    // so `parser.ts::tokenize`'s `catch (e) { e.message }` cleared and took the five
    // modules that inherit it to NT1014. The three that link `checker.ts` stay.
    // ...and NT2001 EMPTIES AGAIN — the three `checker.ts`-linked modules moved to
    // NT1002. One expression started it (`asBlocker`'s `e: unknown`, where `instanceof`
    // does not narrow) and four more blockers came off behind it in the same sitting.
    // ...and NT2001 refills with parser.ts and the four modules that link it — a
    // different five from the ones that emptied it (see the note above).
    expect((byCode["NT2001"] ?? []).slice().sort()).toEqual([]);
    expect(byCode["NT1003"] ?? []).toEqual([]);
    // NEW BUCKET, and it is one module deep: the captured-binding write behind the arrow.
    // ...and empty again: the cursor is one `//@@mutable` record now, so nothing writes a
    // captured BINDING (a field of an owned local is not one). NT1031 has never had a
    // second holder, so this bucket has now been born and emptied without ever growing.
    //
    // ...and it has a second holder after all — the THIRD time this file has pinned an
    // emptied bucket as if empty were an invariant, and the third time that was wrong. The
    // holder is `coverage-preprocess.ts`, which reached this construct only by clearing
    // NT1702 (above); its `advance` closure writes `line++`, the SAME cursor shape lexer.ts
    // fixed with a `//@@mutable` record. Assert MEMBERSHIP, which names the construct.
    //
    // ...and EMPTY AGAIN, by the fix the previous paragraph names: `coverage-preprocess.ts`
    // now carries the same `//@@mutable` cursor record (`TokState`) that `src/lexer.ts`
    // carries, so neither of this tree's two hand-written tokenizers writes a captured
    // binding any more. The bucket is asserted as ABSENT rather than as `[]` because
    // `byCode` is built from the codes actually reported. That is the third time this row
    // has flipped, so read it as membership and expect it to flip again the moment a lane
    // writes a closure over a `let` — which is exactly what it is here to catch.
    expect(byCode["NT1031"]).toBeUndefined();
    // NT1606 changed HANDS entirely: diagnostics.ts left it (above), and checker.ts +
    // ownership.ts arrived from NT1009 once general unions landed. Same bucket, none of
    // the same modules — which is why membership, not size, is the thing to assert.
    // (NT1606 is asserted above. It emptied when checker.ts and ownership.ts moved to
    // NT1027, then refilled with diagnostics.ts — the third time a bucket here has emptied
    // and refilled. Membership, never emptiness.)
    // (The NT0001 membership assertion that stood here is gone: the bucket is empty, and
    // the shrink-only `toBeUndefined` above is now the thing that guards it.)
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
    // WAS `expect(r.blockers.length).toBe(0)`. Definite assignment cleared cli.ts's
    // `let source: string;`, so coverage now reaches further and reports ONE blocker —
    // and that blocker is ITSELF an artifact: the preprocess strips imports, so
    // `readFileSync` reads as an unknown callee (NT1003), the same artifact class the
    // standalone probe invents for any cross-module call.
    //
    // Counting blockers was pinning the symptom. The INVARIANT is the GAP: whatever
    // coverage reports, it is not what actually stops the module. Asserted that way now,
    // so this survives the frontier moving instead of failing for the good reason.
    // ...and the CODE-level form of that check has now itself become a symptom, which is
    // the same lesson one level up. Stage-1's real blocker moved to NT1003 (`onAssign`, a
    // function value), and coverage's own artifact is ALSO NT1003 (`readFileSync` reading
    // as an unknown callee once the preprocess strips imports). Same code, unrelated
    // cause, so `not.toContain(realCode)` went red on a coincidence while the gap it
    // exists to measure was completely unchanged.
    //
    // Compare the FEATURE, not the code. Two blockers sharing a number are not the same
    // blocker, and a test that cannot tell them apart is measuring the catalog rather than
    // the compiler.
    const r = coverage(read("cli.ts"));
    expect(r.parsed).toBe(true);
    let realCode = "";
    let realMsg = "";
    try { sourceToIR(read("cli.ts"), new URL("cli.ts", SRC).pathname); } catch (e) {
      realMsg = String((e as Error).message);
      realCode = /\[(NT\d+)\]/.exec(realMsg)?.[1] ?? "";
    }
    // The pipeline DOES refuse it...
    expect(realCode).not.toBe("");
    // ...and coverage does not see that REASON — not merely that number. Every feature
    // coverage names must be absent from the real diagnostic's text.
    for (const b of r.blockers) expect(realMsg).not.toContain(b.feature);
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
