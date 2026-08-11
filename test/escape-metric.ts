#!/usr/bin/env bun
/*
 * escape-metric — how far cross-frame `throw` propagation has to go, priced.
 *
 *   bun run test/escape-metric.ts                 # the stage-1 program (src/cli.ts, LINKED)
 *   bun run test/escape-metric.ts --list          # + the seed functions
 *   bun run test/escape-metric.ts path/to/x.ts    # any other entry
 *
 * WHY THIS EXISTS. `test/blocker-metric.ts` is CHECKER-ONLY, and says so — the ownership
 * pass and codegen never run, so it cannot see a single NT1004. But NT1004 cross-frame
 * propagation is the largest item on the post-checker tail (docs/self-hosting.md), so the
 * one number everybody quotes is structurally blind to the one blocker that matters most.
 * This measures that blocker, and it needs neither the checker nor codegen to do it —
 * which is what lets it answer on a tree whose `check` aborts outside the per-function
 * loop, as stage-1's does.
 *
 * WHAT IT MEASURES, and each row is a different question:
 *
 *   SEED          functions containing a `throw` codegen refuses today, computed with
 *                 codegen's own rule (not inside a `try` WITH a `catch` in the same
 *                 function, in a program that has a `try` at all, outside `main`).
 *   ESCAPES       the TRANSITIVE closure: functions that would have to propagate if the
 *                 one-frame restriction were lifted. The gap between this and SEED is the
 *                 intermediate frames.
 *   COVERED       call sites reaching an escaping callee that ALREADY sit inside a
 *                 `try`/`catch` in their own frame. This is the row that decides how much
 *                 the shipped one-frame rule can clear, and on stage-1 it is 16 of 1209.
 *   UNRESOLVED    calls the graph cannot resolve (closures, function values, builtins).
 *                 Full propagation must emit a conservative check after each of these or
 *                 admit a hole, so it is a cost line, not a footnote.
 *
 * WHAT IT CANNOT SEE — stated up front, because an instrument that overstates is worse
 * than none:
 *   1. IT IS NOT THE CODEGEN COLUMN of the per-module table. Codegen stops at a
 *      function's FIRST refusal, so a function counted in SEED may fail for some other
 *      reason first. SEED cannot OVERSTATE the NT1004 population (every site it counts is
 *      one codegen refuses today), but the two numbers are answers to different questions.
 *   2. THE CALL GRAPH IS OVER-APPROXIMATE. A method call is resolved by PROPERTY name, so
 *      `x.check(…)` is treated as reaching every `*.check` in the program. That inflates
 *      ESCAPES and COVERED alike. Resolving by receiver type needs the checker, which
 *      aborts on this tree — and the first cut of this tool skipped method calls
 *      altogether and undercounted ESCAPES by about 4x, because nearly every call in
 *      `src/` is a method call.
 *   3. TOP-LEVEL STATEMENTS are `main`'s frame and are not in the denominator.
 *
 * NOT A RATCHET. It reports; it does not gate.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { linkProgram } from "../src/modules.ts";
import type { Program, Stmt } from "../src/ast.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface FrameInfo {
  /** `throw`s no local `catch` covers — the ones codegen refuses today. */
  uncovered: number;
  /** Resolved callees, with whether a local `try`/`catch` covers the call site. */
  calls: { name: string; covered: boolean }[];
  /** Calls to something this graph cannot name. */
  unresolved: number;
}

/** Does the program contain a `try` ANYWHERE? Codegen's own whole-program gate: with no
 *  `try` at all, every `throw` is uncaught and already compiles. */
function hasTry(n: unknown): boolean {
  if (n === null || typeof n !== "object") return false;
  const r = n as Record<string, unknown>;
  if (r.kind === "TryStmt") return true;
  for (const k in r) if (hasTry(r[k])) return true;
  return false;
}

/** One frame's throws and calls. `covered` tracks an enclosing `try` WITH a `catch` in
 *  THIS frame — a `finally` does not handle, so it does not cover. */
function frameInfo(body: Stmt[], resolveProp: (p: string) => string[], known: Set<string>): FrameInfo {
  const out: FrameInfo = { uncovered: 0, calls: [], unresolved: 0 };
  const walk = (n: unknown, covered: boolean, top: boolean): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x, covered, top); return; }
    const r = n as Record<string, unknown>;
    switch (r.kind) {
      case "ThrowStmt":
        if (!covered) out.uncovered++;
        walk(r.argument, covered, false);
        return;
      case "TryStmt":
        walk(r.block, covered || !!r.handler, false);
        if (r.handler) walk(r.handler, covered, false);
        if (r.finalizer) walk(r.finalizer, covered, false);
        return;
      case "FuncDecl":
        if (!top) return; // a nested declaration is its own frame
        break;
      case "CallExpr": {
        const c = r.callee as Record<string, unknown> | undefined;
        if (c?.kind === "Identifier" && known.has(c.name as string)) out.calls.push({ name: c.name as string, covered });
        else if (c?.kind === "MemberExpr" && resolveProp(c.property as string).length > 0) {
          for (const t of resolveProp(c.property as string)) out.calls.push({ name: t, covered });
        } else out.unresolved++;
        break;
      }
      default: break;
    }
    for (const k in r) if (k !== "kind" && k !== "ty") walk(r[k], covered, false);
  };
  walk(body, false, true);
  return out;
}

export interface EscapeReport {
  entry: string;
  functions: number;
  hasTry: boolean;
  seed: number;
  seedSites: number;
  escapes: number;
  callSitesToEscaping: number;
  covered: number;
  unresolved: number;
  seedNames: string[];
}

export function measureEscapes(entryPath: string): EscapeReport {
  const entry = resolve(entryPath);
  const program: Program = linkProgram(readFileSync(entry, "utf8"), entry);
  const fns = program.body.filter((s): s is Stmt & { kind: "FuncDecl" } =>
    s.kind === "FuncDecl" && !(s as { typeParams?: string[] }).typeParams?.length);
  const known = new Set(fns.map((f) => f.name));

  // A method is a top-level `Class.m` and its call sites name only `m`. See caveat 2.
  const byProp = new Map<string, string[]>();
  for (const f of fns) {
    const dot = f.name.lastIndexOf(".");
    if (dot < 0) continue;
    const p = f.name.slice(dot + 1);
    byProp.set(p, [...(byProp.get(p) ?? []), f.name]);
  }
  const resolveProp = (p: string): string[] => byProp.get(p) ?? [];

  const info = new Map<string, FrameInfo>();
  for (const f of fns) info.set(f.name, frameInfo(f.body, resolveProp, known));

  const programHasTry = hasTry(program);
  const seedNames = programHasTry ? fns.filter((f) => info.get(f.name)!.uncovered > 0).map((f) => f.name) : [];
  const seedSites = seedNames.reduce((n, name) => n + info.get(name)!.uncovered, 0);

  // Least fixpoint: g escapes if it calls an escaping f from an UNCOVERED site.
  const escapes = new Set(seedNames);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      if (escapes.has(f.name)) continue;
      for (const c of info.get(f.name)!.calls) {
        if (!c.covered && escapes.has(c.name)) { escapes.add(f.name); changed = true; break; }
      }
    }
  }

  let toEscaping = 0;
  let covered = 0;
  let unresolved = 0;
  for (const f of fns) {
    const i = info.get(f.name)!;
    unresolved += i.unresolved;
    for (const c of i.calls) {
      if (!escapes.has(c.name)) continue;
      toEscaping++;
      if (c.covered) covered++;
    }
  }

  const rel = relative(REPO, entry);
  return {
    entry: rel && !rel.startsWith("..") ? rel : entry,
    functions: fns.length,
    hasTry: programHasTry,
    seed: seedNames.length,
    seedSites,
    escapes: escapes.size,
    callSitesToEscaping: toEscaping,
    covered,
    unresolved,
    seedNames: [...seedNames].sort(),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const r = measureEscapes(args[0] ?? resolve(REPO, "src/cli.ts"));
  const pct = (n: number): string => `${((n / r.functions) * 100).toFixed(1)}%`;
  console.log(`escape-metric  entry=${r.entry}  (linked)`);
  console.log(`functions               ${r.functions}`);
  console.log(`program has a try       ${r.hasTry}`);
  console.log(`SEED  NT1004 functions  ${r.seed}  (${pct(r.seed)})   over ${r.seedSites} throw sites`);
  console.log(`ESCAPES (transitive)    ${r.escapes}  (${pct(r.escapes)})`);
  console.log(`call sites → escaping   ${r.callSitesToEscaping}`);
  console.log(`  …already covered      ${r.covered}   ← what the ONE-FRAME rule can clear`);
  console.log(`unresolved calls        ${r.unresolved}   (closures / function values / builtins)`);
  if (process.argv.includes("--list")) for (const n of r.seedNames) console.log(`  ${n}`);
}
