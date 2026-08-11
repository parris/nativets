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
 *   CARRIABLE     of SEED, the functions whose payload the pending-exception slot can
 *                 actually HOLD. This is the row that prices the work, and it is the one
 *                 the first four hide: SEED is 129 and CARRIABLE is 7, because `src/`
 *                 throws class instances (`NTError{message,name,diag:{…}}`) and the slot
 *                 is one `const char *`. No call-graph cleverness moves that 7 — widening
 *                 the payload to an owned object handle is a RUNTIME change, and it is
 *                 the PREREQUISITE for transitive propagation being worth building.
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
 *   4. THE CARRIABLE ROW COSTS THE CHECKER, which no other row here needs. It runs in the
 *      recovering mode blocker-metric uses and may abort after the per-function loop; a
 *      function it refused has no annotated payload type and is reported as UNKNOWN, never
 *      silently as "not carriable". If no type is recovered at all the row prints `?`.
 *      CARRIABLE is therefore a CEILING, not a promise: it is the payload test only, and
 *      each of the call-graph rules (direct calls, never used as a value, matching catch
 *      binding) can still disqualify a function it counts.
 *
 * NOT A RATCHET. It reports; it does not gate.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { linkProgram } from "../src/modules.ts";
import { check } from "../src/checker.ts";
import { fieldType, isObjectTy, objectFields } from "../src/ast.ts";
import type { Program, Stmt, Ty } from "../src/ast.ts";

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
  /** Of `seed`, the functions whose uncovered throws all raise a payload the pending-
   *  exception flag can actually CARRY. See the `carriable` block comment below. */
  carriable: number;
  /** Seed functions whose payload type is unknown because the CHECKER refused the body,
   *  so no `ty` was ever annotated. Never counted as carriable — a payload nobody typed
   *  is not a payload anybody proved. */
  carriableUnknown: number;
  /** False when the type pass could not run at all, in which case the two rows above are
   *  meaningless and are printed as `?` rather than as zero. */
  typesKnown: boolean;
  carriableNames: string[];
}

/**
 * THE PAYLOAD ROW — and the reason SEED overstates the work by more than an order of
 * magnitude on `src/`.
 *
 * Every other row here is a CALL-GRAPH question, and needs no types. But propagation
 * carries the raise on the runtime's pending-exception slot, which is one `const char *`
 * (runtime.c, `g_exc_msg`). So a `throw` can only cross a frame if its payload fits that
 * slot: a `string`, or the one-field `{message:string}` that `emitExcCheck` already
 * reconstructs. `codegen.ts::raisableTy` is the rule this mirrors.
 *
 * On stage-1 that is what actually blocks the work. `src/` throws CLASS INSTANCES —
 * `NTError{message,name,diag:{…}}` (145 sites) and `InternalError{message,name}` (16) —
 * which no amount of call-graph reasoning can carry, against 16 sites of the one-field
 * `LexError`/`BuildError`. So of 129 SEED functions only 7 have a carriable payload, and
 * the transitive fixpoint has a ceiling of those 7 no matter how good it is. Widening
 * the payload to an owned object handle is a RUNTIME change, and it is the prerequisite.
 *
 * COSTS THE CHECKER, which the rest of this tool deliberately does not need. It is run in
 * the recovering mode `test/blocker-metric.ts` uses and is allowed to abort after the
 * per-function loop; a function it refused has no annotated `ty`, and those are counted
 * as UNKNOWN rather than quietly as "not carriable". If the pass yields nothing at all,
 * `typesKnown` goes false and the rows print `?` — an instrument that reports a number it
 * did not measure is this file's own stated failure mode.
 */
function carriablePayload(t: Ty | undefined): boolean {
  if (t === undefined) return false;
  if (t === "string") return true;
  if (!isObjectTy(t) || objectFields(t).length !== 1) return false;
  return fieldType(t, "message") === "string";
}

/** The payload types of one frame's uncovered throws — `undefined` for a throw the
 *  checker never typed — plus whether any of them sits inside an ARROW body. Same
 *  traversal as `frameInfo`, kept separate so the call-graph rows stay computable with no
 *  checker at all.
 *
 *  The arrow flag mirrors `codegen.ts::scanEscaping` rule 4: a LIFTED arrow's `throw` runs
 *  in a frame that is not this one, so it is not this function's `ret` to take and codegen
 *  refuses the whole function. Without it this row read 8 rather than 7 on stage-1 — an
 *  instrument overstating the very ceiling it exists to report. */
function uncoveredPayloads(body: Stmt[]): { tys: (Ty | undefined)[]; inArrow: boolean } {
  const tys: (Ty | undefined)[] = [];
  let inArrow = false;
  const walk = (n: unknown, covered: boolean, arrow: boolean): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x, covered, arrow); return; }
    const r = n as Record<string, unknown>;
    if (r.kind === "ThrowStmt") {
      if (arrow) inArrow = true;
      else if (!covered) tys.push((r.argument as { ty?: Ty }).ty);
      return;
    }
    if (r.kind === "TryStmt") {
      walk(r.block, covered || !!r.handler, arrow);
      if (r.handler) walk(r.handler, covered, arrow);
      if (r.finalizer) walk(r.finalizer, covered, arrow);
      return;
    }
    if (r.kind === "ArrowFunction") { for (const k in r) walk(r[k], covered, true); return; }
    if (r.kind === "FuncDecl") return; // a nested declaration is its own frame
    for (const k in r) if (k !== "kind" && k !== "ty") walk(r[k], covered, arrow);
  };
  walk(body, false, false);
  return { tys, inArrow };
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

  // ---- payload types. A SECOND link, because `check` MUTATES its Program (it splices
  // generic specializations into the body) and every row above was computed on the
  // untouched one. Failure here degrades the two payload rows to "unknown"; it never
  // takes down the call-graph rows, which is the property that lets this tool answer on
  // a tree whose `check` aborts.
  let typed: Program | null = null;
  try {
    typed = linkProgram(readFileSync(entry, "utf8"), entry);
    try { check(typed, []); } catch { /* expected: aborts after the per-function loop */ }
  } catch { typed = null; }

  const seedSet = new Set(seedNames);
  const carriableNames: string[] = [];
  let carriableUnknown = 0;
  let anyTyped = false;
  for (const s of typed?.body ?? []) {
    if (s.kind !== "FuncDecl" || !seedSet.has(s.name)) continue;
    const { tys, inArrow } = uncoveredPayloads(s.body);
    if (tys.length === 0 && !inArrow) continue;
    if (tys.some((t) => t !== undefined)) anyTyped = true;
    if (inArrow) continue; // rule 4: a lifted arrow's throw is not this frame's `ret`
    // A body the checker refused was never annotated. Counted as UNKNOWN, never as a
    // "no" — the difference between "we proved it cannot carry" and "we did not look".
    if (tys.some((t) => t === undefined)) { carriableUnknown++; continue; }
    // Every uncovered throw must agree on ONE carriable type: the catch binding takes one.
    const first = tys[0];
    if (!carriablePayload(first) || tys.some((t) => t !== first)) continue;
    carriableNames.push(s.name);
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
    carriable: carriableNames.length,
    carriableUnknown,
    typesKnown: anyTyped,
    carriableNames: [...carriableNames].sort(),
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
  console.log(`SEED w/ CARRIABLE load  ${r.typesKnown ? r.carriable : "?"}   ← the CEILING on transitive propagation`);
  console.log(`  …payload type unknown ${r.typesKnown ? r.carriableUnknown : "?"}   (the checker refused the body)`);
  if (!r.typesKnown) console.log(`  (no type pass — the two rows above were NOT measured)`);
  if (process.argv.includes("--list")) {
    for (const n of r.seedNames) console.log(`  seed      ${n}`);
    for (const n of r.carriableNames) console.log(`  carriable ${n}`);
  }
}
