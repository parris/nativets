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
    expect(Object.keys(byCode).sort()).toEqual(
      ["NT1002", "NT1014", "NT1606", "NT1702"],
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
    expect(byCode["NT1014"]).toEqual(["ast.ts", "parser.ts", "checker.ts", "ownership.ts", "modules.ts"]);
    // NT1702 — AN IMPORT CYCLE, and the one entry in this table that is not a missing
    // feature. `coverage.ts` and `coverage-preprocess.ts` import each other (directly or
    // through a third module), which the linker refuses by design; it never had a chance
    // to say so while ast.ts's refusal fired first. A cycle is a defect in the module
    // GRAPH, so it is fixed by moving a declaration, not by building anything.
    expect(byCode["NT1702"]).toEqual(["coverage.ts", "coverage-preprocess.ts"]);
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
    expect(byCode["NT1002"]!.sort()).toEqual(["cli.ts", "codegen.ts", "driver.ts"]);
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
    expect(byCode["NT1606"]!.sort()).toEqual(["lexer.ts"]);
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
    expect(byCode["NT2001"]).toBeUndefined();
    // NEW BUCKET, and it is one module deep: the captured-binding write behind the arrow.
    // ...and empty again: the cursor is one `//@@mutable` record now, so nothing writes a
    // captured BINDING (a field of an owned local is not one). NT1031 has never had a
    // second holder, so this bucket has now been born and emptied without ever growing.
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
    const r = coverage(read("cli.ts"));
    expect(r.parsed).toBe(true);
    const covCodes = r.blockers.map((b) => b.code);
    let realCode = "";
    try { sourceToIR(read("cli.ts"), new URL("cli.ts", SRC).pathname); } catch (e) {
      realCode = /\[(NT\d+)\]/.exec(String((e as Error).message))?.[1] ?? "";
    }
    // The pipeline DOES refuse it...
    expect(realCode).not.toBe("");
    // ...and coverage does not see that reason. That is the gap, and it is the point.
    expect(covCodes).not.toContain(realCode);
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
