/*
 * SH-RATCHET — the per-module BLOCKER ratchet, with cause attribution.
 *
 * ---- The hole this closes ----
 * `docs/self-hosting.md` (§"Re-measured at SH6"): "The gap is being widened by ordinary
 * feature work. Two of the blockers above were planted by recent, unrelated stages:
 * `new Set([...])` arrived with the regex-lexing table, and the text import arrived with
 * the single-binary embed. Neither author was doing self-hosting work." What caught that
 * was `test/bootstrap.test.ts` — a per-module PHASE floor plus the set of NT codes present
 * TREE-WIDE. "The remaining hole: a module regressing to a code ALREADY in the set is
 * invisible to both."
 *
 * It is worse than the doc says, and the worse part is the reason this file exists. Every
 * existing instrument measures the WHOLE-PROGRAM LINK (`sourceToIR(source, entryPath)`),
 * where most modules do not report their own blocker at all — they report a dependency's.
 * With six modules currently inheriting `parser.ts`'s blocker through the link, a refused
 * construct planted in any one of them changes NOTHING that is measured today:
 *
 *   - `bootstrap.test.ts` phase floor        — unchanged (the module still only `parsed`)
 *   - `bootstrap.test.ts` tree-wide code set — unchanged (the planted code is already in it)
 *   - `sh6.test.ts` rung floor               — unchanged (still rung 0)
 *   - `sh6.test.ts` per-module `code` map    — unchanged (the LINKED code is the dep's)
 *   - `self-host-coverage.test.ts` histogram — unchanged (its checker contributes at most
 *                                              ONE blocker per file, and only NT1xxx)
 *
 * Verified, not assumed: see the lane report for the reproduction (`new Set([...])` planted
 * in `src/modules.ts` in a scratch tree moves none of the five, and reds this file).
 *
 * ---- What this file adds, and what it deliberately does not ----
 * It does NOT add a fourth scale. There is no new phase/rung vocabulary here: rung 0/1 is
 * still `sh6.test.ts`'s, the phase ladder is still `bootstrap.test.ts`'s. What is new is
 * three things those two do not have:
 *
 *   1. a STANDALONE column — the module compiled as its OWN program, no link — which is
 *      the only column that says whose gap it is (docs/self-hosting.md's confound);
 *   2. blocker identity by MESSAGE, not by NT code, because one code spans several
 *      features (`NT1009` is general unions AND intersections AND `?.[]`) so a code
 *      comparison cannot tell a module regressing to a different `NT1009` from holding;
 *   3. CAUSE ATTRIBUTION, which is what makes a changed blocker actionable instead of a
 *      thing to rubber-stamp. See below.
 *
 * ---- Distinguishing PROGRESS from REGRESSION ----
 * Clearing a blocker UNMASKS the next one, so a CHANGED blocker is the normal, constant
 * state of this project — `sh6.test.ts`'s per-module code map reds all twelve rows every
 * time a lane lands, which trains people to re-record without reading. A phase/rung floor
 * does not help: both movements sit inside `parsed`/rung 0.
 *
 * The discriminator is a CONTROLLED EXPERIMENT, not a heuristic. A module's blocker is a
 * function of exactly two inputs — the module's own source, and the compiler. So record
 * the hash of the source alongside the blocker, and the two causes separate:
 *
 *   source hash UNCHANGED, blocker changed  -> only the COMPILER can be responsible.
 *                                              That is the frontier moving. PASSES.
 *   source hash CHANGED,   blocker changed  -> the module's own source is what changed
 *                                              what stops it first. FAILS, names both
 *                                              blockers, and says what to do.
 *
 * That asymmetry is the whole design. The common case — a lane clears a blocker in
 * `checker.ts` and nine modules move — is auto-classified as progress and stays GREEN.
 * The case the doc describes — an unrelated stage plants a construct in the module it was
 * editing — is the only one that reds. Two more rules are unconditional:
 *
 *   - a module that reached IR may never stop reaching IR (either cause, hard fail);
 *   - a blocker may never move to an EARLIER pipeline stage (either cause, hard fail),
 *     which is a per-column, finer-grained restatement of the phase floor.
 *
 * `git` is deliberately NOT an input to any verdict: `actions/checkout` fetches depth 1,
 * so a git-informed verdict would differ between a laptop and CI, and CLAUDE.md records
 * that "a green local run is not a green CI run" as a hazard already paid for twice. Git
 * history is used only to ENRICH a failure message, never to decide one.
 *
 * ---- Re-recording (deliberately, in one command) ----
 *   NT_RECORD=1 bun test test/selfhost-ratchet.test.ts
 * rewrites `test/selfhost-ratchet.baseline.json` from today's measurement and prints the
 * diff it applied. Nine lanes move these numbers, so the baseline is generated, sorted and
 * one-line-per-field on purpose: a re-record is a reviewable diff, not a hand edit.
 *
 * ---- What it cannot see (stated, because an instrument that overstates is worse than none) ----
 * The STANDALONE column is blind for a module whose first standalone error is the
 * unlinked-import artifact (`NT1003 … checked WITHOUT linking`): `driver.ts` and
 * `coverage.ts` call an imported function before they reach anything else, so their own
 * gap is invisible until the link, where a dependency's blocker dominates. Those rows are
 * marked `artifact` and their message is canonicalized, so they never red for a reason
 * that is not about them — and so nobody reads them as "no gap".
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { lex } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";
import { analyzeOwnership } from "../src/ownership.ts";
import { codegen } from "../src/codegen.ts";
import { linkProgram } from "../src/modules.ts";
import { sourceToIR } from "../src/driver.ts";

const SRC = new URL("../src/", import.meta.url);
const pathOf = (m: string) => new URL(m, SRC).pathname;
const read = (m: string) => readFileSync(pathOf(m), "utf8");
const BASELINE_PATH = new URL("./selfhost-ratchet.baseline.json", import.meta.url).pathname;

/* ============================================================
 * Measurement
 * ============================================================ */

/**
 * Pipeline stages, in the order a program passes through them. A blocker's stage is the
 * one that threw, so a blocker moving to a LOWER rank means the module stops EARLIER than
 * it used to — a regression whatever caused it. `clear` is the top and means nothing
 * threw: `codegen` returned LLVM IR.
 *
 * (`link` only exists in the linked column; the standalone column skips it by
 * construction. That is the point of having two columns.)
 */
const STAGES = ["lex", "parse", "link", "check", "ownership", "codegen", "clear"] as const;
type Stage = (typeof STAGES)[number];
const stageRank = (s: Stage) => STAGES.indexOf(s);

interface Blocker {
  stage: Stage;
  /** NT code, or "other" for an error carrying none (an internal error, a raw throw). */
  code: string;
  /** First line of the message, with positions normalized away — see `normalize`. */
  message: string;
  /** True when this is the unlinked-import artifact, not a gap. Standalone column only. */
  artifact?: true;
}

/** A cleared column: nothing threw. Recorded as a first-class value, not as absence. */
const CLEAR: Blocker = { stage: "clear", code: "", message: "" };
const isClear = (b: Blocker) => b.stage === "clear";

/**
 * Positions are NOT part of a blocker's identity. `sh6.test.ts` records why: it pinned
 * `at 1109:66` and an unrelated lane adding parsing code ABOVE that line shifted it to
 * 1169:66, reddening a test while nothing had moved. A position is not the fact.
 */
function normalize(message: string): string {
  return message
    .split("\n")[0]!
    .trim()
    .replace(/\b\d+:\d+\b/g, "L:C")
    .replace(/\bline \d+\b/g, "line N");
}

/**
 * The unlinked-import artifact, canonicalized. `check(parse(source))` on a module that
 * CALLS an imported function reports the callee as a missing binding — a fact about the
 * measurement, not about the module. Which callee it names depends on statement order, so
 * recording the raw message would red this file every time an import moved.
 */
function artifactOf(code: string, message: string): Blocker | null {
  if (code === "NT1003" && message.includes("checked WITHOUT linking")) {
    return { stage: "check", code: "NT1003", message: "unlinked-import artifact (standalone view is blind past this point)", artifact: true };
  }
  return null;
}

function blockerFrom(stage: Stage, e: unknown): Blocker {
  const err = e as { message?: string; diag?: { code?: string } };
  const message = normalize(String(err?.message ?? e));
  const code = err?.diag?.code ?? /\[(NT\d+)\]/.exec(message)?.[1] ?? "other";
  return artifactOf(code, message) ?? { stage, code, message };
}

/**
 * STANDALONE — the module compiled as its own whole program: lex, parse, check, ownership,
 * codegen, with NO link. Every stage `sourceToIR` runs except `linkProgram`, so a blocker
 * here belongs to THIS module and nothing else.
 */
function measureStandalone(source: string): Blocker {
  try { lex(source); } catch (e) { return blockerFrom("lex", e); }
  let program;
  try { program = parse(source); } catch (e) { return blockerFrom("parse", e); }
  let checked;
  try { checked = check(program); } catch (e) { return blockerFrom("check", e); }
  try {
    const own = analyzeOwnership(checked);
    if (own.length) return { stage: "ownership", code: own[0]!.code, message: normalize(own[0]!.message) };
  } catch (e) { return blockerFrom("ownership", e); }
  try { codegen(checked); } catch (e) { return blockerFrom("codegen", e); }
  return CLEAR;
}

/**
 * LINKED — `sourceToIR(source, entryPath)`, exactly what `bootstrap.test.ts` scores as
 * `ir` and `sh6.test.ts` scores as rung 0/1. Whole-program: the blocker may belong to a
 * module this one merely IMPORTS, which is the confound docs/self-hosting.md records.
 * Recorded anyway, because it is what stage-1 actually is.
 */
function measureLinked(source: string, entryPath: string): Blocker {
  // `sourceToIR` is ONE call, so it cannot say which stage threw — and the stage is half
  // the ratchet (a blocker moving to an earlier stage is a regression whatever caused it).
  // So the same pipeline is run stage by stage. The equivalence is not assumed: the test
  // "the linked column agrees with sourceToIR" below asserts it for every module.
  try { lex(source); } catch (e) { return blockerFrom("lex", e); }
  try { parse(source); } catch (e) { return blockerFrom("parse", e); }
  let linkedProgram;
  try { linkedProgram = linkProgram(source, entryPath); } catch (e) { return blockerFrom("link", e); }
  let checked;
  try { checked = check(linkedProgram); } catch (e) { return blockerFrom("check", e); }
  try {
    const own = analyzeOwnership(checked);
    if (own.length) return { stage: "ownership", code: own[0]!.code, message: normalize(own[0]!.message) };
  } catch (e) { return blockerFrom("ownership", e); }
  try { codegen(checked); } catch (e) { return blockerFrom("codegen", e); }
  return CLEAR;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

interface Row { sha256: string; standalone: Blocker; linked: Blocker }

function measure(module: string): Row {
  const source = read(module);
  return { sha256: sha(source), standalone: measureStandalone(source), linked: measureLinked(source, pathOf(module)) };
}

/**
 * The modules measured. DISCOVERED, not listed: `bootstrap.test.ts`, `sh6.test.ts` and
 * `self-host-coverage.test.ts` all hardcode the same twelve names, so a thirteenth
 * `src/*.ts` would be unmeasured by every instrument at once. A new module has to be
 * recorded here deliberately (the baseline-completeness test below).
 */
const MODULES = readdirSync(SRC.pathname).filter((f) => f.endsWith(".ts")).sort();

/* ============================================================
 * The classifier — one pure function, exercised on BOTH outcomes below
 * ============================================================ */

type Verdict = "held" | "cleared" | "compiler-moved-it" | "source-moved-it" | "un-cleared" | "stage-regressed";

/** Verdicts that are failures. The rest are progress, or nothing happening. */
const FAILING: Verdict[] = ["source-moved-it", "un-cleared", "stage-regressed"];

/**
 * The whole ratchet, as a pure function of (recorded, current, did the source change).
 *
 * Kept separate from the measurement so it can be tested on inputs the real tree does not
 * currently produce — including every FAILING verdict. A guard whose failure path has
 * never run is not a guard, and this project has already shipped one: `phaseOf` returned
 * `"ir"` from both branches of a try/catch and inflated every measurement for weeks.
 */
export function classify(recorded: Blocker, current: Blocker, sourceChanged: boolean): Verdict {
  if (isClear(recorded) && isClear(current)) return "held";
  // A module that reached IR may never stop reaching IR. No cause excuses this.
  if (isClear(recorded)) return "un-cleared";
  if (isClear(current)) return "cleared";
  if (recorded.code === current.code && recorded.message === current.message) return "held";
  // Stopping at an EARLIER pipeline stage is a regression whatever moved it — including a
  // compiler change, which is how a "better" diagnostic can quietly cost a module ground.
  if (stageRank(current.stage) < stageRank(recorded.stage)) return "stage-regressed";
  return sourceChanged ? "source-moved-it" : "compiler-moved-it";
}

const show = (b: Blocker) => (isClear(b) ? "CLEAR (reaches IR)" : `${b.stage}/${b.code} ${b.message}`);

const RE_RECORD = "NT_RECORD=1 bun test test/selfhost-ratchet.test.ts";

/**
 * The failure text. Names the module, the column, both blockers and the next action —
 * a ratchet nobody understands gets rubber-stamped, so this does the reader's analysis
 * rather than leaving them a diff.
 */
function explain(module: string, column: string, verdict: Verdict, recorded: Blocker, current: Blocker): string {
  const head = `${module} [${column}]  was: ${show(recorded)}\n${" ".repeat(2)}now: ${show(current)}`;
  switch (verdict) {
    case "un-cleared":
      return `${head}\n  REGRESSION — this module used to compile all the way to IR and no longer does.\n` +
        `  This is the only ratchet in the tree that protects a module that ALREADY self-compiles.\n` +
        `  Fix the change that reintroduced the blocker; do not re-record.`;
    case "stage-regressed":
      return `${head}\n  REGRESSION — the blocker moved BACKWARDS, from '${recorded.stage}' to '${current.stage}'.\n` +
        `  The module now stops earlier in the pipeline than it did. If a diagnostic was\n` +
        `  deliberately moved to an earlier stage, re-record and say so in the commit:\n    ${RE_RECORD}`;
    case "source-moved-it":
      return `${head}\n  REGRESSION (probable) — src/${module} itself changed, and so did what stops it first.\n` +
        `  The compiler did not do this: a blocker only moves when the module's source or the\n` +
        `  compiler changes, and here the source is what changed.\n` +
        `  If you added a construct nativets cannot compile, use a supported spelling —\n` +
        `  \`bun run src/cli.ts coverage src/${module}\` lists them. If you deliberately moved this\n` +
        `  module's frontier, re-record:\n    ${RE_RECORD}${gitHint(module, recorded)}`;
    default:
      return head;
  }
}

/**
 * ADVISORY ONLY, and never an input to a verdict (see the header on why git is not a
 * decision input): re-measure the module's RECORDED source with TODAY's compiler. If the
 * recorded blocker is still refused, the source edit is what moved the frontier.
 */
function gitHint(module: string, recorded: Blocker): string {
  const rev = baseline.recordedAt?.rev;
  if (!rev) return "";
  const show = spawnSync("git", ["show", `${rev}:src/${module}`], { encoding: "utf8", cwd: pathOf("") });
  if (show.status !== 0 || !show.stdout) return `\n  (the recorded revision ${rev} is not in this clone, so no before/after could be taken)`;
  const then = measureStandalone(show.stdout);
  return then.code === recorded.code && then.message === recorded.message
    ? `\n  ADVISORY: the compiler STILL refuses '${recorded.message}' when handed src/${module} as of ${rev}.\n` +
      `  So the frontier did not move — your edit changed which construct is hit first.`
    : `\n  ADVISORY: handed src/${module} as of ${rev}, today's compiler reports '${show2(then)}' instead of\n` +
      `  the recorded blocker — so the compiler DID move too, and re-recording is probably right.`;
}
const show2 = (b: Blocker) => (isClear(b) ? "CLEAR" : `${b.code} ${b.message}`);

/* ============================================================
 * The baseline
 * ============================================================ */

interface Baseline { recordedAt?: { date: string; rev: string }; modules: Record<string, Row> }

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

const current: Record<string, Row> = {};
for (const m of MODULES) current[m] = measure(m);

if (process.env.NT_RECORD === "1") {
  const rev = (spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: pathOf("") }).stdout ?? "").trim();
  const next: Baseline = { recordedAt: { date: new Date().toISOString().slice(0, 10), rev }, modules: {} };
  for (const m of MODULES) next.modules[m] = current[m]!;
  for (const m of MODULES) {
    const was = baseline.modules[m];
    const now = current[m]!;
    if (!was) { console.log(`RECORD + ${m}: ${show(now.standalone)} | ${show(now.linked)}`); continue; }
    for (const col of ["standalone", "linked"] as const) {
      if (show(was[col]) !== show(now[col])) console.log(`RECORD ~ ${m} [${col}]: ${show(was[col])}  ->  ${show(now[col])}`);
    }
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
  Object.assign(baseline, next);
}

/* ============================================================
 * The ratchet
 * ============================================================ */

describe("SH-ratchet: per-module blockers (progress passes, a planted blocker fails)", () => {
  for (const module of MODULES) {
    test(`${module} — its blocker moved only where the compiler moved it`, () => {
      const was = baseline.modules[module];
      expect(was ? "recorded" : `${module} is NOT in the baseline — record it deliberately:\n    ${RE_RECORD}`).toBe("recorded");
      const now = current[module]!;
      const sourceChanged = was!.sha256 !== now.sha256;
      const failures: string[] = [];
      for (const col of ["standalone", "linked"] as const) {
        const verdict = classify(was![col], now[col], sourceChanged);
        if (FAILING.includes(verdict)) failures.push(explain(module, col, verdict, was![col], now[col]));
      }
      expect(failures.join("\n\n") || "ok").toBe("ok");
    });
  }

  /**
   * "Reject, never miscompile" (CLAUDE.md) applied to the compiler's OWN source: every
   * blocker must be a named `NT****` diagnostic, never a raw throw.
   *
   * This is here because of a bug found while building this file, and the bug is a
   * measurement bug, which makes it this file's business. `test/self-host-coverage.test.ts`
   * builds its histogram from NT1xxx codes only, and maps a non-`NTError` throw to NT9001 —
   * so a compiler CRASH contributes NOTHING to it. At `abf0185`, `coverage-preprocess.ts`
   * crashed the checker outright (`undefined is not an object (evaluating 'e.kind')`) and
   * the histogram scored it as having no blockers at all. Fixing that crash (`4053cf6`,
   * the arrow-fix lane) surfaced the real `NT1031` behind it and turned that test RED — an
   * instrument that reported the tree as CLEANER the more broken the compiler was.
   *
   * The table is empty today. An entry means a lane taught the compiler to crash on its
   * own source, which no other test in the tree asserts.
   */
  test("no module CRASHES the compiler — every blocker is a named NT diagnostic", () => {
    const CRASHING: string[] = [];
    const crashing = MODULES.filter((m) =>
      [current[m]!.standalone, current[m]!.linked].some((b) => !isClear(b) && b.code === "other"),
    );
    expect(crashing).toEqual(CRASHING);
  });

  /**
   * The baseline covers every `src/*.ts`. The other three self-hosting instruments each
   * hardcode the same twelve module names, so a thirteenth compiler module would be
   * measured by nothing at all — the gap would grow by a whole file, silently.
   */
  test("every src/*.ts is measured (a new compiler module cannot arrive unmeasured)", () => {
    expect(MODULES.filter((m) => !baseline.modules[m])).toEqual([]);
    expect(Object.keys(baseline.modules).filter((m) => !MODULES.includes(m))).toEqual([]);
  });
});

/* ============================================================
 * The instrument's own self-test — on SYNTHETIC specimens
 * ============================================================ */

describe("SH-ratchet: the measurement is honest (control specimens, never a real module)", () => {
  /*
   * Deliberately synthetic. `bootstrap.test.ts` pins a REAL module ("diagnostics.ts")
   * at an exact phase to prove its scale is honest — sound intent, wrong specimen: that
   * test goes red the day the project SUCCEEDS at compiling that module. A control
   * specimen this file owns cannot be invalidated by the compiler improving.
   */
  test("a fully supported program measures CLEAR at both ends of the pipeline", () => {
    const good = 'function add(a: number, b: number): number { return a + b; }\nconsole.log(add(2, 3));\n';
    expect(measureStandalone(good)).toEqual(CLEAR);
  });

  test("each stage is distinguishable, and NONE of them can report CLEAR", () => {
    const specimens: [string, Stage, string][] = [
      ["const a = 1;\n bad\n", "lex", ""],                       // not a token
      ["const a = (;\n", "parse", ""],                                 // not a statement
      ["const a: number[] = [1, 2];\na.push(3);\n", "check", "NT1606"], // a refusal
    ];
    for (const [source, stage, code] of specimens) {
      const b = measureStandalone(source);
      expect({ source, stage: b.stage, clear: isClear(b) }).toEqual({ source, stage, clear: false });
      if (code) expect(b.code).toBe(code);
    }
  });

  /*
   * The LINKED column is where the historical defect lived: `bootstrap.test.ts:phaseOf`
   * returned `"ir"` from BOTH branches of its last try/catch, so "produced LLVM IR" and
   * "threw inside the IR pipeline" scored identically, and the docs repeated the inflated
   * number as fact for weeks. `measureLinked` reports CLEAR from exactly one branch —
   * asserted here on specimens, in both directions, so the branch that means SUCCESS is
   * covered before any real module reaches it.
   */
  test("the linked column reports CLEAR from the success branch ONLY", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-ratchet-"));
    try {
      const good = join(dir, "good.ts");
      writeFileSync(good, 'console.log("ok");\n');
      expect(measureLinked(readFileSync(good, "utf8"), good)).toEqual(CLEAR);

      // ...and a program that dies INSIDE the IR pipeline (past lex and parse) is not CLEAR.
      const bad = join(dir, "bad.ts");
      writeFileSync(bad, 'const a: number[] = [1, 2];\na.push(3);\n');
      const m = measureLinked(readFileSync(bad, "utf8"), bad);
      expect({ clear: isClear(m), code: m.code }).toEqual({ clear: false, code: "NT1606" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The linked column runs the pipeline stage by stage so it can NAME the stage;
   * `sourceToIR` runs the same pipeline as one call. If those two ever disagree, this
   * file is measuring something that is not the compiler. Checked against the real
   * modules, both ways round: same blocker, and CLEAR for exactly the same ones.
   */
  test("the linked column agrees with sourceToIR itself, module for module", () => {
    for (const m of MODULES) {
      const source = read(m);
      const staged = current[m]!.linked;
      let direct: Blocker = CLEAR;
      try { sourceToIR(source, pathOf(m)); } catch (e) { direct = blockerFrom("link", e); }
      expect({ m, clear: isClear(staged), code: staged.code, message: staged.message })
        .toEqual({ m, clear: isClear(direct), code: direct.code, message: direct.message });
    }
  });

  test("a blocker's identity ignores its POSITION but not its CONSTRUCT", () => {
    // The lesson sh6.test.ts records: pinning `at 1109:66` reddened a test when an
    // unrelated lane added lines above it. Same construct at a different line is HELD.
    const a: Blocker = { stage: "check", code: "NT1009", message: normalize("[NT1009] optional element access '?.[]' at 1109:66 is not supported yet") };
    const b: Blocker = { stage: "check", code: "NT1009", message: normalize("[NT1009] optional element access '?.[]' at 1235:66 is not supported yet") };
    expect(classify(a, b, false)).toBe("held");
    // ...but the SAME CODE for a different construct is not the same blocker. This is the
    // documented hole: NT1009 spans unions, intersections and `?.[]`, so a code-only
    // comparison — which is what every existing instrument does — cannot see this.
    const c: Blocker = { stage: "check", code: "NT1009", message: "[NT1009] a union of 'number' and 'string' is not supported yet" };
    expect(classify(a, c, true)).toBe("source-moved-it");
  });
});

describe("SH-ratchet: the classifier fails when it should (every verdict, both signs)", () => {
  const push: Blocker = { stage: "check", code: "NT1606", message: "[NT1606] arrays are immutable: `.push` would mutate the array in place" };
  const set: Blocker = { stage: "check", code: "NT1014", message: "[NT1014] new Set([...]) is not supported yet" };
  const parseErr: Blocker = { stage: "parse", code: "NT0001", message: "[NT0001] unparsed statement" };

  test("unchanged blocker -> held", () => {
    expect(classify(push, push, false)).toBe("held");
    expect(classify(push, push, true)).toBe("held");   // source edited elsewhere in the file
  });

  test("blocker gone -> cleared (progress, never a failure)", () => {
    expect(classify(push, CLEAR, false)).toBe("cleared");
    expect(classify(push, CLEAR, true)).toBe("cleared");
    expect(FAILING).not.toContain("cleared");
  });

  test("module source UNCHANGED and the blocker moved -> the compiler moved it, PASSES", () => {
    // The everyday case: a lane clears a blocker in checker.ts and nine modules move.
    // This is why the file is not a nuisance — the frontier advancing stays green.
    expect(classify(push, set, false)).toBe("compiler-moved-it");
    expect(FAILING).not.toContain("compiler-moved-it");
  });

  test("module source CHANGED and the blocker moved -> FAILS, naming both", () => {
    // The documented case: `new Set([...])` arrives with an unrelated feature.
    expect(classify(push, set, true)).toBe("source-moved-it");
    expect(FAILING).toContain("source-moved-it");
    const text = explain("lexer.ts", "standalone", "source-moved-it", push, set);
    expect(text).toContain("lexer.ts");
    expect(text).toContain("NT1606");            // the old blocker, named
    expect(text).toContain("NT1014");            // the new one, named
    expect(text).toContain("coverage src/lexer.ts"); // what to run
    expect(text).toContain(RE_RECORD);           // how to re-record, if deliberate
  });

  test("a module that reached IR and stopped -> FAILS whatever the cause", () => {
    // diagnostics.ts is about to be the first module here that reaches IR, so this rule
    // stops being hypothetical: nothing may take that back, not even a compiler change.
    expect(classify(CLEAR, push, false)).toBe("un-cleared");
    expect(classify(CLEAR, push, true)).toBe("un-cleared");
    expect(explain("diagnostics.ts", "linked", "un-cleared", CLEAR, push)).toContain("do not re-record");
  });

  test("a blocker moving to an EARLIER stage -> FAILS even with the source unchanged", () => {
    // Ground lost is ground lost. A compiler change that starts refusing a module at
    // `parse` what it used to accept until `check` costs the module real distance.
    expect(classify(push, parseErr, false)).toBe("stage-regressed");
    expect(classify(push, parseErr, true)).toBe("stage-regressed");
  });

  test("the stage scale is ordered, and `clear` is its top", () => {
    expect(stageRank("lex")).toBeLessThan(stageRank("parse"));
    expect(stageRank("parse")).toBeLessThan(stageRank("check"));
    expect(stageRank("check")).toBeLessThan(stageRank("codegen"));
    expect(stageRank("codegen")).toBeLessThan(stageRank("clear"));
  });
});

describe("SH-ratchet: the two columns are named, and disagree (the SH6 confound)", () => {
  /**
   * `sourceToIR` runs the whole-program LINK, so the linked column routinely reports a
   * blocker that belongs to a module this one merely IMPORTS. docs/self-hosting.md records
   * people drawing the wrong conclusion from exactly that: `ownership.ts` was credited with
   * an `NT1009` that lives in `checker.ts`. Both columns are recorded so the disagreement
   * is visible instead of being a footnote.
   */
  test("at least one module's standalone and linked blockers disagree", () => {
    const disagree = MODULES.filter((m) => show(current[m]!.standalone) !== show(current[m]!.linked));
    expect(disagree.length).toBeGreaterThan(0);
  });
});
