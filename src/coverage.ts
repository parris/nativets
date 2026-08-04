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
import { check } from "./checker.ts";
import { NTError, NYI } from "./diagnostics.ts";

export interface Blocker { code: string; feature: string; milestone: string; hint: string; count: number; }
export interface CoverageReport {
  parsed: boolean;
  compiles: boolean;
  statements: number;
  firstError?: { code: string; message: string };
  blockers: Blocker[];
}

type Spec = { code: string; milestone: string; hint: string };

export function coverage(source: string): CoverageReport {
  let program: Program;
  try {
    program = parse(source);
  } catch (e) {
    const diag = e instanceof NTError ? e.diag : { code: "NT0001", message: String(e) };
    return { parsed: false, compiles: false, statements: 0, firstError: { code: diag.code, message: diag.message }, blockers: [] };
  }

  const found = new Map<string, Blocker>();
  const flag = (spec: Spec, feature: string) => {
    const key = spec.code;
    const b = found.get(key) ?? { code: spec.code, feature, milestone: spec.milestone, hint: spec.hint, count: 0 };
    b.count++;
    found.set(key, b);
  };

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
      case "MemberExpr": if ((e as any).optional) flag(NYI.OPTIONAL_CHAIN, "optional chaining"); walkExpr(e.object); break;
      case "TemplateLiteral": e.exprs.forEach(walkExpr); break;
      case "SequenceExpr": e.exprs.forEach(walkExpr); break;
      case "UnaryExpr": walkExpr(e.operand); break;
      case "UpdateExpr": break;
      case "TypeofExpr": walkExpr(e.operand); break;
      case "BinaryExpr": walkExpr(e.left); walkExpr(e.right); break;
      case "LogicalExpr": walkExpr(e.left); walkExpr(e.right); break;
      case "ConditionalExpr": walkExpr(e.test); walkExpr(e.consequent); walkExpr(e.alternate); break;
      case "AssignExpr": walkExpr(e.value); break;
      case "CallExpr": walkExpr(e.callee); e.args.forEach(walkExpr); break;
      case "ArrowFunction":
        flag(NYI.CLOSURE, "arrow function");
        if (e.exprBody) walkExpr(e.body as Expr); else (e.body as Stmt[]).forEach(walkStmt);
        break;
      default: break;
    }
  };

  program.body.forEach(walkStmt);

  let compiles = true;
  let firstError: { code: string; message: string } | undefined;
  try {
    check(parse(source));
  } catch (e) {
    compiles = false;
    if (e instanceof NTError) firstError = { code: e.diag.code, message: e.diag.message };
    else firstError = { code: "NT9001", message: String(e) };
  }

  const blockers = [...found.values()].sort((a, b) => a.milestone.localeCompare(b.milestone) || b.count - a.count);
  return { parsed: true, compiles, statements, firstError, blockers };
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
