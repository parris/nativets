/*
 * `nativets coverage` — the three-tier gradient, modeled on scriptc's coverage.
 *
 * Rather than a binary "does it compile?", report:
 *   - whether the file compiles statically end-to-end, and
 *   - a histogram of blocking features grouped by NT code + milestone + frequency,
 * so "unsupported" becomes an actionable, prioritized list.
 */

import type { Program, Stmt, Expr } from "./ast.ts";
import { parse } from "./parser.ts";
import { linkProgram } from "./modules.ts";
import { check } from "./checker.ts";
import { NTError } from "./diagnostics.ts";
import { preprocessForCoverage } from "./coverage-preprocess.ts";

export interface Blocker { code: string; feature: string; milestone: string; hint: string; count: number; }
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
  let linked: Program | null = null;
  if (entryPath) {
    try {
      if (parse(source).imports?.length) linked = linkProgram(source, entryPath);
    } catch { /* reported by the recovery path */ }
  }
  // Coverage-only pre-strip: survive the module/type preamble (shebang, import,
  // export, type/interface, class) and regex literals that the real lexer/parser
  // reject, so a self-hosting source reaches a feature-level histogram instead of a
  // Tier-0 parse death. Normal programs carry none of this, so they pass through
  // essentially untouched (one statement per top-level statement).
  const pre = preprocessForCoverage(source);

  const found = new Map<string, Blocker>();
  const flag = (spec: Spec, feature: string) => {
    const key = spec.code;
    const b = found.get(key) ?? { code: spec.code, feature, milestone: spec.milestone, hint: spec.hint, count: 0 };
    b.count++;
    found.set(key, b);
  };
  // Constructs the pre-strip erased that are real blockers (classes → NT1012). A linked
  // multi-module program was parsed for real, so the pre-strip's guesses don't apply.
  const stripped = linked ? [] : pre.stripped;
  for (const b of stripped) {
    const e = found.get(b.code);
    if (e) e.count += b.count;
    else found.set(b.code, { ...b });
  }

  let statements = 0;
  const walkStmt = (s: Stmt): void => {
    statements++;
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) walkExpr(d.init); break;
      case "FuncDecl":
        for (const p of s.params) { if (p.default) walkExpr(p.default); }
        s.body.forEach(walkStmt); break;
      case "ReturnStmt": if (s.argument) walkExpr(s.argument); break;
      case "IfStmt": walkExpr(s.test); s.consequent.forEach(walkStmt); s.alternate?.forEach(walkStmt); break;
      case "WhileStmt": walkExpr(s.test); s.body.forEach(walkStmt); break;
      case "DoWhileStmt": walkExpr(s.test); s.body.forEach(walkStmt); break;
      case "ForStmt":
        if (s.init) { if ((s.init as any).kind === "VarDecl") walkStmt(s.init as Stmt); else walkExpr(s.init as Expr); }
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
        if (e.exprBody) walkExpr(e.body as Expr); else (e.body as Stmt[]).forEach(walkStmt);
        break;
      default: break;
    }
  };

  // Parse each surviving top-level statement in isolation (recovery): a single
  // un-parseable statement is reported as a blocker rather than blanking the file.
  // Survivors are reassembled into one Program so the checker sees whole-program scope.
  const body: Stmt[] = [];
  let firstError: { code: string; message: string } | undefined;
  let parseFailures = 0;
  if (linked) body.push(...linked.body);
  for (const st of linked ? [] : pre.statements) {
    let prog: Program;
    try {
      prog = parse(st.text);
    } catch (e) {
      parseFailures++;
      const diag = e instanceof NTError ? e.diag : { code: "NT0001", message: String(e) };
      const { spec, feature } = classifyParseFailure(st.text, diag);
      flag(spec, feature);
      if (!firstError) firstError = { code: spec.code, message: diag.message };
      continue;
    }
    body.push(...prog.body);
  }

  body.forEach(walkStmt);

  // The real semantic verdict comes from the checker over the reassembled survivors.
  let checkPassed = true;
  try {
    check({ kind: "Program", body });
  } catch (e) {
    checkPassed = false;
    const err = e instanceof NTError ? { code: e.diag.code, message: e.diag.message } : { code: "NT9001", message: String(e) };
    if (!firstError) firstError = err;
  }

  const parsed = body.length > 0 || stripped.length > 0;
  const compiles = parsed && checkPassed && parseFailures === 0 && stripped.length === 0;
  const blockers = [...found.values()].sort((a, b) => a.milestone.localeCompare(b.milestone) || b.count - a.count);
  return { parsed, compiles, statements, firstError, blockers };
}

/** Render a coverage report as a human-readable string. */
export function renderCoverage(source: string, report: CoverageReport): string {
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
