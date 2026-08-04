/*
 * Ownership / linear-move checker — modeled on rustc's borrowck (a separate pass
 * over the checked AST, not part of type-checking).
 *
 * Model (phase 1): heap aggregates (arrays) are LINEAR — single-owner. Scalars
 * (number/boolean) and strings are `Copy`/shared and untracked. A linear value is
 * consumed (moved) by binding it to a new name (`let b = a`), returning it, or the
 * explicit `move(a)` form. Method calls, indexing, `.length`, and `for-of` are
 * BORROWS (reads) and do not consume. Using a value after it is moved is an error.
 *
 * Analysis: a forward dataflow with the lattice { Init, Moved } (join = Moved, i.e.
 * "maybe-moved" ⇒ moved), exactly as the rustc-dev-guide describes. `if` merges
 * both branches; loops iterate to a fixpoint so a value moved in the body is seen
 * as moved at the loop head (a re-move on the next iteration is flagged).
 *
 * Error codes (NT16xx band, mapping to Rust's E-codes):
 *   NT1601  use of moved value            (≈ E0382)
 * Deferred to phase 2: NT1602 move-while-borrowed (E0505), NT1603 borrow
 * exclusivity (E0499/E0502), and move-out-of-borrow/array/Drop (E0507/8/9).
 */

import type { CheckedProgram } from "./checker.ts";
import type { Program, Stmt, Expr, FuncDecl } from "./ast.ts";
import { isArrayTy, isObjectTy } from "./ast.ts";

/** The linear (single-owner, move-checked + dropped) types: heap aggregates. */
function isLinearTy(t: import("./ast.ts").Ty): boolean { return isArrayTy(t) || isObjectTy(t); }

export const OWN_CODES = {
  USE_AFTER_MOVE: "NT1601",      // ≈ E0382
  MOVE_WHILE_BORROWED: "NT1602", // ≈ E0505
  MUTATE_WHILE_BORROWED: "NT1603", // ≈ E0502 (iterator invalidation)
} as const;

/** Methods that mutate an array in place (so they conflict with a live borrow). */
const MUTATING = new Set(["push", "pop"]);

export interface OwnDiag { code: string; message: string; line: number; movedAt?: number; }

type VarState = { moved: boolean; at?: number };
type State = Map<string, VarState>;

const clone = (s: State): State => new Map([...s].map(([k, v]) => [k, { ...v }]));
function merge(a: State, b: State): State {
  const out: State = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(k), vb = b.get(k);
    const moved = !!va?.moved || !!vb?.moved;
    out.set(k, { moved, at: va?.at ?? vb?.at });
  }
  return out;
}
function sameMoves(a: State, b: State): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if (!!a.get(k)?.moved !== !!b.get(k)?.moved) return false;
  return true;
}
function assignInto(dst: State, src: State): void { dst.clear(); for (const [k, v] of src) dst.set(k, v); }

function isMoveCall(e: Expr): boolean {
  return e.kind === "CallExpr" && e.callee.kind === "Identifier" && e.callee.name === "move";
}

class Analyzer {
  readonly diags: OwnDiag[] = [];
  private collecting = true;
  constructor(private linear: Set<string>, private topLevel: string[]) {}

  /** Arrays currently borrowed by an enclosing for-of (lexical, count for nesting). */
  private borrowed = new Map<string, number>();
  private pushBorrow(n: string): void { this.borrowed.set(n, (this.borrowed.get(n) ?? 0) + 1); }
  private popBorrow(n: string): void { const c = (this.borrowed.get(n) ?? 1) - 1; if (c <= 0) this.borrowed.delete(n); else this.borrowed.set(n, c); }
  private isBorrowed(n: string): boolean { return this.borrowed.has(n); }

  /** Top-level linear locals still owned (not moved) in `state` — the drop set. */
  ownedTopLevel(state: State): string[] {
    return this.topLevel.filter((n) => state.has(n) && !state.get(n)!.moved);
  }

  private report(d: OwnDiag): void { if (this.collecting) this.diags.push(d); }

  seq(stmts: Stmt[], state: State): void { for (const s of stmts) this.stmt(s, state); }

  private stmt(s: Stmt, state: State): void {
    switch (s.kind) {
      case "VarDecl":
        for (const d of s.decls) {
          this.expr(d.init, state, true);
          if (isLinearTy(d.ty ?? "number")) state.set(d.name, { moved: false });
        }
        return;
      case "ExprStmt": this.expr(s.expr, state, false); return;
      case "ReturnStmt":
        if (s.argument) this.expr(s.argument, state, true); // returning a bare value moves it out
        s.drops = this.ownedTopLevel(state); // free everything still owned before returning
        return;
      case "IfStmt": {
        this.expr(s.test, state, false);
        const s1 = clone(state);
        this.seq(s.consequent, s1);
        const s2 = clone(state);
        if (s.alternate) this.seq(s.alternate, s2);
        assignInto(state, merge(s1, s2));
        return;
      }
      case "WhileStmt":
        this.loop(state, (st) => { this.expr(s.test, st, false); this.seq(s.body, st); });
        return;
      case "DoWhileStmt":
        this.loop(state, (st) => { this.seq(s.body, st); this.expr(s.test, st, false); });
        return;
      case "ForStmt": {
        if (s.init) { if ((s.init as any).kind === "VarDecl") this.stmt(s.init as Stmt, state); else this.expr(s.init as Expr, state, false); }
        this.loop(state, (st) => {
          if (s.test) this.expr(s.test, st, false);
          this.seq(s.body, st);
          if (s.update) this.expr(s.update, st, false);
        });
        return;
      }
      case "ForOfStmt": {
        this.expr(s.iterable, state, false); // borrow the iterable
        // for-of holds a borrow of a linear array for the whole loop body.
        const bv = s.iterable.kind === "Identifier" && this.linear.has(s.iterable.name) ? s.iterable.name : null;
        if (bv) this.pushBorrow(bv);
        this.loop(state, (st) => { this.seq(s.body, st); });
        if (bv) this.popBorrow(bv);
        return;
      }
      case "SwitchStmt": {
        this.expr(s.discriminant, state, false);
        const merged = s.cases.map((c) => { const cs = clone(state); this.seq(c.body, cs); return cs; });
        for (const m of merged) assignInto(state, merge(state, m));
        return;
      }
      case "ForInStmt":
        this.expr(s.object, state, false);
        this.loop(state, (st) => { this.seq(s.body, st); });
        return;
      case "BlockStmt": this.seq(s.body, state); return;
      case "MultiStmt": this.seq(s.stmts, state); return;
      case "ThrowStmt": this.expr(s.argument, state, false); return;
      case "TryStmt":
        this.seq(s.block, state);
        if (s.handler) this.seq(s.handler, state);
        if (s.finalizer) this.seq(s.finalizer, state);
        return;
      case "BreakStmt": case "ContinueStmt": case "FuncDecl":
        return;
    }
  }

  /** Iterate a loop body to a fixpoint (suppressing diagnostics), then one final
   *  pass that reports — so a value moved in the body is flagged on re-move. */
  private loop(state: State, iter: (st: State) => void): void {
    const prev = this.collecting;
    this.collecting = false;
    let entry = clone(state);
    for (let i = 0; i < 4; i++) {
      const st = clone(entry);
      iter(st);
      const m = merge(entry, st);
      if (sameMoves(m, entry)) break;
      entry = m;
    }
    this.collecting = prev;
    const st = clone(entry);
    iter(st); // reporting pass
    assignInto(state, merge(state, entry));
    this.collecting = prev;
  }

  /** `consume` = this position takes ownership (move); otherwise it's a borrow. */
  private expr(e: Expr, state: State, consume: boolean): void {
    switch (e.kind) {
      case "Identifier": {
        if (!this.linear.has(e.name)) return;
        const st = state.get(e.name);
        if (st?.moved) {
          this.report({ code: OWN_CODES.USE_AFTER_MOVE, message: `use of moved value: \`${e.name}\``, line: e.loc?.line ?? 0, movedAt: st.at });
          return;
        }
        if (consume) {
          if (this.isBorrowed(e.name)) {
            // a move conflicts with the live borrow — report and do NOT mark moved (no cascade)
            this.report({ code: OWN_CODES.MOVE_WHILE_BORROWED, message: `cannot move \`${e.name}\` because it is borrowed`, line: e.loc?.line ?? 0 });
            return;
          }
          state.set(e.name, { moved: true, at: e.loc?.line });
        }
        return;
      }
      case "CallExpr": {
        if (isMoveCall(e)) { this.expr(e.args[0]!, state, true); return; }
        if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier") {
          const recv = e.callee.object.name;
          if (this.linear.has(recv) && this.isBorrowed(recv) && MUTATING.has(e.callee.property)) {
            this.report({ code: OWN_CODES.MUTATE_WHILE_BORROWED, message: `cannot mutate \`${recv}\` while it is borrowed (iterator invalidation)`, line: e.callee.object.loc?.line ?? 0 });
          }
        }
        if (e.callee.kind === "MemberExpr") this.expr(e.callee.object, state, false); // receiver borrow
        for (const a of e.args) this.expr(a, state, false); // args borrowed
        return;
      }
      case "AssignExpr":
        this.expr(e.value, state, true);
        if (this.linear.has(e.target)) state.set(e.target, { moved: false }); // reassignment revives
        return;
      case "MemberExpr": this.expr(e.object, state, false); return;
      case "IndexExpr": this.expr(e.object, state, false); this.expr(e.index, state, false); return;
      case "BinaryExpr": this.expr(e.left, state, false); this.expr(e.right, state, false); return;
      case "LogicalExpr": this.expr(e.left, state, false); this.expr(e.right, state, false); return;
      case "UnaryExpr": this.expr(e.operand, state, false); return;
      case "TypeofExpr": this.expr(e.operand, state, false); return;
      case "ConditionalExpr":
        this.expr(e.test, state, false); this.expr(e.consequent, state, false); this.expr(e.alternate, state, false);
        return;
      case "TemplateLiteral": for (const x of e.exprs) this.expr(x, state, false); return;
      case "ArrayLiteral": for (const el of e.elements) this.expr(el, state, false); return;
      case "SpreadExpr": this.expr(e.argument, state, false); return; // spread copies (borrow)
      case "NewExpr": for (const a of e.args) this.expr(a, state, false); return;
      case "AsExpr": this.expr(e.expr, state, false); return;
      case "ObjectLiteral": for (const p of e.properties) this.expr(p.value, state, true); return; // fields move into the object
      case "ArrowFunction": // analyze body in the enclosing scope (captures/params aren't linear here)
        if (e.exprBody) this.expr(e.body as Expr, state, false);
        else this.seq(e.body as Stmt[], state);
        return;
      case "SequenceExpr": for (const x of e.exprs) this.expr(x, state, false); return;
      default: return; // literals, update (numeric), unreachable kinds
    }
  }
}

function collectLinear(stmts: Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) if (isLinearTy(d.ty ?? "number")) out.add(d.name); break;
      case "IfStmt": collectLinear(s.consequent, out); if (s.alternate) collectLinear(s.alternate, out); break;
      case "WhileStmt": case "DoWhileStmt": collectLinear(s.body, out); break;
      case "ForStmt": if (s.init && (s.init as any).kind === "VarDecl") collectLinear([s.init as Stmt], out); collectLinear(s.body, out); break;
      case "ForOfStmt": collectLinear(s.body, out); break;
      case "SwitchStmt": for (const c of s.cases) collectLinear(c.body, out); break;
      case "BlockStmt": collectLinear(s.body, out); break;
      case "MultiStmt": collectLinear(s.stmts, out); break;
      default: break;
    }
  }
}

export function analyzeOwnership(checked: CheckedProgram): OwnDiag[] {
  const diags: OwnDiag[] = [];

  const runScope = (body: Stmt[], params: { name: string; ty: import("./ast.ts").Ty }[]): string[] => {
    const linear = new Set<string>();
    for (const p of params) if (isLinearTy(p.ty)) linear.add(p.name);
    collectLinear(body, linear);
    // Droppable = linear locals declared directly in this scope (NOT params — those
    // are borrowed, the caller owns them).
    const topLevel: string[] = [];
    for (const s of body) if (s.kind === "VarDecl") for (const d of s.decls) if (isLinearTy(d.ty ?? "number")) topLevel.push(d.name);
    const a = new Analyzer(linear, topLevel);
    const st: State = new Map(params.filter((p) => isLinearTy(p.ty)).map((p) => [p.name, { moved: false }]));
    a.seq(body, st);
    diags.push(...a.diags);
    return a.ownedTopLevel(st);
  };

  checked.program.endDrops = runScope(checked.program.body, []);
  for (const s of checked.program.body) {
    if (s.kind === "FuncDecl") {
      const sig = checked.functions.get(s.name)!;
      s.endDrops = runScope(s.body, s.params.map((p, i) => ({ name: p.name, ty: sig.params[i]! })));
    }
  }
  return diags;
}
