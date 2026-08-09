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
    // "An empty NT0001 bucket" was previously called the meaningful invariant. It is NOT,
    // and the static-members lane is the counter-example: `codegen.ts` cleared NT1015 and
    // the module then reached FURTHER and stopped on an unnamed parse error at 582:33.
    // NT0001 is the generic parse-error code, so clearing a NAMED blocker can legitimately
    // refill it — the bucket growing means the frontier moved, not that anything regressed.
    // What this table is for is naming each survivor explicitly, so a NEW one is a
    // deliberate entry rather than a silent arrival.
    // EMPTY AGAIN — and this time every remaining blocker in the tree carries a NAMED
    // code, which is the property actually worth having. codegen.ts's entry was
    // `Expected ']' but found 'program'`, which the indexed-access lane identified as
    // `T["field"]` and gave a real diagnostic.
    //
    // Kept as a table rather than a bare assertion so a NEW anonymous parse failure has to
    // be added here deliberately. Do NOT read an empty table as an invariant: this bucket
    // has emptied and refilled twice, because clearing a named blocker lets a module reach
    // further and hit an unnamed one behind it.
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
    //
    // It went to TWO when clearing `new Set(iterable)` (NT1014) in coverage-preprocess.ts
    // UNMASKED the `.push` behind it, and is back to ONE now: checker.ts's `delete o.k`
    // moved out when that refusal was sharpened, and the module walked on to a regex
    // literal (NT1027). The remaining entry is the real one — coverage-preprocess.ts's
    // named accumulators, which the fresh-receiver rule deliberately does NOT cover.
    // ZERO now. checker.ts's `delete o.k` left when that refusal was sharpened, and
    // coverage-preprocess.ts's `.push` left when the Record lane rewrote ESCAPES as a
    // `switch` and the module walked past it. NT1606 no longer blocks any src module.
    //
    // The `.push` on a NAMED accumulator is still REFUSED as a language rule — the
    // fresh-receiver rule deliberately does not cover it, because permitting it needs
    // in-place mutation of an owned named local, which is how the `.reverse` double free
    // happened. It simply no longer appears in the compiler's own source.
    //
    // BACK TO ONE, and it is the SAME file and the SAME construct as the "went to TWO"
    // paragraph above — the third time this bucket has refilled from coverage-preprocess.ts
    // alone. Nothing was added to that module: the capture-write lane replaced its
    // `line`/`prev` cursor with one `//@@mutable` record (`TokState`, mirroring
    // `src/lexer.ts`'s `LexState`), which cleared its NT1031 and unmasked the `.push`
    // accumulators that have been in `tokenize`/`emit`/`preprocessForCoverage` since the
    // file was written. Read this row as membership, not as the compiler getting worse:
    // an emptied bucket coming back is what "clearing a blocker unmasks the next" looks
    // like from a census instrument.
    //
    // It is left as `.push`, deliberately. The sanctioned idiom `xs = [...xs, v]` is
    // measured at 1036x under bun at real accumulator sizes (docs/self-hosting.md), and
    // `src/*.ts` has to keep RUNNING under bun — so rewriting a tokenizer's per-token
    // accumulator that way is an owner decision, not a lane's.
    expect(nt1606).toEqual([
      { file: "coverage-preprocess.ts", feature: "arrays are immutable: `.push` would mutate the array in place" },
    ]);
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
    // RE-MEASURED CENTRALLY. NT0001 has LEFT this histogram entirely — the indexed-access
    // lane named codegen.ts's last anonymous parse failure (now NT1023), so every code
    // here is a named feature. NT1014 survives as `new Map([[k, v], …])` in ast.ts: the
    // Set forms and the Map-COPY form compile now, the ENTRIES form still needs a tuple.
    //
    // RE-MEASURED BY THE `?.[]` LANE. Two edits to this list, one earned and one owed:
    //
    //   NT1009 is GONE — optional element access was its last two sites (parser.ts and
    //   checker.ts) and both now compile. The code spans three unrelated features
    //   (general unions, intersections, `?.[]`), which is why it was asserted per-feature
    //   rather than by count; all three are clear of the compiler's own source now.
    //
    //   NT1031 is `coverage-preprocess.ts`'s `line++` on a captured binding — a REAL
    //   blocker, and a newly VISIBLE one rather than a newly created one.
    //
    //   Attribution, corrected by bisect rather than inferred: this gate was GREEN at
    //   abf0185 and RED at 877e6d9, so the renumber (943f4fe, NT1029 -> NT1031) did NOT
    //   cause it. 877e6d9 did, and for a good reason. That commit fixed a CRASH in the
    //   capture-write walkers (an unguarded `d.init` on a bare `let x: T;`), and the
    //   crash had been aborting the analysis BEFORE it could report this blocker. So the
    //   pass did not start refusing something new; it started finishing, and told the
    //   truth about a refusal it had been swallowing.
    //
    //   That is worth stating plainly because it inverts how the red reads: the fix did
    //   not break this gate, it revealed that the gate had been measuring a compiler
    //   that crashed. A histogram assembled from a pass that dies partway is not a
    //   smaller histogram, it is a wrong one.
    //
    //   NT1031's count is ONE, and the parameter-default lane's merge is the reason to
    //   say so explicitly. That lane predicted a SECOND site: `const advance = (n = 1) =>
    //   { … line++ … }` at src/lexer.ts:146 used to fail as NT2001 "cannot infer type of
    //   arrow parameter 'n'" — a type ERROR, which this histogram deliberately does not
    //   count — and inferring the parameter from its default makes it type-check, so the
    //   statement should fall one layer deeper onto the NAMED `line++` capture write.
    //
    //   It does, and this histogram still does not see it. MEASURED, not assumed:
    //   `coverage(src/lexer.ts).blockers` is `[]` while the standalone pipeline on the
    //   same file reports NT1031 on that exact `line++`. The two instruments disagree
    //   because `coverage` runs a recovery preprocess (src/coverage-preprocess.ts) and
    //   the real pipeline does not — the same confound that once had cli.ts reported
    //   `parsed: true` with zero blockers while it did not survive the lexer.
    //
    //   So: a clean row here is NOT evidence a module is clean. The standalone column of
    //   test/selfhost-ratchet.test.ts is the one that answers that question, and for
    //   lexer.ts the two now say opposite things.
    // NT1030 joined via checker.ts — `class Scope { parent: Scope | null }` at line 93, a
    // recursive CLASS field that used to be erased to `number` silently. Note this
    // histogram recovers statement-by-statement, so checker.ts contributes to NT1023 AND
    // NT1030 at once; the first-blocker instruments (sh6, bootstrap, selfhost-ratchet) show
    // it moving from one to the other, because they stop at the first. Two views of one
    // change, and neither is wrong — see the "moved shallower" rule in selfhost-ratchet.
    // NT1023 IS NOW ZERO TREE-WIDE, and this histogram is the instrument that says so —
    // it counts the CONSTRUCT (statement-by-statement recovery), not the first blocker,
    // which is the distinction docs/self-hosting.md's standing correction is about. Two
    // classes held all of it, `Checker` and `ModuleGen`, and both are accumulators rather
    // than copy-on-write values, so they now carry `//@@mutable` exactly as
    // `Parser`/`FnGen`/`Analyzer` already did. There is no third class behind them: this
    // bucket did not shrink, it emptied.
    // NT1015 then emptied the same way, and the census is again what says so: this
    // instrument counts the construct, and `get`/`set` accessors number ONE and ZERO across
    // all twelve modules. Accessors stay refused (NT1015 with a hint naming the rewrite);
    // `FnGen`'s lone getter became the zero-argument method it already was, and NT1002
    // (`op in FCMP`) is what sat behind it.
    // NT1014 left this histogram when `src/ast.ts`'s `DATE_GETTERS` stopped being written
    // as `new Map([[k, v], …])`. **DO NOT READ THAT AS "the entries form is gone from the
    // tree."** It is not, and this instrument cannot see the difference: unlike the NT1023
    // and NT1015 rows above — which emptied because a CENSUS said there was no second site
    // — this row emptied because the entries form is no longer any FILE'S first blocker.
    // Counted with a readFileSync scan rather than shell grep, five sites remain, each
    // verified standalone to be reachable and still NT1014:
    //   src/checker.ts:4524 CONSOLE_STREAMS, :4565 FMT_SPECS  (literal, `as const`)
    //   src/modules.ts:431, :574                              (literal, one computed pair)
    //   src/ast.ts:1204  `new Map(p.recTypes ?? [])`          (a [string, Ty][] argument)
    // plus two `.map`-produced tuple arrays (src/ownership.ts:111, :884) and one in
    // src/codegen.ts:1052 that need a real tuple TYPE, not the `new Map` argument position.
    // The sanctioned `.set`-chain rewrite is verified to compile for each of the first
    // five; they are left for a lane that can also measure the movement.
    // NT1002 LEFT when `in` landed — decided at compile time for a literal key over a
    // static shape, the same move `instanceof` made.
    //
    // THREE CODES ARRIVED AT ONCE when the `Record` lane cleared the dictionary tables,
    // and none of them is a new gap in the compiler — each is a construct that has been
    // sitting in `src/*.ts` all along, MASKED in this histogram because the file's
    // recovered statement stream stopped on the `Record` mismatch first:
    //   NT1002  ast.ts     — `t.endsWith("[]")` where `t: Ty`. An artifact of THIS tool:
    //                        coverage strips type declarations, so `Ty` is unknown and
    //                        erases to `number`, and a `number` has no `.endsWith`.
    //   NT1012  codegen.ts — `new DataView(new ArrayBuffer(8))` at src/codegen.ts:34,
    //                        unchanged since it was written.
    //   NT1001  checker.ts — `argTys: []`, an empty array literal whose element type comes
    //                        from a context this recovery mode cannot see.
    // NT1002 refilling is the FOURTH time this file has had an emptied bucket come back;
    // read the buckets as membership, and read a NEW code as "what was behind the old one",
    // not as "the compiler got worse".
    // NT1031 -> NT1606, one swap, one file. `coverage-preprocess.ts`'s `line++`/`prev = t`
    // capture writes are gone — its `tokenize` cursor is now ONE `//@@mutable` record, the
    // shape `src/lexer.ts` used to clear the identical blocker — and the `.push`
    // accumulators that were always behind them are what the histogram sees instead. The
    // corpus evidence that the rewrite is observationally null is a byte-for-byte diff of
    // old vs new `preprocessForCoverage` over all 486 `.ts` files in src/, test/ and
    // examples/ (0 differences), with three mutations of the rewritten lines each redding
    // it (133/22/466 files) so the null result is known to be reached rather than skipped.
    expect([...hist.keys()].sort()).toEqual(
      ["NT1001", "NT1002", "NT1003", "NT1012", "NT1606"],
    );
    expect(hist.get("NT1009")).toBeUndefined();
    // The frontier is not just flat, it is THIN: the largest bucket is 2 (NT1003, the
    // `async`/`await` pair in driver.ts and cli.ts — NT1023's two sites are gone), and
    // every other named code has exactly one site left in the whole tree.
    expect(Math.max(...hist.values())).toBe(2);
    // NT1606 is BACK, at one site, and it is not a new construct: see the NT1031 -> NT1606
    // note above. It is asserted by COUNT rather than by absence, because the number is the
    // thing that would move if a `.push` were added to the compiler's own source, and this
    // histogram is the only instrument here that counts the construct rather than the
    // first blocker.
    expect(hist.get("NT1606")).toBe(1);
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
