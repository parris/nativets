/*
 * `nativets coverage` — the three-tier gradient, modeled on scriptc's coverage.
 *
 * Rather than a binary "does it compile?", report:
 *   - whether the file compiles statically end-to-end, and
 *   - a histogram of blocking features grouped by NT code + milestone + frequency,
 * so "unsupported" becomes an actionable, prioritized list.
 */

import type { Program, Stmt, Expr, ImportDecl, Ty } from "./ast.ts";
import { parse } from "./parser.ts";
import { linkProgram } from "./modules.ts";
import { check } from "./checker.ts";
import { NTError } from "./diagnostics.ts";
// `Blocker` is declared in the LEAF, not here: this file imports that one, so declaring
// the shared type here closed an `import type` cycle the linker cannot order (NT1702).
import { preprocessForCoverage, type Blocker } from "./coverage-preprocess.ts";

// (Not re-exported: `export type { … }` is itself NT1017, and nothing imports `Blocker`
// from here — the one consumer, coverage-preprocess.ts, is where it now lives.)
export interface CoverageReport {
  parsed: boolean;
  compiles: boolean;
  statements: number;
  firstError?: { code: string; message: string };
  blockers: Blocker[];
}

type Spec = { code: string; milestone: string; hint: string };

/**
 * Classify a per-statement parse failure into a blocker spec + feature label.
 *
 * A feature-level NYI thrown by the parser (a general union type, an optional call, …)
 * carries its own NT1xxx code, so pass it through. A raw `NT0001` is syntax outside the
 * accepted subset, and is reported honestly as an unparsed statement.
 *
 * NOTE (M3): this used to re-label any `NT0001` statement whose TEXT matched `Name<…>` as
 * an `NT1013` generics blocker. That heuristic is gone. Generic type arguments erase (SH2)
 * and generic FUNCTION definitions now monomorphize (M3), so a `<…>` in a statement no
 * longer implies generics are what blocked it — re-measured, every `NT1013` it reported
 * over `src/*.ts` was a MISATTRIBUTION of an unrelated failure (`this.pos++` on a member
 * target, `await`, a `\` escape). A blocker histogram that names the wrong feature is
 * worse than one that says "unparsed": it sends the burn-down at the wrong thing.
 */
function classifyParseFailure(_text: string, diag: { code: string; message: string; milestone?: string; hint?: string }): { spec: Spec; feature: string } {
  if (diag.code !== "NT0001") {
    return { spec: { code: diag.code, milestone: diag.milestone ?? "later", hint: diag.hint ?? "" }, feature: diag.message };
  }
  return { spec: { code: "NT0001", milestone: "later", hint: "syntax outside the accepted single-file subset" }, feature: "unparsed statement" };
}

export function coverage(source: string, entryPath?: string): CoverageReport {
  // SH1 modules: when the entry declares imports AND we know where it lives, report on
  // the WHOLE linked program (every module in the graph), not just this file — otherwise
  // every imported name would look undefined. A link failure (bad path, cycle, missing
  // export) falls through to the per-statement recovery path below, which reports it.
  // A `with { type: "text" }` import (SH5) binds a name for the same reason, and only
  // the link materializes it, so it takes the same path.
  let linked: Program | null = null;
  if (entryPath) {
    try {
      const p = parse(source);
      if (p.imports?.length || p.textImports?.length) linked = linkProgram(source, entryPath);
    } catch { /* reported by the recovery path */ }
  }
  // Coverage-only pre-strip: survive the module/type preamble (shebang, import,
  // export, type/interface, class) and regex literals that the real lexer/parser
  // reject, so a self-hosting source reaches a feature-level histogram instead of a
  // Tier-0 parse death. Normal programs carry none of this, so they pass through
  // essentially untouched (one statement per top-level statement).
  const pre = preprocessForCoverage(source);

  let found = new Map<string, Blocker>();
  // Constructs the pre-strip erased that are real blockers (classes → NT1012). A linked
  // multi-module program was parsed for real, so the pre-strip's guesses don't apply.
  const stripped = linked ? [] : pre.stripped;
  for (const b of stripped) {
    found = bumpBlocker(found, { code: b.code, milestone: b.milestone, hint: b.hint }, b.feature, b.count);
  }

  let statements = 0;
  const walkStmt = (s: Stmt): void => {
    statements++;
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) if (d.init) walkExpr(d.init); break;
      case "FuncDecl":
        for (const p of s.params) { if (p.default) walkExpr(p.default); }
        s.body.forEach(walkStmt); break;
      case "ReturnStmt": if (s.argument) walkExpr(s.argument); break;
      case "IfStmt": walkExpr(s.test); s.consequent.forEach(walkStmt); s.alternate?.forEach(walkStmt); break;
      case "WhileStmt": walkExpr(s.test); s.body.forEach(walkStmt); break;
      case "DoWhileStmt": walkExpr(s.test); s.body.forEach(walkStmt); break;
      case "ForStmt":
        if (s.init) { if ((s.init as Stmt).kind === "VarDecl") walkStmt(s.init as Stmt); else walkExpr(s.init as Expr); }
        if (s.test) walkExpr(s.test); if (s.update) walkExpr(s.update); s.body.forEach(walkStmt); break;
      case "ForOfStmt": walkExpr(s.iterable); s.body.forEach(walkStmt); break;
      case "ForInStmt": walkExpr(s.object); s.body.forEach(walkStmt); break;
      case "SwitchStmt": walkExpr(s.discriminant); for (const c of s.cases) { if (c.test) walkExpr(c.test); c.body.forEach(walkStmt); } break;
      case "ThrowStmt": walkExpr(s.argument); break;
      case "TryStmt": s.block.forEach(walkStmt); s.handler?.forEach(walkStmt); s.finalizer?.forEach(walkStmt); break;
      case "ExprStmt": walkExpr(s.expr); break;
      case "BlockStmt": s.body.forEach(walkStmt); break;
      case "MultiStmt": s.stmts.forEach(walkStmt); break;
      case "BreakStmt": case "ContinueStmt": break;
    }
  };

  const walkExpr = (e: Expr): void => {
    switch (e.kind) {
      case "ArrayLiteral": e.elements.forEach(walkExpr); break;
      case "ObjectLiteral": for (const p of e.properties) walkExpr(p.value); break;
      case "SpreadExpr": walkExpr(e.argument); break;
      case "IndexExpr": walkExpr(e.object); walkExpr(e.index); break;
      // Optional chaining `?.` is supported (Stage 21) — no longer a blocker; the
      // checker is the authority on any nullable shape it can't handle.
      case "MemberExpr": walkExpr(e.object); break;
      case "TemplateLiteral": e.exprs.forEach(walkExpr); break;
      case "SequenceExpr": e.exprs.forEach(walkExpr); break;
      case "UnaryExpr": walkExpr(e.operand); break;
      case "UpdateExpr": if (e.targetExpr) walkExpr(e.targetExpr); break; // `this.n++` / `u[i]++`
      case "TypeofExpr": walkExpr(e.operand); break;
      case "InstanceOfExpr": walkExpr(e.object); break;
      case "BinaryExpr": walkExpr(e.left); walkExpr(e.right); break;
      case "LogicalExpr": walkExpr(e.left); walkExpr(e.right); break;
      case "ConditionalExpr": walkExpr(e.test); walkExpr(e.consequent); walkExpr(e.alternate); break;
      case "AssignExpr": walkExpr(e.value); break;
      case "FieldAssign": walkExpr(e.object); walkExpr(e.value); break;
      case "CallExpr": walkExpr(e.callee); e.args.forEach(walkExpr); break;
      // Arrow functions / closures are supported (Stage 13) — no longer a blocker; walk
      // the body so nested unsupported constructs are still surfaced by the checker.
      case "ArrowFunction":
        if (e.exprBody) walkExpr(e.body as Expr); else (e.stmts as Stmt[]).forEach(walkStmt);
        break;
      default: break;
    }
  };

  // Parse each surviving top-level statement in isolation (recovery): a single
  // un-parseable statement is reported as a blocker rather than blanking the file.
  // Survivors are reassembled into one Program so the checker sees whole-program scope.
  // An accumulator, so it carries the `@@mutable` opt-in `.push` needs (docs/decorators.md);
  // and appended one at a time, because `push(...xs)` is NT1006. Both are the same subset
  // rule as `extra` in src/driver.ts's `writeIR`. Identical under bun.
  //@@mutable
  const body: Stmt[] = [];
  let firstError: { code: string; message: string } | undefined;
  let parseFailures = 0;
  if (linked) for (const s of linked.body) body.push(s);
  // Statement-at-a-time parsing loses everything a DECLARATION publishes, so the two
  // things later statements need are threaded across the loop by hand: the type-alias
  // table (`collectTypes` in, `typeEnv` out) and the `@@mutable` tag sets. Without them a
  // `@@mutable type Cell = …` in one statement would be invisible to the `c.n = 1` in the
  // next, and `coverage` would report an NT1606 the real compiler does not.
  // The preprocess ERASES the import preamble, which drops the imported binding NAMES
  // too — and then a call to one of them looks like a call to an unknown function, i.e.
  // the closure gap, which is not what is wrong (see `unlinkedImportError`). Recover the
  // names best-effort by parsing the whole file: when it parses we get them exactly, and
  // when it does not — the very case the preprocess exists for — we are no worse off than
  // before. Only the names are taken; the statements still come from the preprocess.
  let imports: ImportDecl[] = [];
  if (!linked) { try { imports = parse(source).imports ?? []; } catch { /* preamble does not parse; no names to recover */ } }
  const typeEnv = new Map<string, Ty>();
  let mutableClasses = new Set<string>();
  let mutableRecords = new Set<string>();
  for (const st of linked ? [] : pre.statements) {
    let prog: Program;
    try {
      // `externalTypeNames` — the names the preprocess deleted with the preamble and with
      // every `type`/`interface`. The annotations that use them survive into these
      // statements, so without handing them back the parser would refuse a name (NT2003)
      // the file does declare — a refusal invented by the strip.
      prog = parse(st.text, { typeEnv, collectTypes: typeEnv, externalTypeNames: pre.erasedNames });
      for (const c of prog.mutableClasses ?? []) mutableClasses = mutableClasses.add(c);
      for (const r of prog.mutableRecords ?? []) mutableRecords = mutableRecords.add(r);
    } catch (e) {
      parseFailures++;
      const diag = e instanceof NTError ? e.diag : { code: "NT0001", message: String(e) };
      const { spec, feature } = classifyParseFailure(st.text, diag);
      found = bumpBlocker(found, spec, feature, 1);
      if (!firstError) firstError = { code: spec.code, message: diag.message };
      continue;
    }
    for (const s of prog.body) body.push(s);
  }

  body.forEach(walkStmt);

  // The real semantic verdict comes from the checker over the reassembled survivors.
  let checkPassed = true;
  try {
    check(linked ?? {
      kind: "Program", body,
      ...(imports.length ? { imports } : {}),
      ...(mutableClasses.size ? { mutableClasses: [...mutableClasses] } : {}),
      ...(mutableRecords.size ? { mutableRecords: [...mutableRecords] } : {}),
    });
  } catch (e) {
    checkPassed = false;
    const err = e instanceof NTError ? { code: e.diag.code, message: e.diag.message } : { code: "NT9001", message: String(e) };
    if (!firstError) firstError = err;
    // A FEATURE blocker the CHECKER found belongs in the histogram too. It used to reach
    // only `firstError`, which made the histogram silently PARSE-centric: moving a
    // rejection from the parser to the checker — as immutable field assignment did when
    // `@@mutable` records arrived — would have looked like the blocker disappearing.
    // Only the NT1xxx band is counted: that is what "blocking features" means. An NT2xxx
    // TYPE error is a real user error, not a missing feature, and under this file's
    // statement-at-a-time recovery it is usually an artifact of the recovery itself
    // (a name whose declaring statement failed to parse) — it stays in `firstError`,
    // which still makes `compiles` false. The checker stops at its first error, so this
    // contributes at most one blocker per file: an under-count, never a fabricated win.
    if (e instanceof NTError && e.diag.code.startsWith("NT1")) {
      found = bumpBlocker(found, { code: e.diag.code, milestone: e.diag.milestone ?? "later", hint: e.diag.hint ?? "" }, e.diag.message, 1);
    }
  }

  const parsed = body.length > 0 || stripped.length > 0;
  const compiles = parsed && checkPassed && parseFailures === 0 && stripped.length === 0;
  const blockers = [...found.values()].sort((a, b) => a.milestone.localeCompare(b.milestone) || b.count - a.count);
  return { parsed, compiles, statements, firstError, blockers };
}

/**
 * Add `n` to the histogram bucket for `spec.code`, inserting it when it is new, and answer
 * the resulting table.
 *
 * PURE, and returning the Map rather than mutating one, because both halves of the old
 * spelling were outside the subset this compiler must compile ITSELF in:
 *   - `b.count++` on a fetched entry is NT1606 (`objects are immutable`), and
 *   - `found.set(key, b)` in statement position is the discarded-persistent-mutator class
 *     (see test/discarded-mutator.test.ts) — a nativets `Map.set` answers a NEW map and
 *     leaves the receiver alone, so the line was a guaranteed no-op there while working
 *     under bun. It was the one `coverage.ts` entry on that census.
 * Rebinding at the call site was not available either: `flag` was an ARROW closing over
 * `found`, and a write to a captured binding is NT1031. A top-level function taking the
 * table in and handing it back is the shape that has no such receiver problem.
 *
 * Identical under bun, where `.set` answers the receiver, so `found = bump(found, …)` is a
 * self-assignment. The FIRST spec to arrive under a code owns the label/milestone/hint —
 * the same rule the two old spellings agreed on.
 *
 * DECLARED BELOW `coverage`, not above it, and that is deliberate. `Blocker` is an IMPORTED
 * type, so in the STANDALONE (unlinked) view — the left-hand column of
 * test/selfhost-ratchet.test.ts — it resolves to nothing and falls through the parser's
 * last resort to `number`. Any function that CONSTRUCTS a Blocker therefore type-errors
 * there, and this one placed above `coverage` moved that module's standalone blocker from
 * the honest `unlinked-import artifact (standalone view is blind past this point)` to a
 * `.set value expects number` invented entirely by the missing import. The ratchet's own
 * advisory said as much — "the frontier did not move; your edit changed which construct is
 * hit first". Below `coverage`, the blind column keeps reporting its blindness. Function
 * declarations hoist, so the call sites above are unaffected in either toolchain.
 */
function bumpBlocker(found: Map<string, Blocker>, spec: Spec, feature: string, n: number): Map<string, Blocker> {
  const prev = found.get(spec.code);
  if (prev === undefined) {
    return found.set(spec.code, { code: spec.code, feature, milestone: spec.milestone, hint: spec.hint, count: n });
  }
  return found.set(spec.code, { code: prev.code, feature: prev.feature, milestone: prev.milestone, hint: prev.hint, count: prev.count + n });
}

/** Render a coverage report as a human-readable string. */
export function renderCoverage(source: string, report: CoverageReport): string {
  //@@mutable
  const lines: string[] = [];
  if (!report.parsed) {
    lines.push(`✗ parse failed: [${report.firstError!.code}] ${report.firstError!.message}`);
    return lines.join("\n");
  }
  const verdict = report.compiles ? "✅ STATIC — compiles to a native binary" : "⚠️  NOT fully static";
  lines.push(verdict);
  lines.push(`   statements analyzed: ${report.statements}`);
  if (!report.compiles && report.firstError) {
    lines.push(`   first blocker: [${report.firstError.code}] ${report.firstError.message}`);
  }
  if (report.blockers.length) {
    lines.push("");
    lines.push("   blocking features (by milestone, then frequency):");
    for (const b of report.blockers) {
      lines.push(`     ${b.code} ×${b.count}  [${b.milestone}]  ${b.feature} — ${b.hint}`);
    }
  } else if (report.compiles) {
    lines.push("   no unsupported features detected 🎉");
  }
  return lines.join("\n");
}
