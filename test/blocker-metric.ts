#!/usr/bin/env bun
/*
 * blocker-metric — how much of a program the CHECKER refuses, function by function.
 *
 *   bun run test/blocker-metric.ts                 # the stage-1 program (src/cli.ts, LINKED)
 *   bun run test/blocker-metric.ts --json          # machine-readable, stable key order
 *   bun run test/blocker-metric.ts --shapes        # + the distinct blocker messages
 *   bun run test/blocker-metric.ts path/to/x.ts    # any other entry
 *
 * WHY THIS EXISTS. Every other self-hosting instrument in the tree is FIRST-BLOCKER: the
 * checker stops at the first function body it refuses, so a twelve-module program reports
 * one blocker no matter how many it holds. That measures what to fix NEXT and says nothing
 * about how far there is to go — the same mistake docs/self-hosting.md already records
 * under "count the construct, not the first blocker". This runs the per-function loop to
 * completion and reports every function that fails, so "we cleared a bucket" is a number
 * both sides of a change can compare.
 *
 * DEFAULTS TO THE LINKED PROGRAM, deliberately. A per-module measurement structurally
 * cannot see the cross-module class of defect: `closureAssigned` and NT1031's enclosing-
 * body scan are keyed by bare NAME and run over the whole merged program, while the linker
 * renames only TOP-LEVEL bindings — so one module's arrow-assigned local makes that name
 * unnarrowable in every other module. Two files that each compile alone can fail to
 * compile together, and only the linked column shows it.
 *
 * WHAT IT CANNOT SEE — stated up front, because an instrument that overstates is worse
 * than none:
 *   1. FUNCTION BODIES ONLY. Top-level statements are checked before the loop; if one of
 *      them fails the run aborts and this tool says so instead of reporting a number.
 *   2. FIRST BLOCKER PER FUNCTION. A second refusal in the same body is masked until the
 *      first clears — so a bucket can shrink by less than a lane's site count suggests.
 *
 *      IT CUTS BOTH WAYS, and this half is the one that catches people. Masking hides
 *      blockers a lane ADDS, not just ones it fails to remove: edit a function that
 *      already fails, introduce a fresh refusal below its first blocker, and this tool
 *      reports the change as free. Two lanes hit exactly that within an hour of each
 *      other in opposite directions — one swapped an NT2001 for an NT1003 (an
 *      unimplemented global, strictly worse and permanent) in a body whose first blocker
 *      was elsewhere, and the review that caught it was reading the diff, not this
 *      number. So a flat count is NOT evidence that an edit was harmless. To check a
 *      line you actually touched, ask for that function's blockers directly rather than
 *      reading the total:
 *
 *          check(linkProgram(src, entry), blockers);   // then filter blockers by b.fn
 *
 *      Clearing an earlier blocker can also PROMOTE a masked one into view, which is why
 *      a bucket total can rise while the tree strictly improves (see the NT1606 +1 in the
 *      `mutationError`/`Loc` commit). The failing-FUNCTION count is the number to track;
 *      per-code totals move under each other and neither direction is a regression on
 *      its own.
 *   3. THE CHECKER ONLY. The ownership pass and codegen never run, so no NT16xx ownership
 *      diagnostic and no codegen refusal is counted. A function at 0 here is not a
 *      function that compiles.
 *   4. GENERIC TEMPLATES are not in the denominator (they are checked per specialization,
 *      inside the monomorphizer, not by this loop).
 *
 * NOT A RATCHET. It reports; it does not gate. Seven lanes move these numbers at once and
 * a threshold would only fight them. test/blocker-metric.test.ts validates the INSTRUMENT
 * (that it reads 0 on programs that do compile, and that cascade contamination stays
 * negligible) — never the frontier.
 *
 * IT REFUSES TO ANSWER WHEN ITS OWN INPUTS ARE BROKEN, and that is deliberate. An
 * unreadable entry, a tree that does not link, a check that aborts before the per-function
 * loop, and a `src/*.ts` the entry never reaches are each reported as themselves — exit 2
 * and a sentence, never a count. The reason is the failure this repo keeps re-learning:
 * `test/tsc.test.ts` exists because 16 SYNTAX errors in fixtures made tsc report zero TYPE
 * errors for the life of the project (it computes no semantic diagnostics while syntactic
 * ones exist), and the tool kept answering the whole time. A number that arrives when the
 * measurement did not happen is worse than an error, because people believe it — and a
 * gate that fails for an ENVIRONMENTAL reason is nearly as bad, because people learn to
 * dismiss it. Hence: loud, specific, and about the precondition rather than the frontier.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { linkProgram, moduleGraph, choosePrefixBase } from "../src/modules.ts";
import { check, type FnBlocker } from "../src/checker.ts";
import { NTError } from "../src/diagnostics.ts";
import type { Program } from "../src/ast.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The stage-1 program: `bun` runs the compiler, which compiles `src/` to a binary. */
export const STAGE1_ENTRY = resolve(REPO, "src/cli.ts");

export interface CodeCount { code: string; count: number }
export interface ModuleCount { index: number; file: string; functions: number; failing: number }
export interface ShapeCount { count: number; code: string; shape: string; example: string }

export interface BlockerReport {
  /** Repo-relative when it is below the repo, so the report is machine-independent. */
  entry: string;
  modules: number;
  /** Non-generic top-level `FuncDecl`s in the linked program — the denominator. */
  functions: number;
  failing: number;
  /** Blockers whose message reads like RECOVERY damage rather than a real gap (a name
   *  that went undeclared because the statement declaring it failed). Kept visible
   *  because a recovering measurement that does not report its own contamination is the
   *  `coverage`-scored-a-crash failure mode wearing a different hat. */
  cascadeSuspects: number;
  /** What a normal `nativets build` reports today — the ONE blocker every other
   *  instrument sees, with the structural union dumps collapsed. `null` when the
   *  program checks clean. */
  firstBlocker: { code: string; message: string } | null;
  /** Whether the plain (non-collecting) check completed. */
  checksClean: boolean;
  byCode: CodeCount[];
  byModule: ModuleCount[];
  shapes: ShapeCount[];
  /** `src/*.ts` files the stage-1 link did NOT reach, so they are outside every number
   *  above. Empty in the healthy tree. Reported loudly rather than left implicit: a
   *  measurement that quietly covers less than it claims is this project's oldest
   *  failure mode (16 syntax errors in fixtures masked every semantic error in `src/`
   *  for the life of the project, because tsc computes no semantic diagnostics while
   *  syntactic ones exist — see test/tsc.test.ts). */
  unmeasured: string[];
}

/* ------------------------------------------------------------------ helpers */

function show(path: string): string {
  const r = relative(REPO, path);
  return r && !r.startsWith("..") ? r : path;
}

/**
 * The module index a linked name came from, or -1 for the entry (whose names the linker
 * leaves alone). A mangled name is `${base}${i}_${original}`; `base` is a pure function
 * of the sources, so this is exact rather than a guess, and it covers EVERY function
 * rather than only the ones whose AST node happens to carry a `loc`.
 */
function moduleIndexOf(name: string, base: string): number {
  if (!name.startsWith(base)) return -1;
  let digits = "";
  let i = base.length;
  while (i < name.length && name[i]! >= "0" && name[i]! <= "9") { digits += name[i]; i++; }
  if (digits === "" || name[i] !== "_") return -1;
  return Number(digits);
}

/**
 * Collapse the structural union dumps. One `@Expr` dump is ~3 KB of `{kind:…}|{kind:…}`,
 * which buries the part of the message a reader needs (the hint on the end) and makes
 * the JSON undiffable. Everything else is left alone, so the quoted names and positions
 * that say WHICH construct it is survive.
 */
function collapseUnions(message: string, base: string): string {
  const s = message.split(base).join("");
  // A brace/angle-COUNTING scan, not a regex. The members nest (`loc:?U{line:…}`,
  // `captures:?U{name:…}[]`), and a bracket-class regex silently stops at the first
  // inner `}` — which is how the first cut of this left 1.5 KB of dump in the output
  // while looking like it had collapsed it.
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== "{" && ch !== "<") { out += ch; i++; continue; }
    // Consume `{…}` (or `U<…>`) groups separated by `|`, counting depth.
    let j = i;
    let groups = 0;
    while (j < s.length && (s[j] === "{" || s[j] === "<")) {
      const open = s[j]!;
      const close = open === "{" ? "}" : ">";
      let depth = 0;
      const start = j;
      while (j < s.length) {
        if (s[j] === open) depth++;
        else if (s[j] === close) { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      if (depth !== 0) { j = start; break; } // unbalanced — leave the text alone
      groups++;
      let k = j;
      while (k < s.length && s[k] === " ") k++;
      if (s[k] !== "|") break;
      k++;
      while (k < s.length && s[k] === " ") k++;
      if (s[k] !== "{" && s[k] !== "<") break;
      j = k;
    }
    if (groups >= 2) { out += "<UNION>"; i = j; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** A message normalized until two refusals of the SAME shape collide: unions collapsed,
 *  then positions and quoted spellings generalized away. Used only for the `--shapes`
 *  grouping, never for the headline numbers. */
function shapeOf(message: string, base: string): string {
  let s = collapseUnions(message, base);
  s = s.replace(/\bat \d+:\d+/g, "at L:C");
  s = s.replace(/'[^']*'/g, "'X'");
  s = s.replace(/`[^`]*`/g, "`X`");
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Does this blocker read like damage the RECOVERY caused rather than a real gap? */
function looksLikeCascade(b: FnBlocker): boolean {
  return b.message.includes("is not defined") || b.message.includes("Duplicate function");
}

/**
 * The linked names of every function the per-function loop will visit — captured BEFORE
 * `check` runs, and that ordering is load-bearing. `check` rewrites `program.body` on its
 * way out (it splices generic TEMPLATES out and their monomorphized SPECIALIZATIONS in),
 * so reading the body afterwards would count functions the loop never saw and make the
 * per-module rows disagree with the total on any program using generics.
 */
function loopFunctionNames(program: Program): string[] {
  const names: string[] = [];
  for (const s of program.body) if (s.kind === "FuncDecl" && !s.typeParams?.length) names.push(s.name);
  return names;
}

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof NTError) return { code: e.diag.code, message: e.diag.message };
  const err = e as Error;
  return { code: `(${err.name ?? "throw"})`, message: err.message ?? String(e) };
}

/* -------------------------------------------------------------------- core */

export class MetricAborted extends Error {}

/**
 * Measure one entry. Two passes on purpose:
 *
 *   A. a PLAIN check. If it completes, the answer is unambiguously zero and we are done —
 *      no recovery involved, so no recovery artifacts to argue about.
 *   B. only if A threw: the collecting check. If that comes back with an EMPTY list, the
 *      abort was outside the per-function loop (a top-level statement, or a pass after
 *      it), and reporting "0 failing" there would be the exact failure this project has
 *      on record — `coverage` once scoring a compiler CRASH as "no blockers". So it
 *      throws `MetricAborted` instead of returning a number.
 */
export function measure(entryPath: string): BlockerReport {
  const entry = resolve(entryPath);

  // ---- PRECONDITIONS. Each of these fails LOUDLY rather than producing a number, and
  // that is the point: a gate that reports a plausible count when its own inputs are
  // broken teaches eight concurrent lanes to ignore it, which is barely better than a
  // gate that silently skips.
  let source: string;
  try {
    source = readFileSync(entry, "utf8");
  } catch {
    throw new MetricAborted(`cannot read entry '${show(entry)}' — nothing was measured.`);
  }

  let graph: string[];
  let progA: Program;
  try {
    graph = moduleGraph(source, entry);
    // `check` MUTATES its Program (it splices monomorphized specializations into the
    // body), so each pass gets its own link. `linkProgram` is pure in its sources.
    progA = linkProgram(source, entry);
  } catch (e) {
    const d = describe(e);
    throw new MetricAborted(
      `'${show(entry)}' does not LINK, so there is no program to measure — this is a ` +
      `broken tree or a bad entry, not a frontier number: [${d.code}] ${d.message.slice(0, 300)}`,
    );
  }

  const base = choosePrefixBase(graph.map((p) => (p === entry ? source : readFileSync(p, "utf8"))));
  const loopFns = loopFunctionNames(progA);
  const functions = loopFns.length;

  // A `src/*.ts` the stage-1 entry does not reach is outside every number below. It is
  // DISCOVERED from the directory, not a hardcoded list of twelve, so a thirteenth module
  // cannot arrive unmeasured and unmentioned.
  let unmeasured: string[] = [];
  if (entry === STAGE1_ENTRY) {
    const reached = new Set(graph);
    const dir = resolve(REPO, "src");
    unmeasured = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")) // a declaration file is not a module
      .map((f) => resolve(dir, f))
      .filter((p) => !reached.has(p))
      .map(show)
      .sort();
  }

  let firstBlocker: { code: string; message: string } | null = null;
  try {
    check(progA);
  } catch (e) {
    const d = describe(e);
    firstBlocker = { code: d.code, message: collapseUnions(d.message, base) };
  }

  const blockers: FnBlocker[] = [];
  if (firstBlocker !== null) {
    // The collecting pass. It is EXPECTED to throw after the loop — the passes below it
    // assume every body typed — and the array we already hold is the result either way.
    try { check(linkProgram(source, entry), blockers); } catch { /* see above */ }
    if (blockers.length === 0) {
      throw new MetricAborted(
        `${show(entry)}: the check aborted OUTSIDE the per-function loop, so there is no ` +
        `per-function number to report (a top-level statement, or a pass after the loop). ` +
        `Reporting 0 here would score a hard failure as a clean program. First blocker: ` +
        `[${firstBlocker.code}] ${firstBlocker.message.slice(0, 200)}`,
      );
    }
  }

  // ---- aggregate, always through an explicit sort: no Map iteration order reaches the
  // output, so two runs of the same tree produce byte-identical text.
  const codeCounts = new Map<string, number>();
  for (const b of blockers) codeCounts.set(b.code, (codeCounts.get(b.code) ?? 0) + 1);
  const byCode: CodeCount[] = [...codeCounts]
    .map(([code, count]) => ({ code, count }))
    .sort((x, y) => y.count - x.count || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));

  const totalByModule = new Map<number, number>();
  for (const name of loopFns) {
    const i = moduleIndexOf(name, base);
    totalByModule.set(i, (totalByModule.get(i) ?? 0) + 1);
  }
  const failByModule = new Map<number, number>();
  for (const b of blockers) {
    const i = moduleIndexOf(b.fn, base);
    failByModule.set(i, (failByModule.get(i) ?? 0) + 1);
  }
  const byModule: ModuleCount[] = [...totalByModule.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      // -1 is the ENTRY, which the linker does not rename. A single-module program has
      // no graph entry beyond itself, so `graph[index]` covers both shapes.
      file: show(index === -1 ? entry : (graph[index] ?? entry)),
      functions: totalByModule.get(index) ?? 0,
      failing: failByModule.get(index) ?? 0,
    }));

  const shapeCounts = new Map<string, { count: number; code: string; example: string }>();
  for (const b of blockers) {
    const key = `${b.code} ${shapeOf(b.message, base)}`;
    const cur = shapeCounts.get(key);
    if (cur) cur.count++;
    else shapeCounts.set(key, { count: 1, code: b.code, example: b.fn });
  }
  const shapes: ShapeCount[] = [...shapeCounts]
    .map(([key, v]) => ({ count: v.count, code: v.code, shape: key.slice(v.code.length + 1), example: v.example }))
    .sort((x, y) => y.count - x.count || (x.shape < y.shape ? -1 : x.shape > y.shape ? 1 : 0));

  return {
    entry: show(entry),
    modules: graph.length,
    functions,
    failing: blockers.length,
    cascadeSuspects: blockers.filter(looksLikeCascade).length,
    firstBlocker,
    checksClean: firstBlocker === null,
    byCode,
    byModule,
    shapes,
    unmeasured,
  };
}

/* ------------------------------------------------------------------ render */

function pct(n: number, d: number): string {
  return d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`;
}

export function render(r: BlockerReport, withShapes: boolean): string {
  let out = "";
  out += `blocker-metric  entry=${r.entry}  modules=${r.modules}  (linked)\n`;
  out += `functions        ${r.functions}\n`;
  out += `failing          ${r.failing}  (${pct(r.failing, r.functions)})\n`;
  out += `cascade-suspect  ${r.cascadeSuspects}\n`;
  out += r.checksClean
    ? `first-blocker    none — this program CHECKS CLEAN\n`
    : `first-blocker    [${r.firstBlocker!.code}] ${r.firstBlocker!.message}\n`;

  if (r.byCode.length) {
    out += `\nby NT code\n`;
    for (const c of r.byCode) out += `  ${String(c.count).padStart(4)}  ${c.code}\n`;
  }

  out += `\nby module (link order)\n`;
  for (const m of r.byModule) {
    const tag = m.index === -1 ? "entry" : `m${m.index}`;
    out += `  ${tag.padEnd(6)} ${m.file.padEnd(28)} ${String(m.failing).padStart(4)} / ${String(m.functions).padStart(4)}  ${pct(m.failing, m.functions)}\n`;
  }

  if (withShapes && r.shapes.length) {
    out += `\ndistinct blocker shapes (${r.shapes.length})\n`;
    for (const s of r.shapes) out += `  ${String(s.count).padStart(4)}  ${s.code} ${s.shape}\n`;
  }

  if (r.unmeasured.length) {
    out += `\n!! NOT MEASURED — ${r.unmeasured.length} src/ module(s) the stage-1 entry does not reach.\n`;
    out += `!! Every number above excludes them. Fix the import graph or measure them separately.\n`;
    for (const f of r.unmeasured) out += `!!   ${f}\n`;
  }

  out += `\nCounts CHECKER refusals in function bodies only, first blocker per function.\n`;
  out += `Ownership and codegen never run, so a module at 0 is not a module that compiles.\n`;
  return out;
}

/* --------------------------------------------------------------------- CLI */

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const withShapes = args.includes("--shapes");
  const positional = args.filter((a) => !a.startsWith("--"));
  const entry = positional.length ? resolve(positional[0]!) : STAGE1_ENTRY;
  try {
    const r = measure(entry);
    // `shapes` is dropped from the default JSON for the same reason it is dropped from the
    // default text: it is long, and a lane diffing before/after wants the three tables.
    process.stdout.write(asJson ? `${JSON.stringify(withShapes ? r : { ...r, shapes: undefined }, null, 2)}\n` : render(r, withShapes));
  } catch (e) {
    if (e instanceof MetricAborted) { console.error(`blocker-metric: ${e.message}`); process.exit(2); }
    throw e;
  }
}
