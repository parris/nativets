/*
 * Lower a checked program to LLVM IR text (LLVM 21, opaque pointers).
 *
 * Value model:  number -> double,  boolean -> i1,  string -> ptr (NUL-term utf8)
 *
 * Control flow builds a real CFG: each function has an implicit `entry` block
 * holding all allocas, then a chain of labelled blocks. Invariant: at any time
 * only the *current* block may be unterminated; every construct brs its
 * sub-blocks to a continuation before moving on, so the final default terminator
 * only ever patches the current block.
 */

import type { CheckedProgram, Sig } from "./checker.ts";
import { consoleMethod, CONSOLE_STREAMS, planConsoleFormat, spawnMode, SPAWN_INHERIT_TY, type FmtSpec } from "./checker.ts";
// `blockDrops` is gone: the drop set is a synthesized trailing BlockDrops STATEMENT now,
// not an expando read back off the array, so codegen reads it in the normal statement loop.
// `Program` stays — it is still used below, and the lane's branch predated its arrival.
import { freshArray, RETAINS_RECEIVER, arrayElements, stringLiteralValue } from "./ast.ts";
import { makeArrayTy } from "./ast.ts";
import type { Stmt, Expr, Ty, FuncDecl, VarDecl, Loc, Program } from "./ast.ts";
import { NUMBER_CONSTS, MATH_CONSTS } from "./checker.ts";
import { isGeneralUnionTy, generalUnionMembers, generalUnionTagOf, staticTypeofName } from "./ast.ts";
import { isTypeRefTy, unfoldTypeRef, recTypeTable } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectFields, fieldIndex, fieldType, isFuncTy, funcParams, funcRet, makeFuncTy, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, mapKeyTy, mapValTy, setElemTy, classTag, isBytesTy, isBytesRefTy, isTextEncoderTy, isTextDecoderTy, isResponseTy, isHeadersTy, isFetchRefTy } from "./ast.ts";
// stdlib Batch 3 (the object-shaped web APIs): Date / URL / URLSearchParams.
import { isDateTy, isUrlTy, isSearchParamsTy, isUrlRefTy, DATE_GETTERS } from "./ast.ts";
// SH2 (discriminated unions): a union value IS its member's object block, so every
// lowering below treats it exactly like an object pointer.
import { isUnionTy, unionCommonField, widenLiteralTys } from "./ast.ts";
// `expr as T` needs the union's tag values and their slot index to CHECK an assertion
// rather than trust it (see `genAsCast`).
import { unionDiscriminant, unionTagValues, unionWidenedMembers, objectLayoutFits } from "./ast.ts";
import { exprLoc } from "./ast.ts";
import { isOptChainExpr, isStructMsgTy } from "./checker.ts";
import type { ArrowFunction, AssignExpr, ThrowStmt } from "./ast.ts";
import { nyi, NYI, internalError, NTError } from "./diagnostics.ts";

export function llvmDouble(n: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, n, false);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += dv.getUint8(i).toString(16).padStart(2, "0");
  return "0x" + hex.toUpperCase();
}

/** node's `util.inspect` defaults as console.log uses them (lib/internal/util/inspect.js):
 *  a compound deeper than `depth` renders as `[Object]`/`[Array]`, and an array shows at
 *  most `maxArrayLength` entries followed by `... n more items`. `breakLength` (80) and
 *  `compact` (3) live in the runtime builder, which is where widths are known. */
const INSPECT_DEPTH = 2;
const INSPECT_MAXARR = 100;

const ACTOR_BUILTINS = new Set([
  "spawn", "send", "receive", "self", "__drain",
  // v2 links/monitors/trap + fault injection; v3 supervision + registry
  "register", "whereis", "link", "monitor", "trapExit", "exit", "__crash", "__kill", "supervise",
  // v4 selective receive
  "receiveMatch",
  // v6 M:N scheduler introspection (debug)
  "__schedulers", "__schedUsed", "__schedSteals",
]);

/** B3 v4/v5 message kind tag (must match NT_MSG_NUM/STR/STRUCT in runtime/nt_actor.h).
 *  Sent alongside every message so a receive compiled for one type can never
 *  reinterpret another's bits — a mismatch is a runtime error, not a miscompile.
 *  A STRUCTURED message additionally carries its shape (see `msgShape`), because the
 *  coarse kind alone cannot tell two different record types apart. */
/** ` at line:col` for a node that carries its position, else "" — so a refusal names WHICH
 *  construct it means, following the `at 12:3` convention the parser's NYI messages use. */
function where(n: { line?: number; col?: number }): string {
  return n.line === undefined ? "" : ` at ${n.line}:${n.col ?? 0}`;
}

function msgKind(ty: Ty): number {
  const b = baseTy(ty);
  return b === "string" ? 1 : isStructMsgTy(b) ? 2 : 0;
}
/** The shape tag that travels with a structured message: the compiler's canonical type
 *  encoding, which IS structural identity here (two types are the same iff equal). */
function msgShape(ty: Ty): string { return baseTy(ty); }

/** Does the program call any actor builtin? (Drives the nt_sched_init prologue in
 *  @main.) A structural walk over the plain-object AST — order/shape-agnostic. */
function scanUsesActors(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "CallExpr") {
    const callee = n.callee as Record<string, unknown> | undefined;
    if (callee?.kind === "Identifier" && ACTOR_BUILTINS.has(callee.name as string)) return true;
  }
  for (const k in n) if (scanUsesActors(n[k])) return true;
  return false;
}

/* ============================================================================
 * CROSS-FRAME `throw` — which functions may let one LEAVE their frame.
 *
 * A `throw` is lowered as a BRANCH to the enclosing `try`'s catch block, so it has
 * always had to sit inside a `try` in the SAME function (NT1004). The runtime's
 * pending-exception protocol already carries a raise across a frame boundary — that is
 * how a failing `JSON.parse` reaches a `catch` — and nothing about it is specific to the
 * runtime being the raiser. So an escaping `throw` raises on the SAME flag and returns
 * the default value; the caller checks the flag after the call, exactly as it already
 * does after a fallible host call (`emitExcCheck`).
 *
 * WHAT MAKES THAT SOUND IS A REFUSAL, NOT A CLEVERNESS. A set flag that no call site
 * checks is a SILENT WRONG ANSWER — the frame returns a zeroed default and the program
 * carries on — which is the one outcome this compiler will not produce. So propagation
 * is allowed for a function only when every way of reaching it has been PROVED to check:
 *
 *   1. every call site is a DIRECT call this scan can see, and each one sits inside a
 *      `try` WITH a `catch` in its own frame (or is in `main`, whose uncaught arm is
 *      node's own behaviour — stderr and exit 1);
 *   2. the name is never used as a VALUE, so no closure or function-value call can reach
 *      it without a check (a lifted arrow is a frame this scan cannot see into);
 *   3. the thrown type is one the slot can actually carry (a `string`, or ANY object —
 *      see `raisableTy`) and every covering `catch` binds exactly that type — the binding
 *      is not `any` here, and reconstructing a DIFFERENT shape into it is the raw-store
 *      bug `ThrowStmt` already refuses in-frame. This rule is also what lets the catch
 *      site know WHICH mechanism carried the payload without asking the runtime: an
 *      object-typed binding at an escaping call site is an object on the slot, always;
 *   4. no `throw` anywhere in the function is inside an arrow body, and the program uses
 *      no actors — an inlined arrow's `throw` really does run in this frame while a
 *      lifted one does not, and an actor handler is called by the scheduler, from no
 *      call site this scan can see.
 *
 * ONE FRAME, therefore, and by construction: rule 1 means an escaping callee's raise is
 * always consumed by its immediate caller, so no intermediate frame ever has to
 * propagate and the "escapes" set never grows transitively. A deeper chain keeps NT1004.
 * ========================================================================== */

/** The type a raise can carry across a frame, or the empty string if it cannot. Two answers
 *  now, and they are carried by two DIFFERENT mechanisms:
 *
 *    `string`  — the runtime's `const char *` message slot, refcounted, COPIED by reference.
 *    an object — the object BLOCK POINTER, MOVED onto the slot (`nt_exc_raise_obj`) and
 *                taken back off it by the catch (`nt_exc_take_object`).
 *
 *  The object answer has no shape condition at all, and that is the whole point of the move:
 *  nothing is reconstructed, so no field of the payload has to be representable in the slot.
 *  The rule this replaced admitted exactly one object shape — the single `{message:string}`
 *  that `emitExcCheck` could rebuild by BOXING the message — and a previous lane measured
 *  what widening that by flattening would buy on the linked stage-1 tree: 20 of 129 seed
 *  functions for N flat scalar fields, and 20 for a deep recursive flatten, i.e. literally
 *  nothing over flat, because `NTError.diag` carries an optional ARRAY no flattening
 *  carries. Moving the pointer clears 82. Hence the pointer.
 *
 *  The result is a `string` rather than a `Ty` so the empty string can be the "cannot"
 *  answer — unambiguous, since `Ty` has no empty spelling (which is also why tsc rejects
 *  `""` as one). */
function raisableTy(t: Ty | undefined): string {
  if (t === undefined) return "";
  const b: Ty = t;
  if (b === "string") return "string";
  return isObjectTy(b) ? b : "";
}

/** Uncovered `throw`s in ONE frame. `out` collects the raisable type of each throw that
 *  no local `catch` covers; `bad` is set by anything that disqualifies the whole
 *  function — a throw inside an arrow (a frame this walk is not describing), or a thrown
 *  value the flag cannot carry. */
function frameThrows(node: unknown, covered: boolean, inArrow: boolean, out: (t: string) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) frameThrows(x, covered, inArrow, out); return; }
  const n = node as Record<string, unknown>;
  if (n.kind === "ThrowStmt") {
    const arg = n.argument as Expr;
    if (inArrow) out(""); // an arrow's throw is not this frame's `ret` to take
    else if (!covered) out(raisableTy(arg.ty));
    frameThrows(n.argument, covered, inArrow, out);
    return;
  }
  if (n.kind === "TryStmt") {
    // A `finally` does not HANDLE, so a catch-less `try` does not cover its block.
    frameThrows(n.block, !!n.handler || covered, inArrow, out);
    if (n.handler) frameThrows(n.handler, covered, inArrow, out);
    if (n.finalizer) frameThrows(n.finalizer, covered, inArrow, out);
    return;
  }
  if (n.kind === "ArrowFunction") { for (const k in n) frameThrows(n[k], covered, true, out); return; }
  if (n.kind === "FuncDecl") return; // a nested declaration is its own frame
  for (const k in n) if (k !== "ty") frameThrows(n[k], covered, inArrow, out);
}

/** Every mention of a function NAME in the program, split into call sites (with the
 *  binding type of the innermost `catch` covering them, `null` if none) and value uses.
 *  `nameOf` maps a callee expression to the linked function names it may reach — by
 *  PROPERTY name for a method call, which over-approximates, and over-approximating call
 *  sites can only disqualify more. */
function scanUses(
  node: unknown, covered: Ty | null, inArrow: boolean,
  onCall: (names: string[], covered: Ty | null, inArrow: boolean) => void,
  onValue: (name: string) => void,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) scanUses(x, covered, inArrow, onCall, onValue); return; }
  const n = node as Record<string, unknown>;
  if (n.kind === "TryStmt") {
    // Defaulted the way `TryStmt` lowering defaults it; `null` (does not cover) for a
    // `try` with no `catch`, whose `finally` does not handle.
    const inner: Ty | null = n.handler ? ((n.catchTy as Ty | undefined) ?? "string") : null;
    scanUses(n.block, inner ?? covered, inArrow, onCall, onValue);
    if (n.handler) scanUses(n.handler, covered, inArrow, onCall, onValue);
    if (n.finalizer) scanUses(n.finalizer, covered, inArrow, onCall, onValue);
    return;
  }
  // A nested `function` declaration and an arrow BODY are each a frame of their own, so
  // an enclosing `try` does not cover their calls. The arrow is stricter than that: a
  // LIFTED arrow is an LLVM function this scan is not describing, so a call to an
  // escaping function from inside one is treated as uncovered whatever encloses it.
  if (n.kind === "FuncDecl") { scanUses(n.body, null, inArrow, onCall, onValue); return; }
  if (n.kind === "ArrowFunction") { for (const k in n) scanUses(n[k], null, true, onCall, onValue); return; }
  if (n.kind === "CallExpr") {
    const callee = n.callee as Record<string, unknown>;
    if (callee.kind === "Identifier") onCall([callee.name as string], inArrow ? null : covered, inArrow);
    else if (callee.kind === "MemberExpr") {
      onCall([`.${callee.property as string}`], inArrow ? null : covered, inArrow);
      scanUses(callee.object, covered, inArrow, onCall, onValue); // the RECEIVER is a value use
    } else scanUses(n.callee, covered, inArrow, onCall, onValue);
    scanUses(n.args, covered, inArrow, onCall, onValue);
    return;
  }
  if (n.kind === "Identifier") { onValue(n.name as string); return; }
  if (n.kind === "MemberExpr") { onValue(`.${n.property as string}`); scanUses(n.object, covered, inArrow, onCall, onValue); return; }
  for (const k in n) if (k !== "ty") scanUses(n[k], covered, inArrow, onCall, onValue);
}

/**
 * The proved-escaping set. See the block comment above for the four rules; every one of
 * them is a way to LEAVE the set, so the empty answer is always the safe one and a
 * program this scan cannot reason about compiles exactly as it did before.
 *
 * PARALLEL ARRAYS, not a `Map` keyed by name, and that is a subset obligation rather than
 * a style choice. The first cut accumulated into a `Set` from inside the `scanUses`
 * callbacks -- and `Set.add` MUTATES under bun while it is PERSISTENT in the language this
 * compiler implements, so every disqualification the callbacks recorded would be silently
 * discarded once this compiler compiles itself. Not a refusal: a scan that answers "every
 * caller checks" about functions whose callers do not. `.push` on a `//@@mutable` array is
 * the one accumulator that means the same thing under both.
 */
function scanEscaping(program: Program, usesActors: boolean): Set<string> {
  if (usesActors) return new Set<string>(); // rule 4: the scheduler is a caller we cannot see

  // ---- seed: a function whose own `throw` no local `catch` covers, paired with the one
  // carriable type all of its uncovered throws agree on. `frameThrows` reports `""` for a
  // throw that disqualifies the frame outright (one inside an arrow, or a value the flag
  // cannot carry).
  //@@mutable
  const names: string[] = [];
  //@@mutable
  const tys: string[] = [];
  for (const s of program.body) {
    if (s.kind !== "FuncDecl") continue;
    //@@mutable
    const seen: string[] = [];
    frameThrows(s.body, false, false, (t: string) => { seen.push(t); });
    if (seen.length === 0) continue;
    const first = seen[0]!;
    if (first === "" || seen.some((t) => t !== first)) continue; // rules 3+4
    names.push(s.name);
    tys.push(first);
  }
  if (names.length === 0) return new Set<string>();

  // ---- every mention of a name, recorded verbatim and judged afterwards. `where` is the
  // frame the mention sits in: `main`'s own body, some other function's, or an arrow's
  // (a frame this scan is not describing, so it never counts as covered).
  //@@mutable
  const callKey: string[] = [];
  //@@mutable
  const callCov: string[] = []; // "" = no `catch` covers this call site
  //@@mutable
  const callWhere: string[] = [];
  //@@mutable
  const valueUse: string[] = [];
  const visit = (body: Stmt[], isMain: boolean): void => {
    scanUses(body, null, false,
      (keys: string[], cov: Ty | null, inArrow: boolean) => {
        for (const k of keys) {
          callKey.push(k);
          callCov.push(cov ?? "");
          callWhere.push(inArrow ? "arrow" : (isMain ? "main" : "frame"));
        }
      },
      (n: string) => { valueUse.push(n); },
    );
  };
  visit(program.body.filter((s) => s.kind !== "FuncDecl"), true);
  for (const s of program.body) if (s.kind === "FuncDecl") visit(s.body, false);

  // ---- judge. `dead[i]` is "seed function i is NOT provably escaping".
  //@@mutable
  const dead: boolean[] = names.map((_n) => false);
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    // A method is a top-level `Class.m` whose call sites name only `m`, so it answers to
    // the `.m` key too -- resolved by PROPERTY, which over-approximates, and
    // over-approximating a function's call sites can only disqualify more.
    const dot = name.lastIndexOf(".");
    const alt = dot < 0 ? "" : `.${name.slice(dot + 1)}`;
    for (const u of valueUse) if (u === name || (alt !== "" && u === alt)) dead[i] = true; // rule 2
    for (let c = 0; c < callKey.length; c++) {
      const k = callKey[c]!;
      if (k !== name && (alt === "" || k !== alt)) continue;
      // Uncovered: in `main` that IS node's uncaught exception, which `emitExcCheck`'s
      // null-handler arm already renders (stderr, exit 1). Anywhere else it would have to
      // propagate a SECOND frame, which is the case this lane does not implement.
      if (callCov[c]! === "") { if (callWhere[c]! !== "main") dead[i] = true; continue; }
      if (callCov[c]! !== tys[i]!) dead[i] = true; // rule 3: the binding takes ONE type
    }
  }

  // REBOUND, not `.add`-and-discard: a nativets `Set` is persistent, so the discarded
  // spelling adds nothing there while bun's mutating `Set.add` makes it look right —
  // the same divergence `Checker.statics` already records in src/checker.ts.
  //@@mutable
  let out = new Set<string>();
  for (let i = 0; i < names.length; i++) if (!dead[i]!) out = out.add(names[i]!);
  return out;
}

/** Does the program contain a `try` ANYWHERE — including inside an arrow body, a class
 *  method or a function that is never called? (Same structural walk as scanUsesActors,
 *  and deliberately over-approximate: it decides whether an uncaught `throw` could
 *  reach a handler after any number of frames, so a miss would be a wrong answer while
 *  a false hit is only a refusal.) */
function scanHasTry(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "TryStmt") return true;
  for (const k in n) if (scanHasTry(n[k])) return true;
  return false;
}

/** Does this expression mention `name` anywhere? (Structural walk, same shape as
 *  scanUsesActors.) Guards the consuming-append transient: `x = [...x, ...x]` must
 *  NOT hand the first spread ownership of storage the second one still reads. */
function mentions(node: unknown, name: string): boolean {
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "Identifier" && n.name === name) return true;
  for (const k in n) if (k !== "ty" && mentions(n[k], name)) return true;
  return false;
}

/* `freshArray`/`FRESH_ARRAY_CALLS` and `RETAINS_RECEIVER` all live in ast.ts — the
 * checker and the ownership pass need the same judgments, and copies could drift. */

/**
 * Which `nt_arr_join_*` an element type takes. THREE-way, and one function rather than
 * a ternary at each call site: the split used to be `el === "number" ? num : str`, which
 * sent a `boolean[]` — whose slots hold `zext i1`, i.e. the integers 0 and 1 — into
 * `nt_arr_join_str`, where `strlen((char *)1)` killed the process with no diagnostic.
 * A two-way choice written twice is exactly how the third case gets missed twice, so
 * the callers (`.join`, and `coerceToString` for node's `Array#toString`) share this.
 *
 * `checkStringCoercion` in checker.ts is the allow-list that must stay in step with the
 * element types named here; anything else is still refused (NT1032) rather than joined.
 */
function joinFn(el: Ty): string {
  if (el === "number") return "nt_arr_join_num";
  if (el === "boolean") return "nt_arr_join_bool";
  return "nt_arr_join_str";
}

function llvmTy(ty: Ty): string {
  // A nominal recursive reference IS the object block it names — a pointer, like every
  // other heap value. Placed with the other `ptr` arms rather than left to the `default`,
  // which answers `i8`: a `@N` truncated to one byte at every parameter, return and alloca
  // is pointer corruption with no diagnostic.
  if (isTypeRefTy(ty)) return "ptr";
  if (isUnionTy(ty)) return "ptr"; // SH2: the member object block itself — there is no box
  if (isGeneralUnionTy(ty)) return "ptr"; // a general union IS a box: [tag, value], tag = member index
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || (isBytesRefTy(ty) || isFetchRefTy(ty)) || isUrlRefTy(ty)) return "ptr"; // nullable = ptr to [tag,val]; Map/Set = NtMap*; Uint8Array = NtBytes*; URL/URLSearchParams = the URL/query TEXT
  switch (ty) {
    case "Date": return "double"; // stdlib batch 3: a Date IS its time value (epoch ms)
    case "number": return "double";
    case "boolean": return "i1";
    case "string": return "ptr";
    case "Dyn": return "ptr"; // heap-boxed tagged value from JSON.parse
    case "void": return "void";
    default: return "i8"; // undefined | null — unit value; the static type carries meaning
  }
}

/**
 * LLVM symbol for a user function. `main` is the C entry point this module emits
 * itself, so a user function of that name — the idiomatic `async function main() { … }
 * main();` entrypoint — is renamed instead of colliding ("invalid redefinition of
 * function 'main'"). Purely a symbol-level rename; the TS-level name is unchanged.
 */
function userSym(name: string): string { return name === "main" ? "nt_user_main" : name; }

function defaultZero(ty: Ty): string {
  if (isTypeRefTy(ty) || isUnionTy(ty) || isGeneralUnionTy(ty)) return "null";
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || (isBytesRefTy(ty) || isFetchRefTy(ty))) return "null";
  switch (ty) {
    case "number": return "0x0000000000000000";
    case "boolean": return "false";
    case "string": return "null";
    case "void": return "";
    default: return "0"; // undefined | null
  }
}

const POS_INF = "0x7FF0000000000000";
const NAN_HEX = "0x7FF8000000000000"; // stdlib fills: "argument omitted" sentinel for optional numeric args

function encodeCString(s: string): { body: string; len: number } {
  const bytes = new TextEncoder().encode(s);
  let body = "";
  for (const b of bytes) {
    if (b === 0x22) body += "\\22";
    else if (b === 0x5c) body += "\\5C";
    else if (b >= 0x20 && b < 0x7f) body += String.fromCharCode(b);
    else body += "\\" + b.toString(16).padStart(2, "0").toUpperCase();
  }
  return { body: body + "\\00", len: bytes.length + 1 };
}

/**
 * ASAN INSTRUMENTATION OF THE GENERATED CODE — off unless `NATIVETS_ASAN=1`.
 *
 * Building with `clang -fsanitize=address` instruments the C in `runtime/`, and NOTHING
 * ELSE. AddressSanitizer is an LLVM *pass* that only rewrites functions carrying the
 * `sanitize_address` attribute; clang stamps that attribute on the code IT compiles from
 * source, but a hand-written `.ll` fed to the same driver arrives without it, so every
 * load and store nativets emits is left bare.
 *
 * The consequence is precisely inverted from what the ASan lane is for:
 *  - a DOUBLE FREE is still caught, because that is detected inside `free()` — an
 *    allocator interceptor in the ASan runtime, which does not care who called it;
 *  - a HEAP-USE-AFTER-FREE **is not**, because catching it requires a poison check on
 *    the READ, and the read is in uninstrumented generated code.
 *
 * A use-after-free read that returns stale memory at exit 0 is the exact "silent wrong
 * answer" class the prime directive names as the worst outcome available, and it was the
 * one thing the gate could not see. Measured on
 * `{ const xs: B[] = [o.inner]; }  return t + o.inner.v;` with an element-freeing drop:
 * node says 10, we said 5, exit 0, ASan "clean" — and with this attribute set, the same
 * binary reports `heap-use-after-free` and exits 134. See test/asan-instrumentation.test.ts.
 *
 * Kept behind an env var rather than emitted always so that IR snapshots and the byte
 * -identical-output guarantees elsewhere in this file do not move; the attribute is inert
 * without `-fsanitize=address`, so turning it on costs nothing but the diff.
 *
 * An attribute-group id is a NUMBER in LLVM IR (`#0`), never a name — `#asan` is a parse
 * error. 99 is used rather than 0 to stay clear of any group a later lane introduces.
 *
 * Read LAZILY, not captured into a module-level const: the flag has to be flippable
 * inside one test process (test/asan-instrumentation.test.ts emits both ways).
 */
// `process.env.NAME`, not `process.env["NAME"]`: the self-host subset recognizes the
// MemberExpr spelling only (src/checker.ts, "Host I/O"), and src/ must stay inside the
// subset it compiles. Same spelling as driver.ts's `process.env.WASI_SDK_PATH`.
export function asanOn(): boolean { return process.env.NATIVETS_ASAN === "1"; }
function asanFnAttr(): string { return asanOn() ? " #99" : ""; }
const ASAN_ATTR_DEF = "attributes #99 = { sanitize_address }";

const DECLARES = [
  "declare void @js_print_num(double)",
  "declare void @js_print_bool(i32)",
  "declare void @js_print_str(ptr)",
  "declare void @js_print_sep()",
  "declare void @js_print_newline()",
  // Stage 49: `console.error`/`console.warn` write to STDERR. Separate entry points
  // rather than a mode flag on the printer — a preempted actor must never be able to
  // redirect another actor's half-written line — and `begin` flushes stdout first so
  // the two streams stay in order when they are merged.
  "declare void @js_eprint_begin()",
  "declare void @js_eprint_num(double)",
  "declare void @js_eprint_bool(i32)",
  "declare void @js_eprint_str(ptr)",
  "declare void @js_eprint_sep()",
  "declare void @js_eprint_newline()",
  "declare void @nt_fmt_guard(ptr, double)",
  "declare double @js_pow(double, double)",
  "declare ptr @js_str_concat(ptr, ptr)",
  "declare double @js_str_len(ptr)",
  "declare i32 @js_str_eq(ptr, ptr)",
  "declare i32 @js_str_cmp(ptr, ptr)",
  "declare ptr @js_num_to_str(double)",
  "declare ptr @js_bool_to_str(i32)",
  // bitwise
  "declare double @js_bit_and(double, double)",
  "declare double @js_bit_or(double, double)",
  "declare double @js_bit_xor(double, double)",
  "declare double @js_bit_not(double)",
  "declare double @js_shl(double, double)",
  "declare double @js_shr(double, double)",
  "declare double @js_ushr(double, double)",
  // coercion / parsing / math
  "declare double @js_str_to_num(ptr)",
  "declare double @js_math_round(double)",
  "declare double @js_parse_int(ptr, double)",
  "declare double @js_parse_float(ptr)",
  "declare double @floor(double)",
  "declare double @ceil(double)",
  "declare double @sqrt(double)",
  "declare double @trunc(double)",
  "declare double @fabs(double)",
  "declare double @js_math_max(double, double)",
  "declare double @js_math_min(double, double)",
  "declare double @js_math_fold_arr(ptr, double, i32)",
  // string methods
  "declare ptr @js_str_upper(ptr)",
  "declare ptr @js_str_lower(ptr)",
  "declare ptr @js_str_trim(ptr)",
  "declare ptr @js_str_trim_end(ptr)",
  "declare ptr @js_str_trim_start(ptr)",
  "declare ptr @js_str_char_at(ptr, double)",
  "declare ptr @js_str_slice(ptr, double, double)",
  "declare ptr @js_str_substring(ptr, double, double)",
  "declare ptr @js_str_repeat(ptr, double)",
  "declare ptr @js_str_pad_start(ptr, double, ptr)",
  "declare i32 @js_str_includes(ptr, ptr)",
  "declare double @js_str_index_of(ptr, ptr)",
  "declare double @js_str_index_of_from(ptr, ptr, double)",
  // string reference counting (value-semantics strings; rc side-table in the runtime)
  "declare ptr @nt_str_retain(ptr)",
  "declare void @nt_str_release(ptr)",
  "declare double @nt_str_live()",
  // arrays
  "declare ptr @nt_arr_new(double)",
  "declare double @nt_arr_push(ptr, i64)",
  "declare i64 @nt_arr_get(ptr, double)",
  "declare i64 @nt_arr_hof_at(ptr, double, ptr, ptr)",
  // Bounds-PANIC accessors — used only where the programmer wrote the index (the
  // extra `ptr` is the interned "file:line:col" the panic reports).
  "declare i64 @nt_arr_index(ptr, double, ptr)",
  // `expr!` — unwrap the A2 tagged pair, PANIC when the assertion is false (Stage 41 shape)
  "declare i64 @nt_nonnull(ptr, ptr)",
  "declare i64 @nt_union_arm(ptr, double, ptr, ptr)",
  // `expr as T` — the CHECKED type assertion. `nt_as_tag` tests a discriminated union's
  // in-value tag field; `nt_as_unbox` tests a `G<…>` / nullable BOX and unwraps it.
  "declare void @nt_as_tag(ptr, double, ptr, ptr, ptr)",
  "declare i64 @nt_as_unbox(ptr, double, ptr, ptr)",
  "declare ptr @nt_str_index(ptr, double, ptr)",
  "declare void @nt_panic_bounds(ptr, double, double, ptr)",
  "declare i64 @nt_arr_pop(ptr)",
  "declare double @nt_arr_len(ptr)",
  "declare ptr @nt_arr_join_num(ptr, ptr)",
  "declare ptr @nt_arr_join_str(ptr, ptr)",
  "declare ptr @nt_arr_join_bool(ptr, ptr)",
  "declare i32 @nt_arr_includes_num(ptr, double)",
  "declare i32 @nt_arr_includes_str(ptr, ptr)",
  "declare double @nt_arr_indexof_num(ptr, double, double)",
  "declare double @nt_arr_indexof_str(ptr, ptr, double)",
  "declare ptr @nt_arr_copy(ptr)",
  // ordering primitives (ES2023 copying methods): default sort by string form,
  // comparator sort through a codegen-emitted closure shim, and reverse-copy.
  "declare ptr @nt_arr_to_sorted(ptr, i32)",
  "declare ptr @nt_arr_to_sorted_by(ptr, ptr, ptr)",
  "declare ptr @nt_arr_to_reversed(ptr)",
  "declare ptr @nt_arr_with(ptr, double, i64, ptr)",
  "declare void @nt_arr_free(ptr)",
  "declare double @nt_arr_live()",
  // structural-sharing witnesses (B2 step 2): live / cumulative persistent-vector nodes
  "declare double @nt_arr_nodes()",
  "declare double @nt_arr_node_allocs()",
  "declare double @nt_arr_transients()",
  "declare void @nt_arr_extend_own(ptr, ptr)",
  "declare ptr @nt_obj_new(double)",
  "declare void @nt_obj_free(ptr)",
  "declare double @nt_obj_live()",
  "declare ptr @nt_str_split(ptr, ptr)",
  "declare ptr @nt_arr_reverse(ptr)",
  // --- stdlib (web standards) Batch 1: Date/base64/fromCharCode/Number/Array.from ---
  "declare double @nt_date_now()",
  "declare ptr @nt_btoa(ptr)",
  "declare ptr @nt_atob(ptr)",
  "declare ptr @nt_from_char_code(double)",
  "declare ptr @nt_from_code_point(double)",
  "declare i32 @nt_num_is_finite(double)",
  "declare i32 @nt_num_is_integer(double)",
  "declare i32 @nt_num_is_safe_integer(double)",
  "declare ptr @nt_arr_from_str(ptr)",
  // --- stdlib (web standards) Batch 1 PART 2: string/array/number fills ---
  "declare double @js_str_char_code_at(ptr, double)",
  "declare double @js_str_code_point_at(ptr, double)",
  "declare ptr @js_str_at(ptr, double)",
  "declare ptr @js_str_pad_end(ptr, double, ptr)",
  "declare i32 @js_str_starts_with(ptr, ptr, double)",
  "declare i32 @js_str_ends_with(ptr, ptr, double)",
  "declare ptr @js_str_replace(ptr, ptr, ptr, i32)",
  "declare double @js_str_last_index_of(ptr, ptr, double)",
  "declare ptr @nt_str_split_n(ptr, ptr, double)",
  "declare double @nt_arr_at_index(ptr, double)",
  "declare double @nt_arr_last_indexof_num(ptr, double, double)",
  "declare double @nt_arr_last_indexof_str(ptr, ptr, double)",
  "declare ptr @nt_arr_concat(ptr, ptr)",
  "declare ptr @nt_arr_flat1(ptr)",
  "declare ptr @js_num_to_fixed(double, double)",
  "declare ptr @js_num_to_radix_string(double, double)",
  // --- stdlib: URL component parsing (the runtime behind `new URL(u)`) ---
  "declare ptr @nt_url_protocol(ptr)",
  "declare ptr @nt_url_host(ptr)",
  "declare ptr @nt_url_hostname(ptr)",
  "declare ptr @nt_url_pathname(ptr)",
  "declare ptr @nt_url_search(ptr)",
  "declare ptr @nt_url_hash(ptr)",
  // --- stdlib Batch 3: Date components + URL components + URI encoding ---
  "declare double @nt_date_field(double, double, double)",
  "declare ptr @nt_date_to_iso(double)",
  "declare double @nt_date_from_ms(double)",
  "declare double @nt_date_parse(ptr)",
  "declare ptr @nt_date_inspect(double)",
  "declare ptr @nt_date_to_json(double)",
  "declare ptr @nt_url_validate(ptr)",
  "declare ptr @nt_url_port(ptr)",
  "declare ptr @nt_url_origin(ptr)",
  "declare ptr @nt_qs_init(ptr)",
  "declare ptr @nt_qs_get(ptr, ptr)",
  "declare ptr @nt_qs_get_all(ptr, ptr)",
  "declare ptr @nt_qs_to_string(ptr)",
  "declare ptr @nt_encode_uri_component(ptr)",
  "declare ptr @nt_decode_uri_component(ptr)",
  "declare ptr @nt_encode_uri(ptr)",
  "declare ptr @nt_decode_uri(ptr)",
  // Networking tier (L-d): libcurl-backed HTTP(S) client (host/Linux only; conditionally linked).
  // Return the response body (rc-string); write the numeric status through the trailing double*.
  "declare ptr @nt_http_post(ptr, ptr, ptr, ptr)",
  "declare ptr @nt_http_get(ptr, ptr, ptr)",
  // `fetch` (web standard) — blocking; fills the Response block's status + raw-header
  // slots through the two trailing out-pointers and returns the body (rc-string).
  "declare ptr @nt_fetch(ptr, ptr, ptr, ptr, ptr, ptr)",
  "declare ptr @nt_headers_get(ptr, ptr)",
  "declare ptr @nt_arr_slice(ptr, double, double)",
  "declare void @nt_arr_extend(ptr, ptr)",
  "declare ptr @js_json_quote(ptr)",
  "declare ptr @nt_json_num(double)",
  "declare ptr @nt_json_parse(ptr)",
  "declare double @nt_dyn_as_number(ptr)",
  "declare i32 @nt_dyn_as_bool(ptr)",
  "declare i32 @nt_dyn_truthy(ptr)",
  "declare ptr @nt_dyn_as_string(ptr)",
  "declare i32 @nt_dyn_require_object(ptr)",
  "declare ptr @nt_dyn_require_field(ptr, ptr)",
  "declare i32 @nt_dyn_require_array(ptr)",
  "declare double @nt_dyn_len(ptr)",
  "declare ptr @nt_dyn_elem(ptr, double)",
  "declare ptr @nt_dyn_get_field(ptr, ptr)",
  "declare void @nt_dyn_print(ptr)",
  "declare i32 @nt_exc_pending()",
  "declare ptr @nt_exc_message()",
  "declare void @nt_exc_clear()",
  "declare void @nt_exc_abort()",
  // --- Host I/O FFI: CLI args / env / stdin / exit (libc-only, cross-links) ---
  "declare void @nt_init_args(i32, ptr)",
  "declare ptr @nt_argv()",
  "declare ptr @nt_getenv(ptr)",
  // process.platform. A CALL, not a folded constant: the runtime resolves it from the C
  // preprocessor so it follows `-target`, and the .ll stays triple-free (see nt_platform).
  "declare ptr @nt_platform()",
  "declare ptr @nt_read_line()",
  "declare ptr @nt_read_stdin()",
  "declare ptr @nt_read_key()",
  "declare void @nt_raw_mode(i32)",
  "declare void @nt_exit(double)",
  // --- Host FFI (SH4): filesystem + subprocess. libc/POSIX only (fopen/stat/fork),
  // so these cross-link unchanged; a failure raises the pending-exception protocol
  // so `try`/`catch` sees it exactly like node's throw.
  "declare ptr @nt_read_file(ptr)",
  "declare void @nt_write_file(ptr, ptr)",
  "declare i32 @nt_path_exists(ptr)",
  "declare ptr @nt_mkdtemp(ptr)",
  "declare ptr @nt_readdir(ptr)",
  "declare void @nt_rm(ptr, i32, i32)",
  "declare ptr @nt_host_spawn(ptr, ptr, ptr, ptr)",
  "declare void @nt_host_spawn_inherit(ptr, ptr, ptr)",
  "declare ptr @nt_path_join(ptr, ptr)",
  "declare ptr @nt_path_resolve(ptr, ptr)",
  "declare ptr @nt_path_dirname(ptr)",
  "declare ptr @nt_path_basename(ptr)",
  "declare ptr @nt_path_relative(ptr, ptr)",
  "declare ptr @nt_os_tmpdir()",
  "declare ptr @nt_os_homedir()",
  "declare ptr @nt_file_url_to_path(ptr)",
  // --- GUI FFI (raylib-backed, north-star C-d): flat scalar ABI, conditionally linked ---
  // Booleans come back as i32 (0/1) and are lowered to i1 via `icmp ne`. nt_gui.c + -lraylib
  // are pulled in ONLY when one of these is CALLED (see driver.ts) — non-GUI programs and
  // every cross-build stay raylib-free.
  "declare void @nt_gui_init_window(double, double, ptr)",
  "declare i32 @nt_gui_window_should_close()",
  "declare void @nt_gui_set_target_fps(double)",
  "declare void @nt_gui_begin_draw()",
  "declare void @nt_gui_end_draw()",
  "declare void @nt_gui_clear_background(double)",
  "declare void @nt_gui_draw_text(ptr, double, double, double, double)",
  "declare void @nt_gui_draw_rect(double, double, double, double, double)",
  "declare double @nt_gui_mouse_x()",
  "declare double @nt_gui_mouse_y()",
  "declare i32 @nt_gui_mouse_pressed()",
  "declare i32 @nt_gui_point_in_rect(double, double, double, double, double, double)",
  // --- B2 immutable Map/Set (nt_hamt via scalar-ABI wrappers in nt_mapset.c) ---
  // The TS-level handle is nt_mapset.c's NtColl (HAMT + insertion-order key log),
  // so construction/size/iteration go through the nt_coll_* wrappers.
  "declare ptr @nt_coll_map_new()",
  "declare ptr @nt_coll_map_from_coll(ptr)",
  "declare ptr @nt_map_put_slot(ptr, i32, i64, i64)",
  "declare i64 @nt_map_get_slot(ptr, i32, i64)",
  "declare i32 @nt_map_has_slot(ptr, i32, i64)",
  "declare ptr @nt_map_remove_slot(ptr, i32, i64)",
  "declare ptr @nt_coll_set_new()",
  "declare ptr @nt_coll_set_from_arr(ptr, i32)",
  "declare ptr @nt_set_add_slot(ptr, i32, i64)",
  "declare i32 @nt_set_has_slot(ptr, i32, i64)",
  "declare ptr @nt_set_remove_slot(ptr, i32, i64)",
  "declare i64 @nt_coll_size(ptr)",
  // insertion-ordered iteration → a real NtArray of key/value slots
  "declare ptr @nt_coll_keys(ptr)",
  "declare ptr @nt_coll_values(ptr)",
  // --- stdlib batch 2: bytes (Uint8Array + TextEncoder/TextDecoder, nt_bytes.c) ---
  "declare ptr @nt_bytes_new(double)",
  "declare ptr @nt_bytes_from_arr(ptr)",
  "declare double @nt_bytes_get(ptr, double)",
  "declare void @nt_bytes_set(ptr, double, double)",
  // bounds-PANIC element read/write for a written `u[i]` / `u[i] = v`
  "declare double @nt_bytes_index(ptr, double, ptr)",
  "declare void @nt_bytes_index_set(ptr, double, double, ptr)",
  "declare double @nt_bytes_len(ptr)",
  "declare ptr @nt_bytes_json(ptr, ptr, double)",
  "declare ptr @nt_bytes_encode(ptr)",
  "declare ptr @nt_bytes_decode(ptr)",
  // --- B3 v0 actors (spawn/send/receive/self) ---
  "declare void @nt_sched_init()",
  "declare i64 @nt_spawn_closure(ptr, ptr, i64)",
  "declare void @nt_send_slot(i64, i64)",
  "declare i64 @nt_receive_slot()",
  "declare i64 @nt_self()",
  "declare void @nt_drain()",
  // --- B3 v2 links/monitors/trap + fault injection; v3 supervision ---
  "declare void @nt_register(ptr, i64)",
  "declare i64 @nt_whereis(ptr)",
  "declare void @nt_link(i64)",
  "declare i64 @nt_monitor(i64)",
  "declare void @nt_trap_exit(i32)",
  "declare void @nt_actor_exit(i64, i64)",
  "declare void @nt_crash(i64)",
  "declare void @nt_kill(i64)",
  "declare i64 @nt_sup_new(i64, i64, i64)",
  "declare void @nt_sup_add_child(i64, ptr, ptr, ptr)",
  "declare i64 @nt_sup_start(i64)",
  // --- console.log of a COMPOUND value: node's util.inspect (Stage 47) ---
  // Codegen walks the static type and renders one entry string per element/field;
  // the builder owns only the width / line-breaking decision (runtime widths).
  "declare ptr @nt_insp_new(ptr, ptr, double, double, double)",
  "declare void @nt_insp_add(ptr, ptr)",
  "declare ptr @nt_insp_done(ptr)",
  "declare ptr @nt_insp_num(double)",
  "declare ptr @nt_insp_str(ptr)",
  "declare ptr @nt_insp_entry(ptr, ptr)",
  "declare ptr @nt_insp_pair(ptr, ptr)",
  "declare ptr @nt_insp_coll_open(ptr, double)",
  "declare ptr @nt_insp_len_open(ptr, double)",
  "declare ptr @nt_insp_more(double)",
  "declare ptr @nt_dyn_inspect(ptr, double)",
  "declare ptr @nt_dyn_display(ptr, double)",
  "declare ptr @nt_dyn_str_or_null(ptr)",
];

/** B3 v4 runtime entry points — typed messages, receive timeouts, selective receive.
 *  Emitted ONLY in programs that use actors (like the v1 safepoint declare), so
 *  non-actor IR is byte-identical to before v4. */
const ACTOR_V4_DECLARES = [
  "declare i64 @nt_spawn_typed(ptr, ptr, i64, i64)",
  "declare void @nt_send_typed(i64, i64, i64)",
  "declare i64 @nt_recv_timed(i64, double, i32)",
  "declare i32 @nt_recv_timed_out()",
  "declare i64 @nt_mbox_count()",
  "declare i64 @nt_mbox_peek_slot(i64)",
  "declare i64 @nt_mbox_peek_kind(i64)",
  "declare void @nt_mbox_take(i64)",
  "declare i32 @nt_mbox_wait_from(i64, double, i32)",
  // v5 structured messages: the payload is deep-copied HERE (codegen) and travels with
  // its shape tag, which the receive verifies; `nt_msg_str_copy` is the string leaf of
  // that copy walk. Same actor-usage gate, so non-actor IR stays byte-identical.
  "declare void @nt_send_struct(i64, i64, ptr, ptr)",
  "declare i64 @nt_recv_struct(ptr, double, i32)",
  "declare i32 @nt_mbox_shape_ok(i64, ptr)",
  "declare ptr @nt_msg_str_copy(ptr)",
  // v6 M:N introspection (debug builtins). In the GATED list, not the unconditional one,
  // so a non-actor program's IR is still byte-identical.
  "declare double @nt_schedulers()",
  "declare double @nt_sched_used()",
  "declare double @nt_sched_steals()",
];

interface Val { v: string; ty: Ty; }

/** A string handed to `js_str_concat`, plus whether THIS frame allocated it. `fresh`
 *  means "no other owner exists, so releasing it after the concat frees it"; `false` is
 *  always the safe answer and is what every shape not proved below gets. */
interface StrTemp { v: string; fresh: boolean; }

/** A value a lowering allocated and handed back UNOWNED, and the runtime call that
 *  reclaims it (`nt_arr_free` / `nt_str_release`). See `FnGen.discardFree`. */
interface DiscardFree { v: string; call: string; }

/**
 * One live `try`'s finalizer, and the abrupt exits parked on it.
 *
 * A finalizer is entered by BRANCH from every path that leaves the `try`, and a slot
 * says which path that was: 0 = fell out the bottom, 1 = a `return` is pending, and one
 * fresh id per `break`/`continue` that crosses this finalizer on its way somewhere else.
 * The dispatch at the end of the finalizer reads the slot back and resumes the pending
 * completion — that is the whole mechanism, and `break`/`continue` simply had no ids in
 * it, so they branched around the finalizer instead of through it.
 *
 * `scopeDepth` is `blockScopes.length` at the `try` itself, i.e. NOT counting the try
 * block's own scope. Everything at or above it is inside the `try` and is dropped BEFORE
 * the finalizer runs; everything below is outside and is dropped after, on the way to
 * the next finalizer out or to the jump's real target.
 */
interface FinallyFrame {
  /** Identity, so a pending exit can name the frame it is parked on WITHOUT the frame
   *  holding the list. The list lives on the emitter (`jumpExits`) for a reason the
   *  self-host subset dictates: `frame.exits.push(…)` mutates an array reached through a
   *  parameter, which the checker refuses (NT1606) — `this.jumpExits.push(…)` mutates a
   *  field of the `@@mutable` emitter, which it allows. `src/` stays inside the subset it
   *  compiles, so the side table is the shape, not the aggregate. */
  id: number;
  finallyLbl: string;
  modeSlot: string;
  retSlot: string | null;
  scopeDepth: number;
}

/**
 * A `break`/`continue` that is mid-flight through `chain[idx]`'s finalizer.
 *
 * It has to be a RECORD rather than a callback because the resume code is emitted long
 * after the jump: the finalizer's dispatch is written when the `TryStmt` finishes, by
 * which time `blockScopes` has popped every scope the jump still owes drops for. So the
 * scope drop sets are SNAPSHOT at the jump (`scopes`, absolute indices), and the chain of
 * finalizers still to run is captured with it.
 */
interface PendingExit {
  /** The `FinallyFrame.id` this exit is parked on — `chain[idx]`'s, always. */
  frameId: number;
  mode: number;
  scopes: string[][];
  chain: FinallyFrame[];
  /** Index into `chain` of the finalizer this exit is currently parked on. */
  idx: number;
  targetLbl: string;
  targetDepth: number;
}

/**
 * Does lowering THIS expression to a `string` allocate a fresh heap string that nothing
 * else can already own?
 *
 * Only two shapes qualify, and both allocate by construction: `js_str_concat` always
 * returns a NEW buffer (see runtime.c — it memcpy's both inputs and retains neither), and
 * a template literal is a chain of those. Neither result is bound to a name at the point
 * it is used as an operand, so this frame is its only owner.
 *
 * DELIBERATELY NOT LISTED, though they allocate too: a method producer (`.toUpperCase()`,
 * `.slice()`), because "does this method allocate" is a per-method fact and a wrong `true`
 * here is a PREMATURE FREE — the failure this predicate exists to avoid, and one macOS
 * cannot see. `false` only ever means "leak it, exactly as before".
 *
 * The `ty` test is GUARDED AND REBOUND rather than written as `e.ty === "string"`, which
 * is the spelling this compiler refuses when it checks itself: `Expr.ty` is `Ty |
 * undefined` and a nullable may not be compared with a string (NT2001). Exactly the note
 * `raisedMessage` already carries — and the reason the same comparison survives inside
 * `genExprInner` is only that a blocker EARLIER in that body masks it, which is the
 * first-blocker masking `test/blocker-metric.ts` warns hides refusals a lane ADDS.
 */
/**
 * The `BlockDrops` set a statement list carries, or `[]` if it has none.
 *
 * The marker is always the LAST statement (`setBlockDrops` in ast.ts replaces in place
 * precisely so it stays last through the ownership pass's five fixpoint walks), so this
 * is a single look at the tail rather than a scan. Spelled with the length hoisted, the
 * way `setBlockDrops` itself is: `list[list.length - 1]` reads index `-1` on an empty
 * list, which node answers `undefined` and this compiler PANICS on by design (Stage 41,
 * test/no-index-last.test.ts).
 */
function dropsOf(list: Stmt[]): string[] {
  const n = list.length;
  if (n === 0) return [];
  const last = list[n - 1]!;
  return last.kind === "BlockDrops" ? last.names : [];
}

function allocatesString(e: Expr): boolean {
  if (e.kind === "TemplateLiteral") return true;
  if (e.kind !== "BinaryExpr") return false;
  if (e.op !== "+") return false;
  const t = e.ty;
  if (t === undefined) return false;
  const et: Ty = t;
  return et === "string";
}

// Like `FnGen` below, a module emitter is an accumulator: `this.strings`/`this.strDefs`
// grow and `this.arrowCounter` counts up as the module is built. `@@mutable`, in the same
// pragma spelling.
//@@mutable
class ModuleGen {
  private strings = new Map<string, string>();
  private strDefs: string[] = [];
  readonly liftedFns: string[] = [];
  private arrowCounter = 0;
  /** Module-level bindings promoted to LLVM globals (SH1): the ones a function body
   *  reads. `main` uses the global as their storage; every other frame loads from it. */
  /** Recursive-type shapes, the table a `@Name` back-edge resolves through (ast.ts).
   *  Read through `FnGen.unfold`; empty unless the program declared a recursive type. */
  recTypes = new Map<string, Ty>();
  /** `@@mutable` RECORD tags. A record reuses the CLASS tag encoding (`Cell{n:number}`),
   *  which is what makes its mutability nominal — but `util.inspect` must tell the two
   *  apart: node prints `Counter { pos: 0 }` for a class instance and a bare `{ n: 1 }`
   *  for a record, because a record has no constructor to name. Empty for every program
   *  that declares no `@@mutable` record, so nothing else changes. */
  recordTags = new Set<string>();
  /** Does the program contain a `try` at all? When it does NOT, no handler exists in
   *  any frame, so a `throw` with no local `try` is an UNCAUGHT exception rather than
   *  the cross-frame propagation NT1004 refuses. See `FnGen.uncatchable`. */
  hasTry = true;

  /** Functions whose `throw` may LEAVE the frame, PROVED (see `scanEscaping`). Empty for
   *  every program that does not use the callee-raises/caller-catches idiom, which is
   *  why nothing else's IR moves. */
  escaping = new Set<string>();
  /** Set when a frame lowered an UNCAUGHT `throw`. Declared conditionally, exactly like
   *  the actor surface: a program with no uncaught throw emits byte-identical IR. */
  usesUncaughtThrow = false;

  /** Set when the program calls `__strScanned()`, the debug counter for bytes walked by
   *  `strlen` answering a length query. Declared conditionally for the same reason as the
   *  two above: every program that does NOT use it emits byte-identical IR. */
  usesStrScanned = false;

  /** Set when a frame MOVED an object onto the pending-exception slot, or took one off it.
   *  Declared conditionally for the same reason as the flags above: a program that carries
   *  only string payloads — which is every program written before this — emits IR with not
   *  one byte moved. */
  usesExcObject = false;
  constructor(readonly functions: Map<string, Sig>, readonly globals: Map<string, Ty> = new Map()) {}

  /** `@nt.g.<name>` — the storage symbol of a promoted module-level binding. */
  static globalSym(name: string): string { return `@nt.g.${name}`; }

  /** Lambda-lift an arrow to a top-level function `@arrow_N(ptr env, params)`. Idempotent. */
  liftArrow(arrow: ArrowFunction): string {
    if (arrow.liftedName) return arrow.liftedName;
    const name = `arrow_${this.arrowCounter++}`;
    arrow.liftedName = name;
    this.liftedFns.push(new FnGen(this).genArrow(name, arrow));
    return name;
  }

  /** True if the program uses the actor surface (spawn/send/receive/self/__drain).
   *  When set, @main is prefixed with nt_sched_init() so actor 0 (main) exists. */
  usesActors = false;
  private actorEntries = new Map<string, string>();

  /** Lazily emit a generic actor-entry trampoline for a message of LLVM-arg type
   *  `argTy` and return its symbol. It reads the closure fn ptr from env slot 0
   *  and calls `body(env, arg)`, converting the raw i64 slot to the param type —
   *  decoupling the actor ABI (void(ptr,i64)) from the arrow ABI. */
  actorEntry(argTy: Ty): string {
    const key = llvmTy(argTy);
    const existing = this.actorEntries.get(key);
    if (existing) return existing;
    const name = `nt_actor_entry_${this.actorEntries.size}`;
    this.actorEntries = this.actorEntries.set(key, name);
    // slot(i64) -> param: number is a bit-cast double; heap types are inttoptr.
    const conv = argTy === "number"
      ? `%arg = bitcast i64 %slot to double`
      : `%arg = inttoptr i64 %slot to ptr`;
    this.liftedFns.push(
      [
        `define void @${name}(ptr %env, i64 %slot)${asanFnAttr()} {`,
        `L:`,
        `  %fpi = load i64, ptr %env`,
        `  %fp = inttoptr i64 %fpi to ptr`,
        `  ${conv}`,
        `  call void %fp(ptr %env, ${llvmTy(argTy)} %arg)`,
        `  ret void`,
        `}`,
      ].join("\n"),
    );
    return name;
  }

  private msgRenderers = new Map<string, string>();

  /** B3 v5: lazily emit `ptr @nt_msg_render_N(i64 %slot)` — the crash record's renderer
   *  for a structured message of type `ty`. The runtime cannot walk a slot block (it has
   *  no types), so the compiler hands it a per-shape function that JSON-renders the
   *  value; it is called only while printing a crash record. */
  msgRenderer(ty: Ty): string {
    const key = ty;
    const existing = this.msgRenderers.get(key);
    if (existing) return existing;
    const name = `nt_msg_render_${this.msgRenderers.size}`;
    this.msgRenderers = this.msgRenderers.set(key, name);
    this.liftedFns.push(new FnGen(this).genMsgRender(name, ty));
    return name;
  }

  private cmpShims = new Map<string, string>();

  /** Lazily emit a comparator trampoline for `.toSorted(cmp)` and return its symbol.
   *  The runtime's stable merge sort calls `i32 (ptr env, i64 a, i64 b)`; a TS
   *  comparator is a closure `[fn_ptr, caps…]` returning a double. The shim reads
   *  the fn ptr from env slot 0, converts the raw element slots to the element's
   *  LLVM type, calls it, and maps the result to a sign (NaN → 0, like node). One
   *  shim per LLVM element type, so it works for any function VALUE, not just an
   *  inline arrow. */
  cmpShim(elTy: Ty): string {
    const lt = llvmTy(elTy);
    const existing = this.cmpShims.get(lt);
    if (existing) return existing;
    const name = `nt_cmp_shim_${this.cmpShims.size}`;
    this.cmpShims = this.cmpShims.set(lt, name);
    const conv = (reg: string, slot: string) =>
      lt === "double" ? `%${reg} = bitcast i64 %${slot} to double` : `%${reg} = inttoptr i64 %${slot} to ptr`;
    this.liftedFns.push(
      [
        `define i32 @${name}(ptr %env, i64 %sa, i64 %sb)${asanFnAttr()} {`,
        `L:`,
        `  %fpi = load i64, ptr %env`,
        `  %fp = inttoptr i64 %fpi to ptr`,
        `  ${conv("a", "sa")}`,
        `  ${conv("b", "sb")}`,
        `  %r = call double %fp(ptr %env, ${lt} %a, ${lt} %b)`,
        `  %lt = fcmp olt double %r, 0.0`,
        `  %gt = fcmp ogt double %r, 0.0`,
        `  %p = select i1 %gt, i32 1, i32 0`,
        `  %s = select i1 %lt, i32 -1, i32 %p`,
        `  ret i32 %s`,
        `}`,
      ].join("\n"),
    );
    return name;
  }

  private fnValues = new Map<string, string>();
  private fnValueDefs: string[] = [];

  /**
   * The VALUE of a top-level function declaration — `@dbl` used where a function value is
   * wanted. Returns the symbol of a block whose slot 0 holds a callable fn pointer, which
   * is the one thing `callClosure` requires of a function value.
   *
   * TWO pieces, and each is forced by an ABI difference rather than chosen:
   *
   *  1. A TRAMPOLINE, because the two calling conventions differ by exactly one leading
   *     argument. `callClosure` passes the block itself as an implicit `ptr` first
   *     parameter (a lifted arrow reads its captures out of it); a top-level function has
   *     no such parameter. Storing `@dbl` in slot 0 directly would therefore shift every
   *     real argument by one — a silent wrong answer, not a crash. The shim takes the env,
   *     IGNORES it (a declaration captures nothing, which is the whole reason this is
   *     cheaper than a closure) and tail-calls the real symbol.
   *
   *  2. A private CONSTANT global for the block, not `nt_obj_new`. With no captures the
   *     block's contents are known at compile time, so there is nothing to allocate per
   *     evaluation — which also settles the ownership question by removing it: no heap
   *     block means nothing to own, nothing to drop, no leak on the argument path and no
   *     double free if the same function is passed twice. One block per function, shared.
   *
   * Keyed by name, so `f(dbl); g(dbl)` emits one shim and one block. Lazy, on the same
   * pattern as `cmpShim` and `actorEntry`: a program that never uses a function as a value
   * emits neither and its IR is unchanged.
   */
  fnValue(name: string, fnTy: Ty): string {
    const existing = this.fnValues.get(name);
    if (existing) return existing;
    const idx = this.fnValues.size;
    const blk = `@nt_fnval_blk_${idx}`;
    // Threaded, not discarded: a nativets `Map` is PERSISTENT, so `.set` returns a new map
    // and leaves the receiver alone (NT1606). Under bun `.set` mutates and returns the same
    // map, so the assignment is a no-op there — one spelling, both semantics.
    this.fnValues = this.fnValues.set(name, blk);
    const shim = `nt_fnval_${idx}`;
    const ps = funcParams(fnTy);
    const ret = funcRet(fnTy);
    // ONE list: an LLVM parameter and the argument forwarding it are spelled identically
    // (`double %a0`), so the declaration and the call share it. Built with an index loop
    // rather than `.map((p, i) => …)` — `.map` binds `(elem)` only in the subset `src/`
    // must stay inside, and the point-free spelling put this function outside it. The list
    // is built by `.push` into a local nothing else can see, so it takes the `@@mutable`
    // opt-in rather than a fold.
    //@@mutable
    const slots: string[] = [];
    for (let i = 0; i < ps.length; i++) slots.push(`${llvmTy(ps[i]!)} %a${i}`);
    const list = slots.join(", ");
    const retLl = ret === "void" ? "void" : llvmTy(ret);
    const body = ret === "void"
      ? [`  call void @${name}(${list})`, `  ret void`]
      : [`  %r = call ${retLl} @${name}(${list})`, `  ret ${retLl} %r`];
    this.fnValueDefs.push(
      [
        `define ${retLl} @${shim}(ptr %__env${slots.length ? ", " + list : ""}) {`,
        `L:`,
        ...body,
        `}`,
      ].join("\n"),
    );
    // Slot 0 is the fn pointer — the layout `callClosure` loads from. A constant
    // expression, so the block needs no runtime initialization from `main`.
    this.fnValueDefs.push(`${blk} = private constant [1 x i64] [i64 ptrtoint (ptr @${shim} to i64)]`);
    return blk;
  }

  intern(s: string): string {
    const existing = this.strings.get(s);
    if (existing) return existing;
    const sym = `@.str.${this.strings.size}`;
    const { body, len } = encodeCString(s);
    this.strDefs.push(`${sym} = private unnamed_addr constant [${len} x i8] c"${body}"`);
    this.strings = this.strings.set(s, sym);
    return sym;
  }

  /** Host builtins (SH4) the program imported from a `node:` module. Only these names
   *  lower to a host call; every other program's IR is unchanged. */
  hostImports = new Set<string>();

  build(program: Program): string {
    this.usesActors = scanUsesActors(program);
    this.hasTry = scanHasTry(program);
    this.escaping = scanEscaping(program, this.usesActors);
    this.hostImports = new Set(program.hostImports ?? []);
    this.recTypes = recTypeTable(program); // `@Name` back-edges (empty for most programs)
    this.recordTags = new Set(program.mutableRecords ?? []);
    const fns: string[] = [];
    for (const s of program.body) {
      if (s.kind === "FuncDecl") fns.push(new FnGen(this).genFunction(s));
    }
    const main = new FnGen(this).genMain(program.body, program.endDrops ?? []);
    return [
      "; ModuleID = 'nativets'",
      ...DECLARES,
      // v1 preemption safepoint — declared only in actor programs (the only ones that
      // emit calls to it + link nt_actor.c), so non-actor IR stays byte-identical.
      ...(this.usesActors ? ["declare void @nt_reduction_tick()", ...ACTOR_V4_DECLARES] : []),
      // An uncaught `throw` raises on the pending-exception flag before aborting; nothing
      // else in the emitted IR ever raises (the runtime raises internally), so this one is
      // declared only where it is used.
      ...(this.usesUncaughtThrow ? ["declare void @nt_exc_raise_msg(ptr)"] : []),
      // The MOVE pair. Only a program that carries an OBJECT across a frame mentions them.
      ...(this.usesExcObject ? ["declare void @nt_exc_raise_obj(ptr, ptr)", "declare ptr @nt_exc_take_object()"] : []),
      ...(this.usesStrScanned ? ["declare double @nt_str_scanned()"] : []),
      "",
      ...this.strDefs,
      this.strDefs.length ? "" : null,
      // Module-level bindings read from inside a function (SH1). Zero-initialized and
      // written by `main` when the declaration executes, in module (dependency) order.
      ...[...this.globals].map(([n, t]) => `${ModuleGen.globalSym(n)} = internal global ${llvmTy(t)} ${defaultZero(t)}`),
      this.globals.size ? "" : null,
      // Function-declaration VALUES: the trampoline + its constant block, per function
      // used that way. Empty (and so absent from the IR) for every program that uses none.
      ...this.fnValueDefs.flatMap((f) => [f, ""]),
      ...this.liftedFns.flatMap((f) => [f, ""]), // lifted arrows (populated during gen)
      ...fns.flatMap((f) => [f, ""]),
      main,
      "",
      // The group every `define` above references under NATIVETS_ASAN=1 (see `asanOn`).
      ...(asanOn() ? [ASAN_ATTR_DEF, ""] : []),
    ].filter((x) => x !== null).join("\n");
  }
}

/* The four opcode tables. `Map`s built with the `.set` chain, not
 * `Record<string, string> = { … }`: the operator is a RUNTIME key, an object literal cannot
 * construct a dictionary here, and membership is `.has(op)` rather than `FCMP.has(op)` —
 * node's `in` walks the PROTOTYPE CHAIN, so `"toString" in FCMP` was TRUE on the object
 * spelling. See src/ast.ts's HOST_MODULES and test/record-dict.test.ts. */
const FCMP: Map<string, string> = new Map<string, string>()
  .set("<", "olt").set("<=", "ole").set(">", "ogt").set(">=", "oge")
  .set("===", "oeq").set("==", "oeq").set("!==", "une").set("!=", "une");
const ARITH: Map<string, string> = new Map<string, string>()
  .set("+", "fadd").set("-", "fsub").set("*", "fmul").set("/", "fdiv").set("%", "frem");
const BITFN: Map<string, string> = new Map<string, string>()
  .set("&", "js_bit_and").set("|", "js_bit_or").set("^", "js_bit_xor")
  .set("<<", "js_shl").set(">>", "js_shr").set(">>>", "js_ushr");
const MATH_FN1: Map<string, string> = new Map<string, string>()
  .set("floor", "floor").set("ceil", "ceil").set("sqrt", "sqrt")
  .set("trunc", "trunc").set("abs", "fabs").set("round", "js_math_round");

// An emitter is an accumulator: `this.blocks` grows, `this.tmp`/`this.lbl` count up. That
// is in-place mutation of one owned object — `@@mutable`, in the pragma spelling that
// keeps this file runnable by bun (see src/parser.ts's note and src/lexer.ts).
//@@mutable
class FnGen {
  private entryAllocas: string[] = [];
  private blocks: { label: string; lines: string[]; terminated: boolean }[] = [];
  private cur = 0;
  private tmp = 0;
  private lbl = 0;
  private varTypes = new Map<string, Ty>();
  private retTy: Ty = "number";
  /**
   * Active `break`/`continue` targets, each with the BLOCK-SCOPE DEPTH it sits at.
   *
   * The two depths are not the same number and that is the whole point of storing both.
   * A `switch` pushes an entry so that `break` can find it, but its `cont` is INHERITED
   * from the enclosing loop — so a `continue` inside a switch inside a loop leaves the
   * case's scope AND the loop body's, while a `break` at the same spot leaves only the
   * case's. One depth would fix one of them and leave the other leaking.
   *
   * `brkFin`/`contFin` are the same idea one stack over: the `finallyStack` DEPTH the
   * target sits at. A jump crosses every finalizer above that mark and has to RUN each
   * one on the way out (node does), and it inherits the switch's split for exactly the
   * reason the scope depths do — `break` stops at the switch, `continue` does not.
   */
  private loops: { brk: string; cont: string; brkDepth: number; contDepth: number; brkFin: number; contFin: number }[] = [];
  /**
   * The stack of live block scopes' drop sets — `blockScopes[i]` is the `BlockDrops`
   * names of the i-th enclosing statement list (empty when that list has no marker).
   *
   * This mirrors, in codegen, the `this.scopes` stack the ownership pass keeps while it
   * walks. It exists because the marker is a TRAILING statement: `genStmts` stops at the
   * first terminated block, so a jump reached the loop label without ever reaching the
   * markers of the blocks it was leaving. `return` never had the problem — it carries
   * its own `ReturnStmt.drops` stamped by `ownedInScope` — and it deliberately still
   * does; this stack is read only by `break`/`continue`.
   */
  private blockScopes: string[][] = [];
  /** In a lifted arrow: captured var name -> its slot in the closure env (%__clo). */
  private captures = new Map<string, { index: number; ty: Ty }>();
  /** Is `name` a user-bound local/param/capture (so a `Foo.bar` isn't a builtin namespace)? */
  private isBound(name: string): boolean { return this.varTypes.has(name) || this.captures.has(name); }
  /** String-typed VarDecl locals in this frame — reference-counted: retained on
   *  bind/alias, released at scope exit. Params are excluded (the caller owns them). */
  private strLocals = new Set<string>();
  /**
   * Active `try` scopes in this frame; a `throw` branches to the innermost one's
   * `catchLbl`.
   *
   * `catchless` marks a `try` that has only a `finally`. It is NOT a handler — node
   * runs the finalizer and keeps propagating — and its `catchLbl` block is therefore
   * never emitted. Entries for it are still pushed so the innermost-scope lookup can
   * SEE it and refuse (`escapesCatchlessTry`); branching to the label instead produced
   * `br label %catchN` with no such block, i.e. invalid IR and a raw clang error.
   */
  private tryHandlers: { catchLbl: string; excVar: string | null; eType: Ty; catchless: boolean }[] = [];

  /**
   * The innermost enclosing `try`, or null when the handler stack is empty.
   *
   * Spelled as a length test rather than `tryHandlers[tryHandlers.length - 1]` because an
   * EMPTY stack is the ordinary case (a `throw` outside any `try`), and that spelling forms
   * index -1, which node answers `undefined` and nativets PANICS on by design (Stage 41).
   * `src/` may not depend on the read; `test/no-index-last.test.ts` scans for the shape and
   * ratchets it. One helper so the three call sites cannot drift apart.
   */
  private innermostHandler(): { catchLbl: string; excVar: string | null; eType: Ty; catchless: boolean } | null {
    const n = this.tryHandlers.length;
    return n > 0 ? this.tryHandlers[n - 1]! : null;
  }
  /** Active finally blocks (a `return` inside runs finally first, mode=1). */
  private finallyStack: FinallyFrame[] = [];
  /**
   * Next free finalizer dispatch mode. 0 and 1 are reserved (fall-through, `return`), so
   * jump ids start at 2 and one jump burns one id PER finalizer it crosses — the resume
   * block after finalizer N stores a fresh id into finalizer N-1's slot before branching
   * on. Per function: `reset` puts it back, and the slots are per-`try` allocas anyway.
   */
  private jumpMode = 2;
  /**
   * The innermost live finalizer, or null when nothing encloses. Spelled as a length
   * test for the reason `innermostHandler` is: an EMPTY stack is the ordinary case, and
   * `xs[xs.length - 1]` forms index -1 there, which node answers `undefined` and nativets
   * PANICS on (test/no-index-last.test.ts). One helper so the call sites cannot drift.
   */
  private innermostFinally(): FinallyFrame | null {
    const n = this.finallyStack.length;
    return n > 0 ? this.finallyStack[n - 1]! : null;
  }
  /** Abrupt exits parked on a live finalizer, keyed by `FinallyFrame.id`. */
  private jumpExits: PendingExit[] = [];
  /** Next `FinallyFrame.id`. */
  private finId = 0;
  /**
   * True while emitting `main`. `retTy` is "number" there (top-level expressions are typed
   * like any others), but the FUNCTION returns `i32` — so any `ret` emitted from a generic
   * path must use `i32`, not `llvmTy(this.retTy)`. Only the finally-return path can reach
   * this, and only as dead code (a top-level `return` is illegal), but LLVM still type-checks
   * unreachable blocks: emitting `ret double` inside `@main` made clang reject the module.
   */
  private inMain = false;
  /** Active inlined-HOF callbacks (map/filter/reduce with a BLOCK body): a `return`
   *  inside stores the per-element result and branches to the callback's join, rather
   *  than returning from the enclosing function.
   *
   *  `.forEach` pushes a DISCARD frame instead (`slot` empty): node throws its callback's
   *  result away, so there is nothing to store — the `return` only means "next element".
   *  Storing it anyway would need a slot typed by the body, and a body of `void`
   *  (`xs.forEach((x) => { return console.log(x); })`) has no such type: `alloca void` is
   *  not IR LLVM accepts. The argument is still EVALUATED, for its side effects. */
  private hofReturnStack: { slot: string; done: string; ty: Ty; discard?: boolean }[] = [];
  /** Per-inlining counter: gives each inlined HOF callback a frame-unique name suffix
   *  (see freshenHofArrow) so two sibling callbacks reusing a param/local name — possibly
   *  at DIFFERENT types — each get their own correctly-typed slot instead of colliding in
   *  the flat frame (addLocal keeps the first type → a silent miscompile). */
  private hofSeq = 0;
  /** In the `main` frame: the module-level bindings whose storage IS the LLVM global
   *  (so the declaration's store and every top-level read/write hit the same cell a
   *  function body reads). Empty in every other frame. */
  private globalVars = new Set<string>();
  /**
   * The SSA name of a value a lowering just allocated and handed back UNOWNED, and the
   * runtime call that reclaims it — the one signal `ExprStmt` needs in order to free a
   * DISCARDED result rather than leak it. A statement in expression position throws its
   * value away, so nothing names it: no binding exists, no drop set can refer to it, and
   * `freeReceiverTemp` only ever reaches the RECEIVER of a chain, never its result.
   *
   * Marked at the point of construction, NOT recognised by shape at the discard. The
   * shape test is available (`freshArray` in ast.ts, which already answers "yes" for
   * `.concat` and `.keys`) and it is the wrong instrument here: it matches on the
   * METHOD NAME, so a user class with a `concat`/`map`/`keys` method that hands back a
   * field would match it too, and freeing that field is a use-after-free rather than a
   * leak. `freshArray` is safe where it is used today only because both callers have
   * already established that the receiver is a builtin array. At a discard there is no
   * such context, so freshness has to come from the code that did the allocating.
   *
   * Set by exactly the lowerings whose freshness is a fact of the lowering itself:
   * `Object.keys`/`values`/`entries`/`getOwnPropertyNames` (built here out of
   * `nt_arr_new`), `Array#concat` (`nt_arr_concat` returns a new header), and
   * `JSON.stringify` (a fold of `js_str_concat`, whose result this frame owns at rc=1).
   * Anything that does not set it is simply left to leak, as before — a wrong claim here
   * is a premature free, so the default has to be "unclaimed".
   *
   * Read by ONE consumer, immediately after the `genExpr` that set it, and compared by
   * SSA identity: a nested lowering that set it for some inner value cannot be mistaken
   * for the statement's own result, because the value returned would not be that name.
   */
  private discardFree: DiscardFree | null = null;

  /** Read the pending discard claim and clear it, so the next statement starts unclaimed
   *  whether or not this one used it. */
  private takeDiscardFree(): DiscardFree | null {
    const claim = this.discardFree;
    this.discardFree = null;
    return claim;
  }

  constructor(private mod: ModuleGen) {}

  /** Unfold a nominal back-edge one level (`@N` -> its shape); identity on anything else.
   *  Applied wherever a type's SHAPE is needed rather than its identity.
   *
   *  WIDENED, exactly as `checker.unfold` is and for the same reason: `recTypes` stores the
   *  literal-preserving `parseTypeInner` spelling, and codegen must see the type the checker
   *  gave the value or the two drift. It showed up as a wrong ANSWER rather than a crash —
   *  `genInspect` has no arm for a string-LITERAL field type, so it fell through to
   *  `undefined` and `console.log` of a node through a back-edge printed
   *  `{ tag: undefined, n: 2 }` where node prints `{ tag: 'm', n: 2 }`.
   *  `widenLiteralTys` does not descend into a `U<…>`, so a recursive union keeps the tags
   *  its dispatch reads, and a literal-typed field is one string slot either way. */
  private unfold(t: Ty): Ty { return widenLiteralTys(unfoldTypeRef(t, this.mod.recTypes)); }

  /**
   * The storage address of a variable. Normally its frame alloca `%x.addr`; for a
   * module-level binding promoted to a global (SH1) it is `@nt.g.x` — in `main`
   * (which owns the declaration) and in any function that reads it.
   */
  private addr(name: string): string {
    if (this.globalVars.has(name)) return ModuleGen.globalSym(name);
    if (!this.varTypes.has(name) && this.mod.globals.has(name)) return ModuleGen.globalSym(name);
    return `%${name}.addr`;
  }

  /** Read a captured variable from the closure env (slot index+1; slot 0 is the fn ptr). */
  private readCapture(name: string): Val {
    const c = this.captures.get(name)!;
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr %__clo, i64 ${c.index + 1}`);
    const slot = this.fresh();
    this.emit(`${slot} = load i64, ptr ${gep}`);
    return { v: this.fromSlot(slot, c.ty), ty: c.ty };
  }
  private writeCapture(name: string, val: Val): void {
    const c = this.captures.get(name)!;
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr %__clo, i64 ${c.index + 1}`);
    this.emit(`store i64 ${this.toSlot(val)}, ptr ${gep}`);
  }

  // ---- block plumbing ----
  private fresh(): string { return `%t${this.tmp++}`; }
  private label(h: string): string { return `${h}${this.lbl++}`; }
  private alloca(name: string, ty: Ty): void {
    this.entryAllocas.push(`%${name}.addr = alloca ${llvmTy(ty)}`);
  }
  private slot(ty: Ty): string {
    const name = `s${this.lbl++}`;
    this.entryAllocas.push(`%${name} = alloca ${llvmTy(ty)}`);
    return `%${name}`;
  }
  /** A slot in the universal `i64` SLOT representation (what `toSlot`/`fromSlot` move),
   *  for holding a value whose type is only known through `el`. */
  private rawSlot(): string {
    const name = `s${this.lbl++}`;
    this.entryAllocas.push(`%${name} = alloca i64`);
    return `%${name}`;
  }
  private block(label: string): number {
    this.blocks.push({ label, lines: [], terminated: false });
    return this.blocks.length - 1;
  }
  private to(idx: number): void { this.cur = idx; }
  private emit(line: string): void { this.blocks[this.cur]!.lines.push("  " + line); }
  private terminate(line: string): void {
    const b = this.blocks[this.cur]!;
    if (!b.terminated) { b.lines.push("  " + line); b.terminated = true; }
  }
  /** Whether the current block already has a terminator.
   *
   *  A METHOD, not a `get` accessor: nativets refuses accessors (NT1015), and a getter is
   *  exactly a zero-argument method with the parens dropped, so the accessor spelling
   *  bought nothing and cost this module its place on the self-hosting path. */
  private isTerminated(): boolean { return this.blocks[this.cur]!.terminated; }

  /**
   * The interned `file:line:col` a bounds panic reports, or `null` when this index
   * was SYNTHESIZED by a desugaring (destructuring, spread-call expansion) rather
   * than written — those keep the internal, non-panicking accessor.
   */
  private locArg(loc?: Loc): string | null {
    if (!loc) return null;
    return this.mod.intern(`${loc.file ?? "<input>"}:${loc.line}:${loc.col}`);
  }

  /** v1 reduction-counted preemption: emit a safepoint (budget tick + maybe-yield)
   *  at loop back-edges and function-call sites. Emitted ONLY in programs that use
   *  actors, so non-actor programs keep byte-identical IR; the runtime tick is itself
   *  a no-op unless a spawned actor is running. */
  private emitSafepoint(): void {
    if (this.mod.usesActors && !this.noSafepoints) this.emit(`call void @nt_reduction_tick()`);
  }

  private reset(): void {
    this.entryAllocas = []; this.blocks = []; this.cur = 0; this.tmp = 0; this.lbl = 0;
    this.varTypes = new Map();
    this.loops = [];
    this.blockScopes = [];
    this.captures = new Map();
    this.tryHandlers = [];
    this.finallyStack = [];
    this.jumpMode = 2;
    this.jumpExits = [];
    this.finId = 0;
    this.hofReturnStack = [];
    this.strLocals = new Set();
    this.frameLocals = new Set();
    this.globalVars = new Set();
    this.inMain = false;
    this.selfArrow = null;
    this.consumeNode = null; this.consumeTaken = false;
  }

  // ---- string reference counting (value-semantics strings) ----
  /** A string EXPRESSION that mints a fresh heap string (already registered rc=1
   *  by the runtime). Binding one CONSUMES it (no retain); anything else — an
   *  identifier/field/index/literal alias — BORROWS an existing owner and must
   *  retain. Classifying non-producers as borrows is the safe default (a needless
   *  retain only leaks; a missing one could free a still-referenced string). */
  private isStrProducer(e: Expr): boolean {
    return e.kind === "CallExpr" || e.kind === "TemplateLiteral" || (e.kind === "BinaryExpr" && e.op === "+");
  }
  /** Emit a retain unless the initializer is a fresh producer being consumed. */
  private retainStrBind(init: Expr, v: string): void {
    if (!this.isStrProducer(init)) this.emit(`%rc${this.tmp++} = call ptr @nt_str_retain(ptr ${v})`);
  }
  /** Zero-init string locals so an unassigned/conditionally-assigned one releases
   *  as null (a no-op) rather than loading garbage. */
  private emitStrInit(): void {
    for (const n of this.strLocals) this.emit(`store ptr null, ptr ${this.addr(n)}`);
  }
  /** Release owned string locals at scope exit (except one transferred out). */
  private emitStrDrops(exclude?: string): void {
    for (const n of this.strLocals) {
      if (n === exclude) continue;
      const p = this.fresh();
      this.emit(`${p} = load ptr, ptr ${this.addr(n)}`);
      this.emit(`call void @nt_str_release(ptr ${p})`);
    }
  }

  /** Generate a statement sequence, stopping once the block is terminated
   *  (so code after return/break/continue isn't emitted as unreachable IR). */
  private genStmts(list: Stmt[]): void {
    // Every statement list is a scope entry, whether or not it has a marker: the depth
    // arithmetic a jump does is RELATIVE (from here down to its target's depth), so a
    // list with no drops contributing an empty entry costs nothing and keeps the two
    // stacks in step without `genStmts` having to know which lists the ownership pass
    // chose to call `scoped()` on. `dropsOf` reads the marker, which is always LAST.
    this.blockScopes.push(dropsOf(list));
    for (const s of list) {
      if (this.isTerminated()) break;
      this.genStmt(s);
    }
    this.blockScopes.pop();
  }

  /**
   * Unwind block scopes for a `break`/`continue`: free the linear locals of every scope
   * between here and `depth`, innermost first — the order `ownedInScope` builds a
   * `return`'s list in, and the reverse of construction.
   *
   * This does NOT need a fresh move analysis, and that is the load-bearing claim. The
   * names come from the block's own `BlockDrops`, which `droppable` already filtered:
   * a name moved on EVERY path is absent from the list, and a name moved on SOME path is
   * in `condDrops`, so `nullOnMove` stores null into its slot at the move site and
   * `nt_arr_free(NULL)`/`nt_obj_free(NULL)` are no-ops. The pointer IS the drop flag.
   * The jump therefore frees exactly what the fall-through out of the same block would
   * have freed, which is the property that makes it a leak fix rather than a new
   * double-free surface.
   *
   * The one case it under-frees is a name moved unconditionally AFTER the jump: it is
   * `must`-moved at the end of the block, so it is in no list, yet the jump's path never
   * reached the move. That leaks exactly as it did before this existed.
   */
  private emitJumpDrops(depth: number): void {
    for (let i = this.blockScopes.length - 1; i >= depth; i--) this.emitDrops(this.blockScopes[i] ?? []);
  }

  /** Drops for the snapshot scopes `[low, high)`, innermost first — the segment of a
   *  jump's unwind that lies between two finalizers, replayed from the snapshot because
   *  `blockScopes` has long since popped it by the time the resume block is emitted. */
  private emitSnapshotDrops(scopes: string[][], high: number, low: number): void {
    for (let i = high - 1; i >= low; i--) this.emitDrops(scopes[i] ?? []);
  }

  /**
   * Lower a `break`/`continue`: unwind to `targetDepth` and branch to `targetLbl`, RUNNING
   * every finalizer between here and `targetFin` on the way, innermost first.
   *
   * With nothing crossed this is the plain branch it always was. With one or more `try`s
   * crossed the jump cannot branch to its target at all — it has to reach the innermost
   * finalizer, let it run, and be resumed by its dispatch, which may in turn hand it to
   * the next finalizer out. So the jump stores an id and parks a `PendingExit`; the
   * `TryStmt` case pays it off when it writes the dispatch.
   *
   * The drops INTERLEAVE with the finalizers rather than all happening first, which is
   * the property that makes this compose with the block-scope unwinding beside it: a
   * local declared inside the `try` is still live while that `try`'s finalizer runs, and
   * a local declared outside it is not freed until the finalizer is done.
   */
  private emitJump(targetDepth: number, targetFin: number, targetLbl: string): void {
    const nCross = this.finallyStack.length - targetFin;
    if (nCross <= 0) {
      this.emitJumpDrops(targetDepth);
      this.terminate(`br label %${targetLbl}`);
      return;
    }
    // Snapshot, because the resume blocks are emitted after these scopes have popped.
    const scopes = this.blockScopes.map((names) => names);
    const chain = this.finallyStack.slice(targetFin); // outermost .. innermost
    const inner = chain[nCross - 1]!;
    this.emitSnapshotDrops(scopes, scopes.length, inner.scopeDepth);
    this.enterFinally(scopes, chain, nCross - 1, targetLbl, targetDepth);
  }

  /** Store a fresh dispatch id into `chain[idx]`'s mode slot, park the exit on it under
   *  that id, and branch into the finalizer. The id is minted here so the jump site and
   *  every resume block after it share one spelling of "hand this exit to that one". */
  private enterFinally(scopes: string[][], chain: FinallyFrame[], idx: number, targetLbl: string, targetDepth: number): void {
    const f = chain[idx]!;
    const mode = this.jumpMode++;
    this.emit(`store double ${llvmDouble(mode)}, ptr ${f.modeSlot}`);
    this.jumpExits.push({ frameId: f.id, mode, scopes, chain, idx, targetLbl, targetDepth });
    this.terminate(`br label %${f.finallyLbl}`);
  }

  /** The exits parked on `f`, in the order they were parked — the order the dispatch
   *  tests them in, which keeps the emitted IR deterministic. */
  private exitsOn(f: FinallyFrame): PendingExit[] {
    return this.jumpExits.filter((ex) => ex.frameId === f.id);
  }

  /** The resume block for one pending exit, emitted after its finalizer's body: finish
   *  the segment of unwinding this finalizer was blocking, then either hand the exit to
   *  the next finalizer out or land on the jump's real target. */
  private emitResume(ex: PendingExit): void {
    const here = ex.chain[ex.idx]!.scopeDepth;
    const next = ex.idx - 1;
    if (next >= 0) {
      const outer = ex.chain[next]!;
      this.emitSnapshotDrops(ex.scopes, here, outer.scopeDepth);
      this.enterFinally(ex.scopes, ex.chain, next, ex.targetLbl, ex.targetDepth);
      return;
    }
    this.emitSnapshotDrops(ex.scopes, here, ex.targetDepth);
    this.terminate(`br label %${ex.targetLbl}`);
  }

  /** Emit deterministic drops (RAII frees) for owned linear locals. */
  /** Set while generating a LIFTED arrow body (`@arrow_N`). The ownership pass walks
   *  arrow bodies inside their enclosing function, so a `return` inside a block-bodied
   *  arrow carries the ENCLOSING scope's drop list — locals that do not exist (and are
   *  not owned) in the lifted function. Dropping them there emitted a load of an
   *  undefined `%x.addr` (clang: "use of undefined value").
   *
   *  That used to suppress drops in a lifted arrow ENTIRELY, which is not conservative —
   *  it is a leak. An arrow body is a frame of its own, and the enclosing owner it was
   *  said to defer to does not own the arrow's locals at all: `declaredLinear` never
   *  descends into an arrow, so an arrow-body local appears in NO other scope's drop
   *  set and nothing ever freed it. Every value a closure allocated leaked, once per
   *  call — and because `spawn` takes a CLOSURE, that is every actor message a receiver
   *  ever consumes (`test/fuzz2-diff.test.ts`, one object per message DELIVERED at every
   *  scale; the same body written as a `function` was already clean).
   *
   *  The precise question was never "is this a lifted arrow" but "does this name have
   *  storage in THIS frame": `frameLocals` answers it, so an enclosing-scope name in a
   *  `return`'s drop list is skipped (no slot here, nothing owned) and the arrow's own
   *  locals are freed exactly where the ownership pass says. */
  private liftedArrow = false;

  /** Names DECLARED in this frame (`addLocal`), so each has an `%n.addr` alloca here.
   *  Parameters are deliberately excluded — they are borrows the caller drops, and an
   *  arrow parameter that SHADOWS an enclosing linear local would otherwise be freed by
   *  that local's name appearing in a `return`'s enclosing-scope drop list. */
  private frameLocals = new Set<string>();

  /** In a lifted arrow that may call ITSELF (`const walk = (s: Stmt): void => { … walk(…) … }`):
   *  the name it is bound to, and its function type. The self-call needs NO new machinery —
   *  `%__clo` is already the first parameter of every lifted arrow and already holds this
   *  very closure, so the call is the ordinary `callClosure` sequence with `%__clo` as the
   *  receiver. Deliberately NOT a capture: see `computeCaptures` in src/checker.ts for why
   *  snapshotting the name instead would read the binding's slot before it is stored. */
  private selfArrow: { name: string; ty: Ty } | null = null;

  /** Suppress preemption safepoints in this function (B3 v5 message renderers run from
   *  inside the runtime's crash-record printer — yielding there would be catastrophic). */
  private noSafepoints = false;

  /** Set while lowering a CONSUMING APPEND `x = [...x, e]` (B2 step 4 transients): the
   *  spread source is the assignment's own dying value, so its storage is MOVED into
   *  the new array instead of copied+retained. `consumeNode` is the exact `...x`
   *  element (identity-compared, so a second `...x` in the same literal still copies);
   *  `consumeTaken` is set once the spread actually took the storage, and is what
   *  `emitDropOld` reads to skip the assignment's `dropOld`.
   *
   *  There used to be a second field here, `consumedAssign = e`, described as recording
   *  the same fact. It was never DECLARED and never READ — a write to a property that
   *  existed only because bun creates one on assignment, invisible until tsc first
   *  checked this project (TS2339). `consumeTaken` is the mechanism; that was a vestige
   *  of an earlier design, and removing it changes no emitted IR. */
  private consumeNode: Expr | null = null;
  private consumeTaken = false;

  private emitDrops(names: string[]): void {
    for (const n of names) {
      // In a lifted arrow the list may name locals of the ENCLOSING scope (see
      // `liftedArrow`); those have no slot here and this frame owns nothing of theirs.
      if (this.liftedArrow && !this.frameLocals.has(n)) continue;
      const p = this.fresh();
      this.emit(`${p} = load ptr, ptr ${this.addr(n)}`);
      // Move-aware RAII: objects free via nt_obj_free, arrays via nt_arr_free.
      // A CLOSURE ENV is an object too — `nt_obj_new(1 + caps.length)`, a bare slot
      // block with no `NtArray` header — and freeing one as an array frees two words
      // past its end (the wild free that made function types non-linear in the first
      // place; see `nonEscapingClosures` in ownership.ts). Shallow, as everywhere here:
      // the capture slots alias values their own scope owns and drops.
      const dropTy = this.varTypes.get(n) ?? "number";
      const free = isObjectTy(dropTy) || isUnionTy(dropTy) || isTypeRefTy(dropTy) || isFuncTy(dropTy) ? "nt_obj_free" : "nt_arr_free"; // a union IS an object block (SH2); so is a recursive node, and so is a closure env
      this.emit(`call void @${free}(ptr ${p})`);
    }
  }

  /** Free the value a linear local is about to lose to an assignment (see AssignExpr).
   *  A no-op unless the ownership pass proved the old value dead; skipped inside a
   *  lifted arrow for the same reason drops are (the slot may not exist there), and
   *  skipped when the consuming-append transient already took ownership of it. */
  private emitDropOld(e: AssignExpr, ty: Ty): void {
    if (this.consumeTaken) { this.consumeTaken = false; return; } // storage moved into the new version
    if (!e.dropOld || this.liftedArrow || !(isArrayTy(ty) || isObjectTy(ty))) return;
    // A MODULE-LEVEL binding promoted to an LLVM global is one that some function body
    // reads — and such a function may have returned the pointer to a caller that still
    // holds it. The ownership pass cannot see that aliasing (it analyses one scope at a
    // time), so a global is never freed on reassignment: a documented leak, never a UAF.
    if (this.globalVars.has(e.target)) return;
    const p = this.fresh();
    this.emit(`${p} = load ptr, ptr ${this.addr(e.target)}`);
    this.emit(`call void @${isObjectTy(ty) || isUnionTy(ty) ? "nt_obj_free" : "nt_arr_free"}(ptr ${p})`);
  }

  /** Free the RECEIVER of an array method when the receiver was an unbound TEMPORARY
   *  (`"a,b".split(",").length`, `xs.map(f).filter(g)`): no binding owns it, so the
   *  drop pass never sees it — this is the statement-scoped half of RAII.
   *
   *  Both halves of the rule are syntactic and conservative:
   *   - the receiver must be a FRESH array producer (`freshArray`) — a plain function
   *     call is excluded, since it may return an array the callee still owns;
   *   - the method must not hand the receiver back (`.reverse` mutates in place and
   *     returns it, exactly like node), and the result must not BE the receiver.
   *  Element pointers (strings/objects the result copied) are never freed here — the
   *  header is all this owns. Anything not matching just leaks, as it did before. */
  private freeReceiverTemp(objExpr: Expr, recv: Val, method: string, out: Val): void {
    if (!freshArray(objExpr) || RETAINS_RECEIVER.has(method) || out.v === recv.v) return;
    this.emit(`call void @nt_arr_free(ptr ${recv.v})`);
  }

  /**
   * The ARGUMENT-POSITION half of the same rule — `f({a: 1})`, which leaked one object
   * per call, without bound, in the most idiomatic shape TypeScript has. A literal
   * written directly in an argument position has NO NAME, so no drop set can refer to
   * it: `ownedInScope`/`ownedTopLevel` walk `this.scopes`, which hold declared locals.
   * The caller therefore has to free it right here, the way it already frees an unbound
   * method receiver just above.
   *
   * The license to free is that A PARAMETER CANNOT ESCAPE ITS CALLEE. Every route out
   * is already NT1604 ("cannot move out of `o`: it is borrowed") — `return o`, `g = o`,
   * `return new Box(o)`, `return [o]` are each refused today, so when the call returns
   * nothing in the program can still be pointing at the temporary. That refusal is what
   * this rule rests on; if a parameter ever becomes movable, this must be revisited.
   *
   * Four conditions, all syntactic or identity-checked, and all load-bearing:
   *  - the argument is written as a LITERAL at the call site. A named local is the
   *    caller's own owned binding (the drop pass frees it, and freeing here would be a
   *    double free); a plain call may hand back a value its callee still owns.
   *  - the parameter's type is the literal's own aggregate type, so the pointer passed
   *    is the pointer allocated — this is what excludes `Dyn`, a general union and a
   *    nullable, whose boxes RETAIN the literal inside a second allocation.
   *  - `coerce` was the IDENTITY (`co.v === raw.v`). The type test above should imply
   *    it, but this checks the actual fact rather than a prediction of it: any present
   *    or future coercion that allocates a wrapper around the pointer fails this and the
   *    temporary is simply left to leak, as it did before.
   *  - argument 0 of a pre-lowered call is the RECEIVER, which the caller owns.
   *
   * The free is SHALLOW, like every other one here: an object-typed field's target and
   * a string slot survive it. That is the separate, known shallowness of `nt_obj_free`,
   * not a defect of this rule — it leaks, it never dangles.
   *
   * A callee that RAISES branches to its `catch` before reaching the free, so the
   * temporary leaks on the exceptional path. Conservative in the safe direction, and the
   * reason the free is emitted before `emitExcCheck` rather than after: the pending
   * payload can never BE this temporary (moving a parameter onto it is NT1604 too).
   */
  private argTempFree(i: number, args: Expr[], preArg0: string, sig: Sig, raw: Val, co: Val): string | null {
    if (i >= args.length || (i === 0 && preArg0 !== "") || co.v !== raw.v) return null;
    const pt = sig.params[i]!;
    const k = args[i]!.kind;
    if (k === "ObjectLiteral" && isObjectTy(pt)) return "nt_obj_free";
    if (k === "ArrayLiteral" && isArrayTy(pt)) return "nt_arr_free";
    return null;
  }

  /** Emit the frees `argTempFree` selected, once the call has returned.
   *
   *  A RECORD per entry, not a `[string, string]` tuple. The tuple read back as
   *  `string[][]`, so the destructuring `for (const [free, v] of frees)` was NT1007
   *  ("only Map entries are supported") — a self-host blocker — and the two fields were
   *  positional at four push sites, where nothing marked which string was the free
   *  function and which was the pointer. */
  private emitArgTempFrees(frees: { free: string; v: string }[]): void {
    for (const f of frees) this.emit(`call void @${f.free}(ptr ${f.v})`);
  }

  /** The CLASS-INSTANCE half of the rule above — `new P(7).get()`, which leaked 200
   *  objects in the loop the array shape leaked none in. Stage 41 wired the array branch
   *  only, and a class call never reaches it: it lowers to `C.m(inst, …)` through
   *  `genUserCall`, several hundred lines earlier in the dispatch.
   *
   *  The array rule's second half — "the method must not hand the receiver back" — is
   *  checked there by POINTER IDENTITY (`out.v === recv.v`), and that check is blind
   *  here: a lowered call returns a fresh SSA name whatever it returns. So freshness is
   *  proved statically instead, from two facts:
   *
   *   - `new C(…)` is an allocation nothing else can name, and `this` is PARAMETER 0 —
   *     a BORROW. Storing it anywhere that outlives the call (`G = this`, `[this]`, a
   *     container field) is already NT1604, so the pointer cannot escape the body;
   *   - the one sanctioned way it does leave is `return this`, which a `@@mutable`
   *     setter does — and a method that returns its receiver has the receiver's CLASS as
   *     its return type. Gating on `classTag(sig.ret) !== cls` excludes exactly that
   *     shape. A union/`Dyn` return is excluded too: an arm of it could be the class.
   *
   *  `nt_obj_free` frees the receiver's slot array and nothing it points at (the same
   *  header-only contract `nt_arr_free` has), so a method returning a FIELD is safe —
   *  the field's pointee is a separate block. Anything not matching just leaks, as
   *  before: a leak, never a double free. */
  private freeReceiverObjTemp(objExpr: Expr, recv: string | undefined, cls: string, fn: string): void {
    if (recv === undefined || objExpr.kind !== "NewExpr" || this.liftedArrow) return;
    const ret = this.mod.functions.get(fn)?.ret;
    if (ret === undefined) return;
    if (classTag(ret) === cls || isUnionTy(ret) || isGeneralUnionTy(ret) || ret === "Dyn") return;
    this.emit(`call void @nt_obj_free(ptr ${recv})`);
  }

  /** The CONSUMING-APPEND pattern `x = [...x, e1, …]` (B2 step 4). Requires the
   *  ownership pass's `dropOld` proof (x is owned here and no closure captured it),
   *  a LEADING spread of exactly the assignment target, and no other mention of `x`
   *  in the literal — so the storage really is dead once the spread has read it.
   *  Returns the `...x` element node (identity-matched later), or null. */
  private consumingSpread(e: AssignExpr, ty: Ty): Expr | null {
    if (!e.dropOld || this.liftedArrow || !isArrayTy(ty)) return null;
    if (this.captures.has(e.target) || this.globalVars.has(e.target)) return null;
    const lit = e.value;
    if (lit.kind !== "ArrayLiteral" || lit.elements.length === 0) return null;
    const head = lit.elements[0]!;
    if (head.kind !== "SpreadExpr" || head.argument.kind !== "Identifier" || head.argument.name !== e.target) return null;
    for (let i = 1; i < lit.elements.length; i++) if (mentions(lit.elements[i]!, e.target)) return null;
    return head;
  }

  private addLocal(name: string, ty: Ty): void {
    if (this.varTypes.has(name)) return;
    this.varTypes = this.varTypes.set(name, ty);
    // A promoted module-level binding lives in its LLVM global, not a frame slot.
    if (!this.globalVars.has(name)) { this.alloca(name, ty); this.frameLocals = this.frameLocals.add(name); }
  }

  private collectLocals(body: Stmt[]): void {
    for (const s of body) {
      switch (s.kind) {
        case "VarDecl":
          for (const d of s.decls) {
            this.addLocal(d.name, d.ty ?? "number");
            if ((d.ty ?? "number") === "string") this.strLocals = this.strLocals.add(d.name);
          }
          break;
        case "IfStmt":
          this.collectLocals(s.consequent);
          if (s.alternate) this.collectLocals(s.alternate);
          break;
        case "WhileStmt": this.collectLocals(s.body); break;
        case "DoWhileStmt": this.collectLocals(s.body); break;
        case "ForStmt":
          if (s.init && (s.init as VarDecl).kind === "VarDecl") this.collectLocals([s.init as VarDecl]);
          this.collectLocals(s.body);
          break;
        case "ForOfStmt":
          this.addLocal(s.name, s.elemTy ?? "string");
          if (s.name2) this.addLocal(s.name2, s.valTy ?? "number"); // `for (const [k, v] of map)`
          this.collectLocals(s.body);
          break;
        case "ForInStmt":
          this.addLocal(s.name, "string");
          this.collectLocals(s.body);
          break;
        case "SwitchStmt":
          for (const c of s.cases) this.collectLocals(c.body);
          break;
        case "BlockStmt": this.collectLocals(s.body); break;
        case "MultiStmt": this.collectLocals(s.stmts); break;
        case "TryStmt":
          if (s.param) this.addLocal(s.param, s.catchTy ?? "string");
          // A string-typed `catch` binding is a STRING LOCAL like any other: zero-inited
          // (so the normal path releases a null, a no-op) and released at scope exit.
          // It was not one before, which was invisible only because every message that
          // could reach it was UNTRACKED — a literal, or one of the runtime's
          // `nativets_alloc`ed-but-unregistered buffers, for which release does nothing.
          // A cross-frame `throw` can now hand it a REGISTERED heap string, and an owner
          // that never releases is a leak proportional to the number of throws.
          if (s.param && (s.catchTy ?? "string") === "string") this.strLocals = this.strLocals.add(s.param);
          this.collectLocals(s.block);
          if (s.handler) this.collectLocals(s.handler);
          if (s.finalizer) this.collectLocals(s.finalizer);
          break;
        default: break;
      }
    }
  }

  // ---- functions ----
  /** This frame may let a `throw` LEAVE it (see `scanEscaping`). False in `main`, in a
   *  lifted arrow, and in every function whose callers were not all proved to check. */
  private canEscape = false;

  genFunction(fn: FuncDecl): string {
    this.reset();
    this.canEscape = this.mod.escaping.has(fn.name);
    const sig = this.mod.functions.get(fn.name)!;
    // The RESOLVED return type comes from the signature table, which is where the checker
    // records it. It used to be read from `fn.returnTy`, a second copy of `sig.ret` that
    // the checker kept in sync with four in-place record writes (each one `NT1606` when
    // this compiler checks itself).
    this.retTy = sig.ret;
    fn.params.forEach((p, i) => {
      const ty = sig.params[i]!;
      this.varTypes = this.varTypes.set(p.name, ty);
      this.alloca(p.name, ty);
    });
    this.collectLocals(fn.body);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    fn.params.forEach((p, i) => {
      const ty = sig.params[i]!;
      this.emit(`store ${llvmTy(ty)} %${p.name}, ptr ${this.addr(p.name)}`);
    });
    // COPY-ON-WRITE setter (decorators lane): an ordinary class's field-assigning method
    // operates on a fresh SHALLOW copy of the receiver, so the caller's instance is
    // untouched and `return this` yields the new one. Emitted inline (a constant number
    // of slots), so no runtime function and no link gate. Slots are copied verbatim: a
    // heap-valued field is shared with the original, which is the same convention every
    // other container follows (a container frees its handle, never its elements) — a
    // residual leak at worst, never a double free.
    if (fn.copyThis) this.emitThisCopy(sig.params[0]!);
    this.emitStrInit();
    this.genStmts(fn.body);
    if (!this.isTerminated()) {
      this.emitDrops(fn.endDrops ?? []);
      this.emitStrDrops();
      this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
    }
    const params = fn.params.map((p, i) => `${llvmTy(sig.params[i]!)} %${p.name}`).join(", ");
    return this.assemble(`define ${llvmTy(this.retTy)} @${userSym(fn.name)}(${params})`, b0);
  }

  /** `this = shallowCopy(this)` — the copy-on-write setter prologue (docs/decorators.md). */
  private emitThisCopy(thisTy: Ty): void {
    const n = objectFields(thisTy).length;
    const src = this.fresh();
    this.emit(`${src} = load ptr, ptr ${this.addr("this")}`);
    const dst = this.fresh();
    this.emit(`${dst} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(n, 1))})`);
    for (let i = 0; i < n; i++) {
      const sp = this.fresh(), v = this.fresh(), dp = this.fresh();
      this.emit(`${sp} = getelementptr i64, ptr ${src}, i64 ${i}`);
      this.emit(`${v} = load i64, ptr ${sp}`);
      this.emit(`${dp} = getelementptr i64, ptr ${dst}, i64 ${i}`);
      this.emit(`store i64 ${v}, ptr ${dp}`);
    }
    this.emit(`store ptr ${dst}, ptr ${this.addr("this")}`);
  }

  genMain(body: Stmt[], endDrops: string[]): string {
    this.reset();
    this.retTy = "number";
    this.inMain = true;
    // `main` owns the module-level declarations, so its storage for them IS the global.
    this.globalVars = new Set(this.mod.globals.keys());
    this.collectLocals(body);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    // Host I/O: stash argc/argv into runtime globals so process.argv can read them.
    this.emit(`call void @nt_init_args(i32 %argc, ptr %argv)`);
    // Bring up the v0 actor scheduler + actor 0 (main) before any actor call.
    if (this.mod.usesActors) this.emit(`call void @nt_sched_init()`);
    this.emitStrInit();
    this.genStmts(body);
    if (!this.isTerminated()) { this.emitDrops(endDrops); this.emitStrDrops(); this.terminate("ret i32 0"); }
    return this.assemble("define i32 @main(i32 %argc, ptr %argv)", b0);
  }

  /** Generate a lifted arrow `define <ret> @name(ptr %__clo, params) { ... }`. */
  genArrow(name: string, arrow: ArrowFunction): string {
    this.reset();
    this.liftedArrow = true; // see `liftedArrow`: enclosing-scope drops don't apply here
    this.retTy = arrow.retTy ?? "number";
    const paramTys = arrow.paramTys ?? [];
    this.captures = new Map((arrow.captures ?? []).map((c, i) => [c.name, { index: i, ty: c.ty }]));
    // A parameter of the same name SHADOWS the binding (JS, and `typeArrow` agrees by not
    // declaring it), so it is not a self-call site — `%__clo` would be the wrong callee.
    // `const` first, then compare: `p.name === arrow.selfName` would be `string` against
    // `string | undefined`, which is NT2001 in the subset this compiler compiles.
    const selfName = arrow.selfName;
    const selfTy = arrow.ty;
    this.selfArrow = selfName !== undefined && selfTy !== undefined
      && !arrow.params.some((p) => p.name === selfName)
      ? { name: selfName, ty: selfTy } : null;
    arrow.params.forEach((p, i) => { this.varTypes = this.varTypes.set(p.name, paramTys[i]!); this.alloca(p.name, paramTys[i]!); });
    if (!arrow.exprBody) this.collectLocals(arrow.stmts as Stmt[]);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    arrow.params.forEach((p, i) => this.emit(`store ${llvmTy(paramTys[i]!)} %${p.name}, ptr ${this.addr(p.name)}`));
    this.emitStrInit();
    if (arrow.exprBody) {
      // An expression body IS the arrow's `return`, so it needs the same store-boundary
      // coercion a `return` statement gets (`genStmts`, ReturnStmt) — without it a
      // declared `T | null` return whose body is the non-null arm emitted a raw scalar
      // where the signature promises a box.
      const bodyVal = this.coerce(this.genExpr(arrow.body as Expr), this.retTy);
      this.terminate(`ret ${llvmTy(this.retTy)} ${bodyVal.v}`);
    } else {
      this.genStmts(arrow.stmts as Stmt[]);
      if (!this.isTerminated()) { this.emitStrDrops(); this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`); }
    }
    const params = ["ptr %__clo", ...arrow.params.map((p, i) => `${llvmTy(paramTys[i]!)} %${p.name}`)].join(", ");
    return this.assemble(`define ${llvmTy(this.retTy)} @${name}(${params})`, b0);
  }

  /** B3 v5: generate a structured-message renderer `ptr @name(i64 %slot)` — unpack the
   *  slot as `ty` and JSON-render it (the same walk `JSON.stringify` uses). Safepoints
   *  are suppressed: this runs from the runtime while it is printing a crash record, so
   *  it must never yield to the scheduler mid-record. */
  genMsgRender(name: string, ty: Ty): string {
    this.reset();
    this.liftedArrow = true;
    this.noSafepoints = true;
    this.retTy = "string";
    const b0 = this.block(this.label("L"));
    this.to(b0);
    const v = this.fromSlot("%slot", ty);
    const s = this.genJsonStringify({ v, ty });
    this.terminate(`ret ptr ${s.v}`);
    return this.assemble(`define ptr @${name}(i64 %slot)`, b0);
  }

  private assemble(header: string, firstBlock: number): string {
    //@@mutable
    const out: string[] = [`${header}${asanFnAttr()} {`, "entry:"];
    for (const a of this.entryAllocas) out.push("  " + a);
    out.push(`  br label %${this.blocks[firstBlock]!.label}`);
    for (const b of this.blocks) {
      out.push(`${b.label}:`);
      // A loop, not `out.push(...b.lines)`. The spread is NT1006 (a self-host blocker),
      // and spreading into a variadic call passes one ARGUMENT per line — a block with
      // enough lines overflows the call stack in the bun-hosted stage-0 too.
      for (const line of b.lines) out.push(line);
    }
    out.push("}");
    return out.join("\n");
  }

  // ---- statements ----
  private genStmt(s: Stmt): void {
    switch (s.kind) {
      case "VarDecl": {
        for (const d of s.decls) {
          const ty = d.ty ?? "number";
          // A bare `let x: T;` has no initializer. Store the slot's DEFAULT ZERO — not
          // the `undefined` literal, whose `0` is ill-typed for a `double` or a `ptr`
          // slot. The checker has already proved the binding is assigned before any read
          // (definite assignment), so this zero is never observed; it only keeps the slot
          // well-defined. Nothing is retained: no value has been bound yet.
          if (!d.init) {
            this.emit(`store ${llvmTy(ty)} ${defaultZero(ty)}, ptr ${this.addr(d.name)}`);
            continue;
          }
          const val = this.coerce(this.genExpr(d.init), ty);
          // RC: an aliased string (identifier/field/index/literal) gains a new owner
          // → retain. A fresh producer is consumed (its rc=1 transfers to this local).
          if (ty === "string" && this.strLocals.has(d.name)) this.retainStrBind(d.init, val.v);
          this.emit(`store ${llvmTy(ty)} ${val.v}, ptr ${this.addr(d.name)}`);
        }
        return;
      }
      case "ExprStmt": {
        // `Object.keys(o);`, `a.concat(b);` and `JSON.stringify(o);` each allocated a
        // value the statement then threw away, leaking it once per evaluation without
        // bound. See `discardFree` for why freshness is marked at the point the value is
        // BUILT rather than recognised by shape here.
        this.discardFree = null;
        const v = this.genExpr(s.expr);
        // Through a method, not a field read: `this.discardFree = null` above NARROWS the
        // field to `null` for the rest of the block, and TypeScript does not widen it back
        // across the `genExpr` call — so reading it inline typed the claim `never`. The
        // method's declared return type is the honest one.
        const claim = this.takeDiscardFree();
        if (claim !== null && claim.v === v.v) this.emit(`call void @${claim.call}(ptr ${v.v})`);
        return;
      }
      case "ReturnStmt": {
        // Inside an inlined HOF block callback: a `return` yields the per-element
        // result — store it and branch to the callback's join (not a function ret).
        if (this.hofReturnStack.length > 0 && this.finallyStack.length === 0) {
          const h = this.hofReturnStack[this.hofReturnStack.length - 1]!;
          // `.forEach`: node discards the result, so there is no slot — but the returned
          // expression is still evaluated, because it may be the effect the loop is for.
          if (h.discard ?? false) {
            if (s.argument) this.genExpr(s.argument);
            this.terminate(`br label %${h.done}`);
            return;
          }
          const v = s.argument ? this.coerce(this.genExpr(s.argument), h.ty) : { v: defaultZero(h.ty), ty: h.ty };
          this.emit(`store ${llvmTy(h.ty)} ${v.v}, ptr ${h.slot}`);
          this.terminate(`br label %${h.done}`);
          return;
        }
        const fin = this.innermostFinally();
        if (fin !== null) {
          // return inside a try/catch with a finally: stash value, run finally (mode=1)
          const f = fin;
          // Coerced to the DECLARED return type, exactly as the ordinary return path
          // below is. Without this the stash STORED the raw value under the declared
          // type's LLVM type: `function g(): string | boolean { try { return "hi" } finally {…} }`
          // wrote a bare string pointer into a slot the caller reads as a [tag,value]
          // box (exit 255, empty stdout, where node prints the string), and a `double`
          // arm did not even survive `llvm-as`. A no-op when the types already match.
          if (s.argument && f.retSlot) { const v = this.coerce(this.genExpr(s.argument), this.retTy); this.emit(`store ${llvmTy(this.retTy)} ${v.v}, ptr ${f.retSlot}`); }
          this.emit(`store double ${llvmDouble(1)}, ptr ${f.modeSlot}`);
          this.terminate(`br label %${f.finallyLbl}`);
          return;
        }
        if (s.argument) {
          // Coerced to the DECLARED return type, exactly as the HOF-callback return above
          // is: `function f(): number | string { return 7 }` boxes the arm here. Done
          // BEFORE the drops so the box's `toSlot` retain happens while the value is
          // still live; a no-op when the types already match.
          const val = this.coerce(this.genExpr(s.argument), this.retTy);
          this.emitDrops(s.drops ?? []); // free owned locals before returning (not the moved-out value)
          // RC strings: a returned local TRANSFERS its ownership to the caller (exclude it
          // from release). A returned borrow (param/field/index) is retained so the caller
          // gets an owned +1; a returned producer already carries its rc=1 and escapes.
          if (val.ty === "string") {
            const arg = s.argument;
            const xfer = arg.kind === "Identifier" && this.strLocals.has(arg.name) ? arg.name : undefined;
            if (!xfer && !this.isStrProducer(arg)) this.emit(`%rc${this.tmp++} = call ptr @nt_str_retain(ptr ${val.v})`);
            this.emitStrDrops(xfer);
          } else {
            this.emitStrDrops();
          }
          this.terminate(`ret ${llvmTy(val.ty)} ${val.v}`);
        } else {
          this.emitDrops(s.drops ?? []);
          this.emitStrDrops();
          this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
        }
        return;
      }
      case "IfStmt": {
        const cond = this.genCond(s.test);
        const thenLbl = this.label("then");
        const endLbl = this.label("endif");
        const elseLbl = s.alternate ? this.label("else") : endLbl;
        this.terminate(`br i1 ${cond}, label %${thenLbl}, label %${elseLbl}`);
        const thenIdx = this.block(thenLbl);
        this.to(thenIdx);
        this.genStmts(s.consequent);
        if (!this.isTerminated()) this.terminate(`br label %${endLbl}`);
        if (s.alternate) {
          const elseIdx = this.block(elseLbl);
          this.to(elseIdx);
          this.genStmts(s.alternate);
          if (!this.isTerminated()) this.terminate(`br label %${endLbl}`);
        }
        this.to(this.block(endLbl));
        return;
      }
      case "WhileStmt": {
        const condLbl = this.label("while");
        const bodyLbl = this.label("body");
        const endLbl = this.label("endwhile");
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        const cond = this.genCond(s.test);
        this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(bodyLbl));
        // Both depths are the CURRENT one: the body's own scope is pushed by the
        // `genStmts` below, so a jump inside the body unwinds it and every block nested
        // in it. A real loop is the one place `break` and `continue` agree (see `loops`).
        this.loops.push({ brk: endLbl, cont: condLbl, brkDepth: this.blockScopes.length, contDepth: this.blockScopes.length, brkFin: this.finallyStack.length, contFin: this.finallyStack.length });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.isTerminated()) this.terminate(`br label %${condLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "ForStmt": {
        if (s.init) {
          if ((s.init as VarDecl).kind === "VarDecl") this.genStmt(s.init as VarDecl);
          else this.genExpr(s.init as Expr);
        }
        const condLbl = this.label("for");
        const bodyLbl = this.label("forbody");
        const updLbl = this.label("forupd");
        const endLbl = this.label("endfor");
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        if (s.test) {
          const cond = this.genCond(s.test);
          this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        } else {
          this.terminate(`br label %${bodyLbl}`);
        }
        this.to(this.block(bodyLbl));
        this.loops.push({ brk: endLbl, cont: updLbl, brkDepth: this.blockScopes.length, contDepth: this.blockScopes.length, brkFin: this.finallyStack.length, contFin: this.finallyStack.length });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.isTerminated()) this.terminate(`br label %${updLbl}`);
        this.to(this.block(updLbl));
        if (s.update) this.genExpr(s.update);
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "DoWhileStmt": {
        const bodyLbl = this.label("do");
        const condLbl = this.label("docond");
        const endLbl = this.label("enddo");
        this.terminate(`br label %${bodyLbl}`);
        this.to(this.block(bodyLbl));
        // Both depths are the CURRENT one: the body's own scope is pushed by the
        // `genStmts` below, so a jump inside the body unwinds it and every block nested
        // in it. A real loop is the one place `break` and `continue` agree (see `loops`).
        this.loops.push({ brk: endLbl, cont: condLbl, brkDepth: this.blockScopes.length, contDepth: this.blockScopes.length, brkFin: this.finallyStack.length, contFin: this.finallyStack.length });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.isTerminated()) this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        const cond = this.genCond(s.test);
        this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "ForOfStmt": {
        // `for (const [k, v] of map)`: the checker left `iterable` as the MAP, so
        // walk its insertion-ordered key array and look each value up per step.
        const mapV = s.name2 ? this.genExpr(s.iterable) : null;
        const src = mapV
          ? (() => { const a = this.fresh(); this.emit(`${a} = call ptr @nt_coll_keys(ptr ${mapV.v})`); return { v: a, ty: makeArrayTy(s.elemTy ?? "string") }; })()
          : this.genExpr(s.iterable);
        const isStr = src.ty === "string";
        const isBytes = isBytesTy(src.ty);
        const el = s.elemTy ?? "string";
        const idx = this.slot("number");
        this.emit(`store double 0x0000000000000000, ptr ${idx}`);
        const lenT = this.fresh();
        this.emit(`${lenT} = call double @${isStr ? "js_str_len" : isBytes ? "nt_bytes_len" : "nt_arr_len"}(ptr ${src.v})`);
        const condLbl = this.label("of");
        const bodyLbl = this.label("ofbody");
        const updLbl = this.label("ofupd");
        const endLbl = this.label("endof");
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        const iC = this.fresh();
        this.emit(`${iC} = load double, ptr ${idx}`);
        const cmp = this.fresh();
        this.emit(`${cmp} = fcmp olt double ${iC}, ${lenT}`);
        this.terminate(`br i1 ${cmp}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(bodyLbl));
        const iB = this.fresh();
        this.emit(`${iB} = load double, ptr ${idx}`);
        if (isStr) {
          const ch = this.fresh();
          this.emit(`${ch} = call ptr @js_str_char_at(ptr ${src.v}, double ${iB})`);
          this.emit(`store ptr ${ch}, ptr ${this.addr(s.name)}`);
        } else if (isBytes) {
          const by = this.fresh();
          this.emit(`${by} = call double @nt_bytes_get(ptr ${src.v}, double ${iB})`);
          this.emit(`store double ${by}, ptr ${this.addr(s.name)}`);
        } else {
          const slot = this.fresh();
          this.emit(`${slot} = call i64 @nt_arr_get(ptr ${src.v}, double ${iB})`);
          this.emit(`store ${llvmTy(el)} ${this.fromSlot(slot, el)}, ptr ${this.addr(s.name)}`);
          if (mapV) { // entries: value = map.get(key) for this step's key slot
            const vt = s.valTy ?? "number";
            const vs = this.fresh();
            this.emit(`${vs} = call i64 @nt_map_get_slot(ptr ${mapV.v}, i32 ${this.keyTag(el)}, i64 ${slot})`);
            this.emit(`store ${llvmTy(vt)} ${this.fromSlot(vs, vt)}, ptr ${this.addr(s.name2!)}`);
          }
        }
        this.loops.push({ brk: endLbl, cont: updLbl, brkDepth: this.blockScopes.length, contDepth: this.blockScopes.length, brkFin: this.finallyStack.length, contFin: this.finallyStack.length });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.isTerminated()) this.terminate(`br label %${updLbl}`);
        this.to(this.block(updLbl));
        const iU = this.fresh();
        this.emit(`${iU} = load double, ptr ${idx}`);
        const iN = this.fresh();
        this.emit(`${iN} = fadd double ${iU}, 1.0`);
        this.emit(`store double ${iN}, ptr ${idx}`);
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(endLbl));
        // The ITERABLE temporary: `for (const x of [3,2,1])` iterates an array no
        // binding owns, so the drop pass never sees it and it leaked. Freed here, at
        // the single join point every exit lands on — including `break`, which
        // elsewhere deliberately jumps PAST drops but here cannot skip this one.
        //
        // Only a syntactically FRESH array (`freshArray`, the same judgment
        // `freeReceiverTemp` uses) — never a binding, whose owner drops it, and never a
        // plain call result, which the callee may still own. A `for (… of map)` walks a
        // key array `nt_coll_keys` just minted, which nothing else can reference.
        // Elements are not freed here, exactly as `nt_arr_free` never frees them.
        // A `return` out of the body still jumps past this: a leak, never a UAF.
        if (!isStr && !isBytes && (mapV !== null || freshArray(s.iterable))) {
          this.emit(`call void @nt_arr_free(ptr ${src.v})`);
        }
        return;
      }
      case "SwitchStmt": {
        const disc = this.genExpr(s.discriminant);
        const endLbl = this.label("endsw");
        // `_c` is spelled rather than omitted: a callback's parameters bind POSITIONALLY,
        // so a 0-parameter `.map` callback is an arity mismatch the checker refuses — one
        // of codegen.ts's self-host blockers. One label per case, none of them derived
        // from the case itself.
        const bodyLbls = s.cases.map((_c) => this.label("case"));
        const defaultIdx = s.cases.findIndex((c) => c.test === null);
        // A `switch` is a `break` target but NOT a `continue` target: a `continue` inside
        // one belongs to the enclosing loop, so its label AND its unwind depth are both
        // inherited. That is the whole reason the entry carries two depths. Inheriting
        // the label without the depth would unwind only as far as the switch and leave
        // the loop body's own locals leaking — half a fix, silently.
        const outer = this.loops.length ? this.loops[this.loops.length - 1]! : null;
        const outerCont = outer ? outer.cont : endLbl;
        const brkDepth = this.blockScopes.length;
        const brkFin = this.finallyStack.length;
        this.loops.push({ brk: endLbl, cont: outerCont, brkDepth, contDepth: outer ? outer.contDepth : brkDepth, brkFin, contFin: outer ? outer.contFin : brkFin });
        // dispatch chain
        for (let i = 0; i < s.cases.length; i++) {
          const c = s.cases[i]!;
          if (c.test === null) continue;
          const tv = this.genExpr(c.test);
          const m = this.compareEq(disc, tv);
          const nextLbl = this.label("disp");
          this.terminate(`br i1 ${m}, label %${bodyLbls[i]}, label %${nextLbl}`);
          this.to(this.block(nextLbl));
        }
        this.terminate(`br label %${defaultIdx >= 0 ? bodyLbls[defaultIdx] : endLbl}`);
        // bodies (fall through in source order)
        for (let i = 0; i < s.cases.length; i++) {
          this.to(this.block(bodyLbls[i]!));
          this.genStmts(s.cases[i]!.body);
          if (!this.isTerminated()) this.terminate(`br label %${i + 1 < s.cases.length ? bodyLbls[i + 1] : endLbl}`);
        }
        this.loops.pop();
        this.to(this.block(endLbl));
        return;
      }
      case "ForInStmt": {
        const o = this.genExpr(s.object);
        const arr = this.buildStringArray(objectFields(o.ty).map((f) => f.key)).v;
        const idx = this.slot("number");
        this.emit(`store double 0x0000000000000000, ptr ${idx}`);
        const lenT = this.fresh();
        this.emit(`${lenT} = call double @nt_arr_len(ptr ${arr})`);
        const condLbl = this.label("in");
        const bodyLbl = this.label("inbody");
        const updLbl = this.label("inupd");
        const endLbl = this.label("endin");
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        const iC = this.fresh();
        this.emit(`${iC} = load double, ptr ${idx}`);
        const cmp = this.fresh();
        this.emit(`${cmp} = fcmp olt double ${iC}, ${lenT}`);
        this.terminate(`br i1 ${cmp}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(bodyLbl));
        const iB = this.fresh();
        this.emit(`${iB} = load double, ptr ${idx}`);
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_arr_get(ptr ${arr}, double ${iB})`);
        this.emit(`store ptr ${this.fromSlot(slot, "string")}, ptr ${this.addr(s.name)}`);
        this.loops.push({ brk: endLbl, cont: updLbl, brkDepth: this.blockScopes.length, contDepth: this.blockScopes.length, brkFin: this.finallyStack.length, contFin: this.finallyStack.length });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.isTerminated()) this.terminate(`br label %${updLbl}`);
        this.to(this.block(updLbl));
        const iU = this.fresh();
        this.emit(`${iU} = load double, ptr ${idx}`);
        const iN = this.fresh();
        this.emit(`${iN} = fadd double ${iU}, 1.0`);
        this.emit(`store double ${iN}, ptr ${idx}`);
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "ThrowStmt": {
        // Never index -1: an empty stack is the ordinary case (a `throw` outside any
        // `try`), where node answers `undefined` and nativets PANICS on the read. The
        // `!h` arm below is the one that must stay reachable. See test/tsc.test.ts.
        const h = this.innermostHandler();
        // The innermost `try` is `finally`-only: it catches nothing, and its catch block is
        // never emitted. Refuse before anything branches to it. (Not folded into `!h` below:
        // an outer `catch` may exist, and skipping the `finally` on the way to it would drop
        // the finalizer's side effects — node runs it.)
        if (this.escapesCatchlessTry()) throw this.catchlessTryError(`\`throw\`${where(s)}`);
        // A `throw` is lowered as a BRANCH to the enclosing `try`'s catch block, so the
        // try must be in the same function frame. Crossing a frame — the ordinary "raise
        // in the callee, handle at the call site" idiom — needs real unwinding, which does
        // not exist yet. Refuse it; a raw internal error here used to print a Bun stack
        // trace naming our own source files (CLAUDE.md: an NT**** with a hint, always).
        if (!h) {
          // …but a throw NOBODY can catch needs no unwinding at all: it is node's
          // uncaught exception, which prints to stderr and exits 1 — exactly what the
          // pending-exception protocol already does for an uncaught host failure. This
          // frame is `main` (nothing calls module top-level, so no ancestor frame
          // exists) or the whole program contains no `try`.
          if (this.uncatchable() && this.genUncaught(s.argument)) return;
          // …and a throw the ESCAPE SCAN proved every caller catches leaves by the
          // pending-exception flag: raise, free what a `return` here would free, and
          // return the default. `scanEscaping` has already established that every call
          // site checks the flag, so the default value is never read.
          if (this.canEscape && this.genPropagate(s)) return;
          throw nyi(NYI.EXCEPTION, `\`throw\`${where(s)} that is not inside a \`try\` in the same function`,
            "a throw is lowered as a branch to its enclosing `try`, so it must sit inside one IN THE SAME function — or else cross exactly ONE frame, which needs EVERY call site of this function to sit inside a `try`/`catch` in its immediate caller (a call from module top level counts, since nothing above it could catch). Put every call in a `try`/`catch`, wrap the throwing code in a local `try`/`catch`, or return a result value (e.g. `T | undefined`) and check it at the call site");
        }
        const v = this.genExpr(s.argument);
        // The store used to be RAW, under `h.eType` whatever the value actually was — and
        // `h.eType` is inferred from the FIRST throw the checker could see in this block.
        // So a second throw of a different type wrote its value under the first one's
        // type: `catch (e) { e.message }` read the first eight bytes of a string as a
        // pointer. node's catch binding is `any` and nothing here is, so this is a
        // refusal, not a coercion — and it is the backstop that makes the whole class
        // impossible rather than one missed scan at a time.
        if (h.excVar && v.ty !== h.eType) {
          throw nyi(NYI.EXCEPTION, `\`throw\`${where(s)} of ${v.ty} where \`catch (${h.excVar})\` is ${h.eType}`,
            `the catch binding takes ONE type, inferred from the first \`throw\` in the block — node's \`catch\` parameter is \`any\`, which has no equivalent here. Throw the same type from every \`throw\` in a \`try\`, or split them into separate \`try\` blocks`);
        }
        // The binding is an OWNER now (see `collectLocals`), so the store takes a
        // reference — `try { throw s; } catch (e) {}` with a heap `s` otherwise has two
        // slots releasing one string.
        // …and the retain ASKS `isStrProducer`, exactly as `retainStrBind` and the
        // `ReturnStmt` transfer rule beside it do. A fresh template/concat/call result
        // arrives already registered at rc=1, so binding it CONSUMES that reference; the
        // unconditional retain this replaces made the binding a SECOND owner of a
        // temporary nobody else releases (`emitStrDrops` walks named locals only), and one
        // heap string leaked per throw. A thrown NAMED local or literal still retains: the
        // local's own release is still coming at scope exit, and a literal is untracked.
        if (h.excVar && h.eType === "string") this.retainStrBind(s.argument, v.v);
        if (h.excVar) this.emit(`store ${llvmTy(h.eType)} ${v.v}, ptr ${this.addr(h.excVar)}`);
        this.terminate(`br label %${h.catchLbl}`);
        return;
      }
      case "TryStmt": {
        const eType = s.catchTy ?? "string";
        const catchLbl = this.label("catch");
        const endLbl = this.label("endtry");
        const hasFinally = !!s.finalizer;
        const finallyLbl = hasFinally ? this.label("finally") : endLbl;
        const modeSlot = hasFinally ? this.slot("number") : "";
        const retSlot = hasFinally && this.retTy !== "void" ? this.slot(this.retTy) : "";
        const gotoFinally = () => {
          if (hasFinally) this.emit(`store double ${llvmDouble(0)}, ptr ${modeSlot}`); // mode 0 = normal
          this.terminate(`br label %${finallyLbl}`);
        };
        // NULL THE BINDING ON THE WAY IN. The handler's drop set now frees an object-typed
        // `catch` binding (see the `TryStmt` case in ownership.ts), and not every entry to
        // the handler stores one first: `emitExcCheck` reconstructs a value only for the
        // two shapes it knows, so a handler reached from a fallible call under any OTHER
        // object `eType` would have freed whatever the uninitialised alloca held — a wild
        // free, where the bug being fixed was merely a leak. `nt_obj_free(NULL)` is a
        // no-op, so this makes the unstored path free nothing. Re-run on every entry to
        // the `try`, which is what makes it correct inside a loop.
        // (The four arms ARE ownership.ts's `isLinearTy`, which is private to that module;
        // a fifth spelling of the list would be one more thing to keep in step, so the
        // condition is deliberately the same four predicates `emitDrops` branches on.)
        if (s.param && (isArrayTy(eType) || isObjectTy(eType) || isUnionTy(eType) || isTypeRefTy(eType))) {
          this.emit(`store ptr null, ptr ${this.addr(s.param)}`);
        }
        this.tryHandlers.push({ catchLbl, excVar: s.param, eType, catchless: !s.handler });
        const frame: FinallyFrame = { id: this.finId++, finallyLbl, modeSlot, retSlot: retSlot || null, scopeDepth: this.blockScopes.length };
        if (hasFinally) this.finallyStack.push(frame);
        this.genStmts(s.block);
        this.tryHandlers.pop();
        if (!this.isTerminated()) gotoFinally();
        if (s.handler) {
          this.to(this.block(catchLbl));
          this.genStmts(s.handler);
          if (!this.isTerminated()) gotoFinally();
        }
        if (hasFinally) {
          this.finallyStack.pop();
          this.to(this.block(finallyLbl));
          this.genStmts(s.finalizer!);
          // A finalizer that ends TERMINATED — one that itself does a `return`, `break` or
          // `continue` on every path — has no dispatch at all, and that is exactly right:
          // ECMAScript's `UpdateEmpty` says the finalizer's own abrupt completion REPLACES
          // the pending one. Verified against node, not assumed:
          //   for (…) { try { return 7; } finally { break; } } return 9;   -> node prints 9.
          // The pending exits parked on this frame are then simply never resumed, and the
          // stores that named them are dead. A finalizer that jumps only on SOME path still
          // reaches the dispatch on the others, which is the same rule falling out for free.
          if (!this.isTerminated()) {
            const m = this.fresh(); this.emit(`${m} = load double, ptr ${modeSlot}`);
            // Jump modes first: each is one id, and a miss falls through to the next test.
            // The load dominates every block in this chain, so the `%m` uses are legal.
            for (const ex of this.exitsOn(frame)) {
              const hit = this.fresh(); this.emit(`${hit} = fcmp oeq double ${m}, ${llvmDouble(ex.mode)}`);
              const jumpLbl = this.label("finjump");
              const nextLbl = this.label("findisp");
              this.terminate(`br i1 ${hit}, label %${jumpLbl}, label %${nextLbl}`);
              this.to(this.block(jumpLbl));
              this.emitResume(ex);
              this.to(this.block(nextLbl));
            }
            const isRet = this.fresh(); this.emit(`${isRet} = fcmp oeq double ${m}, ${llvmDouble(1)}`);
            const retLbl = this.label("finret");
            this.terminate(`br i1 ${isRet}, label %${retLbl}, label %${endLbl}`);
            this.to(this.block(retLbl));
            // FORWARD RATHER THAN `ret` when another finalizer still encloses this one.
            // This block sits INSIDE the outer `try` — it is emitted while generating it —
            // so returning from here jumped clean over the outer finalizer, which node
            // runs. That was a live silent wrong answer with `return` and TWO finalizers,
            // exactly the defect `break` had, and it survived because `return` was
            // verified against a single `finally` only. So: copy the stashed value into
            // the outer frame's slot, re-arm mode 1 there, and hand the return on. The
            // outer dispatch repeats the test, which is what makes it a CHAIN — three
            // deep works for the same reason two does.
            //
            // `finallyStack` has already popped THIS frame (just above), so the innermost
            // entry left is precisely the next finalizer out.
            const outerFin = this.innermostFinally();
            if (outerFin !== null) {
              if (retSlot && outerFin.retSlot) {
                const fv = this.fresh();
                this.emit(`${fv} = load ${llvmTy(this.retTy)}, ptr ${retSlot}`);
                this.emit(`store ${llvmTy(this.retTy)} ${fv}, ptr ${outerFin.retSlot}`);
              }
              this.emit(`store double ${llvmDouble(1)}, ptr ${outerFin.modeSlot}`);
              this.terminate(`br label %${outerFin.finallyLbl}`);
            }
            // In `main` this block is unreachable (no top-level `return`), but it must still
            // type-check against `define i32 @main` — see `inMain`.
            else if (this.inMain) this.terminate("ret i32 0");
            else if (this.retTy === "void" || !retSlot) this.terminate("ret void");
            else { const rv = this.fresh(); this.emit(`${rv} = load ${llvmTy(this.retTy)}, ptr ${retSlot}`); this.terminate(`ret ${llvmTy(this.retTy)} ${rv}`); }
          }
        }
        this.to(this.block(endLbl));
        return;
      }
      case "BlockStmt":
        this.genStmts(s.body);
        return;
      case "MultiStmt":
        this.genStmts(s.stmts);
        return;
      // Block-scoped RAII: free the linear locals this NESTED block declared (a
      // function/module body has none — those use endDrops). The marker is last in the
      // list, so a block that terminated early never reaches it — which is why a jump
      // out of the block has to emit the same frees itself, on its way past.
      //
      // The two paths cannot both run: `terminate` marks the basic block terminated and
      // `genStmts` stops at the first terminated block, so once a `break` has unwound,
      // the markers of every list it unwound are unreachable in that block. A jump frees
      // once, a fall-through frees once, and never both.
      case "BlockDrops":
        this.emitDrops(s.names);
        return;
      case "BreakStmt": {
        const t = this.loops[this.loops.length - 1]!;
        this.emitJump(t.brkDepth, t.brkFin, t.brk);
        return;
      }
      case "ContinueStmt": {
        const t = this.loops[this.loops.length - 1]!;
        this.emitJump(t.contDepth, t.contFin, t.cont);
        return;
      }
      case "FuncDecl":
        return;
    }
  }

  /** Lower an expression to an i1 truthiness value. */
  private genCond(e: Expr): string {
    return this.truthyOf(this.genExpr(e));
  }

  /**
   * i1 truthiness of an already-evaluated value — JS ToBoolean, type-directed.
   *
   * This used to handle boolean and number and then FALL THROUGH to "assume it is a
   * string and call js_str_len". Every other type is a POINTER, so that read hit the
   * heap block itself and invented an answer from its first word: a nullable box was
   * always truthy (so a present `0` came out true), `[]` and `{}` came out FALSE where
   * node says both are true, and `JSON.parse("0")` came out true. All silent.
   *
   * It is exhaustive now, and the fallback is the JS rule rather than a guess: every
   * remaining value IS an object, and an object is ALWAYS truthy — `[]`, `{}`, an empty
   * Map, a Date, a function. Anything not on either list throws rather than defaulting,
   * so a future box type is a loud compiler error instead of a fresh wrong answer.
   */
  private truthyOf(val: Val): string {
    if (val.ty === "boolean") return val.v;
    if (val.ty === "number") {
      const t = this.fresh();
      this.emit(`${t} = fcmp one double ${val.v}, 0.0`); // NaN and 0 are falsy
      return t;
    }
    if (val.ty === "string") {
      const len = this.fresh();
      this.emit(`${len} = call double @js_str_len(ptr ${val.v})`);
      const t = this.fresh();
      this.emit(`${t} = fcmp one double ${len}, 0.0`);
      return t;
    }
    // The two nullish VALUES are falsy; so is a `void` (an absent result).
    if (val.ty === "undefined" || val.ty === "null" || val.ty === "void") return "false";
    // A nullable BOX: the tag decides first, then the value it carries.
    if (isNullableTy(val.ty)) return this.truthyNullable(val.v, baseTy(val.ty));
    // A Dyn's truthiness is its JSON tag's — a runtime fact, so the runtime decides.
    if (val.ty === "Dyn") {
      const t = this.fresh();
      this.emit(`${t} = call i32 @nt_dyn_truthy(ptr ${val.v})`);
      const b = this.fresh();
      this.emit(`${b} = icmp ne i32 ${t}, 0`);
      return b;
    }
    // Everything below is a JS object, and an object is always truthy — including an
    // EMPTY array/object/Map/Set, and including a Date whose time value is NaN.
    // A DISCRIMINATED union belongs here: its value IS the member object pointer, and
    // every member is an object type by construction. (A GENERAL union does NOT — it is
    // a box that can carry `0` or `""`, and reading the box pointer as the value is the
    // wrong answer it is refused for.)
    if (
      isUnionTy(val.ty) ||
      isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) ||
      isBytesTy(val.ty) || isBytesRefTy(val.ty) || isFetchRefTy(val.ty) || isUrlRefTy(val.ty) ||
      isDateTy(val.ty) || isResponseTy(val.ty) || isHeadersTy(val.ty) || isTextEncoderTy(val.ty) || isTextDecoderTy(val.ty)
    ) return "true";
    throw internalError(`no truthiness rule for ${val.ty} — add one rather than defaulting`);
  }

  /**
   * i1 truthiness of a nullable box: falsy when nullish (tag < 2), otherwise the
   * truthiness of the value it carries. Branched rather than computed unconditionally
   * because the absent case's value slot is 0, and unpacking that as a string would
   * hand `js_str_len` a null pointer.
   */
  private truthyNullable(ptr: string, base: Ty): string {
    const slot = this.slot("boolean");
    const present = this.fresh();
    this.emit(`${present} = icmp eq i64 ${this.nullTag(ptr)}, 2`);
    const pLbl = this.label("tvp"), aLbl = this.label("tva"), end = this.label("tve");
    this.terminate(`br i1 ${present}, label %${pLbl}, label %${aLbl}`);
    this.to(this.block(pLbl));
    const inner = this.truthyOf({ v: this.fromSlot(this.nullVal(ptr), base), ty: base });
    this.emit(`store i1 ${inner}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(aLbl));
    this.emit(`store i1 false, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh();
    this.emit(`${t} = load i1, ptr ${slot}`);
    return t;
  }

  private coerceToString(val: Val): string {
    if (val.ty === "string") return val.v;
    if (val.ty === "undefined") return this.mod.intern("undefined");
    if (val.ty === "null") return this.mod.intern("null");
    // A nullable BOX: node's String() of a nullish is the literal "undefined"/"null",
    // and of a present value is that value's own coercion. Reaching codegen with the
    // raw box is what emitted invalid IR for `${x}`.
    if (isNullableTy(val.ty)) return this.coerceToStringNullable(val.v, baseTy(val.ty), nullishKind(val.ty));
    if (val.ty === "number") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @js_num_to_str(double ${val.v})`);
      return t;
    }
    // node's `Array#toString` IS `join(",")` — `String([1,2,3])` is `"1,2,3"`, an empty
    // array is `""` and a one-element array carries no separator. Only the three element
    // types `joinFn` knows reach here; the checker refuses the rest (NT1032), so this is
    // not a fallback and must not become one.
    if (isArrayTy(val.ty)) {
      const t = this.fresh();
      this.emit(`${t} = call ptr @${joinFn(elemTy(val.ty))}(ptr ${val.v}, ptr ${this.mod.intern(",")})`);
      return t;
    }
    // `boolean` is the LAST case, not the default one. Everything that is not a type
    // above is refused by `checkStringCoercion` before it gets here — reaching this line
    // with (say) an object emitted `zext i1 <ptr>` and made clang's error the user's.
    if (val.ty !== "boolean") throw internalError(`coerceToString of ${val.ty} (the checker should have refused it — see NYI.STRINGIFY)`);
    const z = this.fresh();
    this.emit(`${z} = zext i1 ${val.v} to i32`);
    const t = this.fresh();
    this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
    return t;
  }

  /** node's String() of a nullable box: "undefined"/"null" when nullish, else the value's. */
  private coerceToStringNullable(ptr: string, base: Ty, which: "undefined" | "null"): string {
    const slot = this.slot("string");
    const present = this.fresh();
    this.emit(`${present} = icmp eq i64 ${this.nullTag(ptr)}, 2`);
    const pLbl = this.label("csp"), aLbl = this.label("csa"), end = this.label("cse");
    this.terminate(`br i1 ${present}, label %${pLbl}, label %${aLbl}`);
    this.to(this.block(pLbl));
    const inner = this.coerceToString({ v: this.fromSlot(this.nullVal(ptr), base), ty: base });
    this.emit(`store ptr ${inner}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(aLbl));
    this.emit(`store ptr ${this.mod.intern(which)}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh();
    this.emit(`${t} = load ptr, ptr ${slot}`);
    return t;
  }

  /**
   * Coerce a value to a `double` — JS ToNumber, for the types `checkNumberCoercion`
   * (src/checker.ts) admits.
   *
   * `NaN` is the LAST case, not the default one. This used to end in a bare
   * `return llvmDouble(NaN)`, and the checker returned `number` for every `+` operand
   * without looking at one, so the fall-through was reached by ordinary code and answered
   * a number node does not print, at exit 0: `+new Date(1000)` was NaN (node 1000), `+[]`
   * was NaN (node 0), `+[1]` was NaN (node 1) and a `number | null` holding null was NaN
   * (node 0). Anything not on the list below is refused in the checker now, and reaching
   * this line with it is a compiler bug rather than the user's problem.
   */
  private coerceToNumber(val: Val): string {
    if (val.ty === "number") return val.v;
    // A Date IS its time value (a `double`), and ToNumber of a Date is exactly that value:
    // `ToPrimitive(d, number)` runs `valueOf` FIRST. The string hint would run `toString`
    // and give the weekday form instead, which is why `"" + date` stays refused (NT1024)
    // while this is the identity. `%d` in console.log already had this rule.
    if (isDateTy(val.ty)) return val.v;
    if (val.ty === "string") {
      const t = this.fresh();
      this.emit(`${t} = call double @js_str_to_num(ptr ${val.v})`);
      return t;
    }
    if (val.ty === "boolean") {
      const t = this.fresh();
      this.emit(`${t} = uitofp i1 ${val.v} to double`);
      return t;
    }
    if (val.ty === "null") return llvmDouble(0);
    if (val.ty === "undefined" || val.ty === "void") return llvmDouble(NaN);
    // A nullable BOX branches on its TAG, and the two nullish answers DIFFER — `null` is 0
    // and `undefined` is NaN — so this cannot be folded into a single constant. The raw
    // box reaching the fall-through is what made `const n: number | null = null; +n` NaN.
    if (isNullableTy(val.ty)) return this.coerceToNumberNullable(val.v, baseTy(val.ty), nullishKind(val.ty));
    // An ARRAY has no `valueOf`, so ToNumber is StringToNumber of its `toString` — which
    // IS `join(",")`. `[]` gives `""` → 0 and `[1]` gives `"1"` → 1, both of which node
    // prints and the fall-through did not. Only the element types `joinFn` renders exactly
    // reach here; the checker refuses the rest, so this is not a fallback.
    if (isArrayTy(val.ty)) {
      // The join allocates, and `js_str_to_num` only READS it — so this frame is the last
      // owner and the buffer is dead on the next instruction. Released here for the same
      // reason `releaseTemp` releases a concat operand: without it `+arr` in a loop would
      // leak one string per iteration, which is the residue shape test/fuzz2-diff.test.ts
      // measures.
      const s = this.coerceToString(val);
      const t = this.fresh();
      this.emit(`${t} = call double @js_str_to_num(ptr ${s})`);
      this.emit(`call void @nt_str_release(ptr ${s})`);
      return t;
    }
    throw internalError(`coerceToNumber of ${val.ty} (the checker should have refused it — see NYI.TONUMBER)`);
  }

  /** node's ToNumber of a nullable box: 0 when `null`, NaN when `undefined`, else the
   *  value's own coercion. Branched rather than computed unconditionally because the
   *  absent case's value slot is 0, and unpacking that as a string would hand
   *  `js_str_to_num` a null pointer. */
  private coerceToNumberNullable(ptr: string, base: Ty, which: "undefined" | "null"): string {
    const slot = this.slot("number");
    const present = this.fresh();
    this.emit(`${present} = icmp eq i64 ${this.nullTag(ptr)}, 2`);
    const pLbl = this.label("cnp"), aLbl = this.label("cna"), end = this.label("cne");
    this.terminate(`br i1 ${present}, label %${pLbl}, label %${aLbl}`);
    this.to(this.block(pLbl));
    const inner = this.coerceToNumber({ v: this.fromSlot(this.nullVal(ptr), base), ty: base });
    this.emit(`store double ${inner}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(aLbl));
    this.emit(`store double ${llvmDouble(which === "null" ? 0 : NaN)}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh();
    this.emit(`${t} = load double, ptr ${slot}`);
    return t;
  }

  /** Pack a value into a 64-bit array slot. */
  private toSlot(val: Val): string {
    // RC: a string packed into a heap slot (array element, object field, closure
    // capture, map entry, nullable box) gains a persistent owner → retain. These
    // slot owners are never released (arrays/objects don't reclaim their string
    // elements), so this is a conservative, leak-safe over-retain that guarantees a
    // slot never holds a dangling pointer after a local owner is dropped.
    if (val.ty === "string") this.emit(`%rc${this.tmp++} = call ptr @nt_str_retain(ptr ${val.v})`);
    const t = this.fresh();
    if (val.ty === "number" || isDateTy(val.ty)) this.emit(`${t} = bitcast double ${val.v} to i64`); // a Date IS a double (batch 3)
    else if (isTypeRefTy(val.ty) || isUnionTy(val.ty) || isGeneralUnionTy(val.ty) || val.ty === "string" || isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty) || isNullableTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) || (isBytesRefTy(val.ty) || isFetchRefTy(val.ty)) || isUrlRefTy(val.ty)) this.emit(`${t} = ptrtoint ptr ${val.v} to i64`);
    else if (val.ty === "boolean") this.emit(`${t} = zext i1 ${val.v} to i64`);
    else this.emit(`${t} = zext i8 ${val.v} to i64`);
    return t;
  }
  /** Unpack a 64-bit slot into a value of the given type. */
  private fromSlot(slot: string, ty: Ty): string {
    const t = this.fresh();
    if (ty === "number" || isDateTy(ty)) this.emit(`${t} = bitcast i64 ${slot} to double`); // a Date IS a double (batch 3)
    else if (isTypeRefTy(ty) || isUnionTy(ty) || isGeneralUnionTy(ty) || ty === "string" || isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || (isBytesRefTy(ty) || isFetchRefTy(ty)) || isUrlRefTy(ty)) this.emit(`${t} = inttoptr i64 ${slot} to ptr`);
    else if (ty === "boolean") this.emit(`${t} = trunc i64 ${slot} to i1`);
    else this.emit(`${t} = trunc i64 ${slot} to i8`);
    return t;
  }

  /**
   * Control-flow narrowing: the checker proved that on this path the binding is not
   * nullish (`if (x !== undefined) { x + 1 }`), so this read hands back the BARE value
   * rather than the A2 tagged pair. Unwrapped by the same `nt_nonnull` the `!` assertion
   * uses — so if the analysis is ever wrong it PANICS at the read with a location,
   * exactly like a false assertion, and never yields a phantom value.
   */
  private narrowRead(e: { narrowed?: boolean; loc?: Loc; ty?: Ty }, r: Val): Val {
    if (!e.narrowed) return r;
    // A GENERAL union is a BOX, so a narrowed read UNPACKS it at the arm the checker
    // proved — and re-checks the tag, for the same reason the nullable case does.
    if (isGeneralUnionTy(r.ty) && e.ty !== undefined && e.ty !== r.ty) {
      const arm = e.ty;
      const slot = this.fresh();
      this.emit(`${slot} = call i64 @nt_union_arm(ptr ${r.v}, double ${llvmDouble(generalUnionTagOf(r.ty, arm))}, ptr ${this.mod.intern(arm)}, ptr ${this.locArg(e.loc) ?? "null"})`);
      return { v: this.fromSlot(slot, arm), ty: arm };
    }
    if (!isNullableTy(r.ty)) return r;
    const base = baseTy(r.ty);
    const slot = this.fresh();
    this.emit(`${slot} = call i64 @nt_nonnull(ptr ${r.v}, ptr ${this.locArg(e.loc) ?? "null"})`);
    // The unwrapped value may ALSO have been tag-narrowed (`if (!e) return; if (e.kind
    // === "A")` on an `E | undefined`). A discriminated union is the member pointer
    // itself, so that second narrowing is pure retype — the same rule the `Identifier`
    // case applies to a non-nullable union binding, applied here to what came out of
    // the box. Representation is `base`'s either way; only the layout name changes.
    const ty = isUnionTy(base) && e.ty !== undefined && e.ty !== base ? e.ty : base;
    return { v: this.fromSlot(slot, base), ty };
  }

  // ---- nullable tagged pair [tag, value] (A2) ----
  // tag 0 = undefined, 1 = null, 2 = present. is_nullish = tag < 2. The nullish
  // predicate is TAG-based, never truthiness, so 0 / "" / false pass through.
  /** Allocate a nullable box with the given tag (i64 literal/reg) and packed value slot. */
  private nullBox(tag: string, valSlot: string): string {
    const p = this.fresh();
    this.emit(`${p} = call ptr @nt_obj_new(double ${llvmDouble(2)})`);
    const g0 = this.fresh();
    this.emit(`${g0} = getelementptr i64, ptr ${p}, i64 0`);
    this.emit(`store i64 ${tag}, ptr ${g0}`);
    const g1 = this.fresh();
    this.emit(`${g1} = getelementptr i64, ptr ${p}, i64 1`);
    this.emit(`store i64 ${valSlot}, ptr ${g1}`);
    return p;
  }
  /** Nullable-box tag: 0 (undefined) when `absent` (an i1) holds, else 2 (present).
   *  Used by the stdlib fills whose node result is `T | undefined` (`.at`, `.find`, …). */
  private nullTagIf(absent: string): string {
    const t = this.fresh();
    this.emit(`${t} = select i1 ${absent}, i64 0, i64 2`);
    return t;
  }
  /** Load the tag (i64) of a nullable box. */
  private nullTag(ptr: string): string {
    const g0 = this.fresh();
    this.emit(`${g0} = getelementptr i64, ptr ${ptr}, i64 0`);
    const t = this.fresh();
    this.emit(`${t} = load i64, ptr ${g0}`);
    return t;
  }
  /** Load the raw value slot (i64) of a nullable box. */
  private nullVal(ptr: string): string {
    const g1 = this.fresh();
    this.emit(`${g1} = getelementptr i64, ptr ${ptr}, i64 1`);
    const t = this.fresh();
    this.emit(`${t} = load i64, ptr ${g1}`);
    return t;
  }
  /** i1: is this nullable box nullish (tag < 2)? */
  private isNullish(ptr: string): string {
    const t = this.fresh();
    this.emit(`${t} = icmp ult i64 ${this.nullTag(ptr)}, 2`);
    return t;
  }
  /** Box a value into a nullable of type `target`. undefined/null carry their tag. */
  private coerceNullable(val: Val, target: Ty): Val {
    if (isNullableTy(val.ty)) return { v: val.v, ty: target };
    if (val.ty === "undefined" || val.ty === "void") return { v: this.nullBox("0", "0"), ty: target };
    if (val.ty === "null") return { v: this.nullBox("1", "0"), ty: target };
    return { v: this.nullBox("2", this.toSlot(val)), ty: target }; // present value
  }
  /** Coerce a value to `target` at a store/assign boundary — boxes into a nullable if needed. */
  private coerce(val: Val, target: Ty): Val {
    if (isNullableTy(target) && !isNullableTy(val.ty)) return this.coerceNullable(val, target);
    if (isGeneralUnionTy(target) && !isGeneralUnionTy(val.ty)) return this.coerceGeneralUnion(val, target);
    return val;
  }

  // ---- general union box [tag, value] ----
  // Same two-slot block as the A2 nullable, but `tag` is the arm's INDEX in the
  // union's canonical member order rather than a nullish marker. The checker has
  // already proved `val.ty` is a member, so the tag is a compile-time constant and
  // boxing costs one allocation and two stores — no runtime type test.
  /** Box an arm value into a general union of type `target`. */
  private coerceGeneralUnion(val: Val, target: Ty): Val {
    const tag = generalUnionTagOf(target, val.ty);
    if (tag < 0) throw internalError(`${val.ty} is not a member of the union ${target}`); // the checker proved membership
    return { v: this.nullBox(String(tag), this.toSlot(val)), ty: target };
  }

  /**
   * `expr as T` — emit the assertion, CHECKING it wherever the check is possible and
   * skipping it wherever the layouts are provably identical.
   *
   * The case analysis is entirely about REPRESENTATION, because that is the only thing
   * an assertion can get wrong here. There are four representations in play and the
   * boundaries between them are what used to break:
   *
   *   1. IDENTICAL representation — `42 as number`, `xs as number[]`, and every
   *      same-shape object retype. Free, and stays free: no check is emitted, so `as`
   *      costs nothing on the hot paths that use it as documentation.
   *
   *   2. `U<…>` -> one of its MEMBERS (the downcast). A discriminated union IS the
   *      member pointer, so this is where the reinterpretation happened. The tag is in
   *      the value at a known slot, so it is checkable — `nt_as_tag`. One load and a
   *      string compare, and only in this direction.
   *
   *   3. member -> `U<…>` (the WIDENING). Also pointer-identical, and always TRUE, so
   *      it is free — a member is a union. Checking it would be pure cost.
   *
   *   4. Across a BOX boundary (`G<…>`, nullable). Narrowing unboxes via `nt_as_unbox`;
   *      widening BOXES via the ordinary `coerce`. Neither is optional: the old identity
   *      retype handed a `ptr` where a `double` was wanted and the module failed to
   *      verify, so the user got clang's error rather than one of ours.
   *
   * Anything left over is a cast between representations that cannot be reconciled at
   * all (`{a:number}` -> `{a:number,b:string}` reads off the end of the object). Those
   * are REFUSED by the checker rather than emitted — see `checkAsCast`.
   */
  private genAsCast(val: Val, target: Ty, loc?: Loc): Val {
    const from = val.ty;
    if (from === target) return val;                                    // (1) identity
    const locp = this.locArg(loc) ?? "null";

    // (2) `U<…>` -> member: check the in-value discriminant.
    if (isUnionTy(from) && !isUnionTy(target)) {
      const d = unionDiscriminant(from);
      const widened = unionWidenedMembers(from);
      const tags = unionTagValues(from);
      // Accept every member the target can be READ through — `objectLayoutFits`, i.e.
      // the target's fields sit at the same slots with the same types. That covers three
      // cases with one rule: the target IS a member (the ordinary downcast); several
      // members widen to the same shape, making them layout-identical and equally safe;
      // and the target is a structural WINDOW onto some members, which is the
      // `(e as {name: string}).name` duck-typing idiom `src/` is built on. Tags are
      // comma-separated (a comma cannot occur in a tag value; see TAG_FORBIDDEN).
      //
      // When EVERY member fits, the assertion cannot fail and no check is emitted at all.
      // When NONE does, the checker has already refused it — codegen never sees one.
      //
      // Spelled as a plain loop building the string directly. The obvious
      // `.map(…).filter((t): t is string => t !== null)` is OUT OF SUBSET — a type
      // PREDICATE in an arrow is not something this compiler parses, so `src/` may not
      // use one (docs/self-hosting.md), and it broke the whole-program LINK rather than
      // showing up as a checker blocker.
      let allowed = "";
      let matches = 0;
      for (let i = 0; i < widened.length; i++) {
        if (widened[i] !== target && !objectLayoutFits(target, widened[i]!)) continue;
        allowed = matches === 0 ? tags[i]! : `${allowed},${tags[i]!}`;
        matches++;
      }
      if (d !== undefined && matches > 0) {
        if (matches < widened.length) {
          this.emit(`call void @nt_as_tag(ptr ${val.v}, double ${llvmDouble(d.index)}, ptr ${this.mod.intern(allowed)}, ptr ${this.mod.intern(target)}, ptr ${locp})`);
        }
        return { v: val.v, ty: target };
      }
    }

    // (3) member -> `U<…>`: pointer-identical and always true.
    if (isUnionTy(target) && !isUnionTy(from)) return { v: val.v, ty: target };

    // (4a) `G<…>` -> arm, and nullable -> base: unbox, checking the box tag.
    if (isGeneralUnionTy(from) && !isGeneralUnionTy(target)) {
      const tag = generalUnionTagOf(from, target);
      if (tag >= 0) {
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_as_unbox(ptr ${val.v}, double ${llvmDouble(tag)}, ptr ${this.mod.intern(target)}, ptr ${locp})`);
        return { v: this.fromSlot(slot, target), ty: target };
      }
    }
    if (isNullableTy(from) && !isNullableTy(target) && baseTy(from) === target) {
      const slot = this.fresh();
      // `want < 0` is the runtime's "any PRESENT value" — tags 0/1 are undefined/null.
      this.emit(`${slot} = call i64 @nt_as_unbox(ptr ${val.v}, double ${llvmDouble(-1)}, ptr ${this.mod.intern(target)}, ptr ${locp})`);
      return { v: this.fromSlot(slot, target), ty: target };
    }

    // (4b) arm -> `G<…>`, base -> nullable: BOX, by the same coercion a store uses.
    if ((isGeneralUnionTy(target) && !isGeneralUnionTy(from)) || (isNullableTy(target) && !isNullableTy(from))) {
      return this.coerce(val, target);
    }

    return { v: val.v, ty: target }; // representations already agree — retype only
  }

  /** i1 result of `a === b` for same-typed operands. */
  private compareEq(a: Val, b: Val): string {
    const t = this.fresh();
    if (a.ty === "number") this.emit(`${t} = fcmp oeq double ${a.v}, ${b.v}`);
    else if (a.ty === "boolean") this.emit(`${t} = icmp eq i1 ${a.v}, ${b.v}`);
    else if (a.ty === "string") {
      const eq = this.fresh();
      this.emit(`${eq} = call i32 @js_str_eq(ptr ${a.v}, ptr ${b.v})`);
      this.emit(`${t} = icmp ne i32 ${eq}, 0`);
    } else this.emit(`${t} = icmp eq i8 ${a.v}, ${b.v}`);
    return t;
  }

  private concat(a: string, b: string): string {
    const t = this.fresh();
    this.emit(`${t} = call ptr @js_str_concat(ptr ${a}, ptr ${b})`);
    return t;
  }

  /**
   * `concat`, releasing the operands the JSON serializer itself allocated.
   *
   * The serializer is a left fold of `js_str_concat`, so every accumulator but the last
   * is dead the instant the next concatenation has copied it — and none of them was ever
   * released: `JSON.stringify({a, b})` allocated EIGHT strings and returned one, so seven
   * escaped per call, without bound. `js_str_concat` copies both inputs (it always
   * allocates; there is no "return the operand when the other side is empty" fast path),
   * so a release emitted after it is the last reference and the buffer is reclaimed.
   *
   * `own` says the operand is one this serializer produced. An interned `@.str` constant
   * is passed `false` — not because releasing one would be wrong (`nt_str_release` is a
   * documented no-op on a pointer the RC side table never saw) but so the emitted IR does
   * not grow a dead call per separator.
   *
   * A `genJsonStringify` result is always safe to pass `true`: every arm of it either
   * ALLOCATES (`nt_json_num`, `js_json_quote`, `nt_date_to_json`, a nested object/array's
   * own final concat) or hands back a pointer that is not in the table at all (an
   * interned `null`/`{}`, `js_bool_to_str`'s static `"true"`/`"false"`, `nt_json_num`'s
   * static `"null"` for a non-finite). No arm returns the CALLER's value, which is the
   * one thing that would make this a premature free.
   */
  private jsonCat(a: string, aOwn: boolean, b: string, bOwn: boolean): string {
    const t = this.concat(a, b);
    if (aOwn) this.emit(`call void @nt_str_release(ptr ${a})`);
    if (bOwn) this.emit(`call void @nt_str_release(ptr ${b})`);
    return t;
  }

  /**
   * Did `coerceToString` ALLOCATE, or hand back a string it borrowed?
   *
   * Exactly the two arms that call a REGISTERING runtime producer: `number` reaches
   * `js_num_to_str` and an array reaches `nt_arr_join_*`, both of which `nt_str_register`
   * their result at rc=1. Everything else borrows — a `string` is returned unchanged, and
   * `undefined`/`null`/`boolean` become interned literals, which are not in the refcount
   * table at all.
   *
   * The `isNullableTy` guard is not decoration: it MIRRORS `coerceToString`'s own dispatch
   * order, which tests nullable BEFORE number. A `?Unumber` takes `coerceToStringNullable`
   * (which may return a borrowed inner string), so answering "allocated" for it on the
   * strength of its base type would release a string this frame does not own.
   */
  private coercionAllocates(t: Ty): boolean {
    if (isNullableTy(t)) return false;
    return t === "number" || isArrayTy(t);
  }

  /** One operand of a concatenation: lowered, coerced, and labelled with whether this
   *  frame owns the result. Freshness comes from the COERCION when the operand needed
   *  one, and from the EXPRESSION SHAPE when it was already a string. */
  private concatOperand(e: Expr): StrTemp {
    const val = this.genExpr(e);
    const fresh = val.ty === "string" ? allocatesString(e) : this.coercionAllocates(val.ty);
    return { v: this.coerceToString(val), fresh };
  }

  /** Drop a concat operand this frame allocated. Emitted AFTER the `js_str_concat` that
   *  consumes it, which copies its inputs — so the release is the last reference and the
   *  buffer is reclaimed rather than leaked. A no-op for a borrowed operand. */
  private releaseTemp(t: StrTemp): void {
    if (t.fresh) this.emit(`call void @nt_str_release(ptr ${t.v})`);
  }

  // ---- expressions ----
  /**
   * The codegen half of the checker's `type()` funnel: a VALUE never carries the folded
   * `@Name`, only the shape it names.
   *
   * A field whose declared type is the back-edge (`CallExpr.callee: @Expr`) loads a pointer
   * exactly like the unfolded union does — the encoding is representation-identical, which
   * is why `isTypeRefTy` and `isUnionTy` already select the same `nt_obj_free` — but every
   * structural predicate below answers "no" to `@Expr`, so the receiver of the NEXT access
   * fell through to `no member lowering for .kind on @Expr`. Unfolding here keeps codegen's
   * view of a value in step with the checker's, which is the property the narrowing hand-off
   * at the `MemberExpr` case depends on (it compares `obj.ty` against the checker's
   * `e.object.ty`).
   *
   * One level, for the reason `checker.type` states: the shape's own recursive positions
   * stay folded, so this is O(1) and driven by real accesses.
   *
   * The guard tests whether unfolding CHANGED the type rather than testing for a bare `@N`,
   * because `?U@N` — an optional back-edge — is a value type the checker now unfolds too, and
   * the two halves of this funnel disagreeing is what the funnel exists to prevent. It stays
   * a guard rather than an unconditional `this.unfold` because `unfold` also WIDENS string
   * literals, and widening every expression's type here would erase the tags the discriminated
   * dispatch reads.
   */
  private genExpr(e: Expr): Val {
    const val = this.genExprInner(e);
    const un = unfoldTypeRef(val.ty, this.mod.recTypes);
    return un === val.ty ? val : { v: val.v, ty: this.unfold(val.ty) };
  }

  private genExprInner(e: Expr): Val {
    switch (e.kind) {
      case "NumberLiteral": return { v: llvmDouble(e.value), ty: "number" };
      case "BooleanLiteral": return { v: e.value ? "true" : "false", ty: "boolean" };
      case "StringLiteral": return { v: this.mod.intern(e.value), ty: "string" };
      case "UndefinedLiteral": return { v: "0", ty: "undefined" };
      case "NullLiteral": return { v: "0", ty: "null" };

      case "SequenceExpr": {
        let last: Val = { v: "0", ty: "undefined" };
        for (const x of e.exprs) last = this.genExpr(x);
        return last;
      }

      case "ArrayLiteral": {
        const ty = e.ty as Ty;
        const el = elemTy(ty);
        const arr = this.fresh();
        this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(e.elements.length, 1))})`);
        for (const element of e.elements) {
          if (element.kind === "SpreadExpr") {
            const src = this.genExpr(element.argument);
            // Consuming append (`x = [...x, e]`): this spread's source is dying, so MOVE
            // its storage into the fresh array — which also leaves the vector at rc 1,
            // the transient condition for the trailing pushes. See `consumingSpread`.
            if (this.consumeNode === element) {
              this.consumeNode = null; this.consumeTaken = true;
              this.emit(`call void @nt_arr_extend_own(ptr ${arr}, ptr ${src.v})`);
            } else {
              this.emit(`call void @nt_arr_extend(ptr ${arr}, ptr ${src.v})`);
            }
          } else {
            // COERCE into the declared element type, the same store boundary an object
            // literal's field takes. `["x", null]` against `(string | null)[]` has to push
            // BOXES, not a raw `ptr` and a raw 0 — the slot's type is `?Nstring`, so an
            // unboxed element read back as a box loads its first word as the tag.
            this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(this.coerce(this.genExpr(element), el))})`);
          }
        }
        return { v: arr, ty };
      }

      case "IndexExpr":
        // `a?.[i]`, or a link trailing one, lowers as ONE guarded unit — same dispatch the
        // MemberExpr case uses, so a chain mixing `.b` and `[i]` stays a single chain.
        if (e.ty !== undefined && isNullableTy(e.ty) && isOptChainExpr(e)) return this.genOptChain(e);
        return this.genElemRead(this.genExpr(e.object), e);

      case "ObjectLiteral": {
        const ty = e.ty as Ty;
        const nfields = objectFields(ty).length;
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(nfields)})`);
        let written = new Set<string>();
        // store by MERGED field index (spread + overrides mean property order != slot order)
        for (const p of e.properties) {
          if (p.spread) {
            const src = this.genExpr(p.value);
            const srcTy = p.value.ty as Ty;
            for (const f of objectFields(srcTy)) {
              const sg = this.fresh();
              this.emit(`${sg} = getelementptr i64, ptr ${src.v}, i64 ${fieldIndex(srcTy, f.key)}`);
              const val = this.fresh();
              this.emit(`${val} = load i64, ptr ${sg}`);
              const dg = this.fresh();
              this.emit(`${dg} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, f.key)}`);
              this.emit(`store i64 ${val}, ptr ${dg}`);
              written = written.add(f.key);
            }
          } else {
            const ft = fieldType(ty, p.key) ?? (p.value.ty as Ty);
            const slot = this.toSlot(this.coerce(this.genExpr(p.value), ft)); // box into a nullable field
            const g = this.fresh();
            this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, p.key)}`);
            this.emit(`store i64 ${slot}, ptr ${g}`);
            written = written.add(p.key);
          }
        }
        // An OMITTED optional field must still hold a valid `undefined` box so a later
        // read is defined (not a null-pointer deref). Initialize any such field.
        for (const f of objectFields(ty)) {
          if (written.has(f.key) || !isNullableTy(f.ty)) continue;
          const box = this.nullBox("0", "0");
          const g = this.fresh();
          this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, f.key)}`);
          this.emit(`store i64 ${this.toSlot({ v: box, ty: f.ty })}, ptr ${g}`);
        }
        return { v: obj, ty };
      }

      case "ArrowFunction": {
        // build a closure: a heap block [fn_ptr, cap0, cap1, ...]
        const fnName = this.mod.liftArrow(e);
        const caps = e.captures ?? [];
        const clo = this.fresh();
        this.emit(`${clo} = call ptr @nt_obj_new(double ${llvmDouble(1 + caps.length)})`);
        const fp = this.fresh();
        this.emit(`${fp} = ptrtoint ptr @${fnName} to i64`);
        const g0 = this.fresh();
        this.emit(`${g0} = getelementptr i64, ptr ${clo}, i64 0`);
        this.emit(`store i64 ${fp}, ptr ${g0}`);
        caps.forEach((c, i) => {
          const v = this.genExpr({ kind: "Identifier", name: c.name }); // snapshot the enclosing var
          const g = this.fresh();
          this.emit(`${g} = getelementptr i64, ptr ${clo}, i64 ${i + 1}`);
          this.emit(`store i64 ${this.toSlot(v)}, ptr ${g}`);
        });
        return { v: clo, ty: (e.ty ?? "number") as Ty };
      }

      case "SpreadExpr":
        throw internalError(`codegen reached the expression kind ${e.kind}, which the checker should have expanded or refused`);

      case "TemplateLiteral": {
        // A chain of concats, and every link but the last is garbage the moment the next
        // one copies it. `acc` starts as an interned QUASI — a literal, never in the
        // refcount table — and becomes frame-owned as soon as the first concat replaces
        // it, which is what `accFresh` tracks.
        let acc = this.mod.intern(e.quasis[0]!);
        let accFresh = false;
        for (let i = 0; i < e.exprs.length; i++) {
          const part = this.concatOperand(e.exprs[i]!);
          const withPart = this.concat(acc, part.v);
          if (accFresh) this.emit(`call void @nt_str_release(ptr ${acc})`);
          this.releaseTemp(part);
          // The trailing quasi is a literal, so only the accumulator needs dropping —
          // and `withPart` is always a concat result, hence always this frame's.
          acc = this.concat(withPart, this.mod.intern(e.quasis[i + 1]!));
          this.emit(`call void @nt_str_release(ptr ${withPart})`);
          accFresh = true;
        }
        return { v: acc, ty: "string" };
      }

      case "Identifier": {
        if (e.name === "NaN") return { v: llvmDouble(NaN), ty: "number" };
        if (e.name === "Infinity") return { v: llvmDouble(Infinity), ty: "number" };
        // Both narrowings reach a read: `narrowRead` unwraps a nullable that the checker
        // proved present, and the union case below keeps the binding's storage while
        // taking the checker's MEMBER type (same pointer, different layout).
        if (this.captures.has(e.name)) return this.narrowRead(e, this.readCapture(e.name));
        // A function DECLARATION read as a value. Checked AFTER the binding tables, so a
        // local, a parameter or a capture of the same name still SHADOWS the function —
        // which is what node does, and what keeps this from changing any existing program.
        // Without it the name reached `this.addr`, which invented a frame slot that was
        // never allocated (`use of undefined value '%dbl.addr'` out of clang).
        if (!this.isBound(e.name)) {
          const sig = this.mod.functions.get(e.name);
          if (sig !== undefined) {
            const fnTy = makeFuncTy(sig.params, sig.ret);
            return { v: this.mod.fnValue(e.name, fnTy), ty: fnTy };
          }
        }
        /**
         * The binding's DECLARED type, which is what its STORAGE is laid out as — and
         * therefore the type this load must use. `e.ty` is the checker's type for this
         * READ, which control-flow narrowing may have already sharpened to the present
         * arm; falling back to it directly loses the box.
         *
         * `varTypes` does not hold a module-level binding promoted to a global (SH1) in
         * any frame but `main`, so `mod.globals` has to answer for one here, exactly as
         * `addr` consults it for the address. Without it, `if (g) { g.length }` on a
         * module-level `string | undefined` read `e.ty` = `string`, loaded the A2 BOX
         * pointer and passed it to `js_str_len` as if it were the string: node prints
         * `3`, we printed `1` — the length of the box's first word read as UTF-8. Exit 0,
         * no diagnostic, valid IR. `narrowRead` below is what unwraps the box, and it is
         * gated on seeing a nullable, so it only ever fires once the type is right.
         * `alphaRenameShadows` has already renamed any inner binding of the same name, so
         * a global's name here can only mean the global.
         */
        const declared = this.varTypes.get(e.name) ?? this.mod.globals.get(e.name) ?? (e.ty ?? "number");
        const ty = isUnionTy(declared) && e.ty !== undefined && e.ty !== declared ? e.ty : declared;
        const t = this.fresh();
        this.emit(`${t} = load ${llvmTy(ty)}, ptr ${this.addr(e.name)}`);
        // Drop flag: this read moves the value out, and the binding is still dropped on
        // some other path — null the slot so that drop frees nothing (see nullOnMove).
        if (e.nullOnMove && !this.liftedArrow) this.emit(`store ptr null, ptr ${this.addr(e.name)}`);
        return this.narrowRead(e, { v: t, ty });
      }

      case "MemberExpr": {
        // stdlib Batch 1: `Number.*` numeric constants — folded to their exact IEEE-754 value.
        if (e.object.kind === "Identifier" && e.object.name === "Number" && !this.isBound("Number")) {
          const c = NUMBER_CONSTS.get(e.property);
          if (c !== undefined) return { v: llvmDouble(c), ty: "number" };
        }
        // The `Math.*` data properties — folded the same way, and admitted by the same
        // guard in the checker (both consult the one table, so neither can drift).
        if (e.object.kind === "Identifier" && e.object.name === "Math" && !this.isBound("Math")) {
          const c = MATH_CONSTS.get(e.property);
          if (c !== undefined) return { v: llvmDouble(c), ty: "number" };
        }
        // Host I/O: process.argv (string[]) and process.env.NAME (string). Recognized
        // only when `process` is not a user binding (matches the checker's guard).
        if (!this.varTypes.has("process") && !this.captures.has("process")) {
          if (e.object.kind === "Identifier" && e.object.name === "process" && e.property === "argv") {
            const t = this.fresh();
            this.emit(`${t} = call ptr @nt_argv()`);
            return { v: t, ty: "string[]" };
          }
          // process.platform (string). NOT folded to a literal here even though it is a
          // compile-time constant on the C side: codegen runs once and the SAME .ll is
          // handed to clang with whatever `-target` the build asked for, so a folded
          // constant would report the COMPILING host's platform inside a cross-compiled
          // binary. The runtime's #ifdef follows `-target` instead. See nt_platform().
          if (e.object.kind === "Identifier" && e.object.name === "process" && e.property === "platform") {
            const t = this.fresh();
            this.emit(`${t} = call ptr @nt_platform()`);
            return { v: t, ty: "string" };
          }
          if (
            e.object.kind === "MemberExpr" && e.object.object.kind === "Identifier" &&
            e.object.object.name === "process" && e.object.property === "env"
          ) {
            const t = this.fresh();
            this.emit(`${t} = call ptr @nt_getenv(ptr ${this.mod.intern(e.property)})`);
            return { v: t, ty: "string" };
          }
        }
        // An optional chain whose result is nullable is lowered as a unit: guard at
        // each `?.`, short-circuiting the WHOLE rest of the chain to `undefined`.
        if (e.ty !== undefined && isNullableTy(e.ty) && isOptChainExpr(e)) return this.genOptChain(e);
        let obj = this.genExpr(e.object);
        // SH2 narrowing: the checker may have retyped this receiver from the union to one
        // of its members. The POINTER is identical — only the slot layout the fields are
        // read with changes — so take the checker's answer wherever it narrowed. Done on
        // the MemberExpr (not on the Identifier) so it covers every producer of a union
        // value alike: a local, a closure capture, a `for-of` element, a call result.
        //
        // A narrowed receiver is a SUB-UNION as often as it is a single member, and that
        // second case was missing here — `isObjectTy` alone. `switch (o.inner.kind) {
        // case "A": case "B": return o.inner.v; }` has produced one since SH2, and the
        // checker accepts `.v` on it whenever `unionCommonField` does; codegen then
        // re-derived the receiver type from the FIELD (`fieldType(Box, "inner")`, the
        // WHOLE union), asked `unionCommonField` about that instead, and died on the
        // assertion below. A loud InternalError rather than a wrong slot, because that
        // assertion is there — but a crash on a program the checker had blessed.
        //
        // Only a discriminated union may be retyped this way, and only from a union: the
        // move is sound exactly because a `U<…>` value IS the member pointer, so the
        // retype emits nothing. When nothing was narrowed the checker's stamp is the same
        // type and this is a no-op.
        const narrowedRecv = e.object.ty;
        if (isUnionTy(obj.ty) && narrowedRecv !== undefined && (isObjectTy(narrowedRecv) || isUnionTy(narrowedRecv))) {
          obj = { v: obj.v, ty: narrowedRecv };
        }
        if (obj.ty === "Dyn") { // dynamic field access: nt_dyn_get_field returns a Dyn
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_dyn_get_field(ptr ${obj.v}, ptr ${this.mod.intern(e.property)})`);
          return { v: t, ty: "Dyn" };
        }
        // fetch's Response block: `.status` / `.headers` are slots; `.ok` is the
        // spec's 200..299 predicate computed from the status.
        if (isResponseTy(obj.ty)) {
          if (e.property === "status") return this.responseSlot(obj.v, 0, "number");
          if (e.property === "headers") return this.responseSlot(obj.v, 2, "Headers");
          const st = this.responseSlot(obj.v, 0, "number").v;
          const lo = this.fresh(); this.emit(`${lo} = fcmp oge double ${st}, ${llvmDouble(200)}`);
          const hi = this.fresh(); this.emit(`${hi} = fcmp olt double ${st}, ${llvmDouble(300)}`);
          const ok = this.fresh(); this.emit(`${ok} = and i1 ${lo}, ${hi}`);
          return { v: ok, ty: "boolean" };
        }
        // stdlib Batch 3: a URL component is one runtime re-parse of the URL text.
        // `.searchParams` is the query text (the same handle shape), so it is the
        // `.search` accessor with the leading '?' stripped by `nt_qs_init`.
        if (isUrlTy(obj.ty)) {
          const t = this.fresh();
          if (e.property === "searchParams") {
            const q = this.fresh();
            this.emit(`${q} = call ptr @nt_url_search(ptr ${obj.v})`);
            this.emit(`${t} = call ptr @nt_qs_init(ptr ${q})`);
            return { v: t, ty: "URLSearchParams" };
          }
          this.emit(`${t} = call ptr @nt_url_${e.property}(ptr ${obj.v})`);
          return { v: t, ty: "string" };
        }
        if (e.property === "length" && (obj.ty === "string" || isArrayTy(obj.ty) || isBytesTy(obj.ty))) {
          const t = this.fresh();
          if (obj.ty === "string") this.emit(`${t} = call double @js_str_len(ptr ${obj.v})`);
          else if (isBytesTy(obj.ty)) this.emit(`${t} = call double @nt_bytes_len(ptr ${obj.v})`);
          else {
            this.emit(`${t} = call double @nt_arr_len(ptr ${obj.v})`);
            // `xs.map(f).length` — reading the length is the last use of that temporary.
            this.freeReceiverTemp(e.object, obj, "length", { v: t, ty: "number" });
          }
          return { v: t, ty: "number" };
        }
        if ((isMapTy(obj.ty) || isSetTy(obj.ty)) && e.property === "size") {
          const sz = this.fresh();
          this.emit(`${sz} = call i64 @nt_coll_size(ptr ${obj.v})`);
          const d = this.fresh();
          this.emit(`${d} = sitofp i64 ${sz} to double`);
          return { v: d, ty: "number" };
        }
        // SH2: on an un-narrowed union the readable fields are the ones `unionCommonField`
        // admits — in every member, at the SAME slot, with the SAME type. That is exactly
        // what makes this an ordinary constant-offset slot load with no tag test, which is
        // in turn what lets the union go unboxed. The discriminant is the degenerate case
        // (same slot by construction, every member's literal tag widening to `string`), so
        // it needs no branch of its own; the checker refuses everything this declines.
        if (isUnionTy(obj.ty)) {
          // NOT a `!`. The checker refuses every read this declines, so reaching here with
          // nothing means the two passes have drifted — and the failure mode of guessing a
          // slot is a load at the wrong offset, which is the one outcome this whole rule
          // exists to prevent. Say so loudly instead of emitting a plausible `getelementptr`.
          const c = unionCommonField(obj.ty, e.property);
          if (!c) throw internalError(`.${e.property} is not at one slot in every member of ${obj.ty}`);
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${c.index}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          return this.narrowRead(e, { v: this.fromSlot(slot, c.ty), ty: c.ty });
        }
        if (isObjectTy(obj.ty)) {
          const idx = fieldIndex(obj.ty, e.property);
          const ft = fieldType(obj.ty, e.property)!;
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${idx}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          // A DOTTED NAME the checker narrowed unwraps here, by the same `nt_nonnull` an
          // identifier read uses — the object is immutable, so the field cannot have been
          // rewritten since the proof, and a wrong proof panics rather than inventing one.
          return this.narrowRead(e, { v: this.fromSlot(slot, ft), ty: ft });
        }
        throw internalError(`no member lowering for .${e.property} on ${e.object.ty ?? "an untyped receiver"}`);
      }

      case "TypeofExpr": {
        const inner = e.operand.ty ?? "number";
        // A runtime-nullable value's typeof depends on its tag: undefined→"undefined",
        // null→"object", present→typeof(base). Branch at runtime.
        if (isNullableTy(inner)) return this.genTypeofNullable(this.genExpr(e.operand).v, baseTy(inner));
        // A general union's typeof is likewise a RUNTIME fact — it is the whole point of
        // the box's tag, and it is what the checker's narrowing is reading.
        if (isGeneralUnionTy(inner)) return this.genTypeofGeneralUnion(this.genExpr(e.operand).v, inner);
        // Everything else is a compile-time constant. This used to ENUMERATE the object-ish
        // kinds and fall through to `inner` — the raw `Ty` encoding — so any kind nobody
        // listed printed the compiler's internal spelling as a JavaScript answer
        // (`typeof new Set(…)` → `"Set<string>"`, and a tagged union printed its whole
        // member list). `staticTypeofName` inverts the dispatch: five non-object answers,
        // `"object"` otherwise.
        return { v: this.mod.intern(this.typeofNameOf(inner)), ty: "string" };
      }

      case "UnaryExpr": {
        if (e.op === "+") return { v: this.coerceToNumber(this.genExpr(e.operand)), ty: "number" };
        if (e.op === "void") { this.genExpr(e.operand); return { v: "0", ty: "undefined" }; }
        if (e.op === "~") {
          const x = this.genExpr(e.operand);
          const t = this.fresh();
          this.emit(`${t} = call double @js_bit_not(double ${x.v})`);
          return { v: t, ty: "number" };
        }
        if (e.op === "-") {
          const x = this.genExpr(e.operand);
          const t = this.fresh();
          this.emit(`${t} = fneg double ${x.v}`);
          return { v: t, ty: "number" };
        }
        // '!'
        const cond = this.genCond(e.operand);
        const t = this.fresh();
        this.emit(`${t} = xor i1 ${cond}, true`);
        return { v: t, ty: "boolean" };
      }

      case "UpdateExpr": {
        // Member/index target (`this.n++`, `u[i]++`). Read-modify-write in place, with
        // the object and index evaluated EXACTLY ONCE (node semantics), yielding the old
        // value for postfix and the new one for prefix. Only writable targets reach here
        // — the parser/checker rejected the immutable ones with NT1606.
        if (e.targetExpr) {
          const tgt = e.targetExpr;
          const delta = e.op === "++" ? "fadd" : "fsub";
          if (tgt.kind === "IndexExpr") {
            const obj = this.genExpr(tgt.object);
            const idx = this.genExpr(tgt.index);
            const old = this.fresh();
            this.emit(`${old} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
            const nv = this.fresh();
            this.emit(`${nv} = ${delta} double ${old}, 1.0`);
            this.emit(`call void @nt_bytes_set(ptr ${obj.v}, double ${idx.v}, double ${nv})`);
            // The stored byte wraps (ToUint8), so a prefix update must report the byte
            // that landed, not the raw sum — read it back rather than reusing `nv`.
            if (!e.prefix) return { v: old, ty: "number" };
            const back = this.fresh();
            this.emit(`${back} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
            return { v: back, ty: "number" };
          }
          // NARROW on the TAG, do not assert it. This was
          //   const m = tgt as Extract<Expr, { kind: "MemberExpr" }>;
          // an `as` that claims a shape rather than checking one — the same defect shape
          // the `(e.callee as {name: string}).name` family had, and with the same result:
          // the cast is erased, so a `tgt` of any OTHER kind is read as if it had an
          // `object` slot. It did happen. `resolveStaticFieldReads` rewrote the `C.n` in
          // `C.n++` into a bare Identifier (its write-detection missed `UpdateExpr` —
          // fixed in src/ast.ts `staticExpr`), that Identifier arrived here, and
          // `m.object` was `undefined`: `TypeError: undefined is not an object (evaluating
          // 'e.kind')` from inside `genExprInner`, with a bun stack trace and no NT code.
          //
          // The checker fix makes THAT program unreachable; this makes the next one a
          // report instead of a crash. `internalError` and not an NT code on purpose: if
          // a target that is neither MemberExpr nor IndexExpr ever reaches here again, the
          // frontend admitted something codegen cannot lower and the bug is ours — see the
          // note on `InternalError` in src/diagnostics.ts.
          if (tgt.kind !== "MemberExpr") {
            throw internalError(`no update lowering for a target of kind ${tgt.kind} — \`${e.op}\` on a member/index target reaches codegen only as a MemberExpr or an IndexExpr, so the frontend rewrote this one (a static field's \`C.f\` read becomes a bare Identifier) without refusing the write first`);
          }
          const obj = this.genExpr(tgt.object);
          const slot = this.fresh();
          this.emit(`${slot} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, tgt.property)}`);
          const raw = this.fresh();
          this.emit(`${raw} = load i64, ptr ${slot}`);
          const old = this.fresh();
          this.emit(`${old} = bitcast i64 ${raw} to double`);
          const nv = this.fresh();
          this.emit(`${nv} = ${delta} double ${old}, 1.0`);
          const back = this.fresh();
          this.emit(`${back} = bitcast double ${nv} to i64`);
          this.emit(`store i64 ${back}, ptr ${slot}`);
          return { v: e.prefix ? nv : old, ty: "number" };
        }
        if (this.captures.has(e.target)) {
          const cur = this.readCapture(e.target);
          const nv = this.fresh();
          this.emit(`${nv} = ${e.op === "++" ? "fadd" : "fsub"} double ${cur.v}, 1.0`);
          this.writeCapture(e.target, { v: nv, ty: "number" });
          return { v: e.prefix ? nv : cur.v, ty: "number" };
        }
        const old = this.fresh();
        this.emit(`${old} = load double, ptr ${this.addr(e.target)}`);
        const nv = this.fresh();
        this.emit(`${nv} = ${e.op === "++" ? "fadd" : "fsub"} double ${old}, 1.0`);
        this.emit(`store double ${nv}, ptr ${this.addr(e.target)}`);
        return { v: e.prefix ? nv : old, ty: "number" };
      }

      case "BinaryExpr": {
        const op = e.op;
        if (FCMP.has(op)) {
          const lt = e.left.ty ?? "number";
          // A2 nullable === undefined / === null: compare the BOX TAG (0=undefined,
          // 1=null, 2=present), never truthiness — so `0` / `""` / `false` are present.
          const nullLit = (t: Ty | undefined): number | null => t === "undefined" ? 0 : t === "null" ? 1 : null;
          const boxSide = isNullableTy(lt) ? e.left : isNullableTy(e.right.ty ?? "number") ? e.right : null;
          if (boxSide && nullLit((boxSide === e.left ? e.right : e.left).ty) !== null) {
            const want = nullLit((boxSide === e.left ? e.right : e.left).ty)!;
            const box = this.genExpr(boxSide);
            const eq = this.fresh();
            this.emit(`${eq} = icmp eq i64 ${this.nullTag(box.v)}, ${want}`);
            if (op === "===" || op === "==") return { v: eq, ty: "boolean" };
            const ne = this.fresh();
            this.emit(`${ne} = xor i1 ${eq}, true`);
            return { v: ne, ty: "boolean" };
          }
          const l = this.genExpr(e.left);
          const r = this.genExpr(e.right);
          // Unit types, BEFORE a register is allocated: every value of `undefined` is THE
          // undefined and every value of `null` is THE null, so equality is a CONSTANT —
          // node's `null === null` is `true`. (The checker already refused the mixed pair,
          // so reaching here means both sides are the same unit type.) These used to fall
          // all the way into the `js_str_eq` arm below and hand it an `i8`, which made
          // `const a = null; const b = null; a === b` a clang error naming an SSA register
          // rather than the `true` node prints. Both operands are still evaluated above,
          // for their side effects.
          if (lt === "undefined" || lt === "null" || lt === "void")
            return { v: op === "===" || op === "==" ? "true" : "false", ty: "boolean" };
          const t = this.fresh();
          if (lt === "number") {
            this.emit(`${t} = fcmp ${FCMP.get(op)!} double ${l.v}, ${r.v}`);
          } else if (lt === "boolean") {
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "eq" : "ne"} i1 ${l.v}, ${r.v}`);
          } else if (isArrayTy(lt) || isObjectTy(lt)) {
            // Heap reference identity: arrays/objects compare by pointer (as node
            // does for `===`), so a CoW copy is `!==` its source. NOT strcmp.
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "eq" : "ne"} ptr ${l.v}, ${r.v}`);
          } else if (op === "<" || op === "<=" || op === ">" || op === ">=") {
            // Lexicographic string compare: sign of js_str_cmp (memcmp order ==
            // code-point order; node compares UTF-16 code units — see divergences).
            const c = this.fresh();
            this.emit(`${c} = call i32 @js_str_cmp(ptr ${l.v}, ptr ${r.v})`);
            this.emit(`${t} = icmp ${op === "<" ? "slt" : op === "<=" ? "sle" : op === ">" ? "sgt" : "sge"} i32 ${c}, 0`);
          } else {
            // The BYTE-WISE arm, and it is only correct for a `ptr`. This was the plain
            // `else` — the DEFAULT — so every type whose representation is not a pointer
            // reached it and handed a `double`/`i1`/`i8` to a `ptr` parameter: `date ===
            // date` emitted `js_str_eq(ptr <double>)` and came back to the user as a raw
            // clang error with no NT code and no hint. The guard makes any remaining
            // member of that class a loud compiler bug report instead, naming the type.
            if (llvmTy(lt) !== "ptr")
              throw internalError(`\`${op}\` on ${lt}, whose representation is \`${llvmTy(lt)}\` and not a pointer — the checker should have refused it, or this chain needs an arm for it`);
            const eq = this.fresh();
            this.emit(`${eq} = call i32 @js_str_eq(ptr ${l.v}, ptr ${r.v})`);
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "ne" : "eq"} i32 ${eq}, 0`);
          }
          return { v: t, ty: "boolean" };
        }
        if (BITFN.has(op)) {
          const l = this.genExpr(e.left);
          const r = this.genExpr(e.right);
          const t = this.fresh();
          this.emit(`${t} = call double @${BITFN.get(op)!}(double ${l.v}, double ${r.v})`);
          return { v: t, ty: "number" };
        }
        if (op === "+" && e.ty === "string") {
          // Both operands are CONSUMED by the concat (it copies), so whichever of them
          // this frame allocated is dead on the next instruction and nothing else owns
          // it — it is not a local, so no scope exit would ever have released it. The
          // result is the caller's; it is never released here.
          const l = this.concatOperand(e.left);
          const r = this.concatOperand(e.right);
          const out = this.concat(l.v, r.v);
          this.releaseTemp(l);
          this.releaseTemp(r);
          return { v: out, ty: "string" };
        }
        const l = this.genExpr(e.left);
        const r = this.genExpr(e.right);
        const t = this.fresh();
        // `**` is Number::exponentiate, which C `pow` gets wrong for a unit base with a
        // non-finite exponent — `js_pow` is the spec-shaped wrapper. Math.pow shares it.
        if (op === "**") this.emit(`${t} = call double @js_pow(double ${l.v}, double ${r.v})`);
        else this.emit(`${t} = ${ARITH.get(op)!} double ${l.v}, ${r.v}`);
        return { v: t, ty: "number" };
      }

      case "LogicalExpr": {
        if (e.op === "??") {
          const lt = e.left.ty ?? "number";
          if (lt === "null" || lt === "undefined") return this.genExpr(e.right); // statically nullish → right
          if (!isNullableTy(lt)) return this.genExpr(e.left);                     // statically present → left
          // runtime-nullable left: TAG-based branch (never truthiness).
          //
          // The RESULT type is the checker's, not `baseTy(lt)`: `??` only consumes the
          // LEFT's nullishness, so a still-nullable right keeps the whole expression
          // nullable (`a ?? b` on two `string|undefined`s). Both arms are therefore
          // COERCED into it, exactly as `ConditionalExpr` below does — the left arm
          // unboxes to the base and may re-box, the right arm may already be a box.
          // Storing the right arm RAW into a `base` slot is what silently reinterpreted
          // a [tag,value] box as a string pointer and made `a ?? b ?? "fallback"` skip
          // its fallback. See test/nullish-coalesce.test.ts.
          const base = baseTy(lt);
          const ty = (e.ty ?? base) as Ty;
          const box = this.genExpr(e.left);
          const slot = this.slot(ty);
          const isN = this.isNullish(box.v);
          const rLbl = this.label("nc"), lLbl = this.label("ncl"), endLbl = this.label("nce");
          this.terminate(`br i1 ${isN}, label %${rLbl}, label %${lLbl}`);
          this.to(this.block(rLbl));
          const rv = this.coerce(this.genExpr(e.right), ty);
          this.emit(`store ${llvmTy(ty)} ${rv.v}, ptr ${slot}`);
          this.terminate(`br label %${endLbl}`);
          this.to(this.block(lLbl));
          const lv = this.fromSlot(this.nullVal(box.v), base); // unbox the present value
          const lc = this.coerce({ v: lv, ty: base }, ty);
          this.emit(`store ${llvmTy(ty)} ${lc.v}, ptr ${slot}`);
          this.terminate(`br label %${endLbl}`);
          this.to(this.block(endLbl));
          const t = this.fresh();
          this.emit(`${t} = load ${llvmTy(ty)}, ptr ${slot}`);
          return { v: t, ty };
        }
        // `&&` / `||` — value-returning short-circuit (result type = operand type).
        //
        // …except in TRUTHINESS position, where the checker types the node `boolean`
        // whatever its operands are (see its `typeCond`): `Boolean(a && b)` is exactly
        // `Boolean(a) && Boolean(b)`. There the value stored is each operand's
        // TRUTHINESS, not the operand — storing a `string | undefined` box into an `i1`
        // slot is not a representation the slot has. Keyed off the result type rather
        // than a flag, and it subsumes the old path rather than sitting beside it:
        // `truthyOf` of a `boolean` is that boolean, so a plain `b1 && b2` emits exactly
        // what it emitted before.
        const ty = (e.ty ?? "boolean") as Ty;
        const slot = this.slot(ty);
        const l = this.genExpr(e.left);
        if (ty !== "boolean") this.emit(`store ${llvmTy(ty)} ${l.v}, ptr ${slot}`);
        const cond = this.truthyOf(l);
        if (ty === "boolean") this.emit(`store i1 ${cond}, ptr ${slot}`);
        const evalLbl = this.label("rhs");
        const endLbl = this.label("logend");
        if (e.op === "&&") this.terminate(`br i1 ${cond}, label %${evalLbl}, label %${endLbl}`);
        else this.terminate(`br i1 ${cond}, label %${endLbl}, label %${evalLbl}`);
        this.to(this.block(evalLbl));
        const r = this.genExpr(e.right);
        this.emit(`store ${llvmTy(ty)} ${ty === "boolean" ? this.truthyOf(r) : r.v}, ptr ${slot}`);
        this.terminate(`br label %${endLbl}`);
        this.to(this.block(endLbl));
        const t = this.fresh();
        this.emit(`${t} = load ${llvmTy(ty)}, ptr ${slot}`);
        return { v: t, ty };
      }

      case "ConditionalExpr": {
        const ty = e.ty ?? "number";
        const slot = this.slot(ty);
        const cond = this.genCond(e.test);
        const thenLbl = this.label("tern");
        const elseLbl = this.label("ternelse");
        const endLbl = this.label("ternend");
        this.terminate(`br i1 ${cond}, label %${thenLbl}, label %${elseLbl}`);
        // COERCE each arm into the ternary's own type. The checker's `?:` join is a
        // union (`b ? tag : undefined` is `?Ustring`), so an arm's value is not always
        // already in the result's representation — the `undefined` arm is an i64 zero
        // where the slot wants a [tag,value] box. Storing it raw emitted
        // `store ptr 0, ptr %s1`, which clang rejects outright ("integer constant must
        // have integer type"): the diagnostic contract failing, not a miscompile, but
        // in the same family as the try/finally return slot that never coerced.
        this.to(this.block(thenLbl));
        const c = this.coerce(this.genExpr(e.consequent), ty);
        this.emit(`store ${llvmTy(ty)} ${c.v}, ptr ${slot}`);
        this.terminate(`br label %${endLbl}`);
        this.to(this.block(elseLbl));
        const a = this.coerce(this.genExpr(e.alternate), ty);
        this.emit(`store ${llvmTy(ty)} ${a.v}, ptr ${slot}`);
        this.terminate(`br label %${endLbl}`);
        this.to(this.block(endLbl));
        const t = this.fresh();
        this.emit(`${t} = load ${llvmTy(ty)}, ptr ${slot}`);
        return { v: t, ty };
      }

      case "AssignExpr": {
        if (this.captures.has(e.target)) {
          const cty = this.captures.get(e.target)!.ty;
          if (e.op === "=") { const v = this.genExpr(e.value); this.writeCapture(e.target, v); return { v: v.v, ty: cty }; }
          const cur = this.readCapture(e.target);
          const rv = this.genExpr(e.value);
          const bare0 = e.op.slice(0, -1);
          const t0 = this.fresh();
          if (ARITH.has(bare0)) this.emit(`${t0} = ${ARITH.get(bare0)!} double ${cur.v}, ${rv.v}`);
          else this.emit(`${t0} = call double @${BITFN.get(bare0)!}(double ${cur.v}, double ${rv.v})`);
          this.writeCapture(e.target, { v: t0, ty: "number" });
          return { v: t0, ty: "number" };
        }
        /**
         * The TYPE of the assignment target. `varTypes` only knows the frame's own
         * bindings, so for a module-level binding promoted to a global (SH1) it is empty
         * in every frame but `main` — and the old `?? "number"` fallback then lowered
         * EVERY such write as a bare `double`, at whatever the global's real layout was.
         * `addr()` already consults `mod.globals` for the same reason; the type had to,
         * or the address and the value it stores describe different cells.
         *
         * It was not one bug but the whole family: `g = undefined` on a module-level
         * `number | undefined` skipped the nullable BOXING (`store double 0, ptr @g`),
         * a `string`/`boolean`/array global stored a pointer as a `double`, and `s += "b"`
         * on a `string` global took the ARITHMETIC path (`fadd double %t, @.str.0`). Most
         * of those are caught by clang's parser — but `g = 7` on a `number | undefined`
         * global is `store double 7.0, ptr @g` into a box slot, which is well-formed IR
         * that LLVM's own verifier accepts and SEGFAULTS on the next read. That one shape
         * was a silent miscompile with nothing anywhere to catch it, which is why the type
         * has to be right here rather than the constant made well-formed downstream.
         */
        const ty = this.varTypes.get(e.target) ?? this.mod.globals.get(e.target) ?? "number";
        if (e.op === "=") {
          const consume = this.consumingSpread(e, ty);
          if (consume) { this.consumeNode = consume; }
          const val = this.coerce(this.genExpr(e.value), ty); // box into a nullable slot if needed
          this.consumeNode = null;
          // RC: reassigning a string local. Retain an aliased borrow so the new value
          // outlives the assignment (safe if it escapes); the previous value is left
          // to leak (a conservative over-retention) rather than risk a premature free.
          if (ty === "string" && this.strLocals.has(e.target)) this.retainStrBind(e.value, val.v);
          // RAII on reassignment (B2 step 4): free the superseded linear value AFTER the
          // right-hand side has been evaluated (it may read the old value) and before the
          // slot is overwritten. `dropOld` is the ownership pass's proof that it is dead.
          this.emitDropOld(e, ty);
          this.emit(`store ${llvmTy(ty)} ${val.v}, ptr ${this.addr(e.target)}`);
          return { v: val.v, ty };
        }
        if (e.op === "+=" && ty === "string") {
          const old = this.fresh();
          this.emit(`${old} = load ptr, ptr ${this.addr(e.target)}`);
          const rv = this.coerceToString(this.genExpr(e.value));
          const cat = this.concat(old, rv);
          this.emit(`store ptr ${cat}, ptr ${this.addr(e.target)}`);
          return { v: cat, ty: "string" };
        }
        const old = this.fresh();
        this.emit(`${old} = load double, ptr ${this.addr(e.target)}`);
        const rv = this.genExpr(e.value);
        const bare = e.op.slice(0, -1); // "+", "&", "<<", ...
        const t = this.fresh();
        if (ARITH.has(bare)) this.emit(`${t} = ${ARITH.get(bare)!} double ${old}, ${rv.v}`);
        else this.emit(`${t} = call double @${BITFN.get(bare)!}(double ${old}, double ${rv.v})`);
        this.emit(`store double ${t}, ptr ${this.addr(e.target)}`);
        return { v: t, ty: "number" };
      }

      /**
       * `expr as T` — the type assertion, and NOT an identity retype.
       *
       * It used to be one, which made `as` a hole through the value model: nativets
       * reasons about MEMORY LAYOUT where tsc reasons about types, and the two genuinely
       * disagree here — tsc ACCEPTS a union-to-member downcast, so no diagnostic
       * anywhere fired. Retyping a `U<…>` to one of its members reinterpreted the same
       * bytes at a different member's field layout and returned a neighbouring slot; and
       * retyping across a `G<…>` / nullable BOX boundary emitted IR that did not even
       * verify. See `genAsCast` for the case analysis and what each case costs.
       */
      case "AsExpr": {
        // Narrowing a dynamic value (`dyn as T`) emits a runtime validator that
        // checks the tag and unboxes — its own, much heavier, machinery.
        if (e.expr.ty === "Dyn") return this.genDynNarrow(this.genExpr(e.expr).v, e.ty);
        return this.genAsCast(this.genExpr(e.expr), e.ty, exprLoc(e));
      }

      // `satisfies` never retypes, so it erases completely — no validator, no retag.
      case "SatisfiesExpr": return this.genExpr(e.expr);
      /**
       * `expr!` — the non-null assertion. On a non-nullable operand it is the identity.
       * On a nullable it UNWRAPS the A2 tagged pair to the bare value.
       *
       * What happens when the assertion is FALSE is a deliberate divergence, and it
       * follows Stage 41 exactly. TypeScript erases `!`, so node hands back `undefined`
       * and the program computes on with a value that was never there — the silent wrong
       * answer this project refuses. Unwrapping a tag-0 box would be strictly worse (a
       * phantom `0` / dangling pointer rather than an honest `undefined`). So a false
       * assertion PANICS at the `!`, with the same stderr + exit-134 shape as an
       * out-of-bounds index. `!` is an assertion; this is what asserting means.
       */
      case "NonNullExpr": {
        const inner = this.genExpr(e.expr);
        if (!isNullableTy(inner.ty)) return inner; // identity — nothing to narrow
        const base = baseTy(inner.ty);
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_nonnull(ptr ${inner.v}, ptr ${this.locArg(e.loc) ?? "null"})`);
        return { v: this.fromSlot(slot, base), ty: base };
      }
      case "InstanceOfExpr": {
        // The checker already decided the test from the static type; emit the constant.
        // The left operand is still evaluated — it may have side effects (`f() instanceof C`).
        this.genExpr(e.object);
        return { v: e.result ? "true" : "false", ty: "boolean" };
      }
      case "InExpr": {
        // Same shape as `instanceof`: the checker decided it from the static type, and
        // both operands are still evaluated for their side effects (`k() in f()`).
        this.genExpr(e.key);
        this.genExpr(e.object);
        return { v: e.result ? "true" : "false", ty: "boolean" };
      }
      case "IndexAssign": {
        // Element write `u[i] = v` (+ compound) — only Uint8Array reaches codegen (the
        // checker rejects immutable array/object index-assign with NT1606). The store
        // clamps/wraps to a byte in the runtime (JS ToUint8). Evaluate obj + index once.
        const obj = this.genExpr(e.object);
        const idx = this.genExpr(e.index);
        // An out-of-range typed-array write used to be a SILENT no-op; it panics now.
        const loc = this.locArg(e.loc);
        let out: string;
        if (e.op === "=") {
          out = this.genExpr(e.value).v;
        } else {
          const cur = this.fresh();
          this.emit(loc
            ? `${cur} = call double @nt_bytes_index(ptr ${obj.v}, double ${idx.v}, ptr ${loc})`
            : `${cur} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
          const rv = this.genExpr(e.value);
          const bare = e.op.slice(0, -1); // "+", "&", "<<", ...
          out = this.fresh();
          if (ARITH.has(bare)) this.emit(`${out} = ${ARITH.get(bare)!} double ${cur}, ${rv.v}`);
          else this.emit(`${out} = call double @${BITFN.get(bare)!}(double ${cur}, double ${rv.v})`);
        }
        this.emit(loc
          ? `call void @nt_bytes_index_set(ptr ${obj.v}, double ${idx.v}, double ${out}, ptr ${loc})`
          : `call void @nt_bytes_set(ptr ${obj.v}, double ${idx.v}, double ${out})`);
        return { v: out, ty: "number" };
      }
      case "FieldAssign": {
        // `this.field = value` — store one instance slot (constructor initialization).
        const obj = this.genExpr(e.object);
        const ft = fieldType(obj.ty, e.field)!;
        const slot = this.toSlot(this.coerce(this.genExpr(e.value), ft));
        const g = this.fresh();
        this.emit(`${g} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, e.field)}`);
        this.emit(`store i64 ${slot}, ptr ${g}`);
        return { v: this.fromSlot(slot, ft), ty: ft };
      }
      case "NewExpr": {
        // Immutable collections (B2): fresh empty handle from the nt_hamt runtime.
        if (e.callee === "Map") {
          const m = this.fresh();
          if (e.args.length === 1) { // `new Map(otherMap)` — a fresh, insertion-ordered copy
            const src = this.genExpr(e.args[0]!);
            this.emit(`${m} = call ptr @nt_coll_map_from_coll(ptr ${src.v})`);
            return { v: m, ty: e.ty! };
          }
          this.emit(`${m} = call ptr @nt_coll_map_new()`);
          return { v: m, ty: e.ty! };
        }
        if (e.callee === "Set") {
          const s = this.fresh();
          if (e.args.length === 1) {
            // `new Set(array)` — the runtime folds the array through the same
            // add path, so dedup and insertion order match node exactly. A Set
            // source is materialized to its insertion-ordered key array first;
            // that also makes the result a FRESH handle, as node's copy is
            // (`new Set(a) === a` is false, and `===` on a Set is identity here).
            const src = this.genExpr(e.args[0]!);
            let arr = src.v;
            if (isSetTy(src.ty)) { const k = this.fresh(); this.emit(`${k} = call ptr @nt_coll_keys(ptr ${src.v})`); arr = k; }
            this.emit(`${s} = call ptr @nt_coll_set_from_arr(ptr ${arr}, i32 ${this.keyTag(setElemTy(e.ty!))})`);
            return { v: s, ty: e.ty! };
          }
          this.emit(`${s} = call ptr @nt_coll_set_new()`);
          return { v: s, ty: e.ty! };
        }
        // Bytes (stdlib batch 2): `new Uint8Array(n)` -> zero-filled; `new Uint8Array([..])`
        // -> from the number array (each ToUint8). TextEncoder/TextDecoder are stateless
        // (no runtime object), represented by a null sentinel ptr.
        if (e.callee === "Uint8Array") {
          const arg = this.genExpr(e.args[0]!);
          const b = this.fresh();
          if (isArrayTy(arg.ty)) this.emit(`${b} = call ptr @nt_bytes_from_arr(ptr ${arg.v})`);
          else this.emit(`${b} = call ptr @nt_bytes_new(double ${arg.v})`);
          return { v: b, ty: "Uint8Array" };
        }
        if (e.callee === "TextEncoder" || e.callee === "TextDecoder") return { v: "null", ty: e.callee };
        // --- stdlib Batch 3 ---
        // `new Date()` reads the clock; `new Date(ms)` TimeClips; `new Date(iso)` parses
        // the ES Date Time String Format (NaN == node's Invalid Date). The VALUE is the
        // time value itself, so there is nothing to allocate and nothing to drop.
        if (e.ty === "Date") {
          const t = this.fresh();
          if (e.args.length === 0) this.emit(`${t} = call double @nt_date_now()`);
          else {
            const a = this.genExpr(e.args[0]!);
            this.emit(a.ty === "string"
              ? `${t} = call double @nt_date_parse(ptr ${a.v})`
              : `${t} = call double @nt_date_from_ms(double ${a.v})`);
          }
          return { v: t, ty: "Date" };
        }
        // `new URL(u)` / `new URLSearchParams(q)` are string handles: the URL text and the
        // raw query text. `new URL` VALIDATES here (node throws a TypeError on a URL it
        // cannot parse), through the catchable pending-exception protocol.
        if (e.ty === "URL") {
          const u = this.genExpr(e.args[0]!);
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_url_validate(ptr ${u.v})`);
          this.emitExcCheck();
          return { v: t, ty: "URL" };
        }
        if (e.ty === "URLSearchParams") {
          const q = this.genExpr(e.args[0]!);
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_qs_init(ptr ${q.v})`);
          return { v: t, ty: "URLSearchParams" };
        }
        // `new C(args)` on a user class: allocate the field slot block, then run the
        // constructor (`C.constructor(this, …args)`), and hand back the instance ptr.
        const cls = e.ty === undefined ? undefined : classTag(e.ty);
        if (cls) {
          const objTy = e.ty!;
          const nfields = objectFields(objTy).length;
          const obj = this.fresh();
          this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(nfields, 1))})`);
          const csig = this.mod.functions.get(`${cls}.constructor`)!;
          const argVals: string[] = [`ptr ${obj}`];
          for (let i = 1; i < csig.params.length; i++) {
            // `i - 1 < e.args.length` FIRST: a defaulted parameter means the read is at
            // index == length, which nativets PANICS on (Stage 41) — see the census note
            // in test/no-index-last.test.ts.
            const v = i - 1 < e.args.length ? this.genExpr(e.args[i - 1]!) : this.genExpr(csig.defaults[i]!);
            argVals.push(`${llvmTy(csig.params[i]!)} ${this.coerce(v, csig.params[i]!).v}`);
          }
          // A DECORATED class's constructor returns the instance (the `@wrapper` sees
          // `(instance, …args) => instance`, so it may hand back a different one); an
          // ordinary constructor is `void` and the allocation IS the value.
          if (csig.ret === objTy) {
            const r = this.fresh();
            this.emit(`${r} = call ptr @${cls}.constructor(${argVals.join(", ")})`);
            return { v: r, ty: objTy };
          }
          this.emit(`call void @${cls}.constructor(${argVals.join(", ")})`);
          return { v: obj, ty: objTy };
        }
        // new Error(msg) → object { message: msg }
        const msg = this.genExpr(e.args[0]!);
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(1)})`);
        const g = this.fresh();
        this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 0`);
        this.emit(`store i64 ${this.toSlot(msg)}, ptr ${g}`);
        return { v: obj, ty: "{message:string}" };
      }
      case "CallExpr": return this.genCall(e);
    }
  }

  private genCall(e: Extract<Expr, { kind: "CallExpr" }>): Val {
    const cm = consoleMethod(e);
    if (cm !== null) return this.genConsoleLog(e.args, CONSOLE_STREAMS.get(cm) ?? "out");

    // process.stdout.write(s) — the string verbatim, no newline and no separator.
    // Same buffer as console.log (`js_print_str` is what console.log's string arm
    // calls), so the two interleave in source order and `nt_exit` flushes both.
    if (
      e.callee.kind === "MemberExpr" && e.callee.object.kind === "MemberExpr" &&
      e.callee.object.object.kind === "Identifier" &&
      e.callee.object.object.name === "process" && e.callee.object.property === "stdout" &&
      e.callee.property === "write" &&
      !this.varTypes.has("process") && !this.captures.has("process")
    ) {
      const s = this.genExpr(e.args[0]!);
      this.emit(`call void @js_print_str(ptr ${s.v})`);
      return { v: "0", ty: "void" };
    }

    // process.exit(code?) — flush + exit; the block cannot fall through afterwards.
    if (
      e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" &&
      e.callee.object.name === "process" && e.callee.property === "exit" &&
      !this.varTypes.has("process") && !this.captures.has("process")
    ) {
      const code = e.args.length ? this.genExpr(e.args[0]!).v : llvmDouble(0);
      this.emit(`call void @nt_exit(double ${code})`);
      this.terminate("unreachable");
      return { v: "", ty: "void" };
    }

    // JSON.stringify(x) — serialization generated from x's static type.
    // JSON.parse(s) — runtime recursive-descent parser producing a tagged Dyn box.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "JSON") {
      if (e.callee.property === "parse") {
        const s = this.genExpr(e.args[0]!);
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_json_parse(ptr ${s.v})`);
        this.emitExcCheck();
        return { v: t, ty: "Dyn" };
      }
      // `e.args.length > 2` guards the read: `JSON.stringify(v)` is the common call and
      // `e.args[2]` would be an index == length read, which nativets PANICS on.
      const json = this.genJsonStringify(this.genExpr(e.args[0]!), this.jsonIndentUnit(e.args.length > 2 ? e.args[2] : undefined), 0);
      // The serializer's result is this frame's at rc=1 (a `js_str_concat` fold), so a
      // DISCARDED `JSON.stringify(o);` can be reclaimed rather than leaked. The degenerate
      // shapes — `{}` for a Map/Set/fieldless object, `null` — hand back an interned
      // constant instead, which `nt_str_release` ignores. Never `val` itself: no arm of
      // `genJsonStringify` returns its argument.
      this.discardFree = { v: json.v, call: "nt_str_release" };
      return json;
    }

    // Object.keys(o) / Object.values(o) — keys are compile-time known from o's type.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object" && !this.isBound("Object")) {
      if (e.callee.property === "fromEntries") {
        // Literal entries: the checker has already verified the shape (see `inferCall`),
        // but "verified elsewhere" is not something codegen can read off the node, so the
        // tag is re-tested here through `arrayElements` rather than assumed through a
        // duck-typed window. Both reads used to be `as { elements: Expr[] }`, which names
        // `elements` at slot 0 while `ArrayLiteral` carries it at slot 1 and slot 0 is
        // `kind` — compiled, both took the `kind` STRING POINTER and indexed it.
        // `internalError` rather than a fallback: if the checker's guarantee ever fails,
        // an empty object here would be a silent wrong answer.
        const pairs = arrayElements(e.args[0]!);
        if (pairs === undefined) throw internalError("Object.fromEntries reached codegen with a non-literal argument");
        const ty = e.ty ?? "number";
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(pairs.length)})`);
        pairs.forEach((pair) => {
          const inner = arrayElements(pair);
          if (inner === undefined) throw internalError("Object.fromEntries reached codegen with a non-literal entry");
          // Stored by FIELD INDEX, not by the entry's position in the literal — the same
          // rule `ObjectLiteral` above already follows. Entry order and slot order are two
          // different things now that a minted object type puts ARRAY-INDEX keys first:
          // `[["b",…],["2",…]]` has `2` at slot 0, so indexing by position paired every
          // value with the wrong key. It was silent (the keys and the value SET both still
          // looked right) and exit 0, which is the worst outcome available.
          const key = stringLiteralValue(inner[0]!);
          if (key === undefined) throw internalError("Object.fromEntries reached codegen with a non-literal entry key");
          const v = this.genExpr(inner[1]!);
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, key)}`);
          this.emit(`store i64 ${this.toSlot(v)}, ptr ${gep}`);
        });
        return { v: obj, ty };
      }
      const o = this.genExpr(e.args[0]!);
      if (e.callee.property === "entries") {
        // string[][] — one 2-element [key, value] array per field (checker: string values).
        const fields = objectFields(o.ty);
        const arr = this.fresh();
        this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(fields.length, 1))})`);
        fields.forEach((f, i) => {
          const pair = this.fresh();
          this.emit(`${pair} = call ptr @nt_arr_new(double 2.0)`);
          this.emit(`call double @nt_arr_push(ptr ${pair}, i64 ${this.toSlot({ v: this.mod.intern(f.key), ty: "string" })})`);
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${o.v}, i64 ${i}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          this.emit(`call double @nt_arr_push(ptr ${pair}, i64 ${slot})`);
          this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot({ v: pair, ty: "string[]" })})`);
        });
        this.discardFree = { v: arr, call: "nt_arr_free" }; // built here out of nt_arr_new; nothing else names it
        return { v: arr, ty: "string[][]" };
      }
      // stdlib Batch 3: `Object.freeze(o)` is the identity (objects are ALREADY
      // immutable, Stage 29). `getOwnPropertyNames` == `keys` for a plain record.
      //
      // There is deliberately NO `isFrozen` case: it used to return the constant `true`,
      // which is a silent wrong answer for a never-frozen object (node: `false`). The
      // checker now refuses `isFrozen`/`isSealed`/`isExtensible` (NT1002), so nothing
      // reaches here — and the constant is gone rather than left as unreachable code,
      // because that is the shape a future edit would resurrect.
      if (e.callee.property === "freeze") return o; // the IDENTITY — never mark this fresh
      if (e.callee.property === "keys" || e.callee.property === "getOwnPropertyNames") {
        const keys = this.buildStringArray(objectFields(o.ty).map((f) => f.key));
        this.discardFree = { v: keys.v, call: "nt_arr_free" }; // a fresh nt_arr_new of interned key literals
        return keys;
      }
      // values: read each field slot into a fresh homogeneous array (checker enforced).
      const fields = objectFields(o.ty);
      const arr = this.fresh();
      this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(fields.length, 1))})`);
      fields.forEach((f, i) => {
        const gep = this.fresh();
        this.emit(`${gep} = getelementptr i64, ptr ${o.v}, i64 ${i}`);
        const slot = this.fresh();
        this.emit(`${slot} = load i64, ptr ${gep}`);
        const val: Val = { v: this.fromSlot(slot, f.ty), ty: f.ty };
        this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(val)})`);
      });
      this.discardFree = { v: arr, call: "nt_arr_free" }; // Object.values: a fresh nt_arr_new of field slots
      return { v: arr, ty: makeArrayTy(fields[0]!.ty) };
    }

    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Math") {
      return this.genMath(e.callee.property, e.args);
    }

    // --- stdlib (web standards) Batch 1: static-namespace member calls ---
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier") {
      const ns = e.callee.object.name, p = e.callee.property;
      if (ns === "Date" && p === "now" && !this.isBound("Date")) {
        const t = this.fresh();
        this.emit(`${t} = call double @nt_date_now()`);
        return { v: t, ty: "number" };
      }
      if (ns === "String" && (p === "fromCharCode" || p === "fromCodePoint") && !this.isBound("String")) {
        const fn = p === "fromCharCode" ? "nt_from_char_code" : "nt_from_code_point";
        let acc: string = this.mod.intern(""); // 0 args → ""
        for (const a of e.args) {
          const n = this.genExpr(a).v;
          const ch = this.fresh();
          this.emit(`${ch} = call ptr @${fn}(double ${n})`);
          const cat = this.fresh();
          this.emit(`${cat} = call ptr @js_str_concat(ptr ${acc}, ptr ${ch})`);
          acc = cat;
        }
        return { v: acc, ty: "string" };
      }
      if (ns === "Number" && !this.isBound("Number") && (p === "isNaN" || p === "parseInt" || p === "parseFloat")) {
        return this.genGlobal(p === "isNaN" ? "isNaN" : p, e.args)!; // the namespaced alias of the global
      }
      if (ns === "Number" && !this.isBound("Number") && (p === "isInteger" || p === "isFinite" || p === "isSafeInteger")) {
        const fn = p === "isInteger" ? "nt_num_is_integer" : p === "isFinite" ? "nt_num_is_finite" : "nt_num_is_safe_integer";
        const x = this.genExpr(e.args[0]!).v;
        const r = this.fresh();
        this.emit(`${r} = call i32 @${fn}(double ${x})`);
        const t = this.fresh();
        this.emit(`${t} = icmp ne i32 ${r}, 0`);
        return { v: t, ty: "boolean" };
      }
      if (ns === "Array" && !this.isBound("Array")) {
        if (p === "isArray") {
          const at = e.args[0]!.ty ?? "number";
          const a = this.genExpr(e.args[0]!); // evaluate for side effects
          // On a GENERAL union the static type says nothing about which arm is in the
          // box, so the fold below would answer `false` for an array — a silent wrong
          // answer. Test the TAG instead: true iff it names an array arm.
          if (isGeneralUnionTy(at)) {
            const members = generalUnionMembers(at);
            const tag = this.nullTag(a.v);
            let acc = "false";
            members.forEach((m, i) => {
              if (!isArrayTy(m)) return;
              const is = this.fresh();
              this.emit(`${is} = icmp eq i64 ${tag}, ${i}`);
              if (acc === "false") { acc = is; return; }
              const or = this.fresh();
              this.emit(`${or} = or i1 ${acc}, ${is}`);
              acc = or;
            });
            return { v: acc, ty: "boolean" };
          }
          return { v: isArrayTy(at) ? "true" : "false", ty: "boolean" };
        }
        if (p === "from") {
          const a = this.genExpr(e.args[0]!);
          const t = this.fresh();
          // Array.from(arrayLike) COPIES (node): a Map/Set iterator is already a
          // fresh array, but `Array.from(arr)` must not alias its source.
          if (isArrayTy(a.ty)) { this.emit(`${t} = call ptr @nt_arr_copy(ptr ${a.v})`); return { v: t, ty: a.ty }; }
          this.emit(`${t} = call ptr @nt_arr_from_str(ptr ${a.v})`);
          return { v: t, ty: "string[]" };
        }
        if (p === "of") { // Array.of(...items) — build the array directly
          const vals = e.args.map((x) => this.genExpr(x));
          const arr = this.fresh();
          this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(vals.length, 1))})`);
          for (const v of vals) this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(v)})`);
          return { v: arr, ty: makeArrayTy(vals[0]!.ty) };
        }
      }
    }
    // stdlib Batch 1: structuredClone(v) — the type-directed deep copy.
    if (e.callee.kind === "Identifier" && e.callee.name === "structuredClone" && !this.isBound("structuredClone")) {
      return this.genDeepClone(this.genExpr(e.args[0]!));
    }
    // class instance method call: `inst.m(args)` → `C.m(inst, …args)` (the lowered fn).
    if (e.callee.kind === "MemberExpr") {
      const recvTy = e.callee.object.ty;
      const cls = recvTy === undefined ? undefined : classTag(recvTy);
      if (cls && this.mod.functions.has(`${cls}.${e.callee.property}`)) {
        // The RECEIVER is lowered HERE rather than inside the call, because the drop
        // below needs its pointer and `genUserCall` would otherwise generate and forget
        // it. Passed on as a pre-evaluated argument 0, so it is evaluated exactly once.
        const fn = `${cls}.${e.callee.property}`;
        const recv = this.genExpr(e.callee.object);
        const out = this.genUserCall(fn, [e.callee.object, ...e.args], recv.v);
        this.freeReceiverObjTemp(e.callee.object, recv.v, cls, fn);
        return out;
      }
    }
    if (e.callee.kind === "MemberExpr") {
      const recv = this.genExpr(e.callee.object);
      // fetch: `res.text()` hands back the already-read body; `res.json()` parses it
      // into a Dyn (so `as T` narrowing composes exactly like JSON.parse's result).
      if (isResponseTy(recv.ty)) {
        const body = this.responseSlot(recv.v, 1, "string");
        if (e.callee.property === "text") return body;
        const d = this.fresh();
        this.emit(`${d} = call ptr @nt_json_parse(ptr ${body.v})`);
        this.emitExcCheck();
        return { v: d, ty: "Dyn" };
      }
      // `res.headers.get(name)` — case-insensitive in the runtime; a miss is NULL,
      // which becomes the `null` arm of the nullable box (node returns null too).
      if (isHeadersTy(recv.ty)) {
        const key = this.genExpr(e.args[0]!).v;
        const got = this.fresh();
        this.emit(`${got} = call ptr @nt_headers_get(ptr ${recv.v}, ptr ${key})`);
        const isNull = this.fresh();
        this.emit(`${isNull} = icmp eq ptr ${got}, null`);
        if (e.callee.property === "has") {
          const t = this.fresh();
          this.emit(`${t} = xor i1 ${isNull}, true`);
          return { v: t, ty: "boolean" };
        }
        const tag = this.fresh();
        this.emit(`${tag} = select i1 ${isNull}, i64 1, i64 2`); // 1 = null, 2 = present
        const slot = this.fresh();
        this.emit(`${slot} = ptrtoint ptr ${got} to i64`);
        return { v: this.nullBox(tag, slot), ty: makeNullable("null", "string") };
      }
      // --- stdlib Batch 3 ---
      // Date: the value IS the time value, so `getTime()`/`valueOf()` are the identity;
      // every component getter is one `nt_date_field(t, which, utc)` call; `toISOString`
      // is fallible (node throws RangeError on an Invalid Date).
      if (isDateTy(recv.ty)) {
        const p = e.callee.property;
        if (p === "getTime" || p === "valueOf") return { v: recv.v, ty: "number" };
        if (p === "toISOString") {
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_date_to_iso(double ${recv.v})`);
          this.emitExcCheck();
          return { v: t, ty: "string" };
        }
        // `toJSON` used to share the line above, which is what made an Invalid Date's
        // `.toJSON()` THROW. 21.4.4.37 tests the time value at step 3 and returns `null`
        // for a non-finite one, so step 4's `toISOString` invocation is never reached and
        // the method cannot throw — hence `string | null`, and hence the BRANCH: the ISO
        // call is fallible, so it may only be evaluated on the finite side.
        if (p === "toJSON") {
          const slot = this.slot("string");
          const nan = this.fresh();
          this.emit(`${nan} = fcmp uno double ${recv.v}, ${recv.v}`);
          const nLbl = this.label("tjn"), vLbl = this.label("tjv"), end = this.label("tje");
          this.terminate(`br i1 ${nan}, label %${nLbl}, label %${vLbl}`);
          this.to(this.block(vLbl));
          const iso = this.fresh();
          this.emit(`${iso} = call ptr @nt_date_to_iso(double ${recv.v})`);
          this.emit(`store ptr ${iso}, ptr ${slot}`);
          this.terminate(`br label %${end}`);
          this.to(this.block(nLbl));
          this.emit(`store ptr null, ptr ${slot}`);
          this.terminate(`br label %${end}`);
          this.to(this.block(end));
          const got = this.fresh();
          this.emit(`${got} = load ptr, ptr ${slot}`);
          const isNull = this.fresh();
          this.emit(`${isNull} = icmp eq ptr ${got}, null`);
          const tag = this.fresh();
          this.emit(`${tag} = select i1 ${isNull}, i64 1, i64 2`); // 1 = null, 2 = present
          const val = this.fresh();
          this.emit(`${val} = ptrtoint ptr ${got} to i64`);
          return { v: this.nullBox(tag, val), ty: makeNullable("null", "string") };
        }
        const g = DATE_GETTERS.get(p)!;
        const t = this.fresh();
        this.emit(`${t} = call double @nt_date_field(double ${recv.v}, double ${llvmDouble(g.which)}, double ${llvmDouble(g.utc)})`);
        return { v: t, ty: "number" };
      }
      // URLSearchParams over the raw query text: `.get` is a nullable box (node returns
      // null for a miss), `.has` a boolean, `.getAll` a string[], `.toString` the
      // normalized serialization.
      if (isSearchParamsTy(recv.ty)) return this.genSearchParamsMethod(e.callee.property, recv, e.args);
      if (isMapTy(recv.ty)) return this.genMapMethod(e.callee.property, recv, e.args);
      if (isSetTy(recv.ty)) return this.genSetMethod(e.callee.property, recv, e.args);
      // Bytes (stdlib batch 2): TextEncoder#encode -> Uint8Array; TextDecoder#decode -> string.
      if (isTextEncoderTy(recv.ty)) {
        const s = this.genExpr(e.args[0]!);
        const b = this.fresh();
        this.emit(`${b} = call ptr @nt_bytes_encode(ptr ${s.v})`);
        return { v: b, ty: "Uint8Array" };
      }
      if (isTextDecoderTy(recv.ty)) {
        const u = this.genExpr(e.args[0]!);
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_bytes_decode(ptr ${u.v})`);
        return { v: t, ty: "string" };
      }
      if (recv.ty === "number") { // stdlib Batch 1: Number#toFixed / #toString(radix)
        const t = this.fresh();
        if (e.callee.property === "toString") {
          const r = e.args[0] ? this.genExpr(e.args[0]).v : llvmDouble(10);
          this.emit(`${t} = call ptr @js_num_to_radix_string(double ${recv.v}, double ${r})`);
        } else {
          const d = e.args[0] ? this.genExpr(e.args[0]).v : "0.0";
          this.emit(`${t} = call ptr @js_num_to_fixed(double ${recv.v}, double ${d})`);
        }
        return { v: t, ty: "string" };
      }
      if (isArrayTy(recv.ty)) {
        // loc: panic-on-OOB needs the written index site (Stage 41).
        // freeReceiverTemp: an unbound temporary receiver is dropped here (B2 step 4).
        const out = this.genArrayMethod(e.callee.property, recv, e.args, e.loc);
        this.freeReceiverTemp(e.callee.object, recv, e.callee.property, out);
        return out;
      }
      return this.genStringMethod(e.callee.property, recv, e.args);
    }
    if (e.callee.kind === "Identifier") {
      if (this.mod.hostImports.has(e.callee.name)) return this.genHost(e.callee.name, e.args);
      const g = this.genGlobal(e.callee.name, e.args, e.ty);
      if (g) return g;
      // A SELF-CALL inside a lifted arrow. Checked before the capture and local paths on
      // purpose: at MODULE level the same name is also a promoted global whose slot happens
      // to hold this closure, so the fallthrough would work by luck and diverge the moment
      // the arrow is a function-local — and under shadowing it would find the OUTER binding.
      // `%__clo` is this closure, so this is a plain closure call with no load at all.
      if (this.selfArrow && e.callee.name === this.selfArrow.name) {
        return this.genCallValueFrom("%__clo", this.selfArrow.ty, e.args);
      }
      const cap = this.captures.get(e.callee.name);
      if (cap && isFuncTy(cap.ty)) return this.genCallValueFrom(this.readCapture(e.callee.name).v, cap.ty, e.args);
      // A function VALUE held in a local, a capture, or — decorators lane — a MODULE-LEVEL
      // binding promoted to a global (SH1). The last case is how a `@wrapper` decorator's
      // one-time application is stored, so a wrapped method can call it from its own frame.
      const vt = this.varTypes.get(e.callee.name) ?? this.mod.globals.get(e.callee.name);
      if (vt && isFuncTy(vt)) {
        const clo = this.fresh();
        this.emit(`${clo} = load ptr, ptr ${this.addr(e.callee.name)}`);
        return this.genCallValueFrom(clo, vt, e.args);
      }
      // An OPTIONAL callback (`f?: (x: number) => number`) the checker proved present on
      // this path. Its STORAGE is the nullable `[tag,value]` pair, so neither branch above
      // matches — `?U(number)=>number` is not `isFuncTy` — and without this it fell into
      // `genUserCall`, which looked the name up among the module's FUNCTIONS, found
      // nothing, and dereferenced `undefined`. Read it through `genExpr` rather than a
      // bare load: that is the ordinary identifier read, so `narrowRead` unwraps the pair
      // with the same `nt_nonnull` that `x!` uses — a wrong proof PANICS at the call with
      // a location instead of calling through a phantom pointer — and it works for a
      // CAPTURED optional callback too, which a load off `addr()` would not.
      const dt = vt ?? this.captures.get(e.callee.name)?.ty;
      if (dt !== undefined && isNullableTy(dt) && isFuncTy(baseTy(dt)) && (e.callee.narrowed ?? false)) {
        return this.genCallValueFrom(this.genExpr(e.callee).v, baseTy(dt), e.args);
      }
      return this.genUserCall(e.callee.name, e.args);
    }
    // arbitrary expression callee of function type, e.g. compose(f,g)(x)
    const ct = e.callee.ty;
    if (ct && isFuncTy(ct)) return this.genCallValueFrom(this.genExpr(e.callee).v, ct, e.args);
    throw internalError(`no call lowering for a callee of kind ${e.callee.kind}${e.callee.ty ? ` typed ${e.callee.ty}` : ""}`);
  }

  /**
   * Narrow a Dyn box (ptr) to a static type `target`, emitting a runtime validator
   * that throws (native TypeError) on a tag/shape mismatch and hands back a value of
   * `target`'s LLVM type. io-ts/zod semantics generated from the static type.
   */
  private genDynNarrow(dyn: string, target: Ty): Val {
    const v = this.genDynValidate(dyn, target);
    this.emitExcCheck(); // one check after the whole (possibly nested) validation
    return v;
  }

  /**
   * Recursively emit the validator for `target` against the Dyn `dyn`, producing a
   * value in `target`'s normal representation. Emits NO exception check — the
   * runtime validators are NULL-safe and raise a sticky pending flag on mismatch,
   * so genDynNarrow checks once at the end (before any use of the result).
   */
  private genDynValidate(dyn: string, target: Ty): Val {
    if (target === "number") {
      const t = this.fresh();
      this.emit(`${t} = call double @nt_dyn_as_number(ptr ${dyn})`);
      return { v: t, ty: "number" };
    }
    if (target === "boolean") {
      const t = this.fresh();
      this.emit(`${t} = call i32 @nt_dyn_as_bool(ptr ${dyn})`);
      const b = this.fresh();
      this.emit(`${b} = trunc i32 ${t} to i1`);
      return { v: b, ty: "boolean" };
    }
    if (target === "string") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_dyn_as_string(ptr ${dyn})`);
      return { v: t, ty: "string" };
    }
    if (isObjectTy(target)) {
      const fields = objectFields(target);
      this.emit(`${this.fresh()} = call i32 @nt_dyn_require_object(ptr ${dyn})`);
      const obj = this.fresh();
      this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(fields.length, 1))})`);
      fields.forEach((f, i) => {
        const fd = this.fresh();
        this.emit(`${fd} = call ptr @nt_dyn_require_field(ptr ${dyn}, ptr ${this.mod.intern(f.key)})`);
        const fv = this.genDynValidate(fd, f.ty);
        const gep = this.fresh();
        this.emit(`${gep} = getelementptr i64, ptr ${obj}, i64 ${i}`);
        this.emit(`store i64 ${this.toSlot(fv)}, ptr ${gep}`);
      });
      return { v: obj, ty: target };
    }
    if (isArrayTy(target)) {
      const el = elemTy(target);
      this.emit(`${this.fresh()} = call i32 @nt_dyn_require_array(ptr ${dyn})`);
      const len = this.fresh();
      this.emit(`${len} = call double @nt_dyn_len(ptr ${dyn})`);
      const arr = this.fresh();
      this.emit(`${arr} = call ptr @nt_arr_new(double ${len})`);
      const idx = this.slot("number");
      this.emit(`store double ${llvmDouble(0)}, ptr ${idx}`);
      const cond = this.label("dvc"), body = this.label("dvb"), end = this.label("dve");
      this.terminate(`br label %${cond}`);
      this.to(this.block(cond));
      const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
      const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${len}`);
      this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
      this.to(this.block(body));
      const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
      const ed = this.fresh(); this.emit(`${ed} = call ptr @nt_dyn_elem(ptr ${dyn}, double ${iB})`);
      const ev = this.genDynValidate(ed, el);
      this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(ev)})`);
      const iN = this.fresh(); this.emit(`${iN} = fadd double ${iB}, ${llvmDouble(1)}`);
      this.emit(`store double ${iN}, ptr ${idx}`);
      this.terminate(`br label %${cond}`);
      this.to(this.block(end));
      return { v: arr, ty: target };
    }
    throw nyi(NYI.JSON, `narrowing a dynamic value to ${target}`);
  }

  /**
   * After a fallible runtime call, branch to the innermost catch (clearing the
   * pending flag) if an exception was raised; at top level, abort (exit 1). Keeps
   * the lexical throw model — no unwinder — while making runtime throws catchable.
   *
   * `objectPayload` says the callee was PROVED to MOVE an object onto the pending slot
   * rather than raise a bare message — true only at a call to a `scanEscaping` callee
   * whose covering `catch` binds that same object type (rule 3), which is what lets this
   * choose the take-the-object arm with no runtime test. False for every HOST call, and
   * that is not a conservatism but a fact about them: `JSON.parse` and `fs` have a message
   * and no typed object to hand over.
   */
  private emitExcCheck(objectPayload = false): void {
    // Same refusal as `ThrowStmt`, for the same reason: a host failure inside a
    // `finally`-only `try` has no catch block to branch to. Raised BEFORE the check is
    // emitted, so no half-formed branch survives.
    if (this.escapesCatchlessTry()) throw this.catchlessTryError("a call that can raise");
    // …and the same discipline for a payload THIS call site cannot deliver. A MESSAGE-only
    // raise — every host call's, and `objectPayload` is exactly the flag that says this is
    // not one — can rebuild a binding of two shapes only: a `string`, and the one-field
    // `{message:string}` the message is boxed into. Under any OTHER object type this stored
    // NOTHING and branched to the handler regardless, leaving the binding at whatever its
    // uninitialised alloca held — which the handler then read as an object pointer. That is
    // a silent wrong answer with a ZERO exit code (measured: node "Thrown\nSyntaxError",
    // ours "Thrown\n\xef\xbf\xbd", both exit 0), not a crash and not a diagnostic. Refuse
    // it. Raised BEFORE anything is emitted.
    const hh = this.innermostHandler();
    if (!objectPayload && hh !== null && hh.excVar !== null && hh.eType !== "string" && hh.eType !== "{message:string}") {
      throw nyi(NYI.EXCEPTION, `a call that can raise inside a \`try\` whose \`catch (${hh.excVar})\` is ${hh.eType}, which the pending-exception flag cannot rebuild`,
        "a HOST call raises ONE string — the runtime has no typed object to hand over — so a `catch` binding it reaches can only be rebuilt as a `string` or as `{message:string}` (what `new Error(msg)` is here), and this handler binds neither. (A USER function's `throw` of this type does cross a frame: the object itself is moved.) Move the call that can raise OUT of this `try`, or give the raising code a `try` of its own whose `catch` binds one of those two shapes");
    }
    const p = this.fresh();
    this.emit(`${p} = call i32 @nt_exc_pending()`);
    const cond = this.fresh();
    this.emit(`${cond} = icmp ne i32 ${p}, 0`);
    const throwLbl = this.label("exc");
    const contLbl = this.label("cont");
    this.terminate(`br i1 ${cond}, label %${throwLbl}, label %${contLbl}`);
    this.to(this.block(throwLbl));
    // See the ThrowStmt case above: an empty handler stack must not become index -1.
    const h = this.innermostHandler();
    if (h) {
      if (h.excVar && objectPayload && isObjectTy(h.eType)) {
        // THE MOVE, RECEIVED. `nt_exc_take_object` NULLs the runtime's slot, so this store
        // makes the binding the object's single owner and the `nt_exc_clear` two lines
        // below frees nothing. Nothing is copied and nothing is rebuilt: the pointer the
        // raising frame allocated is the pointer the handler reads, so a nested field of
        // any shape — an array, another object — arrives intact, and no aliasing this
        // could not see can double-free it. The handler's drop set frees it exactly once
        // (ownership.ts's `TryStmt` case already makes an object-typed catch binding an
        // owner), and the `store ptr null` on entry to the `try` is what keeps the
        // never-stored path from freeing an uninitialised alloca.
        this.mod.usesExcObject = true;
        const o = this.fresh();
        this.emit(`${o} = call ptr @nt_exc_take_object()`);
        this.emit(`store ptr ${o}, ptr ${this.addr(h.excVar)}`);
      } else if (h.excVar && h.eType === "string") {
        const m = this.fresh();
        this.emit(`${m} = call ptr @nt_exc_message()`);
        // The binding is a STRING LOCAL, released at scope exit — so it needs its own
        // reference. The pending message is an owner (see nt_exc_raise in runtime.c) and
        // `nt_exc_clear` below drops the runtime's; without this retain, a message the
        // raising frame heap-allocated would be freed while the handler still reads it.
        // A literal is untracked, so the retain is a no-op and no existing IR behaves
        // differently.
        this.emit(`${this.fresh()} = call ptr @nt_str_retain(ptr ${m})`);
        this.emit(`store ptr ${m}, ptr ${this.addr(h.excVar)}`);
      } else if (h.excVar && h.eType === "{message:string}") {
        // SH4: the block calls a host builtin, so its failure is an Error — box the
        // runtime message into `new Error(msg)`'s shape so `e.message` reads it.
        const m = this.fresh();
        this.emit(`${m} = call ptr @nt_exc_message()`);
        // The slot outlives `nt_exc_clear` below, which drops the runtime's reference.
        this.emit(`${this.fresh()} = call ptr @nt_str_retain(ptr ${m})`);
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(1)})`);
        const g = this.fresh();
        this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 0`);
        this.emit(`store i64 ${this.toSlot({ v: m, ty: "string" })}, ptr ${g}`);
        this.emit(`store ptr ${obj}, ptr ${this.addr(h.excVar)}`);
      }
      this.emit(`call void @nt_exc_clear()`);
      this.terminate(`br label %${h.catchLbl}`);
    } else {
      this.emit(`call void @nt_exc_abort()`);
      this.terminate(`unreachable`);
    }
    this.to(this.block(contLbl));
  }

  /**
   * Can a `throw` in THIS frame, with no `try` around it here, still reach a handler?
   *
   * Two cases where it provably cannot, and both are exact rather than heuristic:
   * `main` IS module top-level, which no user frame calls, so it has no ancestor to
   * unwind to; and a program containing no `try` at all has no handler to reach after
   * any number of frames. Every other shape may or may not be caught by a caller —
   * that is the cross-frame propagation NT1004 still refuses.
   */
  private uncatchable(): boolean {
    return this.inMain || !this.mod.hasTry;
  }

  /**
   * Would an exception raised HERE have to leave a `try` that has a `finally` and no
   * `catch`? Such a `try` catches nothing (node runs the finalizer and keeps
   * propagating), so the only correct lowering runs the finalizer on the exceptional
   * path — which the lexical branch-to-catch throw model cannot express. Refuse.
   *
   * Only the INNERMOST scope is consulted, and that is exact: if the innermost `try`
   * has a `catch`, the exception never reaches an outer `finally` in this frame.
   */
  private escapesCatchlessTry(): boolean {
    const n = this.tryHandlers.length;
    return n > 0 && this.tryHandlers[n - 1]!.catchless;
  }

  /** The NT1004 refusal for the case above — RETURNED, not thrown, so the signature stays
   *  inside the self-hosting subset (`never` in return position is NT2003 here). `what`
   *  names the raising construct. */
  private catchlessTryError(what: string): NTError {
    return nyi(NYI.EXCEPTION, `${what} inside a \`try\` that has a \`finally\` and no \`catch\``,
      "a `finally` does not CATCH — node runs it and keeps propagating, and a `throw` is lowered as a branch to the enclosing `catch` block, which a `finally`-only `try` does not have. Give the `try` a `catch` clause, or move the raising code out of the `try`");
  }

  /**
   * Lower an UNCAUGHT `throw`: raise the message on the pending-exception flag and
   * abort — `nt_exc_abort` is one line to stderr plus `exit(1)`, which matches node's
   * stdout (everything already printed, flushed by `exit`) and its exit code. Only the
   * stderr TEXT differs (node prints a stack trace); see docs/divergences.md.
   *
   * Returns false for a thrown value with no message string — `throw 42`, `throw {a:1}`
   * — so the caller keeps the NT1004 refusal rather than inventing text for it.
   */
  /**
   * Lower a `throw` that LEAVES this frame: raise the message on the pending-exception
   * flag, then leave by an ordinary `ret`. The caller checks the flag immediately after
   * the call (`emitExcCheck` in `genUserCall`) and branches to its own `catch`, so the
   * returned default is never read — and `scanEscaping` has already proved that every
   * call site is one that checks.
   *
   * THE DROP SET IS THE WHOLE COST, and it is `ReturnStmt`'s: leaving by a `ret` means
   * freeing exactly what a `return` written at this point would free. `ThrowStmt.drops`
   * is the ownership pass's `ownedInScope` at the throw, MINUS the thrown value, which the
   * raise has moved — the same annotation and the same one-line computation
   * `ReturnStmt.drops` already uses, no second analysis, and no "the unwinder leaks by
   * construction" that a `longjmp` past these frames would have.
   *
   * The message is RETAINED by `nt_exc_raise_msg` before the drops run, so a message
   * string this frame owns (`throw `bad: ${x}`;`) survives its own release. A literal is
   * untracked and the retain is a no-op, which is why nothing else's behaviour moves.
   *
   * Returns false for a thrown value the slot cannot carry — the caller then keeps the
   * NT1004 refusal rather than inventing a payload, exactly as `genUncaught` does.
   */
  private genPropagate(s: ThrowStmt): boolean {
    const v = this.genExpr(s.argument);
    if (isObjectTy(v.ty)) return this.genPropagateObject(s, v);
    const msg = this.raisedMessage(v);
    if (msg === "") return false;
    this.mod.usesUncaughtThrow = true;
    this.emit(`call void @nt_exc_raise_msg(ptr ${msg})`);
    // THE RAISE CONSUMES A PRODUCER. `nt_exc_raise_msg` retains unconditionally, which is
    // right for a thrown NAMED local (this frame's `emitStrDrops` release is still coming)
    // and for a borrow, but a fresh template/concat/call result already carries rc=1 and
    // no named local holds it — `emitStrDrops` walks locals only — so nobody ever released
    // that reference and one heap string leaked per cross-frame throw. Releasing here
    // hands the raise the producer's own count instead of adding a second: the pending
    // slot is left holding exactly one, which `nt_exc_clear` drops. Same `isStrProducer`
    // question the in-frame path above and `retainStrBind` ask, so the two agree.
    if (v.ty === "string" && this.isStrProducer(s.argument)) {
      this.emit(`call void @nt_str_release(ptr ${msg})`);
    }
    // `nt_obj_free` is SHALLOW, so freeing a thrown `new Error(m)` here does not touch
    // the message the raise just retained.
    this.emitDrops(s.drops ?? []);
    this.emitStrDrops();
    this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
    return true;
  }

  /**
   * The OBJECT half of `genPropagate` — the move. `nt_exc_raise_obj` takes the object block
   * pointer, and from that call until a `catch` runs `nt_exc_take_object` the runtime slot
   * is its ONE owner: `ThrowStmt.drops` has already had the thrown name subtracted from it
   * (ownership.ts), so the drop set below cannot free it, and no copy exists to go stale.
   * That is the property flattening could not have: a `diag: {code, spans?: DiagSpan[]}`
   * nested three deep arrives byte-identical because it is never walked.
   *
   * The message is passed ALONGSIDE, borrowed out of the object's own `message` slot, and
   * only so an UNCAUGHT raise can name itself on stderr (`nt_exc_abort`). It is `null` for
   * an object that carries no `message: string`, which is a payload the old rule refused
   * outright — the object no longer has to have one, because nothing is rebuilt from it.
   *
   * Always true: unlike the message path there is no shape that can fail here, and
   * `scanEscaping` has already established (rule 3) that every covering `catch` binds
   * exactly this object type.
   */
  private genPropagateObject(s: ThrowStmt, v: Val): boolean {
    this.mod.usesExcObject = true;
    const msg = this.raisedMessage(v); // "" — and so `null` — when there is no message field
    this.emit(`call void @nt_exc_raise_obj(ptr ${v.v}, ptr ${msg === "" ? "null" : msg})`);
    this.emitDrops(s.drops ?? []);
    this.emitStrDrops();
    this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
    return true;
  }

  /**
   * The message string a thrown value raises with, or `""` for a value that carries none
   * (`throw 42`, `throw {a:1}`) — the caller then keeps the NT1004 refusal rather than
   * inventing text for it. `""` is unambiguous as the "no message" answer: every message
   * this returns is an SSA name or a global symbol, never the empty spelling.
   *
   * Factored out of `genUncaught` (where `genPropagate` had copied it) because the
   * comparison it is built on, `fieldType(t, "message") === "string"`, is one this
   * compiler REFUSES when it checks itself — `fieldType` answers `Ty | undefined` and a
   * nullable may not be compared with a string. Guarding the `undefined` and rebinding
   * before the comparison is the spelling that passes, and doing it once means one
   * function inside the subset instead of two outside it.
   */
  private raisedMessage(v: Val): string {
    const t: Ty = v.ty;
    if (t === "string") return v.v;
    if (!isObjectTy(t)) return "";
    const f = fieldType(t, "message");
    if (f === undefined) return "";
    const ft: Ty = f;
    if (ft !== "string") return "";
    const g = this.fresh();
    this.emit(`${g} = getelementptr i64, ptr ${v.v}, i64 ${fieldIndex(t, "message")}`);
    const raw = this.fresh();
    this.emit(`${raw} = load i64, ptr ${g}`);
    return this.fromSlot(raw, "string");
  }

  private genUncaught(argument: Expr): boolean {
    const v = this.genExpr(argument);
    const msg = this.raisedMessage(v);
    if (msg === "") return false;
    this.mod.usesUncaughtThrow = true;
    this.emit(`call void @nt_exc_raise_msg(ptr ${msg})`);
    this.emit(`call void @nt_exc_abort()`);
    this.terminate("unreachable");
    return true;
  }

  /** Call a function VALUE (closure ptr already computed): indirect call through slot 0. */
  private genCallValueFrom(clo: string, fnTy: Ty, args: Expr[]): Val {
    // Each argument is COERCED to the parameter type, exactly as the direct-call path
    // (`genUserCall`) does — this one merely RELABELLED the raw value with the parameter's
    // type, so a `string` passed to a `(s: string | undefined) => …` closure arrived as a
    // bare string pointer where the callee loads a [tag,value] box. A no-op when the types
    // already match, so ordinary closure calls emit exactly the IR they always did.
    return this.callClosure(clo, fnTy, (ps) => args.map((a, i) => this.coerce(this.genExpr(a), ps[i]!)));
  }

  /** Call a closure value with ALREADY-generated argument values — B3 v4's
   *  selective-receive scan calls the user predicate with a value peeked out of the
   *  mailbox, which has no Expr form. */
  private callClosureWith(clo: string, fnTy: Ty, argVs: Val[]): Val {
    // `_ps` is named but unused — the values are already generated, so there is nothing
    // left to coerce. Spelling the parameter rather than passing `() => argVs` keeps this
    // inside the subset `src/` must compile: a 0-parameter arrow where a 1-parameter one
    // is expected is an arity mismatch the checker refuses (it was a self-host blocker).
    return this.callClosure(clo, fnTy, (_ps) => argVs);
  }

  /** Shared closure-call emission. Arguments are produced by `mk` at exactly the
   *  point the Expr-taking path always produced them (after the fn-ptr load), so the
   *  emitted IR for ordinary calls is unchanged. */
  private callClosure(clo: string, fnTy: Ty, mk: (ps: Ty[]) => Val[]): Val {
    this.emitSafepoint(); // call site: preempt long / deeply-recursive call chains
    const fpSlot = this.fresh();
    this.emit(`${fpSlot} = getelementptr i64, ptr ${clo}, i64 0`);
    const fpInt = this.fresh();
    this.emit(`${fpInt} = load i64, ptr ${fpSlot}`);
    const fp = this.fresh();
    this.emit(`${fp} = inttoptr i64 ${fpInt} to ptr`);
    const ps = funcParams(fnTy);
    const ret = funcRet(fnTy);
    const argVals = mk(ps).map((a, i) => `${llvmTy(ps[i] ?? a.ty)} ${a.v}`);
    const argStr = [`ptr ${clo}`, ...argVals].join(", ");
    if (ret === "void") { this.emit(`call void ${fp}(${argStr})`); return { v: "", ty: "void" }; }
    const t = this.fresh();
    this.emit(`${t} = call ${llvmTy(ret)} ${fp}(${argStr})`);
    return { v: t, ty: ret };
  }

  /**
   * `console.log` / `error` / `warn` / `info` / `debug`.
   *
   * Stage 49: node reads FORMAT SPECIFIERS from a leading string argument when
   * further arguments follow (`formatWithOptionsInternal`). Our arguments are
   * statically typed and the format string is almost always a literal, so the
   * whole scan happens at COMPILE time (`planConsoleFormat`) and each specifier
   * lowers to the conversion its argument's type calls for — no runtime format
   * interpreter, no per-call cost. A NON-literal format string keeps the plain
   * space-separated path plus a runtime guard that refuses (loudly) if the string
   * turns out to contain a specifier; a literal that consumes nothing (node's
   * `console.log("100%% done")`, one argument) is the plain path too.
   *
   * Every argument is evaluated FIRST, left to right — node evaluates the whole
   * argument list before formatting, and `%c` discards its argument but must not
   * skip its side effects.
   */
  private genConsoleLog(args: Expr[], stream: "out" | "err" = "out"): Val {
    const err = stream === "err";
    const P = err ? "js_eprint" : "js_print";
    if (err) this.emit(`call void @js_eprint_begin()`);
    const plan = planConsoleFormat(args);
    const vals = args.map((a) => this.genExpr(a));
    if (plan === null) {
      // A runtime string in the format position is the one case the compile-time scan
      // cannot decide; the guard turns "maybe wrong output" into a refusal.
      const fmt = args.length > 1 ? this.genFormatStringOrNull(vals[0]!) : null;
      if (fmt !== null) this.emit(`call void @nt_fmt_guard(ptr ${fmt}, double ${llvmDouble(args.length - 1)})`);
      vals.forEach((val, i) => {
        if (i > 0) this.emit(`call void @${P}_sep()`);
        this.emitPrint(val, stream);
      });
    } else {
      for (const piece of plan.pieces) {
        if (piece.kind === "text") { this.emit(`call void @${P}_str(ptr ${this.mod.intern(piece.text)})`); continue; }
        const s = this.genFormatArg(vals[piece.arg]!, piece.spec);
        if (s !== null) this.emit(`call void @${P}_str(ptr ${s.v})`);
      }
      // Anything the format string did not consume is appended space-separated —
      // with a LEADING space, because node sets its join separator once it formats.
      for (let i = plan.restStart; i < vals.length; i++) {
        this.emit(`call void @${P}_sep()`);
        this.emitPrint(vals[i]!, stream);
      }
    }
    this.emit(`call void @${P}_newline()`);
    return { v: "0", ty: "void" };
  }

  /**
   * The leading argument AS A FORMAT STRING, or null if it can never be one.
   * node only scans specifiers when `typeof args[0] === 'string'` — which for a
   * nullable or a `Dyn` is a RUNTIME fact, so those two produce a pointer that is
   * null exactly when node would not have scanned (`nt_fmt_guard` ignores null).
   */
  private genFormatStringOrNull(val: Val): string | null {
    if (val.ty === "string") return val.v;
    if (isNullableTy(val.ty) && baseTy(val.ty) === "string") {
      const tag = this.nullTag(val.v);
      const present = this.fresh(); this.emit(`${present} = icmp eq i64 ${tag}, 2`);
      const inner = this.fromSlot(this.nullVal(val.v), "string");
      const t = this.fresh(); this.emit(`${t} = select i1 ${present}, ptr ${inner}, ptr null`);
      return t;
    }
    if (val.ty === "Dyn") {
      const t = this.fresh(); this.emit(`${t} = call ptr @nt_dyn_str_or_null(ptr ${val.v})`);
      return t;
    }
    return null;
  }

  /** Print one value per its static type (used by console.log, incl. nullable unbox). */
  private emitPrint(val: Val, stream: "out" | "err" = "out"): void {
    const P = stream === "err" ? "js_eprint" : "js_print";
    if (val.ty === "number") { this.emit(`call void @${P}_num(double ${val.v})`); return; }
    if (val.ty === "boolean") {
      const z = this.fresh();
      this.emit(`${z} = zext i1 ${val.v} to i32`);
      this.emit(`call void @${P}_bool(i32 ${z})`);
      return;
    }
    if (val.ty === "undefined" || val.ty === "void") { this.emit(`call void @${P}_str(ptr ${this.mod.intern("undefined")})`); return; }
    if (val.ty === "null") { this.emit(`call void @${P}_str(ptr ${this.mod.intern("null")})`); return; }
    if (val.ty === "Dyn") {
      if (stream === "out") { this.emit(`call void @nt_dyn_print(ptr ${val.v})`); return; }
      const s = this.fresh();
      this.emit(`${s} = call ptr @nt_dyn_display(ptr ${val.v}, double 0x0000000000000000)`);
      this.emit(`call void @${P}_str(ptr ${s})`);
      return;
    }
    // stdlib Batch 3: node's util.inspect of a Date is its ISO string ("Invalid Date"
    // when the time value is NaN) — the one non-throwing renderer, so no exc check.
    if (isDateTy(val.ty)) {
      const s = this.fresh();
      this.emit(`${s} = call ptr @nt_date_inspect(double ${val.v})`);
      this.emit(`call void @${P}_str(ptr ${s})`);
      return;
    }
    if (isNullableTy(val.ty)) { this.emitPrintNullable(val.v, baseTy(val.ty), stream); return; }
    if (isGeneralUnionTy(val.ty)) { this.emitPrintGeneralUnion(val.v, val.ty, stream); return; }
    // A COMPOUND value (object / class instance / array / Map / Set) is rendered by
    // node's util.inspect. Before Stage 47 this fell through to `js_print_str` on the
    // heap POINTER — a silent wrong answer (usually a bare newline).
    // A recursive node is a compound too. Left out, it reached the `js_print_str` tail below
    // and printed the raw heap pointer as a C string — exactly the "usually a bare newline"
    // silent wrong answer the comment above records Stage 47 fixing for objects, reproduced
    // by a new encoding the arm did not name.
    if (isObjectTy(val.ty) || isArrayTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) || isBytesTy(val.ty) || isTypeRefTy(val.ty)) {
      this.emit(`call void @${P}_str(ptr ${this.genInspect(val, 0, 0).v})`);
      return;
    }
    this.emit(`call void @${P}_str(ptr ${val.v})`); // a top-level string prints BARE
  }

  /**
   * One format specifier applied to one argument, as a string Val (null = print
   * nothing, which is `%c`). Every conversion is node's, per `%`:
   *
   *   `%s` String(), except a compound inspects at `depth: 0` (nested → `[Object]`)
   *        and a number keeps util.inspect's `-0`;
   *   `%O` inspect at the default depth — i.e. exactly what printing it alone gives,
   *        except that a top-level string is QUOTED;  `%o` is the same for a scalar
   *        (its `showHidden` only shows on a compound, which the checker refuses);
   *   `%j` JSON.stringify — with node's literal `undefined` for a value it drops;
   *   `%d` formatNumber(ToNumber(x));  `%i` parseInt(String(x));  `%f` parseFloat(String(x)).
   */
  private genFormatArg(val: Val, spec: FmtSpec): Val | null {
    const ty = val.ty;
    const lit = (s: string): Val => ({ v: this.mod.intern(s), ty: "string" });
    if (spec === "c") return null; // consumed and ignored (node's CSS specifier)
    if (isNullableTy(ty)) return this.genFormatNullable(val.v, baseTy(ty), spec);
    if (spec === "O" || spec === "o") {
      if (ty === "Dyn") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_dyn_inspect(ptr ${val.v}, double 0x0000000000000000)`); return { v: t, ty: "string" }; }
      return this.genInspect(val, 0, 0);
    }
    if (spec === "j") {
      // JSON.stringify(undefined) is the VALUE undefined, which node concatenates as
      // the literal "undefined" — not the string "null" the walk would give.
      if (ty === "undefined" || ty === "void") return lit("undefined");
      return this.genJsonStringify(val);
    }
    if (spec === "s") {
      if (ty === "string") return val; // bare, like String()
      if (ty === "Dyn") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_dyn_display(ptr ${val.v}, double ${llvmDouble(INSPECT_DEPTH)})`); return { v: t, ty: "string" }; }
      // A compound goes through inspect with `depth: 0`, so starting the walk AT the
      // cut-off depth is what makes its fields' compounds render as `[Object]`.
      if (isObjectTy(ty) || isArrayTy(ty) || isMapTy(ty) || isSetTy(ty)) return this.genInspect(val, INSPECT_DEPTH, 0);
      return this.genInspect(val, 0, 0); // number (-0), boolean, undefined, null, Date
    }
    // %d / %i / %f — all three render a double through util.inspect's formatNumber.
    const num = this.genFormatNumber(val, spec);
    const t = this.fresh();
    this.emit(`${t} = call ptr @nt_insp_num(double ${num})`);
    return { v: t, ty: "string" };
  }

  /** The `double` a `%d`/`%i`/`%f` conversion produces for this value. */
  private genFormatNumber(val: Val, spec: "d" | "i" | "f"): string {
    const ty = val.ty;
    // `%d` is ToNumber: a boolean is 1/0, `null` is 0, `undefined` is NaN, and a Date
    // is its time value (nativets represents a Date AS that double).
    if (spec === "d") {
      if (ty === "number" || isDateTy(ty)) return val.v;
      if (ty === "null") return "0.0";
      if (ty === "boolean") { const t = this.fresh(); this.emit(`${t} = uitofp i1 ${val.v} to double`); return t; }
      if (ty === "string") { const t = this.fresh(); this.emit(`${t} = call double @js_str_to_num(ptr ${val.v})`); return t; }
      return llvmDouble(NaN); // undefined, and an object/Map/Set ("[object Object]")
    }
    // `%i`/`%f` are parseInt/parseFloat of String(x) — so a boolean ("true") is NaN
    // where `%d` gives 1, and a Date is NaN because its String() starts with a weekday.
    if (ty === "number" || ty === "string" || ty === "boolean" || ty === "undefined" || ty === "void" || ty === "null") {
      const s = this.coerceToString(ty === "void" ? { v: val.v, ty: "undefined" } : val);
      const t = this.fresh();
      this.emit(spec === "i" ? `${t} = call double @js_parse_int(ptr ${s}, double 0x0000000000000000)` : `${t} = call double @js_parse_float(ptr ${s})`);
      return t;
    }
    return llvmDouble(NaN);
  }

  /** A nullable box under a specifier: the tag decides, then the base type converts. */
  private genFormatNullable(ptr: string, base: Ty, spec: FmtSpec): Val | null {
    if (spec === "c") return null;
    const out = this.slot("string");
    const tag = this.nullTag(ptr);
    const isU = this.fresh(); this.emit(`${isU} = icmp eq i64 ${tag}, 0`);
    const uLbl = this.label("fu"), nChk = this.label("fnc"), nLbl = this.label("fn"), pLbl = this.label("fp"), end = this.label("fe");
    this.terminate(`br i1 ${isU}, label %${uLbl}, label %${nChk}`);
    this.to(this.block(uLbl));
    this.emit(`store ptr ${this.genFormatArg({ v: "0", ty: "undefined" }, spec)!.v}, ptr ${out}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(nChk));
    const isN = this.fresh(); this.emit(`${isN} = icmp eq i64 ${tag}, 1`);
    this.terminate(`br i1 ${isN}, label %${nLbl}, label %${pLbl}`);
    this.to(this.block(nLbl));
    this.emit(`store ptr ${this.genFormatArg({ v: "0", ty: "null" }, spec)!.v}, ptr ${out}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(pLbl));
    const inner = this.genFormatArg({ v: this.fromSlot(this.nullVal(ptr), base), ty: base }, spec)!;
    this.emit(`store ptr ${inner.v}, ptr ${out}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh(); this.emit(`${t} = load ptr, ptr ${out}`);
    return { v: t, ty: "string" };
  }

  /**
   * node's `util.inspect` of a value, generated from its STATIC type — the
   * `JSON.stringify` walk's shape, with node's rendering rules. Returns a string Val.
   *
   * `depth` is node's `recurseTimes` (a compound below `depth 2` renders as
   * `[Object]`/`[Array]`); `indent` is node's `ctx.indentationLvl` (+2 per level),
   * which the runtime builder needs for the width test and the wrapped layout.
   * Nested strings are QUOTED, a top-level one is not — hence the split between
   * this walk and `emitPrint`.
   */
  private genInspect(val: Val, depth: number, indent: number): Val {
    const ty = val.ty;
    const lit = (s: string): Val => ({ v: this.mod.intern(s), ty: "string" });
    if (ty === "number") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_num(double ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "boolean") {
      const z = this.fresh(); this.emit(`${z} = zext i1 ${val.v} to i32`);
      const t = this.fresh(); this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
      return { v: t, ty: "string" };
    }
    if (ty === "string") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_str(ptr ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "undefined" || ty === "void") return lit("undefined");
    if (ty === "null") return lit("null");
    if (isDateTy(ty)) { const t = this.fresh(); this.emit(`${t} = call ptr @nt_date_inspect(double ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "Dyn") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_dyn_inspect(ptr ${val.v}, double ${llvmDouble(indent)})`); return { v: t, ty: "string" }; }
    if (isNullableTy(ty)) return this.genInspectNullable(val.v, baseTy(ty), depth, indent);
    // A recursive node renders as the object it names. Safe against a cycle for the same
    // reason nesting is: `genInspectObject` cuts at INSPECT_DEPTH, which is node's own
    // depth-2 `[Object]` rule, so the unfolding is bounded by the printer, not by the type.
    if (isTypeRefTy(ty)) {
      // `expandTypeRef` returns an UNKNOWN name unchanged — the deliberate "cannot decide,
      // do not guess" rule — and this line re-enters itself with it. JSC makes that tail
      // call a loop, so a dangling `@N` HUNG the compiler with no diagnostic and no exit
      // (see src/modules.ts `rewriteRefs`, which is where one used to come from). A `@N`
      // the table cannot resolve must fail LOUDLY, which is what property 2 of the
      // encoding promises (ast.ts).
      const shape = this.unfold(ty);
      if (isTypeRefTy(shape)) throw internalError(`no shape for the recursive type ${ty} — its back-edge resolves to nothing in the merged program`);
      return this.genInspect({ v: val.v, ty: shape }, depth, indent);
    }
    if (isObjectTy(ty)) return this.genInspectObject(val, depth, indent);
    if (isBytesTy(ty)) return this.genInspectBytes(val, depth, indent);
    if (isArrayTy(ty)) return this.genInspectArray(val, depth, indent);
    if (isMapTy(ty) || isSetTy(ty)) return this.genInspectColl(val, depth, indent);
    return lit("undefined"); // unreachable: the checker rejects every other arg type
  }

  /** A nullable box is INVISIBLE to inspect: render the tag's value at the same depth. */
  private genInspectNullable(ptr: string, base: Ty, depth: number, indent: number): Val {
    const out = this.slot("string");
    const tag = this.nullTag(ptr);
    const isU = this.fresh(); this.emit(`${isU} = icmp eq i64 ${tag}, 0`);
    const uLbl = this.label("iu"), nChk = this.label("inc"), nLbl = this.label("in"), pLbl = this.label("ip"), end = this.label("ie");
    this.terminate(`br i1 ${isU}, label %${uLbl}, label %${nChk}`);
    this.to(this.block(uLbl)); this.emit(`store ptr ${this.mod.intern("undefined")}, ptr ${out}`); this.terminate(`br label %${end}`);
    this.to(this.block(nChk));
    const isN = this.fresh(); this.emit(`${isN} = icmp eq i64 ${tag}, 1`);
    this.terminate(`br i1 ${isN}, label %${nLbl}, label %${pLbl}`);
    this.to(this.block(nLbl)); this.emit(`store ptr ${this.mod.intern("null")}, ptr ${out}`); this.terminate(`br label %${end}`);
    this.to(this.block(pLbl));
    const inner = this.genInspect({ v: this.fromSlot(this.nullVal(ptr), base), ty: base }, depth, indent);
    this.emit(`store ptr ${inner.v}, ptr ${out}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh(); this.emit(`${t} = load ptr, ptr ${out}`);
    return { v: t, ty: "string" };
  }

  /**
   * `{ a: 1, b: 'x' }` / `Point { x: 1 }`. node folds a class name into the OPENING
   * BRACE (`braces[0]`), and measures it there, so `open` carries it. Both the empty
   * form and the depth cut-off are compile-time decisions here (fields are static),
   * and node checks EMPTY FIRST — `{}` prints at any depth, `[Object]` only when it
   * has fields.
   */
  private genInspectObject(val: Val, depth: number, indent: number): Val {
    const fields = objectFields(val.ty);
    // A `@@mutable` RECORD carries a tag for the same reason a class instance does, but
    // node has no name to print for it — there is no constructor. So the tag is folded into
    // the brace only for a CLASS. Getting this wrong is a silent wrong answer at exit 0
    // (`Cell { n: 1 }` where node prints `{ n: 1 }`), and it scales with every record
    // declared. The class side is unchanged: node really does print `Counter { pos: 0 }`.
    const rawTag = classTag(val.ty);
    const tag = rawTag !== undefined && this.mod.recordTags.has(rawTag) ? undefined : rawTag;
    const open = `${tag ? `${tag} ` : ""}{`;
    if (fields.length === 0) return { v: this.mod.intern(`${open}}`), ty: "string" };
    if (depth > INSPECT_DEPTH) return { v: this.mod.intern(`[${tag ?? "Object"}]`), ty: "string" };
    const b = this.fresh();
    this.emit(`${b} = call ptr @nt_insp_new(ptr ${this.mod.intern(open)}, ptr ${this.mod.intern("}")}, double ${llvmDouble(indent)}, double 0x0000000000000000, double 0x0000000000000000)`);
    fields.forEach((f) => {
      const gep = this.fresh();
      this.emit(`${gep} = getelementptr i64, ptr ${val.v}, i64 ${fieldIndex(val.ty, f.key)}`);
      const slot = this.fresh();
      this.emit(`${slot} = load i64, ptr ${gep}`);
      const s = this.genInspect({ v: this.fromSlot(slot, f.ty), ty: f.ty }, depth + 1, indent + 2);
      const e = this.fresh();
      this.emit(`${e} = call ptr @nt_insp_entry(ptr ${this.mod.intern(f.key)}, ptr ${s.v})`);
      this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${e})`);
    });
    const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_done(ptr ${b})`);
    return { v: t, ty: "string" };
  }

  /**
   * `[ 1, 2, 3 ]`, or node's column-grouped layout past six entries. The length is a
   * runtime value, so the empty (`[]`) and depth-cut (`[Array]`) cases are a runtime
   * select; entries past `maxArrayLength` (100) become `... n more items`.
   */
  private genInspectArray(val: Val, depth: number, indent: number): Val {
    const el = elemTy(val.ty);
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${val.v})`);
    const isEmpty = this.fresh(); this.emit(`${isEmpty} = fcmp oeq double ${len}, 0.0`);
    if (depth > INSPECT_DEPTH) {
      const t = this.fresh();
      this.emit(`${t} = select i1 ${isEmpty}, ptr ${this.mod.intern("[]")}, ptr ${this.mod.intern("[Array]")}`);
      return { v: t, ty: "string" };
    }
    // node's `order`: padStart only when EVERY element is a number.
    const numericPad = el === "number" ? 1 : 0;
    const b = this.fresh();
    this.emit(`${b} = call ptr @nt_insp_new(ptr ${this.mod.intern("[")}, ptr ${this.mod.intern("]")}, double ${llvmDouble(indent)}, double ${llvmDouble(1)}, double ${llvmDouble(numericPad)})`);
    const over = this.fresh(); this.emit(`${over} = fcmp ogt double ${len}, ${llvmDouble(INSPECT_MAXARR)}`);
    const capped = this.fresh();
    this.emit(`${capped} = select i1 ${over}, double ${llvmDouble(INSPECT_MAXARR)}, double ${len}`);
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const cond = this.label("ia"), body = this.label("iab"), upd = this.label("iau"), end = this.label("iae");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${capped}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
    const slot = this.fresh(); this.emit(`${slot} = call i64 @nt_arr_get(ptr ${val.v}, double ${iB})`);
    const es = this.genInspect({ v: this.fromSlot(slot, el), ty: el }, depth + 1, indent + 2);
    this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${es.v})`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    const rem = this.fresh(); this.emit(`${rem} = fsub double ${len}, ${capped}`);
    const more = this.fresh(); this.emit(`${more} = fcmp ogt double ${rem}, 0.0`);
    const mLbl = this.label("iam"), mEnd = this.label("iaz");
    this.terminate(`br i1 ${more}, label %${mLbl}, label %${mEnd}`);
    this.to(this.block(mLbl));
    const ms = this.fresh(); this.emit(`${ms} = call ptr @nt_insp_more(double ${rem})`);
    this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${ms})`);
    this.terminate(`br label %${mEnd}`);
    this.to(this.block(mEnd));
    const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_done(ptr ${b})`);
    return { v: t, ty: "string" };
  }

  /**
   * `Uint8Array(3) [ 1, 2, 3 ]` (Stage 49, closing NT1016). node's `formatTypedArray`
   * is `formatArrayBuffer`'s layout with the LENGTH folded into the opening brace —
   * the same shape as a Map/Set, measured as part of `braces[0]` — so this is
   * `genInspectArray` with a runtime-built brace: column grouping past six entries,
   * right-aligned (every element is a number), `... n more items` past 100, and the
   * depth cut to `[Uint8Array]`.
   */
  private genInspectBytes(val: Val, depth: number, indent: number): Val {
    const len = this.fresh(); this.emit(`${len} = call double @nt_bytes_len(ptr ${val.v})`);
    const open = this.fresh();
    this.emit(`${open} = call ptr @nt_insp_len_open(ptr ${this.mod.intern("Uint8Array")}, double ${len})`);
    const isEmpty = this.fresh(); this.emit(`${isEmpty} = fcmp oeq double ${len}, 0.0`);
    if (depth > INSPECT_DEPTH) {
      // As everywhere in node's renderer, EMPTY is checked before the depth cut.
      const empty = this.concat(open, this.mod.intern("]"));
      const t = this.fresh();
      this.emit(`${t} = select i1 ${isEmpty}, ptr ${empty}, ptr ${this.mod.intern("[Uint8Array]")}`);
      return { v: t, ty: "string" };
    }
    const b = this.fresh();
    this.emit(`${b} = call ptr @nt_insp_new(ptr ${open}, ptr ${this.mod.intern("]")}, double ${llvmDouble(indent)}, double ${llvmDouble(1)}, double ${llvmDouble(1)})`);
    const over = this.fresh(); this.emit(`${over} = fcmp ogt double ${len}, ${llvmDouble(INSPECT_MAXARR)}`);
    const capped = this.fresh();
    this.emit(`${capped} = select i1 ${over}, double ${llvmDouble(INSPECT_MAXARR)}, double ${len}`);
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const cond = this.label("ib"), body = this.label("ibb"), upd = this.label("ibu"), end = this.label("ibe");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${capped}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
    const by = this.fresh(); this.emit(`${by} = call double @nt_bytes_get(ptr ${val.v}, double ${iB})`);
    const es = this.fresh(); this.emit(`${es} = call ptr @nt_insp_num(double ${by})`);
    this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${es})`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    const rem = this.fresh(); this.emit(`${rem} = fsub double ${len}, ${capped}`);
    const more = this.fresh(); this.emit(`${more} = fcmp ogt double ${rem}, 0.0`);
    const mLbl = this.label("ibm"), mEnd = this.label("ibz");
    this.terminate(`br i1 ${more}, label %${mLbl}, label %${mEnd}`);
    this.to(this.block(mLbl));
    const ms = this.fresh(); this.emit(`${ms} = call ptr @nt_insp_more(double ${rem})`);
    this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${ms})`);
    this.terminate(`br label %${mEnd}`);
    this.to(this.block(mEnd));
    const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_done(ptr ${b})`);
    return { v: t, ty: "string" };
  }

  /**
   * `Map(1) { 'a' => 1 }` / `Set(2) { 1, 2 }`. The size is in node's opening brace and
   * is a runtime value, so the brace is built at runtime too. Iteration reuses the
   * Stage-37 insertion-order key log (`nt_coll_keys`), so the order matches node.
   */
  private genInspectColl(val: Val, depth: number, indent: number): Val {
    const isMap = isMapTy(val.ty);
    const kt = isMap ? mapKeyTy(val.ty) : setElemTy(val.ty);
    const vt = isMap ? mapValTy(val.ty) : ("number" as Ty);
    const size = this.fresh(); this.emit(`${size} = call i64 @nt_coll_size(ptr ${val.v})`);
    const sizeD = this.fresh(); this.emit(`${sizeD} = sitofp i64 ${size} to double`);
    const open = this.fresh();
    this.emit(`${open} = call ptr @nt_insp_coll_open(ptr ${this.mod.intern(isMap ? "Map" : "Set")}, double ${sizeD})`);
    if (depth > INSPECT_DEPTH) {
      // node checks empty BEFORE the depth cut, so an empty collection still prints.
      const isEmpty = this.fresh(); this.emit(`${isEmpty} = icmp eq i64 ${size}, 0`);
      const empty = this.concat(open, this.mod.intern("}"));
      const t = this.fresh();
      this.emit(`${t} = select i1 ${isEmpty}, ptr ${empty}, ptr ${this.mod.intern(isMap ? "[Map]" : "[Set]")}`);
      return { v: t, ty: "string" };
    }
    const b = this.fresh();
    this.emit(`${b} = call ptr @nt_insp_new(ptr ${open}, ptr ${this.mod.intern("}")}, double ${llvmDouble(indent)}, double 0x0000000000000000, double 0x0000000000000000)`);
    const keys = this.fresh(); this.emit(`${keys} = call ptr @nt_coll_keys(ptr ${val.v})`);
    const klen = this.fresh(); this.emit(`${klen} = call double @nt_arr_len(ptr ${keys})`);
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const cond = this.label("ic"), body = this.label("icb"), upd = this.label("icu"), end = this.label("ice");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${klen}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
    const kslot = this.fresh(); this.emit(`${kslot} = call i64 @nt_arr_get(ptr ${keys}, double ${iB})`);
    const ks = this.genInspect({ v: this.fromSlot(kslot, kt), ty: kt }, depth + 1, indent + 2);
    let entry = ks.v;
    if (isMap) {
      const vs = this.fresh();
      this.emit(`${vs} = call i64 @nt_map_get_slot(ptr ${val.v}, i32 ${this.keyTag(kt)}, i64 ${kslot})`);
      const vstr = this.genInspect({ v: this.fromSlot(vs, vt), ty: vt }, depth + 1, indent + 2);
      const p = this.fresh();
      this.emit(`${p} = call ptr @nt_insp_pair(ptr ${ks.v}, ptr ${vstr.v})`);
      entry = p;
    }
    this.emit(`call void @nt_insp_add(ptr ${b}, ptr ${entry})`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    const t = this.fresh(); this.emit(`${t} = call ptr @nt_insp_done(ptr ${b})`);
    return { v: t, ty: "string" };
  }

  /** Print a nullable box: tag 0 → `undefined`, 1 → `null`, else unbox and print the base value. */
  private emitPrintNullable(ptr: string, rawBase: Ty, stream: "out" | "err" = "out"): void {
    // Unfold here rather than at the recursive `emitPrint` below: `base` is also what
    // `fromSlot` is given, and a `@N` there packs as a pointer only because `fromSlot`
    // knows the encoding — keeping the two in step is easier if the base is a real shape.
    const base = this.unfold(rawBase);
    const P = stream === "err" ? "js_eprint" : "js_print";
    const tag = this.nullTag(ptr);
    const isU = this.fresh(); this.emit(`${isU} = icmp eq i64 ${tag}, 0`);
    const uLbl = this.label("pu"), nChk = this.label("pnc"), nLbl = this.label("pn"), pLbl = this.label("pp"), end = this.label("pe");
    this.terminate(`br i1 ${isU}, label %${uLbl}, label %${nChk}`);
    this.to(this.block(uLbl)); this.emit(`call void @${P}_str(ptr ${this.mod.intern("undefined")})`); this.terminate(`br label %${end}`);
    this.to(this.block(nChk));
    const isN = this.fresh(); this.emit(`${isN} = icmp eq i64 ${tag}, 1`);
    this.terminate(`br i1 ${isN}, label %${nLbl}, label %${pLbl}`);
    this.to(this.block(nLbl)); this.emit(`call void @${P}_str(ptr ${this.mod.intern("null")})`); this.terminate(`br label %${end}`);
    this.to(this.block(pLbl)); this.emitPrint({ v: this.fromSlot(this.nullVal(ptr), base), ty: base }, stream); this.terminate(`br label %${end}`);
    this.to(this.block(end));
  }

  /**
   * Print a general-union box by dispatching on its tag: each arm is unpacked to its
   * own static type and handed to the ordinary printer, so what comes out is exactly
   * what the arm would have printed on its own — which is exactly what node prints.
   */
  private emitPrintGeneralUnion(ptr: string, ty: Ty, stream: "out" | "err" = "out"): void {
    const members = generalUnionMembers(ty);
    const tag = this.nullTag(ptr);
    const raw = this.nullVal(ptr);
    const end = this.label("gpe");
    members.forEach((m, i) => {
      const hit = this.label("gph"), miss = this.label("gpm");
      if (i === members.length - 1) {
        // The last arm needs no test: the tag is one of the members by construction.
        this.emitPrint({ v: this.fromSlot(raw, m), ty: m }, stream);
        this.terminate(`br label %${end}`);
        return;
      }
      const is = this.fresh();
      this.emit(`${is} = icmp eq i64 ${tag}, ${i}`);
      this.terminate(`br i1 ${is}, label %${hit}, label %${miss}`);
      this.to(this.block(hit));
      this.emitPrint({ v: this.fromSlot(raw, m), ty: m }, stream);
      this.terminate(`br label %${end}`);
      this.to(this.block(miss));
    });
    this.to(this.block(end));
  }

  /**
   * Runtime typeof of a nullable box: tag 0→"undefined", 1→"object" (null), else
   * typeof(base). The PRESENT arm carried its own copy of the leaking default arm —
   * `Set<string> | undefined` holding a set answered `"Set<string>"` — so it asks the one
   * canonical `staticTypeofName` too. `base` is never itself nullable (the box does not
   * nest), so the answer is always a constant here.
   */
  private genTypeofNullable(ptr: string, base: Ty): Val {
    const baseName = this.typeofNameOf(base);
    const slot = this.slot("string");
    const tag = this.nullTag(ptr);
    const isU = this.fresh(); this.emit(`${isU} = icmp eq i64 ${tag}, 0`);
    const uLbl = this.label("tu"), nChk = this.label("tnc"), nLbl = this.label("tn"), pLbl = this.label("tp"), end = this.label("te");
    this.terminate(`br i1 ${isU}, label %${uLbl}, label %${nChk}`);
    this.to(this.block(uLbl)); this.emit(`store ptr ${this.mod.intern("undefined")}, ptr ${slot}`); this.terminate(`br label %${end}`);
    this.to(this.block(nChk));
    const isN = this.fresh(); this.emit(`${isN} = icmp eq i64 ${tag}, 1`);
    this.terminate(`br i1 ${isN}, label %${nLbl}, label %${pLbl}`);
    this.to(this.block(nLbl)); this.emit(`store ptr ${this.mod.intern("object")}, ptr ${slot}`); this.terminate(`br label %${end}`);
    this.to(this.block(pLbl)); this.emit(`store ptr ${this.mod.intern(baseName)}, ptr ${slot}`); this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh(); this.emit(`${t} = load ptr, ptr ${slot}`);
    return { v: t, ty: "string" };
  }

  /**
   * The `typeof` name for a type whose answer must be a COMPILE-TIME CONSTANT — the
   * present arm of a nullable box and each arm of a general union. `staticTypeofName`
   * returns `undefined` exactly when the answer is a runtime fact or the type has no
   * value form (`Dyn`, an unsubstituted `#T`); neither can reach here, and a wrong
   * guess would be a silent wrong answer, so it is an internal error rather than a
   * fallback to `"object"`. Reject, never miscompile.
   */
  private typeofNameOf(t: Ty): string {
    const name = staticTypeofName(t);
    if (name === undefined) throw internalError(`no constant \`typeof\` for ${t}`);
    return name;
  }

  /**
   * Runtime `typeof` of a general-union box: select the arm's `typeof` name by tag.
   * A chain of `select`s rather than blocks — every arm's answer is a constant string,
   * so there is nothing to branch around.
   */
  private genTypeofGeneralUnion(ptr: string, ty: Ty): Val {
    const members = generalUnionMembers(ty);
    const tag = this.nullTag(ptr);
    let acc = this.mod.intern(this.typeofNameOf(members[members.length - 1]!)); // the last arm needs no test
    for (let i = members.length - 2; i >= 0; i--) {
      const is = this.fresh();
      this.emit(`${is} = icmp eq i64 ${tag}, ${i}`);
      const sel = this.fresh();
      this.emit(`${sel} = select i1 ${is}, ptr ${this.mod.intern(this.typeofNameOf(members[i]!))}, ptr ${acc}`);
      acc = sel;
    }
    return { v: acc, ty: "string" };
  }

  /** Read `.prop` from a NON-nullable object/string/array value (object slot, or `.length`). */
  private genFieldRead(obj: Val, prop: string): Val {
    if (prop === "length" && (obj.ty === "string" || isArrayTy(obj.ty) || isBytesTy(obj.ty))) {
      const t = this.fresh();
      if (obj.ty === "string") this.emit(`${t} = call double @js_str_len(ptr ${obj.v})`);
      else if (isBytesTy(obj.ty)) this.emit(`${t} = call double @nt_bytes_len(ptr ${obj.v})`);
      else this.emit(`${t} = call double @nt_arr_len(ptr ${obj.v})`);
      return { v: t, ty: "number" };
    }
    // A FOLDED receiver has no fields — `objectFields("@N")` is the empty list, so
    // `fieldType` is `undefined` and `fieldIndex` is a slot number computed from nothing.
    // Every caller is required to unfold first (they read the SHAPE, not the reference);
    // saying so here turns the one that forgets into a compiler bug report instead of a
    // load from the wrong offset. This is the `objectFields("@N")` phantom-record trap,
    // and it has now cost this project two silent wrong answers.
    if (isTypeRefTy(obj.ty)) throw internalError(`field read '.${prop}' on the folded reference ${obj.ty} — the receiver must be unfolded first`);
    const ft = fieldType(obj.ty, prop)!;
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, prop)}`);
    const slot = this.fresh();
    this.emit(`${slot} = load i64, ptr ${gep}`);
    return { v: this.fromSlot(slot, ft), ty: ft };
  }

  /**
   * Read `[index]` from an ALREADY-LOWERED, non-nullable object value. The sibling of
   * `genFieldRead`, and the shared tail of the `IndexExpr` case: split out so an optional
   * element access reaches the identical read after its nullish guard rather than growing
   * a parallel lowering. The index is lowered HERE, so a caller that has branched first
   * (see `genOptChain`) never evaluates it on the short-circuit path.
   */
  private genElemRead(obj: Val, e: Extract<Expr, { kind: "IndexExpr" }>): Val {
    if (obj.ty === "Dyn") { // dynamic element (numeric) or field (string literal) -> Dyn
      if (e.index.kind === "StringLiteral") {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_dyn_get_field(ptr ${obj.v}, ptr ${this.mod.intern(e.index.value)})`);
        return { v: t, ty: "Dyn" };
      }
      const idx = this.genExpr(e.index);
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_dyn_elem(ptr ${obj.v}, double ${idx.v})`);
      return { v: t, ty: "Dyn" };
    }
    if (isObjectTy(obj.ty)) {
      // object["key"] — string-literal index is a static field (checker-enforced)
      const key = (e.index as Extract<Expr, { kind: "StringLiteral" }>).value;
      const ft = fieldType(obj.ty, key)!;
      const gep = this.fresh();
      this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, key)}`);
      const slot = this.fresh();
      this.emit(`${slot} = load i64, ptr ${gep}`);
      return { v: this.fromSlot(slot, ft), ty: ft };
    }
    const idx = this.genExpr(e.index);
    // A WRITTEN index (`e.loc` set by the parser) reads through the bounds-PANIC
    // accessor; a synthesized one (destructuring, spread-call) keeps the plain read.
    const loc = this.locArg(e.loc);
    if (obj.ty === "string") {
      const t = this.fresh();
      this.emit(loc
        ? `${t} = call ptr @nt_str_index(ptr ${obj.v}, double ${idx.v}, ptr ${loc})`
        : `${t} = call ptr @js_str_char_at(ptr ${obj.v}, double ${idx.v})`);
      return { v: t, ty: "string" };
    }
    if (isBytesTy(obj.ty)) {
      const t = this.fresh();
      this.emit(loc
        ? `${t} = call double @nt_bytes_index(ptr ${obj.v}, double ${idx.v}, ptr ${loc})`
        : `${t} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
      return { v: t, ty: "number" };
    }
    const el = elemTy(obj.ty);
    const slot = this.fresh();
    this.emit(loc
      ? `${slot} = call i64 @nt_arr_index(ptr ${obj.v}, double ${idx.v}, ptr ${loc})`
      : `${slot} = call i64 @nt_arr_get(ptr ${obj.v}, double ${idx.v})`);
    return { v: this.fromSlot(slot, el), ty: el };
  }

  /**
   * Lower an optional chain to a single unit. Flatten `head .m1 .m2 …` into ordered
   * links; walk them, and at every step where the current value is nullable, guard:
   * if nullish, branch to a SHARED `undefined`-result join (short-circuiting the rest
   * of the chain — no trailing member is evaluated); otherwise unbox and read on.
   * The result is always a nullable box (tag 0 on any short-circuit, else present).
   */
  private genOptChain(e: Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>): Val {
    // A link is either `.prop` or `[index]`, so the LINK NODES THEMSELVES are the list —
    // no side record, and an index link keeps its own `loc` for the bounds panic. Holding
    // the node also means the index expression travels UNEVALUATED: it is lowered only
    // inside the continuation block past the guard, which is what makes
    // `a?.[sideEffect()]` skip the side effect when `a` is nullish, as node does.
    // Collected OUTERMOST-FIRST with `.push` and walked backwards, rather than `.unshift`ed
    // into chain order: `//@@mutable` legalizes `.push` only, so the reversed loop is what
    // puts this function inside the subset `src/` must stay in. The two spellings visit the
    // links in the same order — head-first — which is load-bearing, because each guard must
    // short-circuit before the links past it are lowered.
    //@@mutable
    const links: Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>[] = [];
    let node: Expr = e;
    while (node.kind === "MemberExpr" || node.kind === "IndexExpr") { links.push(node); node = node.object; }
    const resultSlot = this.slot(e.ty!); // holds the resulting nullable box (ptr)
    const nullJoin = this.label("ocnull");
    const endLbl = this.label("ocend");
    let cur = this.genExpr(node); // chain head
    for (let li = links.length - 1; li >= 0; li--) {
      const link = links[li]!;
      if (isNullableTy(cur.ty)) {
        const isN = this.isNullish(cur.v);
        const contLbl = this.label("occ");
        this.terminate(`br i1 ${isN}, label %${nullJoin}, label %${contLbl}`);
        this.to(this.block(contLbl));
        // UNFOLD, as `emitPrintNullable` does one screen up: `baseTy("?U@N")` is the bare
        // back-edge, and handing that to `genFieldRead` asks `fieldIndex("@N", …)` — where
        // `objectFields` returns the empty list, so the read silently took slot 0 of the
        // wrong shape. `a.next?.n` printed `0` and `a.next?.label` printed `(null)` where
        // node prints `2` and `y`: a SILENT WRONG ANSWER, which is the one outcome this
        // compiler refuses to have.
        const base = this.unfold(baseTy(cur.ty));
        cur = { v: this.fromSlot(this.nullVal(cur.v), base), ty: base }; // unbox the present value
      }
      cur = link.kind === "MemberExpr" ? this.genFieldRead(cur, link.property) : this.genElemRead(cur, link);
    }
    // Fall-through: every link read. Box the final value as present (or keep it if
    // the final field type is itself nullable).
    const present = isNullableTy(cur.ty) ? cur.v : this.nullBox("2", this.toSlot(cur));
    this.emit(`store ptr ${present}, ptr ${resultSlot}`);
    this.terminate(`br label %${endLbl}`);
    // Shared short-circuit target: result = undefined.
    this.to(this.block(nullJoin));
    this.emit(`store ptr ${this.nullBox("0", "0")}, ptr ${resultSlot}`);
    this.terminate(`br label %${endLbl}`);
    this.to(this.block(endLbl));
    const t = this.fresh();
    this.emit(`${t} = load ptr, ptr ${resultSlot}`);
    return { v: t, ty: e.ty! };
  }

  private genMath(method: string, args: Expr[]): Val {
    // max/min first: their arguments may include a SPREAD, which has no value of its
    // own and so must not reach `genExpr` through the map below.
    if (method === "max" || method === "min") return this.genMathMinMax(method, args);
    const vals = args.map((a) => this.genExpr(a).v);
    if (method === "pow") {
      // Math.pow and `**` are the SAME operation in the spec (both Number::exponentiate),
      // so they share one lowering; C `pow` would answer 1 where node answers NaN.
      const t = this.fresh();
      this.emit(`${t} = call double @js_pow(double ${vals[0]}, double ${vals[1]})`);
      return { v: t, ty: "number" };
    }
    const fn = MATH_FN1.get(method);
    if (!fn) throw internalError(`no lowering for Math.${method}, which the checker admitted`);
    const t = this.fresh();
    this.emit(`${t} = call double @${fn}(double ${vals[0]})`);
    return { v: t, ty: "number" };
  }

  /**
   * `Math.max` / `Math.min` — a LEFT FOLD with the pairwise step `js_math_max/min`.
   *
   * NOT C's fmax/fmin: those answer 1 for `Math.max(NaN, 1)` where JS says NaN, and
   * IEEE-754 maxNum leaves +0/-0 unspecified where JS orders them. Both were silent
   * wrong answers here before.
   *
   * A SPREAD argument folds in the runtime (`js_math_fold_arr`), so its length is a
   * runtime property: `Math.max(...xs)` needs no arity, and spreads mix freely with
   * fixed arguments in any position. Seeding from the identity is what makes an EMPTY
   * spread come out as -Infinity/+Infinity instead of 0 — but with NO spread present
   * the seed is the first argument instead, which keeps the emitted IR for the ordinary
   * `Math.max(a, b)` exactly what it has always been.
   */
  private genMathMinMax(method: "max" | "min", args: Expr[]): Val {
    const isMax = method === "max";
    const step = isMax ? "js_math_max" : "js_math_min";
    const identity = llvmDouble(isMax ? -Infinity : Infinity);

    if (!args.some((a) => a.kind === "SpreadExpr")) {
      const vals = args.map((a) => this.genExpr(a).v);
      if (vals.length === 0) return { v: identity, ty: "number" };
      let acc = vals[0]!;
      for (let i = 1; i < vals.length; i++) {
        const t = this.fresh();
        this.emit(`${t} = call double @${step}(double ${acc}, double ${vals[i]})`);
        acc = t;
      }
      return { v: acc, ty: "number" };
    }

    let acc = identity;
    for (const a of args) {
      const t = this.fresh();
      if (a.kind === "SpreadExpr") {
        const arr = this.genExpr(a.argument);
        this.emit(`${t} = call double @js_math_fold_arr(ptr ${arr.v}, double ${acc}, i32 ${isMax ? 1 : 0})`);
        // `Math.max(...spans.map(f))` builds an array no binding owns, so the drop pass
        // never sees it. Same syntactic freshness judgment as `freeReceiverTemp`.
        if (freshArray(a.argument)) this.emit(`call void @nt_arr_free(ptr ${arr.v})`);
      } else {
        this.emit(`${t} = call double @${step}(double ${acc}, double ${this.genExpr(a).v})`);
      }
      acc = t;
    }
    return { v: acc, ty: "number" };
  }

  private genStringMethod(method: string, recv: Val, args: Expr[]): Val {
    const a = args.map((x) => this.genExpr(x));
    const call = (fn: string, argstr: string): string => {
      const t = this.fresh();
      this.emit(`${t} = call ptr @${fn}(${argstr})`);
      return t;
    };
    switch (method) {
      case "toUpperCase": return { v: call("js_str_upper", `ptr ${recv.v}`), ty: "string" };
      case "toLowerCase": return { v: call("js_str_lower", `ptr ${recv.v}`), ty: "string" };
      case "trim": return { v: call("js_str_trim", `ptr ${recv.v}`), ty: "string" };
      case "trimEnd": return { v: call("js_str_trim_end", `ptr ${recv.v}`), ty: "string" };
      case "trimStart": return { v: call("js_str_trim_start", `ptr ${recv.v}`), ty: "string" };
      case "charAt": return { v: call("js_str_char_at", `ptr ${recv.v}, double ${a[0]!.v}`), ty: "string" };
      case "repeat": return { v: call("js_str_repeat", `ptr ${recv.v}, double ${a[0]!.v}`), ty: "string" };
      // `.slice(start?, end?)`: both optional in lib.es5.d.ts, so `s.slice()` is the whole
      // string. `.substring(start, end?)` keeps a REQUIRED start — see STRING_METHODS.
      case "slice": return { v: call("js_str_slice", `ptr ${recv.v}, double ${a[0]?.v ?? "0.0"}, double ${a[1]?.v ?? POS_INF}`), ty: "string" };
      case "substring": return { v: call("js_str_substring", `ptr ${recv.v}, double ${a[0]!.v}, double ${a[1]?.v ?? POS_INF}`), ty: "string" };
      case "padStart": return { v: call("js_str_pad_start", `ptr ${recv.v}, double ${a[0]!.v}, ptr ${a[1]?.v ?? this.mod.intern(" ")}`), ty: "string" };
      case "includes": {
        const r = this.fresh();
        this.emit(`${r} = call i32 @js_str_includes(ptr ${recv.v}, ptr ${a[0]!.v})`);
        const t = this.fresh();
        this.emit(`${t} = icmp ne i32 ${r}, 0`);
        return { v: t, ty: "boolean" };
      }
      case "indexOf": {
        // The optional fromIndex takes a DIFFERENT entry point rather than defaulting to
        // NaN through one: the 1-arg call stays exactly the instruction it always was,
        // so no existing `.ll` (or IR snapshot) moves.
        const t = this.fresh();
        // `a.length > 1`, not `a[1]`: the 1-arg form reads index == length, a panic.
        if (a.length > 1) this.emit(`${t} = call double @js_str_index_of_from(ptr ${recv.v}, ptr ${a[0]!.v}, double ${a[1]!.v})`);
        else this.emit(`${t} = call double @js_str_index_of(ptr ${recv.v}, ptr ${a[0]!.v})`);
        return { v: t, ty: "number" };
      }
      case "split": // optional 2nd arg = limit (NaN when omitted)
        return { v: call("nt_str_split_n", `ptr ${recv.v}, ptr ${a[0]!.v}, double ${a[1]?.v ?? NAN_HEX}`), ty: "string[]" };
      // --- stdlib Batch 1 (part 2): string fills ---
      case "concat": { // variadic: fold the arguments onto the receiver
        let acc = recv.v;
        for (const x of a) { const t = this.fresh(); this.emit(`${t} = call ptr @js_str_concat(ptr ${acc}, ptr ${x.v})`); acc = t; }
        return { v: acc, ty: "string" };
      }
      case "lastIndexOf": {
        const t = this.fresh();
        // The optional `position` is NaN when omitted — which is also what the spec's
        // own NaN case means (+Infinity, i.e. search the whole string), so one path serves both.
        this.emit(`${t} = call double @js_str_last_index_of(ptr ${recv.v}, ptr ${a[0]!.v}, double ${a[1]?.v ?? NAN_HEX})`);
        return { v: t, ty: "number" };
      }
      case "replace": case "replaceAll":
        return { v: call("js_str_replace", `ptr ${recv.v}, ptr ${a[0]!.v}, ptr ${a[1]!.v}, i32 ${method === "replaceAll" ? 1 : 0}`), ty: "string" };
      case "startsWith": case "endsWith": {
        // The optional position argument is NaN when omitted (runtime default).
        const fn = method === "startsWith" ? "js_str_starts_with" : "js_str_ends_with";
        const r = this.fresh();
        this.emit(`${r} = call i32 @${fn}(ptr ${recv.v}, ptr ${a[0]!.v}, double ${a[1]?.v ?? NAN_HEX})`);
        const t = this.fresh();
        this.emit(`${t} = icmp ne i32 ${r}, 0`);
        return { v: t, ty: "boolean" };
      }
      case "padEnd": return { v: call("js_str_pad_end", `ptr ${recv.v}, double ${a[0]!.v}, ptr ${a[1]?.v ?? this.mod.intern(" ")}`), ty: "string" };
      case "charCodeAt": {
        const t = this.fresh();
        this.emit(`${t} = call double @js_str_char_code_at(ptr ${recv.v}, double ${a[0]?.v ?? "0.0"})`);
        return { v: t, ty: "number" };
      }
      case "codePointAt": {
        // number | undefined — the runtime returns NaN for an out-of-range index
        // (never a real code point), which becomes node's `undefined` box.
        const r = this.fresh();
        this.emit(`${r} = call double @js_str_code_point_at(ptr ${recv.v}, double ${a[0]?.v ?? "0.0"})`);
        const oob = this.fresh();
        this.emit(`${oob} = fcmp uno double ${r}, ${r}`); // NaN sentinel => out of range
        return { v: this.nullBox(this.nullTagIf(oob), this.toSlot({ v: r, ty: "number" })), ty: makeNullable("undefined", "number") };
      }
      case "at": {
        // string | undefined — NULL from the runtime is the out-of-range sentinel.
        const r = this.fresh();
        this.emit(`${r} = call ptr @js_str_at(ptr ${recv.v}, double ${a[0]?.v ?? "0.0"})`);
        const oob = this.fresh();
        this.emit(`${oob} = icmp eq ptr ${r}, null`);
        return { v: this.nullBox(this.nullTagIf(oob), this.toSlot({ v: r, ty: "string" })), ty: makeNullable("undefined", "string") };
      }
      default: throw internalError(`no lowering for string method .${method}, which the checker admitted`);
    }
  }

  /** structuredClone: a deep copy generated from the STATIC type (the same
   *  type-directed walk shape as JSON.stringify). Scalars/strings are values and
   *  pass through; an object becomes a fresh slot block with each field cloned;
   *  an array becomes a fresh vector with each element cloned in a loop. */
  private genDeepClone(v: Val, copyStrings = false): Val {
    const ty = v.ty;
    // THE GUARANTEE, not a second opinion. Every arm below falls through to `return v` —
    // value semantics — for a type it does not recognize, and a `@Name` back-edge is such a
    // type, so an unrefused recursive value was copied by ALIASING it. Both callers
    // (`structuredClone`, the actor-message copy) refuse this in the checker; this makes the
    // safety a property of the WALK rather than of two independent gates staying in place.
    // A BARE `@N` is the whole test: the walk decomposes fields and elements itself, so a
    // reference nested anywhere arrives here on its own step. Asking `containsTypeRef` up
    // front would be the same answer more expensively, and asking `t.includes("@")` would
    // refuse a record with an `@` in a KEY.
    if (isTypeRefTy(ty)) {
      throw internalError(`deep copy of the recursive type ${ty} reached codegen — the walk has no seen-set, so it would alias rather than copy. This must be refused in the checker (structuredClone / actor message)`);
    }
    // B3 v5: for an actor message the copy must reach STRINGS too — a receiver whose
    // record pointed into the sender's (refcounted, releasable) buffer would not be
    // isolated. structuredClone itself leaves strings alone: they are immutable values
    // within one actor, so sharing them there is unobservable.
    if (ty === "string" && copyStrings) {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_msg_str_copy(ptr ${v.v})`);
      return { v: t, ty };
    }
    if (isObjectTy(ty)) {
      const fields = objectFields(ty);
      const obj = this.fresh();
      this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(fields.length, 1))})`);
      fields.forEach((f, i) => {
        const gep = this.fresh();
        this.emit(`${gep} = getelementptr i64, ptr ${v.v}, i64 ${i}`);
        const slot = this.fresh();
        this.emit(`${slot} = load i64, ptr ${gep}`);
        const cloned = this.genDeepClone({ v: this.fromSlot(slot, f.ty), ty: f.ty }, copyStrings);
        const dst = this.fresh();
        this.emit(`${dst} = getelementptr i64, ptr ${obj}, i64 ${i}`);
        this.emit(`store i64 ${this.toSlot(cloned)}, ptr ${dst}`);
      });
      return { v: obj, ty };
    }
    if (isArrayTy(ty)) {
      const el = elemTy(ty);
      // A scalar element array is a flat block — one runtime copy is already deep.
      // (Not for a message's `string[]`: the elements themselves must be copied.)
      if (!isObjectTy(el) && !isArrayTy(el) && !(copyStrings && el === "string")) {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_copy(ptr ${v.v})`);
        return { v: t, ty };
      }
      const len = this.fresh();
      this.emit(`${len} = call double @nt_arr_len(ptr ${v.v})`);
      const out = this.fresh();
      this.emit(`${out} = call ptr @nt_arr_new(double ${len})`);
      const idx = this.slot("number");
      this.emit(`store double 0x0000000000000000, ptr ${idx}`);
      const cond = this.label("clc"), body = this.label("clb"), end = this.label("cle");
      this.terminate(`br label %${cond}`);
      this.to(this.block(cond));
      const iC = this.fresh();
      this.emit(`${iC} = load double, ptr ${idx}`);
      const cmp = this.fresh();
      this.emit(`${cmp} = fcmp olt double ${iC}, ${len}`);
      this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
      this.to(this.block(body));
      const slot = this.fresh();
      this.emit(`${slot} = call i64 @nt_arr_get(ptr ${v.v}, double ${iC})`);
      const cloned = this.genDeepClone({ v: this.fromSlot(slot, el), ty: el }, copyStrings);
      this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot(cloned)})`);
      const iN = this.fresh();
      this.emit(`${iN} = fadd double ${iC}, 1.0`);
      this.emit(`store double ${iN}, ptr ${idx}`);
      this.terminate(`br label %${cond}`);
      this.to(this.block(end));
      return { v: out, ty };
    }
    return v; // number / string / boolean — value semantics, nothing to clone
  }

  /** Build a `string[]` array literal from compile-time-known keys (Object.keys / for-in). */
  private buildStringArray(keys: string[]): Val {
    const arr = this.fresh();
    this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(keys.length, 1))})`);
    for (const k of keys) {
      const slot = this.toSlot({ v: this.mod.intern(k), ty: "string" });
      this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${slot})`);
    }
    return { v: arr, ty: "string[]" };
  }

  /** Key-type tag passed to the nt_hamt scalar wrappers: NT_K_NUM=0, NT_K_STR=1. */
  private keyTag(ty: Ty): number { return ty === "string" ? 1 : 0; }

  /** Immutable Map methods → nt_hamt scalar-ABI wrappers. `.set`/`.delete` return a NEW handle. */
  /**
   * stdlib Batch 3 — URLSearchParams over the raw query text. `.get` returns NULL
   * for a miss, which becomes the `null` arm of the A2 tagged pair (node's exact
   * `string | null` shape); `.has` is the NULL test; `.getAll` a fresh string[].
   */
  private genSearchParamsMethod(method: string, recv: Val, args: Expr[]): Val {
    if (method === "toString") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_qs_to_string(ptr ${recv.v})`);
      return { v: t, ty: "string" };
    }
    const key = this.genExpr(args[0]!).v;
    if (method === "getAll") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_qs_get_all(ptr ${recv.v}, ptr ${key})`);
      return { v: t, ty: "string[]" };
    }
    const got = this.fresh();
    this.emit(`${got} = call ptr @nt_qs_get(ptr ${recv.v}, ptr ${key})`);
    const isNull = this.fresh();
    this.emit(`${isNull} = icmp eq ptr ${got}, null`);
    if (method === "has") {
      const t = this.fresh();
      this.emit(`${t} = xor i1 ${isNull}, true`);
      return { v: t, ty: "boolean" };
    }
    const tag = this.fresh();
    this.emit(`${tag} = select i1 ${isNull}, i64 1, i64 2`); // 1 = null, 2 = present
    const slot = this.fresh();
    this.emit(`${slot} = ptrtoint ptr ${got} to i64`);
    return { v: this.nullBox(tag, slot), ty: makeNullable("null", "string") };
  }

  private genMapMethod(method: string, recv: Val, args: Expr[]): Val {
    const k = mapKeyTy(recv.ty), v = mapValTy(recv.ty);
    const tag = this.keyTag(k);
    const keySlot = () => this.toSlot(this.genExpr(args[0]!)); // arg[0] typed as k
    switch (method) {
      // Iterators → a real array of key/value slots in INSERTION order (the key log
      // in nt_mapset.c), so for-of / spread / Array.from all match node's order.
      case "keys": case "values": {
        const a = this.fresh();
        this.emit(`${a} = call ptr @nt_coll_${method}(ptr ${recv.v})`);
        return { v: a, ty: makeArrayTy(method === "keys" ? k : v) };
      }
      case "set": {
        const ks = keySlot();
        const vs = this.toSlot(this.genExpr(args[1]!));
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_map_put_slot(ptr ${recv.v}, i32 ${tag}, i64 ${ks}, i64 ${vs})`);
        return { v: t, ty: recv.ty };
      }
      case "get": {
        // Returns `V | undefined`: build a nullable box — tag 2 (present) + the
        // value slot on a hit, tag 0 (undefined) on a miss. Reuses A2 machinery.
        const ks = keySlot();
        const present = this.fresh();
        this.emit(`${present} = call i32 @nt_map_has_slot(ptr ${recv.v}, i32 ${tag}, i64 ${ks})`);
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_map_get_slot(ptr ${recv.v}, i32 ${tag}, i64 ${ks})`);
        const isP = this.fresh();
        this.emit(`${isP} = icmp ne i32 ${present}, 0`);
        const tg = this.fresh();
        this.emit(`${tg} = select i1 ${isP}, i64 2, i64 0`);
        const vs = this.fresh();
        this.emit(`${vs} = select i1 ${isP}, i64 ${slot}, i64 0`);
        return { v: this.nullBox(tg, vs), ty: makeNullable("undefined", v) };
      }
      case "has": {
        const ks = keySlot();
        const r = this.fresh(), b = this.fresh();
        this.emit(`${r} = call i32 @nt_map_has_slot(ptr ${recv.v}, i32 ${tag}, i64 ${ks})`);
        this.emit(`${b} = icmp ne i32 ${r}, 0`);
        return { v: b, ty: "boolean" };
      }
      case "delete": {
        const ks = keySlot();
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_map_remove_slot(ptr ${recv.v}, i32 ${tag}, i64 ${ks})`);
        return { v: t, ty: recv.ty };
      }
      default: throw nyi(NYI.COLLECTION, `Map method '.${method}'`);
    }
  }

  /** Immutable Set methods → nt_hamt scalar-ABI wrappers. `.add`/`.delete` return a NEW handle. */
  private genSetMethod(method: string, recv: Val, args: Expr[]): Val {
    const el = setElemTy(recv.ty);
    const tag = this.keyTag(el);
    const elSlot = () => this.toSlot(this.genExpr(args[0]!));
    switch (method) {
      // `.values()`/`.keys()` are the same thing for a Set: its elements, in
      // insertion order (node's guarantee, kept by nt_mapset.c's key log).
      case "keys": case "values": {
        const a = this.fresh();
        this.emit(`${a} = call ptr @nt_coll_keys(ptr ${recv.v})`);
        return { v: a, ty: makeArrayTy(el) };
      }
      case "add": {
        const es = elSlot();
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_set_add_slot(ptr ${recv.v}, i32 ${tag}, i64 ${es})`);
        return { v: t, ty: recv.ty };
      }
      case "has": {
        const es = elSlot();
        const r = this.fresh(), b = this.fresh();
        this.emit(`${r} = call i32 @nt_set_has_slot(ptr ${recv.v}, i32 ${tag}, i64 ${es})`);
        this.emit(`${b} = icmp ne i32 ${r}, 0`);
        return { v: b, ty: "boolean" };
      }
      case "delete": {
        const es = elSlot();
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_set_remove_slot(ptr ${recv.v}, i32 ${tag}, i64 ${es})`);
        return { v: t, ty: recv.ty };
      }
      default: throw nyi(NYI.COLLECTION, `Set method '.${method}'`);
    }
  }

  private genArrayMethod(method: string, recv: Val, args: Expr[], loc?: Loc): Val {
    const el = elemTy(recv.ty);
    const numeric = el === "number";
    switch (method) {
      // ES2023 copying ordering primitives (non-mutating in node too).
      case "toSorted": {
        const t = this.fresh();
        if (args.length === 0) {
          this.emit(`${t} = call ptr @nt_arr_to_sorted(ptr ${recv.v}, i32 ${el === "string" ? 1 : 0})`);
        } else {
          const clo = this.genExpr(args[0]!); // any function value → closure block
          this.emit(`${t} = call ptr @nt_arr_to_sorted_by(ptr ${recv.v}, ptr ${clo.v}, ptr @${this.mod.cmpShim(el)})`);
        }
        return { v: t, ty: recv.ty };
      }
      case "toReversed": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_to_reversed(ptr ${recv.v})`);
        return { v: t, ty: recv.ty };
      }
      // `.push` on a `@@mutable` accumulator binding (the checker refuses every other
      // receiver). node's contract, mined from test262
      // test/built-ins/Array/prototype/push/: append the arguments LEFT TO RIGHT and
      // return the NEW length — which for zero arguments is just the current length.
      case "push": {
        if (args.length === 0) {
          const t = this.fresh();
          this.emit(`${t} = call double @nt_arr_len(ptr ${recv.v})`);
          return { v: t, ty: "number" };
        }
        let last = "";
        for (const a of args) {
          const slot = this.toSlot(this.genExpr(a));
          last = this.fresh();
          this.emit(`${last} = call double @nt_arr_push(ptr ${recv.v}, i64 ${slot})`);
        }
        return { v: last, ty: "number" };
      }
      case "pop": {
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_arr_pop(ptr ${recv.v})`);
        return { v: this.fromSlot(slot, el), ty: el };
      }
      case "join": {
        const sep = args[0] ? this.genExpr(args[0]).v : this.mod.intern(",");
        const t = this.fresh();
        this.emit(`${t} = call ptr @${joinFn(el)}(ptr ${recv.v}, ptr ${sep})`);
        return { v: t, ty: "string" };
      }
      case "includes": {
        const x = this.genExpr(args[0]!).v;
        const r = this.fresh();
        if (numeric) this.emit(`${r} = call i32 @nt_arr_includes_num(ptr ${recv.v}, double ${x})`);
        else this.emit(`${r} = call i32 @nt_arr_includes_str(ptr ${recv.v}, ptr ${x})`);
        const t = this.fresh();
        this.emit(`${t} = icmp ne i32 ${r}, 0`);
        return { v: t, ty: "boolean" };
      }
      // `.indexOf(x, fromIndex?)` / `.lastIndexOf(x, fromIndex?)`. The OMITTED case is
      // spelled here, not as a NaN sentinel in the runtime, because an explicitly passed
      // NaN is NOT the same thing: `ToIntegerOrInfinity(NaN)` is 0, so
      // `[1,2,1].lastIndexOf(1, NaN)` is 0 while `[1,2,1].lastIndexOf(1)` is 2. Absent is
      // 0 forward and +Infinity backward (which the runtime clamps to len-1).
      // (`String#lastIndexOf` is the opposite — there a NaN position IS +Infinity by
      // ES 22.1.3.11 — so it keeps its NaN sentinel.)
      case "indexOf": {
        const x = this.genExpr(args[0]!).v;
        const from = args.length > 1 ? this.genExpr(args[1]!).v : "0.0";
        const t = this.fresh();
        if (numeric) this.emit(`${t} = call double @nt_arr_indexof_num(ptr ${recv.v}, double ${x}, double ${from})`);
        else this.emit(`${t} = call double @nt_arr_indexof_str(ptr ${recv.v}, ptr ${x}, double ${from})`);
        return { v: t, ty: "number" };
      }
      case "reverse": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_arr_reverse(ptr ${recv.v})`); return { v: t, ty: recv.ty }; }
      // --- stdlib Batch 1 (part 2): array fills ---
      case "lastIndexOf": {
        const x = this.genExpr(args[0]!).v;
        const from = args.length > 1 ? this.genExpr(args[1]!).v : POS_INF; // absent => len-1
        const t = this.fresh();
        this.emit(`${t} = call double @${numeric ? "nt_arr_last_indexof_num" : "nt_arr_last_indexof_str"}(ptr ${recv.v}, ${numeric ? "double" : "ptr"} ${x}, double ${from})`);
        return { v: t, ty: "number" };
      }
      case "concat": { // variadic: fold each argument array onto a fresh copy
        let acc = recv.v;
        for (const arg of args) {
          const b = this.genExpr(arg).v;
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_arr_concat(ptr ${acc}, ptr ${b})`);
          // The FOLD's intermediates: every `acc` past the receiver is a header this
          // lowering allocated one line earlier and has just copied out of, so nothing
          // else can name it — `a.concat(b, c)` allocated two and returned one. The
          // receiver itself is skipped: it is the caller's binding (or, if it was a
          // temporary, `freeReceiverTemp`'s to release).
          if (acc !== recv.v) this.emit(`call void @nt_arr_free(ptr ${acc})`);
          acc = t;
        }
        // Fresh by construction: `nt_arr_concat` returns a NEW header (and `concat` with
        // no arguments is `recv` itself, which this frame does not own).
        if (acc !== recv.v) this.discardFree = { v: acc, call: "nt_arr_free" };
        return { v: acc, ty: recv.ty };
      }
      case "at": {
        // T | undefined — the runtime normalizes the index and returns -1 out of range.
        const i = this.fresh();
        this.emit(`${i} = call double @nt_arr_at_index(ptr ${recv.v}, double ${this.genExpr(args[0]!).v})`);
        const oob = this.fresh();
        this.emit(`${oob} = fcmp olt double ${i}, 0x0000000000000000`);
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_arr_get(ptr ${recv.v}, double ${i})`);
        return { v: this.nullBox(this.nullTagIf(oob), slot), ty: makeNullable("undefined", el) };
      }
      case "with": {
        // Immutable update (CoW): full copy of the flat block with slot i replaced.
        // Receiver is borrowed + unchanged; result is a fresh owned array (drops once).
        // Out of range PANICS: it used to leave the copy untouched, so the program
        // carried on with an array it believed it had updated (node throws RangeError).
        const idx = this.genExpr(args[0]!).v;
        const slot = this.toSlot(this.genExpr(args[1]!));
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_with(ptr ${recv.v}, double ${idx}, i64 ${slot}, ptr ${this.locArg(loc) ?? "null"})`);
        return { v: t, ty: recv.ty };
      }
      case "slice": {
        // `start` defaults to 0, so `xs.slice()` copies the whole array.
        const a0 = args.length > 0 ? this.genExpr(args[0]!).v : "0.0";
        // `args.length > 1`, not `args[1]`: `slice(n)` reads index == length, a panic.
        const a1 = args.length > 1 ? this.genExpr(args[1]!).v : POS_INF;
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_slice(ptr ${recv.v}, double ${a0}, double ${a1})`);
        return { v: t, ty: recv.ty };
      }
      case "flat": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_arr_flat1(ptr ${recv.v})`); return { v: t, ty: el }; }
      case "flatMap": return this.genFlatMap(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, this.locArg(loc) ?? "null");
      case "some": case "every": case "find": case "findIndex": case "findLast": case "findLastIndex":
        return this.genSearchHof(method, recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, this.locArg(loc) ?? "null");
      case "forEach": return this.genForEach(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, this.locArg(loc) ?? "null");
      case "map": return this.genMap(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, this.locArg(loc) ?? "null");
      case "filter": return this.genFilter(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, this.locArg(loc) ?? "null");
      case "reduce": return this.genReduce(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, args[1]!, this.locArg(loc) ?? "null");
      default: throw internalError(`no lowering for array method .${method}, which the checker admitted`);
    }
  }

  /** HOF loop skeleton. `setup(len)` runs in the pre-loop block (create output
   *  arrays etc. exactly once); then the cond/body blocks are set up and entered. */
  /**
   * The receiver's length, emitted BEFORE the loop scaffolding — the value a caller that
   * pre-sizes an output array (`.map`/`.filter`) needs, and the loop bound for everyone.
   *
   * It is a separate call rather than a `setup` CALLBACK that `hofLoop` invoked between
   * the two emissions. The callback shape forced every pre-sizing caller to write its
   * output register into a `let` in the ENCLOSING function and assign it from inside the
   * arrow, which is a write to a captured binding — NT1031, and outside the subset `src/`
   * must stay inside (three of `codegen.ts`'s self-host blockers were exactly this, plus
   * two more from `() => {}` passed where `(len: string) => void` was expected). Ordering
   * is unchanged: callers emit their pre-loop setup between `hofLen` and `hofLoop`, which
   * is where `setup(len)` used to run, so the IR is byte-identical.
   */
  private hofLen(recv: Val): string {
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${recv.v})`);
    return len;
  }

  /**
   * Bind one iteration's element into the callback's parameter slot (and its INDEX slot,
   * when the callback declared one), returning the element value.
   *
   * A METHOD taking `recv`/`idx` rather than a closure member on `hofLoop`'s result. As a
   * member it was a function-typed FIELD, so every `L.elem(…)` was a method call on an
   * object literal — NT1002, and outside the subset `src/` must stay inside; it was the
   * blocker masked directly beneath the `setup` callback in all five HOF generators.
   * `hofLoop` never called it, only handed it back, so lifting it out moves no emission.
   */
  private hofElem(recv: Val, idx: string, el: Ty, pName: string, iName: string, what: string, locp: string): string {
    const iB = this.fresh();
    this.emit(`${iB} = load double, ptr ${idx}`);
    const slot = this.fresh();
    // THE BOUNDS-PANICKING ACCESSOR, not `nt_arr_get`. The loop bound is `hofLen`'s
    // SNAPSHOT of the length, taken before the first callback ran — which matches node,
    // whose `.map`/`.filter`/… read `length` once too. What it is NOT is a guaranteed
    // in-bounds range: a callback that SHRINKS the receiver leaves every index from the
    // new length up to the snapshot pointing past the end, and `nt_arr_get` answered 0
    // there. That printed `[1,2,0,0]` where node prints `[1,2,null,null]`, exit 0 both
    // ways — and it was the one place a compiler-generated read could go out of bounds
    // without the Stage 41 panic, while the identical `a[i]` written in the source did
    // panic. The comment on `nt_arr_get` used to justify its return-0 contract by naming
    // these loops as in-bounds; that is what was false.
    //
    // Re-reading the length per iteration is NOT the alternative: node snapshots too, so
    // a callback that PUSHES must still visit only the original count, and re-reading
    // would walk the growth. node's actual answer — skip the absent index, and let
    // `.map`'s result carry holes — needs an absent-ness a dense `int64` array cannot
    // represent, and would give `.map` the type `T | undefined`.
    //
    // Measured cost: ZERO IR instructions (a one-for-one call substitution across all 24
    // perf-corpus programs), and no wall-clock delta once the panic's buffers live in
    // their own frame. See nt_arr_hof_at in runtime/runtime.c.
    this.emit(`${slot} = call i64 @nt_arr_hof_at(ptr ${recv.v}, double ${iB}, ptr ${this.mod.intern(what)}, ptr ${locp})`);
    const v = this.fromSlot(slot, el);
    this.emit(`store ${llvmTy(el)} ${v}, ptr ${this.addr(pName)}`);
    // The INDEX parameter, when the callback declared one: the loop counter this line
    // just loaded, copied into the callback's own slot. Re-read per iteration inside the
    // body block rather than hoisted, so a body that ASSIGNS to `i` perturbs only its own
    // copy and the loop keeps stepping — node's callback parameter is a fresh binding too.
    //
    // `""` for "no index parameter", not an optional parameter: `iName?: string` in this
    // annotation is outside the subset `src/` must stay inside (the parser does not take
    // `?` on a function-TYPE parameter, and the recovery reported it as `Cannot find name
    // 'el'` — the whole tree stopped linking). Same sentinel `hofReturnStack`'s `slot`
    // already uses two screens down.
    if (iName !== "") this.emit(`store double ${iB}, ptr ${this.addr(iName)}`);
    return v;
  }

  private hofLoop(recv: Val, tag: string, len: string): { idx: string; cond: string; upd: string; end: string } {
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const cond = this.label(tag), body = this.label(`${tag}b`), upd = this.label(`${tag}u`), end = this.label(`${tag}e`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh();
    this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh();
    this.emit(`${cmp} = fcmp olt double ${iC}, ${len}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    return { idx, cond, upd, end };
  }

  /**
   * The INDEX parameter of an inlined HOF callback — its (already freshened) name, given a
   * `number` slot in the flat frame, or `""` when the callback did not declare one.
   *
   * `at` is where the index sits in the parameter list: 1 for `.map`/`.filter`/`.forEach`/
   * `.flatMap`/`.find*`/`.some`/`.every`, whose callback is `(elem, index)`, and 2 for
   * `.reduce`, whose callback is `(acc, elem, index)`. The checker (`hofCallbackParams`)
   * has already established the arity, so an absent parameter here means the source
   * omitted it — never that a slot went unbound.
   *
   * The slot MUST be added here, before `hofLoop` emits: it is the enclosing function's
   * flat frame, and a `store` to a `%i.addr` that was never allocated is not a wrong
   * answer but a tree LLVM rejects ("use of undefined value") — which is how the missing
   * `.filter`/`.flatMap` wiring announced itself rather than silently reading garbage.
   */
  private hofIndexParam(arrow: Extract<Expr, { kind: "ArrowFunction" }>, at: number): string {
    const p = arrow.params[at];
    if (!p) return "";
    this.addLocal(p.name, "number");
    return p.name;
  }

  private hofStep(idx: string, upd: string, cond: string): void {
    if (!this.isTerminated()) this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh();
    this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh();
    this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
  }

  /** Element type produced by an inlined HOF callback — its `retTy` (recorded by the
   *  checker for both expression and block bodies). */
  private hofRetTy(arrow: Extract<Expr, { kind: "ArrowFunction" }>): Ty {
    return (arrow.retTy ?? (arrow.exprBody ? (arrow.body as Expr).ty : "number") ?? "number") as Ty;
  }

  /** Collect the names an arrow's block body BINDS in the flat frame (params handled by
   *  the caller) — VarDecls, for-loop/for-of/for-in vars, catch params — WITHOUT descending
   *  into nested arrows (those are their own binders). Mirrors collectLocals's shape.
   *
   *  RETURNS the accumulated set rather than filling an out-parameter, and every caller
   *  must take the return. A nativets `Set` is PERSISTENT: `.add` yields a new set and
   *  leaves the receiver unchanged (NT1606), so an out-parameter would come back empty.
   *  Under bun `.add` mutates and returns the same set, so threading is a no-op there —
   *  one spelling, both semantics. */
  private collectBoundNames(body: Stmt[], out: Set<string>): Set<string> {
    let acc = out;
    for (const s of body) {
      switch (s.kind) {
        case "VarDecl": for (const d of s.decls) acc = acc.add(d.name); break;
        case "IfStmt": acc = this.collectBoundNames(s.consequent, acc); if (s.alternate) acc = this.collectBoundNames(s.alternate, acc); break;
        case "WhileStmt": case "DoWhileStmt": acc = this.collectBoundNames(s.body, acc); break;
        case "ForStmt":
          if (s.init && (s.init as VarDecl).kind === "VarDecl") for (const d of (s.init as VarDecl).decls) acc = acc.add(d.name);
          acc = this.collectBoundNames(s.body, acc); break;
        // `name2` is the VALUE half of `for (const [k, v] of map)` and binds exactly as
        // `name` does. Missing it here was a silent wrong answer: two inlined callbacks in
        // one frame both kept the source name `v`, the first fixed its slot's LLVM type,
        // and the second read a string ptr back as a double.
        case "ForOfStmt": acc = acc.add(s.name); if (s.name2) acc = acc.add(s.name2); acc = this.collectBoundNames(s.body, acc); break;
        case "ForInStmt": acc = acc.add(s.name); acc = this.collectBoundNames(s.body, acc); break;
        case "SwitchStmt": for (const c of s.cases) acc = this.collectBoundNames(c.body, acc); break;
        case "BlockStmt": acc = this.collectBoundNames(s.body, acc); break;
        case "MultiStmt": acc = this.collectBoundNames(s.stmts, acc); break;
        // A nested `function f()` binds `f` in the arrow's scope exactly as a `let` does.
        // Unreachable as a miscompile today only because any REFERENCE to a nested function
        // is NT1003 ("function values / unknown callee") — the declaration itself compiles
        // fine, so the binding is already in the tree. Missing it here is the same shape as
        // the `name2` bug: two inlined callbacks in one frame would both keep the source
        // name `f`. It also feeds `childRenameMap`, where the omission is a SHADOWING miss —
        // an inner `function f` would not mask an outer `f`, so the inner body's references
        // would be rewritten to the outer's fresh name. Collected here for the same reason
        // `BlockDrops` is renamed in `subStmt`: it costs nothing and stops this being a live
        // miscompile the day nested functions become callable.
        case "FuncDecl": acc = acc.add(s.name); break;
        case "TryStmt":
          if (s.param) acc = acc.add(s.param);
          acc = this.collectBoundNames(s.block, acc);
          if (s.handler) acc = this.collectBoundNames(s.handler, acc);
          if (s.finalizer) acc = this.collectBoundNames(s.finalizer, acc); break;
        default: break;
      }
    }
    return acc;
  }

  /** Alpha-rename an inlined HOF callback's OWN bound names (params + block-body locals) to
   *  frame-unique names, rewriting every reference. HOF callbacks are inlined into the
   *  enclosing function's single flat frame, where locals are keyed by source name; two
   *  sibling callbacks that reuse a name — e.g. two `.reduce((acc, x) => …)` with `acc` a
   *  number in one and a string in the other — would otherwise collide, and `addLocal`'s
   *  "already declared" guard keeps the FIRST type, so the second reads its value at the
   *  wrong LLVM type (a string ptr as a double → garbage). A per-inlining suffix gives each
   *  its own correctly-typed slot. The suffix contains a `.` (illegal in a source identifier)
   *  so it can never collide with a real variable. Scope-aware: a NESTED arrow/function that
   *  re-binds a name shadows it (its subtree keeps the inner binding). Mutates in place — each
   *  source arrow is inlined exactly once. Enclosing captures (names it does NOT bind) are
   *  left untouched, so they still resolve to the enclosing frame. */
  private freshenHofArrow(arrow: Extract<Expr, { kind: "ArrowFunction" }>): void {
    const suffix = `.h${this.hofSeq++}`;
    let bound = new Set<string>();
    for (const p of arrow.params) bound = bound.add(p.name);
    if (!arrow.exprBody) bound = this.collectBoundNames(arrow.stmts as Stmt[], bound);
    if (bound.size === 0) return;
    let map = new Map<string, string>();
    for (const n of bound) map = map.set(n, n + suffix);
    for (const p of arrow.params) { if (p.default) this.subExpr(p.default, map); p.name = map.get(p.name)!; }
    if (arrow.exprBody) this.subExpr(arrow.body as Expr, map);
    else this.subStmts(arrow.stmts as Stmt[], map);
  }

  /** The names a nested arrow/function binds — remove from the active rename map for its
   *  subtree so an inner re-binding (shadow) isn't rewritten to the outer's fresh name. */
  private childRenameMap(params: { name: string }[], stmts: Stmt[] | undefined, map: Map<string, string>): Map<string, string> {
    let shadow = new Set<string>();
    for (const p of params) shadow = shadow.add(p.name);
    // An EXPRESSION body binds nothing beyond the parameters, so `stmts` is absent and
    // there is nothing to collect — which is what `exprBody` used to be passed in to say.
    if (stmts !== undefined) shadow = this.collectBoundNames(stmts, shadow);
    // Copy the keys that SURVIVE rather than copy-then-`.delete`. `.delete` cannot be
    // threaded the way `.set`/`.add` are: under bun it returns a BOOLEAN, so
    // `child = child.delete(n)` would type-check under nativets' persistent Map and put
    // `true` in `child` when this same file runs under bun. Filtering is the one spelling
    // that means the same thing in both.
    let child = new Map<string, string>();
    for (const [k, v] of map) if (!shadow.has(k)) child = child.set(k, v);
    return child;
  }

  private subStmts(stmts: Stmt[], map: Map<string, string>): void {
    for (const s of stmts) this.subStmt(s, map);
  }

  private subStmt(s: Stmt, map: Map<string, string>): void {
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) { if (d.init) this.subExpr(d.init, map); if (map.has(d.name)) d.name = map.get(d.name)!; } break;
      case "ReturnStmt": if (s.argument) this.subExpr(s.argument, map); break;
      case "IfStmt": this.subExpr(s.test, map); this.subStmts(s.consequent, map); if (s.alternate) this.subStmts(s.alternate, map); break;
      case "WhileStmt": this.subExpr(s.test, map); this.subStmts(s.body, map); break;
      case "DoWhileStmt": this.subStmts(s.body, map); this.subExpr(s.test, map); break;
      case "ForStmt":
        if (s.init) { if ((s.init as VarDecl).kind === "VarDecl") this.subStmt(s.init as VarDecl, map); else this.subExpr(s.init as Expr, map); }
        if (s.test) this.subExpr(s.test, map);
        if (s.update) this.subExpr(s.update, map);
        this.subStmts(s.body, map); break;
      case "ForOfStmt":
        this.subExpr(s.iterable, map);
        if (map.has(s.name)) s.name = map.get(s.name)!;
        // The value half of `for (const [k, v] of map)` — renamed with the key half, or the
        // two inlinings collide on `v` (see collectBoundNames).
        if (s.name2 && map.has(s.name2)) s.name2 = map.get(s.name2)!;
        this.subStmts(s.body, map); break;
      case "ForInStmt": this.subExpr(s.object, map); if (map.has(s.name)) s.name = map.get(s.name)!; this.subStmts(s.body, map); break;
      case "SwitchStmt": this.subExpr(s.discriminant, map); for (const c of s.cases) { if (c.test) this.subExpr(c.test, map); this.subStmts(c.body, map); } break;
      case "ThrowStmt": this.subExpr(s.argument, map); break;
      case "TryStmt":
        this.subStmts(s.block, map);
        if (s.handler) this.subStmts(s.handler, map);
        if (s.param && map.has(s.param)) s.param = map.get(s.param)!;
        if (s.finalizer) this.subStmts(s.finalizer, map); break;
      case "ExprStmt": this.subExpr(s.expr, map); break;
      case "BlockStmt": this.subStmts(s.body, map); break;
      case "MultiStmt": this.subStmts(s.stmts, map); break;
      case "FuncDecl": {
        const child = this.childRenameMap(s.params, s.body, map);
        for (const p of s.params) if (p.default) this.subExpr(p.default, child);
        this.subStmts(s.body, child); break;
      }
      // A drop set names LOCALS, so it has to be renamed with them. Unreachable today —
      // ownership walks an arrow body with `seq`, not `scoped`, so no marker is placed
      // inside one — but the silent `default` below would have kept the pre-rename names
      // and made `emitDrops` load an `%x.addr` that no longer exists. Renaming here costs
      // nothing and stops that being a live miscompile the day arrow-body locals become
      // linear-tracked.
      case "BlockDrops": s.names = s.names.map((n) => map.get(n) ?? n); break;
      default: break; // BreakStmt / ContinueStmt
    }
  }

  private subExpr(e: Expr, map: Map<string, string>): void {
    switch (e.kind) {
      case "Identifier": if (map.has(e.name)) e.name = map.get(e.name)!; return;
      case "UpdateExpr":
        if (e.targetExpr) { this.subExpr(e.targetExpr, map); return; }
        if (map.has(e.target)) e.target = map.get(e.target)!;
        return;
      case "AssignExpr": this.subExpr(e.value, map); if (map.has(e.target)) e.target = map.get(e.target)!; return;
      case "TemplateLiteral": for (const x of e.exprs) this.subExpr(x, map); return;
      case "ArrayLiteral": for (const x of e.elements) this.subExpr(x, map); return;
      case "ObjectLiteral": for (const p of e.properties) this.subExpr(p.value, map); return;
      case "SpreadExpr": this.subExpr(e.argument, map); return;
      case "MemberExpr": this.subExpr(e.object, map); return;
      case "IndexExpr": this.subExpr(e.object, map); this.subExpr(e.index, map); return;
      case "UnaryExpr": this.subExpr(e.operand, map); return;
      case "BinaryExpr": this.subExpr(e.left, map); this.subExpr(e.right, map); return;
      case "LogicalExpr": this.subExpr(e.left, map); this.subExpr(e.right, map); return;
      case "SequenceExpr": for (const x of e.exprs) this.subExpr(x, map); return;
      case "ConditionalExpr": this.subExpr(e.test, map); this.subExpr(e.consequent, map); this.subExpr(e.alternate, map); return;
      case "FieldAssign": this.subExpr(e.object, map); this.subExpr(e.value, map); return;
      case "IndexAssign": this.subExpr(e.object, map); this.subExpr(e.index, map); this.subExpr(e.value, map); return;
      case "TypeofExpr": this.subExpr(e.operand, map); return;
      case "CallExpr": this.subExpr(e.callee, map); for (const a of e.args) this.subExpr(a, map); return;
      case "NewExpr": for (const a of e.args) this.subExpr(a, map); return;
      case "AsExpr": case "SatisfiesExpr": this.subExpr(e.expr, map); return;
      case "NonNullExpr": this.subExpr(e.expr, map); return;
      case "InstanceOfExpr": this.subExpr(e.object, map); return;
      case "InExpr": this.subExpr(e.key, map); this.subExpr(e.object, map); return;
      case "ArrowFunction": {
        const child = this.childRenameMap(e.params, e.stmts, map);
        for (const p of e.params) if (p.default) this.subExpr(p.default, child);
        if (e.exprBody) this.subExpr(e.body as Expr, child);
        else this.subStmts(e.stmts as Stmt[], child);
        return;
      }
      default: return; // literals
    }
  }

  /** Allocate a block-body callback's own locals before the loop, null-initializing
   *  its string locals (mirrors emitStrInit for the frame) so a 0-iteration loop or a
   *  conditional bind releases null (a no-op), never garbage. Expression bodies have
   *  no locals beyond the param. */
  private prepHofLocals(arrow: Extract<Expr, { kind: "ArrowFunction" }>): void {
    if (arrow.exprBody) return;
    const before = new Set(this.strLocals);
    this.collectLocals(arrow.stmts as Stmt[]);
    for (const n of this.strLocals) if (!before.has(n)) this.emit(`store ptr null, ptr ${this.addr(n)}`);
  }

  /** Emit an inlined HOF callback body and yield its result Val (type `retTy`). An
   *  expression body evaluates directly; a BLOCK body runs its statements — a `return`
   *  inside stores to a result slot (via hofReturnStack) and branches to the join. */
  private genHofBody(arrow: Extract<Expr, { kind: "ArrowFunction" }>, retTy: Ty): Val {
    if (arrow.exprBody) return this.genExpr(arrow.body as Expr);
    const slot = this.slot(retTy);
    const done = this.label("hofr");
    this.hofReturnStack.push({ slot, done, ty: retTy });
    this.genStmts(arrow.stmts as Stmt[]);
    this.hofReturnStack.pop();
    if (!this.isTerminated()) this.terminate(`br label %${done}`); // fall-through (no return hit)
    this.to(this.block(done));
    const v = this.fresh();
    this.emit(`${v} = load ${llvmTy(retTy)}, ptr ${slot}`);
    return { v, ty: retTy };
  }

  /**
   * forEach — `genMap`'s loop with NO output array and the callback result DISCARDED.
   *
   * Every other step is map's, and deliberately so: `freshenHofArrow` gives this
   * inlining its own slots, `prepHofLocals` null-initializes the block body's string
   * locals before the loop, and the ownership pass computes this body's drops exactly as
   * it does map's. An inlined body is a scope — a local the body allocates is freed per
   * iteration, and a value it merely captures is not.
   *
   * The one difference from map is the body: nothing is pushed anywhere, and a `return`
   * means "next element" rather than "here is this element's result".
   */
  private genForEach(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, locp: string): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    const ip = this.hofIndexParam(arrow, 1);
    this.prepHofLocals(arrow);
    const L = this.hofLoop(recv, "each", this.hofLen(recv)); // no output array to build
    this.hofElem(recv, L.idx, el, p, ip, ".forEach", locp);
    if (arrow.exprBody) {
      this.genExpr(arrow.body as Expr); // evaluated for effect, exactly as an ExprStmt is
    } else {
      const done = this.label("eachr");
      this.hofReturnStack.push({ slot: "", done, ty: "void", discard: true });
      this.genStmts(arrow.stmts as Stmt[]);
      this.hofReturnStack.pop();
      if (!this.isTerminated()) this.terminate(`br label %${done}`); // fall-through (no return hit)
      this.to(this.block(done));
    }
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: "", ty: "void" }; // node: `.forEach` returns undefined
  }

  private genMap(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, locp: string): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const R = this.hofRetTy(arrow);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    const ip = this.hofIndexParam(arrow, 1);
    this.prepHofLocals(arrow);
    const len = this.hofLen(recv);
    const out = this.fresh();
    this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); // pre-sized: one element per input
    const L = this.hofLoop(recv, "map", len);
    this.hofElem(recv, L.idx, el, p, ip, ".map", locp);
    const rv = this.genHofBody(arrow, R);
    this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot(rv)})`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: makeArrayTy(R) };
  }

  /** flatMap — map's loop, but each callback result (an array) is CONCATENATED
   *  into the output instead of pushed, i.e. exactly one level of flattening. */
  private genFlatMap(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, locp: string): Val {
    this.freshenHofArrow(arrow);
    const el = elemTy(recv.ty);
    const R = this.hofRetTy(arrow); // an array type (checker-enforced)
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    const ip = this.hofIndexParam(arrow, 1);
    this.prepHofLocals(arrow);
    const len = this.hofLen(recv);
    const out = this.fresh();
    this.emit(`${out} = call ptr @nt_arr_new(double 1.0)`); // flattened length is not known here
    const L = this.hofLoop(recv, "fmap", len);
    this.hofElem(recv, L.idx, el, p, ip, ".flatMap", locp);
    const rv = this.genHofBody(arrow, R);
    this.emit(`call void @nt_arr_extend(ptr ${out}, ptr ${rv.v})`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: R };
  }

  private genFilter(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, locp: string): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    const ip = this.hofIndexParam(arrow, 1);
    this.prepHofLocals(arrow);
    const len = this.hofLen(recv);
    const out = this.fresh();
    this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); // pre-sized: at most one per input
    const L = this.hofLoop(recv, "flt", len);
    const pv = this.hofElem(recv, L.idx, el, p, ip, ".filter", locp);
    const keep = this.genHofBody(arrow, "boolean"); // boolean
    const pushLbl = this.label("fltp");
    const skipLbl = this.label("flts");
    this.terminate(`br i1 ${keep.v}, label %${pushLbl}, label %${skipLbl}`);
    this.to(this.block(pushLbl));
    this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot({ v: pv, ty: el })})`);
    this.terminate(`br label %${skipLbl}`);
    this.to(this.block(skipLbl));
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: makeArrayTy(el) };
  }

  /** some/every/find/findIndex/findLast/findLastIndex — ONE inlined predicate loop.
   *  Forward with early exit for some/every/find/findIndex (node's iteration order);
   *  `findLast`/`findLastIndex` iterate BACKWARDS, also node's order, so a callback
   *  with side effects still observes the same sequence. The hit index lives in a
   *  slot; `.find*` then boxes it as `T | undefined`. */
  private genSearchHof(method: string, recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, locp: string): Val {
    this.freshenHofArrow(arrow);
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    const backwards = method === "findLast" || method === "findLastIndex";
    this.addLocal(p, el);
    const ip = this.hofIndexParam(arrow, 1);
    this.prepHofLocals(arrow);

    const src = recv.v;
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${src})`);
    const hit = this.slot("number"); // index of the first (last) match, -1 = none
    this.emit(`store double 0xBFF0000000000000, ptr ${hit}`); // -1
    // THE ELEMENT THE MATCH SAW, kept rather than re-read after the loop.
    //
    // `.find`/`.findLast` used to produce their result with a second `src[hit]` read down
    // at the `end` block. That read is not the one the predicate was shown: the MATCHING
    // callback can shrink the array after being handed its element, and then `hit` points
    // past the new end and `nt_arr_get` answered 0 —
    //   `a.find((x, i) => { const m = i === 3; if (m) { a.pop(); a.pop(); } return m; })`
    //   gave `0` where node gives `4`, exit 0 both ways.
    // Unlike the loop read above, this one does NOT want a panic: node returns `kValue`,
    // which it read before the shrink, so the right answer is in hand and matching node
    // costs one store on the match path. Zero-initialised because that is exactly what
    // the old miss path read out of `nt_arr_get`, and the `miss` flag masks it either way.
    const wantElem = method === "find" || method === "findLast";
    const hitv = wantElem ? this.rawSlot() : "";
    if (wantElem) this.emit(`store i64 0, ptr ${hitv}`);
    const idx = this.slot("number");
    if (backwards) { const st = this.fresh(); this.emit(`${st} = fsub double ${len}, 1.0`); this.emit(`store double ${st}, ptr ${idx}`); }
    else this.emit(`store double 0x0000000000000000, ptr ${idx}`);

    const cond = this.label("srch"), body = this.label("srchb"), upd = this.label("srchu"), end = this.label("srche");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh();
    this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh();
    this.emit(`${cmp} = fcmp ${backwards ? "oge" : "olt"} double ${iC}, ${backwards ? "0x0000000000000000" : len}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);

    this.to(this.block(body));
    const iB = this.fresh();
    this.emit(`${iB} = load double, ptr ${idx}`);
    const slot = this.fresh();
    // Bounds-PANICKING, for the reason `hofElem` is: `len` above is a SNAPSHOT taken
    // before the first callback ran, so a callback that shrinks the receiver walks past
    // the end and `nt_arr_get` answered 0 there. It bites harder here than in `.map`,
    // because the phantom is handed to a PREDICATE rather than copied into an output
    // array — `[1,2,3,4].some((x, i) => { …pop twice…; return x === 0; })` answered
    // `true` where node answers `false`, exit 0 both ways. (This loop does not go through
    // `hofElem`: it counts DOWN for `.findLast`/`.findLastIndex`, so it keeps its own.)
    this.emit(`${slot} = call i64 @nt_arr_hof_at(ptr ${src}, double ${iB}, ptr ${this.mod.intern(`.${method}`)}, ptr ${locp})`);
    this.emit(`store ${llvmTy(el)} ${this.fromSlot(slot, el)}, ptr %${p}.addr`);
    // The index parameter — this loop's OWN counter, which for `.findLast`/`.findLastIndex`
    // starts at `len - 1` and counts DOWN. node passes the real position either way, so
    // reusing `idx` (rather than a separate forward count) is what makes the backwards
    // arms node-exact instead of merely non-crashing.
    if (ip !== "") this.emit(`store double ${iB}, ptr ${this.addr(ip)}`);
    const keep = this.genHofBody(arrow, "boolean");
    // `.every` short-circuits on the FIRST FALSE; everything else on the first true.
    const stop = this.label("srchs"), go = this.label("srchg");
    const take = this.fresh();
    if (method === "every") this.emit(`${take} = xor i1 ${keep.v}, true`);
    else this.emit(`${take} = or i1 ${keep.v}, false`);
    this.terminate(`br i1 ${take}, label %${stop}, label %${go}`);
    this.to(this.block(stop));
    const iH = this.fresh();
    this.emit(`${iH} = load double, ptr ${idx}`);
    this.emit(`store double ${iH}, ptr ${hit}`);
    if (wantElem) this.emit(`store i64 ${slot}, ptr ${hitv}`); // the value the predicate saw
    this.terminate(`br label %${end}`);

    this.to(this.block(go));
    const iU = this.fresh();
    this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh();
    this.emit(`${iN} = ${backwards ? "fsub" : "fadd"} double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    this.terminate(`br label %${cond}`);

    this.to(this.block(end));
    const h = this.fresh();
    this.emit(`${h} = load double, ptr ${hit}`);
    const found = this.fresh();
    this.emit(`${found} = fcmp oge double ${h}, 0x0000000000000000`);
    if (method === "some") return { v: found, ty: "boolean" };
    if (method === "every") { const t = this.fresh(); this.emit(`${t} = xor i1 ${found}, true`); return { v: t, ty: "boolean" }; }
    if (method === "findIndex" || method === "findLastIndex") return { v: h, ty: "number" };
    const es = this.fresh();
    this.emit(`${es} = load i64, ptr ${hitv}`);
    const miss = this.fresh();
    this.emit(`${miss} = xor i1 ${found}, true`);
    // A NULLABLE element is ALREADY a `[tag, value]` box, so boxing it again would build
    // a box holding a box while the static type (`el`, one level) described one. Reading
    // a field off the result then loaded the inner box's TAG and bitcast it to a double:
    //     node `r 7 14`   nativets `r 1e-323 2.1326037835e-314`   exit 0 on BOTH sides.
    // Hand the element's own box back instead — allocation-free, and node cannot tell
    // "found `undefined`" from "found nothing" anyway, so one arm is all the answer has.
    // Optional chaining reached the identical conclusion at `genOptionalChain` ("keep it
    // if the final field type is itself nullable"); this is that rule, one method over.
    if (isNullableTy(el)) {
      const ep = this.fromSlot(es, el);
      const sel = this.fresh();
      // A `select` and not a branch: both arms are already materialised, and the miss box
      // is a constant-shaped allocation whose cost is a miss the loop already paid for.
      this.emit(`${sel} = select i1 ${miss}, ptr ${this.nullBox("0", "0")}, ptr ${ep}`);
      return { v: sel, ty: el };
    }
    return { v: this.nullBox(this.nullTagIf(miss), es), ty: makeNullable("undefined", el) };
  }

  private genReduce(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, initExpr: Expr, locp: string): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const accName = arrow.params[0]!.name;
    const xName = arrow.params[1]!.name;
    const init = this.genExpr(initExpr);
    const A = init.ty;
    this.addLocal(accName, A);
    this.addLocal(xName, el);
    const ip = this.hofIndexParam(arrow, 2); // `(acc, elem, index)` — index is param TWO here
    this.emit(`store ${llvmTy(A)} ${init.v}, ptr ${this.addr(accName)}`); // pre-loop init
    this.prepHofLocals(arrow);
    const L = this.hofLoop(recv, "red", this.hofLen(recv));
    this.hofElem(recv, L.idx, el, xName, ip, ".reduce", locp);
    const rv = this.genHofBody(arrow, A);
    this.emit(`store ${llvmTy(A)} ${rv.v}, ptr ${this.addr(accName)}`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    const t = this.fresh();
    this.emit(`${t} = load ${llvmTy(A)}, ptr ${this.addr(accName)}`);
    return { v: t, ty: A };
  }

  /**
   * The indent unit for JSON.stringify(value, null, space) from the literal 3rd arg.
   * "" means compact (1-arg, byte-identical) output. Mirrors node: a number is
   * ToInteger'd, clamped to [0,10] spaces; a string is truncated to 10 chars.
   */
  private jsonIndentUnit(space: Expr | undefined): string {
    if (!space) return "";
    if (space.kind === "NumberLiteral") {
      const n = Math.max(0, Math.min(10, Math.trunc(space.value)));
      return " ".repeat(n);
    }
    if (space.kind === "StringLiteral") return space.value.slice(0, 10);
    return "";
  }

  /**
   * JSON.stringify — generated recursively from the static type.
   * `indent` is the (compile-time) indent unit ("" = compact); `depth` the current
   * nesting level, so a pretty-printed line is prefixed with indent.repeat(depth).
   */
  private genJsonStringify(val: Val, indent = "", depth = 0): Val {
    const ty = val.ty;
    // TERMINATION, stated rather than inherited. The serializer is UNROLLED at compile time
    // from the static type, so it terminates only because the type shrinks at every step —
    // and a recursive type is exactly the one that does not. Today a bare `@N` falls through
    // to the exhaustive `internalError` at the bottom, and the checker refuses it (NT1005)
    // before that; both are true and neither says so, which is the shape of a guarantee that
    // quietly stops holding. So the back-edge is refused HERE, by name — a BARE `@N`, since
    // the serializer decomposes fields and elements itself and a nested reference arrives on
    // its own step.
    if (isTypeRefTy(ty)) {
      throw internalError(`JSON.stringify of the recursive type ${ty} reached codegen — the serializer is unrolled from the static type and a back-edge does not shrink, so it has no base case. This must be refused in the checker (checkJsonStringifyArg)`);
    }
    // And a ceiling, because the argument above is about the types that exist TODAY. A
    // static type nests a handful of levels deep; 64 is far past anything a program writes
    // and far short of a stack overflow, so an unrolling that runs away announces itself
    // instead of taking the process out.
    if (depth > 64) {
      throw internalError(`JSON.stringify unrolled past 64 levels on ${ty} — the generated serializer is not terminating`);
    }
    // `nt_json_num`, not `js_num_to_str`: JSON has no non-finite number, so node
    // writes `null` for NaN/±Infinity where `String(x)` writes the token.
    if (ty === "number") { const t = this.fresh(); this.emit(`${t} = call ptr @nt_json_num(double ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "boolean") {
      const z = this.fresh(); this.emit(`${z} = zext i1 ${val.v} to i32`);
      const t = this.fresh(); this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
      return { v: t, ty: "string" };
    }
    if (ty === "string") { const t = this.fresh(); this.emit(`${t} = call ptr @js_json_quote(ptr ${val.v})`); return { v: t, ty: "string" }; }
    // stdlib Batch 3: node serializes a Date through `Date.prototype.toJSON`, i.e.
    // the QUOTED ISO string — and `null` for a non-finite time value (toJSON checks
    // the time value first, so an Invalid Date serializes rather than throwing).
    if (isDateTy(ty)) { const t = this.fresh(); this.emit(`${t} = call ptr @nt_date_to_json(double ${val.v})`); return { v: t, ty: "string" }; }
    // A nullable BOX: `null` for either nullish arm, otherwise the value it carries.
    // (An absent UNDEFINED arm is not `null` in node — at the root it is the undefined
    // VALUE and in an object the key is dropped — so those two shapes are refused by
    // the checker rather than rendered here. See `refuseNullableStringify`.)
    if (isNullableTy(ty)) return this.genJsonNullable(val.v, baseTy(ty), indent, depth);
    if (isArrayTy(ty)) return this.genJsonArray(val, indent, depth);
    if (isObjectTy(ty)) return this.genJsonObject(val, indent, depth);
    // The `null` VALUE is the one literal `null` node actually writes here. It used
    // to arrive by accident, through the fall-through this replaces.
    if (ty === "null") return { v: this.mod.intern("null"), ty: "string" };
    // A Map/Set has no own ENUMERABLE property — its contents live in internal slots
    // `JSON.stringify` never walks — so node serializes EVERY one of them as `{}`.
    // Constant, and exact for any contents, so it is emitted rather than refused.
    if (isMapTy(ty) || isSetTy(ty)) return { v: this.mod.intern("{}"), ty: "string" };
    // A typed array's own enumerable properties ARE its indices, so node writes an
    // index-keyed object: `{"0":1,"1":255}`, not `[1,255]`.
    if (isBytesTy(ty)) {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_bytes_json(ptr ${val.v}, ptr ${this.mod.intern(indent)}, double ${llvmDouble(depth)})`);
      return { v: t, ty: "string" };
    }
    // NOT a default. This used to `return this.mod.intern("null")`, which quietly
    // absorbed every type nobody had written a rule for — six were already wrong
    // against node (Map, Set, Uint8Array, a function, a Dyn, and `undefined`), and
    // a nested one looked right because it sat inside a correct object. The
    // checker's `checkJsonStringifyArg` walks this same shape first and refuses
    // anything with no node-exact rendering, so reaching here is a broken invariant
    // between the two — and the next box type is a loud error, not a wrong answer.
    throw internalError(`no JSON.stringify rule for ${ty}, which checkJsonStringifyArg admitted — add one rather than defaulting`);
  }

  /** JSON for a nullable box: nullish -> `null`, present -> the base value's JSON. */
  private genJsonNullable(ptr: string, base: Ty, indent: string, depth: number): Val {
    const slot = this.slot("string");
    const present = this.fresh();
    this.emit(`${present} = icmp eq i64 ${this.nullTag(ptr)}, 2`);
    const pLbl = this.label("jnp"), aLbl = this.label("jna"), end = this.label("jne");
    this.terminate(`br i1 ${present}, label %${pLbl}, label %${aLbl}`);
    this.to(this.block(pLbl));
    const inner = this.genJsonStringify({ v: this.fromSlot(this.nullVal(ptr), base), ty: base }, indent, depth);
    this.emit(`store ptr ${inner.v}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(aLbl));
    this.emit(`store ptr ${this.mod.intern("null")}, ptr ${slot}`);
    this.terminate(`br label %${end}`);
    this.to(this.block(end));
    const t = this.fresh();
    this.emit(`${t} = load ptr, ptr ${slot}`);
    return { v: t, ty: "string" };
  }

  /**
   * JSON for an object. A field typed `T | undefined` is OMITTED when absent — node
   * drops the key rather than writing `null` — so both the key and its SEPARATOR are
   * runtime decisions, and the comma has to close up behind a dropped field. That is
   * what the `emitted` flag is for: it says whether anything has been written yet, so
   * the first surviving field takes no comma wherever it lands. A field with no
   * undefined arm keeps the old compile-time path.
   */
  private genJsonObject(val: Val, indent = "", depth = 0): Val {
    // A FUNCTION-typed field is dropped, exactly as node drops one: `JSON.stringify`
    // maps a function to `undefined`, and an object's undefined-valued key is
    // omitted. Unlike a `T | undefined` field this is a COMPILE-TIME decision — a
    // field's type either IS a function or is not — so it never reaches the runtime
    // `emitted` machinery below, and an object of only function fields is `{}`.
    const fields = objectFields(val.ty).filter((f) => !isFuncTy(f.ty));
    const pretty = indent !== "";
    // node prints an empty object inline as `{}` even with an indent.
    if (fields.length === 0) return { v: this.mod.intern("{}"), ty: "string" };
    const inner = pretty ? indent.repeat(depth + 1) : "";
    const close = pretty ? indent.repeat(depth) : "";
    const optional = (t: Ty) => isNullableTy(t) && nullishKind(t) === "undefined";

    // Fast path: nothing can vanish, so the separators are known at compile time.
    // Kept byte-identical to the pre-omission emission (same order of interned
    // constants) so it does not churn every record's IR snapshot.
    if (!fields.some((f) => optional(f.ty))) {
      let acc = this.mod.intern(pretty ? `{\n${inner}` : "{");
      // `own` tracks whether `acc` is still the interned opening constant (borrowed) or
      // has become a concatenation this frame allocated. It flips on the first concat and
      // never flips back; see `jsonCat`.
      let own = false;
      fields.forEach((f, i) => {
        if (i > 0) { acc = this.jsonCat(acc, own, this.mod.intern(pretty ? `,\n${inner}` : ","), false); own = true; }
        acc = this.jsonCat(acc, own, this.mod.intern(pretty ? `"${f.key}": ` : `"${f.key}":`), false); own = true;
        const fv = this.genJsonStringify(this.loadField(val, f.key, f.ty), indent, depth + 1).v;
        acc = this.jsonCat(acc, own, fv, true); own = true;
      });
      return { v: this.jsonCat(acc, own, this.mod.intern(pretty ? `\n${close}}` : "}"), false), ty: "string" };
    }

    const sep = this.mod.intern(pretty ? `,\n${inner}` : ",");
    const open = this.mod.intern(pretty ? `{\n${inner}` : "{");
    const accSlot = this.slot("string");
    const emittedSlot = this.slot("boolean");
    this.emit(`store ptr ${this.mod.intern("")}, ptr ${accSlot}`);
    this.emit(`store i1 false, ptr ${emittedSlot}`);
    // Append `<sep?>"key":<json>` and record that something was written.
    const writeField = (key: string, jsonV: string): void => {
      const cur = this.fresh(); this.emit(`${cur} = load ptr, ptr ${accSlot}`);
      const had = this.fresh(); this.emit(`${had} = load i1, ptr ${emittedSlot}`);
      const lead = this.fresh();
      this.emit(`${lead} = select i1 ${had}, ptr ${sep}, ptr ${this.mod.intern("")}`);
      // `cur` is the interned `""` on the first write and a concatenation this frame
      // allocated on every later one — a RUNTIME distinction, since a field can vanish.
      // Released unconditionally: the two cases are exactly "owned" and "not in the RC
      // table", and `nt_str_release` is a no-op on the second. `lead` is a select between
      // two interned constants, so it is never owned.
      let a = this.jsonCat(cur, true, lead, false);
      a = this.jsonCat(a, true, this.mod.intern(pretty ? `"${key}": ` : `"${key}":`), false);
      a = this.jsonCat(a, true, jsonV, true);
      this.emit(`store ptr ${a}, ptr ${accSlot}`);
      this.emit(`store i1 true, ptr ${emittedSlot}`);
    };

    for (const f of fields) {
      const fv = this.loadField(val, f.key, f.ty);
      if (!optional(f.ty)) { writeField(f.key, this.genJsonStringify(fv, indent, depth + 1).v); continue; }
      const base = baseTy(f.ty);
      const present = this.fresh();
      this.emit(`${present} = icmp eq i64 ${this.nullTag(fv.v)}, 2`);
      const pLbl = this.label("jop"), end = this.label("joe");
      this.terminate(`br i1 ${present}, label %${pLbl}, label %${end}`);
      this.to(this.block(pLbl));
      // Present: render the BASE value — `{k: undefined}` is the only dropped shape,
      // and this arm is proved present, so there is no nullable left to unwrap.
      writeField(f.key, this.genJsonStringify({ v: this.fromSlot(this.nullVal(fv.v), base), ty: base }, indent, depth + 1).v);
      this.terminate(`br label %${end}`);
      this.to(this.block(end));
    }
    const body = this.fresh(); this.emit(`${body} = load ptr, ptr ${accSlot}`);
    const any = this.fresh(); this.emit(`${any} = load i1, ptr ${emittedSlot}`);
    // Every field vanished ⇒ node prints `{}` — with no newline/indent inside it.
    // (The interned constants are hoisted rather than written inline: a nested template
    // literal carrying an escape, inside another template's interpolation, is outside
    // the subset our OWN lexer accepts, and this file has to parse under both.)
    const bareOpen = this.mod.intern("{");
    const bareClose = this.mod.intern("}");
    const fullClose = this.mod.intern(pretty ? `\n${close}}` : "}");
    const openV = this.fresh();
    this.emit(`${openV} = select i1 ${any}, ptr ${open}, ptr ${bareOpen}`);
    const closeV = this.fresh();
    this.emit(`${closeV} = select i1 ${any}, ptr ${fullClose}, ptr ${bareClose}`);
    // `openV`/`closeV` select between interned constants; `body` is the accumulator, owned
    // whenever any field survived and the interned `""` when none did.
    return { v: this.jsonCat(this.jsonCat(openV, false, body, true), true, closeV, false), ty: "string" };
  }

  /** Load object field `key` (typed `ty`) out of the record `val`. */
  private loadField(val: Val, key: string, ty: Ty): Val {
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr ${val.v}, i64 ${fieldIndex(val.ty, key)}`);
    const slot = this.fresh();
    this.emit(`${slot} = load i64, ptr ${gep}`);
    return { v: this.fromSlot(slot, ty), ty };
  }

  private genJsonArray(val: Val, indent = "", depth = 0): Val {
    const el = elemTy(val.ty);
    const pretty = indent !== "";
    const accSlot = this.slot("string");
    this.emit(`store ptr ${this.mod.intern("[")}, ptr ${accSlot}`);
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${val.v})`);
    // Pretty-print prefixes (compile-time known): each element is on its own line
    // at depth+1; the closing `]` sits at the parent's depth.
    const inner = pretty ? indent.repeat(depth + 1) : "";
    const close = pretty ? indent.repeat(depth) : "";
    const cond = this.label("js"), body = this.label("jsb"), upd = this.label("jsu"), end = this.label("jse");
    const comma = this.label("jsc"), firstL = this.label("jsf"), after = this.label("jsa");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${len}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
    const first = this.fresh(); this.emit(`${first} = fcmp oeq double ${iB}, 0.0`);
    this.terminate(`br i1 ${first}, label %${firstL}, label %${comma}`);
    // First element: pretty prints a leading newline + indent before it.
    this.to(this.block(firstL));
    // Every accumulator load below is released once the next concatenation has copied it:
    // owned on all but the first iteration, and the interned `[` on that one, which
    // `nt_str_release` ignores. Without this the loop leaked one string per ELEMENT.
    if (pretty) {
      const af0 = this.fresh(); this.emit(`${af0} = load ptr, ptr ${accSlot}`);
      this.emit(`store ptr ${this.jsonCat(af0, true, this.mod.intern(`\n${inner}`), false)}, ptr ${accSlot}`);
    }
    this.terminate(`br label %${after}`);
    // Subsequent elements: separator (compact `,` or pretty `,\n<indent>`).
    this.to(this.block(comma));
    const a1 = this.fresh(); this.emit(`${a1} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.jsonCat(a1, true, this.mod.intern(pretty ? `,\n${inner}` : ","), false)}, ptr ${accSlot}`);
    this.terminate(`br label %${after}`);
    this.to(this.block(after));
    const iB2 = this.fresh(); this.emit(`${iB2} = load double, ptr ${idx}`);
    const slot = this.fresh(); this.emit(`${slot} = call i64 @nt_arr_get(ptr ${val.v}, double ${iB2})`);
    const es = this.genJsonStringify({ v: this.fromSlot(slot, el), ty: el }, indent, depth + 1);
    const a3 = this.fresh(); this.emit(`${a3} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.jsonCat(a3, true, es.v, true)}, ptr ${accSlot}`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    if (!pretty) {
      const af = this.fresh(); this.emit(`${af} = load ptr, ptr ${accSlot}`);
      return { v: this.jsonCat(af, true, this.mod.intern("]"), false), ty: "string" };
    }
    // Pretty close: an empty array stays inline `[]`; a non-empty one gets `\n<close>]`.
    const emptyL = this.label("jsE"), neL = this.label("jsN"), joinL = this.label("jsJ");
    const isEmpty = this.fresh(); this.emit(`${isEmpty} = fcmp oeq double ${len}, 0.0`);
    this.terminate(`br i1 ${isEmpty}, label %${emptyL}, label %${neL}`);
    this.to(this.block(emptyL));
    const ae = this.fresh(); this.emit(`${ae} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.jsonCat(ae, true, this.mod.intern("]"), false)}, ptr ${accSlot}`);
    this.terminate(`br label %${joinL}`);
    this.to(this.block(neL));
    const an = this.fresh(); this.emit(`${an} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.jsonCat(an, true, this.mod.intern(`\n${close}]`), false)}, ptr ${accSlot}`);
    this.terminate(`br label %${joinL}`);
    this.to(this.block(joinL));
    const afj = this.fresh(); this.emit(`${afj} = load ptr, ptr ${accSlot}`);
    return { v: afj, ty: "string" };
  }

  /**
   * HTTP client builtin (httpGet/httpPost) → a `{status:number,body:string}` object.
   * The status out-param is the object's status slot itself (no alloca — loop-safe: the
   * chat REPL calls httpPost every turn), which the runtime fills with the numeric status
   * as raw double bits (== toSlot(number)); the body string is stored (retained) in slot 1.
   */
  private genHttp(fn: string, args: Expr[], hasBody: boolean): Val {
    const url = this.genExpr(args[0]!).v;
    const headers = this.genExpr(args[1]!).v;
    const body = hasBody ? this.genExpr(args[2]!).v : null;
    const ty: Ty = "{status:number,body:string}";
    const obj = this.fresh();
    this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(2)})`);
    const gStatus = this.fresh();
    this.emit(`${gStatus} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, "status")}`);
    const resp = this.fresh();
    const call = hasBody
      ? `${resp} = call ptr @${fn}(ptr ${url}, ptr ${headers}, ptr ${body}, ptr ${gStatus})`
      : `${resp} = call ptr @${fn}(ptr ${url}, ptr ${headers}, ptr ${gStatus})`;
    this.emit(call); // writes *status_out into the status slot as a double
    const gBody = this.fresh();
    this.emit(`${gBody} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, "body")}`);
    this.emit(`store i64 ${this.toSlot({ v: resp, ty: "string" })}, ptr ${gBody}`);
    return { v: obj, ty };
  }

  /**
   * `fetch(url, init?)` → a `Response` handle: a 3-slot heap block
   * `[status(double bits), body(ptr), rawHeaders(ptr)]`. The status and raw-header
   * slots are passed to the runtime AS the out-pointers (no alloca — loop-safe, the
   * same trick genHttp uses), and the returned body is stored into slot 1.
   *
   * The request line comes from the STATIC shape of `init`: `method` (default "GET"),
   * `body` (default ""), and `headers` — an object whose keys are known at compile
   * time, so the wire header block is unrolled into `k: v\n` concatenations.
   *
   * The call BLOCKS. A transport failure raises through the pending-exception
   * protocol, so the emitted `emitExcCheck` routes it to the nearest catch — matching
   * node's fetch rejecting.
   */
  private genFetch(args: Expr[]): Val {
    const url = this.genExpr(args[0]!).v;
    let method: string = this.mod.intern("GET");
    let body: string = this.mod.intern("");
    let headers: string = this.mod.intern("");
    if (args[1]) {
      const init = this.genExpr(args[1]!);
      const field = (key: string): string | null => {
        const ft = fieldType(init.ty, key);
        if (!ft) return null;
        const gep = this.fresh();
        this.emit(`${gep} = getelementptr i64, ptr ${init.v}, i64 ${fieldIndex(init.ty, key)}`);
        const slot = this.fresh();
        this.emit(`${slot} = load i64, ptr ${gep}`);
        return this.fromSlot(slot, ft);
      };
      method = field("method") ?? method;
      body = field("body") ?? body;
      const hdrTy = fieldType(init.ty, "headers");
      const hdrObj = hdrTy ? field("headers") : null;
      if (hdrObj && hdrTy) {
        // Build the newline-joined "Name: Value" block the curl layer expects.
        let acc = this.mod.intern("");
        for (const f of objectFields(hdrTy)) {
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${hdrObj}, i64 ${fieldIndex(hdrTy, f.key)}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          const v = this.fromSlot(slot, "string");
          acc = this.concat(this.concat(acc, this.mod.intern(`${f.key}: `)), v);
          acc = this.concat(acc, this.mod.intern("\n"));
        }
        headers = acc;
      }
    }
    const resp = this.fresh();
    this.emit(`${resp} = call ptr @nt_obj_new(double ${llvmDouble(3)})`);
    const gStatus = this.fresh();
    this.emit(`${gStatus} = getelementptr i64, ptr ${resp}, i64 0`);
    const gHeaders = this.fresh();
    this.emit(`${gHeaders} = getelementptr i64, ptr ${resp}, i64 2`);
    const bodyStr = this.fresh();
    this.emit(`${bodyStr} = call ptr @nt_fetch(ptr ${url}, ptr ${method}, ptr ${headers}, ptr ${body}, ptr ${gStatus}, ptr ${gHeaders})`);
    const gBody = this.fresh();
    this.emit(`${gBody} = getelementptr i64, ptr ${resp}, i64 1`);
    this.emit(`store i64 ${this.toSlot({ v: bodyStr, ty: "string" })}, ptr ${gBody}`);
    this.emitExcCheck(); // a network/DNS failure rejects like node's fetch
    return { v: resp, ty: "Response" };
  }

  /** Load one slot of a Response block (0 status, 1 body, 2 raw headers). */
  private responseSlot(resp: string, idx: number, ty: Ty): Val {
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr ${resp}, i64 ${idx}`);
    const slot = this.fresh();
    this.emit(`${slot} = load i64, ptr ${gep}`);
    return { v: this.fromSlot(slot, ty), ty };
  }

  /**
   * Host FFI (SH4) — lower a `node:` builtin the program imported. The checker has
   * already validated the signature (HOST_FUNCS), so this only marshals. Fallible
   * calls raise the pending exception (nt_exc_*) and are followed by an exception
   * check, so a missing file surfaces as a catchable throw, like node's ENOENT.
   */
  private genHost(name: string, args: Expr[]): Val {
    switch (name) {
      case "readFileSync": {
        // The encoding argument is checked to be the literal "utf8"; nothing to emit.
        const path = this.genExpr(args[0]!).v;
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_read_file(ptr ${path})`);
        this.emitExcCheck();
        return { v: t, ty: "string" };
      }
      case "writeFileSync": {
        const path = this.genExpr(args[0]!).v;
        const data = this.genExpr(args[1]!).v;
        this.emit(`call void @nt_write_file(ptr ${path}, ptr ${data})`);
        this.emitExcCheck();
        return { v: "", ty: "void" };
      }
      case "existsSync": {
        // Infallible by contract (node swallows every stat error into `false`), so no
        // exception check. i32 → i1 like the other predicate FFI returns.
        const path = this.genExpr(args[0]!).v;
        const r = this.fresh();
        this.emit(`${r} = call i32 @nt_path_exists(ptr ${path})`);
        const t = this.fresh();
        this.emit(`${t} = icmp ne i32 ${r}, 0`);
        return { v: t, ty: "boolean" };
      }
      case "mkdtempSync": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_mkdtemp(ptr ${this.genExpr(args[0]!).v})`);
        this.emitExcCheck();
        return { v: t, ty: "string" };
      }
      case "readdirSync": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_readdir(ptr ${this.genExpr(args[0]!).v})`);
        this.emitExcCheck();
        return { v: t, ty: "string[]" };
      }
      case "rmSync": {
        // The options are compile-time literals (checkHostCall), so the flags are
        // constants here — no options object is ever built.
        const path = this.genExpr(args[0]!).v;
        const opts = args[1];
        const flag = (k: string) =>
          opts?.kind === "ObjectLiteral" && opts.properties.some((p) => p.key === k) ? 1 : 0;
        this.emit(`call void @nt_rm(ptr ${path}, i32 ${flag("recursive")}, i32 ${flag("force")})`);
        this.emitExcCheck();
        return { v: "", ty: "void" };
      }
      case "spawnSync": {
        // Same shape as genFetch: allocate the result block, hand C the slot pointers
        // it fills (status as a raw double, stderr as a ptr) and store the returned
        // stdout. Slot order matches HOST_FUNCS' field order: 0 status, 1 stdout,
        // 2 stderr. The options object is compile-time only ({ encoding: "utf8" }).
        const cmd = this.genExpr(args[0]!).v;
        const argv = this.genExpr(args[1]!).v;
        // `{ stdio: "inherit" }` — the child runs on OUR fds, so there is nothing to
        // capture and the result block is one slot wide (checker: SPAWN_INHERIT_TY).
        if (spawnMode(args) === "inherit") {
          const r = this.fresh();
          this.emit(`${r} = call ptr @nt_obj_new(double ${llvmDouble(1)})`);
          const g = this.fresh();
          this.emit(`${g} = getelementptr i64, ptr ${r}, i64 0`);
          this.emit(`call void @nt_host_spawn_inherit(ptr ${cmd}, ptr ${argv}, ptr ${g})`);
          return { v: r, ty: SPAWN_INHERIT_TY };
        }
        const res = this.fresh();
        this.emit(`${res} = call ptr @nt_obj_new(double ${llvmDouble(3)})`);
        const gStatus = this.fresh();
        this.emit(`${gStatus} = getelementptr i64, ptr ${res}, i64 0`);
        const gErr = this.fresh();
        this.emit(`${gErr} = getelementptr i64, ptr ${res}, i64 2`);
        const out = this.fresh();
        this.emit(`${out} = call ptr @nt_host_spawn(ptr ${cmd}, ptr ${argv}, ptr ${gStatus}, ptr ${gErr})`);
        const gOut = this.fresh();
        this.emit(`${gOut} = getelementptr i64, ptr ${res}, i64 1`);
        this.emit(`store i64 ${this.toSlot({ v: out, ty: "string" })}, ptr ${gOut}`);
        return { v: res, ty: "{status:number,stdout:string,stderr:string}" };
      }
      // node:path — pure string work; nothing here can fail, so no exception check.
      case "join": case "resolve": {
        // node's variadic form, LEFT-FOLDED over the binary primitive.
        const fn = name === "join" ? "nt_path_join" : "nt_path_resolve";
        let acc = this.genExpr(args[0]!).v;
        if (args.length === 1) {
          // Still a real call: node's 1-argument `join`/`resolve` NORMALIZES ("a/./b"
          // → "a/b"). `resolve` takes a null second part; `join` an empty one.
          const t = this.fresh();
          const snd = name === "resolve" ? "null" : this.mod.intern("");
          this.emit(`${t} = call ptr @${fn}(ptr ${acc}, ptr ${snd})`);
          return { v: t, ty: "string" };
        }
        for (let i = 1; i < args.length; i++) {
          const next = this.genExpr(args[i]!).v;
          const t = this.fresh();
          this.emit(`${t} = call ptr @${fn}(ptr ${acc}, ptr ${next})`);
          acc = t;
        }
        return { v: acc, ty: "string" };
      }
      case "dirname": case "basename": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_path_${name}(ptr ${this.genExpr(args[0]!).v})`);
        return { v: t, ty: "string" };
      }
      case "tmpdir": case "homedir": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_os_${name}()`);
        return { v: t, ty: "string" };
      }
      case "fileURLToPath": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_file_url_to_path(ptr ${this.genExpr(args[0]!).v})`);
        this.emitExcCheck(); // node throws for a non-file scheme / an encoded separator
        return { v: t, ty: "string" };
      }
      case "relative": {
        const a = this.genExpr(args[0]!).v, b = this.genExpr(args[1]!).v;
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_path_relative(ptr ${a}, ptr ${b})`);
        return { v: t, ty: "string" };
      }
    }
    // Unreachable: the checker only admits a name that HOST_FUNCS has a signature for.
    throw internalError(`host builtin '${name}' has no lowering, but the checker has a signature for it`);
  }

  private genGlobal(name: string, args: Expr[], retTy?: Ty): Val | null {
    switch (name) {
      case "parseInt": {
        const s = this.genExpr(args[0]!).v;
        // `args.length > 1`, not `args[1]`: `parseInt(s)` reads index == length, a panic.
        const radix = args.length > 1 ? this.genExpr(args[1]!).v : llvmDouble(0);
        const t = this.fresh();
        this.emit(`${t} = call double @js_parse_int(ptr ${s}, double ${radix})`);
        return { v: t, ty: "number" };
      }
      case "parseFloat": {
        const t = this.fresh();
        this.emit(`${t} = call double @js_parse_float(ptr ${this.genExpr(args[0]!).v})`);
        return { v: t, ty: "number" };
      }
      case "isNaN": {
        const x = this.genExpr(args[0]!).v;
        const t = this.fresh();
        this.emit(`${t} = fcmp uno double ${x}, ${x}`);
        return { v: t, ty: "boolean" };
      }
      case "Number": return { v: this.coerceToNumber(this.genExpr(args[0]!)), ty: "number" };
      case "String": return { v: this.coerceToString(this.genExpr(args[0]!)), ty: "string" };
      // --- stdlib (web standards) Batch 1: base64 globals ---
      // BOTH ARE FALLIBLE, exactly like `decodeURIComponent` two cases below: node throws
      // `InvalidCharacterError` for a `btoa` code point above U+00FF and for an `atob`
      // input that is not forgiving-base64. So each needs the pending-exception check —
      // without it the runtime's raise would set the flag and nothing would read it, which
      // is how a throw turns back into the exit-0 wrong answer this pair is being fixed for.
      case "btoa": case "atob": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_${name}(ptr ${this.genExpr(args[0]!).v})`);
        this.emitExcCheck();
        return { v: t, ty: "string" };
      }
      // --- stdlib: URL parsing (WHATWG URL functional subset) — string in, string out ---
      // --- stdlib Batch 3: URI encoding. decode* is fallible (node's URIError). ---
      case "encodeURIComponent": case "encodeURI": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_${name === "encodeURI" ? "encode_uri" : "encode_uri_component"}(ptr ${this.genExpr(args[0]!).v})`);
        return { v: t, ty: "string" };
      }
      case "decodeURIComponent": case "decodeURI": {
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_${name === "decodeURI" ? "decode_uri" : "decode_uri_component"}(ptr ${this.genExpr(args[0]!).v})`);
        this.emitExcCheck();
        return { v: t, ty: "string" };
      }
      case "move": return this.genExpr(args[0]!); // ownership marker; runtime identity
      // Host I/O stdin builtins — return a fresh (rc-tracked) heap string.
      case "readLine": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_line()`); return { v: t, ty: "string" }; }
      case "readStdin": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_stdin()`); return { v: t, ty: "string" }; }
      case "readKey": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_key()`); return { v: t, ty: "string" }; }
      case "rawMode": { const b = this.fresh(); this.emit(`${b} = zext i1 ${this.genExpr(args[0]!).v} to i32`); this.emit(`call void @nt_raw_mode(i32 ${b})`); return { v: "", ty: "void" }; }
      case "__arrLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_live()`); return { v: t, ty: "number" }; }
      case "__objLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_obj_live()`); return { v: t, ty: "number" }; }
      case "__pvNodes": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_nodes()`); return { v: t, ty: "number" }; }
      case "__pvAllocs": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_node_allocs()`); return { v: t, ty: "number" }; }
      case "__strLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_str_live()`); return { v: t, ty: "number" }; }
      case "__strScanned": { this.mod.usesStrScanned = true; const t = this.fresh(); this.emit(`${t} = call double @nt_str_scanned()`); return { v: t, ty: "number" }; }
      case "__pvTransients": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_transients()`); return { v: t, ty: "number" }; }
      // Networking tier (L-d): HTTP(S) client → {status:number, body:string}.
      case "httpGet": return this.genHttp("nt_http_get", args, false);
      case "httpPost": return this.genHttp("nt_http_post", args, true);
      // `fetch(url, init?)` — the web-standard client (blocking; see genFetch).
      case "fetch": return this.isBound("fetch") ? null : this.genFetch(args);

      // --- GUI FFI (raylib-backed, north-star C-d) ---
      // Flat scalar ABI: numbers pass as double, the title/text string as ptr; i32-returning
      // predicates are lowered to boolean via `icmp ne i32 _, 0` (mirrors Number.isInteger).
      // nt_gui.c + -lraylib are linked ONLY when one of these emits a call (see driver.ts).
      case "initWindow": {
        const w = this.genExpr(args[0]!).v, h = this.genExpr(args[1]!).v, title = this.genExpr(args[2]!).v;
        this.emit(`call void @nt_gui_init_window(double ${w}, double ${h}, ptr ${title})`);
        return { v: "", ty: "void" };
      }
      case "setTargetFPS": { this.emit(`call void @nt_gui_set_target_fps(double ${this.genExpr(args[0]!).v})`); return { v: "", ty: "void" }; }
      case "beginDraw": { this.emit(`call void @nt_gui_begin_draw()`); return { v: "", ty: "void" }; }
      case "endDraw": { this.emit(`call void @nt_gui_end_draw()`); return { v: "", ty: "void" }; }
      case "clearBackground": { this.emit(`call void @nt_gui_clear_background(double ${this.genExpr(args[0]!).v})`); return { v: "", ty: "void" }; }
      case "drawText": {
        const s = this.genExpr(args[0]!).v, x = this.genExpr(args[1]!).v, y = this.genExpr(args[2]!).v;
        const sz = this.genExpr(args[3]!).v, col = this.genExpr(args[4]!).v;
        this.emit(`call void @nt_gui_draw_text(ptr ${s}, double ${x}, double ${y}, double ${sz}, double ${col})`);
        return { v: "", ty: "void" };
      }
      case "drawRect": {
        const x = this.genExpr(args[0]!).v, y = this.genExpr(args[1]!).v, w = this.genExpr(args[2]!).v;
        const h = this.genExpr(args[3]!).v, col = this.genExpr(args[4]!).v;
        this.emit(`call void @nt_gui_draw_rect(double ${x}, double ${y}, double ${w}, double ${h}, double ${col})`);
        return { v: "", ty: "void" };
      }
      case "mouseX": { const t = this.fresh(); this.emit(`${t} = call double @nt_gui_mouse_x()`); return { v: t, ty: "number" }; }
      case "mouseY": { const t = this.fresh(); this.emit(`${t} = call double @nt_gui_mouse_y()`); return { v: t, ty: "number" }; }
      case "windowShouldClose": {
        const r = this.fresh(); this.emit(`${r} = call i32 @nt_gui_window_should_close()`);
        const t = this.fresh(); this.emit(`${t} = icmp ne i32 ${r}, 0`); return { v: t, ty: "boolean" };
      }
      case "mousePressed": {
        const r = this.fresh(); this.emit(`${r} = call i32 @nt_gui_mouse_pressed()`);
        const t = this.fresh(); this.emit(`${t} = icmp ne i32 ${r}, 0`); return { v: t, ty: "boolean" };
      }
      case "pointInRect": {
        const a = args.map((e) => this.genExpr(e).v);
        const r = this.fresh();
        this.emit(`${r} = call i32 @nt_gui_point_in_rect(double ${a[0]}, double ${a[1]}, double ${a[2]}, double ${a[3]}, double ${a[4]}, double ${a[5]})`);
        const t = this.fresh(); this.emit(`${t} = icmp ne i32 ${r}, 0`); return { v: t, ty: "boolean" };
      }

      // --- B3 v0 actors ---
      case "spawn": {
        // spawn(body, arg): body is a closure value; message rides in a typed i64 slot
        // (a string arg is deep-copied by the runtime, like any sent message).
        const fn = this.genExpr(args[0]!);              // ptr: [fn_ptr, caps...]
        const argTy = funcParams(fn.ty)[0] ?? "number"; // the body's message type
        const entry = this.mod.actorEntry(argTy);
        // v5: a structured spawn arg is deep-copied HERE (the runtime has no types to
        // walk with); number/string args are copied by the runtime as before.
        const slot = this.slotNoRetain(this.msgValue(this.genExpr(args[1]!)));
        const pidI = this.fresh();
        this.emit(`${pidI} = call i64 @nt_spawn_typed(ptr @${entry}, ptr ${fn.v}, i64 ${slot}, i64 ${msgKind(argTy)})`);
        const pid = this.fresh();
        this.emit(`${pid} = sitofp i64 ${pidI} to double`);
        return { v: pid, ty: "number" };
      }
      case "send": {
        const pidV = this.genExpr(args[0]!).v;          // double
        const pidI = this.fresh();
        this.emit(`${pidI} = fptosi double ${pidV} to i64`);
        const msg = this.genExpr(args[1]!);
        // No retain: a message is DEEP-COPIED before it is enqueued (strings by the
        // runtime, records/arrays by `msgValue` below), so the receiver owns a private
        // value and the sender's own local keeps exactly the ownership it had.
        const slot = this.slotNoRetain(this.msgValue(msg));
        if (isStructMsgTy(msg.ty)) {
          // v5: the SHAPE travels with the message so the receive can verify it got what
          // it was compiled for, plus a renderer for the crash record.
          const shape = this.mod.intern(msgShape(msg.ty));
          const render = this.mod.msgRenderer(msg.ty);
          this.emit(`call void @nt_send_struct(i64 ${pidI}, i64 ${slot}, ptr ${shape}, ptr @${render})`);
          return { v: "", ty: "void" };
        }
        this.emit(`call void @nt_send_typed(i64 ${pidI}, i64 ${slot}, i64 ${msgKind(msg.ty)})`);
        return { v: "", ty: "void" };
      }
      // v4: receive() blocks; receive(ms) is Erlang's `after` — on timeout it yields the
      // A2 `undefined` box rather than any in-band sentinel.
      case "receive": {
        const rt: Ty = retTy ?? "number";
        const base = baseTy(rt);
        const kind = msgKind(base);
        // v5: a structured receive checks the SHAPE, not just the coarse kind.
        const shape = isStructMsgTy(base) ? this.mod.intern(msgShape(base)) : null;
        const recv = (ms: string, has: number) => {
          const t = this.fresh();
          if (shape) this.emit(`${t} = call i64 @nt_recv_struct(ptr ${shape}, double ${ms}, i32 ${has})`);
          else this.emit(`${t} = call i64 @nt_recv_timed(i64 ${kind}, double ${ms}, i32 ${has})`);
          return t;
        };
        if (args.length === 0) {
          const slot = recv(llvmDouble(0), 0);
          return { v: this.fromSlot(slot, base), ty: base };
        }
        const ms = this.genExpr(args[0]!).v;
        const slot = recv(ms, 1);
        const flag = this.fresh(); this.emit(`${flag} = call i32 @nt_recv_timed_out()`);
        const to = this.fresh(); this.emit(`${to} = icmp ne i32 ${flag}, 0`);
        return { v: this.genTimeoutBox(to, slot, rt), ty: rt };
      }
      case "receiveMatch": return this.genReceiveMatch(args, retTy ?? "number");
      case "self": {
        const p = this.fresh();
        this.emit(`${p} = call i64 @nt_self()`);
        const d = this.fresh();
        this.emit(`${d} = sitofp i64 ${p} to double`);
        return { v: d, ty: "number" };
      }
      case "__drain": { this.emit(`call void @nt_drain()`); return { v: "", ty: "void" }; }
      case "__schedulers":   { const t = this.fresh(); this.emit(`${t} = call double @nt_schedulers()`); return { v: t, ty: "number" }; }
      case "__schedUsed":    { const t = this.fresh(); this.emit(`${t} = call double @nt_sched_used()`); return { v: t, ty: "number" }; }
      case "__schedSteals":  { const t = this.fresh(); this.emit(`${t} = call double @nt_sched_steals()`); return { v: t, ty: "number" }; }

      // --- B3 v2 registry / links / monitors / trap / fault injection ---
      case "register": {
        const namePtr = this.genExpr(args[0]!).v;
        const pidI = this.fresh(); this.emit(`${pidI} = fptosi double ${this.genExpr(args[1]!).v} to i64`);
        this.emit(`call void @nt_register(ptr ${namePtr}, i64 ${pidI})`);
        return { v: "", ty: "void" };
      }
      case "whereis": {
        const namePtr = this.genExpr(args[0]!).v;
        const p = this.fresh(); this.emit(`${p} = call i64 @nt_whereis(ptr ${namePtr})`);
        const d = this.fresh(); this.emit(`${d} = sitofp i64 ${p} to double`);
        return { v: d, ty: "number" };
      }
      case "link": {
        const pidI = this.fresh(); this.emit(`${pidI} = fptosi double ${this.genExpr(args[0]!).v} to i64`);
        this.emit(`call void @nt_link(i64 ${pidI})`);
        return { v: "", ty: "void" };
      }
      case "monitor": {
        const pidI = this.fresh(); this.emit(`${pidI} = fptosi double ${this.genExpr(args[0]!).v} to i64`);
        const ref = this.fresh(); this.emit(`${ref} = call i64 @nt_monitor(i64 ${pidI})`);
        const d = this.fresh(); this.emit(`${d} = sitofp i64 ${ref} to double`);
        return { v: d, ty: "number" }; // ref (opaque number)
      }
      case "trapExit": {
        const b = this.fresh(); this.emit(`${b} = zext i1 ${this.genExpr(args[0]!).v} to i32`);
        this.emit(`call void @nt_trap_exit(i32 ${b})`);
        return { v: "", ty: "void" };
      }
      case "exit": {
        const pidI = this.fresh(); this.emit(`${pidI} = fptosi double ${this.genExpr(args[0]!).v} to i64`);
        const rI = this.fresh(); this.emit(`${rI} = fptosi double ${this.genExpr(args[1]!).v} to i64`);
        this.emit(`call void @nt_actor_exit(i64 ${pidI}, i64 ${rI})`);
        return { v: "", ty: "void" };
      }
      case "__crash": {
        const rI = this.fresh(); this.emit(`${rI} = fptosi double ${this.genExpr(args[0]!).v} to i64`);
        this.emit(`call void @nt_crash(i64 ${rI})`);
        return { v: "", ty: "void" };
      }
      case "__kill": {
        const pidI = this.fresh(); this.emit(`${pidI} = fptosi double ${this.genExpr(args[0]!).v} to i64`);
        this.emit(`call void @nt_kill(i64 ${pidI})`);
        return { v: "", ty: "void" };
      }

      // --- B3 v3 supervision: build a spec, add each child, start the supervisor ---
      case "supervise": return this.genSupervise(args[0]!, args[1]!);

      default: return null;
    }
  }

  /** B3 v3: lower supervise(children, opts) — build a C supervisor spec (one child
   *  at a time, reading the ChildSpec object's static slots), then start the
   *  supervisor actor. Children/opts are ordinary linear values; this borrows them. */
  private genSupervise(children: Expr, opts: Expr): Val {
    const optsV = this.genExpr(opts);
    const readNum = (field: string): string => {
      const g = this.fresh();
      this.emit(`${g} = getelementptr i64, ptr ${optsV.v}, i64 ${fieldIndex(optsV.ty, field)}`);
      const s = this.fresh(); this.emit(`${s} = load i64, ptr ${g}`);
      const d = this.fromSlot(s, "number");    // slot -> double
      const i = this.fresh(); this.emit(`${i} = fptosi double ${d} to i64`);
      return i;
    };
    const maxR = readNum("maxRestarts");
    const maxS = readNum("maxSeconds");
    const handle = this.fresh();
    this.emit(`${handle} = call i64 @nt_sup_new(i64 ${maxR}, i64 ${maxS}, i64 0)`); // one_for_one

    const childrenV = this.genExpr(children);
    const elem = elemTy(childrenV.ty);          // the ChildSpec object type
    const idIx = fieldIndex(elem, "id");
    const startIx = fieldIndex(elem, "start");
    const restartIx = fieldIndex(elem, "restart");

    // for (i = 0; i < len; i++) nt_sup_add_child(handle, id, start, restart)
    const idxSlot = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idxSlot}`);
    const lenT = this.fresh();
    this.emit(`${lenT} = call double @nt_arr_len(ptr ${childrenV.v})`);
    const condLbl = this.label("sup"), bodyLbl = this.label("supb"), endLbl = this.label("supend");
    this.terminate(`br label %${condLbl}`);
    this.to(this.block(condLbl));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idxSlot}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${lenT}`);
    this.terminate(`br i1 ${cmp}, label %${bodyLbl}, label %${endLbl}`);
    this.to(this.block(bodyLbl));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idxSlot}`);
    const slot = this.fresh(); this.emit(`${slot} = call i64 @nt_arr_get(ptr ${childrenV.v}, double ${iB})`);
    const childObj = this.fresh(); this.emit(`${childObj} = inttoptr i64 ${slot} to ptr`);
    const loadPtrField = (ix: number): string => {
      const g = this.fresh(); this.emit(`${g} = getelementptr i64, ptr ${childObj}, i64 ${ix}`);
      const s = this.fresh(); this.emit(`${s} = load i64, ptr ${g}`);
      const p = this.fresh(); this.emit(`${p} = inttoptr i64 ${s} to ptr`);
      return p;
    };
    const idP = loadPtrField(idIx), startP = loadPtrField(startIx), restartP = loadPtrField(restartIx);
    this.emit(`call void @nt_sup_add_child(i64 ${handle}, ptr ${idP}, ptr ${startP}, ptr ${restartP})`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iB}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idxSlot}`);
    this.terminate(`br label %${condLbl}`);
    this.to(this.block(endLbl));

    const pidI = this.fresh(); this.emit(`${pidI} = call i64 @nt_sup_start(i64 ${handle})`);
    const pid = this.fresh(); this.emit(`${pid} = sitofp i64 ${pidI} to double`);
    return { v: pid, ty: "number" };
  }

  /** Pack a value into a raw 8-byte slot WITHOUT the string retain `toSlot` adds.
   *  For handoffs where the CALLEE takes its own copy — an actor send/spawn deep-copies
   *  a string message — so the sender keeps exactly the ownership it already had. */
  /** B3 v5: the value that actually goes on the wire. Isolation is the actor model's
   *  whole point, so a STRUCTURED message is deep-copied at the send/spawn site with the
   *  type-driven walk (the Stage-40 `structuredClone` walk, extended to copy string
   *  leaves) — the receiver shares nothing with the sender's heap. Numbers are values and
   *  strings are copied by the runtime, so both pass straight through. */
  private msgValue(val: Val): Val {
    // The pass-through arm rebuilds the record rather than handing `val` back: returning a
    // PARAMETER is a move out of a borrow (NT1604), and the `if` spelling of this exact
    // function was already refused — only the `?:` spelling slipped through, because the
    // ownership pass could not see a move through a ternary arm. A `Val` is an immutable
    // {SSA name, type} descriptor, so the copy is free at runtime and identity-neutral.
    return isStructMsgTy(val.ty) ? this.genDeepClone(val, /*copyStrings=*/true) : { v: val.v, ty: val.ty };
  }

  private slotNoRetain(val: Val): string {
    if (val.ty !== "string") return this.toSlot(val);
    const t = this.fresh();
    this.emit(`${t} = ptrtoint ptr ${val.v} to i64`);
    return t;
  }

  /** B3 v4: join a timed receive into `T | undefined` — the A2 tagged pair, so a
   *  timeout is a real `undefined` and never collides with a legal message value. */
  private genTimeoutBox(timedOut: string, slot: string, rt: Ty): string {
    const out = this.slot(rt);
    const toLbl = this.label("rcvto"), okLbl = this.label("rcvok"), endLbl = this.label("rcvend");
    this.terminate(`br i1 ${timedOut}, label %${toLbl}, label %${okLbl}`);
    this.to(this.block(toLbl));
    this.emit(`store ptr ${this.nullBox("0", "0")}, ptr ${out}`);
    this.terminate(`br label %${endLbl}`);
    this.to(this.block(okLbl));
    this.emit(`store ptr ${this.nullBox("2", slot)}, ptr ${out}`);
    this.terminate(`br label %${endLbl}`);
    this.to(this.block(endLbl));
    const r = this.fresh();
    this.emit(`${r} = load ptr, ptr ${out}`);
    return r;
  }

  /** B3 v4 selective receive — `receiveMatch(pred)` / `receiveMatch(pred, ms)`.
   *
   *  OTP semantics, emitted as a scan over the mailbox rather than a dequeue: walk the
   *  queued messages in order, skip kinds this receive wasn't compiled for, apply the
   *  user predicate (an ordinary closure call, so it can capture and can even yield at
   *  its safepoint), and TAKE the first match. Everything that didn't match simply stays
   *  where it is — that IS Erlang's save queue, restored for the next receive for free.
   *  When the scan is exhausted we block for messages we haven't examined yet and resume
   *  scanning from there, so a message arriving mid-scan is never skipped. */
  private genReceiveMatch(args: Expr[], retTy: Ty): Val {
    const nullable = isNullableTy(retTy);
    const base = baseTy(retTy);
    const kind = msgKind(base);
    const pred = this.genExpr(args[0]!);                    // closure ptr: (base) => boolean
    const hasT = args.length > 1;
    const ms = hasT ? this.genExpr(args[1]!).v : llvmDouble(0);

    const scanned = this.slot("number");   // first not-yet-examined index (survives a block)
    const iSlot = this.slot("number");     // scan cursor
    const res = this.slot(base);           // the matched message
    const okSlot = this.slot("boolean");   // matched (vs timed out)
    this.emit(`store double ${llvmDouble(0)}, ptr ${scanned}`);
    this.emit(`store ${llvmTy(base)} ${defaultZero(base)}, ptr ${res}`);
    this.emit(`store i1 false, ptr ${okSlot}`);

    const outer = this.label("selscan"), inner = this.label("selnext"), body = this.label("selbody");
    const tryp = this.label("seltry"), hit = this.label("selhit"), step = this.label("selstep");
    const wait = this.label("selwait"), miss = this.label("selmiss"), done = this.label("seldone");

    this.terminate(`br label %${outer}`);
    // outer: re-read the mailbox length (it can grow while we scan) and resume the cursor
    this.to(this.block(outer));
    const lenI = this.fresh(); this.emit(`${lenI} = call i64 @nt_mbox_count()`);
    const lenD = this.fresh(); this.emit(`${lenD} = sitofp i64 ${lenI} to double`);
    const sc = this.fresh(); this.emit(`${sc} = load double, ptr ${scanned}`);
    this.emit(`store double ${sc}, ptr ${iSlot}`);
    this.terminate(`br label %${inner}`);

    this.to(this.block(inner));
    const i0 = this.fresh(); this.emit(`${i0} = load double, ptr ${iSlot}`);
    const more = this.fresh(); this.emit(`${more} = fcmp olt double ${i0}, ${lenD}`);
    this.terminate(`br i1 ${more}, label %${body}, label %${wait}`);

    // body: only messages of this receive's kind are candidates (an exit signal or a
    // number sent to a string receive is left in the mailbox, not misread).
    this.to(this.block(body));
    const iD = this.fresh(); this.emit(`${iD} = load double, ptr ${iSlot}`);
    const iI = this.fresh(); this.emit(`${iI} = fptosi double ${iD} to i64`);
    // v5: for a structured receive the wire tag is the SHAPE, not the coarse kind. A
    // foreign shape (or a number/string) is simply skipped and left queued in order —
    // the save queue — rather than handed to a predicate compiled for other slots.
    const tag = this.fresh();
    if (isStructMsgTy(base)) this.emit(`${tag} = call i32 @nt_mbox_shape_ok(i64 ${iI}, ptr ${this.mod.intern(msgShape(base))})`);
    else this.emit(`${tag} = call i64 @nt_mbox_peek_kind(i64 ${iI})`);
    const kOk = this.fresh();
    this.emit(isStructMsgTy(base) ? `${kOk} = icmp ne i32 ${tag}, 0` : `${kOk} = icmp eq i64 ${tag}, ${kind}`);
    this.terminate(`br i1 ${kOk}, label %${tryp}, label %${step}`);

    this.to(this.block(tryp));
    const rawSlot = this.fresh(); this.emit(`${rawSlot} = call i64 @nt_mbox_peek_slot(i64 ${iI})`);
    const v = this.fromSlot(rawSlot, base);
    const p = this.callClosureWith(pred.v, pred.ty, [{ v, ty: base }]);
    this.terminate(`br i1 ${p.v}, label %${hit}, label %${step}`);

    this.to(this.block(hit));
    this.emit(`call void @nt_mbox_take(i64 ${iI})`);
    this.emit(`store ${llvmTy(base)} ${v}, ptr ${res}`);
    this.emit(`store i1 true, ptr ${okSlot}`);
    this.terminate(`br label %${done}`);

    this.to(this.block(step));
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iD}, ${llvmDouble(1)}`);
    this.emit(`store double ${iN}, ptr ${iSlot}`);
    this.terminate(`br label %${inner}`);

    // wait: nothing in the queue matched — block until something we haven't examined
    // arrives (or the timeout fires), then rescan from where we stopped.
    this.to(this.block(wait));
    this.emit(`store double ${lenD}, ptr ${scanned}`);
    const got = this.fresh();
    this.emit(`${got} = call i32 @nt_mbox_wait_from(i64 ${lenI}, double ${ms}, i32 ${hasT ? 1 : 0})`);
    const gotB = this.fresh(); this.emit(`${gotB} = icmp ne i32 ${got}, 0`);
    this.terminate(`br i1 ${gotB}, label %${outer}, label %${miss}`);

    this.to(this.block(miss));
    this.terminate(`br label %${done}`);

    this.to(this.block(done));
    const okV = this.fresh(); this.emit(`${okV} = load i1, ptr ${okSlot}`);
    const rv = this.fresh(); this.emit(`${rv} = load ${llvmTy(base)}, ptr ${res}`);
    if (!nullable) return { v: rv, ty: base };   // blocking form: only reachable on a match
    const timedOut = this.fresh(); this.emit(`${timedOut} = xor i1 ${okV}, true`);
    return { v: this.genTimeoutBox(timedOut, this.slotNoRetain({ v: rv, ty: base }), retTy), ty: retTy };
  }

  /** Argument `i` of a user call: the caller's pre-lowered argument 0, or the expression
   *  written at the call site (or the parameter's DEFAULT when the site omitted it).
   *  Deliberately builds a FRESH `Val` for the pre-lowered case rather than handing back
   *  one it was given — src/ has to stay inside the subset it compiles, and returning an
   *  element of a `Val[]` parameter is a move out of a borrowed array element (NT1605). */
  private argVal(i: number, args: Expr[], preArg0: string, sig: Sig): Val {
    if (i === 0 && preArg0 !== "") return { v: preArg0, ty: args[0]!.ty ?? sig.params[0]! };
    // `i < args.length`, not `args[i] ?? …`: a defaulted parameter reads index == length,
    // which nativets PANICS on (Stage 41) — the `??` could never see `undefined`.
    return this.genExpr(i < args.length ? args[i]! : sig.defaults[i]!);
  }

  /** `preArg0`, when non-empty, is the SSA value of argument 0 already lowered by the
   *  CALLER; `args[0]` is then read for its TYPE only and never generated again. Exactly
   *  one caller uses it — the class-instance method call, whose chain-temporary drop needs
   *  the receiver's pointer and must not evaluate the receiver twice. */
  private genUserCall(name: string, args: Expr[], preArg0 = ""): Val {
    this.emitSafepoint(); // call site: preempt long / deeply-recursive call chains
    const sig = this.mod.functions.get(name)!;
    // A callee `scanEscaping` proved may RAISE gets the same check a fallible host call
    // already gets: the pending flag decides between the next statement and this frame's
    // `catch`. Emitting it is not optional — `scanEscaping` only admits a callee whose
    // every call site checks, so this line is the other half of that proof.
    const raises = this.mod.escaping.has(name);
    // A PROVED-escaping callee whose covering `catch` binds an OBJECT is one that moved the
    // object onto the pending slot (`scanEscaping` rule 3 makes those two the same type), so
    // the check takes it rather than rebuilding a binding from the message. `false` at every
    // host call site, which is a fact about them and not a conservatism: the runtime raises
    // a `const char *` and has no typed object to hand over.
    const h = this.innermostHandler();
    const objPayload = raises && h !== null && h.excVar !== null && isObjectTy(h.eType);
    if (sig.rest) {
      const fixed = sig.params.length - 1;
      //@@mutable
      const argVals: string[] = [];
      //@@mutable
      const frees: { free: string; v: string }[] = []; // see `argTempFree`
      // The FIXED parameters coerce just like a non-rest call's do (see below) — this
      // path emitted them raw, so a nullable/general-union fixed parameter of a rest
      // function received an unboxed value.
      for (let i = 0; i < fixed; i++) {
        const raw = this.argVal(i, args, preArg0, sig);
        const co = this.coerce(raw, sig.params[i]!);
        const free = this.argTempFree(i, args, preArg0, sig, raw, co);
        if (free !== null) frees.push({ free, v: raw.v });
        argVals.push(`${llvmTy(sig.params[i]!)} ${co.v}`);
      }
      const arr = this.fresh(); // pack trailing args into the rest array
      this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(args.length - fixed, 1))})`);
      for (let i = fixed; i < args.length; i++) this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(this.genExpr(args[i]!))})`);
      argVals.push(`ptr ${arr}`);
      // The REST ARRAY is built right here, at this call site, and nothing else can ever
      // name it — the purest unbound temporary in the language. It is a borrow to the
      // callee like every other parameter (`function f(...xs: T[]): T[] { return xs; }`
      // is NT1604), so the caller frees the header once the call returns. Shallow: the
      // ELEMENTS are the caller's own values, still owned and dropped by its own scope,
      // and freeing them here would be the double free this rule exists to avoid.
      frees.push({ free: "nt_arr_free", v: arr });
      const argstr = argVals.join(", ");
      if (sig.ret === "void") { this.emit(`call void @${userSym(name)}(${argstr})`); this.emitArgTempFrees(frees); if (raises) this.emitExcCheck(objPayload); return { v: "", ty: "void" }; }
      const t = this.fresh();
      this.emit(`${t} = call ${llvmTy(sig.ret)} @${userSym(name)}(${argstr})`);
      this.emitArgTempFrees(frees);
      if (raises) this.emitExcCheck(objPayload);
      return { v: t, ty: sig.ret };
    }
    //@@mutable
    const argVals: string[] = [];
    //@@mutable
    const frees: { free: string; v: string }[] = []; // unbound literal temporaries, freed after the call
    for (let i = 0; i < sig.params.length; i++) {
      // Coerced to the param type — boxing an `undefined` default into a nullable
      // optional param (`f(x?: T)`), and boxing an ARM into a general-union param
      // (`f(v: number | string)`, called as `f(41)`). A no-op when the types already
      // match, so ordinary params are unaffected.
      const raw = this.argVal(i, args, preArg0, sig);
      const co = this.coerce(raw, sig.params[i]!);
      const free = this.argTempFree(i, args, preArg0, sig, raw, co);
      if (free !== null) frees.push({ free, v: raw.v });
      argVals.push(co.v);
    }
    const argstr = argVals.map((v, i) => `${llvmTy(sig.params[i]!)} ${v}`).join(", ");
    if (sig.ret === "void") {
      this.emit(`call void @${userSym(name)}(${argstr})`);
      this.emitArgTempFrees(frees);
      if (raises) this.emitExcCheck(objPayload);
      return { v: "", ty: "void" };
    }
    const t = this.fresh();
    this.emit(`${t} = call ${llvmTy(sig.ret)} @${userSym(name)}(${argstr})`);
    this.emitArgTempFrees(frees);
    if (raises) this.emitExcCheck(objPayload);
    return { v: t, ty: sig.ret };
  }
}

/** A character LLVM allows in an unquoted local name (`%foo.bar`, `endtry12`). */
function isLabelChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") ||
    c === "_" || c === "." || c === "$" || c === "-";
}

/**
 * The `X` of every `label %X` on one instruction line.
 *
 * `label %X` is the ONLY way this codegen names a block: it emits `br label %X` and
 * `br i1 %c, label %A, label %B` and nothing else — no `switch` (a TS `switch` lowers
 * to chained `br i1`), no `phi`, no `blockaddress`, and none of the unwind forms
 * (`invoke`, `indirectbr`, `callbr`, `catchswitch`, `cleanupret`), because the throw
 * model is a lexical branch and there is no unwinder. Measured over every module the
 * corpus emits (173 modules, 3.6 MB): 6,706 block references on 4,844 branch lines, all
 * of them a `br`, and zero occurrences of any other form. So this is the whole reference
 * grammar as emitted, not a subset of it.
 *
 * Two forms WOULD escape it if codegen ever grew them, because neither spells the
 * `label` keyword: a `phi` incoming block (`[ %v, %lbl ]`) and `blockaddress(@f, %lbl)`.
 * `verifyBlockLabels` refuses outright if it sees either, rather than waving through a
 * construct it does not actually check.
 *
 * `%label`, `%label.addr` and `@Item.label` are VALUES, not block operands — a program
 * with a variable named `label` emits all three — so a match must not be preceded by a
 * name character, `%` or `@`.
 */
function labelRefs(line: string): string[] {
  //@@mutable
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ";") break; // a comment: nothing after it is an operand
    // The `l` test first: it makes the common (non-matching) character free, where the
    // `slice` alone allocated a 5-char string at every position of every line.
    if (line[i] !== "l" || line.slice(i, i + 5) !== "label") { i++; continue; }
    const before = i === 0 ? " " : line[i - 1]!;
    if (isLabelChar(before) || before === "%" || before === "@") { i = i + 5; continue; }
    let j = i + 5;
    while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
    if (j >= line.length || line[j] !== "%") { i = i + 5; continue; }
    j++;
    const start = j;
    while (j < line.length && isLabelChar(line[j]!)) j++;
    if (j > start) out.push(line.slice(start, j));
    i = j;
  }
  return out;
}

/**
 * The two constructs that reference a block WITHOUT the `label` keyword, and which
 * `labelRefs` therefore cannot see: a `phi` incoming block (`[ %v, %lbl ]`) and
 * `blockaddress(@f, %lbl)`. Codegen emits neither — zero of each across every module
 * the corpus emits — and the point of naming them here is that if one ever appears,
 * `verifyBlockLabels` says so loudly instead of quietly checking less than it claims.
 *
 * Matched in OPCODE position only, so a user function `@phi` or a local `%phi` (both
 * of which a program with a variable named `phi` emits) is not one of these.
 */
function uncheckedBlockRef(line: string): string {
  const s = line.trim();
  if (s.slice(0, 4) === "phi ") return "phi";
  if (s.indexOf("= phi ") >= 0) return "phi";
  const b = s.indexOf("blockaddress(");
  // Not `@blockaddress(...)` / `%blockaddress` — a call to a user function of that name.
  if (b === 0 || (b > 0 && !isLabelChar(s[b - 1]!) && s[b - 1] !== "%" && s[b - 1] !== "@")) return "blockaddress";
  return "";
}

/** `@name` out of a `define <ty> @name(...) ... {` header, for the error message. */
function defineSymbol(header: string): string {
  const at = header.indexOf("@");
  if (at < 0) return header;
  let j = at + 1;
  while (j < header.length && header[j] !== "(") j++;
  return header.slice(at, j);
}

/**
 * Every `label %X` inside a `define` must name a block defined in that SAME `define`.
 *
 * This exists because `sourceToIR` is check -> analyzeOwnership -> codegen and returns
 * TEXT: clang never runs, so `emit` exited 0 on a module clang would reject. A
 * `try`/`finally` with no `catch` emitted `br label %catchN` with no such block, and the
 * compiler reported success — and "emit exits 0" is the gate this project reads as
 * "reaches IR". That particular source is refused now (NT1004); this stops the next one.
 *
 * A malformed module is a COMPILER bug, so it raises `InternalError` and never an
 * `NT****` code: an NT code tells the reader how to rewrite their program, and there is
 * nothing here for them to rewrite (see `InternalError` in src/diagnostics.ts).
 *
 * Deliberately NOT a general IR verifier — LLVM ships one, and duplicating it here would
 * be a second, worse implementation. This is one structural invariant, checked exactly.
 *
 * Only `define` BODIES are scanned. A module-level string constant may contain any text
 * at all (`;`, `%`, the word `label`), and a body contains no string constants — over
 * the whole corpus, zero `label` occurrences outside a body and zero double-quotes
 * inside one.
 */
export function verifyBlockLabels(ir: string): void {
  const lines = ir.split("\n");
  let inDefine = false;
  let fn = "";
  let defs = new Set<string>();
  //@@mutable
  let refs: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!inDefine) {
      if (line.startsWith("define ") && line.endsWith("{")) {
        inDefine = true;
        fn = defineSymbol(line);
        defs = new Set<string>();
        refs = [];
      }
      continue;
    }
    // `assemble` closes a body with a bare `}` at column 0, and emits every
    // instruction indented — so an UNINDENTED `name:` is a block label.
    if (line === "}") { checkRefs(fn, defs, refs); inDefine = false; continue; }
    if (line.length > 1 && line.endsWith(":") && isLabelChar(line[0]!)) {
      // `defs = defs.add(…)`, not `defs.add(…)`: our `Set` is persistent (NT1606).
      defs = defs.add(line.slice(0, line.length - 1));
      continue;
    }
    const blind = uncheckedBlockRef(line);
    if (blind !== "") {
      throw internalError(
        `${fn} emits a \`${blind}\`, which names its blocks WITHOUT the \`label\` keyword — ` +
        `so verifyBlockLabels does not check those references and would wave the module ` +
        `through. Teach \`labelRefs\` the \`${blind}\` operand form before emitting one. ` +
        `Line: ${line.trim()}`,
      );
    }
    for (const r of labelRefs(line)) refs.push(r);
  }
  // An unterminated body would otherwise drop its references unchecked — the one way
  // this check could go quiet without saying so.
  if (inDefine) checkRefs(fn, defs, refs);
}

function checkRefs(fn: string, defs: Set<string>, refs: string[]): void {
  for (const r of refs) {
    if (defs.has(r)) continue;
    //@@mutable
    const names: string[] = [];
    for (const d of defs) names.push(d);
    const shown = names.length > 24 ? names.slice(0, 24).join(", ") + `, … (${names.length} total)` : names.join(", ");
    throw internalError(
      `${fn} branches to \`label %${r}\`, but no block \`${r}:\` is defined in it — the ` +
      `emitted module is malformed and clang would reject it. A branch target was emitted ` +
      `without the block it names. Blocks defined in ${fn}: ${shown}`,
    );
  }
}

export function codegen(checked: CheckedProgram): string {
  const ir = new ModuleGen(checked.functions, checked.globals).build(checked.program);
  verifyBlockLabels(ir);
  return ir;
}
