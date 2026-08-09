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
 *   NT1601  use of moved value               (≈ E0382)
 *   NT1602  move while borrowed               (≈ E0505)
 *   NT1603  mutate while borrowed / iter-inval(≈ E0502)
 *   NT1604  move out of borrowed content      (≈ E0507) — a for-of element or by-borrow param
 *   NT1605  move out of a linear array element(≈ E0508) — `arr[i]` where the element is linear
 * Deferred: move-out-of-borrow for the general (non-for-of) borrow, and Drop-typed moves (E0509).
 */

import type { CheckedProgram } from "./checker.ts";
import type { Program, Stmt, Expr, FuncDecl } from "./ast.ts";
import { isArrayTy, isObjectTy, isUnionTy, isTypeRefTy, isFuncTy, setBlockDrops, classTag, mutableTags, RETAINS_RECEIVER } from "./ast.ts";

/** The linear (single-owner, move-checked + dropped) types: heap aggregates. A
 *  DISCRIMINATED UNION (SH2) is one of them: its value IS a member's object block, so
 *  it is owned, moved and freed exactly like the record it is. */
/* A recursive node (`@N`) is an owned heap object exactly like the shape it names, so it is
 * LINEAR. Left out, `isLinearTy` answered false and the whole memory-safety story switched
 * off for the new encoding at once: no move checking, no borrow rules, and — because
 * `declaredLinear` feeds the drop list — no drop emitted either. */
function isLinearTy(t: import("./ast.ts").Ty): boolean { return isArrayTy(t) || isObjectTy(t) || isUnionTy(t) || isTypeRefTy(t); }

export const OWN_CODES = {
  USE_AFTER_MOVE: "NT1601",      // ≈ E0382
  MOVE_WHILE_BORROWED: "NT1602", // ≈ E0505
  MUTATE_WHILE_BORROWED: "NT1603", // ≈ E0502 (iterator invalidation)
  MOVE_OUT_OF_BORROW: "NT1604",  // ≈ E0507 (move out of a for-of element / by-borrow param)
  MOVE_OUT_OF_ARRAY: "NT1605",   // ≈ E0508 (move out of a linear array element `arr[i]`)
  MUTATE_THROUGH_BORROW: "NT1607", // ≈ E0596 (`@@mutable` setter called on a handle we don't own)
} as const;

/**
 * `@@mutable` classes (decorators lane) — the exclusive-access rule.
 *
 * An `@@mutable` instance really mutates, and every handle observes it. Two adjustments
 * to the linear model make that both expressible AND single-owner:
 *
 *  1. `const b = a` is an ALIAS (a borrow), not a move — that is what "every alias
 *     observes it" means. Ownership stays with the original binding, which is the one
 *     and only place the value is dropped, so aliasing can never double-free. An alias
 *     is registered as a borrow binding, so moving out of it (returning it, `move(b)`,
 *     storing it into a container) is the existing NT1604 — it can never outlive its
 *     owner by escaping.
 *  2. Only an OWNER may mutate (`&mut self`). Calling a SETTER — a method that assigns
 *     `this.f` — through anything the analysis does not know we own (an alias, a
 *     by-borrow parameter, a `for-of` element) is NT1607.
 */
export interface MutableInfo {
  /** Class tags carrying `@@mutable`. */
  classes: Set<string>;
  /** `Class.method` names that assign a field (setters), across all classes. */
  setters: Set<string>;
  /** Just the METHOD names of the above — the conservative check for a receiver whose
   *  type the pass cannot resolve (a container element, a callback parameter). */
  setterProps: Set<string>;
}
const NO_MUTABLE: MutableInfo = { classes: new Set(), setters: new Set(), setterProps: new Set() };

/** Methods that mutate an array in place (so they conflict with a live borrow). */
const MUTATING = new Set(["push", "pop"]);

/** Does this call hand its receiver back? Only the ARRAY builtin does, so BOTH the
 *  receiver and the result must be arrays — the method NAME alone is not enough. A user
 *  class may define its own `.reverse()`, on any receiver, returning anything it built;
 *  treating that as receiver-retaining would leak the fresh value it returns and
 *  spuriously refuse handing it out. */
function retainsReceiver(e: Expr): boolean {
  if (e.kind !== "CallExpr" || e.callee.kind !== "MemberExpr") return false;
  if (!RETAINS_RECEIVER.has(e.callee.property)) return false;
  const recvTy = e.callee.object.ty;
  return e.ty !== undefined && isArrayTy(e.ty) && recvTy !== undefined && isArrayTy(recvTy);
}

/** `a.reverse()` ⇒ `"a"`: a receiver-retaining call made directly on a BINDING, whose
 *  result is therefore a second name for that binding's allocation. A chained receiver
 *  (`a.map(f).reverse()`) is deliberately NOT a match — there the receiver is a fresh
 *  temporary that no binding owns, so the result legitimately becomes its owner. */
function retainedReceiver(e: Expr): string | null {
  if (!retainsReceiver(e)) return null;
  const base = (e as { callee: { object: Expr } }).callee.object;
  return base.kind === "Identifier" ? base.name : null;
}

export interface OwnDiag { code: string; message: string; line: number; movedAt?: number; hint?: string; }

/**
 * `moved` is MAY-move (join = OR) — the lattice the use-after-move check reads, so a
 * value moved on one path is an error to use on any path. `must` is MUST-move
 * (join = AND): it separates "definitely gone" from "gone only on some path", which is
 * exactly rustc's DROP-FLAG question. A may-but-not-must-moved value still has an owner
 * at runtime on some paths, so it must still be dropped — see `nullOnMove`.
 */
type VarState = { moved: boolean; must: boolean; at?: number };
type State = Map<string, VarState>;

/*
 * A SHALLOW copy of the state map — same keys, same order, a fresh `VarState` each.
 * Spelled as a loop rather than `new Map([...s].map(([k, v]) => [k, { ...v }]))`
 * because spreading a Map yields `[key, value]` PAIRS, and nativets has no tuple
 * type (NT1014) — the same gap the entries form hits from the other side. This is
 * what the Map constructor does internally anyway (ES2024 24.1.1.1 §8 calls `set`
 * once per entry, in order; 24.1.3.9 §8 makes `set` return its receiver), so the two
 * spellings are one program by construction — pinned against node in
 * `test/collections.test.ts`. It also drops an intermediate pair array under bun.
 */
const clone = (s: State): State => {
  let out: State = new Map<string, VarState>();
  for (const [k, v] of s) out = out.set(k, { ...v });
  return out;
};
function merge(a: State, b: State): State {
  const out: State = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(k), vb = b.get(k);
    const moved = !!va?.moved || !!vb?.moved;
    const must = !!va?.must && !!vb?.must;   // definitely moved only if moved on BOTH paths
    out.set(k, { moved, must, at: va?.at ?? vb?.at });
  }
  return out;
}
function sameMoves(a: State, b: State): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if (!!a.get(k)?.moved !== !!b.get(k)?.moved) return false;
  return true;
}
function assignInto(dst: State, src: State): void { dst.clear(); for (const [k, v] of src) dst.set(k, v); }

/** Best-effort source line of an expression (dig through member/index/call to a located leaf). */
function lineOf(e: Expr): number {
  switch (e.kind) {
    case "Identifier": return e.loc?.line ?? 0;
    case "MemberExpr": case "IndexExpr": return lineOf(e.object);
    case "CallExpr": return lineOf(e.callee);
    default: return 0;
  }
}

/** Peel a method CHAIN back to what it started from: `a.bump().bump()` ⇒ `a`. */
function chainRoot(e: Expr): Expr {
  let cur = e;
  while (cur.kind === "CallExpr" && cur.callee.kind === "MemberExpr") cur = cur.callee.object;
  return cur;
}

function isMoveCall(e: Expr): boolean {
  return e.kind === "CallExpr" && e.callee.kind === "Identifier" && e.callee.name === "move";
}

/**
 * stdlib Batch 3: `Object.freeze(o)` hands back the SAME pointer (objects are
 * already immutable, so freezing is the identity — and node guarantees
 * `Object.freeze(o) === o`). It therefore behaves like a bare `o` for ownership:
 * transparent, so it consumes exactly when the surrounding position consumes.
 */
function isIdentityCall(e: Expr): boolean {
  return e.kind === "CallExpr" && e.callee.kind === "MemberExpr" && e.callee.property === "freeze"
    && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object" && e.args.length === 1;
}

// The dataflow analyzer mutates its own borrow/alias/arrow-depth state as it walks — one
// owned object, mutated in place. `@@mutable`, in the pragma spelling (src/lexer.ts).
//@@mutable
class Analyzer {
  readonly diags: OwnDiag[] = [];
  private collecting = true;
  constructor(
    private linear: Set<string>,
    private topLevel: string[],
    paramBorrows: string[] = [],
    /** Names read from inside an arrow body. A closure copies the pointer into its
     *  env, so the binding is no longer the only reference — reassigning it must NOT
     *  free the old value (the closure may outlive the assignment). Conservative:
     *  over-approximated by "mentioned anywhere inside any arrow in this scope". */
    private captured: Set<string> = new Set(),
    /** `@@mutable` classes + their setters, and the static type of every tracked name —
     *  what the exclusive-access rule above is decided from. */
    private mutable: MutableInfo = NO_MUTABLE,
    private varTy: Map<string, import("./ast.ts").Ty> = new Map(),
    /** alias name → the binding that OWNS the value (`const b = a` ⇒ b → a). */
    private aliasOf: Map<string, string> = new Map(),
    /** class tag → the ARGUMENT indices its constructor CONSUMES (parameter properties
     *  of a linear type). Empty for every program without one, so the rule is inert. */
    private consuming: Map<string, Set<number>> = new Map(),
  ) {
    for (const p of paramBorrows) { this.borrowBindings.add(p); this.borrowParams.add(p); }
    for (const a of aliasOf.keys()) this.borrowBindings.add(a); // an alias may never escape
    for (const owner of aliasOf.values()) if (owner) this.aliasedOwners.add(owner);
  }

  /** Owners that something else aliases — reassigning one would dangle the alias. */
  private readonly aliasedOwners = new Set<string>();

  /** The subset of `borrowBindings` that are PARAMETERS — the ones whose fix is a
   *  consuming parameter rather than "use the owner instead". */
  private readonly borrowParams = new Set<string>();

  /** Is this type an instance of an `@@mutable` class? */
  private isMutableInstance(ty: import("./ast.ts").Ty): boolean {
    if (!this.mutable.classes.size || !isObjectTy(ty)) return false;
    const tag = classTag(ty);
    return tag !== undefined && this.mutable.classes.has(tag);
  }

  /** The `@@mutable` class tag of a name's static type, if it has one. */
  private mutableClassOf(name: string): string | undefined {
    const ty = this.varTy.get(name);
    if (ty === undefined || !this.isMutableInstance(ty)) return undefined;
    return classTag(ty);
  }

  /** Collection mode: record every name an arrow body mentions (pass 1). */
  private arrowDepth = 0;
  readonly arrowNames = new Set<string>();

  /** Names bound to a BORROW rather than owned: by-borrow params (whole scope) and for-of
   *  loop variables over a LINEAR element (loop body). Moving out of any is E0507 (NT1604). */
  private borrowBindings = new Set<string>();

  /** Arrays currently borrowed by an enclosing for-of (lexical, count for nesting). */
  private borrowed = new Map<string, number>();
  private pushBorrow(n: string): void { this.borrowed.set(n, (this.borrowed.get(n) ?? 0) + 1); }
  private popBorrow(n: string): void { const c = (this.borrowed.get(n) ?? 1) - 1; if (c <= 0) this.borrowed.delete(n); else this.borrowed.set(n, c); }
  private isBorrowed(n: string): boolean { return this.borrowed.has(n); }

  /**
   * DROP DECISION for one name at one program point — the rustc drop-flag question.
   *   - not moved on any path        → drop it (the common case, no flag needed);
   *   - moved on EVERY path (`must`) → never drop (the new owner will);
   *   - moved on SOME path           → still drop, but the value needs a runtime flag.
   * Our flag is free: the move NULLS the variable's slot (see `nullOnMove` / codegen)
   * and `nt_arr_free(NULL)` / `nt_obj_free(NULL)` are no-ops, so the pointer IS the
   * drop flag and the drop stays a single unconditional call. A name a closure
   * captured is excluded — its env holds a second pointer we cannot null.
   */
  private droppable(n: string, state: State): boolean {
    const st = state.get(n);
    if (!st) return false;
    if (!st.moved) return true;
    if (st.must || this.captured.has(n)) return false;
    this.condDrops.add(n); // ⇒ every move of `n` must null its slot
    return true;
  }

  /** Names that need the null-on-move drop flag, and the move sites to null at. */
  readonly condDrops = new Set<string>();
  readonly moveSites = new Map<string, Set<Expr>>();

  /** Top-level linear locals to free at this point — the scope-exit drop set. */
  ownedTopLevel(state: State): string[] {
    return this.topLevel.filter((n) => this.droppable(n, state));
  }

  /** Linear locals of every ACTIVE scope that are still owned — what a `return` from
   *  inside a nested block must free (innermost first). */
  private ownedInScope(state: State): string[] {
    const out: string[] = [];
    for (let i = this.scopes.length - 1; i >= 0; i--) out.push(...this.scopes[i]!.filter((n) => this.droppable(n, state)));
    out.push(...this.ownedTopLevel(state));
    // A `return` jumps past every block's drop marker, so it frees the enclosing
    // closure envs too. Never both: reaching the marker means not having returned.
    for (let i = this.closureScopes.length - 1; i >= 0; i--) out.push(...this.closureScopes[i]!);
    out.push(...this.topClosures);
    return out;
  }

  /** Stack of nested block scopes (their directly-declared linear locals). */
  private scopes: string[][] = [];

  /** The same stack for provably-owned closure envs, plus this scope's own top-level
   *  ones (`runScope` sets it, and returns the same list as the fall-through drops). */
  private closureScopes: string[][] = [];
  topClosures: string[] = [];
  /** Names with more than one declaration in this scope tree — they share a frame slot,
   *  so no closure env bound to one can be proved uniquely owned (`shadowedNames`). */
  shadowed: Set<string> = new Set();

  private report(d: OwnDiag): void { if (this.collecting) this.diags.push(d); }

  seq(stmts: Stmt[], state: State): void { for (const s of stmts) this.stmt(s, state); }

  /** A NESTED statement list: its own linear locals are freed at its fall-through exit
   *  (`blockDrops`), so a value that never leaves the block does not wait for the
   *  function to return. Move-aware — a local moved out of the block is not dropped.
   *  `break`/`continue`/`throw` jump past the drop point: a leak, never a double free. */
  private scoped(list: Stmt[], state: State): void {
    const declared = declaredLinear(list, new Set(this.aliasOf.keys())).filter((n) => this.linear.has(n));
    // Closure envs the block provably owns (see `nonEscapingClosures`). Purely
    // syntactic, so unlike `declared` they need no move state and no `droppable` check —
    // a name that could be moved anywhere is not a candidate in the first place.
    const envs = nonEscapingClosures(list, this.shadowed);
    if (declared.length === 0 && envs.length === 0) { this.seq(list, state); return; }
    this.scopes.push(declared);
    this.closureScopes.push(envs);
    this.seq(list, state);
    this.scopes.pop();
    this.closureScopes.pop();
    setBlockDrops(list, [...declared.filter((n) => this.droppable(n, state)), ...envs]);
  }

  /**
   * An arrow BODY is a scope of its own. `runScope` builds `linear` with
   * `collectLinear`, which walks statements and never descends into an expression — so
   * a linear local an arrow body declared was invisible to it, `scoped()` intersected
   * the block's declarations with an empty `linear`, and every nested block inside a
   * callback got an empty drop set. The array was allocated once per element and never
   * freed. (A `.map` callback is INLINED, so those statements really do run in the
   * enclosing function; the same body in a plain function frees correctly.)
   *
   * The body's own names are added to `linear` only for the duration of the walk, so
   * they are linear exactly where they are in scope — and only the ones NOT already
   * there are removed afterwards, or an arrow local shadowing an enclosing linear name
   * would un-track the enclosing one for the rest of the function.
   *
   * `linear` is otherwise read-only during a walk, which the fixpoint in `loop()` leans
   * on (test/block-drops.test.ts): a body is re-walked up to five times and `scoped()`'s
   * "no linear locals ⇒ no marker" decision has to come out the same every time. It
   * still does — what is added here is a pure function of the arrow's AST, and it is
   * added on every walk before any nested `scoped()` inside the arrow runs.
   *
   * ALIASES are excluded, and that exclusion is the double-free guard. `collectAliases`
   * does not descend into arrows either, so `const b = a.reverse()` inside a callback
   * body leaves `b` unrecorded; making it linear would put BOTH names in the block's
   * drop set and free the one allocation twice. Not linear ⇒ not droppable, which is
   * exactly the treatment the enclosing scope gives an alias.
   *
   * And the body runs through `loop()`, because a `.map`/`.filter`/… callback IS a loop
   * body — it is inlined into a loop over the receiver, which nothing else in this pass
   * can see. Walking it once was what made the drops unsafe to add: `const a: number[] =
   * base` MOVES a captured array into a body-local, and dropping that local at the
   * block's exit frees `base` on the first element and again on every element after —
   * a double free (observed: exit 255, no output, against 11,12,13). The fixpoint
   * catches the re-move on walk two and refuses it as NT1601, exactly as the same body
   * written as a `for-of` already does. `setBlockDrops` replacing rather than appending
   * is what makes the re-walk safe (test/block-drops.test.ts).
   */
  private arrowScope(list: Stmt[], state: State): void {
    const own = new Set<string>();
    collectLinear(list, own);
    const aliases = new Map<string, string>();
    collectAliases(list, (t) => this.isMutableInstance(t), aliases);
    for (const a of aliases.keys()) own.delete(a); // an alias owns nothing, so it is never dropped
    const added: string[] = [];
    for (const n of own) if (!this.linear.has(n)) { this.linear.add(n); added.push(n); }
    this.loop(state, (st) => { this.scoped(list, st); });
    for (const n of added) this.linear.delete(n);
  }

  private stmt(s: Stmt, state: State): void {
    switch (s.kind) {
      case "VarDecl":
        for (const d of s.decls) {
          // An ALIAS of an `@@mutable` instance (`const b = a`) BORROWS — it does not
          // consume `a`, and it is never an owner, so it is never dropped either.
          // No initializer (`let x: T;`) — nothing is consumed or borrowed at the
          // declaration; the binding becomes owned at its first ASSIGNMENT.
          if (d.init) this.expr(d.init, state, !this.aliasOf.has(d.name));
          if (isLinearTy(d.ty ?? "number")) state.set(d.name, { moved: false, must: false });
        }
        return;
      case "ExprStmt": this.expr(s.expr, state, false); return;
      case "ReturnStmt":
        if (s.argument) this.expr(s.argument, state, true); // returning a bare value moves it out
        s.drops = this.ownedInScope(state); // free everything still owned before returning
        return;
      case "IfStmt": {
        this.expr(s.test, state, false);
        const s1 = clone(state);
        this.scoped(s.consequent, s1);
        const s2 = clone(state);
        if (s.alternate) this.scoped(s.alternate, s2);
        assignInto(state, merge(s1, s2));
        return;
      }
      case "WhileStmt":
        this.loop(state, (st) => { this.expr(s.test, st, false); this.scoped(s.body, st); });
        return;
      case "DoWhileStmt":
        this.loop(state, (st) => { this.scoped(s.body, st); this.expr(s.test, st, false); });
        return;
      case "ForStmt": {
        if (s.init) { if ((s.init as any).kind === "VarDecl") this.stmt(s.init as Stmt, state); else this.expr(s.init as Expr, state, false); }
        this.loop(state, (st) => {
          if (s.test) this.expr(s.test, st, false);
          this.scoped(s.body, st);
          if (s.update) this.expr(s.update, st, false);
        });
        return;
      }
      case "ForOfStmt": {
        this.expr(s.iterable, state, false); // borrow the iterable
        // for-of holds a borrow of a linear array for the whole loop body.
        const bv = s.iterable.kind === "Identifier" && this.linear.has(s.iterable.name) ? s.iterable.name : null;
        if (bv) this.pushBorrow(bv);
        // If the element type is linear, the loop var only BORROWS each element —
        // moving it out of the loop is E0507 (NT1604).
        const elemBorrow = s.elemTy !== undefined && isLinearTy(s.elemTy);
        if (elemBorrow) this.borrowBindings.add(s.name);
        this.loop(state, (st) => { this.scoped(s.body, st); });
        if (elemBorrow) this.borrowBindings.delete(s.name);
        if (bv) this.popBorrow(bv);
        return;
      }
      case "SwitchStmt": {
        this.expr(s.discriminant, state, false);
        const merged = s.cases.map((c) => { const cs = clone(state); this.scoped(c.body, cs); return cs; });
        for (const m of merged) assignInto(state, merge(state, m));
        return;
      }
      case "ForInStmt":
        this.expr(s.object, state, false);
        this.loop(state, (st) => { this.scoped(s.body, st); });
        return;
      case "BlockStmt": this.scoped(s.body, state); return;
      case "MultiStmt": this.seq(s.stmts, state); return; // scope-less group: its decls belong to the enclosing block
      case "ThrowStmt": this.expr(s.argument, state, false); return;
      case "TryStmt":
        this.scoped(s.block, state);
        if (s.handler) this.scoped(s.handler, state);
        if (s.finalizer) this.scoped(s.finalizer, state);
        return;
      // `BlockDrops` is this pass's OWN output. A loop body is walked up to five times
      // for the fixpoint, so every walk after the first sees the marker the last one
      // left; it declares and moves nothing, so there is nothing to do with it.
      case "BreakStmt": case "ContinueStmt": case "FuncDecl": case "BlockDrops":
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

  /**
   * EXCLUSIVE ACCESS for an in-place field write on a `@@mutable` record — the same rule
   * a `@@mutable` class setter obeys, stated over a `FieldAssign`/`UpdateExpr` target
   * instead of a method call.
   *
   * The receiver must be a BINDING this scope owns. Refused (NT1607, ≈ rustc E0596):
   *   - an alias (`const b = c; b.n = 1`) and a by-borrow PARAMETER — the owner is elsewhere;
   *   - a `for-of` element — the array owns it;
   *   - anything that is not a name at all (`cells[0].n = 1`, a call result, a capture) —
   *     ownership we cannot establish, so it is refused rather than mutated blind.
   * Reading through any handle stays fine; only the WRITE needs the owner.
   */
  private checkOwnedReceiver(object: Expr, field: string): void {
    if (!this.mutable.classes.size) return;
    // Resolve the receiver: `a.b.c = v` mutates the record `a.b`, whose root binding is `a`.
    let root: Expr = object;
    while (root.kind === "MemberExpr") root = root.object;
    if (root.kind === "Identifier" && root.name === "this") return; // a method's own receiver
    const owned = root.kind === "Identifier" && this.varTy.has(root.name) && !this.borrowBindings.has(root.name);
    if (owned) return;
    const name = root.kind === "Identifier" ? root.name : null;
    if (name !== null && this.varTy.get(name) !== undefined && !this.isMutableInstance(this.varTy.get(name)!)) {
      // A borrowed binding of a NON-mutable type cannot be the receiver of a legal field
      // write at all (the checker already rejected it) — nothing to add here.
      return;
    }
    const ownerOfAlias = name !== null ? this.aliasOf.get(name) : undefined;
    this.report({
      code: OWN_CODES.MUTATE_THROUGH_BORROW,
      message: name === null
        ? `cannot assign \`.${field}\` here: the receiver is not a binding whose ownership this scope can establish`
        : `cannot mutate \`${name}\` through a borrow: assigning \`.${field}\` needs exclusive (owning) access`,
      line: lineOf(object),
      hint: ownerOfAlias !== undefined && ownerOfAlias !== ""
        ? `\`${name}\` is an alias of \`${ownerOfAlias}\`, which still owns the value — assign through \`${ownerOfAlias}\`, or make \`${name}\` the owner with \`const ${name} = move(${ownerOfAlias})\``
        : "a `@@mutable` record is mutated in place, so the write needs an OWNED receiver — a local bound in this scope. Parameters, `for-of` elements, container elements and captures are borrows (their owner is elsewhere), so they are refused rather than mutated blind; build and return a new record instead",
    });
  }

  /** `consume` = this position takes ownership (move); otherwise it's a borrow. */
  private expr(e: Expr, state: State, consume: boolean): void {
    switch (e.kind) {
      case "Identifier": {
        if (this.arrowDepth > 0) this.arrowNames.add(e.name);
        // Moving out of a borrowed binding (by-borrow param / for-of element) is E0507.
        if (consume && this.borrowBindings.has(e.name)) {
          const owner = this.aliasOf.get(e.name);
          this.report({
            code: OWN_CODES.MOVE_OUT_OF_BORROW,
            message: `cannot move out of \`${e.name}\`: it is borrowed (the owner is elsewhere)`,
            line: e.loc?.line ?? 0,
            hint: owner !== undefined && owner !== ""
              ? `\`${e.name}\` names the value \`${owner}\` owns, so handing it out would leave \`${owner}\` to free a pointer the receiver still holds — hand out \`${owner}\` itself instead`
              : this.borrowParams.has(e.name)
                // The one CONSUMING position the language has, and the way out of this
                // refusal for the shape it actually blocks: storing a parameter into an
                // object. `constructor(readonly d: T)` makes the parameter a move rather
                // than a borrow, and the `new` site gives the value up.
                ? `a parameter is a BORROW — the caller still owns the value and drops it when its scope ends, so a second owner here would free it twice. To take OWNERSHIP of an argument, declare it as a constructor PARAMETER PROPERTY (\`constructor(readonly ${e.name}: T)\`), which stores it into the object and moves it at every \`new\` site; otherwise build and return a new value instead of handing this one out`
                : undefined,
          });
          return;
        }
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
          let sites = this.moveSites.get(e.name);
          if (!sites) { sites = new Set(); this.moveSites.set(e.name, sites); }
          sites.add(e);
          state.set(e.name, { moved: true, must: true, at: e.loc?.line });
        }
        return;
      }
      case "CallExpr": {
        if (isMoveCall(e)) { this.expr(e.args[0]!, state, true); return; }
        if (isIdentityCall(e)) { this.expr(e.args[0]!, state, consume); return; }
        // `a.reverse()` mutates in place and hands the SAME pointer back, so for
        // ownership it is transparent — exactly like `Object.freeze(a)` above. The
        // result IS the receiver, so a consuming position (`return a.reverse()`,
        // `[a.reverse()]`) consumes `a` itself; a borrowing one leaves `a` owned.
        // Without this the scope dropped `a` and returned the freed pointer.
        // (A BINDING of the result reaches here with consume=false: `collectAliases`
        // already made it an alias, so the receiver stays the one owner.)
        if (retainsReceiver(e)) {
          this.expr((e.callee as { object: Expr }).object, state, consume);
          return;
        }
        // A method call on a `@@mutable` instance hands back the RECEIVER (`return this`),
        // which the caller still owns — so its result is a BORROW. Consuming it (returning
        // it out of this function, storing it in a container, `move`ing it) would create a
        // second owner of a value someone else drops: E0507.
        if (consume && e.callee.kind === "MemberExpr" && e.ty !== undefined && this.isMutableInstance(e.ty)) {
          this.report({
            code: OWN_CODES.MOVE_OUT_OF_BORROW,
            message: `cannot move out of \`${classTag(e.ty)}.${e.callee.property}(…)\`: a method of a \`@@mutable\` class returns a BORROW of its receiver, which the caller still owns`,
            line: lineOf(e.callee),
            hint: "bind it (`const b = x.m();` is an alias, not an owner) or call the method for its effect; to hand a value out of this scope, return the OWNING binding instead",
          });
          return;
        }
        // `@@mutable` EXCLUSIVE ACCESS: a setter really mutates the receiver, so it needs
        // ownership (Rust's `&mut self`). The receiver is resolved through a method chain
        // (`a.bump().bump()` is still `a`) down to a binding; anything else — an array or
        // field element, an arrow parameter, a capture — is ownership we cannot establish,
        // so it is refused rather than mutated blind. Recognized by the setter's NAME,
        // which is why the whole block is inert unless the program has `@@mutable` classes.
        //
        // …with ONE root that is not a binding and is owned anyway: a `new C(…)`
        // TEMPORARY. It is not a binding, so nothing in this scope — or any other — can
        // name it, which makes it strictly MORE uniquely owned than the "local bound to
        // `new C(…)`" the refusal's own hint asks for, and that spelling is accepted.
        // Exclusive access therefore holds BY CONSTRUCTION. (This is commit 1ea7fa2's
        // "a syntactically-fresh receiver is a temporary nothing can name", with the sign
        // flipped: there the fact made `.push` VACUOUS, here it makes the call SAFE.)
        // Handing the result back OUT is still refused by the MOVE_OUT_OF_BORROW rule
        // above — a `@@mutable` method returns a borrow of its receiver either way, and
        // for a temporary there is no owning binding to return instead.
        const freshRecv = e.callee.kind === "MemberExpr" && chainRoot(e.callee.object).kind === "NewExpr";
        if (e.callee.kind === "MemberExpr" && !freshRecv && this.mutable.setterProps.has(e.callee.property)) {
          const root = chainRoot(e.callee.object);
          const recv = root.kind === "Identifier" && this.varTy.has(root.name) ? root.name : null;
          if (recv === null) {
            this.report({
              code: OWN_CODES.MUTATE_THROUGH_BORROW,
              message: `cannot call the \`@@mutable\` setter \`${e.callee.property}\` here: its receiver is not a binding whose ownership this scope can establish`,
              line: lineOf(e.callee),
              hint: "a setter mutates in place, so it needs an OWNED receiver — a local bound to `new C(…)` in this scope. Container elements, closure captures and callback parameters cannot be proved unique, so they are refused rather than mutated blind",
            });
            return;
          }
          const tag = this.mutableClassOf(recv);
          if (tag !== undefined && this.mutable.setters.has(`${tag}.${e.callee.property}`) && this.borrowBindings.has(recv)) {
            const owner = this.aliasOf.get(recv);
            this.report({
              code: OWN_CODES.MUTATE_THROUGH_BORROW,
              message: `cannot mutate \`${recv}\` through a borrow: \`${tag}.${e.callee.property}\` assigns a field, so it needs exclusive (owning) access`,
              line: lineOf(e.callee),
              hint: owner !== undefined && owner !== ""
                ? `\`${recv}\` is an alias of \`${owner}\`, which still owns the value — call the setter on \`${owner}\`, or make \`${recv}\` the owner with \`const ${recv} = move(${owner})\``
                : `\`${recv}\` is borrowed (a parameter, an alias, or a \`for-of\` element) and its owner is elsewhere — mutate it where it is owned, or return a new value instead`,
            });
          }
        }
        if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier") {
          const recv = e.callee.object.name;
          if (this.linear.has(recv) && this.isBorrowed(recv) && MUTATING.has(e.callee.property)) {
            this.report({ code: OWN_CODES.MUTATE_WHILE_BORROWED, message: `cannot mutate \`${recv}\` while it is borrowed (iterator invalidation)`, line: e.callee.object.loc?.line ?? 0 });
          }
          // `@@mutable` ACCUMULATOR (`//@@mutable let xs: T[] = []` + `xs.push(v)`): the
          // append really writes the array the binding owns, so it needs EXCLUSIVE ACCESS,
          // exactly like a `@@mutable` setter. Three facts already establish it and cost
          // nothing here:
          //   - an array is LINEAR, so `const b = xs` MOVES; a second name is never a
          //     second live handle, and a push after it is the ordinary NT1601;
          //   - a PARAMETER is a borrow and cannot carry the attribute (the attribute is
          //     on a `let`/`const`), so the checker's NT1606 already covers it;
          //   - `this.f`, `xs[0]`, `f()` name no binding, so they are NT1606 too.
          // The one hole the type/flow layers cannot see is a CLOSURE: an arrow copies the
          // pointer into an env that this scope cannot null and that may outlive the
          // binding, so a push through it is a write to storage we may already have freed.
          // `captured` is the scan pass's over-approximation ("mentioned inside ANY arrow
          // in this scope"), which refuses the push whether it is written inside the arrow
          // or outside it while an arrow holds the name. Over-refusal, never a UAF.
          if (e.callee.property === "push" && this.linear.has(recv) && this.captured.has(recv)) {
            this.report({
              code: OWN_CODES.MUTATE_THROUGH_BORROW,
              message: `cannot \`.push\` to \`${recv}\`: a closure captures it, so this scope is not its only handle`,
              line: e.callee.object.loc?.line ?? 0,
              hint: "an arrow copies the array pointer into an env this scope cannot null, and the closure may outlive the binding — so an in-place append could write storage that is already freed. Build the array with `[...xs, v]` here and pass the finished array in, or move the accumulation inside the closure",
            });
          }
        }
        if (e.callee.kind === "MemberExpr") this.expr(e.callee.object, state, false); // receiver borrow
        // `xs.push(v)` STORES `v` in the array, so it CONSUMES it — the same move
        // `[...xs, v]` makes, and for the same reason: a container holds its slots and the
        // slot outlives the expression. Borrowing the argument (which is right for every
        // other call, where the callee only reads it) left the pushed value owned by its
        // original binding, so the binding freed it at scope exit while the array went on
        // pointing at it: `g.push(a)` inside a function, then `g[0].length` from outside,
        // read freed memory and printed 3 for a 2-element array. Exit 0, wrong answer.
        // Guarded on the RECEIVER'S TYPE, not the method name — a user class may define
        // its own `.push`, and consuming ITS argument would move a value the callee only
        // borrows. `this` is the array-builtin `.push` only when the receiver is an array.
        const arrPush = e.callee.kind === "MemberExpr" && e.callee.property === "push"
          && e.callee.object.ty !== undefined && isArrayTy(e.callee.object.ty);
        for (const a of e.args) this.expr(a, state, arrPush);
        return;
      }
      case "AssignExpr":
        this.expr(e.value, state, true);
        // Reassigning a binding that something else ALIASES would free the old value out
        // from under the alias (`let b = a; a = new C();` ⇒ `b` dangles). rustc's E0506.
        if (this.aliasedOwners.has(e.target)) {
          this.report({
            code: OWN_CODES.MOVE_WHILE_BORROWED,
            message: `cannot assign to \`${e.target}\` because it is borrowed (an alias of it is still live)`,
            line: 0,
            hint: "an alias of a `@@mutable` value borrows from its owner for the rest of the scope; reassigning the owner would leave the alias dangling. Scope the alias more tightly, or mutate through the owner instead of rebinding it",
          });
          return;
        }
        if (this.linear.has(e.target)) {
          // RAII on REASSIGNMENT (B2 step 4): the old value is about to become
          // unreachable, so this scope must free it — unless it was moved out (the new
          // owner will free it; `a = a` / `a = move(a)` land here too, and freeing then
          // would destroy the value we are storing) or a closure captured the pointer.
          e.dropOld = !this.captured.has(e.target) && this.arrowDepth === 0 && this.droppable(e.target, state);
          state.set(e.target, { moved: false, must: false }); // reassignment revives
        }
        return;
      case "FieldAssign":
        // `o.field = v`: read the receiver (borrow), move the value in.
        //
        // A `@@mutable` RECORD has no methods, so its mutation is this node rather than a
        // setter call — but the rule is the SAME one Stage 45 established for classes:
        // only the OWNER may mutate (Rust's `&mut self`). `this.f = v` inside a member
        // body is exempt (the receiver is the caller's, and the call-site rules are what
        // keep it single-owner).
        if (!e.viaThis) this.checkOwnedReceiver(e.object, e.field);
        this.expr(e.object, state, false);
        // A parameter property's DEFINITIONAL store does not move: a consuming parameter
        // arrived already owned by this object (the `new` site gave it up), so the value
        // is not being taken out of anything. Treating it as a move would be the NT1604
        // this feature exists to answer, and would also strip the name of its remaining
        // BORROW — `constructor(readonly xs: T[]) { this.n = xs.length }` reads `xs` after
        // the store, which is exactly the rustc-legal `Self { n: xs.len(), xs }` reordered.
        // `xs` stays in `borrowBindings`, so moving it out a SECOND time is still NT1604.
        this.expr(e.value, state, e.paramProp !== true);
        return;
      case "IndexAssign": // `u[i] = v` (Uint8Array only reaches here — arrays/objects rejected in the checker)
        this.expr(e.object, state, false);
        this.expr(e.index, state, false);
        this.expr(e.value, state, false);
        return;
      case "MemberExpr": this.expr(e.object, state, false); return;
      case "IndexExpr":
        // Reading `arr[i]` in a CONSUMING position (binding / return / move) when the element
        // type is LINEAR would move an element out of the array, leaving a hole — E0508.
        // A Copy element (number[]/string[]) is a plain read; a field/method access through the
        // index is a borrow (consume=false) — both stay legal.
        if (consume && e.ty !== undefined && isLinearTy(e.ty)) {
          this.report({ code: OWN_CODES.MOVE_OUT_OF_ARRAY, message: `cannot move out of array element (its element type is linear)`, line: lineOf(e.object) });
        }
        this.expr(e.object, state, false); this.expr(e.index, state, false); return;
      case "BinaryExpr": this.expr(e.left, state, false); this.expr(e.right, state, false); return;
      case "LogicalExpr": this.expr(e.left, state, false); this.expr(e.right, state, false); return;
      case "UnaryExpr": this.expr(e.operand, state, false); return;
      case "TypeofExpr": this.expr(e.operand, state, false); return;
      case "ConditionalExpr":
        this.expr(e.test, state, false); this.expr(e.consequent, state, false); this.expr(e.alternate, state, false);
        return;
      case "TemplateLiteral": for (const x of e.exprs) this.expr(x, state, false); return;
      case "ArrayLiteral":
        // An element MOVES into the array (the same rule ObjectLiteral fields follow):
        // the array now holds the only reference, so the source binding must not be
        // dropped at scope exit. Treating elements as borrows was a use-after-free —
        // `return [o1, o2]` freed both objects while the returned array pointed at them.
        // A `...spread` source is COPIED, so it stays owned (borrow).
        for (const el of e.elements) this.expr(el, state, el.kind !== "SpreadExpr");
        return;
      case "SpreadExpr": this.expr(e.argument, state, false); return; // spread copies (borrow)
      case "NewExpr": {
        // CONSUMING PARAMETERS. Most arguments are borrows — the caller keeps ownership
        // and drops the value. A constructor PARAMETER PROPERTY is the exception: it
        // stores its argument into a slot that outlives the call, so the callee takes
        // ownership and the caller must NOT drop it. That is rustc's `fn new(d: D)`
        // against `fn new(d: &D)`, and it is what makes the store legal at all — without
        // the move here the value would have two owners and be freed twice.
        const consuming = this.consuming.get(e.callee);
        for (let i = 0; i < e.args.length; i++) this.expr(e.args[i]!, state, consuming !== undefined && consuming.has(i));
        return;
      }
      case "AsExpr": this.expr(e.expr, state, false); return;
      // `satisfies` is a pure type-layer check; ownership flows straight through it.
      case "SatisfiesExpr": this.expr(e.expr, state, consume); return;
      // `expr!` is a type-level assertion; ownership flows straight through it.
      case "NonNullExpr": this.expr(e.expr, state, consume); return;
      case "InstanceOfExpr": this.expr(e.object, state, false); return; // a type TEST only borrows
      case "InExpr": this.expr(e.key, state, false); this.expr(e.object, state, false); return; // a key-presence TEST only borrows
      case "ObjectLiteral": for (const p of e.properties) this.expr(p.value, state, !p.spread); return; // fields move into the object; a `...spread` source is COPIED (borrow), so it stays usable + owned
      case "ArrowFunction": // captures/params aren't linear here; the BODY is its own scope
        this.arrowDepth++;
        if (e.exprBody) this.expr(e.body as Expr, state, false);
        else this.arrowScope(e.stmts as Stmt[], state);
        this.arrowDepth--;
        return;
      case "SequenceExpr": for (const x of e.exprs) this.expr(x, state, false); return;
      case "UpdateExpr":
        // `c.n++` on a `@@mutable` record is a field WRITE, so it needs an owned receiver
        // exactly like `c.n = c.n + 1`. A plain `i++` has no receiver and falls through.
        if (e.targetExpr) {
          if (e.targetExpr.kind === "MemberExpr") this.checkOwnedReceiver(e.targetExpr.object, e.targetExpr.property);
          this.expr(e.targetExpr, state, false);
        }
        return;
      default: return; // literals, numeric update, unreachable kinds
    }
  }
}

/** Linear locals declared DIRECTLY in this statement list (a `MultiStmt` is a
 *  scope-less group — the destructuring/swap desugaring — so it counts as direct).
 *  `aliases` (non-owning `@@mutable` handles) are never owners, so never dropped. */
function declaredLinear(list: Stmt[], aliases: Set<string>): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (s.kind === "VarDecl") { for (const d of s.decls) if (isLinearTy(d.ty ?? "number") && !aliases.has(d.name)) out.push(d.name); }
    else if (s.kind === "MultiStmt") out.push(...declaredLinear(s.stmts, aliases));
  }
  return out;
}

/* ============================================================
 * CLOSURE ENVIRONMENTS — the drop set function types are NOT in.
 *
 * A bound arrow allocates a heap env (`nt_obj_new(1 + caps.length)`, codegen's
 * ArrowFunction case): a bare slot block `[fn_ptr, cap0, …]` with no header. Nothing
 * ever freed one, so every evaluated arrow leaked — once per ITERATION inside a loop.
 *
 * A function type is deliberately NOT linear (see `isLinearTy`): making it so once made
 * `isArrayTy("()=>number[]")` answer true, and the scope freed closures with
 * `nt_arr_free`, which reads the bare block as an `NtArray{len,cap,data,pv}` and frees
 * two words past its end — a wild free, exit 255. Function types therefore stay out of
 * the move/borrow machinery entirely, and closure envs get this separate, purely
 * SYNTACTIC drop rule instead, whose whole job is to prove unique ownership without any
 * of it. Codegen frees the name with `nt_obj_free` (never `nt_arr_free`), shallowly:
 * capture slots alias values the enclosing scope still owns and still drops, so walking
 * them would be the double free this rule exists to avoid.
 *
 * A binding qualifies when ALL of:
 *   - it is declared DIRECTLY in this statement list, and its initializer is an ARROW
 *     LITERAL — a fresh allocation this scope made, not one a call handed back;
 *   - its type is a function type;
 *   - every other mention of the name in the list is the CALLEE of a direct call
 *     `f(…)`. Anything else — `return f`, `[f]`, `{ f }`, `g(f)`, `const h = f`,
 *     `f = …`, a mention inside another arrow's body (which would copy the pointer into
 *     a second env that may outlive this scope) — disqualifies it, and it keeps leaking.
 *
 * "Used only by calling it" is exactly the proof needed: the pointer is stored in one
 * slot, nothing else can name it, and no path takes it out of the scope — so the scope's
 * exit is the last place it is live. `makeCounter`'s returned closure is disqualified by
 * `return f`, which is what keeps that sanctioned idiom working.
 * ============================================================ */

/** Property keys whose STRING values are never a binding mention — type encodings,
 *  member/field/property names, and the drop lists this pass writes back into the AST
 *  (`BlockDrops.names`, `ReturnStmt.drops`, `FuncDecl.endDrops`), which would otherwise
 *  read as mentions of the very names they schedule. Everything NOT listed here
 *  disqualifies on a match, so the omission of a key is the conservative direction. */
const NOT_A_MENTION = new Set(["kind", "ty", "elemTy", "retTy", "key", "property", "field", "names", "drops", "endDrops"]);

function isIdentNode(x: unknown): boolean {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "Identifier";
}

/**
 * Record every candidate name the subtree mentions in a position other than a direct
 * call callee. Structural rather than kind-by-kind on purpose: an expression kind this
 * pass forgot to enumerate would silently hide a mention, and a hidden mention is the
 * one error direction that frees a live pointer. A key it does not recognize is a
 * mention; only `NOT_A_MENTION` is exempt.
 */
function scanMentions(
  node: unknown, key: string, cands: Set<string>, ownDecls: Set<object>, inArrow: boolean,
  seen: Set<object>, out: Set<string>,
): void {
  if (typeof node === "string") { if (!NOT_A_MENTION.has(key) && cands.has(node)) out.add(node); return; }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(node)) { for (const el of node) scanMentions(el, key, cands, ownDecls, inArrow, seen, out); return; }
  // An arrow BODY copies what it names into a second env that may outlive this scope,
  // so inside one even a call callee is a mention.
  const arrow = inArrow || obj["kind"] === "ArrowFunction";
  const skipCallee = !arrow && obj["kind"] === "CallExpr" && isIdentNode(obj["callee"]);
  const ownDecl = ownDecls.has(obj);
  for (const k of Object.keys(obj)) {
    if (skipCallee && k === "callee") continue;
    if (ownDecl && k === "name") continue; // the candidate's own declarator, not a use
    scanMentions(obj[k], k, cands, ownDecls, arrow, seen, out);
  }
}

/** The candidate declarators directly in `list` (a `MultiStmt` is a scope-less group). */
function closureDecls(list: Stmt[], out: Map<string, object>): void {
  for (const s of list) {
    if (s.kind === "VarDecl") {
      for (const d of s.decls) {
        if (d.init === undefined || d.init === null || d.init.kind !== "ArrowFunction") continue;
        if (!isFuncTy(d.ty ?? "number")) continue;
        // A name declared twice in one scope would be freed twice for one live slot.
        if (out.has(d.name)) { out.set(d.name, {}); continue; } // an unreachable node ⇒ its `name` disqualifies it below
        out.set(d.name, d as unknown as object);
      }
    } else if (s.kind === "MultiStmt") closureDecls(s.stmts, out);
  }
}

/**
 * Names DECLARED more than once anywhere in a scope tree — a shadowing inner block, a
 * local shadowing a parameter, a same-named function. Codegen gives a name ONE frame
 * slot per function (`addLocal` returns early if the name is already known), so two
 * declarations of `f` share storage: the inner one overwrites the outer's env pointer
 * and the inner block's drop would then free a pointer the outer name still reads.
 *
 * BLOCK SHADOWING no longer reaches here: `alphaRenameShadows` (src/checker.ts) gives a
 * nested-scope declaration its own name before this pass runs, so the two `f`s have
 * different names and both envs are dropped normally. What is left is the residue that
 * rename deliberately does NOT touch — two declarations of one name in ONE scope, and a
 * function-body declaration colliding with a parameter. node rejects both outright
 * (`SyntaxError: Identifier 'f' has already been declared`) and nativets does not yet,
 * so they still reach codegen sharing a slot; disqualifying them keeps that pre-existing
 * gap a LEAK rather than a use-after-free.
 *
 * A DECLARING occurrence is any node carrying a `name` string that is not an
 * `Identifier` (declarators have no `kind` at all; params, `for-of` bindings and
 * `FuncDecl`s carry their own). Over-counting only costs a leak.
 */
function shadowedNames(node: unknown, seeded: string[]): Set<string> {
  const count = new Map<string, number>();
  for (const p of seeded) count.set(p, (count.get(p) ?? 0) + 1);
  const seen = new Set<object>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    const obj = n as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(n)) { for (const el of n) walk(el); return; }
    const nm = obj["name"];
    if (typeof nm === "string" && obj["kind"] !== "Identifier") count.set(nm, (count.get(nm) ?? 0) + 1);
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  const out = new Set<string>();
  for (const [n, c] of count) if (c > 1) out.add(n);
  return out;
}

/** Closure-env bindings of `list` that are provably owned by it — its extra drop set.
 *  `shadowed` names the bindings that share a frame slot with another declaration. */
function nonEscapingClosures(list: Stmt[], shadowed: Set<string>): string[] {
  const decls = new Map<string, object>();
  closureDecls(list, decls);
  if (decls.size === 0) return [];
  const cands = new Set(decls.keys());
  const escaped = new Set<string>();
  scanMentions(list, "", cands, new Set(decls.values()), false, new Set(), escaped);
  return [...cands].filter((n) => !escaped.has(n) && !shadowed.has(n));
}

/**
 * Every binding that NAMES a value someone else owns — an ALIAS, not a move. Recorded
 * as alias → owner. Aliases are excluded from the owned/droppable sets everywhere, so
 * the value is still freed exactly once, by the original binding, and can never be
 * double-freed through a second handle; and each is registered as a borrow, so it can
 * never escape the owner's scope (returning one is NT1604).
 *
 * Two sources, sharing that one mechanism:
 *   - `const b = a` (and `const c = a.bump()`) where the type is an `@@mutable` class
 *     instance — the decorators model (docs/decorators.md);
 *   - `const b = a.reverse()` on ANY linear value — the call returns its receiver.
 */
function collectAliases(stmts: Stmt[], isMutableTy: (t: import("./ast.ts").Ty) => boolean, out: Map<string, string>): void {
  for (const s of stmts) {
    switch (s.kind) {
      case "VarDecl":
        // A binding is an ALIAS when the value came from somewhere that still owns it:
        // another binding (`const b = a`) or a METHOD CALL on one (`const c = a.bump()`
        // hands back the receiver). `new C(…)` — and a factory function's return — are
        // fresh values, so those bindings are real owners and get the usual drop.
        for (const d of s.decls) {
          if (!d.init) continue; // `let x: T;` — no initializer, so it aliases nothing
          // `const b = a.reverse()` — the call mutates in place and returns its
          // RECEIVER, so `b` names the allocation `a` already owns. Recording it as an
          // alias is what stops the scope freeing that one pointer through BOTH names.
          // Independent of `@@mutable`: this applies to plain arrays.
          const retained = retainedReceiver(d.init);
          if (retained !== null) { out.set(d.name, retained); continue; }
          if (!isMutableTy(d.ty ?? "number")) continue;
          if (d.init.kind === "Identifier") out.set(d.name, d.init.name);
          else if (d.init.kind === "CallExpr" && d.init.callee.kind === "MemberExpr") {
            const base = d.init.callee.object;
            out.set(d.name, base.kind === "Identifier" ? base.name : "");
          }
        }
        break;
      case "IfStmt": collectAliases(s.consequent, isMutableTy, out); if (s.alternate) collectAliases(s.alternate, isMutableTy, out); break;
      case "WhileStmt": case "DoWhileStmt": case "ForOfStmt": case "ForInStmt": case "BlockStmt": collectAliases(s.body, isMutableTy, out); break;
      case "ForStmt": if (s.init && (s.init as Stmt).kind === "VarDecl") collectAliases([s.init as Stmt], isMutableTy, out); collectAliases(s.body, isMutableTy, out); break;
      case "SwitchStmt": for (const c of s.cases) collectAliases(c.body, isMutableTy, out); break;
      case "TryStmt": collectAliases(s.block, isMutableTy, out); if (s.handler) collectAliases(s.handler, isMutableTy, out); if (s.finalizer) collectAliases(s.finalizer, isMutableTy, out); break;
      case "MultiStmt": collectAliases(s.stmts, isMutableTy, out); break;
      default: break;
    }
  }
}

/** Static type of every name bound in a scope — what the `@@mutable` rules read. */
function collectVarTys(stmts: Stmt[], out: Map<string, import("./ast.ts").Ty>): void {
  for (const s of stmts) {
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) if (d.ty !== undefined) out.set(d.name, d.ty); break;
      case "IfStmt": collectVarTys(s.consequent, out); if (s.alternate) collectVarTys(s.alternate, out); break;
      case "WhileStmt": case "DoWhileStmt": case "BlockStmt": collectVarTys(s.body, out); break;
      case "ForStmt": if (s.init && (s.init as Stmt).kind === "VarDecl") collectVarTys([s.init as Stmt], out); collectVarTys(s.body, out); break;
      case "ForOfStmt": if (s.elemTy !== undefined) out.set(s.name, s.elemTy); collectVarTys(s.body, out); break;
      case "ForInStmt": collectVarTys(s.body, out); break;
      case "SwitchStmt": for (const c of s.cases) collectVarTys(c.body, out); break;
      case "TryStmt": collectVarTys(s.block, out); if (s.handler) collectVarTys(s.handler, out); if (s.finalizer) collectVarTys(s.finalizer, out); break;
      case "MultiStmt": collectVarTys(s.stmts, out); break;
      default: break;
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

  // `@@mutable` classes (decorators lane) and their setters. Empty for every program that
  // does not use the attribute, in which case every rule below is inert.
  const mutable: MutableInfo = {
    classes: mutableTags(checked.program), // `@@mutable` classes AND `@@mutable` records
    setters: new Set(),
    setterProps: new Set(),
  };
  for (const s of checked.program.body) {
    if (s.kind !== "FuncDecl" || !s.setter) continue;
    const [tag, m] = [s.name.split(".")[0]!, s.name.split(".").slice(1).join(".")];
    if (!mutable.classes.has(tag)) continue; // an ordinary class's setter copies — nothing to guard
    mutable.setters.add(s.name);
    // `s.replace(/\$inner$/, "")` — the suffix, without a RegExp (nativets has none).
    mutable.setterProps.add(m.endsWith("$inner") ? m.slice(0, m.length - "$inner".length) : m);
  }
  /**
   * CONSUMING PARAMETERS — the one place a callee takes ownership of an argument.
   *
   * A constructor parameter property (`constructor(readonly d: Diagnostic)`) desugars to a
   * field plus `this.d = d`, so the parameter is stored into a slot that outlives the call.
   * A borrow cannot do that: the caller would still drop the value while the object holds
   * a pointer to it, which is a double free (observed: exit 255). So the parameter is a
   * MOVE — rustc's `fn new(d: D) -> Self` — and every `new C(v)` site moves `v`, after
   * which using `v` is NT1601 (≈ E0382).
   *
   * Only PARAMETER PROPERTIES qualify, because only they are syntactically guaranteed to
   * store: the desugaring emits the assignment, so the answer needs no inference and no
   * new spelling. A hand-written `this.d = d` in a constructor body stays NT1604, and its
   * hint names the parameter-property form.
   *
   * The map is keyed by class tag; argument index `i` is constructor parameter `i + 1`
   * (parameter 0 is the receiver `this`).
   */
  const CTOR = ".constructor";
  const consuming = new Map<string, Set<number>>();
  for (const s of checked.program.body) {
    if (s.kind !== "FuncDecl" || !s.name.endsWith(CTOR)) continue;
    const sig = checked.functions.get(s.name);
    if (sig === undefined) continue;
    const idx = new Set<number>();
    for (let i = 1; i < s.params.length; i++) {
      if (s.params[i]!.paramProp === true && isLinearTy(sig.params[i] ?? "number")) idx.add(i - 1);
    }
    if (idx.size > 0) consuming.set(s.name.slice(0, s.name.length - CTOR.length), idx);
  }

  const isMutableTy = (t: import("./ast.ts").Ty): boolean => {
    if (!mutable.classes.size || !isObjectTy(t)) return false;
    const tag = classTag(t);
    return tag !== undefined && mutable.classes.has(tag);
  };

  /**
   * `this` inside a SETTER, and inside any method of a `@@mutable` class, is UNTRACKED.
   *   - `@@mutable`: the receiver is the caller's, and `return this` hands the same
   *     borrow back — the call-site rules above (alias binding / no consuming a method
   *     result) are what keep it single-owner, so tracking `this` here would only
   *     produce spurious moves.
   *   - ordinary copy-on-write setter: `this` is the METHOD's private fresh copy, so
   *     returning it is a legitimate transfer, not a move out of the caller's value.
   */
  const untrackedThis = (fn: FuncDecl): boolean =>
    fn.params[0]?.name === "this" && (fn.setter === true || fn.untrackThis === true || mutable.classes.has(fn.name.split(".")[0]!));

  const runScope = (body: Stmt[], params: { name: string; ty: import("./ast.ts").Ty }[], untrack: Set<string> = new Set()): string[] => {
    const aliases = new Map<string, string>();
    collectAliases(body, isMutableTy, aliases); // ALWAYS: the retains-receiver rule is not `@@mutable`-specific
    const varTy = new Map<string, import("./ast.ts").Ty>();
    if (mutable.classes.size) {
      for (const p of params) varTy.set(p.name, p.ty);
      collectVarTys(body, varTy);
    }
    const linear = new Set<string>();
    for (const p of params) if (isLinearTy(p.ty)) linear.add(p.name);
    collectLinear(body, linear);
    for (const a of aliases.keys()) linear.delete(a); // an alias owns nothing
    for (const u of untrack) linear.delete(u);
    // Droppable = linear locals declared directly in this scope (NOT params — those
    // are borrowed, the caller owns them; NOT `@@mutable` aliases — the original owns them).
    const topLevel: string[] = [];
    for (const s of body) if (s.kind === "VarDecl") for (const d of s.decls) if (isLinearTy(d.ty ?? "number") && !aliases.has(d.name)) topLevel.push(d.name);
    // Linear params are BORROWED (the caller owns + drops them) — moving one out is E0507.
    const paramBorrows = params.filter((p) => isLinearTy(p.ty) && !untrack.has(p.name)).map((p) => p.name);
    const entry = (): State => new Map(params.filter((p) => isLinearTy(p.ty) && !untrack.has(p.name)).map((p) => [p.name, { moved: false, must: false }]));
    // Pass 1 (discard): which names does a closure body mention? Those pointers may be
    // copied into a closure env that outlives the binding, so they are never freed on
    // reassignment. Diagnostics from this pass are dropped — pass 2 is the real one.
    // Closure envs this scope's TOP level provably owns — the body is walked with
    // `seq`, not `scoped`, so it has no block marker of its own and they ride along on
    // the returned end-drop set (and on `ownedInScope`, for an early `return`).
    const shadowed = shadowedNames(body, params.map((p) => p.name));
    const topClosures = nonEscapingClosures(body, shadowed);
    const scan = new Analyzer(linear, topLevel, paramBorrows, new Set(), mutable, varTy, aliases, consuming);
    scan.topClosures = topClosures;
    scan.shadowed = shadowed;
    scan.seq(body, entry());
    const a = new Analyzer(linear, topLevel, paramBorrows, scan.arrowNames, mutable, varTy, aliases, consuming);
    a.topClosures = topClosures;
    a.shadowed = shadowed;
    const st = entry();
    a.seq(body, st);
    const end = [...a.ownedTopLevel(st), ...topClosures]; // computed BEFORE marking: it can add to condDrops
    // Drop flags: a name that is dropped on a path where it MIGHT already have been
    // moved needs its move sites to null the slot, so the drop is a no-op there.
    for (const n of a.condDrops) for (const site of a.moveSites.get(n) ?? []) (site as { nullOnMove?: boolean }).nullOnMove = true;
    diags.push(...a.diags);
    return end;
  };

  checked.program.endDrops = runScope(checked.program.body, []);
  for (const s of checked.program.body) {
    if (s.kind === "FuncDecl") {
      const sig = checked.functions.get(s.name)!;
      s.endDrops = runScope(s.body, s.params.map((p, i) => ({ name: p.name, ty: sig.params[i]! })), untrackedThis(s) ? new Set(["this"]) : new Set());
    }
  }
  return diags;
}
