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
 *   NT1608  assignment to a linear parameter  (≈ E0384) — a parameter is an immutable borrow
 * Deferred: move-out-of-borrow for the general (non-for-of) borrow, and Drop-typed moves (E0509).
 */

import type { CheckedProgram } from "./checker.ts";
import type { Program, Stmt, Expr, FuncDecl, Ty } from "./ast.ts";
import { isArrayTy, isObjectTy, isUnionTy, isTypeRefTy, isFuncTy, isNullableTy, baseTy, setBlockDrops, classTag, mutableTags, RETAINS_RECEIVER } from "./ast.ts";

/** The linear (single-owner, move-checked + dropped) types: heap aggregates. A
 *  DISCRIMINATED UNION (SH2) is one of them: its value IS a member's object block, so
 *  it is owned, moved and freed exactly like the record it is. */
/* A recursive node (`@N`) is an owned heap object exactly like the shape it names, so it is
 * LINEAR. Left out, `isLinearTy` answered false and the whole memory-safety story switched
 * off for the new encoding at once: no move checking, no borrow rules, and — because
 * `declaredLinear` feeds the drop list — no drop emitted either. */
function isLinearTy(t: Ty): boolean { return isArrayTy(t) || isObjectTy(t) || isUnionTy(t) || isTypeRefTy(t); }

export const OWN_CODES = {
  USE_AFTER_MOVE: "NT1601",      // ≈ E0382
  MOVE_WHILE_BORROWED: "NT1602", // ≈ E0505
  MUTATE_WHILE_BORROWED: "NT1603", // ≈ E0502 (iterator invalidation)
  MOVE_OUT_OF_BORROW: "NT1604",  // ≈ E0507 (move out of a for-of element / by-borrow param)
  MOVE_OUT_OF_ARRAY: "NT1605",   // ≈ E0508 (move out of a linear array element `arr[i]`)
  MUTATE_THROUGH_BORROW: "NT1607", // ≈ E0596 (`@@mutable` setter called on a handle we don't own)
  ASSIGN_TO_BORROW_PARAM: "NT1608", // ≈ E0384 (assignment to an immutable parameter binding)
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
  /** Just the `@@mutable` RECORD tags — the subset of `classes` that came from a
   *  `type`/`interface` rather than a `class`. `classes` deliberately mixes the two
   *  (`mutableTags`), but the NT1607 parameter/`for-of` arm is dropped for records ONLY:
   *  a record's write is a field store on a receiver named in the signature, whereas a
   *  class's is a setter CALL whose receiver is `this` inside the method. */
  records: Set<string>;
}
const NO_MUTABLE: MutableInfo = { classes: new Set(), setters: new Set(), setterProps: new Set(), records: new Set() };

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
  // The tag tests are REPEATED from `retainsReceiver` rather than inherited from it,
  // because a `boolean` return carries no narrowing back to the caller. This used to
  // bridge that gap with `(e as { callee: { object: Expr } }).callee.object`, which is the
  // same unsound shape as the old `exprLoc` cast and fails the same way: `callee` is at
  // slot 0 of the asserted shape but slot 1 of `CallExpr`, so compiled it reads `kind` —
  // a string pointer — and walks `.object` off it. Dynamic property access hid that under
  // `bun`; the checked-`as` work turned it into a refusal.
  //
  // A type predicate (`(e): e is CallExpr =>`) would let `retainsReceiver` narrow for
  // real and delete the duplication, but that spelling currently breaks the whole-program
  // LINK, so the honest fix today is to narrow in place.
  if (e.kind !== "CallExpr" || e.callee.kind !== "MemberExpr") return null;
  if (!retainsReceiver(e)) return null;
  const base = e.callee.object;
  return base.kind === "Identifier" ? base.name : null;
}

/**
 * `s as T` ⇒ `"s"`: a type ASSERTION over a plain binding. `as` reinterprets a PLACE at
 * another type — it allocates nothing and copies nothing — so the result is a second name
 * for the operand's allocation, exactly as `retainedReceiver` above describes for
 * `a.reverse()`.
 *
 * `satisfies` and `!` are looked through for the same reason: all three are type-layer
 * operators that `Ownership.expr` already flows straight through, so a binding
 * initialized from one of them must be an alias rather than a second owner.
 *
 * An assertion over anything that is NOT a binding (`{a:1} as T`, `f() as T`) answers
 * null: the operand is a temporary nobody else owns, so the new binding really does own
 * the result and gets the usual drop.
 */
// Spelled as three POSITIVE tag tests, which is the narrowing this compiler actually
// does (SH2) — each one narrows to a single member, so `.expr` is an ordinary field read.
// Two other spellings were tried and both are blockers in `src/`'s own subset:
// `(e as { expr: Expr }).expr` is refused by this lane's own new rule, and rightly so
// (`expr` is at slot 1 in these members but slot 0 in the asserted shape, so the read
// would take `kind` — a string pointer — as an `Expr`); and a negated chain
// `if (e.kind !== "AsExpr" && …) return null` does not narrow the remainder, so `.expr`
// is `Property 'expr' does not exist on <the whole Expr union>`.
function assertedPlaceRoot(e: Expr): string | null {
  if (e.kind === "AsExpr") return placeRootOf(e.expr);
  if (e.kind === "SatisfiesExpr") return placeRootOf(e.expr);
  if (e.kind === "NonNullExpr") return placeRootOf(e.expr);
  return null;
}

/** The binding an assertion's operand names, following chained assertions to one place. */
function placeRootOf(inner: Expr): string | null {
  if (inner.kind === "Identifier") return inner.name;
  return assertedPlaceRoot(inner); // `s as A as B` — chained assertions name one place
}

/**
 * `o.lines` ⇒ `"o"` when `o` is a BORROW — a field read whose result is a second name for
 * storage the receiver still owns. `this.lines` answers `"this"`, which is a borrow in
 * every method body (the receiver belongs to the caller).
 *
 * A chained root (`p.b.lines`) walks to the outermost binding, exactly as
 * `checkOwnedReceiver` resolves its receiver, so `p.b.lines` on a borrowed `p` matches.
 * Anything whose root is not a binding — a call result, an element, a literal — answers
 * null: the receiver is a temporary nobody else owns, so the read really does take it.
 *
 * SPELLING NOTE (docs/self-hosting.md): the walk is RECURSIVE rather than
 * `while (root.kind === "MemberExpr") root = root.object`, which is how
 * `checkOwnedReceiver` writes the same thing. The loop form does not survive this
 * compiler's own narrowing — the discriminant is re-widened at the back edge, so
 * `root.object` is `Property 'object' does not exist on <the whole Expr union>` — and
 * `src/` has to stay inside the subset it compiles.
 */
function fieldRootName(e: Expr): string | null {
  if (e.kind === "Identifier") return e.name;
  if (e.kind === "MemberExpr") return fieldRootName(e.object);
  return null;
}

function borrowedFieldRoot(e: Expr, borrowRoots: Set<string>): string | null {
  if (e.kind !== "MemberExpr") return null;
  // `?? "number"` rather than an `undefined` guard — the spelling every other
  // `isLinearTy` call site in this file uses, and the one that stays inside the
  // self-hosting subset (a narrowed `Ty | undefined` does not reach the parameter).
  if (!isLinearTy(e.ty ?? "number")) return null;
  const root = fieldRootName(e.object);
  if (root === null || !borrowRoots.has(root)) return null;
  return root;
}

/**
 * `xs.find(p)` / `xs.findLast(p)` over a `(T | undefined)[]` — the LINEAR base `T` when
 * the result BORROWS an element the receiver still owns, else null.
 *
 * READ OFF THE TYPES ALREADY THERE, deliberately, rather than stamped by the checker on
 * a new AST field. The stamp was written first and it cost `inferSearchHof` its place in
 * the self-hosting subset: `callee.searchElemTy = …` is NT1606, "objects are immutable",
 * so the compiler stopped being able to compile the function that taught it this rule.
 * The subset rule is not a formality — a helper that reads existing `ty` fields is both
 * smaller and better placed.
 *
 * It is not yet self-compiling EITHER, and for a reason worth naming rather than
 * hiding: `e.callee.object.ty` reads a field off the `Expr` union, which is the same
 * NT2001 its two neighbours `retainsReceiver` and `retainedReceiver` already carry —
 * they do the identical job one screen up and are written the identical way. This is
 * that gap, not a new one, and it clears when that one does. Inlining the body into
 * `stmt` would have made the blocker count flat by hiding it under a function that
 * already fails, which is precisely the masking test/blocker-metric.ts warns about.
 *
 * The three conditions are each doing work:
 *  - an ARRAY receiver, so a user method that merely happens to be named `find` is not
 *    swept up and refused;
 *  - a NULLABLE result, which for `.find` is always true;
 *  - a LINEAR base. This is the whole discrimination. A scalar `(number|undefined)[]`
 *    element is copied into a fresh box that owns itself, so calling it a borrow would
 *    refuse safe programs; only a linear payload is a pointer the array still holds.
 *    Every OTHER `.find` element shape (a plain object, a `?N` element) is refused by
 *    the checker before it can reach here.
 */
function searchBorrowBase(e: Expr): Ty | null {
  if (e.kind !== "CallExpr" || e.callee.kind !== "MemberExpr") return null;
  if (e.callee.property !== "find" && e.callee.property !== "findLast") return null;
  if (!isArrayTy(e.callee.object.ty ?? "number")) return null;
  const t = e.ty ?? "number";
  if (!isNullableTy(t) || !isLinearTy(baseTy(t))) return null;
  return baseTy(t);
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
  let out: State = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(k), vb = b.get(k);
    const moved = !!va?.moved || !!vb?.moved;
    const must = !!va?.must && !!vb?.must;   // definitely moved only if moved on BOTH paths
    out = out.set(k, { moved, must, at: va?.at ?? vb?.at });
  }
  return out;
}
/**
 * DOES EVERY PATH THROUGH THIS STATEMENT LIST LEAVE THE FRAME?
 *
 * The fall-through join after an `if`/`switch` is a program point an arm that `return`s
 * or `throw`s never reaches, so merging that arm's moves into it poisoned names for code
 * the move cannot precede:
 *
 *     const a: number[] = [1, 2, 3];
 *     if (c) return a;            // moves `a` — and LEAVES
 *     return [a.length];          // was NT1601; node prints 3
 *
 * Conservative in the safe direction: `false` (i.e. "control can fall out of here, so
 * merge") unless divergence is proved. A LOOP body never counts however it ends — the
 * loop may run zero times. `if` counts only when BOTH arms diverge.
 *
 * The predicate is deliberately about leaving THE FRAME, not about leaving the block:
 * see `hasJump` for the other half, and `Analyzer.escapes` for the `try` guard. Widening
 * it past that is how a safe refusal becomes a silent use-after-free.
 *
 * Spelled as a `switch` per statement rather than a chain of `&&`ed `if`s, the same shape
 * as `hasJump` below, so that `src/` stays inside the subset it compiles: a `kind ===`
 * test and a `!== null` test on the SAME line only narrow one at a time here, so the
 * `&&` spelling read `alternate` as still-nullable and was NT2001 ("narrow it first") —
 * a self-hosting blocker this lane would have added with its own fix.
 */
function leavesFrame(list: Stmt[]): boolean {
  for (const s of list) {
    switch (s.kind) {
      case "ReturnStmt": case "ThrowStmt": return true;
      case "BlockStmt": if (leavesFrame(s.body)) return true; break;
      case "MultiStmt": if (leavesFrame(s.stmts)) return true; break;
      case "IfStmt": {
        const alt = s.alternate;
        if (alt !== null && leavesFrame(s.consequent) && leavesFrame(alt)) return true;
        break;
      }
      default: break;
    }
  }
  return false;
}

/**
 * Does this list contain a `break` or a `continue` ANYWHERE?
 *
 * The disqualifier for `leavesFrame`. A list can hold BOTH a `return` and a `break`:
 *
 *     for (…) {
 *       if (c) { const b: number[] = a; if (d) break; return 1; }
 *     }
 *     use(a);                     // reached by the BREAK, with `a` moved
 *
 * The `return` makes the arm look diverging, but the `break` path leaves the arm WITHOUT
 * leaving the frame and lands on the loop-exit join — which is fed from exactly the state
 * we would have discarded. Dropping it there would accept a real use-after-move, so an
 * arm holding any jump keeps today's unconditional merge.
 *
 * Over-approximates on purpose: a `break` bound to a loop or `switch` NESTED INSIDE the
 * arm cannot escape it, and is counted anyway. That costs a conservative refusal, which
 * is the direction this pass is allowed to be wrong in. There are no labeled statements
 * in the subset (see ast.ts), so a jump always targets the innermost construct.
 *
 * Nested `FuncDecl`s and arrow bodies are not walked — they are their own frames, and a
 * jump inside one cannot name a loop out here.
 */
function hasJump(list: Stmt[]): boolean {
  for (const s of list) {
    switch (s.kind) {
      case "BreakStmt": case "ContinueStmt": return true;
      case "BlockStmt": case "WhileStmt": case "DoWhileStmt": case "ForStmt": case "ForOfStmt": case "ForInStmt":
        if (hasJump(s.body)) return true;
        break;
      case "MultiStmt": if (hasJump(s.stmts)) return true; break;
      case "IfStmt": if (hasJump(s.consequent) || (s.alternate !== null && hasJump(s.alternate))) return true; break;
      case "SwitchStmt": for (const c of s.cases) if (hasJump(c.body)) return true; break;
      case "TryStmt":
        if (hasJump(s.block)) return true;
        if (s.handler !== null && hasJump(s.handler)) return true;
        if (s.finalizer !== null && hasJump(s.finalizer)) return true;
        break;
      default: break;
    }
  }
  return false;
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

/**
 * The array HOFs whose callback codegen INLINES rather than allocating a closure for.
 *
 * Kept in step with `genArrayMethod`'s dispatch (src/codegen.ts) and with the checker's
 * `inferHof`/`inferForEach`/`inferSearchHof`, which already require the argument to be an
 * arrow LITERAL and refuse a function value ("array .map needs an inline arrow"). The
 * comparator of `.toSorted(cmp)` is deliberately ABSENT: that one goes through
 * `Module.cmpShim`, which reads a real `[fn_ptr, caps…]` env, so it is a closure in every
 * sense this file cares about.
 */
const INLINED_HOFS = new Set([
  "forEach", "map", "filter", "reduce", "flatMap",
  "some", "every", "find", "findIndex", "findLast", "findLastIndex",
]);

/**
 * The arrow argument of an inlined-HOF call, if this call is one.
 *
 * WHY THIS PREDICATE EXISTS. `arrowNames` — "mentioned inside ANY arrow" — is the
 * conservative stand-in for "a heap env holds a second pointer to this". For an inlined
 * HOF callback that premise is FALSE: `genForEach`/`genMap`/… emit the body straight into
 * the enclosing frame as a loop, so no `nt_obj_new` env is allocated, no pointer is
 * snapshotted into one, and the body cannot outlive the statement — it IS the statement.
 * `envArrowNames` below is the same over-approximation restricted to arrows that really
 * do get an env, and it is what the `.push` rule consults.
 *
 * Guarded on the RECEIVER'S TYPE, not the method name alone: a user class may define its
 * own `.map`, and ITS argument is an ordinary closure value. `isArrayTy` is exactly the
 * test `genExpr` uses to route into `genArrayMethod` at all.
 *
 * Takes the three PRIMITIVES rather than the `CallExpr`, so that `src/` stays inside the
 * subset it compiles: an `Expr`-typed parameter cannot have `.callee`/`.ty` read off it
 * without narrowing, and this checker refuses that with NT2001 ("Property 'ty' does not
 * exist on <UNION> — narrow it first"). Its sibling `retainsReceiver` above takes the
 * `Expr` and is a self-hosting blocker for exactly that reason; this one is not. The
 * caller reads the three fields where `e` is ALREADY narrowed to a `CallExpr`, reusing the
 * same accesses the `arrPush` test a few lines below it already performs.
 */
function isInlinedHofArrow(property: string, recvTy: Ty | undefined, cbKind: string): boolean {
  if (!INLINED_HOFS.has(property) || cbKind !== "ArrowFunction") return false;
  return recvTy !== undefined && isArrayTy(recvTy);
}

/** Peel a method CHAIN back to what it started from: `a.bump().bump()` ⇒ `a`. */
function chainRoot(e: Expr): Expr {
  let cur = e;
  while (cur.kind === "CallExpr" && cur.callee.kind === "MemberExpr") cur = cur.callee.object;
  return cur;
}

/** Peel a FIELD path back to what it starts from: `this.mod.strings` ⇒ `this`.
 *  The other half of `chainRoot` — that one peels method CALLS, this one peels member
 *  ACCESSES. Both answer "what is this receiver ultimately reached through". */
function fieldRoot(e: Expr): Expr {
  return e.kind === "MemberExpr" ? fieldRoot(e.object) : e;
}

/** Is this expression the method's own receiver? */
function isThisExpr(e: Expr): boolean {
  return e.kind === "Identifier" && e.name === "this";
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
    private varTy: Map<string, Ty> = new Map(),
    /** alias name → the binding that OWNS the value (`const b = a` ⇒ b → a). */
    private aliasOf: Map<string, string> = new Map(),
    /** class tag → the ARGUMENT indices its constructor CONSUMES (parameter properties
     *  of a linear type). Empty for every program without one, so the rule is inert. */
    private consuming: Map<string, Set<number>> = new Map(),
  ) {
    for (const p of paramBorrows) { this.borrowBindings = this.borrowBindings.add(p); this.borrowParams = this.borrowParams.add(p); }
    for (const a of aliasOf.keys()) this.borrowBindings = this.borrowBindings.add(a); // an alias may never escape
    for (const owner of aliasOf.values()) if (owner) this.aliasedOwners = this.aliasedOwners.add(owner);
  }

  /** Owners that something else aliases — reassigning one would dangle the alias. */
  private readonly aliasedOwners = new Set<string>();

  /** The subset of `borrowBindings` that are PARAMETERS — the ones whose fix is a
   *  consuming parameter rather than "use the owner instead". */
  private readonly borrowParams = new Set<string>();

  /** Is this type an instance of an `@@mutable` class? */
  private isMutableInstance(ty: Ty): boolean {
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
  arrowNames = new Set<string>();

  /**
   * `arrowNames`, restricted to arrows that actually GET a heap env — i.e. every arrow
   * except an inlined HOF callback (`isInlinedHofArrow`). Same pass, same
   * over-approximation, one nesting counter narrower.
   *
   * The two sets are deliberately kept APART rather than merged. `captured` gates DROP
   * decisions (`droppable`, `dropOld`), where being conservative costs a leak; this one
   * gates a REFUSAL, where being conservative costs a correct program. Relaxing a drop is
   * the direction that can mint a use-after-free, so it is not relaxed here.
   */
  // Rebound rather than mutated: a `Set` here is PERSISTENT, so `.add` returns a NEW set
  // and leaves the receiver alone (docs/divergences.md §A) — the spelling every sibling
  // field on this class now uses.
  private envArrowDepth = 0;
  envArrowNames = new Set<string>();

  /** Arrow literals this walk has identified as inlined HOF callbacks — recorded by the
   *  `CallExpr` case for the `ArrowFunction` case, which has no parent to ask. */
  private inlinedCallbacks = new Set<Expr>();

  /** Names an arrow WITH AN ENV mentions — set from pass 1's `envArrowNames`. */
  envCaptured = new Set<string>();

  /** Names bound to a BORROW rather than owned: by-borrow params (whole scope) and for-of
   *  loop variables over a LINEAR element (loop body). Moving out of any is E0507 (NT1604). */
  private borrowBindings = new Set<string>();

  /**
   * `this` IS A BORROW IN THIS FRAME, EVEN THOUGH IT IS NOT MOVE-TRACKED.
   *
   * A `@@mutable` method's receiver belongs to the caller (`untrackedThis` below), so it is
   * deliberately kept out of `linear` and out of the entry state — move tracking on it
   * would only invent spurious re-move reports on the fluent chain. That untracking was
   * doing a SECOND job it was never argued for: `this` was also absent from
   * `borrowBindings`, so the NT1604 arm in `expr`'s `Identifier` case could not fire on it
   * either, and every CONSUMING position in the body was silently exempt from the
   * non-escape rule that governs the identical value at the call site.
   *
   * The two jobs are separable and this flag separates them: UNTRACKED for move state,
   * BORROWED for escape. Kept as its own flag rather than an entry in `borrowBindings`
   * because `this` is not a binding — the receiver rule (`checkOwnedReceiver`) and the
   * setter rule both special-case the name already, and folding it in would change what
   * they mean.
   *
   * Measured before/after on `class C { box(): C[] { return [this]; } }` called from a
   * scope that drops the receiver: exit 0 printing `1 1e-323` against node's `1 30`, and
   * `heap-use-after-free` under `-fsanitize=address`. The undecorated twin of the same
   * program is refused NT1604 today; this makes `@@mutable` agree with it.
   */
  borrowThis = false;

  /** This scope's parameters carrying the per-parameter `@@mutable` opt-in — the ones a
   *  callee may append to, and therefore the only ones this scope may hand ON to another
   *  `@@mutable` position (see `mutableArgs`). */
  mutableParams = new Set<string>();

  /** Function name → the ARGUMENT indices whose parameter is `@@mutable`, i.e. the
   *  positions the callee may `.push` to. Empty for every program without one, so both
   *  rules below are inert. */
  mutableArgs: Map<string, Set<number>> = new Map();

  /** The same table for a METHOD call, keyed by the method's bare PROPERTY name with the
   *  implicit `this` parameter already discounted. Name-based, exactly like the
   *  `setterProps` check for `@@mutable` setters, so an unrelated class's like-named
   *  method can be over-refused — over-refusal, never a wrong answer. */
  mutableArgProps: Map<string, Set<number>> = new Map();

  /** Arrays currently borrowed by an enclosing for-of (lexical, count for nesting).
   *
   *  Keyed by the receiver's PATH, not only by a bare name. A bare name is its own path,
   *  so every pre-existing entry reads exactly as before; the addition is `this.<field>`,
   *  which became reachable when a `@@mutable` class's array field learned `.push`
   *  (`Checker.accumulatorName`). Without the path key that append was a SILENT WRONG
   *  ANSWER rather than a refusal — see `iterationPath`. */
  private borrowed = new Map<string, number>();
  private pushBorrow(n: string): void { this.borrowed = this.borrowed.set(n, (this.borrowed.get(n) ?? 0) + 1); }
  private popBorrow(n: string): void { const c = (this.borrowed.get(n) ?? 1) - 1; if (c <= 0) this.borrowed.delete(n); else this.borrowed = this.borrowed.set(n, c); }
  private isBorrowed(n: string): boolean { return this.borrowed.has(n); }

  /**
   * The BORROW PATH of a for-of iterable / mutation receiver, or `null` when this scope
   * cannot name the storage.
   *
   * Two shapes, and only two:
   *   - a bare `xs` — a binding, the pre-existing case;
   *   - `this.xs` — an array field of a `@@mutable` class, which `Checker.accumulatorName`
   *     now lets a method `.push` to.
   *
   * WHY THIS EXISTS. `nt_arr_push` reallocates the array's `data` block, and a `for-of`
   * reads through it, so appending to the array being iterated is iterator invalidation —
   * rustc's E0502, our NT1603. For a bare name that was already caught. For a field it was
   * not, because `ForOfStmt` only registered a borrow when the iterable was an
   * `Identifier`, and the mutation check only fired when the receiver was one. Neither
   * REFUSED the field shape; they simply never saw it, so it compiled and printed the
   * wrong answer at exit 0:
   *
   *   //@@mutable
   *   class A { xs: number[] = [1,2,3];
   *     boom(): number { let s = 0;
   *       for (const x of this.xs) { if (this.xs.length < 40) this.xs.push(x + 100); s = s + x; }
   *       return s; } }
   *   console.log(new A().boom(), new A().xs.length);   // node: 24779 40;  we printed 6 6
   *
   * The lowered loop snapshots the length at entry, so the growth was invisible to the
   * iteration. Refusing the shape is the fix — an append to the array you are iterating has
   * no memory-safe lowering here, and node's answer depends on the growth being observed.
   */
  private iterationPath(e: Expr): string | null {
    if (e.kind === "Identifier") return e.name;
    if (e.kind === "MemberExpr" && e.object.kind === "Identifier" && e.object.name === "this") return `this.${e.property}`;
    return null;
  }

  /**
   * A call that hands an array to a `@@mutable` PARAMETER (docs/decorators.md). The
   * callee may append to it, so the two things the callee cannot see are checked HERE,
   * at the one place that can see them — the call site.
   *
   * 1. **The marker must TRAVEL.** Passing a plain (unmarked) parameter into a marked
   *    position is NT1607. This is not decoration: it is what makes rule 2 reachable.
   *    `outer(xs: T[])` announces nothing, so a caller of `outer` has no reason to think
   *    its array is about to grow — and rule 2 fires at the call that hands the array
   *    over, which is the call to `outer`. One unmarked hop would route around every
   *    announcement and every check below it.
   * 2. **ITERATOR INVALIDATION.** Growing an array while a `for-of` walks it is NT1603
   *    for a direct `.push`; through a call it is the same hazard and the same code. It
   *    is a WRONG-ANSWER hazard rather than a memory one — `nt_arr_get` re-reads `data`
   *    every step, so nothing dangles, but the loop's length is read ONCE, so nativets
   *    would walk the old length where node walks the growing array.
   *
   * IMPRECISION, stated because it is real: both rules key on an ARGUMENT that is a bare
   * identifier and a CALLEE that is a bare name. An argument that is a field or element
   * path (`f(node.body)`) is admitted — it is memory-safe for the reasons above, but a
   * `for-of` over that same path in this scope is not caught, because `borrowed` is keyed
   * by binding name. Rule 1 is what bounds the damage: the array reached that call
   * through an owned binding or a marked parameter somewhere up the chain.
   */
  private checkMutableArgs(e: { callee: Expr; args: Expr[] }): void {
    if (this.mutableArgs.size === 0 && this.mutableArgProps.size === 0) return;
    const [name, idx] = e.callee.kind === "Identifier"
      ? [e.callee.name, this.mutableArgs.get(e.callee.name)]
      : e.callee.kind === "MemberExpr"
        ? [e.callee.property, this.mutableArgProps.get(e.callee.property)]
        : ["", undefined];
    if (idx === undefined) return;
    for (const i of idx) {
      const a = e.args[i];
      if (a === undefined || a.kind !== "Identifier") continue;
      if (this.borrowParams.has(a.name) && !this.mutableParams.has(a.name)) {
        this.report({
          code: OWN_CODES.MUTATE_THROUGH_BORROW,
          message: `cannot pass \`${a.name}\` to the \`@@mutable\` parameter of \`${name}\`: \`${a.name}\` is a plain parameter, so this signature does not announce that it may be appended to`,
          line: a.loc?.line ?? 0,
          hint: `mark it too — put \`//@@mutable\` on the line above \`${a.name}\` in this parameter list — or build a new array here and return it. The opt-in has to travel, or a caller could not see that its array grows`,
        });
      } else if (this.isBorrowed(a.name)) {
        this.report({
          code: OWN_CODES.MUTATE_WHILE_BORROWED,
          message: `cannot pass \`${a.name}\` to the \`@@mutable\` parameter of \`${name}\` while it is borrowed (iterator invalidation)`,
          line: a.loc?.line ?? 0,
        });
      }
    }
  }

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
    this.condDrops = this.condDrops.add(n); // ⇒ every move of `n` must null its slot
    return true;
  }

  /**
   * Lexical nesting inside a `try` — the guard that keeps `escapes` honest.
   *
   * A `return` inside a `try` runs the `finally` on its way out, and a `throw` inside one
   * runs the `catch` AND the `finally`. Those are program points REACHED FROM the
   * diverging branch, and they read the very state `escapes` would discard:
   *
   *     try { if (c) { const b: number[] = a; return b.length; } }
   *     finally { console.log(a.length); }        // must stay NT1601
   *
   * The `catch`/`finally` entry state is the try block's fall-through state (see the
   * `TryStmt` case), so there is nowhere else for a diverging arm's moves to be recorded.
   * Rather than build a second, exceptional dataflow for it, the relaxation is simply OFF
   * inside a `try` — the analysis there stays bit-for-bit what it is today, which is
   * conservative and already proven. It costs the `try`-local shape of B, and it is not
   * needed for A: A's fix is the `throw` becoming CONSUMING, and the drop flag
   * (`condDrops`/`nullOnMove`) is what makes the maybe-moved local safe to still list.
   */
  private tryDepth = 0;

  /**
   * Is this arm off the path to the fall-through join — may its moves be dropped?
   *
   * All three conditions are load-bearing; see `leavesFrame`, `hasJump` and `tryDepth`.
   */
  private escapes(list: Stmt[]): boolean {
    return this.tryDepth === 0 && !hasJump(list) && leavesFrame(list);
  }

  /**
   * The fall-through join of an `if`'s two arms. An arm that leaves the frame contributes
   * NOTHING: this point is not on any path through it. If both leave, the join itself is
   * unreachable and the state from BEFORE the `if` stands — the most permissive answer,
   * and the one that keeps `if (c) return a; else return a;` from reporting a re-move of
   * a value each arm moves exactly once.
   */
  private joinArms(entry: State, s1: State, l1: Stmt[], s2: State, l2: Stmt[]): State {
    const e1 = this.escapes(l1), e2 = this.escapes(l2);
    if (e1 && e2) return entry;
    if (e1) return s2;
    if (e2) return s1;
    return merge(s1, s2);
  }

  /** Names that need the null-on-move drop flag, and the move sites to null at. */
  condDrops = new Set<string>();
  moveSites = new Map<string, Set<Expr>>();

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
   *  `break`/`continue`/`throw` jump past the drop point: a leak, never a double free.
   *
   *  `extra` names locals this list OWNS without DECLARING: the `catch` binding, which is
   *  bound by the `try` rather than by a `VarDecl` inside the handler, and is otherwise
   *  invisible to `declaredLinear`. */
  private scoped(
    //@@mutable
    list: Stmt[],
    state: State,
    extra: string[] = [],
  ): void {
    const declared = [...extra, ...declaredLinear(list, new Set(this.aliasOf.keys()))].filter((n) => this.linear.has(n));
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
    for (const n of own) if (!this.linear.has(n)) { this.linear = this.linear.add(n); added.push(n); }
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
          // `const hit = xs.find(p)` over a `(T | undefined)[]`: the hit path hands back
          // the ELEMENT BOX the array still owns, so this name is a BORROW for the rest
          // of the scope — the same rule a `for-of` element over a linear array gets
          // above, spelled the same way. Without it, narrowing and rebinding
          // (`const h: T = hit`) makes `h` a second owner and frees the array's element
          // at the block's exit: `xs[1].line` then read freed memory and printed
          // `1e-323` where node prints `3`, exit 0 on both sides.
          //
          // Never DELETED again, unlike the for-of case: a for-of binding dies with its
          // loop, and this one lives to the end of the function like any other `const`.
          if (d.init && searchBorrowBase(d.init) !== null) this.borrowBindings = this.borrowBindings.add(d.name);
        }
        return;
      case "ExprStmt": this.expr(s.expr, state, false); return;
      case "ReturnStmt":
        // `return this` from a `@@mutable` member is a BORROW HAND-BACK, not a move: the
        // caller already owns the receiver, and what it may then do with the returned
        // handle is governed by the call-site rules that are already pinned in
        // test/decorators.test.ts — a method result may not be bound as an owner, may not
        // be returned out of its owner's scope, may not be put in a container. Those rules
        // can SEE this value (it is a call result); they cannot see `this` packed into a
        // container inside the body, which is exactly the gap `borrowThis` closes. So the
        // fluent chain stays legal and nothing else in a consuming position does.
        if (s.argument) this.expr(s.argument, state, !(this.borrowThis && s.argument.kind === "Identifier" && s.argument.name === "this"));
        s.drops = this.ownedInScope(state); // free everything still owned before returning
        return;
      case "IfStmt": {
        this.expr(s.test, state, false);
        const s1 = clone(state);
        this.scoped(s.consequent, s1);
        const s2 = clone(state);
        if (s.alternate) this.scoped(s.alternate, s2);
        assignInto(state, this.joinArms(clone(state), s1, s.consequent, s2, s.alternate ?? []));
        return;
      }
      case "WhileStmt":
        this.loop(state, (st) => { this.expr(s.test, st, false); this.scoped(s.body, st); });
        return;
      case "DoWhileStmt":
        this.loop(state, (st) => { this.scoped(s.body, st); this.expr(s.test, st, false); });
        return;
      case "ForStmt": {
        if (s.init) { if ((s.init as Stmt).kind === "VarDecl") this.stmt(s.init as Stmt, state); else this.expr(s.init as Expr, state, false); }
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
        //
        // Two ways to be that array. A bare NAME must be `linear` — the pre-existing test,
        // unchanged. `this.<field>` carries no entry in `linear` (that set holds bindings,
        // and a field is not one), so it is registered unconditionally: the borrow is inert
        // unless something later mutates the same path, and the only thing that can is the
        // `.push` this lane legalized. See `iterationPath` for the wrong answer this stops.
        const ip = this.iterationPath(s.iterable);
        const bv = ip !== null && (s.iterable.kind !== "Identifier" || this.linear.has(ip)) ? ip : null;
        if (bv !== null) this.pushBorrow(bv);
        // If the element type is linear, the loop var only BORROWS each element —
        // moving it out of the loop is E0507 (NT1604).
        const elemBorrow = s.elemTy !== undefined && isLinearTy(s.elemTy);
        if (elemBorrow) this.borrowBindings = this.borrowBindings.add(s.name);
        this.loop(state, (st) => { this.scoped(s.body, st); });
        if (elemBorrow) this.borrowBindings.delete(s.name);
        if (bv !== null) this.popBorrow(bv);
        return;
      }
      case "SwitchStmt": {
        this.expr(s.discriminant, state, false);
        // A case whose body leaves the frame is not on any path to the statement AFTER the
        // switch, so — exactly as for an `if` arm — its moves are not merged in. A case
        // ending in `break` is NOT one of those: `hasJump` disqualifies it, and its state
        // must reach this join because that is where the break lands.
        const merged = s.cases.map((c) => { const cs = clone(state); this.scoped(c.body, cs); return cs; });
        for (let i = 0; i < merged.length; i++) if (!this.escapes(s.cases[i]!.body)) assignInto(state, merge(state, merged[i]!));
        return;
      }
      case "ForInStmt":
        this.expr(s.object, state, false);
        this.loop(state, (st) => { this.scoped(s.body, st); });
        return;
      case "BlockStmt": this.scoped(s.body, state); return;
      case "MultiStmt": this.seq(s.stmts, state); return; // scope-less group: its decls belong to the enclosing block
      case "ThrowStmt": {
        // THE RAISE IS A MOVE, and it is now spelled as one.
        //
        // Both lowerings TAKE the pointer: a cross-frame raise hands it to
        // `nt_exc_raise_obj`, whose slot owns it until `nt_exc_take_object` gives it to the
        // catch binding; an IN-FRAME throw stores it straight into the catch binding's
        // slot and branches (codegen's `ThrowStmt` case). ownership.ts makes that binding
        // an OWNER either way (see `TryStmt` below) — so the thrower must stop being one.
        //
        // It used to be spelled as SUBTRACTION from the drop list below instead, on the
        // grounds that marking it moved would make `if (c) throw e;` leave `e` maybe-moved
        // for the code after the `if` — an NT1601 on a program node accepts. That was a
        // real objection, and it is what `escapes` now answers: a branch that throws does
        // not merge its moves into the join, so `if (c) { throw err; } use(err);` stays
        // legal with the move recorded. What subtraction could NOT do was cover the
        // IN-FRAME throw of a local declared OUTSIDE the `try`, because the double owner
        // there is not in this list at all — it is the catch binding:
        //
        //     const err = new E("boom");
        //     try { if (n > 0) throw err; return 1; }
        //     catch (e) { return e.message.length * 19; }   // freed `err` AND `e`
        //
        // node prints 76; we exited 255 with empty stdout and no diagnostic. As a MOVE it
        // is a `condDrops` name, so `nullOnMove` nulls `err`'s slot at the raise and the
        // handler's drop of it is the no-op `nt_obj_free(NULL)` — one owner, one free.
        // (Inside a `try`, `escapes` is off by design, so the merge keeps `err`
        // maybe-moved, which is exactly what asks for the drop flag.)
        this.expr(s.argument, state, true);
        // The EXCEPTIONAL exit's drop set, and it is the same one `ReturnStmt` takes
        // above for the same reason: a throw that propagates out of its frame leaves by
        // a `ret`, so it must free exactly what a `return` written here would free.
        // Computed unconditionally — whether the throw actually propagates is codegen's
        // question (`scanEscaping`), and a throw that branches to a local catch simply
        // never reads this list. The thrown name is excluded by `droppable` now that it is
        // moved-on-every-path here, so no filter is needed.
        s.drops = this.ownedInScope(state);
        return;
      }
      case "TryStmt": {
        // The whole statement, handler and finalizer included, is a no-relaxation region
        // (see `tryDepth`): a `return` or `throw` anywhere in it reaches a program point
        // that reads this state, and a nested `try` inside the handler is no different.
        this.tryDepth++;
        this.scoped(s.block, state);
        // THE CATCH BINDING IS AN OWNER. `throw new Error(m)` stores a temporary with no
        // other owner into it and branches, and a cross-frame raise reconstructs a FRESH
        // object into it (codegen's `emitExcCheck`) — either way nothing else can free it.
        // It is bound by the `try`, not by a `VarDecl` in the handler, so `declaredLinear`
        // never saw it and the handler's drop marker never carried it: one object leaked
        // per caught exception, plus every heap string in its slots, since `nt_obj_free`
        // is shallow and a slot nobody frees is a message nobody releases.
        // A STRING binding is NOT linear and is not listed here: it is already an owner on
        // codegen's separate `strLocals` path, and naming it twice would double-free.
        const bound = s.param;
        const owns = s.handler !== null && bound !== null && isLinearTy(s.catchTy ?? "string");
        const caught: string[] = owns && bound !== null ? [bound] : [];
        for (const n of caught) state.set(n, { moved: false, must: false });
        if (s.handler) this.scoped(s.handler, state, caught);
        if (s.finalizer) this.scoped(s.finalizer, state);
        this.tryDepth--;
        return;
      }
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
    // `fieldRoot`/`isThisExpr` are shared with the SETTER-CALL arm, which states the same
    // rule over `this.b.c()` — one notion of "what is this reached through", one spelling.
    const root: Expr = fieldRoot(object);
    if (isThisExpr(root)) return; // a method's own receiver
    const owned = root.kind === "Identifier" && this.varTy.has(root.name) && !this.borrowBindings.has(root.name);
    if (owned) return;
    // THE SIGNATURE ARM (piece 3). A by-borrow PARAMETER or a `for-of` ELEMENT whose type
    // is a `@@mutable` RECORD may be mutated in place. `borrowBindings` is exactly
    // {parameters} ∪ {aliases} ∪ {for-of elements}, so subtracting `aliasOf` leaves the two
    // this arm covers — an ALIAS is still refused, and so is any receiver that is not a
    // binding (a container element, a call result, a capture), which never gets here.
    //
    // WHY THIS IS THE RIGHT PLACE FOR THE OPT-IN: the tag is NOMINAL and therefore part of
    // the signature, so `function tick(c: Cell)` announces "may mutate" in its own type and
    // the calling convention stays visible at the call site — the objection that ruled out
    // inferring it. Requiring a second opt-in per (function × receiver) site would not.
    //
    // SOUND, and none of it is new machinery: a borrow never FREES (the caller still drops
    // exactly once), the assigned VALUE is consumed (`b.items = local` MOVES `local`, which
    // is what closes the use-after-free `.push` once had), and the OVERWRITTEN value is
    // leaked rather than freed (required — an alias may still hold it). What is lost is
    // EXCLUSIVITY, which docs/decorators.md Decision 3 already disclaims.
    //
    // Restricted to a receiver that IS the binding: `p.b.n = 1` keeps the refusal, because
    // the record actually mutated (`p.b`) is a container element and not a binding at all.
    if (object.kind === "Identifier" && this.borrowBindings.has(object.name) && !this.aliasOf.has(object.name)) {
      const ty = this.varTy.get(object.name);
      const tag = ty !== undefined && isObjectTy(ty) ? classTag(ty) : undefined;
      if (tag !== undefined && this.mutable.records.has(tag)) return;
    }
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
        if (this.arrowDepth > 0) this.arrowNames = this.arrowNames.add(e.name);
        if (this.envArrowDepth > 0) this.envArrowNames = this.envArrowNames.add(e.name);
        // Moving out of a borrowed binding (by-borrow param / for-of element) is E0507 —
        // and `this` in a `@@mutable` member body is one of them (see `borrowThis`). The
        // one consuming position that IS legitimate, `return this`, never reaches here:
        // `ReturnStmt` passes it as a borrow.
        if (consume && this.borrowThis && e.name === "this") {
          this.report({
            code: OWN_CODES.MOVE_OUT_OF_BORROW,
            message: "cannot move out of `this`: it is borrowed (the caller owns the receiver)",
            line: e.loc?.line ?? 0,
            hint: "a `@@mutable` method's receiver belongs to the CALLER, which frees it when its own scope ends — so storing `this` where it can outlive the call (a field, an array or object literal, a `.push`) leaves a second handle pointing at freed memory. `return this` is the one hand-back that stays legal, because the call site's own non-escape rules can see it. To keep a reference, return `this` and let the caller decide where to put it, or store an owned COPY of the data instead of the receiver",
          });
          return;
        }
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
          if (!sites) { sites = new Set(); this.moveSites = this.moveSites.set(e.name, sites); }
          sites.add(e);
          state.set(e.name, { moved: true, must: true, at: e.loc?.line });
        }
        return;
      }
      case "CallExpr": {
        // Record the inlined-HOF callback BEFORE anything can walk into it, so the
        // `ArrowFunction` case below can tell "loop body" from "closure with an env".
        const cb0 = e.args[0];
        if (e.callee.kind === "MemberExpr" && cb0 !== undefined
          && isInlinedHofArrow(e.callee.property, e.callee.object.ty, cb0.kind)) this.inlinedCallbacks = this.inlinedCallbacks.add(cb0);
        this.checkMutableArgs(e);
        if (isMoveCall(e)) { this.expr(e.args[0]!, state, true); return; }
        if (isIdentityCall(e)) { this.expr(e.args[0]!, state, consume); return; }
        // `a.reverse()` mutates in place and hands the SAME pointer back, so for
        // ownership it is transparent — exactly like `Object.freeze(a)` above. The
        // result IS the receiver, so a consuming position (`return a.reverse()`,
        // `[a.reverse()]`) consumes `a` itself; a borrowing one leaves `a` owned.
        // Without this the scope dropped `a` and returned the freed pointer.
        // (A BINDING of the result reaches here with consume=false: `collectAliases`
        // already made it an alias, so the receiver stays the one owner.)
        // The tag test is REPEATED from `retainsReceiver` rather than inherited from it,
        // because a `boolean` return carries no narrowing back here — the same gap
        // `retainedReceiver` documents 700 lines above, closed the same way. That comment
        // was written about the sibling site and this one was missed, so it is worth being
        // explicit: the read this replaces,
        //
        //     (e.callee as { object: Expr }).object
        //
        // put `object` at slot 0 of the asserted shape while `MemberExpr` carries it at
        // slot 1 and slot 0 is `kind`. Compiled, it took the `kind` STRING POINTER and
        // handed it to `this.expr` as an `Expr`. Every other site in this family produces a
        // wrong VALUE; this one feeds a wrong POINTER to the pass that decides what gets
        // freed, and `.reverse()` is exactly the case where that decision is "the result IS
        // the receiver, so do not drop it twice".
        if (e.callee.kind === "MemberExpr" && retainsReceiver(e)) {
          this.expr(e.callee.object, state, consume);
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
        // …and with one ROOT that is a binding this arm could not see: the method's OWN
        // RECEIVER, one or more fields down (`this.mod.intern(…)`).
        //
        // This is not a new permission. `checkOwnedReceiver` — THE SAME RULE stated over a
        // field ASSIGN rather than a setter call — peels the member chain to its root and
        // returns early on `this`, "a method's own receiver". So on the unmodified tree
        // `this.c.pos = this.c.pos + 1` compiled while `this.c.bump()`, which performs the
        // identical write, was refused. Two arms of one rule disagreed about one receiver,
        // and the difference was SPELLING, not ownership.
        //
        // The arm's own `recv` lookup already accepts bare `this` (it is in `varTy`), so
        // depth 0 was never in question; it just stopped peeling at depth 1, where a field
        // path is a `MemberExpr` and not the `Identifier` the lookup demands. `borrowThis`'s
        // comment states the intent this restores, in as many words: "`this` is not a
        // binding — the receiver rule (`checkOwnedReceiver`) and the setter rule BOTH
        // special-case the name already".
        //
        // SOUND, for the reason the field-assign arm is: a setter MUTATES IN PLACE. It
        // frees nothing and stores no second owner, so it writes into storage the caller's
        // receiver transitively owns and the caller still drops exactly once. What is given
        // up is EXCLUSIVITY — another handle may observe the write — which is the identical
        // cost `this.c.pos = …` already pays, and which docs/decorators.md Decision 3
        // disclaims for `@@mutable` by design.
        //
        // ESCAPE IS UNTOUCHED, and that is the boundary worth naming: `this` remains a
        // borrow (`borrowThis`), the setter still returns a borrow of the inner object, and
        // MOVE_OUT_OF_BORROW still refuses handing either one out of the body.
        //
        // Restricted to depth >= 1 on purpose (`chainRoot(...) is a MemberExpr`): bare
        // `this.setter()` keeps going through the arm exactly as before, so the accepted
        // path for it — and the borrowed-receiver report below — are byte-identical.
        const ownFieldRecv = e.callee.kind === "MemberExpr"
          && chainRoot(e.callee.object).kind === "MemberExpr"
          && isThisExpr(fieldRoot(chainRoot(e.callee.object)));
        if (e.callee.kind === "MemberExpr" && !freshRecv && !ownFieldRecv && this.mutable.setterProps.has(e.callee.property)) {
          const root = chainRoot(e.callee.object);
          const recv = root.kind === "Identifier" && this.varTy.has(root.name) ? root.name : null;
          if (recv === null) {
            // WHICH ADVICE IS TRUE depends on what the receiver actually is, and the one
            // text this used to print was FALSE for the commonest case that reaches here.
            // On `const h = new Holder(); h.c.bump();` it said "it needs an OWNED receiver
            // — a local bound to `new C(…)` in this scope", and `h` IS exactly that; then
            // it listed "container elements, closure captures and callback parameters",
            // and `h.c` is none of the three. So it named neither the reason (a FIELD is
            // not a binding this scope can name) nor a rewrite that compiles — following
            // it literally gives `const c = new Counter(); c.bump();`, which builds a
            // second counter and mutates the wrong one.
            //
            // The field arm's advice is COMPILED, not asserted: reaching the field from
            // inside a method of its holder (`tick(): void { this.c.bump(); }`, then
            // `h.tick()`) is the shape legalized above, and it runs byte-identically to
            // node from an owned local AND through a by-borrow parameter.
            const fieldRecv = root.kind === "MemberExpr";
            this.report({
              code: OWN_CODES.MUTATE_THROUGH_BORROW,
              message: fieldRecv
                ? `cannot call the \`@@mutable\` setter \`${e.callee.property}\` here: its receiver is the field \`${root.property}\`, which this scope owns no binding for`
                : `cannot call the \`@@mutable\` setter \`${e.callee.property}\` here: its receiver is not a binding whose ownership this scope can establish`,
              line: lineOf(e.callee),
              hint: fieldRecv
                ? `a setter mutates in place, so it needs a receiver whose ownership this scope can establish — and a FIELD is owned by the object that holds it, not by anything named here. Mutate it from INSIDE a method of that holder, where \`this.${root.property}.${e.callee.property}(…)\` is owned exactly as far as \`this\` is, and call that method from here instead`
                : "a setter mutates in place, so it needs an OWNED receiver — a local bound to `new C(…)` in this scope. Container elements, closure captures and callback parameters cannot be proved unique, so they are refused rather than mutated blind",
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
        // ITERATOR INVALIDATION on a FIELD (`for (const x of this.xs) this.xs.push(…)`).
        // Stated over the PATH, so it covers the receiver a `@@mutable` class's array field
        // now presents. Separate from the bare-name arm below rather than merged into it:
        // that arm additionally requires `this.linear.has(recv)`, and a field has no entry
        // there, so folding the two would either lose the field or drop a guard the bare
        // name still needs. See `iterationPath` for the wrong answer this stops.
        if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "MemberExpr" && MUTATING.has(e.callee.property)) {
          const path = this.iterationPath(e.callee.object);
          if (path !== null && this.isBorrowed(path)) {
            this.report({
              code: OWN_CODES.MUTATE_WHILE_BORROWED,
              message: `cannot mutate \`${path}\` while it is borrowed (iterator invalidation)`,
              line: e.callee.object.loc?.line ?? 0,
              // METHOD-AWARE, because `MUTATING` holds two methods that invalidate for
              // OPPOSITE reasons and the push text was being printed for both. `.pop`
              // reallocates nothing — it decrements the length — so "reallocates it" and
              // "the growth being SEEN" were each false on a pop, and "append after the
              // loop" is not a fix for a program that removes. Measured, with this guard
              // off: `for (const x of this.xs) { this.xs.pop(); s = s + x; }` over five
              // elements prints `60 2` under node (the iterator re-reads `length` and
              // stops early, leaving two) and `60 0` here (the lowered loop runs the
              // ENTRY length, `nt_arr_get` answers 0 for the indices past the shrunken
              // end, and every iteration pops). Same sum by coincidence, different array,
              // exit 0 both times — the silent-wrong-answer class.
              hint: e.callee.property === "pop"
                ? `a \`for-of\` over \`${path}\` snapshots the length before the first step, and \`.pop\` changes it underneath — node's iterator re-reads \`length\` every step and STOPS EARLY, while this loop would run the original count and read past the new end. Take the elements you want inside the loop and shrink AFTER it (\`for (const x of ${path}) { … }\` then the \`.pop()\` calls), or iterate an index yourself with \`while (${path}.length > 0)\``
                : `a \`for-of\` over \`${path}\` reads through the array's storage, and \`.push\` reallocates it — so the loop would keep reading the old block, and node's answer depends on the growth being SEEN. Collect into a local first (\`let add: T[] = []\` … \`add.push(v)\`), then append after the loop`,
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
          // The one hole the type/flow layers cannot see is a CLOSURE WITH AN ENV: a bound
          // arrow copies the array pointer into an `nt_obj_new` block that this scope
          // cannot null and that may outlive the binding, so a push through it is a write
          // to storage we may already have freed. `envCaptured` is the scan pass's
          // over-approximation ("mentioned inside any arrow that GETS an env"), which
          // refuses the push whether it is written inside the arrow or outside it while an
          // arrow holds the name. Over-refusal, never a UAF.
          //
          // An INLINED HOF callback is deliberately NOT in that set, and this is where the
          // rule used to be wrong: `xs.forEach((x) => out.push(x))` was refused with a
          // reason that does not apply to it. `genForEach`/`genMap`/… emit the arrow's
          // statements straight into the enclosing frame as a loop — no env is allocated,
          // no pointer is snapshotted, and the body cannot outlive the statement it is
          // written in, because it IS the statement. The accepted program is the `for-of`
          // loop it desugars to, which has always compiled; `nt_arr_push` mutates the
          // NtArray header in place (only `a->data` is reallocated), so the accumulator's
          // pointer does not move under the loop either. See docs/divergences.md.
          if (e.callee.property === "push" && this.linear.has(recv) && this.envCaptured.has(recv)) {
            // WHICH ADVICE IS TRUE depends on where this push is written. Inside an
            // inlined callback the push itself is already the recommended spelling, and
            // telling the author to write what they just wrote is the "hint that compiles
            // to a wrong answer" failure this file has hit before: the env belongs to some
            // OTHER arrow in the scope, and that arrow is what has to move.
            const insideInlined = this.arrowDepth > 0 && this.envArrowDepth === 0;
            this.report({
              code: OWN_CODES.MUTATE_THROUGH_BORROW,
              message: insideInlined
                ? `cannot \`.push\` to \`${recv}\`: this callback is inlined, but ANOTHER arrow in this scope captures \`${recv}\` into its own environment`
                : `cannot \`.push\` to \`${recv}\`: a closure with its own environment captures it, so this scope is not its only handle`,
              line: e.callee.object.loc?.line ?? 0,
              hint: insideInlined
                ? `the \`.push\` itself is fine — an inlined HOF callback is a loop in this frame. What blocks it is a BOUND arrow elsewhere in this scope that mentions \`${recv}\`: it copies the array pointer into a heap env this scope cannot null, so the append could write storage already freed. Drop that arrow, or read \`${recv}\` through a plain expression instead of from inside one`
                : "a BOUND arrow copies the array pointer into a heap env this scope cannot null, and the closure may outlive the binding — so an in-place append could write storage that is already freed. An INLINED callback is different and is allowed: write the accumulation as `xs.forEach((x) => { out.push(x); })` (or a plain `for-of`), which compiles to a loop in this same frame and needs no env at all",
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
        // ASSIGNMENT TO A LINEAR PARAMETER (≈ rustc E0384: a parameter is an immutable
        // binding unless declared `mut`). A parameter is a BORROW — the caller owns the
        // value and frees it when its own scope ends. Rebinding one is a lost update in
        // node (the caller never sees it), and it was a USE-AFTER-FREE here: `dropOld`
        // below proved only "not moved, not captured", never "this scope owns it", so
        // `out = ["z"]` freed the CALLER's array and every later read of it dangled.
        //   function f(out: string[]): void { out = ["z"]; }
        //   const acc: string[] = ["a", "b"]; f(acc); console.log(acc.length);
        // node prints 2; this printed 3, then a fresh garbage integer per run, at exit 0.
        //
        // Suppressing `dropOld` alone is memory-safe and matches node exactly, but then
        // nothing ever frees the value the callee allocated — the borrow is not this
        // scope's to drop, and proving WHICH paths reassigned needs a per-parameter drop
        // flag we do not have. A leak is the better of the two failures, and a REFUSAL is
        // better than either: the pattern users write this for (an accumulator out-param)
        // cannot work in node either, so the rebinding is never what they wanted.
        // docs/self-hosting.md:2076 already decided the same question for a persistent
        // Map — "RETURN the bindings".
        if (this.borrowParams.has(e.target)) {
          this.report({
            code: OWN_CODES.ASSIGN_TO_BORROW_PARAM,
            message: `cannot assign to \`${e.target}\`: a parameter is a BORROW, so this scope may not rebind it`,
            line: lineOf(e.value),
            hint: `the caller owns \`${e.target}\` and frees it when its own scope ends, so this assignment could not be visible to the caller — node discards it too. RETURN the new value and rebind at the call site (\`${e.target} = f(${e.target})\`), or take a copy first (\`let local = [...${e.target}]\`) and rebind that`,
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
        this.expr(e.value, state, !(e.paramProp ?? false));
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
      /**
       * A `?:` YIELDS ONE OF ITS ARMS, so in a consuming position it MOVES whichever one
       * runs — the arms inherit `consume`, exactly as `as` / `satisfies` / `!` below do.
       * Only the TEST is unconditionally a borrow.
       *
       * This used to hard-code `consume: false` for both arms, which discarded the
       * caller's move and made `?:` a universal laundering step for the ownership rules:
       * `const y: string[] = x` was NT1604, and `const y: string[] = c ? x : o` — the
       * IDENTICAL move — compiled at exit 0. Everything downstream is designed assuming
       * those refusals hold, so this was not merely a missing diagnostic: the binding
       * became a second owner of the caller's value and freed it, which ASan reports as
       * `heap-use-after-free` in `nt_arr_free`, and as "attempting double-free" when a
       * union member is returned through an arm. Silent on a plain run — the allocator's
       * abort discards buffered stdout, so the program exits 0 having printed a prefix of
       * the right answer. Same defect and same shape as `AsExpr` (481c463), one node type
       * over. An explicit `move(x)` in an arm WAS caught (its own case consumes), which is
       * why only the IMPLICIT move stayed open.
       *
       * MOVE and not the ALIAS reading `as` takes: `as` retypes ONE place, so its result
       * is always the operand's allocation, while a `?:` picks between two — and an arm can
       * be a fresh value (`c ? a : ["z"]`) that nothing else will ever free. Aliasing would
       * leak those. The cost of moving is the mirror case, two owned locals as the two arms
       * (`c ? a : b`): both are marked moved but only the one that ran is reachable through
       * the result, so the other LEAKS. Making that exact needs a per-path drop flag this
       * pass does not have — the same one `AssignExpr`'s borrow-param rule above declined
       * to invent — and a leak is the better of the two failures. It was a
       * use-after-free before. Pinned in test/drops.test.ts.
       */
      case "ConditionalExpr":
        this.expr(e.test, state, false); this.expr(e.consequent, state, consume); this.expr(e.alternate, state, consume);
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
      /**
       * `expr as T` is a type-layer assertion, so ownership flows straight THROUGH it —
       * exactly as it does for its two neighbours below. This used to hard-code
       * `consume: false`, which made `as` the only expression form that turned a MOVE
       * into a BORROW: `const b = a as T;` left `a` live and owned while `b` became an
       * owner too, so the object was freed TWICE at end of scope. A double free out of
       * safe TypeScript — and a silent one, since the allocator's abort discards
       * buffered stdout. `as` retypes a value; it does not duplicate it.
       */
      case "AsExpr": this.expr(e.expr, state, consume); return;
      // `satisfies` is a pure type-layer check; ownership flows straight through it.
      case "SatisfiesExpr": this.expr(e.expr, state, consume); return;
      // `expr!` is a type-level assertion; ownership flows straight through it.
      case "NonNullExpr": this.expr(e.expr, state, consume); return;
      case "InstanceOfExpr": this.expr(e.object, state, false); return; // a type TEST only borrows
      case "InExpr": this.expr(e.key, state, false); this.expr(e.object, state, false); return; // a key-presence TEST only borrows
      case "ObjectLiteral": for (const p of e.properties) this.expr(p.value, state, !p.spread); return; // fields move into the object; a `...spread` source is COPIED (borrow), so it stays usable + owned
      case "ArrowFunction": { // captures/params aren't linear here; the BODY is its own scope
        // An inlined HOF callback allocates no env, so descending into it does NOT cross a
        // capture boundary for `envArrowNames` (it still does for the conservative
        // `arrowNames`). Nesting is honoured both ways: a bound arrow written INSIDE an
        // inlined body still bumps the env counter, and an inlined callback written inside
        // a bound arrow stays under that arrow's already-raised counter.
        const inlined = this.inlinedCallbacks.has(e);
        this.arrowDepth++;
        if (!inlined) this.envArrowDepth++;
        if (e.exprBody) this.expr(e.body as Expr, state, false);
        else this.arrowScope(e.stmts as Stmt[], state);
        if (!inlined) this.envArrowDepth--;
        this.arrowDepth--;
        return;
      }
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
  //@@mutable
  const out: string[] = [];
  for (const s of list) {
    if (s.kind === "VarDecl") { for (const d of s.decls) if (isLinearTy(d.ty ?? "number") && !aliases.has(d.name)) out.push(d.name); }
    else if (s.kind === "MultiStmt") for (const n of declaredLinear(s.stmts, aliases)) out.push(n);
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
/*  `selfName` joins them for the same reason: it is an ArrowFunction ANNOTATION naming the
 *  declarator that binds the arrow (`ArrowFunction.selfName`, set for a self-recursive
 *  `const`), not a use of it. Left off the list it disqualified every self-recursive
 *  closure from its own drop — the annotation read as a mention of the very name it
 *  describes, exactly like `drops` and `endDrops` above. */
const NOT_A_MENTION = new Set(["kind", "ty", "elemTy", "retTy", "key", "property", "field", "names", "drops", "endDrops", "selfName"]);

/**
 * KEPT AS A CAST, deliberately — the one duck-typed window in `src/` that is sound, and
 * the reason is worth stating so it is not "fixed" into something worse.
 *
 * The others (`retarget`, the `nullOnMove` marking) named a field that lives at slot 1, 2
 * or 4 through a ONE-FIELD window, i.e. at slot 0, i.e. at `kind`. This one names `kind`,
 * and `kind` genuinely IS slot 0 of every `Expr`/`Stmt` member — so the window and the
 * layout agree, and the read is exactly node's answer. `test/as-cast.test.ts` pins that
 * case as legal and, being an agreeing slot in every member, free of any tag check.
 *
 * Tag dispatch is not available here anyway: the argument is `unknown` from a structural
 * walk, so there is no static union to narrow — reading the tag IS the narrowing. That is
 * what makes this a type guard rather than a layout assumption.
 */
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
  selfOf: string | undefined, inSelfCallee: boolean, seen: Set<object>, out: Set<string>,
): void {
  if (typeof node === "string") {
    if (NOT_A_MENTION.has(key) || !cands.has(node)) return;
    // THE SELF-CALL, and the only mention inside an arrow body that is still not one. See
    // `inSelfCallee` at the recursion below for why this is exact rather than a blanket
    // exemption: only the arrow's OWN name, only directly under a call's callee.
    // `selfOf !== undefined` first: comparing `string` with `string | undefined` is NT2001
    // in the subset this compiler compiles (see `computeCaptures` in src/checker.ts).
    if (inSelfCallee && key === "name" && selfOf !== undefined && node === selfOf) return;
    out.add(node);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(node)) { for (const el of node) scanMentions(el, key, cands, ownDecls, inArrow, selfOf, inSelfCallee, seen, out); return; }
  // An arrow BODY copies what it names into a second env that may outlive this scope,
  // so inside one even a call callee is a mention.
  const arrow = inArrow || obj["kind"] === "ArrowFunction";
  const skipCallee = !arrow && obj["kind"] === "CallExpr" && isIdentNode(obj["callee"]);
  // ...with ONE exception, the arrow's own name. A self-call copies the pointer nowhere:
  // `computeCaptures` (src/checker.ts) deliberately does not capture the self-name, and
  // codegen lowers the call through `%__clo`, the environment the arrow is already running
  // in — so the pointer still lives in exactly the one slot this scope owns and drops.
  //
  // ENTERING AN ARROW REPLACES `selfOf` rather than adding to it, so an ENCLOSING arrow's
  // name mentioned inside a NESTED one is still a mention: that one genuinely is captured
  // into the nested arrow's env, and the nested env may outlive this scope. Replacing also
  // means an arrow with no `selfName` clears it, which is the conservative direction (a
  // leak, never a free of something still live).
  const self = obj["kind"] === "ArrowFunction"
    ? (typeof obj["selfName"] === "string" ? obj["selfName"] : undefined)
    : selfOf;
  // Descended INTO rather than skipped outright, unlike `skipCallee`: the string test above
  // exempts only a `name` equal to `self`, so any other candidate reachable under the same
  // callee still disqualifies.
  const selfCallee = arrow && self !== undefined && obj["kind"] === "CallExpr" && isIdentNode(obj["callee"]);
  // The flag is set on the CallExpr's `callee` KEY, but the string it has to reach is one
  // level further down — the callee `Identifier`'s own `name`. So it survives exactly that
  // one hop, and is cleared at anything that is not that Identifier, which keeps the
  // exemption from leaking into a subtree where a same-named binding could really escape.
  const underCallee = inSelfCallee && obj["kind"] === "Identifier";
  const ownDecl = ownDecls.has(obj);
  for (const k of Object.keys(obj)) {
    if (skipCallee && k === "callee") continue;
    if (ownDecl && k === "name") continue; // the candidate's own declarator, not a use
    scanMentions(obj[k], k, cands, ownDecls, arrow, self, underCallee || (selfCallee && k === "callee"), seen, out);
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
        out.set(d.name, d);
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
 *
 * ...but it costs one, and a NESTED FUNCTION'S BODY is a different frame, so counting it
 * here is over-counting with nothing bought. Codegen says so directly rather than by
 * comment: `collectLocals` (src/codegen.ts) has no `FuncDecl` case at all, and
 * `genFunction` calls `reset()` before it starts — a declaration inside a nested function
 * gets a slot in THAT function's frame and can never share one out here. The FuncDecl's
 * OWN name still counts; only its parameters and body are skipped.
 *
 * That is a real leak: an ordinary helper's private `let add = 0` deleted the drop for a
 * `const add = …` closure in the module frame. Worst when modules are LINKED, because
 * `runScope` analyses that frame with `program.body` and after SH1 that is every module at
 * once — so the collision arrives from a file the closure has never heard of, which no
 * per-module measurement can see and no differential test can either (the output is
 * identical, it just never frees). `test/modules/closure-drop` pins the linked shape with
 * `__objLive()`, `test/closure-env-drops.test.ts` the single-file one.
 *
 * The sibling collectors here — `collectLinear`, `collectVarTys`, `collectAliases` — are
 * kind-by-kind switches with no `FuncDecl` arm and were already right. Only this one walked
 * reflectively, which is how it over-reached.
 *
 * Arrow bodies keep counting. An inlined HOF callback's locals DO land in the enclosing
 * frame (`freshenHofArrow` makes them unique first), and that is the direction where a
 * mistake would be a use-after-free rather than a leak.
 */
function shadowedNames(node: unknown, seeded: string[]): Set<string> {
  let count = new Map<string, number>();
  for (const p of seeded) count = count.set(p, (count.get(p) ?? 0) + 1);
  const seen = new Set<object>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    const obj = n as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(n)) { for (const el of n) walk(el); return; }
    const nm = obj["name"];
    if (typeof nm === "string" && obj["kind"] !== "Identifier") count.set(nm, (count.get(nm) ?? 0) + 1);
    // A nested function is its own frame: its name is declared here, its insides are not.
    if (obj["kind"] === "FuncDecl") return;
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  let out = new Set<string>();
  for (const [n, c] of count) if (c > 1) out = out.add(n);
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
  scanMentions(list, "", cands, new Set(decls.values()), false, undefined, false, new Set(), escaped);
  return [...cands].filter((n) => !escaped.has(n) && !shadowed.has(n));
}

/**
 * Every binding that NAMES a value someone else owns — an ALIAS, not a move. Recorded
 * as alias → owner. Aliases are excluded from the owned/droppable sets everywhere, so
 * the value is still freed exactly once, by the original binding, and can never be
 * double-freed through a second handle; and each is registered as a borrow, so it can
 * never escape the owner's scope (returning one is NT1604).
 *
 * Three sources, sharing that one mechanism:
 *   - `const b = a` (and `const c = a.bump()`) where the type is an `@@mutable` class
 *     instance — the decorators model (docs/decorators.md);
 *   - `const b = a.reverse()` on ANY linear value — the call returns its receiver;
 *   - `const b = o.f` where the FIELD is linear and `o` is a BORROW (`borrowRoots`: a linear
 *     parameter, a method's `this`, or a `for-of` element) — the object still owns the field.
 *
 * THE THIRD ONE CLOSED A USE-AFTER-FREE, and it is the reason this comment says three.
 * A field read was neither a move nor an alias: nothing recorded it at all, so the
 * binding was an ordinary linear local and scope exit emitted `nt_arr_free` on storage
 * the receiver still points at.
 *
 *   type Box = { lines: string[] };
 *   function probe(o: Box): string { const b = o.lines; return b.join("|"); }
 *   const o: Box = { lines: ["a", "b"] };
 *   probe(o);
 *   console.log(o.lines.join("|"));   // node "a|b";  we printed an EMPTY LINE, at exit 0
 *
 * The same shape through a `@@mutable` class field SEGFAULTED — exit 139 out of a
 * memory-safe language. `test/ownership/move-out-of-field.ts` pins both.
 *
 * ALIAS, not refusal, is the right answer here and the distinction matters: the READ is
 * perfectly safe and matches node, and refusing it would reject `const b = o.lines;
 * b.length` — a shape this compiler's own source is full of. What is unsafe is letting
 * the handle ESCAPE, and that falls out for free: an alias is a borrow binding, so
 * `return b` / `move(b)` / storing it in a container is the existing NT1604.
 *
 * A LOCALLY-OWNED receiver is deliberately NOT in `borrowRoots` (`const o = { lines: […] };
 * const b = o.lines`): there the move is genuine, `nt_obj_free` is shallow so nothing is
 * freed twice, and that shape compiles and matches node today.
 *
 * The cost is a LEAK where there used to be a use-after-free — the array-in-object class
 * `nt_obj_free` already leaks by construction (docs/ROADMAP.md, "Why ELEMENTS is not a
 * one-line fix"), so this joins a known list rather than opening a new one, and the
 * project's stated trade is leak-over-dangle.
 */
function collectAliases(stmts: Stmt[], isMutableTy: (t: Ty) => boolean, out: Map<string, string>, borrowRoots: Set<string> = new Set()): void {
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
          // `const c = s as T` — a type ASSERTION names the very same allocation `s`
          // does; `as` reinterprets a place, it does not produce a value. So `c` is an
          // ALIAS, by the same rule and for the same reason as `a.reverse()` below.
          //
          // This is what stopped the scope freeing one pointer through BOTH names: `as`
          // used to leave `s` owned AND make `c` an owner, so the object was freed twice
          // (a double free out of safe TypeScript — test/as-cast.test.ts).
          //
          // ALIAS rather than MOVE, and the distinction is the whole point: `s` is very
          // often a borrowed PARAMETER, and `const c = s as Extract<Expr, …>` is the
          // single most common shape in this compiler's own source. Moving would refuse
          // every one of them with NT1604 — correct, but it would reject the pattern
          // `Extract<T, U>` exists to serve. Letting the handle ESCAPE is the unsafe
          // part, and that is still caught: an alias is a borrow binding, so `return c`
          // is the existing NT1604. Deliberately NOT gated on `isMutableTy` — the double
          // free it prevents is the plain immutable-object shape.
          const asRoot = assertedPlaceRoot(d.init);
          if (asRoot !== null) { out.set(d.name, asRoot); continue; }
          const retained = retainedReceiver(d.init);
          if (retained !== null) { out.set(d.name, retained); continue; }
          // `const b = o.f` / `const b = this.f` on a LINEAR field of a BORROWED receiver:
          // the object owns the field and outlives this scope, so `b` names it rather than
          // taking it. Not `@@mutable`-gated — it is the plain-array shape that dangled.
          const fieldRoot = borrowedFieldRoot(d.init, borrowRoots);
          if (fieldRoot !== null && isLinearTy(d.ty ?? "number")) { out.set(d.name, fieldRoot); continue; }
          if (!isMutableTy(d.ty ?? "number")) continue;
          if (d.init.kind === "Identifier") out.set(d.name, d.init.name);
          else if (d.init.kind === "CallExpr" && d.init.callee.kind === "MemberExpr") {
            const base = d.init.callee.object;
            out.set(d.name, base.kind === "Identifier" ? base.name : "");
          }
        }
        break;
      case "IfStmt": collectAliases(s.consequent, isMutableTy, out, borrowRoots); if (s.alternate) collectAliases(s.alternate, isMutableTy, out, borrowRoots); break;
      case "WhileStmt": case "DoWhileStmt": case "ForInStmt": case "BlockStmt": collectAliases(s.body, isMutableTy, out, borrowRoots); break;
      // A `for-of` ELEMENT over a linear element type is a BORROW for the body's extent —
      // the array owns it, exactly as `Analyzer.expr` puts the name in `borrowBindings`
      // there. So `for (const t of toks) { const b = t.parts; }` is the same
      // use-after-free as the parameter case, and it SEGFAULTED (exit 139) rather than
      // merely printing a wrong answer. Scoped to the body with a fresh set: the name is
      // not a borrow outside the loop.
      case "ForOfStmt":
        collectAliases(s.body, isMutableTy, out,
          isLinearTy(s.elemTy ?? "number") ? new Set<string>([...borrowRoots, s.name]) : borrowRoots);
        break;
      case "ForStmt": if (s.init && (s.init as Stmt).kind === "VarDecl") collectAliases([s.init as Stmt], isMutableTy, out, borrowRoots); collectAliases(s.body, isMutableTy, out, borrowRoots); break;
      case "SwitchStmt": for (const c of s.cases) collectAliases(c.body, isMutableTy, out, borrowRoots); break;
      case "TryStmt": collectAliases(s.block, isMutableTy, out, borrowRoots); if (s.handler) collectAliases(s.handler, isMutableTy, out, borrowRoots); if (s.finalizer) collectAliases(s.finalizer, isMutableTy, out, borrowRoots); break;
      case "MultiStmt": collectAliases(s.stmts, isMutableTy, out, borrowRoots); break;
      default: break;
    }
  }
}

/** Static type of every name bound in a scope — what the `@@mutable` rules read. */
function collectVarTys(stmts: Stmt[], out: Map<string, Ty>): void {
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
      case "ForStmt": if (s.init && (s.init as Stmt).kind === "VarDecl") collectLinear([s.init as Stmt], out); collectLinear(s.body, out); break;
      case "ForOfStmt": collectLinear(s.body, out); break;
      case "SwitchStmt": for (const c of s.cases) collectLinear(c.body, out); break;
      case "BlockStmt": collectLinear(s.body, out); break;
      // A `try` was MISSING here, and it was a LEAK rather than a refusal: `scoped()` is
      // called on all three lists, so `declaredLinear` did find an array declared inside
      // one — but `scoped` then intersects that with `this.linear`, which is what this
      // function builds, so the name was never linear and the block's drop marker carried
      // nothing. One array (or object, or closure env) leaked per execution of the `try`.
      // `collectVarTys` directly above already descends here; these two walk the same tree
      // for the same frame and had disagreed about it since the `try` lowering landed.
      case "TryStmt": {
        // The `catch` binding too, when it holds a heap aggregate — it is an owner (see
        // the `TryStmt` case in `stmt`) and `declaredLinear` cannot see it, so `scoped`
        // is handed it explicitly and needs it to be linear for that to count.
        const bound = s.param;
        if (s.handler !== null && bound !== null && isLinearTy(s.catchTy ?? "string")) out.add(bound);
        collectLinear(s.block, out);
        if (s.handler) collectLinear(s.handler, out);
        if (s.finalizer) collectLinear(s.finalizer, out);
        break;
      }
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
    records: new Set(checked.program.mutableRecords ?? []),
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
  let consuming = new Map<string, Set<number>>();
  for (const s of checked.program.body) {
    if (s.kind !== "FuncDecl" || !s.name.endsWith(CTOR)) continue;
    const sig = checked.functions.get(s.name);
    if (sig === undefined) continue;
    let idx = new Set<number>();
    for (let i = 1; i < s.params.length; i++) {
      if ((s.params[i]!.paramProp ?? false) && isLinearTy(sig.params[i] ?? "number")) idx = idx.add(i - 1);
    }
    if (idx.size > 0) consuming = consuming.set(s.name.slice(0, s.name.length - CTOR.length), idx);
  }

  const isMutableTy = (t: Ty): boolean => {
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
   *
   * UNTRACKED IS NOT UNCHECKED. Read literally, the first clause justifies exempting ONE
   * consuming position — the `return this` it names — and then delegates the rest to the
   * call-site rules. But the mechanism it used, dropping `this` from `paramBorrows`, also
   * dropped it from `borrowBindings`, which exempted EVERY consuming position: a field
   * store, an array/object literal, a `.push`, an argument in a consuming slot. The
   * call-site rules cannot reach any of those — they inspect the RESULT of a call, and
   * these all happen inside the callee. `borrowedThis` below restores the borrow without
   * restoring the move tracking; see `Analyzer.borrowThis`.
   */
  const untrackedThis = (fn: FuncDecl): boolean =>
    // `fn.params.length > 0` FIRST: a nullary function makes `fn.params[0]` a read at
    // index == length, which nativets PANICS on (Stage 41), so `?.` never sees `undefined`.
    fn.params.length > 0 && fn.params[0]!.name === "this" && ((fn.setter ?? false) || (fn.untrackThis ?? false) || mutable.classes.has(fn.name.split(".")[0]!));

  /**
   * The subset of `untrackedThis` where `this` is still the CALLER'S OBJECT: a member of a
   * `@@mutable` class. The other two arms are deliberately excluded, because in both of
   * them the receiver really is this frame's own value and there is nothing to escape:
   *   - a copy-on-write SETTER on an ordinary class works on a private fresh copy;
   *   - `untrackThis` marks a DECORATED CONSTRUCTOR, whose only consuming use of `this` is
   *     the `return this` the parser itself synthesized (parser.ts) — already exempt.
   */
  const borrowedThis = (fn: FuncDecl): boolean =>
    fn.params.length > 0 && fn.params[0]!.name === "this" && mutable.classes.has(fn.name.split(".")[0]!);

  // The per-parameter `@@mutable` opt-in, as a call-site table: which argument positions
  // of which function the callee may `.push` to. Built over every FuncDecl (methods are
  // lowered to dotted names by now), so a method's marked parameter is covered by the
  // same two rules a plain function's is.
  const mutableArgs = new Map<string, Set<number>>();
  const mutableArgProps = new Map<string, Set<number>>();
  const collectMutableArgs = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      if (s.kind !== "FuncDecl") continue;
      const idx = new Set<number>();
      s.params.forEach((p, i) => { if (p.mutable) idx.add(i); });
      if (idx.size) {
        mutableArgs.set(s.name, idx);
        // A lowered METHOD is `C.m` with an implicit `this` at index 0, while its call
        // site writes `o.m(a)` with no receiver argument — so the property-keyed table
        // shifts by one. Merged rather than overwritten: the key is a bare name, so two
        // classes may contribute to it.
        const dot = s.name.lastIndexOf(".");
        if (dot >= 0) {
          const shift = s.params[0]?.name === "this" ? 1 : 0;
          const prop = s.name.slice(dot + 1);
          const set = mutableArgProps.get(prop) ?? new Set<number>();
          for (const i of idx) set.add(i - shift);
          mutableArgProps.set(prop, set);
        }
      }
      collectMutableArgs(s.body);
    }
  };
  collectMutableArgs(checked.program.body);

  const runScope = (body: Stmt[], params: { name: string; ty: Ty }[], untrack: Set<string> = new Set(), mutableNames: Set<string> = new Set(), borrowThis: boolean = false): string[] => {
    const aliases = new Map<string, string>();
    // Receivers whose FIELDS this scope may only borrow: a linear parameter (the caller
    // owns and drops it) and a method's `this`. `this` is unconditional — it names no
    // binding in `params`, and it is a borrow in every member body.
    const borrowRoots = new Set<string>(["this", ...params.filter((p) => isLinearTy(p.ty)).map((p) => p.name)]);
    collectAliases(body, isMutableTy, aliases, borrowRoots); // ALWAYS: the retains-receiver rule is not `@@mutable`-specific
    let varTy = new Map<string, Ty>();
    if (mutable.classes.size) {
      for (const p of params) varTy = varTy.set(p.name, p.ty);
      collectVarTys(body, varTy);
    }
    let linear = new Set<string>();
    for (const p of params) if (isLinearTy(p.ty)) linear = linear.add(p.name);
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
    scan.mutableArgs = mutableArgs;
    scan.mutableArgProps = mutableArgProps;
    scan.mutableParams = mutableNames;
    scan.borrowThis = borrowThis;
    scan.seq(body, entry());
    const a = new Analyzer(linear, topLevel, paramBorrows, scan.arrowNames, mutable, varTy, aliases, consuming);
    a.envCaptured = scan.envArrowNames; // the subset whose capture really is an env
    a.topClosures = topClosures;
    a.shadowed = shadowed;
    a.mutableArgs = mutableArgs;
    a.mutableArgProps = mutableArgProps;
    a.mutableParams = mutableNames;
    a.borrowThis = borrowThis;
    const st = entry();
    a.seq(body, st);
    const end = [...a.ownedTopLevel(st), ...topClosures]; // computed BEFORE marking: it can add to condDrops
    // Drop flags: a name that is dropped on a path where it MIGHT already have been
    // moved needs its move sites to null the slot, so the drop is a no-op there.
    //
    // The tag test is not a filter — EVERY move site is an `Identifier` by construction
    // (`sites.add(e)` runs only inside `expr`'s `case "Identifier"`, and codegen reads the
    // flag back off an `Identifier` too). It is there because the store needs a slot, and
    // the cast this replaced,
    //
    //     (site as { nullOnMove?: boolean }).nullOnMove = true;
    //
    // named slot 0. `nullOnMove` is slot 4 of `Identifier`; slot 0 is `kind`. Dynamic
    // under `bun`, and compiled it would have overwritten the discriminant of every
    // conditionally-dropped move site with `true` — on ordinary correct programs, not
    // just exotic ones. Narrowing costs a tag compare that is already proven.
    for (const n of a.condDrops) for (const site of a.moveSites.get(n) ?? []) if (site.kind === "Identifier") site.nullOnMove = true;
    diags.push(...a.diags);
    return end;
  };

  checked.program.endDrops = runScope(checked.program.body, []);
  for (const s of checked.program.body) {
    if (s.kind === "FuncDecl") {
      const sig = checked.functions.get(s.name)!;
      s.endDrops = runScope(
        s.body,
        s.params.map((p, i) => ({ name: p.name, ty: sig.params[i]! })),
        untrackedThis(s) ? new Set(["this"]) : new Set(),
        new Set(s.params.filter((p) => p.mutable).map((p) => p.name)),
        borrowedThis(s),
      );
    }
  }
  return diags;
}
