/*
 * Static checker + type inference.
 *
 * Supported types: number | boolean | string | void | undefined | null.
 * Unsupported-but-valid TS is rejected here with an NT1xxx diagnostic (never
 * miscompiled), which `coverage` surfaces. Codegen only ever sees checked,
 * supported programs.
 */

import type { Program, Stmt, Expr, Ty, FuncDecl, VarDecl, ForOfStmt, MemberExpr } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectType, objectFields, fieldType, isFuncTy, funcParams, funcRet, makeFuncTy, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, makeMapTy, makeSetTy, mapKeyTy, mapValTy, setElemTy, classTag, isBytesTy, isTextEncoderTy, isTextDecoderTy, isResponseTy, isHeadersTy } from "./ast.ts";
import { hasTypeParam, substTypeParams, eraseTypeParams, unifyTypeParams, mapTypesDeep, mutableTags, exprText, freshArray } from "./ast.ts";
// stdlib Batch 3 (the object-shaped web APIs): Date / URL / URLSearchParams.
import { isDateTy, isUrlTy, isSearchParamsTy, DATE_GETTERS, URL_COMPONENTS } from "./ast.ts";
// Stage 47 (console.log of compound values): the handle-type predicates the
// inspectability walk needs to refuse a value it cannot render exactly like node.
import { isBytesRefTy, isFetchRefTy, isUrlRefTy } from "./ast.ts";
// SH2 (discriminated unions): the tagged-union encoding and its tag machinery.
import { isUnionTy, unionDiscriminant, unionMemberFor, unionMembers, unionTagValues, unionWidenedMembers, makeUnionTy, widenLiteralTys } from "./ast.ts";
// The GENERAL (non-object) union encoding — arms with no discriminant field, tagged
// by `typeof` instead. Distinct from the discriminated-union machinery imported above.
import { isGeneralUnionTy, generalUnionMembers, makeGeneralUnionTy, typeofTagOf } from "./ast.ts";
import type { ArrowFunction, BinaryExpr, Loc } from "./ast.ts";
// `unlinkedImportError` says "you did not link" instead of blaming closures, for a call
// to an imported binding that the standalone (unlinked) check cannot see.
import { NTError, NYI, nyi, typeError, mutationError, emptyArrayError, boundsError, unlinkedImportError, useBeforeAssign } from "./diagnostics.ts";

export interface Sig { params: Ty[]; ret: Ty; required: number; defaults: (Expr | null)[]; rest: boolean; }

/** Types storable as a Map value (a raw i64 slot): scalars plus heap refs (array/object). */
function isMapValueTy(v: Ty): boolean {
  return v === "number" || v === "string" || v === "boolean" || isArrayTy(v) || isObjectTy(v);
}
export interface CheckedProgram {
  program: Program;
  functions: Map<string, Sig>;
  /** Module-level bindings a FUNCTION body reads → promoted to LLVM globals by
   *  codegen (see the module scope in `check`). Empty for programs whose functions
   *  only touch their own params/locals, which is every program written before SH1. */
  globals: Map<string, Ty>;
}

/* ------------------------------------------------------------------
 * Statically-known out-of-bounds (NT2002).
 *
 * An out-of-range index panics at runtime. When the length AND the index are both
 * compile-time constants the fault is certain, so we reject the program instead —
 * compile-time beats runtime for the same defect (reject-don't-miscompile).
 * Deliberately narrow: a literal array/string (or a `const` bound to one) indexed by
 * a numeric literal. Anything less certain is left to the runtime panic.
 * ------------------------------------------------------------------ */

/** The length of an expression whose size is fixed at compile time, else undefined. */
function literalLength(e: Expr): number | undefined {
  if (e.kind === "ArrayLiteral") {
    return e.elements.some((x) => x.kind === "SpreadExpr") ? undefined : e.elements.length;
  }
  // String indices address UTF-8 BYTES here (docs/divergences.md §A.2), so measure bytes.
  if (e.kind === "StringLiteral") return Buffer.byteLength(e.value, "utf8");
  return undefined;
}

/** A literal index, including a negated one (`a[-1]`, which parses as unary minus). */
function literalIndex(e: Expr): number | undefined {
  if (e.kind === "NumberLiteral") return e.value;
  if (e.kind === "UnaryExpr" && e.op === "-" && e.operand.kind === "NumberLiteral") return -e.operand.value;
  return undefined;
}

/** `len` is set only for a `const` bound to a literal of statically-known length (an
 *  array literal without spreads, or a string literal) — it feeds the NT2002
 *  compile-time out-of-bounds rejection. */
interface Binding {
  ty: Ty; constant: boolean; len?: number;
  /** SH2: this binding is a NARROWING shadow of a discriminated union, and this is the
   *  union it was narrowed from. Assigning through it is refused (see the checker) —
   *  the narrowing was proved for the OLD value and a new one can carry a different
   *  tag, so honouring it would read the next field access at the wrong slot. */
  narrowedFrom?: Ty;
}

/**
 * One control-flow narrowing fact — see the narrowing section on `Checker`. The thing it
 * is about is an ACCESS PATH: the root `binding` plus `path`, the dotted suffix read off
 * it (`""` for the bare name, `".spans"` for `diag.spans`). `name` is the root's name,
 * which is what the "was it assigned in this region?" filter looks at.
 */
interface NarrowFact { name: string; binding: Binding; path: string; ty: Ty; constant: boolean; arrowDepth: number }

/** The root binding + dotted suffix an expression reads, and the type at the end of it. */
interface AccessPath { name: string; binding: Binding; path: string; ty: Ty }

class Scope {
  private vars = new Map<string, Binding>();
  /** Names of THIS scope's own bindings that some lookup resolved to. Used on the
   *  module scope to learn which top-level bindings a function body reads, so only
   *  those are promoted to LLVM globals (everything else stays a `main` local, and
   *  every single-file program's IR is unchanged). */
  readonly hits = new Set<string>();
  constructor(private parent: Scope | null = null) {}
  child(): Scope { return new Scope(this); }
  declare(name: string, ty: Ty, constant: boolean, len?: number, narrowedFrom?: Ty): void { this.vars.set(name, { ty, constant, len, narrowedFrom }); }
  own(name: string): Binding | undefined { return this.vars.get(name); }
  lookup(name: string): Binding | undefined {
    const b = this.vars.get(name);
    if (b) { this.hits.add(name); return b; }
    return this.parent?.lookup(name);
  }
}

const BUILTIN_NUMBERS = ["NaN", "Infinity"];
const RELATIONAL = new Set(["<", "<=", ">", ">="]);
const EQUALITY = new Set(["===", "!==", "==", "!="]);
const BITWISE = new Set(["&", "|", "^", "<<", ">>", ">>>"]);

/** stdlib Batch 1: `Number.*` numeric constants (exact IEEE-754 values, like node). */
export const NUMBER_CONSTS: Record<string, number> = {
  MAX_SAFE_INTEGER: 9007199254740991,
  MIN_SAFE_INTEGER: -9007199254740991,
  EPSILON: 2.220446049250313e-16,
  MAX_VALUE: 1.7976931348623157e308,
  MIN_VALUE: 5e-324,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: NaN,
};

const MATH_METHODS: Record<string, number | "var"> = {
  floor: 1, ceil: 1, round: 1, abs: 1, sqrt: 1, trunc: 1, pow: 2, max: "var", min: "var",
};
interface MethodSig { min: number; max: number; argTys: (Ty | null)[]; ret: Ty; }
/** stdlib Batch 1 (part 2): predicate HOFs — one inline arrow, boolean body. */
const SEARCH_HOFS = new Set(["some", "every", "find", "findIndex", "findLast", "findLastIndex"]);
const STRING_METHODS: Record<string, MethodSig> = {
  toUpperCase: { min: 0, max: 0, argTys: [], ret: "string" },
  toLowerCase: { min: 0, max: 0, argTys: [], ret: "string" },
  trim: { min: 0, max: 0, argTys: [], ret: "string" },
  charAt: { min: 1, max: 1, argTys: ["number"], ret: "string" },
  slice: { min: 1, max: 2, argTys: ["number", "number"], ret: "string" },
  substring: { min: 1, max: 2, argTys: ["number", "number"], ret: "string" },
  repeat: { min: 1, max: 1, argTys: ["number"], ret: "string" },
  padStart: { min: 1, max: 2, argTys: ["number", "string"], ret: "string" },
  includes: { min: 1, max: 1, argTys: ["string"], ret: "boolean" },
  indexOf: { min: 1, max: 1, argTys: ["string"], ret: "number" },
  split: { min: 1, max: 2, argTys: ["string", "number"], ret: "string[]" }, // 2nd arg = limit (stdlib batch 1)
  // --- stdlib Batch 1 (part 2): string fills (byte-oriented, ASCII == node) ---
  charCodeAt: { min: 0, max: 1, argTys: ["number"], ret: "number" },
  codePointAt: { min: 0, max: 1, argTys: ["number"], ret: makeNullable("undefined", "number") },
  at: { min: 1, max: 1, argTys: ["number"], ret: makeNullable("undefined", "string") }, // string | undefined
  padEnd: { min: 1, max: 2, argTys: ["number", "string"], ret: "string" },
  replace: { min: 2, max: 2, argTys: ["string", "string"], ret: "string" },     // string pattern only (no RegExp)
  replaceAll: { min: 2, max: 2, argTys: ["string", "string"], ret: "string" },  // string pattern only (no RegExp)
  startsWith: { min: 1, max: 2, argTys: ["string", "number"], ret: "boolean" },
  endsWith: { min: 1, max: 2, argTys: ["string", "number"], ret: "boolean" },
  lastIndexOf: { min: 1, max: 1, argTys: ["string"], ret: "number" }, // number | undefined (node: undefined out of range)
};
/**
 * Host FFI (SH4) — the signatures of the `node:` builtins, keyed by their canonical
 * name. Unlike GLOBAL_FUNCS these are NOT ambient: a name is only in scope when the
 * program imported it (`Program.hostImports`), so node and nativets agree on what is
 * defined. Backed by libc in runtime/runtime.c, so they cross-link unchanged.
 */
const HOST_FUNCS: Record<string, MethodSig> = {
  // node:fs — `readFileSync(path, "utf8")`. The encoding is REQUIRED and must be the
  // literal "utf8": node returns a Buffer without one, and we have no Buffer.
  readFileSync: { min: 2, max: 2, argTys: ["string", "string"], ret: "string" },
  // `writeFileSync(path, contents)` — node also takes an options/encoding third
  // argument; the default (utf8, truncate) is the only mode implemented.
  writeFileSync: { min: 2, max: 2, argTys: ["string", "string"], ret: "void" },
  // `existsSync(path)` REPORTS rather than throws — it is the guard in front of a read.
  existsSync: { min: 1, max: 1, argTys: ["string"], ret: "boolean" },
  mkdtempSync: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  readdirSync: { min: 1, max: 1, argTys: ["string"], ret: "string[]" }, // names only (no withFileTypes)
  // `rmSync(path)` / `rmSync(path, { recursive: true, force: true })`. The options are
  // validated by VALUE (checkHostCall) — they decide what the call removes.
  rmSync: { min: 1, max: 2, argTys: ["string", null], ret: "void" },
  // node:child_process — `spawnSync(cmd, args, { encoding: "utf8" })`. The options
  // object is validated by VALUE (checkHostCall): every other node option changes what
  // the call does, so an ignored one would be a silent divergence. Field order here IS
  // the slot order codegen writes.
  spawnSync: { min: 3, max: 3, argTys: ["string", "string[]", null], ret: "{status:number,stdout:string,stderr:string}" },
  // node:path (POSIX). `join`/`resolve` are variadic in node and are LEFT-FOLDED over
  // the binary runtime primitive here (normalize is idempotent and `..` resolves left
  // to right, so the fold is node's answer — pinned by the differential corpus).
  join: { min: 1, max: 8, argTys: ["string", "string", "string", "string", "string", "string", "string", "string"], ret: "string" },
  resolve: { min: 1, max: 8, argTys: ["string", "string", "string", "string", "string", "string", "string", "string"], ret: "string" },
  dirname: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  // node's 2-arg `basename(p, ext)` strips a suffix; only the 1-arg form is implemented.
  basename: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  relative: { min: 2, max: 2, argTys: ["string", "string"], ret: "string" },
  // node:os / node:url — the last two the compiler's own source imports.
  tmpdir: { min: 0, max: 0, argTys: [], ret: "string" },
  homedir: { min: 0, max: 0, argTys: [], ret: "string" },
  fileURLToPath: { min: 1, max: 1, argTys: ["string"], ret: "string" },
};

const GLOBAL_FUNCS: Record<string, MethodSig> = {
  parseInt: { min: 1, max: 2, argTys: ["string", "number"], ret: "number" },
  parseFloat: { min: 1, max: 1, argTys: ["string"], ret: "number" },
  isNaN: { min: 1, max: 1, argTys: ["number"], ret: "boolean" },
  Number: { min: 1, max: 1, argTys: [null], ret: "number" },
  String: { min: 1, max: 1, argTys: [null], ret: "string" },
  // --- stdlib (web standards) Batch 1: base64 globals (differential vs node) ---
  btoa: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  atob: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  // --- stdlib Batch 3: URI encoding (ECMAScript §19.2, byte-exact vs node) ---
  encodeURIComponent: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  decodeURIComponent: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  encodeURI: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  decodeURI: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  __arrLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live array count
  __objLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live object count
  __pvNodes: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live persistent-vector nodes
  __pvAllocs: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: cumulative pvec node allocs
  __strLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live heap-string count
  __pvTransients: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: in-place (rc==1) appends
  // Host I/O FFI (stdin): the node oracle gets these via a harness polyfill prelude.
  readLine: { min: 0, max: 0, argTys: [], ret: "string" },  // next stdin line (no newline), "" at EOF
  readStdin: { min: 0, max: 0, argTys: [], ret: "string" }, // all remaining stdin
  readKey: { min: 0, max: 0, argTys: [], ret: "string" },   // next single keypress (raw), "" at EOF
  rawMode: { min: 1, max: 1, argTys: ["boolean"], ret: "void" }, // enter/leave terminal raw mode
  // Networking tier (L-d): libcurl-backed HTTP(S) client. `headers` is a newline-joined
  // list of "Name: Value" lines. Returns {status, body}; host/Linux only (see driver.ts).
  httpGet: { min: 2, max: 2, argTys: ["string", "string"], ret: "{status:number,body:string}" },
  httpPost: { min: 3, max: 3, argTys: ["string", "string", "string"], ret: "{status:number,body:string}" },
  // --- GUI FFI (raylib-backed, north-star C-d): a minimal immediate-mode surface. Host
  // desktop only; nt_gui.c + -lraylib are linked ONLY when one of these is called (see
  // driver.ts), so non-GUI programs / cross-builds stay raylib-free. Colors are a small
  // palette INDEX (number) resolved in the runtime — no raylib `Color` crosses the FFI.
  initWindow: { min: 3, max: 3, argTys: ["number", "number", "string"], ret: "void" },
  windowShouldClose: { min: 0, max: 0, argTys: [], ret: "boolean" },
  beginDraw: { min: 0, max: 0, argTys: [], ret: "void" },
  endDraw: { min: 0, max: 0, argTys: [], ret: "void" },
  clearBackground: { min: 1, max: 1, argTys: ["number"], ret: "void" }, // palette index
  drawText: { min: 5, max: 5, argTys: ["string", "number", "number", "number", "number"], ret: "void" }, // s,x,y,size,color
  drawRect: { min: 5, max: 5, argTys: ["number", "number", "number", "number", "number"], ret: "void" }, // x,y,w,h,color
  mouseX: { min: 0, max: 0, argTys: [], ret: "number" },
  mouseY: { min: 0, max: 0, argTys: [], ret: "number" },
  mousePressed: { min: 0, max: 0, argTys: [], ret: "boolean" }, // left button pressed this frame
  pointInRect: { min: 6, max: 6, argTys: ["number", "number", "number", "number", "number", "number"], ret: "boolean" }, // px,py,x,y,w,h
  setTargetFPS: { min: 1, max: 1, argTys: ["number"], ret: "void" },
};
/** B3 v0 actor builtins — special-cased in inferCall (variadic / function-valued). */
const ACTOR_BUILTINS = new Set([
  "spawn", "send", "receive", "self", "__drain",
  // v2 registry / links / monitors / trap + fault injection; v3 supervision
  "register", "whereis", "link", "monitor", "trapExit", "exit", "__crash", "__kill", "supervise",
  // v4 selective receive (receiveMatch(pred, timeoutMs?)); receive gained an optional timeout
  "receiveMatch",
  // v6 M:N scheduler introspection (debug builtins, like __arrLive)
  "__schedulers", "__schedUsed", "__schedSteals",
]);

/** B3 v5: is `t` a STRUCTURED message type — a record or an array, sent by a
 *  type-driven deep copy (the structuredClone walk) with its shape on the wire? */
export function isStructMsgTy(t: Ty): boolean { return isObjectTy(t) || isArrayTy(t); }

/** Every leaf of a structured message must itself be copyable and re-typable by the
 *  receiver: scalars, strings, and nested records/arrays of those. A function value
 *  captures the SENDER's environment (copying it would break isolation), and the
 *  reference handles (Map/Set, Uint8Array, Response, Dyn, nullable boxes) have no
 *  deep-copy walk — so they are refused, never shipped as a raw pointer. */
function msgLeafOk(t: Ty): boolean {
  if (t === "number" || t === "string" || t === "boolean") return true;
  if (isObjectTy(t)) return objectFields(t).every((f) => msgLeafOk(f.ty));
  if (isArrayTy(t)) return msgLeafOk(elemTy(t));
  return false;
}

/** B3 v4/v5: the message types an actor can send/receive — `number` (v0), `string`
 *  (v4) and, since v5, STRUCTURED records/arrays of those (deep-copied on send, with
 *  a shape tag so a receive can verify it got the shape it was compiled for).
 *  `T | undefined` (a timeout result) narrows to its base. Anything else is refused
 *  with a code rather than shipped through the 8-byte slot uncopied. */
export function actorMsgTy(t?: Ty): Ty {
  const base = t === undefined ? "number" : isNullableTy(t) ? baseTy(t) : t;
  if (base === "number" || base === "string") return base;
  if (isStructMsgTy(base) && msgLeafOk(base)) return base;
  throw nyi(NYI.ACTOR_MSG, `actor message of type ${base}`);
}

/** The type of a value that is actually PUT ON THE WIRE (a `send`/`spawn` argument, or
 *  a `receiveMatch` predicate's parameter). Unlike a receive ANNOTATION — where
 *  `T | undefined` legitimately means "a T, or a timeout" — a nullable is not unwrapped
 *  here: `T | undefined` is a two-slot tagged BOX, so sending one would put the box
 *  pointer on the wire for a receiver expecting a T. A message is always present, so
 *  unwrap it first (`send(pid, x ?? fallback)`). */
export function actorSendTy(t: Ty): Ty {
  if (isNullableTy(t))
    throw nyi(NYI.ACTOR_MSG, `actor message of type \`${baseTy(t)} | ${nullishKind(t)}\` (a message is always present — unwrap it first, e.g. \`send(pid, x ?? fallback)\`)`);
  return actorMsgTy(t);
}

export function check(program: Program): CheckedProgram {
  const functions = new Map<string, Sig>();
  // Value bindings this module imports. A linked program has none left (the linker
  // rewrites them to concrete names), so this is populated only for a single-module
  // check — where it turns "unknown callee" into "you did not link".
  const importedFrom = new Map<string, string>();
  for (const im of program.imports ?? [])
    for (const s of im.specs ?? []) if (!s.typeOnly) importedFrom.set(s.local, im.source);
  const c = new Checker(functions, mutableTags(program), new Set(program.mutableRecords ?? []), new Set(program.hostImports ?? []), importedFrom);
  const builtins = () => {
    const s = new Scope();
    for (const n of BUILTIN_NUMBERS) s.declare(n, "number", true);
    return s;
  };
  /**
   * The MODULE scope — top-level bindings, and the parent of every function scope
   * (SH1: a module's functions must see its module-level `const`s, most visibly an
   * imported module's `export const` read from an imported function).
   */
  const moduleScope = builtins();
  // Narrowing: a name some arrow (or nested function) assigns to can change at any time
  // after a guard proved it non-nullish, so it is never narrowed. TypeScript's rule, for
  // the same reason (`narrowingPastLastAssignment.ts`, function `f3`).
  c.noteClosureAssignments(program.body);
  // M3: a generic declaration is a TEMPLATE, not a function. Register it with the
  // monomorphizer instead of the signature table; it is never checked or emitted as
  // written — only its specializations are (and a generic nobody calls emits nothing).
  // Its scope factory is the MODULE scope (lazily), so a generic body sees module-level
  // bindings and imports exactly like an ordinary function does.
  for (const s of program.body) {
    if (s.kind === "FuncDecl" && s.typeParams?.length) c.declareGeneric(s, () => moduleScope.child());
  }

  for (const s of program.body) {
    if (s.kind !== "FuncDecl" || s.typeParams?.length) continue;
    if (functions.has(s.name)) throw typeError(`Duplicate function '${s.name}'`);
    let rest = false;
    s.params.forEach((p, i) => { if (p.rest) { if (i !== s.params.length - 1) throw typeError("rest parameter must be last"); rest = true; } });
    const params = s.params.map((p) => p.annot ?? (p.default ? c.type(p.default, builtins()) : "number"));
    // An ANNOTATED default is typed later, by `checkFunction`, against the MODULE scope —
    // it may name a module-level const, which does not exist yet at this point in the
    // pass. That re-typing is what sets its `.ty` for codegen and gives an empty-array
    // default `[]` its element type from the annotation (`function f(a: T[] = [])`).
    const fixed = rest ? s.params.length - 1 : s.params.length;
    const required = s.params.slice(0, fixed).filter((p) => !p.default).length;
    const defaults = s.params.map((p) => p.default ?? null);
    const ret = s.returnAnnot ?? "number";
    s.returnTy = ret;
    functions.set(s.name, { params, ret, required, defaults, rest });
    if (s.isStatic) c.statics.add(s.name); // `static m()` → reachable only as `C.m(…)`
  }

  // pass 1.5: pre-declare the module-level bindings, so return-type inference and
  // function bodies can see them. Best-effort: an initializer we cannot type yet
  // (e.g. one calling a function whose return type pass 2 has not inferred) is
  // simply skipped here — `checkBlock` below re-declares every one with its final
  // type, which is what the promoted-globals table is read from.
  for (const s of program.body) {
    if (s.kind !== "VarDecl") continue;
    for (const d of s.decls) {
      try {
        // No initializer to infer from: the annotation IS the type (`let x: T;`), and
        // with no annotation either (`let x;`) the type is `undefined` — the same answer
        // the synthesized initializer used to give.
        const t = d.annot ?? (d.init ? c.type(d.init, moduleScope) : "undefined");
        moduleScope.declare(d.name, t, s.declKind === "const");
      } catch { /* typed for real in checkBlock */ }
    }
  }

  // pass 2: infer return types for unannotated functions (e.g. ones returning closures)
  for (const s of program.body) {
    if (s.kind === "FuncDecl" && !s.typeParams?.length && !s.returnAnnot) {
      const inferred = c.inferReturnType(s, moduleScope.child());
      s.returnTy = inferred;
      functions.get(s.name)!.ret = inferred;
    }
  }

  c.bodyChain = [program.body]; // the outermost enclosing body, for NT1031
  c.checkBlock(program.body, moduleScope);
  // Only reads made from INSIDE a function body promote a module binding to a global,
  // so clear the top level's own hits before checking the functions.
  moduleScope.hits.clear();
  for (const s of program.body) if (s.kind === "FuncDecl" && !s.typeParams?.length) c.checkFunction(s, moduleScope.child());
  // M3: check every specialization that got instantiated above (checking one body can
  // instantiate more generics, so drain to a fixpoint), then SPLICE the templates out of
  // the program and the concrete specializations in — from here on the rest of the
  // pipeline (ownership, drops, codegen) sees only ordinary functions. This runs BEFORE
  // the globals table is read: a specialization's body can be the only reader of a
  // module-level binding, and that read must still promote it to a global.
  c.drainInstantiations(() => moduleScope.child());
  program.body = [
    ...program.body.filter((s) => !(s.kind === "FuncDecl" && s.typeParams?.length)),
    ...c.specializations(),
  ];
  // Belt-and-braces: a `#T` marker has no lowering, so if one somehow survived
  // specialization it must be REJECTED here, never handed to codegen.
  mapTypesDeep(program.body, (t) => {
    if (hasTypeParam(t)) throw nyi(NYI.GENERIC, `unresolved generic type parameter '${t}' survived monomorphization`);
    return t;
  });
  // Definite assignment runs LAST: it reads `Declarator.init`, and `checkStmt` above is
  // what materializes that initializer for the types which admit `undefined`. Running it
  // on the final body also covers every generic specialization just spliced in.
  checkDefiniteAssignment(program.body);

  const globals = new Map<string, Ty>();
  for (const name of moduleScope.hits) {
    if (BUILTIN_NUMBERS.includes(name)) continue; // NaN/Infinity are constants, not storage
    const b = moduleScope.own(name);
    if (b) globals.set(name, b.ty);
  }
  return { program, functions, globals };
}

/** Expansion budget — a monomorphizable program needs a handful; only polymorphic
 *  recursion (an unbounded family of instantiations) can reach this. */
const MAX_INSTANTIATIONS = 200;

/** Clone a generic template into a fully-concrete specialization named `name`. */
function specializeDecl(tmpl: FuncDecl, name: string, bindings: Map<string, Ty>): FuncDecl {
  // `typeParams: undefined` is what CLEARS the field — there is deliberately no
  // `delete spec.typeParams` here. Every reader is `s.typeParams?.length` or
  // `tmpl.typeParams!` on the template, so undefined and absent are the same thing at
  // every use site; and `delete` is refused by this very compiler (NT1606), so writing
  // it would plant a self-hosting blocker in the file that emits the diagnostic.
  const spec = structuredClone({ ...tmpl, name, typeParams: undefined }) as FuncDecl;
  mapTypesDeep(spec, (t) => substTypeParams(t, bindings));
  return spec;
}

/**
 * Key ENUMERATION needs a runtime key set; we only have a compile-time one.
 *
 * An object here is a flat slot array whose field list comes from its TYPE
 * (`objectFields`), so `Object.keys`/`for-in` lower to a constant string array. node
 * decides the key set per VALUE at runtime, and an OPTIONAL field is exactly where the
 * two part company: `f({})` and `f({a: 1})` reach the same call site with the same
 * static type and different correct answers, so there is no compile-time answer to give.
 *
 * This used to print the declared key list regardless — `Object.keys({b: 2})` on
 * `{a?: number, b: number}` returned `["a","b"]` where node returns `["b"]`, exit 0 on
 * both sides. A silent wrong answer, so it is a refusal now.
 *
 * Only the `?U` (undefined) arm is refused. A `?N` field (`a: T | null`) always HAS its
 * key in node, so the static answer is already right and stays accepted.
 */
/**
 * Render an annotation the way the SOURCE spells it: the erased type's arguments under
 * the identifier actually written. `Record<K,V>` erases to `Map<K,V>`, so a mismatch
 * built from the erasure alone reported a `Map` to an author who wrote `Record` and sent
 * them looking for a type that is nowhere in their file.
 */
function asWritten(annot: Ty, head: string | undefined): string {
  const a = String(annot);
  if (head === undefined || a.startsWith(head)) return a;
  const lt = a.indexOf("<");
  return lt < 0 ? a : `${head}${a.slice(lt)}`; // an alias erasing to a shape keeps the shape
}

/**
 * The `Record`-specific half of that diagnostic: say WHY the erasure exists and name the
 * two real fixes. Only fires for a `Record` annotation initialized with an object
 * literal, which is the shape TypeScript accepts and this compiler cannot.
 */
function dictHint(annot: Ty, head: string | undefined, got: Ty): string | undefined {
  if (head !== "Record" || !isMapTy(annot) || !isObjectTy(got)) return undefined;
  const k = mapKeyTy(annot), v = mapValTy(annot);
  const fs = objectFields(got);
  const sample = fs.length > 0 ? fs[0]!.key : "k";
  return `\`Record<${k}, ${v}>\` is compiled as \`Map<${k}, ${v}>\` here — a dictionary with RUNTIME keys — because an object's fields are fixed slots named by its TYPE, ` +
    `and a \`Record\`'s key set is by definition not statically known. An object literal cannot initialize one. ` +
    `Build it with \`new Map<${k}, ${v}>().set("${sample}", …)\` and read it with \`.get(k)\`. ` +
    `Annotating the exact shape instead (\`{ ${sample}: ${v} }\`) also works, but ONLY if every read uses a LITERAL key — an object is indexed by a string literal here, so \`o[someVariable]\` stays refused`;
}

function enumerableOrThrow(ot: Ty, what: string, forIn = false): void {
  const opt = objectFields(ot).find((f) => isNullableTy(f.ty) && nullishKind(f.ty) === "undefined");
  if (opt === undefined) return;
  throw nyi(
    forIn ? NYI.FOR_IN : NYI.OBJECT,
    `${what} of an object with the optional field '${opt.key}'`,
    "a key set is decided at compile time here (from the TYPE), but node decides it per value at runtime — `{}` and " +
    `\`{${opt.key}: …}\` share this type and have different key sets, so there is no answer to give. ` +
    `Read the field instead (\`o.${opt.key} !== undefined\`), or make it REQUIRED and assign \`undefined\` when it is missing. ` +
    `Note that \`${opt.key}: T | undefined\` is encoded exactly like \`${opt.key}?: T\` here, so it is refused too even though its key is always present in node`,
  );
}

/**
 * One type argument, spelled so it is safe inside an LLVM symbol name: every character
 * outside `[A-Za-z0-9_]` becomes `_`. Was `t.replace(/[^A-Za-z0-9_]/g, "_")` — nativets
 * refuses `RegExp` on principle (NT1027), so the compiler's own source scans characters.
 * The rewrite is pinned against the original in `test/no-regex.test.ts`.
 *
 * Two things the class must get exactly right, both pinned there:
 *  - `$` is NOT in it. `$` is the mangler's own separator (`f$number$string`), so a `$`
 *    inside a type has to collapse to `_` or two instantiations could collide. `\w` and
 *    `ast.ts`'s `isIdentPart` differ on precisely this character.
 *  - the scan is by UTF-16 CODE UNIT, like the flagless regex it replaces — so a non-BMP
 *    character yields TWO underscores and the length is preserved. `for (const c of t)`
 *    would iterate code points and quietly produce one.
 */
function mangleTypeArg(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    const word = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
    out += word ? c : "_";
  }
  return out;
}

class Checker {
  private loopDepth = 0;
  private switchDepth = 0;
  /**
   * The function-like bodies enclosing the node being checked, outermost first — the
   * module top level, then each function/method body, then each arrow body. Only
   * `checkCapturedWrites` (NT1031) reads it: deciding whether a closure's write to a
   * capture is observable means asking whether anything OUTSIDE the closure still
   * mentions the binding, and a scope chain records names, not the code that uses them.
   * Public so `check()` can seed it with the module body.
   */
  bodyChain: Stmt[][] = [];
  /**
   * Call nodes allowed to be a Map/Set ITERATOR (`m.keys()/.values()/.entries()`).
   * node returns a lazy Iterator object there; we return a real array, so the two
   * agree exactly in `for-of` / `[...it]` / `Array.from(it)` and nowhere else
   * (`it.length` is 2 for us, `undefined` in node). Rather than diverge silently,
   * the iterator is only typed in those three positions — anywhere else it is an
   * NT1014 rejection. This set records the positions as they are checked.
   */
  private iterOk = new Set<Expr>();
  /**
   * `static` class methods, by their LOWERED name (`C.m`). A static has no receiver, so
   * `C.m(a)` is a direct call to the lowered function — and an INSTANCE method, which
   * lowers to the same shape of name, must NOT be reachable that way (in node a class
   * object has no such property, so calling it is a TypeError, never a receiver-less call).
   */
  readonly statics = new Set<string>();
  constructor(
    private functions: Map<string, Sig>,
    /** Tags whose values mutate IN PLACE — `@@mutable` classes and `@@mutable` records.
     *  Empty for every program that does not use the attribute, which is what keeps
     *  `o.f = v` rejected exactly as it was before (Stage 29). */
    private mutable: Set<string> = new Set(),
    /** Just the `@@mutable` RECORD tags. A record has no constructor — its values come
     *  from object LITERALS — so a literal must be able to take the tag from its context.
     *  Class tags are deliberately excluded: an instance comes from `new C(…)`. */
    private recordTags: Set<string> = new Set(),
    /** Host builtins (SH4) brought into scope by a `node:` import. Empty unless the
     *  program imported one, so `readFileSync` is an ordinary undefined name — and a
     *  user function of that name — in every program that did not. */
    private hostImports: Set<string> = new Set(),
    /** Local name → the module specifier it was imported from, for a program that has NOT
     *  been linked. Empty after linking (the linker rewrites the bindings), so this only
     *  ever improves the diagnostic for a single-module check — it never accepts a call. */
    private importedFrom: Map<string, string> = new Map(),
  ) {}

  /** The tagged record type a literal should take from its context, if any. */
  private contextualRecordTy(hint: Ty | undefined): Ty | undefined {
    if (hint === undefined || !this.recordTags.size) return undefined;
    const base = baseTy(hint);
    const tag = classTag(base);
    return tag !== undefined && this.recordTags.has(tag) ? base : undefined;
  }

  /**
   * May a field of `ot` be assigned in place? Only for a value whose type carries a
   * `@@mutable` tag — a class instance (Stage 45) or a `@@mutable` record (this lane).
   * Mutability is NOMINAL: a structurally identical undecorated record has no tag, so it
   * stays immutable and keeps the NT1606 rejection with the spread hint.
   */
  private isMutableTy(ot: Ty): boolean {
    if (!this.mutable.size || !isObjectTy(ot)) return false;
    const tag = classTag(ot);
    return tag !== undefined && this.mutable.has(tag);
  }

  /* ============================================================
   * Control-flow narrowing of nullable BINDINGS (A2 follow-on).
   *
   * `x!` narrowed the EXPRESSION only. Having PROVED on this path that `x` is not
   * nullish, every later read of `x` on that path should see the base type instead of
   * the `?U`/`?N` tagged pair — `if (x !== undefined) { x + 1 }` is the idiomatic TS
   * spelling and used to be a type error.
   *
   * A narrowing is a stack of FRAMES, each a set of facts scoped to a region (an `if`
   * branch, the rest of a block after an early exit, the right operand of `&&`). A fact
   * names the BINDING OBJECT, not the name, so an inner declaration that shadows the
   * name is unaffected. Reads consult the innermost frame.
   *
   * What a fact is ABOUT is an access PATH, not only a name: `diag.spans` narrows just
   * like `x` does (TypeScript's `discriminantPropertyCheck.ts`). A dotted path is only
   * eligible when every object along it is IMMUTABLE — nativets objects are immutable by
   * default and only a `@@mutable` tag can rewrite a field in place, so outside that tag
   * the single way `d.spans` can change is a new value bound to `d`, which the
   * assigned-name filter below already catches. A `@@mutable` object, and `this` (a
   * constructor/setter may write through it), get no path facts at all.
   *
   * Two rules keep it sound (the model is TypeScript's own, `narrowingPastLastAssignment.ts`):
   *   - a fact is dropped if the region ASSIGNS to that name anywhere (including inside
   *     an arrow in it), so a loop back-edge can never observe a stale narrowing;
   *   - a `let` fact does not survive into an inner function body — a closure may run
   *     after a later assignment. `const` facts do (they cannot be invalidated).
   * A name assigned inside ANY arrow in the program is never narrowed at all, which is
   * TypeScript's rule for the same reason.
   *
   * When the analysis is nonetheless wrong the read unwraps a nullish box, which PANICS
   * exactly like a false `!` assertion (see codegen's `NonNullExpr`) — never a phantom
   * value.
   * ============================================================ */

  /** One proved fact: this access path is not nullish here, so it reads as `ty`. */
  private narrowStack: NarrowFact[][] = [];
  /** Nesting depth of arrow bodies being typed (a `let` narrowing stops at depth+1). */
  private arrowDepth = 0;
  /** Names assigned inside SOME arrow body anywhere in the program — never narrowable. */
  private closureAssigned = new Set<string>();

  /** Record the program's closure-assigned names (see the note above). */
  noteClosureAssignments(body: Stmt[]): void {
    const direct = new Set<string>();
    collectAssignedStmts(body, direct, this.closureAssigned, false);
  }

  /** The narrowed type of the path `b` + `path` here, or undefined if no fact covers it. */
  private narrowedTy(b: Binding, path: string): Ty | undefined {
    for (let i = this.narrowStack.length - 1; i >= 0; i--) {
      for (const f of this.narrowStack[i]!) {
        if (f.binding !== b || f.path !== path) continue;
        return !f.constant && this.arrowDepth > f.arrowDepth ? undefined : f.ty;
      }
    }
    return undefined;
  }

  /**
   * The access path `e` denotes, if it is one: a plain name, or a chain of ordinary field
   * reads over one. Each step reports the type ALREADY NARROWED at that step, so
   * `!a || !a.b || a.b.c` can walk through `a`'s own fact to reach `a.b`.
   *
   * Refused (so no fact is ever recorded for them): `this` and `@@mutable` receivers,
   * whose fields can be rewritten in place; a `?.` link, whose result is a fresh nullable
   * rather than the field itself; and anything computed (a call, an index), which is not
   * a stable name for a value.
   */
  private accessPath(e: Expr, scope: Scope): AccessPath | undefined {
    if (e.kind === "Identifier") {
      if (e.name === "this") return undefined;
      const b = scope.lookup(e.name);
      if (!b) return undefined;
      return { name: e.name, binding: b, path: "", ty: this.narrowedTy(b, "") ?? b.ty };
    }
    if (e.kind !== "MemberExpr" || e.optional === true) return undefined;
    const base = this.accessPath(e.object, scope);
    if (base === undefined) return undefined;
    if (!isObjectTy(base.ty) || this.isMutableTy(base.ty)) return undefined;
    const ft = fieldType(base.ty, e.property);
    if (ft === undefined) return undefined;
    const path = base.path + "." + e.property;
    return { name: base.name, binding: base.binding, path, ty: this.narrowedTy(base.binding, path) ?? ft };
  }

  /**
   * Type an arrow body with `let` narrowings suspended (they do not cross the boundary).
   *
   * Concrete, not generic, like the two below: a generic METHOD is still an NT1015 in the
   * subset the compiler can compile ITSELF in, and `test/self-host-coverage.test.ts`
   * measures exactly that — a generic here would push the file's real frontier out of view.
   */
  private inArrow(f: () => Ty): Ty {
    this.arrowDepth++;
    try { return f(); } finally { this.arrowDepth--; }
  }

  /** Type an expression with `facts` in scope. */
  private withFacts(facts: NarrowFact[], f: () => Ty): Ty {
    this.narrowStack.push(facts);
    try { return f(); } finally { this.narrowStack.pop(); }
  }

  /**
   * Check statements with `facts` in scope. `finally` matters: `coverage` keeps going
   * after a rejected statement, so a diagnostic thrown mid-branch must not leave a stale
   * frame behind for the next one.
   */
  private withFactsIn(facts: NarrowFact[], f: () => void): void {
    this.narrowStack.push(facts);
    try { f(); } finally { this.narrowStack.pop(); }
  }

  /**
   * The facts `test` establishes for `region`, where `region` is the code they cover:
   * the guard's own facts on the branch selected by `positive`, plus any `x!` assertion
   * evaluated unconditionally in the test (which holds on BOTH branches). Facts about a
   * name the region assigns are dropped.
   *
   * The GUARD ITSELF is scanned for assignments too, not just the region: in
   * `!x || (x = y) !== undefined || x.length === 0` the assignment runs BETWEEN the proof
   * and the use, so by `x.length` the binding holds something the proof was never about
   * (TypeScript refuses the same shape — `typeGuardsInRightOperandOfOrOrOperator.ts`,
   * `foo2`). Evaluation order inside the guard is not modeled, so ANY assignment in it
   * drops the fact: over-conservative, never wrong.
   */
  private factsFor(test: Expr, scope: Scope, positive: boolean, region: Stmt[], guards = true): NarrowFact[] {
    const out: NarrowFact[] = [];
    if (guards) this.guardFacts(test, scope, positive, out);
    this.assertFacts(test, scope, out);
    if (!out.length) return out;
    const assigned = new Set<string>();
    collectAssignedStmts(exprRegion(test), assigned, assigned, false);
    collectAssignedStmts(region, assigned, assigned, false);
    return out.filter((f) => !assigned.has(f.name) && !this.closureAssigned.has(f.name));
  }

  /**
   * Facts from the guard itself: an equality against the matching nullish literal, or a
   * bare TRUTHINESS test. A truthy value is never nullish (the nullish tags are the two
   * falsiest things there are), so `if (x)` proves the same thing `x !== undefined` does
   * — TypeScript's `controlFlowTruthiness.ts`. Only the positive branch narrows: `0`,
   * `""` and `false` are falsy while present, so the else branch proves nothing.
   */
  private guardFacts(e: Expr, scope: Scope, positive: boolean, out: NarrowFact[]): void {
    switch (e.kind) {
      case "Identifier":
      case "MemberExpr":
        if (positive) this.addFact(e, scope, null, out);
        return;
      case "BinaryExpr": {
        const ne = e.op === "!==" || e.op === "!=";
        const eq = e.op === "===" || e.op === "==";
        if (!ne && !eq) return;
        // `typeof x === "number"` on a GENERAL union. Unlike the nullish tests below it
        // narrows on BOTH polarities — the arms are a closed set, so ruling one out is
        // as informative as picking one. `positive === eq` is "the tag matched".
        this.typeofFacts(e, scope, positive === eq, out);
        // The value is non-nullish on the TRUE branch of `!==` and the FALSE branch of `===`.
        if (positive !== ne) return;
        for (const [v, lit] of [[e.left, e.right], [e.right, e.left]] as [Expr, Expr][]) {
          // Both operand orders narrow — TypeScript's
          // `nullOrUndefinedTypeGuardIsOrderIndependent.ts` asserts exactly that.
          const lt = (lit as { ty?: Ty }).ty;
          if (lt === "undefined" || lt === "null") this.addFact(v, scope, lt, out);
        }
        return;
      }
      case "LogicalExpr":
        // `a && b` proves both when true; `a || b` proves both when false (De Morgan).
        if ((e.op === "&&") === positive && e.op !== "??") {
          this.guardFacts(e.left, scope, positive, out);
          this.guardFacts(e.right, scope, positive, out);
        }
        return;
      case "UnaryExpr":
        if (e.op === "!") this.guardFacts(e.operand, scope, !positive, out);
        return;
      case "CallExpr":
        // `Array.isArray(v)` — the idiomatic discriminant for an array arm, and the
        // same closed-set reasoning as `typeof`: it narrows on both branches.
        this.isArrayFacts(e, scope, positive, out);
        return;
      default:
        return;
    }
  }

  /** `Array.isArray(x)` narrowing a general union — see `typeofFacts` for the rules.
   *  Takes a plain `Expr` and re-tests `kind`: an `Expr & { kind: … }` intersection is
   *  outside the subset we compile, and writing one here would add a self-host blocker
   *  to our own source (which is exactly how this was caught). */
  private isArrayFacts(e: Expr, scope: Scope, matched: boolean, out: NarrowFact[]): void {
    if (e.kind !== "CallExpr") return;
    const c = e.callee;
    if (c.kind !== "MemberExpr" || c.property !== "isArray") return;
    if (c.object.kind !== "Identifier" || c.object.name !== "Array" || scope.lookup("Array")) return;
    if (e.args.length !== 1) return;
    const p = this.accessPath(e.args[0]!, scope);
    if (p === undefined || !isGeneralUnionTy(p.ty)) return;
    const keep = generalUnionMembers(p.ty).filter((m) => isArrayTy(m) === matched);
    if (keep.length !== 1) return;
    if (out.some((f) => f.binding === p.binding && f.path === p.path)) return;
    out.push({ name: p.name, binding: p.binding, path: p.path, ty: keep[0]!, constant: p.binding.constant, arrowDepth: this.arrowDepth });
  }

  /**
   * `x!` assertions evaluated UNCONDITIONALLY by `e` — the fact survives the expression
   * (`m! && m[0]`, TypeScript's `narrowingWithNonNullExpression.ts`), because a false
   * assertion never returns. Conditional positions (a `&&`/`||`/`??` right operand, a
   * `?:` arm, an arrow body) are skipped: they may not run.
   */
  private assertFacts(e: Expr, scope: Scope, out: NarrowFact[]): void {
    const go = (x: Expr) => this.assertFacts(x, scope, out);
    switch (e.kind) {
      case "NonNullExpr":
        this.addFact(e.expr, scope, null, out);
        go(e.expr);
        return;
      case "MemberExpr": go(e.object); return;
      case "IndexExpr": go(e.object); go(e.index); return;
      case "UnaryExpr": go(e.operand); return;
      case "TypeofExpr": go(e.operand); return;
      case "AsExpr": case "SatisfiesExpr": go(e.expr); return;
      case "InstanceOfExpr": go(e.object); return;
      case "BinaryExpr": go(e.left); go(e.right); return;
      case "LogicalExpr": go(e.left); return; // the right operand is conditional
      case "ConditionalExpr": go(e.test); return; // ditto the arms
      case "SequenceExpr": e.exprs.forEach(go); return;
      case "TemplateLiteral": e.exprs.forEach(go); return;
      case "CallExpr": go(e.callee); e.args.forEach(go); return;
      case "ArrayLiteral": e.elements.forEach(go); return;
      case "SpreadExpr": go(e.argument); return;
      default: return;
    }
  }

  /**
   * Add "this access path is not nullish" — but only when the test can actually prove it,
   * and only for something that IS a path (anything else is silently no fact). A nullable
   * carries ONE nullish arm, so comparing a `T | null` against `undefined` proves nothing
   * (the tags never match); `kind` is the literal that was compared against, or null for a
   * truthiness test / `!` assertion, which prove it outright.
   */
  private addFact(e: Expr, scope: Scope, kind: Ty | null, out: NarrowFact[]): void {
    const p = this.accessPath(e, scope);
    if (p === undefined || !isNullableTy(p.ty)) return;
    if (kind !== null && nullishKind(p.ty) !== kind) return;
    if (out.some((f) => f.binding === p.binding && f.path === p.path)) return;
    out.push({ name: p.name, binding: p.binding, path: p.path, ty: baseTy(p.ty), constant: p.binding.constant, arrowDepth: this.arrowDepth });
  }

  /**
   * `typeof x === "number"` against a GENERAL union — the only discriminant it has.
   *
   * `matched` says whether this branch is the one where the tag equalled the literal.
   * The arms are a closed set, so both branches narrow: the matching one to the arms
   * with that `typeof`, the other to the arms without it.
   *
   * A fact is only recorded when the surviving set is a SINGLE arm. A 3-arm union's
   * else branch is a 2-arm SUB-union, whose tags are renumbered against its own
   * canonical member order — narrowing to it would need the box retagged, so instead
   * the binding simply stays the full union (still printable, still tag-correct) and
   * any arm-specific use of it is refused. Conservative, never wrong.
   */
  private typeofFacts(e: BinaryExpr, scope: Scope, matched: boolean, out: NarrowFact[]): void {
    for (const [t, lit] of [[e.left, e.right], [e.right, e.left]] as [Expr, Expr][]) {
      if (t.kind !== "TypeofExpr" || lit.kind !== "StringLiteral") continue;
      const p = this.accessPath(t.operand, scope);
      if (p === undefined || !isGeneralUnionTy(p.ty)) continue;
      const keep = generalUnionMembers(p.ty).filter((m) => (typeofTagOf(m) === lit.value) === matched);
      if (keep.length !== 1) continue;
      if (out.some((f) => f.binding === p.binding && f.path === p.path)) continue;
      out.push({ name: p.name, binding: p.binding, path: p.path, ty: keep[0]!, constant: p.binding.constant, arrowDepth: this.arrowDepth });
    }
  }

  /** The narrowed type for the path `e` reads here, if a fact covers it. */
  private narrowedPath(e: Expr, scope: Scope): Ty | undefined {
    const p = this.accessPath(e, scope);
    return p === undefined ? undefined : this.narrowedTy(p.binding, p.path);
  }

  /**
   * A guard whose taken branch always EXITS narrows the binding for the REST of the
   * block — `if (x === undefined) return;`. Modeled on TypeScript's
   * `controlFlowIfStatement.ts` (function `a`, where the `else` returns).
   */
  private exitGuardFacts(s: Stmt, scope: Scope, rest: Stmt[]): NarrowFact[] {
    if (s.kind !== "IfStmt" || !rest.length) return [];
    const consExits = alwaysExits(s.consequent);
    const altExits = !!s.alternate && alwaysExits(s.alternate);
    if (consExits === altExits) return []; // neither, or both (the rest is unreachable)
    return this.factsFor(s.test, scope, altExits, rest);
  }

  /* ============================================================
   * M3 — monomorphization of generic functions.
   *
   * (The type-argument spelling used by the mangler is `mangleTypeArg`, just above this
   * class — nativets has no RegExp, so the compiler's own source scans characters.)
   *
   * A generic `function f<T>(x: T): T` is a TEMPLATE: it is never checked or emitted as
   * written (its annotations carry `#T` markers, which have no lowering). Instead, every
   * call site resolves a concrete type-argument tuple — from explicit call-site type args
   * (`f<string>(…)`) or by unifying the parameter patterns against the argument types —
   * and gets rewritten to call a SPECIALIZATION: a clone of the template with `#T`
   * substituted throughout, registered under a mangled name (`f$string`).
   *
   * Instantiations are memoized on (function, type-tuple), so a self-recursive call at
   * the same instantiation reuses the in-progress specialization instead of expanding
   * forever. Bodies are checked in a drain loop AFTER registration, which is what makes
   * the recursive case terminate.
   * ============================================================ */

  /** Templates by name (declared generics), plus the builtin-scope factory to check with. */
  private generics = new Map<string, FuncDecl>();
  private genericBase: (() => Scope) | null = null;
  /** (name, type-tuple) → mangled specialization name. */
  private instances = new Map<string, string>();
  /** Specializations in emission order, and the queue of ones whose body is unchecked. */
  private specialized: FuncDecl[] = [];
  private pending: FuncDecl[] = [];

  declareGeneric(fn: FuncDecl, base: () => Scope): void {
    if (this.generics.has(fn.name) || this.functions.has(fn.name)) throw typeError(`Duplicate function '${fn.name}'`);
    this.generics.set(fn.name, fn);
    this.genericBase = base;
  }
  specializations(): FuncDecl[] { return this.specialized; }

  /** Check every queued specialization body; checking one may enqueue more. */
  drainInstantiations(base: () => Scope): void {
    while (this.pending.length) {
      const fn = this.pending.shift()!;
      this.checkFunction(fn, base());
    }
  }

  /** A mangled, LLVM-safe, collision-free name for one instantiation (`first$string__`). */
  private mangle(base: string, args: Ty[]): string {
    const stem = `${base}$${args.map(mangleTypeArg).join("$")}`;
    let name = stem, n = 2;
    while (this.functions.has(name) || this.generics.has(name)) name = `${stem}_${n++}`;
    return name;
  }

  /**
   * Resolve the type arguments for a call to generic `name`, instantiate (or reuse) the
   * matching specialization, REWRITE the call's callee to it, and return its signature.
   * The caller then type-checks the arguments against that fully-concrete signature, so
   * an argument mismatch is reported exactly like any ordinary call.
   */
  private instantiate(name: string, e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope, recvOffset = 0): Sig {
    const tmpl = this.generics.get(name)!;
    const tps = tmpl.typeParams!;
    const bindings = new Map<string, Ty>();
    // A generic METHOD is the same template with a leading `this` parameter that no
    // argument corresponds to (`recvOffset` 1). Drop it before matching arguments to
    // parameters so every index below is a plain positional match, exactly as for a
    // function. `this` is never generic, so it can never carry a binding.
    const sigParams = tmpl.params.slice(recvOffset);
    const what = recvOffset ? "generic method" : "generic function";

    if (e.typeArgs?.length) {
      // Explicit call-site type args pin the instantiation positionally.
      if (e.typeArgs.length > tps.length) throw typeError(`'${name}' takes ${tps.length} type argument(s), got ${e.typeArgs.length}`);
      e.typeArgs.forEach((t, i) => bindings.set(tps[i]!, t));
    }
    const patterns = sigParams.map((p) => p.annot ?? "number");
    // Round 1 — plain arguments. An ARROW argument is deferred: it needs the (possibly
    // still-unbound) parameter pattern as its contextual type before it can be typed.
    e.args.forEach((a, i) => {
      const pat = patterns[Math.min(i, patterns.length - 1)];
      if (!pat || !hasTypeParam(pat) || a.kind === "ArrowFunction") return;
      unifyTypeParams(sigParams[i]?.rest ? elemTy(pat) : pat, this.type(a, scope), bindings);
    });
    // Round 2 — arrow arguments, now that the other parameters have bound what they can:
    // `mapAll<T, U>(xs: T[], f: (t: T) => U)` learns T from `xs`, types the arrow with
    // `(number) => ?`, and learns U from the arrow's inferred return type.
    e.args.forEach((a, i) => {
      const pat = patterns[i];
      if (a.kind !== "ArrowFunction" || !pat || !hasTypeParam(pat)) return;
      const ctx = substTypeParams(pat, bindings);
      if (!isFuncTy(ctx) || funcParams(ctx).some(hasTypeParam)) return; // params still unknown → reported below
      unifyTypeParams(pat, this.typeArrow(a, ctx, scope), bindings);
    });

    const missing = tps.filter((t) => !bindings.has(t));
    if (missing.length) {
      throw nyi(NYI.GENERIC, `cannot infer type argument${missing.length > 1 ? "s" : ""} ${missing.map((m) => `'${m}'`).join(", ")} for ${what} '${name}'; pass them explicitly (\`${name}<${tps.join(", ")}>(…)\`)`);
    }
    const typeArgs = tps.map((t) => bindings.get(t)!);
    for (const t of typeArgs) {
      if (hasTypeParam(t)) throw nyi(NYI.GENERIC, `${what} '${name}' instantiated with an unresolved type parameter (nested generics are not supported)`);
    }

    const key = `${name}|${typeArgs.join("|")}`;
    const memo = this.instances.get(key);
    if (memo) { this.retarget(e, memo, recvOffset); return this.functions.get(memo)!; }

    // POLYMORPHIC RECURSION (`f<T>` calling `f<T[]>`) has no finite monomorphization —
    // each level demands a strictly bigger type. Memoization can't see it (every key is
    // new), so cap the expansion and reject rather than diverge.
    if (this.specialized.length >= MAX_INSTANTIATIONS) {
      throw nyi(NYI.GENERIC, `too many generic instantiations while specializing '${name}' (>${MAX_INSTANTIATIONS}); a generic that calls itself at a DIFFERENT type argument (polymorphic recursion) cannot be monomorphized`);
    }
    const mangled = this.mangle(name, typeArgs);
    this.instances.set(key, mangled); // BEFORE cloning — self-recursion resolves here
    const spec = specializeDecl(tmpl, mangled, bindings);
    const params: Ty[] = spec.params.map((p) => p.annot ?? (p.default ? this.type(p.default, this.genericBase!()) : "number"));
    spec.params.forEach((p, i) => { if (p.default && p.annot) this.type(p.default, this.genericBase!(), params[i]); });
    const fixed = spec.params.length - (spec.params.at(-1)?.rest ? 1 : 0);
    const sig: Sig = {
      params,
      ret: spec.returnAnnot ?? "number",
      required: spec.params.slice(0, fixed).filter((p) => !p.default).length,
      defaults: spec.params.map((p) => p.default ?? null),
      rest: !!spec.params.at(-1)?.rest,
    };
    spec.returnTy = sig.ret;
    this.functions.set(mangled, sig);
    this.specialized.push(spec);
    if (!spec.returnAnnot) { sig.ret = this.inferReturnType(spec, this.genericBase!()); spec.returnTy = sig.ret; }
    this.pending.push(spec); // body checked in the drain loop (keeps recursion finite)
    this.retarget(e, mangled, recvOffset);
    return sig;
  }

  /**
   * Point a call at its specialization. A FUNCTION call has an Identifier callee, so the
   * name is replaced outright. A METHOD call has a MemberExpr callee, and everything
   * downstream (the checker's own method path, and codegen's `C.m` lookup) rebuilds the
   * symbol as `${classTag(receiver)}.${property}` — so the specialization is selected by
   * rewriting the PROPERTY to the mangled tail (`t` → `t$number`). The receiver
   * expression is left untouched, which is what keeps `this` flowing normally.
   */
  private retarget(e: Extract<Expr, { kind: "CallExpr" }>, mangled: string, recvOffset: number): void {
    if (recvOffset === 0) { (e.callee as { name: string }).name = mangled; return; }
    // `mangled` is the whole dotted symbol (`C.t$number`); a class name cannot contain a
    // `.`, so everything after the first one is the property.
    (e.callee as { property: string }).property = mangled.slice(mangled.indexOf(".") + 1);
  }

  /** Whitelist `e` as an iteration position (see `iterOk`). */
  private markIter(e: Expr): void {
    if (e.kind === "CallExpr" && e.callee.kind === "MemberExpr") this.iterOk.add(e);
  }

  /**
   * An iteration position (`for-of`, `[...x]`, `Array.from(x)`): whitelist an
   * explicit iterator call, and rewrite a Set used DIRECTLY as an iterable to
   * `set.values()` so everything downstream sees a plain array. A Map used
   * directly is refused — node yields `[key, value]` pairs there and we have no
   * tuple type (`for (const [k, v] of m)` is the supported spelling).
   */
  private asIterable(e: Expr, scope: Scope, ctx: string): { expr: Expr; ty: Ty } {
    this.markIter(e);
    const t = this.type(e, scope);
    if (isMapTy(t)) throw nyi(NYI.COLLECTION, `${ctx} over a Map (node yields [key, value] pairs — use \`for (const [k, v] of m)\`, \`m.keys()\` or \`m.values()\`)`);
    if (!isSetTy(t)) return { expr: e, ty: t };
    const call = { kind: "CallExpr", callee: { kind: "MemberExpr", object: e, property: "values" }, args: [] } as Expr;
    this.markIter(call);
    return { expr: call, ty: this.type(call, scope) };
  }

  checkFunction(fn: FuncDecl, base: Scope): void {
    // A default is an expression evaluated at CALL time, in the scope that encloses the
    // function — so it can name a module-level binding (`= NO_MUTABLE`) just like the body
    // can. The signature pass above cannot type it there: it runs before the module
    // bindings exist, so all it has is a builtins-only scope. Type it HERE, where `base`
    // is the module scope, purely to set `.ty` for codegen.
    //
    // Deliberately BEFORE the parameters are declared, so the module scope is all a
    // default can see. `function f(a, b = a)` — a default reading the parameters to its
    // left — is ordinary JavaScript, but codegen materializes defaults before the
    // parameter allocas are stored, so it emits a load from an undefined `%a.addr` and
    // clang rejects the module. Until that is fixed, such a default must keep failing the
    // CHECKER, with an NT2001 naming the parameter, rather than reaching clang.
    for (const p of fn.params) {
      if (!p.default || !p.annot) continue;
      const t = this.type(p.default, base, p.annot);
      // ...and then RESHAPE it to the parameter's slot layout, the same way a declaration's
      // initializer is reshaped. Without this, `function g(o: Opts = {})` materialized the
      // default in the literal's OWN layout — `nt_obj_new(0)`, zero slots — while the body
      // reads slot 0 as a pointer to a nullable box, because that is what `{a?: number}`
      // is. Reading off the end of a 0-slot object: it compiled clean and died at runtime
      // with exit 255 and empty stdout where node printed a value. Guarded by `assignable`
      // so this only ever rewrites a layout, never masks a genuine type mismatch.
      if (this.assignable(p.annot, t)) this.retypeLiteral(p.default, p.annot);
    }
    for (const p of fn.params) base.declare(p.name, p.annot ?? "number", false);
    this.bodyChain.push(fn.body);
    try { this.checkBlock(fn.body, base, fn.returnTy ?? "number"); } finally { this.bodyChain.pop(); }
    this.checkExhaustiveTailSwitch(fn, fn.returnTy ?? "number");
  }

  /**
   * SH2 exhaustiveness. Deliberately exactly as wide as the DEFECT it removes, and no
   * wider: falling out of a `switch` is ordinary JavaScript, and a switch with a
   * statement after it, or with arms that `break`, is code node runs correctly and we
   * must not reject. The one shape that goes WRONG is the switch that is a function's
   * TAIL with every arm returning or throwing: an uncovered member falls off the end of
   * the function, where node yields `undefined` and nativets yields a value (`0` for a
   * `number` return — a pre-existing general divergence). That is a silent wrong answer,
   * and here — uniquely — the compiler knows the complete set of possibilities, so it
   * can name the missing ones instead of guessing.
   *
   * Everything is read off the AST types the checker just filled in, so no scope is
   * needed: `switch (s.kind)`'s receiver carries the un-narrowed union on `.object.ty`.
   */
  private checkExhaustiveTailSwitch(fn: FuncDecl, ret: Ty): void {
    if (ret === "void") return;
    const last = fn.body[fn.body.length - 1];
    if (!last || last.kind !== "SwitchStmt") return;
    const d = last.discriminant;
    if (d.kind !== "MemberExpr" || d.object.ty === undefined || !isUnionTy(d.object.ty)) return;
    const u = d.object.ty;
    if (unionDiscriminant(u)!.key !== d.property) return;
    if (last.cases.some((c) => c.test === null)) return; // a `default` covers everything left
    // Only a switch every arm of which LEAVES the function is one the author wrote to be
    // total; an arm that merely breaks is choosing to fall out, and is left alone. An
    // empty body is fine — it falls into the next case, which is still inside the switch.
    const total = last.cases.every((c, i) => (c.body.length === 0 && i < last.cases.length - 1) || leavesFunction(c.body));
    if (!total) return;
    const covered = new Set(last.cases.map((c) => (c.test && c.test.kind === "StringLiteral" ? c.test.value : "")));
    const missing = unionTagValues(u).filter((v) => !covered.has(v));
    if (missing.length === 0) return;
    throw typeError(
      `'${fn.name}' can fall off its end: this switch over ${showUnion(u)} returns from every case but does not cover ` +
        `${missing.map((v) => `'${d.property}: "${v}"'`).join(", ")} — add ${missing.length === 1 ? "that case" : "those cases"}, ` +
        `a \`default:\`, or a \`return\` after the switch (node would yield \`undefined\` here, which this return type cannot represent)`,
    );
  }

  checkBlock(body: Stmt[], scope: Scope, ret: Ty = "void"): void {
    let pushed = 0;
    for (let i = 0; i < body.length; i++) {
      this.checkStmt(body[i]!, scope, ret);
      // Two INDEPENDENT early-exit narrowings, and a block can want both:
      // nullable facts (`if (x === undefined) return;` — x is present below), and
      // discriminated-union tag elimination (`if (n.kind === "Num") return …;` — the
      // rest of the block sees the remaining members). Different domains, same shape.
      const facts = this.exitGuardFacts(body[i]!, scope, body.slice(i + 1));
      if (facts.length) { this.narrowStack.push(facts); pushed++; }
      this.eliminateAfterEarlyExit(body[i]!, scope);
    }
    for (let i = 0; i < pushed; i++) this.narrowStack.pop();
  }

  /**
   * SH2 narrowing by ELIMINATION — the guard-clause shape, and the second one the
   * compiler's own passes are written in:
   *
   *     if (n.kind === "NumberLiteral") return n.value;
   *     if (n.kind === "Negate") return -evaluate(n.operand);
   *     return n.left …            // narrowed to BinaryExpr by what CANNOT be here
   *
   * An `if` with no `else` whose body always leaves the block means every statement
   * after it runs only when the tag did NOT match, so the rest of the block sees the
   * remaining members. The shadow is declared in the block's OWN scope (not a child),
   * because "from here on" IS the rest of this scope — and the statements before it
   * are already checked, so nothing is retroactively affected.
   */
  private eliminateAfterEarlyExit(s: Stmt, scope: Scope): void {
    if (s.kind !== "IfStmt" || s.alternate) return;
    if (!leavesBlock(s.consequent)) return;
    const t = this.tagTest(s.test, scope);
    if (!t) return;
    const others = unionTagValues(t.union).filter((v) => v !== t.tag);
    this.narrowInto(scope, t.name, t.union, t.negated ? [t.tag] : others);
  }

  /**
   * Structural, optional-aware assignability (A2). A source type is assignable to
   * a target when it is identical, when a non-nullable value flows into a nullable
   * `T | undefined` / `T | null` (or the matching bare `undefined`/`null`), or —
   * for object types — when every REQUIRED target field is present and assignable
   * and every absent target field is optional (nullable). Extra source fields are
   * tolerated (a widening on assignment; excess-property linting is out of scope).
   */
  private assignable(target: Ty, source: Ty): boolean {
    if (target === source) return true;
    // SH2: a union value IS one of its members' object blocks — there is no box — so
    // what flows in must have EXACTLY a member's layout. Deliberately identity, not the
    // structural rule below: a record that is merely structurally compatible with a
    // member could have a different slot layout, and accepting it would miscompile
    // every subsequent field read. (An object LITERAL reaches here already retyped to
    // the member the context selected — see `unionMemberForLiteral`.)
    if (isUnionTy(target)) {
      const members = unionWidenedMembers(target);
      if (isUnionTy(source)) return unionWidenedMembers(source).every((m) => members.includes(m));
      return members.includes(source);
    }
    // A GENERAL union is a box: any arm (or a narrower general union) may flow in.
    if (isGeneralUnionTy(target)) {
      const members = generalUnionMembers(target);
      if (isGeneralUnionTy(source)) return generalUnionMembers(source).every((m) => members.includes(m));
      return members.includes(source);
    }
    if (isNullableTy(target)) {
      const which = nullishKind(target);
      if (source === which) return true;                 // undefined→?U / null→?N
      if (isNullableTy(source)) return this.assignable(baseTy(target), baseTy(source));
      return this.assignable(baseTy(target), source);    // a present value of the base type
    }
    if (isObjectTy(target) && isObjectTy(source)) {
      for (const tf of objectFields(target)) {
        const sf = fieldType(source, tf.key);
        if (sf === undefined) { if (!isNullableTy(tf.ty)) return false; continue; } // absent → must be optional
        if (!this.assignable(tf.ty, sf)) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Retype an object/array literal (recursively) to the annotated target shape so
   * codegen builds the declared slot layout — filling optional fields the literal
   * omits and boxing scalar field values into their nullable field type. Only
   * reshapes when the literal is assignable to the target.
   */
  private retypeLiteral(e: Expr, target: Ty): void {
    const base = baseTy(target);
    if (e.kind === "ObjectLiteral" && isObjectTy(base)) {
      e.ty = base;
      for (const p of e.properties) {
        if (p.spread) continue;
        const ft = fieldType(base, p.key);
        if (ft) this.retypeLiteral(p.value, ft);
      }
    }
  }

  /**
   * Reject `a[5]` on a known-3-long `a` at COMPILE TIME (NT2002) rather than letting it
   * reach the runtime panic. Only fires when both sides are certain: a literal (or a
   * `const` bound to a literal) indexed by a numeric literal. See literalLength above.
   */
  private checkStaticBounds(e: Extract<Expr, { kind: "IndexExpr" }>, ot: Ty, scope: Scope): void {
    const idx = literalIndex(e.index);
    if (idx === undefined) return;
    let len = literalLength(e.object);
    if (len === undefined && e.object.kind === "Identifier") {
      const b = scope.lookup(e.object.name);
      if (b?.constant) len = b.len;
    }
    if (len === undefined) return;
    if (idx >= 0 && idx < len && Number.isInteger(idx)) return;
    const what = ot === "string" ? "a string" : isBytesTy(ot) ? "a Uint8Array" : "an array";
    throw boundsError(
      `index ${idx} is out of bounds for ${what} of length ${len}`,
      `valid indices are 0..${len - 1}` +
        (len === 0 ? " (there are none — it is empty)" : "") +
        `; use \`.at(${idx})\` if you want \`undefined\` instead of a panic`,
    );
  }

  /* ---- SH2 narrowing ------------------------------------------------------
   * `if (s.kind === "square")` / `switch (s.kind)` retype `s` INSIDE the arm. It is
   * a pure type-space operation — a union value already is its member's object block,
   * so narrowing emits no code at all; it only changes the slot layout the member
   * fields are read with. Implemented by SHADOW-DECLARING the name in the arm's child
   * scope, which is the one mechanism every later pass already reads.
   *
   * Deliberately narrow in scope: the narrowed thing must be a plain IDENTIFIER
   * (`s`, not `o.inner`) tested against the union's own discriminant. Anything else
   * keeps the un-narrowed union and the "narrow it first" diagnostic — an unsound
   * narrowing would hand codegen the wrong layout, which is the exact silent wrong
   * answer this project exists to avoid.
   */

  /** `x.kind` where `x` is a union-typed local and `kind` is its discriminant. */
  private discriminantRead(e: Expr, scope: Scope): { name: string; union: Ty } | undefined {
    if (e.kind !== "MemberExpr" || e.optional || e.object.kind !== "Identifier") return undefined;
    const u = scope.lookup(e.object.name)?.ty;
    if (u === undefined || !isUnionTy(u)) return undefined;
    return unionDiscriminant(u)!.key === e.property ? { name: e.object.name, union: u } : undefined;
  }

  /** The narrowing a `===`/`!==` tag comparison implies for its two arms. */
  private tagTest(test: Expr, scope: Scope): { name: string; union: Ty; tag: string; negated: boolean } | undefined {
    if (test.kind !== "BinaryExpr") return undefined;
    if (test.op !== "===" && test.op !== "!==" && test.op !== "==" && test.op !== "!=") return undefined;
    const negated = test.op === "!==" || test.op === "!=";
    for (const [a, b] of [[test.left, test.right], [test.right, test.left]] as [Expr, Expr][]) {
      const d = this.discriminantRead(a, scope);
      if (d && b.kind === "StringLiteral") return { ...d, tag: b.value, negated };
    }
    return undefined;
  }

  /**
   * The type a name gets when its union is restricted to `tags`. One tag ⇒ that
   * member; several ⇒ the sub-union (still discriminated, by construction); none ⇒
   * `undefined`, meaning "leave the binding alone" — TS would say `never`, and the
   * un-narrowed union is the honest conservative stand-in (its fields still need a
   * narrowing, only `.kind` is readable).
   */
  private restrictUnion(u: Ty, tags: string[]): Ty | undefined {
    const values = unionTagValues(u);
    const keep = unionMembers(u).filter((_, i) => tags.includes(values[i]!));
    if (keep.length === 0) return undefined;
    return keep.length === 1 ? widenLiteralTys(keep[0]!) : makeUnionTy(keep);
  }

  /** Declare the narrowed shadow binding in `inner`, when there is one. */
  private narrowInto(inner: Scope, name: string, u: Ty, tags: string[]): void {
    const t = this.restrictUnion(u, tags);
    // Declared CONSTANT on purpose: a narrowing is proved for the value that is there
    // now, and assigning a different member through the same name would leave every
    // later field access reading the wrong slot. Refusing is the conservative half of
    // reject-don't-miscompile; tracking the invalidation properly (rustc-style flow
    // analysis through loops and nested blocks) is the general fix.
    if (t !== undefined) inner.declare(name, t, true, undefined, u);
  }

  /**
   * Which member of the union `u` does this object literal construct? Answered from the
   * TAG the literal actually writes, not from its structure: two members can be
   * structurally ambiguous (`{k:"a",n:number} | {k:"b",n:number}`), a tag never is.
   */
  private unionMemberForLiteral(e: Extract<Expr, { kind: "ObjectLiteral" }>, u: Ty): Ty | undefined {
    const d = unionDiscriminant(u);
    if (!d) return undefined;
    const tags = unionTagValues(u).map((v) => `"${v}"`).join(" | ");
    const p = e.properties.find((p) => !p.spread && p.key === d.key);
    if (!p || p.value.kind !== "StringLiteral") {
      throw typeError(
        `an object literal for ${showUnion(u)} must set '${d.key}' to one of the literals ${tags}` +
          ` — that tag is what selects the member (and, at runtime, IS the value's type)`,
      );
    }
    const m = unionMemberFor(u, p.value.value);
    if (!m) throw typeError(`'${d.key}: "${p.value.value}"' matches no member of ${showUnion(u)} (expected ${tags})`);
    return m;
  }

  /** Resolve `.prop` on a NON-nullable base (object field, or string/array `.length`). */
  private fieldOnBase(base: Ty, prop: string): Ty {
    // SH2: only the DISCRIMINANT is readable on an un-narrowed union — it is the one
    // field guaranteed to exist, at the same slot, in every member. Everything else
    // needs a narrowing first; say so instead of guessing a member.
    if (isUnionTy(base)) {
      const d = unionDiscriminant(base)!;
      if (prop === d.key) return "string";
      throw typeError(
        `Property '${prop}' does not exist on ${showUnion(base)} — narrow it first ` +
          `(\`if (x.${d.key} === "…")\` or \`switch (x.${d.key})\`), then the member's fields are available`,
      );
    }
    if ((base === "string" || isArrayTy(base)) && prop === "length") return "number";
    if (isObjectTy(base)) {
      const ft = fieldType(base, prop);
      if (!ft) throw typeError(`Property '${prop}' does not exist on ${base}`);
      return ft;
    }
    throw typeError(`Property '${prop}' does not exist on ${base}`);
  }

  private checkStmt(s: Stmt, scope: Scope, ret: Ty): void {
    switch (s.kind) {
      case "VarDecl":
        for (const d of s.decls) {
          // A bare `let x;` / `let x: T;` has NO initializer. Two cases, and the
          // difference is the whole point of making `init` optional:
          //
          //  - the binding CAN hold `undefined` — either it is unannotated (`let x;`,
          //    whose type simply IS `undefined` here) or its annotation admits it
          //    (`let x: string | undefined;`). Then it really is initialized, to
          //    `undefined`, exactly as node has it. Materialize that literal so the rest
          //    of the pipeline sees the value that is genuinely there — a nullable slot
          //    needs a real [tag,value] box, not a raw zero.
          //  - it cannot (`let x: string;`) — there is NO value of type `T` to start
          //    with. The binding is UNINITIALIZED; whether a read is legal is decided by
          //    definite assignment (checkDefiniteAssignment), not here.
          if (!d.init) {
            // A `const` can never be assigned later, so an absent initializer is not a
            // definite-assignment question at all — it is the same hard error node gives
            // ("'const' declarations must be initialized"), and it is worth saying so.
            if (s.declKind === "const") throw typeError(`'${d.name}' is a \`const\` with no initializer`,
              undefined, `a \`const\` must be initialized where it is declared — use \`let\` if the value is assigned later`);
            if (!d.annot || this.assignable(d.annot, "undefined")) {
              d.init = { kind: "UndefinedLiteral" }; // fall through to the normal path
            } else {
              d.ty = d.annot;
              scope.declare(d.name, d.ty, s.declKind === "const");
              continue;
            }
          }
          const t = this.type(d.init, scope, d.annot); // annotation is the context (e.g. `const a: T[] = []`)
          if (d.annot && d.annot !== t && !this.assignable(d.annot, t)) {
            throw typeError(`'${d.name}' declared ${asWritten(d.annot, d.annotHead)} but initialized with ${t}`,
              undefined, dictHint(d.annot, d.annotHead, t));
          }
          // Reshape the initializer literal to the declared slot layout (fill omitted
          // optional fields, box scalars into nullable fields) — runs AFTER inference,
          // which sets the literal's own inferred `.ty`, so it must overwrite here.
          if (d.annot) this.retypeLiteral(d.init, d.annot);
          d.ty = d.annot ?? t;
          scope.declare(d.name, d.ty, s.declKind === "const",
            s.declKind === "const" ? literalLength(d.init) : undefined);
        }
        return;
      case "FuncDecl": return;
      case "ReturnStmt":
        if (s.argument) {
          const t = this.type(s.argument, scope, ret === "void" ? undefined : ret); // return type is the context (e.g. `return []`)
          if (ret !== "void" && !this.fitsParam(ret, t)) throw typeError(`return type ${t} does not match declared ${ret}`);
        }
        return;
      case "IfStmt": {
        refuseUnboxedUnion(this.type(s.test, scope), "a truthiness test");
        // Two INDEPENDENT narrowings apply to the same arms, and a guard can want both
        // (see checkBlock): nullable FACTS from the guard hold in the branch it selects,
        // and a TAG test narrows each arm's union — the tested member in one, the
        // remaining members in the other, which is what makes an `else if` chain over a
        // 3-member union work. Compose them rather than choosing one.
        const t = this.tagTest(s.test, scope);
        const con = scope.child();
        const alt = scope.child();
        if (t) {
          const others = unionTagValues(t.union).filter((v) => v !== t.tag);
          this.narrowInto(con, t.name, t.union, t.negated ? others : [t.tag]);
          this.narrowInto(alt, t.name, t.union, t.negated ? [t.tag] : others);
        }
        this.withFactsIn(this.factsFor(s.test, scope, true, s.consequent),
          () => this.checkBlock(s.consequent, con, ret));
        if (s.alternate) {
          this.withFactsIn(this.factsFor(s.test, scope, false, s.alternate),
            () => this.checkBlock(s.alternate!, alt, ret));
        }
        return;
      }
      case "WhileStmt":
        refuseUnboxedUnion(this.type(s.test, scope), "a truthiness test");
        this.loopDepth++; this.checkBlock(s.body, scope.child(), ret); this.loopDepth--;
        return;
      case "DoWhileStmt":
        this.loopDepth++; this.checkBlock(s.body, scope.child(), ret); this.loopDepth--;
        refuseUnboxedUnion(this.type(s.test, scope), "a truthiness test");
        return;
      case "ForStmt": {
        const inner = scope.child();
        if (s.init) {
          if ((s.init as VarDecl).kind === "VarDecl") this.checkStmt(s.init as VarDecl, inner, ret);
          else this.type(s.init as Expr, inner);
        }
        if (s.test) this.type(s.test, inner);
        if (s.update) this.type(s.update, inner);
        this.loopDepth++; this.checkBlock(s.body, inner.child(), ret); this.loopDepth--;
        return;
      }
      case "ForOfStmt": {
        // --- Map/Set iteration, INSERTION-ORDERED (see nt_mapset.c's key log) ----
        // `for (const [k, v] of m)` / `of m.entries()` binds both names: the loop
        // walks the insertion-ordered keys and looks each value up (no tuple type
        // needed). `for (const x of set)` is rewritten to `set.values()`, so it
        // reuses the ordinary array for-of. `for (const x of map)` (one name) is
        // refused — node binds a [k, v] array there, which we cannot represent.
        if (s.name2) { this.checkMapEntriesLoop(s, scope, ret); return; }
        const iter = this.asIterable(s.iterable, scope, "for-of");
        s.iterable = iter.expr;
        const it = iter.ty;
        const el: Ty = it === "string" ? "string" : isArrayTy(it) ? elemTy(it) : isBytesTy(it) ? "number" : (() => { throw nyi(NYI.FOR_OF_NONSTRING, `for-of over ${it}`); })();
        s.elemTy = el;
        const inner = scope.child();
        inner.declare(s.name, el, false);
        this.loopDepth++; this.checkBlock(s.body, inner, ret); this.loopDepth--;
        return;
      }
      case "ForInStmt": {
        const ot = this.type(s.object, scope);
        if (!isObjectTy(ot)) throw nyi(NYI.FOR_IN, `for-in over ${ot}`);
        enumerableOrThrow(ot, "for-in", true);
        const inner = scope.child();
        inner.declare(s.name, "string", false); // keys are strings
        this.loopDepth++; this.checkBlock(s.body, inner, ret); this.loopDepth--;
        return;
      }
      case "SwitchStmt": {
        const dt = this.type(s.discriminant, scope);
        this.switchDepth++;
        // SH2: `switch (s.kind)` narrows each arm to the member(s) that can reach it.
        // FALLTHROUGH is the subtle part and is handled explicitly: a case body that
        // does not end in a terminator also runs for the NEXT case's tag, so the tags
        // that can reach a body are carried forward. Narrowing to the case's own tag
        // alone would be unsound exactly there.
        const d = this.discriminantRead(s.discriminant, scope);
        const listed = s.cases.map((c) => (c.test && c.test.kind === "StringLiteral" ? c.test.value : undefined));
        let carry: string[] = [];
        s.cases.forEach((cse, i) => {
          if (cse.test) {
            const ct = this.type(cse.test, scope);
            if (ct !== dt) throw typeError(`switch case type ${ct} does not match discriminant ${dt}`);
          }
          const inner = scope.child();
          if (d) {
            const own = cse.test
              ? (listed[i] !== undefined ? [listed[i]!] : []) // a non-literal case test tells us nothing
              : unionTagValues(d.union).filter((v) => !listed.includes(v)); // `default:` — whatever is left
            const tags = [...new Set([...carry, ...own])];
            this.narrowInto(inner, d.name, d.union, tags);
            carry = leavesBlock(cse.body) ? [] : tags;
          }
          this.checkBlock(cse.body, inner, ret);
        });
        this.switchDepth--;
        return;
      }
      case "ThrowStmt":
        this.type(s.argument, scope);
        return;
      case "TryStmt": {
        const catchTy = this.inferThrowType(s.block, scope) ?? "string";
        s.catchTy = catchTy;
        this.checkBlock(s.block, scope.child(), ret);
        if (s.handler) {
          const inner = scope.child();
          if (s.param) inner.declare(s.param, catchTy, false);
          this.checkBlock(s.handler, inner, ret);
        }
        if (s.finalizer) this.checkBlock(s.finalizer, scope.child(), ret);
        return;
      }
      case "BreakStmt":
        if (this.loopDepth === 0 && this.switchDepth === 0) throw typeError("'break' outside loop/switch");
        return;
      case "ContinueStmt":
        if (this.loopDepth === 0) throw typeError("'continue' outside loop");
        return;
      case "BlockStmt":
        this.checkBlock(s.body, scope.child(), ret);
        return;
      case "MultiStmt": // transparent group (desugaring) — same scope
        for (const st of s.stmts) this.checkStmt(st, scope, ret);
        return;
      case "ExprStmt":
        this.type(s.expr, scope);
        return;
    }
  }

  type(e: Expr, scope: Scope, hint?: Ty): Ty { const t = this.infer(e, scope, hint); e.ty = t; return t; }

  private infer(e: Expr, scope: Scope, hint?: Ty): Ty {
    switch (e.kind) {
      case "NumberLiteral": return "number";
      case "BooleanLiteral": return "boolean";
      case "StringLiteral": return "string";
      case "UndefinedLiteral": return "undefined";
      case "NullLiteral": return "null";
      case "TemplateLiteral":
        // Same box, same invalid IR, as string concatenation just above.
        for (const x of e.exprs) refuseUnboxedUnion(this.type(x, scope), "a template literal");
        return "string";
      case "ArrayLiteral": {
        if (e.elements.length === 0) {
          // Empty `[]` has no element to infer from — take the element type from
          // CONTEXT: a binding/field annotation, a declared return type, a parameter
          // type, an assignment target, or the other arm of a `?:`/`??`. With no
          // context we still reject (don't guess) — see `emptyArrayError`.
          if (hint && isArrayTy(hint)) {
            const el = elemTy(hint);
            if (el !== "number" && el !== "string" && el !== "boolean" && !isObjectTy(el) && !isArrayTy(el) && !isUnionTy(el)) throw nyi(NYI.ARRAY, `arrays of ${el}`);
            return hint;
          }
          throw emptyArrayError();
        }
        const tys = e.elements.map((el) => {
          if (el.kind === "SpreadExpr") {
            // [...map.keys()] / [...set] — an iteration position (a Set spreads its elements).
            const sp = this.asIterable(el.argument, scope, "spread");
            el.argument = sp.expr;
            const st = sp.ty;
            if (!isArrayTy(st)) throw typeError("can only spread an array into an array literal");
            return elemTy(st);
          }
          // The context's ELEMENT type is each element's context, so a `@@mutable` record
          // literal in `const cells: Cell[] = [{ n: 1 }]` takes its tag (and a nested `[]`
          // takes its element type) from the annotation, exactly as one in a field does.
          return this.type(el, scope, hint && isArrayTy(hint) ? elemTy(hint) : undefined);
        });
        // SH2: the elements of a `Shape[]` have DIFFERENT types by design — they share
        // the union, not one object shape. Accept exactly when every element is one of
        // its members (the same identity rule `assignable` uses for a union target).
        const want = hint !== undefined && isArrayTy(hint) && isUnionTy(elemTy(hint)) ? elemTy(hint) : undefined;
        if (want !== undefined && tys.every((t) => this.assignable(want, t))) return hint as Ty;
        const first = tys[0]!;
        if (!tys.every((t) => t === first)) throw typeError(`array elements must share a type (got ${[...new Set(tys)].join(", ")})`);
        // A `Date` is represented AS a double (stdlib batch 3), so `Date[]` is a
        // `number[]` in every way that matters to the slot vector — allow it.
        if (first !== "number" && first !== "string" && first !== "boolean" && !isObjectTy(first) && !isArrayTy(first) && !isDateTy(first) && !isUnionTy(first)) throw nyi(NYI.ARRAY, `arrays of ${first}`);
        return `${first}[]`;
      }
      case "ObjectLiteral": {
        // SH2: when the context wants a UNION, the literal's own tag says which member
        // it is, and that member becomes the context from here down. This is the one
        // place a union value is created, and the selection is syntactic (the tag the
        // programmer wrote) rather than structural — two members can be structurally
        // ambiguous, a tag never is.
        const ctx = hint !== undefined && isUnionTy(hint) ? this.unionMemberForLiteral(e, hint) : hint;
        const fields: { key: string; ty: Ty }[] = [];
        const put = (key: string, ty: Ty) => { const f = fields.find((f) => f.key === key); if (f) f.ty = ty; else fields.push({ key, ty }); };
        for (const p of e.properties) {
          if (p.spread) {
            const st = this.type(p.value, scope);
            if (!isObjectTy(st)) throw typeError("can only spread an object into an object literal");
            for (const f of objectFields(st)) put(f.key, f.ty);
          } else {
            // An annotated target type is the context for each property value, so
            // `const o: {xs: number[]} = { xs: [] }` types the empty literal.
            const want = ctx && isObjectTy(ctx) ? fieldType(ctx, p.key) : undefined;
            put(p.key, this.type(p.value, scope, want ? baseTy(want) : undefined));
          }
        }
        const lit = objectType(fields);
        // The selected member wins as the literal's type, so codegen builds the member's
        // declared slot layout (and any optional field it omitted is still allocated).
        if (hint !== undefined && isUnionTy(hint) && ctx !== undefined && isObjectTy(ctx) && this.assignable(ctx, lit)) return ctx;
        // Contextual TAGGING (`@@mutable` records). A record's values come from object
        // literals, and the tag is what makes its mutability nominal — so where the
        // context asks for a tagged record and the literal fits it, the literal IS one.
        // That covers `const c: Cell = {…}`, `return {…}`, `f({…})` and `Cell[]` elements
        // through the one hint channel that already exists.
        const tagged = this.contextualRecordTy(hint);
        return tagged !== undefined && this.assignable(tagged, lit) ? tagged : lit;
      }
      case "SpreadExpr": throw nyi(NYI.SPREAD, "spread");
      case "ArrowFunction": return this.typeArrow(e, undefined, scope);
      case "SequenceExpr": {
        let t: Ty = "undefined";
        for (const x of e.exprs) t = this.type(x, scope);
        return t;
      }
      case "Identifier": {
        const b = scope.lookup(e.name);
        // M3: a generic declaration has no single type, so it cannot be used as a VALUE —
        // monomorphization specializes at CALL sites. Say so precisely instead of
        // reporting it as undefined.
        if (!b && this.generics.has(e.name)) {
          throw nyi(NYI.GENERIC, `generic function '${e.name}' used as a value; a generic is specialized at its CALL site — call it directly (\`${e.name}(…)\`) or wrap it in a concrete arrow`);
        }
        if (!b) throw typeError(`'${e.name}' is not defined`);
        // Control-flow narrowing: on this path the binding was PROVED non-nullish, so it
        // reads as its base type and codegen unwraps the tagged pair here. Always
        // written, so a `true` stamped by an earlier typing pass cannot go stale.
        const narrowed = this.narrowedTy(b, "");
        e.narrowed = narrowed !== undefined;
        return narrowed ?? b.ty;
      }
      case "MemberExpr": {
        // Host I/O: process.argv -> string[], process.env.NAME -> string. Recognized
        // only when `process` is not shadowed by a user binding.
        if (!scope.lookup("process")) {
          if (e.object.kind === "Identifier" && e.object.name === "process") {
            if (e.property === "argv") return "string[]";
            throw typeError(`process.${e.property} is not supported`);
          }
          if (
            e.object.kind === "MemberExpr" && e.object.object.kind === "Identifier" &&
            e.object.object.name === "process" && e.object.property === "env"
          ) {
            return "string"; // process.env.NAME (empty string if unset — see docs)
          }
        }
        // stdlib Batch 1: the `Number.*` numeric constants (MAX_SAFE_INTEGER, EPSILON, …).
        if (e.object.kind === "Identifier" && e.object.name === "Number" && !scope.lookup("Number")) {
          if (NUMBER_CONSTS[e.property] === undefined) throw nyi(NYI.OBJECT, `Number.${e.property}`);
          return "number";
        }
        const ot = this.type(e.object, scope);
        // Accessing a member of a possibly-nullish object: the result is nullable
        // (the whole chain short-circuits to `undefined` if the object is nullish).
        // Legal only when THIS link is `?.`, or the object is itself an ongoing
        // optional chain (a trailing non-optional member after a `?.`).
        if (isNullableTy(ot)) {
          if (!e.optional && !isOptChainExpr(e.object)) {
            // Name the RECEIVER as it was written (`d.spans`, not the fabricated word
            // `value`) and point at the `.` that is not allowed, so the reader can find
            // it. Getting both wrong is what once hid this rejection in `diagnostics.ts`.
            const what = exprText(e.object);
            throw typeError(
              `${what === undefined ? "this value" : `'${what}'`} is possibly ${nullishKind(ot)}`,
              e.loc,
              `use '?.' (\`${what ?? "value"}?.${e.property}\` short-circuits the whole chain to undefined), ` +
              `or prove it non-nullish first — \`if (${what ?? "value"}) { … }\`, an early \`return\`, or \`!\``,
              "this read is not proved non-nullish",
            );
          }
          const ft = this.fieldOnBase(baseTy(ot), e.property);
          return makeNullable("undefined", baseTy(ft));
        }
        // fetch's Response: `.status` (number), `.ok` (2xx, computed from the status),
        // `.headers` (the response header block — see `Headers` below).
        if (isResponseTy(ot)) {
          if (e.property === "status") return "number";
          if (e.property === "ok") return "boolean";
          if (e.property === "headers") return "Headers";
          throw nyi(NYI.OBJECT, `Response property '.${e.property}' (supported: .status, .ok, .headers, .text(), .json())`);
        }
        // stdlib Batch 3: `new URL(u)` components. Every one is a `string` (node's
        // shape: an absent part is "", never null), and `.searchParams` hands back the
        // query as a URLSearchParams. `.href`/`.toString()` would need the WHATWG
        // serializer (which normalizes), so they are refused rather than approximated.
        if (isUrlTy(ot)) {
          if (URL_COMPONENTS.includes(e.property)) return "string";
          if (e.property === "searchParams") return "URLSearchParams";
          throw nyi(NYI.WEBAPI, `URL property '.${e.property}' (supported: ${URL_COMPONENTS.join(", ")}, searchParams)`);
        }
        if ((ot === "string" || isArrayTy(ot) || isBytesTy(ot)) && e.property === "length") return "number";
        if ((isMapTy(ot) || isSetTy(ot)) && e.property === "size") return "number";
        if (ot === "Dyn") return "Dyn"; // dynamic field access — runtime tag check
        if (isUnionTy(ot)) return this.fieldOnBase(ot, e.property); // SH2: the discriminant, or "narrow it first"
        if (isObjectTy(ot)) {
          const ft = fieldType(ot, e.property);
          if (!ft) throw typeError(`Property '${e.property}' does not exist on ${ot}`);
          // Control-flow narrowing of a DOTTED NAME: `if (d.spans) { d.spans.length }`
          // reads the same immutable field, proved non-nullish. Always written, so a
          // `true` stamped by an earlier typing pass cannot go stale.
          const narrowed = this.narrowedPath(e, scope);
          e.narrowed = narrowed !== undefined;
          return narrowed ?? ft; // a redundant `?.` on a non-nullable object is allowed (result unchanged)
        }
        throw typeError(`Property '${e.property}' does not exist on ${ot}`);
      }
      case "IndexExpr": {
        const ot = this.type(e.object, scope);
        if (ot === "Dyn") { this.type(e.index, scope); return "Dyn"; } // dynamic element/field — runtime tag check
        if (isUnionTy(ot)) { // SH2: `u["kind"]` is the same read as `u.kind`
          if (e.index.kind !== "StringLiteral") throw typeError("object must be indexed by a string literal");
          return this.fieldOnBase(ot, e.index.value);
        }
        if (isObjectTy(ot)) {
          if (e.index.kind !== "StringLiteral") throw typeError("object must be indexed by a string literal");
          const ft = fieldType(ot, e.index.value);
          if (!ft) throw typeError(`Property '${e.index.value}' does not exist on ${ot}`);
          return ft;
        }
        const it = this.type(e.index, scope);
        if (it !== "number") throw typeError("index must be number");
        this.checkStaticBounds(e, ot, scope);
        if (isArrayTy(ot)) return elemTy(ot);
        if (ot === "string") return "string";
        if (isBytesTy(ot)) return "number"; // Uint8Array element read -> 0..255
        throw nyi(NYI.ARRAY, `index access on ${ot}`);
      }
      case "TypeofExpr":
        this.type(e.operand, scope);
        return "string";
      case "UnaryExpr": {
        const t = this.type(e.operand, scope);
        if (e.op === "!") return "boolean";
        if (e.op === "void") return "undefined";
        if (e.op === "~") { if (t !== "number") throw typeError(`'~' needs number`); return "number"; }
        if (e.op === "+") return "number"; // numeric coercion of number/string/boolean/null/undefined
        if (t !== "number") throw typeError(`Unary '-' needs number, got ${t}`);
        return "number";
      }
      case "UpdateExpr": {
        // Member/index target (`this.n++`, `u[i]++`). The parser already vetted a field
        // target against the immutability rule; an INDEX target is decided here, exactly
        // like `IndexAssign`: a mutable `Uint8Array` element is writable, an immutable
        // array/object element is NT1606.
        if (e.targetExpr) {
          const tgt = e.targetExpr;
          if (tgt.kind === "IndexExpr") {
            const ot = this.type(tgt.object, scope);
            if (isBytesTy(ot)) {
              if (this.type(tgt.index, scope) !== "number") throw typeError("Uint8Array index must be a number");
              return "number";
            }
            if (isObjectTy(ot))
              throw mutationError("objects are immutable: `o[k]++` would mutate the object in place", "use `{ ...o, k: o[k] + 1 }` — returns a NEW object; the original is unchanged");
            throw mutationError("arrays are immutable: `arr[i]++` would mutate the array in place", "use `arr.with(i, arr[i] + 1)` — returns a NEW array; the original is unchanged");
          }
          // A FIELD target (`this.n++`, `cell.n++`). The parser vetted only the `this`
          // case (syntax); mutability of any other receiver is a TYPE question, decided
          // here exactly like `FieldAssign`.
          if (tgt.kind === "MemberExpr") {
            const ot = this.type(tgt.object, scope);
            const isThis = tgt.object.kind === "Identifier" && tgt.object.name === "this";
            if (!isThis && !this.isMutableTy(ot)) {
              throw mutationError(
                "objects are immutable: `o.f++` would mutate the object in place",
                "use `{ ...o, f: o.f + 1 }` — returns a NEW object; the original is unchanged" +
                  (isObjectTy(ot) ? ". To assign in place instead, declare the record `@@mutable` (docs/decorators.md)" : ""),
              );
            }
          }
          const ft = this.type(tgt, scope);
          if (ft !== "number") throw typeError(`'${e.op}' needs number`);
          return "number";
        }
        const b = scope.lookup(e.target);
        if (!b) throw typeError(`'${e.target}' is not defined`);
        if (b.ty !== "number") throw typeError(`'${e.op}' needs number`);
        return "number";
      }
      case "BinaryExpr": {
        const l = this.type(e.left, scope);
        const r = this.type(e.right, scope);
        if (RELATIONAL.has(e.op)) {
          // Strings compare lexicographically (node: UTF-16 code units; we compare
          // UTF-8 bytes == code-point order — identical outside the astral/U+E000
          // corner documented in docs/divergences.md).
          if (l === "string" && r === "string") return "boolean";
          if (l !== "number" || r !== "number") throw typeError(`Comparison needs numbers or two strings`);
          return "boolean";
        }
        if (EQUALITY.has(e.op)) {
          // A2 nullable vs the `undefined` / `null` literal — the idiomatic TS
          // nullish test (`if (m === undefined)`). It is a TAG comparison on the
          // tagged pair, never truthiness, so `0` / `""` / `false` compare false.
          if (isNullableTy(l) && (r === "undefined" || r === "null")) return "boolean";
          if (isNullableTy(r) && (l === "undefined" || l === "null")) return "boolean";
          // A general union is a BOX: `===` on it compared the two boxes' TAGS, so
          // `1 === 2` came out true. Refuse until the arms are compared themselves.
          for (const t of [l, r]) refuseUnboxedUnion(t, "`===`");
          if (l !== r) throw typeError(`Cannot compare ${l} with ${r}`);
          return "boolean";
        }
        if (BITWISE.has(e.op)) {
          if (l !== "number" || r !== "number") throw typeError(`Bitwise op needs numbers`);
          return "number";
        }
        if (e.op === "+" && (l === "string" || r === "string")) {
          // Response/Headers have no string coercion (they are opaque handles).
          for (const t of [l, r]) if (isResponseTy(t) || isHeadersTy(t)) throw nyi(NYI.OBJECT, `string concatenation with a ${t}`);
          // A `T | null` / `T | undefined` used to be REFUSED here, on the reasoning that
          // `?? "…"` is "the only spelling whose output is unambiguous". node disagrees and
          // node is the specification: String(undefined) is "undefined" and String(null) is
          // "null", exactly. `coerceToString` now branches on the tag and emits those, so
          // this is ordinary concatenation — and `${x}`, which shares that path, no longer
          // reaches codegen with a raw box and emits invalid IR.
          // ...and a general union is the same two-slot box, which reached codegen and
          // emitted invalid IR.
          for (const t of [l, r]) refuseUnboxedUnion(t, "string concatenation");
          // stdlib Batch 3: `"" + date` is node's Date#toString — a LOCALE- and
          // zone-name-formatted human string ("Thu Jan 01 1970 … (GMT)"), which needs
          // the tz display-name tables. Refuse rather than approximate.
          for (const t of [l, r]) if (isDateTy(t) || isUrlTy(t) || isSearchParamsTy(t))
            throw nyi(NYI.WEBAPI, `string concatenation with a ${t} (use ${isDateTy(t) ? "`.toISOString()`" : "`.toString()` / a component"})`);
          return "string";
        }
        if (l !== "number" || r !== "number") throw typeError(`Arithmetic needs numbers, got ${l} ${e.op} ${r}`);
        return "number";
      }
      case "LogicalExpr": {
        const l = this.type(e.left, scope);
        // For `??` the LEFT operand is the context for the right (`maybeArr ?? []` gets
        // its element type from `maybeArr`'s base type); a definitely-nullish left falls
        // back to the surrounding context.
        const rhint = e.op !== "??" ? hint
          : isNullableTy(l) ? baseTy(l)
          : l === "null" || l === "undefined" ? hint
          : l;
        // Control-flow narrowing across the short circuit: the right operand only runs
        // when the left decided the branch, so it sees that branch's facts — `&&` the
        // TRUE ones (`m! && m[0]`, `x !== undefined && x > 3`), `||` the FALSE ones.
        // `??` gets no guard fact (its right operand runs when the left IS nullish), but
        // an `x!` assertion in the left holds for it too — the left ran to completion.
        const r = this.withFacts(
          this.factsFor(e.left, scope, e.op === "&&", exprRegion(e.right), e.op !== "??"),
          () => this.type(e.right, scope, rhint),
        );
        if (e.op === "??") {
          // `??` collapses to the non-nullish arm. Left may be definitely-nullish
          // (static → right), a runtime-nullable `T | ...` (runtime tag branch →
          // base ⊔ right), or definitely non-nullish (static → left).
          if (l === "null" || l === "undefined") return r;
          if (isNullableTy(l)) {
            const base = baseTy(l);
            if (base !== r && !this.assignable(base, r) && !this.assignable(r, base)) throw typeError(`?? branches differ: ${base} vs ${r}`);
            return base;
          }
          if (l !== r) throw typeError(`?? branches differ: ${l} vs ${r}`);
          return l;
        }
        // `&&` / `||`: boolean short-circuit, or JS value-returning truthiness for
        // matching number/string operands (`0 || 5` → 5, `"" || "x"` → "x").
        if (l === "boolean" && r === "boolean") return "boolean";
        if (l === r && (l === "number" || l === "string")) return l;
        throw typeError(`'${e.op}' operands must be matching boolean/number/string (got ${l}, ${r})`);
      }
      case "ConditionalExpr": {
        refuseUnboxedUnion(this.type(e.test, scope), "a truthiness test");
        // Each arm sees the surrounding context; additionally an empty `[]` arm takes
        // its element type from the OTHER arm (`flag ? [1, 2] : []`), so type the
        // non-empty arm first and feed its type back.
        // Each arm is also NARROWED by the test, exactly as an `if` branch is
        // (`x !== undefined ? x.toUpperCase() : "-"`).
        const yes = (f: () => Ty) => this.withFacts(this.factsFor(e.test, scope, true, exprRegion(e.consequent)), f);
        const no = (f: () => Ty) => this.withFacts(this.factsFor(e.test, scope, false, exprRegion(e.alternate)), f);
        let a: Ty, b: Ty;
        if (isEmptyArrayLit(e.consequent) && !isEmptyArrayLit(e.alternate)) {
          b = no(() => this.type(e.alternate, scope, hint));
          a = yes(() => this.type(e.consequent, scope, hint ?? b));
        } else {
          a = yes(() => this.type(e.consequent, scope, hint));
          b = no(() => this.type(e.alternate, scope, hint ?? a));
        }
        if (a !== b) throw typeError(`Ternary branches differ: ${a} vs ${b}`);
        return a;
      }
      case "AssignExpr": {
        const b = scope.lookup(e.target);
        if (!b) throw typeError(`'${e.target}' is not defined`);
        if (b.narrowedFrom !== undefined) {
          throw typeError(
            `cannot assign to '${e.target}' here: it is NARROWED to ${b.ty === baseTy(b.ty) && isUnionTy(b.ty) ? showUnion(b.ty) : b.ty} ` +
              `inside this arm, and the narrowing was proved for the value already in it — a different member of ` +
              `${showUnion(b.narrowedFrom)} would make every later field access read the wrong slot. ` +
              `Assign to a new binding, or move the assignment outside the narrowed arm`,
          );
        }
        if (b.constant) throw typeError(`Cannot assign to const '${e.target}'`);
        const vt = this.type(e.value, scope, e.op === "=" ? b.ty : undefined); // assignment target is the context (e.g. `a = []`)
        if (e.op === "=") {
          if (vt !== b.ty && !this.assignable(b.ty, vt)) throw typeError(`Cannot assign ${vt} to ${b.ty} '${e.target}'`);
        } else if (e.op === "+=" && b.ty === "string") {
          if (vt !== "string" && vt !== "number") throw typeError(`Cannot += ${vt} to string`);
        } else if (b.ty !== "number" || vt !== "number") {
          throw typeError(`'${e.op}' needs number`);
        }
        return b.ty;
      }
      case "IndexAssign": {
        // Element assignment `obj[i] = v` (+ compound). Immutable arrays/objects are
        // rejected here (NT1606, the "sharp turn"); a mutable `Uint8Array` is allowed
        // (node semantics — `u[i] = v` writes a byte with JS ToUint8 wrap).
        const ot = this.type(e.object, scope);
        if (isBytesTy(ot)) {
          const it = this.type(e.index, scope);
          if (it !== "number") throw typeError("Uint8Array index must be a number");
          const vt = this.type(e.value, scope);
          if (vt !== "number") throw typeError(`Uint8Array element must be a number, got ${vt}`);
          e.ty = "number";
          return "number";
        }
        if (isObjectTy(ot))
          throw mutationError("objects are immutable: `o[i] = v` would mutate the object in place", "use `{ ...o, k: v }` — returns a NEW object; the original is unchanged");
        throw mutationError("arrays are immutable: `arr[i] = v` would mutate the array in place", "use `arr.with(i, v)` — returns a NEW array; the original is unchanged");
      }
      case "FieldAssign": {
        // `o.field = expr` — store one slot. Three ways to get here:
        //   - `this.f = v` inside a class member body (the parser vetted the syntactic
        //     context: a constructor building the instance, or a setter method);
        //   - `r.f = v` on a `@@mutable` RECORD (this lane) — allowed below;
        //   - anything else, which is the Stage-29 immutability rejection (NT1606).
        // The parser cannot decide the last two (it does not know types), so it emits the
        // node and defers here. The ownership pass then decides WHO may mutate (NT1607).
        const ot = this.type(e.object, scope);
        if (!e.viaThis && !this.isMutableTy(ot)) {
          throw mutationError(
            "objects are immutable: `o.f = v` would mutate the object in place",
            isObjectTy(ot)
              ? "use `{ ...o, f: v }` — returns a NEW object; the original is unchanged. To assign in place instead, declare the record `@@mutable` (docs/decorators.md)"
              : "use `{ ...o, f: v }` — returns a NEW object; the original is unchanged",
          );
        }
        if (!isObjectTy(ot)) throw typeError(`cannot assign field on non-object type ${ot}`);
        const ft = fieldType(ot, e.field);
        if (!ft) throw typeError(`Property '${e.field}' does not exist on ${ot}`);
        const vt = this.type(e.value, scope, baseTy(ft)); // field type is the context (e.g. `items: number[] = []`)
        if (vt !== ft && !this.assignable(ft, vt)) throw typeError(`cannot assign ${vt} to field '${e.field}' of type ${ft}`);
        return ft;
      }
      case "NewExpr": {
        // Immutable collections (B2). `new Map<K,V>()` / `new Set<T>()`; bare
        // `new Map()`/`new Set()` default to Map<string,number> / Set<string>.
        if (e.callee === "Map") {
          if (e.args.length > 1) throw typeError("new Map expects at most one argument (an iterable)");
          let k = e.typeArgs?.[0] ?? "string", v = e.typeArgs?.[1] ?? "number";
          if (e.args.length === 1) {
            // Only the Map-COPY form. The entries form needs a [K, V] tuple type we
            // do not have yet (`["a", 1]` is NT2001 on its own), so it stays refused.
            // Refuse the entries form BEFORE typing it — `[["a", 1]]` would otherwise
            // die as NT2001 ("elements must share a type"), which names the symptom
            // rather than the missing tuple type.
            const a0 = e.args[0]!;
            if (a0.kind === "ArrayLiteral") throw nyi(NYI.COLLECTION, "new Map([[key, value], …]) (the entries form needs a [key, value] tuple type we do not have yet; use .set)");
            const at = this.type(a0, scope);
            if (!isMapTy(at)) throw nyi(NYI.COLLECTION, `new Map(${at}) (only another Map is supported — the [key, value] entries form needs a tuple type we do not have yet; use .set)`);
            k = mapKeyTy(at); v = mapValTy(at);
          }
          // Keys ride an i64 slot tagged NT_K_STR (string) or NT_K_NUM (number) —
          // those are the two the runtime canonicalizes (SameValueZero), so keys are
          // restricted to string|number. Values ride a raw i64 slot, so any storable
          // type works: scalars plus heap refs (array/object).
          if (k !== "string" && k !== "number") throw nyi(NYI.COLLECTION, `Map with ${k} keys (only string|number keys)`);
          if (!isMapValueTy(v)) throw nyi(NYI.COLLECTION, `Map with ${v} values`);
          return makeMapTy(k, v);
        }
        if (e.callee === "Set") {
          if (e.args.length > 1) throw typeError("new Set expects at most one argument (an iterable)");
          const declared = e.typeArgs?.[0];
          let el = declared ?? "string";
          if (e.args.length === 1) {
            // `new Set(iterable)` — bulk construction. The element type comes from the
            // argument (an array's element type), so `new Set([1,2,3])` is Set<number>
            // without a type argument, exactly as node/tsc infer it.
            const at = this.type(e.args[0]!, scope, declared ? (`${declared}[]` as Ty) : undefined);
            if (isArrayTy(at)) el = elemTy(at);
            else if (isSetTy(at)) el = setElemTy(at);
            // A string is deliberately REFUSED: node iterates it by code point
            // (`new Set("a😀b")` has size 3) while our string for-of walks bytes, so
            // building it here would silently produce the wrong set. We cannot prove
            // a string is ASCII at compile time, so the refusal is unconditional.
            else if (at === "string") throw nyi(NYI.COLLECTION, "new Set(string) (node iterates a string by code point; split it yourself, e.g. new Set(s.split(\"\")) for ASCII)");
            else throw nyi(NYI.COLLECTION, `new Set(${at}) (only an array or another Set is supported — build others with .add)`);
            if (declared && el !== declared) throw typeError(`new Set<${declared}> from ${at} (element type must match)`);
          }
          if (el !== "string" && el !== "number") throw nyi(NYI.COLLECTION, `Set of ${el}`);
          return makeSetTy(el);
        }
        // Bytes (stdlib batch 2): `new Uint8Array(n)` (zero-filled length n) or
        // `new Uint8Array([1,2,3])` (from a number array, each ToUint8). `new TextEncoder()`
        // / `new TextDecoder()` are stateless singletons (no ctor args).
        if (e.callee === "Uint8Array") {
          if (e.args.length !== 1) throw typeError("new Uint8Array expects one argument: a length or a number[]");
          const at = this.type(e.args[0]!, scope);
          if (at !== "number" && !(isArrayTy(at) && elemTy(at) === "number"))
            throw typeError(`new Uint8Array expects a number length or number[], got ${at}`);
          return "Uint8Array";
        }
        if (e.callee === "TextEncoder" || e.callee === "TextDecoder") {
          if (e.args.length !== 0) throw typeError(`new ${e.callee}() takes no arguments`);
          return e.callee;
        }
        // --- stdlib Batch 3: the object-shaped web APIs ---
        // `new Date()` (the clock), `new Date(ms)`, `new Date(isoString)`. A Date is a
        // VALUE — its representation is the epoch-ms double — so it needs no allocation.
        if (e.callee === "Date" && !scope.lookup("Date")) {
          if (e.args.length > 1) throw nyi(NYI.WEBAPI, "new Date(y, m, d, …) (the component constructor)");
          if (e.args.length === 1) {
            const at = this.type(e.args[0]!, scope);
            if (at !== "number" && at !== "string")
              throw typeError(`new Date expects a number (epoch ms) or an ISO string, got ${at}`);
          }
          return "Date";
        }
        // `new URL(u)` — a string handle re-parsed by each accessor. A RELATIVE base
        // (`new URL(path, base)`) needs URL resolution we do not implement.
        if (e.callee === "URL" && !scope.lookup("URL")) {
          if (e.args.length === 2) throw nyi(NYI.WEBAPI, "new URL(relative, base) (relative-URL resolution)");
          if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError("new URL(url: string)");
          return "URL";
        }
        if (e.callee === "URLSearchParams" && !scope.lookup("URLSearchParams")) {
          if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string")
            throw typeError("new URLSearchParams(init: string) — only the query-string form is supported");
          return "URLSearchParams";
        }
        // `new C(args)` on a user class: the ctor lowered to `C.constructor(this, …)`,
        // so its sig carries the instance type (param 0 = `this`) and the ctor param types.
        const ctor = this.functions.get(`${e.callee}.constructor`);
        if (ctor) {
          const objTy = ctor.params[0]!;             // `this` — the instance type
          const min = ctor.required - 1, max = ctor.params.length - 1;
          if (e.args.length < min || e.args.length > max) throw typeError(`new ${e.callee} expects ${min}..${max} args, got ${e.args.length}`);
          e.args.forEach((a, i) => {
            const exp = ctor.params[i + 1]!;
            const at = this.typeArg(a, exp, scope);
            if (!this.fitsArg(exp, at, a)) throw typeError(`new ${e.callee} arg ${i} expects ${exp}, got ${at}`);
          });
          return objTy;
        }
        // `new Promise(...)` — no event loop, so a promise cannot mean what it means in
        // node. Reject (NT1020) with the pointer to actors for real concurrency.
        if (e.callee === "Promise") throw nyi(NYI.ASYNC, "new Promise(...)");
        if (e.callee !== "Error") throw nyi(NYI.CLASS, `new ${e.callee}(...)`);
        if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError("new Error(message: string)");
        return "{message:string}";
      }
      case "AsExpr": { this.type(e.expr, scope); return e.ty; } // identity retype
      /**
       * `satisfies` CHECKS against the annotation but keeps the expression's own type.
       * The annotation is passed down as the contextual hint (so an object literal is
       * shaped by it, exactly as under a `const x: T =` annotation), and then the
       * result is the INFERRED type, not `e.ty` — that is the whole difference from
       * `as` on the line above.
       */
      case "SatisfiesExpr": {
        const t = this.type(e.expr, scope, e.ty);
        if (t !== e.ty && !this.assignable(e.ty, t)) {
          throw typeError(`${t} does not satisfy ${e.ty}`, undefined,
            `\`satisfies\` checks assignability without changing the type; use \`as ${e.ty}\` only if you mean to retype.`);
        }
        return t;
      }
      // `expr!` NARROWS away the nullable arm — that is the point of the operator, and
      // why it cannot simply be erased. On a non-nullable operand it is the identity.
      case "NonNullExpr": return baseTy(this.type(e.expr, scope, hint));
      case "InstanceOfExpr": {
        // `x instanceof C`, decided here and folded to a constant by codegen. A value's
        // static type IS its exact class in this subset (user classes don't inherit, and
        // nothing is polymorphic), so the answer is the same one node computes.
        const ot = this.type(e.object, scope);
        const c = e.className;
        if (c === "Array") e.result = isArrayTy(ot);
        else if (c === "Uint8Array") e.result = isBytesTy(ot);
        else if (c === "Map") e.result = isMapTy(ot);
        else if (c === "Set") e.result = isSetTy(ot);
        else if (this.functions.has(`${c}.constructor`)) e.result = classTag(ot) === c;
        else throw nyi(NYI.INSTANCEOF, `'instanceof ${c}'${c === "Error" ? " (Error is modelled structurally as {message:string})" : ""}`);
        e.ty = "boolean";
        return "boolean";
      }
      case "CallExpr": return this.inferCall(e, scope, hint);
    }
  }

  /** Type of the first `throw` reachable in a body (for the catch binding). */
  private inferThrowType(stmts: Stmt[], scope: Scope): Ty | undefined {
    // SH4: a host FFI call throws an ERROR, exactly like node's `fs` — so a block
    // containing one binds `catch (e)` to `{message:string}` and `e.message` is the
    // node-identical text. Checked before the `throw` scan (an explicit throw in the
    // same block still wins, since it decides the type it actually throws).
    if (this.hostImports.size && stmts.some((s) => hasHostCall(s, this.hostImports))) {
      const explicit = this.firstThrowType(stmts, scope);
      return explicit ?? "{message:string}";
    }
    return this.firstThrowType(stmts, scope);
  }

  private firstThrowType(stmts: Stmt[], scope: Scope): Ty | undefined {
    for (const s of stmts) {
      let t: Ty | undefined;
      if (s.kind === "ThrowStmt") t = this.type(s.argument, scope);
      else if (s.kind === "IfStmt") t = this.firstThrowType(s.consequent, scope) ?? (s.alternate ? this.firstThrowType(s.alternate, scope) : undefined);
      else if (s.kind === "WhileStmt" || s.kind === "DoWhileStmt" || s.kind === "ForOfStmt" || s.kind === "ForInStmt" || s.kind === "ForStmt") t = this.firstThrowType(s.body, scope);
      else if (s.kind === "BlockStmt") t = this.firstThrowType(s.body, scope);
      else if (s.kind === "MultiStmt") t = this.firstThrowType(s.stmts, scope);
      if (t) return t;
    }
    return undefined;
  }

  private calleeArity(callee: Expr, scope: Scope): number | undefined {
    if (callee.kind === "Identifier") {
      const b = scope.lookup(callee.name);
      if (b && isFuncTy(b.ty)) return funcParams(b.ty).length;
      const sig = this.functions.get(callee.name);
      // A REST parameter has no arity to expand against: `sig.params.length` counts it
      // as ONE parameter, so `total(...xs)` would expand to `total(xs[0])` and quietly
      // answer 1 where node answers 6. Report "no known arity" so the caller REFUSES
      // (NT1006) instead — general variadics are a separate, much larger feature.
      if (sig) return sig.rest ? undefined : sig.params.length;
    }
    return undefined; // variadic builtin / method
  }

  private inferCall(e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope, hint?: Ty): Ty {
    // `Math.max(...xs)` / `Math.min(...xs)` — the ONE variadic builtin that accepts a
    // spread of a runtime-length array, because its fold has a well-defined IDENTITY
    // (-Infinity / +Infinity). So the length need not be known at compile time and an
    // EMPTY array is meaningful rather than an arity error. Every other variadic still
    // falls through to the NT1006 refusal below — see docs/divergences.md.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Math"
        && (e.callee.property === "max" || e.callee.property === "min")
        && e.args.some((a) => a.kind === "SpreadExpr")) {
      const m = e.callee.property;
      // `...[a, b]` has its length right here — inline it, so no array is ever built.
      e.args = e.args.flatMap((a) =>
        a.kind === "SpreadExpr" && a.argument.kind === "ArrayLiteral" ? a.argument.elements : [a]);
      for (const a of e.args) {
        if (a.kind === "SpreadExpr") {
          const t = this.type(a.argument, scope);
          if (t !== "number[]") throw typeError(`Math.${m} can spread a number[], not ${String(t)}`);
        } else if (this.type(a, scope) !== "number") throw typeError(`Math.${m} needs numbers`);
      }
      return "number";
    }

    // Expand a single spread argument: `f(...[a,b])` inline; `f(...arr)` → f(arr[0]..arr[n-1]).
    if (e.args.length === 1 && e.args[0]!.kind === "SpreadExpr") {
      const arg = (e.args[0] as Extract<Expr, { kind: "SpreadExpr" }>).argument;
      if (arg.kind === "ArrayLiteral") {
        e.args = arg.elements;
      } else {
        const arity = this.calleeArity(e.callee, scope);
        if (arity === undefined) throw nyi(NYI.SPREAD, "spread of a value into a variadic/method call");
        e.args = Array.from({ length: arity }, (_, i) => ({ kind: "IndexExpr", object: arg, index: { kind: "NumberLiteral", value: i } }) as Expr);
      }
    }
    for (const a of e.args) if (a.kind === "SpreadExpr") throw nyi(NYI.SPREAD, "spread in calls");

    // console.log / error / warn / info / debug (...)
    const cm = consoleMethod(e);
    if (cm !== null) {
      if (!CONSOLE_STREAMS.has(cm))
        throw nyi(NYI.CONSOLE, `console.${cm}`);
      // Stage 49: node reads format specifiers from a LEADING STRING argument, so an
      // argument's ROLE decides what it must be renderable as — `%d` of an object is
      // node's `NaN` and needs no inspect, `%c` discards its argument entirely.
      const plan = planConsoleFormat(e.args);
      const bySpec = plan ? fmtSpecByArg(plan) : null;
      for (const [i, a] of e.args.entries()) {
        const at = this.type(a, scope);
        if (plan && i === 0) continue; // the format string itself, consumed
        const spec = bySpec?.get(i);
        if (spec !== undefined) { checkFormatArg(spec, at); continue; }
        checkConsoleArg(at);
      }
      return "void";
    }

    // move(x) — ownership marker; identity for typing (see src/ownership.ts)
    if (e.callee.kind === "Identifier" && e.callee.name === "move") {
      if (e.args.length !== 1) throw typeError("move() takes exactly one argument");
      return this.type(e.args[0]!, scope);
    }

    // B3 v0 actor surface — spawn / send / receive / self / __drain.
    // v0 messages are `number` (the future `Dyn` grows this). Not shadowable by a
    // user binding of the same name (these are recognized like Math.*/console.log).
    if (e.callee.kind === "Identifier" && ACTOR_BUILTINS.has(e.callee.name) && !scope.lookup(e.callee.name)) {
      const name = e.callee.name;
      if (name === "self") {
        if (e.args.length !== 0) throw typeError("self() takes no arguments");
        return "number"; // pid
      }
      // v4 receive: `receive()` blocks; `receive(ms)` is Erlang's `after` and yields
      // `T | undefined` (A2 nullable) so a timeout is observably distinct from any real
      // message. The message type T comes from CONTEXT (the declared type of the binding
      // — `const m: string = receive()`), defaulting to number, and is checked at
      // runtime against the sender's kind, so it can never be a miscompile.
      if (name === "receive") {
        if (e.args.length > 1) throw typeError("receive(timeoutMs?) takes at most one argument");
        const base = actorMsgTy(hint);
        if (e.args.length === 0) return base;
        if (this.type(e.args[0]!, scope) !== "number") throw typeError("receive: the timeout must be a number (ms)");
        return makeNullable("undefined", base);
      }
      // v4 selective receive: `receiveMatch(pred)` takes the FIRST message satisfying
      // `pred`, leaving the rest queued in order (OTP's save queue). T comes from the
      // predicate's parameter type. `receiveMatch(pred, ms)` adds the timeout.
      if (name === "receiveMatch") {
        if (e.args.length < 1 || e.args.length > 2)
          throw typeError("receiveMatch(pred, timeoutMs?) takes one or two arguments");
        const predTy = this.type(e.args[0]!, scope);
        if (!isFuncTy(predTy) || funcParams(predTy).length !== 1)
          throw typeError("receiveMatch: pred must be a one-argument function (msg) => boolean");
        if (funcRet(predTy) !== "boolean") throw typeError("receiveMatch: pred must return boolean");
        const base = actorSendTy(funcParams(predTy)[0]!);
        if (e.args.length === 1) return base;
        if (this.type(e.args[1]!, scope) !== "number") throw typeError("receiveMatch: the timeout must be a number (ms)");
        return makeNullable("undefined", base);
      }
      if (name === "__drain") {
        if (e.args.length !== 0) throw typeError("__drain() takes no arguments");
        return "void";
      }
      // v6 debug introspection: resolved scheduler-thread count, how many of them
      // actually ran an actor, and how many actors were work-STOLEN across queues.
      if (name === "__schedulers" || name === "__schedUsed" || name === "__schedSteals") {
        if (e.args.length !== 0) throw typeError(`${name}() takes no arguments`);
        return "number";
      }
      // v2/v3 surface — registry / links / monitors / trap / fault injection / supervision
      if (name === "register") {
        if (e.args.length !== 2) throw typeError("register(name, pid) takes two arguments");
        if (this.type(e.args[0]!, scope) !== "string") throw typeError("register: name must be a string");
        if (this.type(e.args[1]!, scope) !== "number") throw typeError("register: pid must be a number");
        return "void";
      }
      if (name === "whereis") {
        if (e.args.length !== 1) throw typeError("whereis(name) takes one argument");
        if (this.type(e.args[0]!, scope) !== "string") throw typeError("whereis: name must be a string");
        return "number"; // pid (0 if absent)
      }
      if (name === "link" || name === "__kill") {
        if (e.args.length !== 1) throw typeError(`${name}(pid) takes one argument`);
        if (this.type(e.args[0]!, scope) !== "number") throw typeError(`${name}: pid must be a number`);
        return "void";
      }
      if (name === "monitor") {
        if (e.args.length !== 1) throw typeError("monitor(pid) takes one argument");
        if (this.type(e.args[0]!, scope) !== "number") throw typeError("monitor: pid must be a number");
        return "number"; // ref
      }
      if (name === "trapExit") {
        if (e.args.length !== 1) throw typeError("trapExit(on) takes one argument");
        if (this.type(e.args[0]!, scope) !== "boolean") throw typeError("trapExit: on must be a boolean");
        return "void";
      }
      if (name === "exit") {
        if (e.args.length !== 2) throw typeError("exit(pid, reason) takes two arguments");
        if (this.type(e.args[0]!, scope) !== "number") throw typeError("exit: pid must be a number");
        if (this.type(e.args[1]!, scope) !== "number") throw typeError("exit: reason must be a number");
        return "void";
      }
      if (name === "__crash") {
        if (e.args.length !== 1) throw typeError("__crash(reason) takes one argument");
        if (this.type(e.args[0]!, scope) !== "number") throw typeError("__crash: reason must be a number");
        return "void";
      }
      if (name === "supervise") {
        if (e.args.length !== 2) throw typeError("supervise(children, opts) takes two arguments");
        // children is an array LITERAL of ChildSpec objects. General `object[]` is a
        // deferred feature, so supervise types the literal here directly (each element
        // + the array node get their `.ty` set for codegen) rather than routing through
        // the array-of-scalars-only inference.
        const childrenArg = e.args[0]!;
        if (childrenArg.kind !== "ArrayLiteral" || childrenArg.elements.length === 0)
          throw typeError("supervise: children must be a non-empty array literal of ChildSpec objects");
        let child: Ty | null = null;
        for (const el of childrenArg.elements) {
          if (el.kind === "SpreadExpr") throw typeError("supervise: children may not use spread");
          const et = this.type(el, scope); // sets el.ty
          if (!isObjectTy(et)) throw typeError("supervise: each child must be a ChildSpec object");
          if (child === null) child = et;
          else if (et !== child) throw typeError("supervise: all children must share one ChildSpec shape");
        }
        childrenArg.ty = `${child}[]` as Ty; // array node type for codegen (reads e.ty)
        if (fieldType(child!, "id") !== "string") throw typeError("supervise: ChildSpec.id must be a string");
        const startTy = fieldType(child!, "start");
        if (!startTy || !isFuncTy(startTy) || funcParams(startTy).length !== 0 || funcRet(startTy) !== "number")
          throw typeError("supervise: ChildSpec.start must be a () => Pid");
        if (fieldType(child!, "restart") !== "string") throw typeError("supervise: ChildSpec.restart must be a string");
        const ot = this.type(e.args[1]!, scope);
        if (!isObjectTy(ot)) throw typeError("supervise: opts must be an object");
        if (fieldType(ot, "strategy") !== "string") throw typeError("supervise: opts.strategy must be a string");
        if (fieldType(ot, "maxRestarts") !== "number") throw typeError("supervise: opts.maxRestarts must be a number");
        if (fieldType(ot, "maxSeconds") !== "number") throw typeError("supervise: opts.maxSeconds must be a number");
        return "number"; // supervisor pid
      }
      if (name === "send") {
        if (e.args.length !== 2) throw typeError("send(to, msg) takes two arguments");
        if (this.type(e.args[0]!, scope) !== "number") throw typeError("send: pid must be a number");
        actorSendTy(this.type(e.args[1]!, scope)); // number | string | record/array; else a code
        return "void";
      }
      // spawn(body, arg): body is (msg) => void; returns the new pid (number).
      const expected = makeFuncTy(["number"], "void"); // default message type
      const bodyTy = this.typeArg(e.args[0]!, expected, scope);
      if (!isFuncTy(bodyTy) || funcParams(bodyTy).length !== 1) throw typeError("spawn: body must be a one-argument function");
      // The body's return value is ignored (the actor entry trampoline discards it),
      // so any inferred return type is fine — nativets defaults empty blocks to number.
      const msgTy = actorSendTy(funcParams(bodyTy)[0]!);
      if (e.args.length !== 2) throw typeError("spawn(body, arg) takes two arguments");
      if (this.type(e.args[1]!, scope) !== msgTy) throw typeError(`spawn: arg type must match the body's parameter (${msgTy})`);
      return "number"; // pid
    }

    // Host I/O: process.exit(code?) — not shadowable by a user `process` binding.
    if (
      e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" &&
      e.callee.object.name === "process" && !scope.lookup("process")
    ) {
      if (e.callee.property !== "exit") throw typeError(`process.${e.callee.property}() is not supported`);
      if (e.args.length > 1) throw typeError("process.exit(code?) takes at most one argument");
      if (e.args.length === 1 && this.type(e.args[0]!, scope) !== "number") throw typeError("process.exit: code must be a number");
      return "void";
    }

    // JSON.stringify(x) / JSON.parse(s): Dyn
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "JSON") {
      if (e.callee.property === "parse") {
        if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError("JSON.parse(text: string)");
        return "Dyn";
      }
      if (e.callee.property !== "stringify") throw nyi(NYI.JSON, `JSON.${e.callee.property}`);
      if (e.args.length < 1 || e.args.length > 3) throw typeError("JSON.stringify expects 1 to 3 arguments");
      // SH2: the serializer is generated from the STATIC type, and an un-narrowed union
      // does not have one shape — it used to fall through to the literal `null`, which is
      // a silent wrong answer. Refuse; narrowing gives it a member to serialize.
      const jt = this.type(e.args[0]!, scope);
      checkUnionRenderable(jt, "JSON.stringify");
      refuseUnboxedUnion(jt, "JSON.stringify"); // rendered the box as the literal `null`
      // Exhaustive: everything the serializer has no node-exact rule for is refused
      // here, including the `undefined` at the ROOT that used to render `null`.
      checkJsonStringifyArg(jt, "root");
      // arg2 (replacer) — only `null`/`undefined` supported (no array/function replacer).
      if (e.args.length >= 2) {
        const r = e.args[1]!;
        if (r.kind !== "NullLiteral" && r.kind !== "UndefinedLiteral")
          throw nyi(NYI.JSON, "JSON.stringify replacer (only null is supported)");
      }
      // arg3 (space/indent) — a literal number or string so the indent is known at compile time.
      if (e.args.length === 3) {
        const s = e.args[2]!;
        if (s.kind !== "NumberLiteral" && s.kind !== "StringLiteral")
          throw nyi(NYI.JSON, "JSON.stringify indent (must be a number or string literal)");
      }
      return "string";
    }

    // Object.keys(o) / Object.values(o) — keys are compile-time known from o's type.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object" && !scope.lookup("Object")) {
      const p = e.callee.property;
      // Object.fromEntries([[k, v], …]) — the keys must be compile-time known, so the
      // argument must be a literal array of literal [stringLiteral, value] pairs. The
      // result type is built from those keys, exactly like an object literal.
      if (p === "fromEntries") {
        if (e.args.length !== 1) throw typeError("Object.fromEntries expects 1 argument");
        const lit = e.args[0]!;
        if (lit.kind !== "ArrayLiteral" || lit.elements.length === 0)
          throw nyi(NYI.OBJECT, "Object.fromEntries of a non-literal (keys must be known at compile time)");
        const fields: string[] = [];
        for (const pair of lit.elements) {
          if (pair.kind !== "ArrayLiteral" || pair.elements.length !== 2 || pair.elements[0]!.kind !== "StringLiteral")
            throw nyi(NYI.OBJECT, "Object.fromEntries entries (each must be a literal [\"key\", value] pair)");
          const key = (pair.elements[0] as { value: string }).value;
          const vt = this.type(pair.elements[1]!, scope);
          if (vt !== "number" && vt !== "string" && vt !== "boolean") throw nyi(NYI.OBJECT, `Object.fromEntries value of type ${vt}`);
          fields.push(`${key}:${vt}`);
        }
        return `{${fields.join(",")}}` as Ty;
      }
      // --- stdlib Batch 3 ---
      // `Object.freeze(o)` is the IDENTITY here and honestly so: objects are already
      // immutable (Stage 29), so freezing changes nothing and node's contract —
      // "returns the same object, now non-writable" — is met exactly.
      if (p === "freeze" || p === "isFrozen") {
        if (e.args.length !== 1) throw typeError(`Object.${p} expects 1 argument`);
        const ot = this.type(e.args[0]!, scope);
        if (!isObjectTy(ot)) throw typeError(`Object.${p} expects an object`);
        return p === "isFrozen" ? "boolean" : ot;
      }
      // `Object.assign(target, …)` MUTATES its target — the one thing this language
      // does not do. Point at the object spread that expresses the same intent.
      if (p === "assign" || p === "defineProperty" || p === "setPrototypeOf")
        throw mutationError(`Object.${p} mutates its target object`,
          "objects are immutable — build a new one with spread: `const merged = { ...a, ...b }`");
      if (p !== "keys" && p !== "values" && p !== "entries" && p !== "getOwnPropertyNames") throw nyi(NYI.OBJECT, `Object.${p}`);
      if (e.args.length !== 1) throw typeError(`Object.${p} expects 1 argument`);
      const ot = this.type(e.args[0]!, scope);
      if (!isObjectTy(ot)) throw typeError(`Object.${p} expects an object`);
      enumerableOrThrow(ot, `Object.${p}`);
      // `getOwnPropertyNames` == `keys` for a plain record (no non-enumerable props here).
      if (p === "keys" || p === "getOwnPropertyNames") return "string[]";
      if (p === "entries") {
        // [key, value] pairs. A pair is an ARRAY, and arrays are homogeneous here, so a
        // pair is only representable when the values are strings (string[] pairs).
        const fs = objectFields(ot);
        if (fs.length === 0) throw nyi(NYI.OBJECT, "Object.entries of an empty object");
        if (!fs.every((f) => f.ty === "string"))
          throw nyi(NYI.OBJECT, "Object.entries of a non-string-valued object (a [string, T] pair is a mixed-type tuple; use Object.keys + field access)");
        return "string[][]";
      }
      // values → T[]; require a homogeneous value type (our arrays are homogeneous).
      const fs = objectFields(ot);
      if (fs.length === 0) throw nyi(NYI.OBJECT, "Object.values of an empty object");
      const vt = fs[0]!.ty;
      if (!fs.every((f) => f.ty === vt)) throw nyi(NYI.OBJECT, "Object.values of a heterogeneous object (arrays are homogeneous)");
      return `${vt}[]` as Ty;
    }

    // --- stdlib (web standards) Batch 1: static-namespace member calls ---
    // String.fromCharCode(...nums) / String.fromCodePoint(...nums) → string.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "String" && !scope.lookup("String")) {
      const p = e.callee.property;
      if (p !== "fromCharCode" && p !== "fromCodePoint") throw nyi(NYI.OBJECT, `String.${p}`);
      for (const a of e.args) if (this.type(a, scope) !== "number") throw typeError(`String.${p} needs numbers`);
      return "string";
    }
    // Number.isInteger/isFinite/isSafeInteger(x) → boolean (no coercion; x is a number).
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Number" && !scope.lookup("Number")) {
      const p = e.callee.property;
      // Number.isNaN / parseInt / parseFloat are the namespaced aliases of the globals
      // (isNaN does NOT coerce — but the argument is already statically a number).
      if (p === "isNaN" || p === "parseInt" || p === "parseFloat") {
        const g = GLOBAL_FUNCS[p === "isNaN" ? "isNaN" : p]!;
        this.checkArgs(e.args, g, scope, `Number.${p}`);
        return g.ret;
      }
      if (p !== "isInteger" && p !== "isFinite" && p !== "isSafeInteger") throw nyi(NYI.OBJECT, `Number.${p}`);
      if (e.args.length !== 1) throw typeError(`Number.${p} expects 1 argument`);
      if (this.type(e.args[0]!, scope) !== "number") throw typeError(`Number.${p} expects a number`);
      return "boolean";
    }
    // Array.isArray(x) → boolean (compile-time from x's static type); Array.from(str) → string[].
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Array" && !scope.lookup("Array")) {
      const p = e.callee.property;
      if (p === "isArray") {
        if (e.args.length !== 1) throw typeError("Array.isArray expects 1 argument");
        this.type(e.args[0]!, scope); // evaluated for side effects
        return "boolean";
      }
      if (p === "from") {
        if (e.args.length !== 1) throw typeError("Array.from expects 1 argument");
        // Array.from(map.keys()) / Array.from(set) — an iteration position. This
        // subsumes the plain `Array.from(arr)` / `Array.from(str)` forms: asIterable
        // passes an array or string straight through and only rewrites collections.
        const from = this.asIterable(e.args[0]!, scope, "Array.from");
        e.args[0] = from.expr;
        const at = from.ty;
        if (isArrayTy(at)) return at;                     // arrays / Map-Set iterators → a copy
        if (at !== "string") throw nyi(NYI.ARRAY, "Array.from of a non-string, non-array");
        return "string[]";
      }
      if (p === "of") { // Array.of(...items) ≡ an array literal of the arguments
        if (e.args.length === 0) throw nyi(NYI.ARRAY, "Array.of() with no arguments (empty array literals need an element type)");
        const ts = e.args.map((a) => this.type(a, scope));
        if (ts.some((t) => t !== ts[0])) throw typeError("Array.of expects arguments of one type (arrays are homogeneous)");
        if (ts[0] !== "number" && ts[0] !== "string" && ts[0] !== "boolean") throw nyi(NYI.ARRAY, `Array.of of ${ts[0]}`);
        return `${ts[0]}[]` as Ty;
      }
      throw nyi(NYI.OBJECT, `Array.${p}`);
    }
    // Date.now() → number (ms since epoch).
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Date" && !scope.lookup("Date")) {
      if (e.callee.property !== "now") throw nyi(NYI.OBJECT, `Date.${e.callee.property}`);
      if (e.args.length !== 0) throw typeError("Date.now expects no arguments");
      return "number";
    }

    // --- Networking tier: `fetch` (the web standard, on the libcurl primitive) ---
    // `fetch(url)` / `fetch(url, init)` → Response. The call BLOCKS (no event loop);
    // `await` in front of it is an identity pass-through — see docs/divergences.md.
    if (e.callee.kind === "Identifier" && e.callee.name === "fetch" && !scope.lookup("fetch")) return this.inferFetch(e, scope);
    // Explicit promise plumbing means nothing without an event loop — reject (NT1020)
    // rather than pretend `Promise.all` runs anything in parallel.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Promise" && !scope.lookup("Promise")) {
      throw nyi(NYI.ASYNC, `Promise.${e.callee.property}`);
    }

    // Math.X(...)
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Math") {
      const m = e.callee.property;
      const arity = MATH_METHODS[m];
      if (arity === undefined) throw typeError(`Math.${m} is not supported`);
      for (const a of e.args) { if (this.type(a, scope) !== "number") throw typeError(`Math.${m} needs numbers`); }
      if (arity !== "var" && e.args.length !== arity) throw typeError(`Math.${m} expects ${arity} args`);
      return "number";
    }

    // `C.m(args)` — a STATIC method call. The class name is a NAMESPACE, not a value, so
    // there is no receiver to type: rewrite the callee to the lowered top-level function
    // `C.m` and let the ordinary named-call path below check the arguments. (A local
    // binding of the class's name wins, exactly as it would for any other identifier.)
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && !scope.lookup(e.callee.object.name)) {
      const cname = e.callee.object.name, lowered = `${cname}.${e.callee.property}`;
      if (this.statics.has(lowered)) e.callee = { kind: "Identifier", name: lowered };
      // The reverse mix-up: an INSTANCE method reached through the class name. It lowers
      // to the same shape of name, so say so rather than leaving the class name to fail
      // as an undefined identifier (in node the class object has no such property at all).
      else if (this.functions.has(lowered)) {
        throw typeError(`'${e.callee.property}' is an instance method of ${cname}, not a static — call it on an instance (\`inst.${e.callee.property}(…)\`)`);
      }
    }

    // receiver.method(...)
    if (e.callee.kind === "MemberExpr") {
      const recv = this.type(e.callee.object, scope);
      // class instance method: `inst.m(args)` → the lowered `C.m(this, …)`.
      const cls = classTag(recv);
      if (cls) {
        // A STATIC is not on the instance — it has no receiver at all, so an instance
        // cannot reach it (node: `p.make is not a function`). Point at the class.
        if (this.statics.has(`${cls}.${e.callee.property}`))
          throw typeError(`'${e.callee.property}' is a static method of ${cls}, not an instance method — call it on the class (\`${cls}.${e.callee.property}(…)\`)`);
        // A GENERIC method is a TEMPLATE, not a signature: resolve its type arguments
        // from these arguments and instantiate, then check the call against the
        // fully-concrete specialization exactly like an ordinary method. `recvOffset` 1
        // tells `instantiate` that the template's leading `this` has no argument.
        const msig = this.generics.has(`${cls}.${e.callee.property}`)
          ? this.instantiate(`${cls}.${e.callee.property}`, e, scope, 1)
          : this.functions.get(`${cls}.${e.callee.property}`);
        if (!msig) {
          if (fieldType(recv, e.callee.property)) throw typeError(`'${e.callee.property}' is a field of ${cls}, not a method`);
          throw typeError(`Method '${e.callee.property}' does not exist on ${cls}`);
        }
        const min = msig.required - 1, max = msig.params.length - 1;
        if (e.args.length < min || e.args.length > max) throw typeError(`'${cls}.${e.callee.property}' expects ${min}..${max} args, got ${e.args.length}`);
        e.args.forEach((a, i) => {
          const exp = msig.params[i + 1]!;
          const at = this.typeArg(a, exp, scope);
          if (!this.fitsArg(exp, at, a)) throw typeError(`'${cls}.${e.callee.property}' arg ${i} expects ${exp}, got ${at}`);
        });
        return msig.ret;
      }
      // `.then` / `.catch` / `.finally` are promise plumbing — no event loop, so the
      // callback ordering they promise cannot be honored. Reject (NT1020).
      if (["then", "catch", "finally"].includes(e.callee.property)) throw nyi(NYI.ASYNC, `'.${e.callee.property}()' on ${recv}`);
      // fetch's Response: `await res.text()` → string, `await res.json()` → Dyn (which
      // then narrows with `dyn as T`, reusing the Stage-20 runtime validator).
      if (isResponseTy(recv)) {
        if (e.args.length !== 0) throw typeError(`Response.${e.callee.property}() takes no arguments`);
        if (e.callee.property === "text") return "string";
        if (e.callee.property === "json") return "Dyn";
        throw nyi(NYI.OBJECT, `Response method '.${e.callee.property}' (supported: .text(), .json(), .status, .ok, .headers)`);
      }
      // Response headers — `res.headers.get(name)` is case-insensitive per the spec and
      // returns `string | null` (node's exact shape), so `?? "fallback"` composes.
      if (isHeadersTy(recv)) {
        if (e.callee.property !== "get" && e.callee.property !== "has")
          throw nyi(NYI.OBJECT, `Headers method '.${e.callee.property}' (supported: .get(name), .has(name))`);
        if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError(`Headers.${e.callee.property}(name: string)`);
        return e.callee.property === "has" ? "boolean" : makeNullable("null", "string");
      }
      // --- stdlib Batch 3: Date / URLSearchParams instance methods ---
      if (isDateTy(recv)) return this.inferDateMethod(e.callee.property, e.args, scope);
      if (isSearchParamsTy(recv)) return this.inferSearchParamsMethod(e.callee.property, e.args, scope);
      if (isMapTy(recv)) return this.inferMapMethod(recv, e.callee.property, e.args, scope, e);
      if (isSetTy(recv)) return this.inferSetMethod(recv, e.callee.property, e.args, scope, e);
      // Bytes (stdlib batch 2): TextEncoder#encode(string) -> Uint8Array (UTF-8);
      // TextDecoder#decode(Uint8Array) -> string (UTF-8).
      if (isTextEncoderTy(recv)) {
        if (e.callee.property !== "encode") throw nyi(NYI.OBJECT, `TextEncoder method '${e.callee.property}'`);
        if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError("TextEncoder.encode expects (string)");
        return "Uint8Array";
      }
      if (isTextDecoderTy(recv)) {
        if (e.callee.property !== "decode") throw nyi(NYI.OBJECT, `TextDecoder method '${e.callee.property}'`);
        if (e.args.length !== 1 || !isBytesTy(this.type(e.args[0]!, scope))) throw typeError("TextDecoder.decode expects (Uint8Array)");
        return "string";
      }
      if (isArrayTy(recv)) return this.inferArrayMethod(recv, e.callee, e.args, scope);
      // stdlib Batch 1: Number#toFixed(digits) — the digit count must be a literal
      // 0..100 so the RangeError node throws for anything else is impossible here.
      if (recv === "number") {
        // Number#toString(radix) — radix must be a literal 2..36 (node throws
        // RangeError otherwise, which we make impossible rather than emulate).
        if (e.callee.property === "toString") {
          if (e.args.length > 1) throw typeError(".toString expects 0..1 args");
          if (e.args.length === 1) {
            const r = e.args[0]!;
            if (r.kind !== "NumberLiteral" || r.value < 2 || r.value > 36 || Math.floor(r.value) !== r.value)
              throw nyi(NYI.OBJECT, ".toString(radix) with a non-literal / out-of-range radix (node throws RangeError outside 2..36)");
          }
          return "string";
        }
        if (e.callee.property !== "toFixed") throw nyi(NYI.OBJECT, `number method '${e.callee.property}'`);
        if (e.args.length > 1) throw typeError(".toFixed expects 0..1 args");
        if (e.args.length === 1) {
          const d = e.args[0]!;
          if (d.kind !== "NumberLiteral" || d.value < 0 || d.value > 100 || Math.floor(d.value) !== d.value)
            throw nyi(NYI.OBJECT, ".toFixed(digits) with a non-literal / out-of-range digit count (node throws RangeError outside 0..100)");
        }
        return "string";
      }
      if (recv === "string") {
        // .concat is VARIADIC (all-string args) — outside the fixed-arity table.
        if (e.callee.property === "concat") {
          for (const a of e.args) if (this.type(a, scope) !== "string") throw typeError(".concat expects strings");
          return "string";
        }
        // stdlib Batch 3 — the two string methods that need data we do not ship, named
        // precisely instead of falling into the generic "not supported" bucket:
        // `normalize` needs the Unicode canonical decomposition/composition tables
        // (NFC/NFD/NFKC/NFKD), `localeCompare` needs ICU collation (which is why
        // "a".localeCompare("B") is -1 in node but +1 under a byte compare). Both are
        // silently-wrong-looking if approximated, so they are refused.
        if (e.callee.property === "normalize")
          throw nyi(NYI.WEBAPI, "String#normalize (Unicode NFC/NFD normalization needs the Unicode character database, which nativets does not ship — nativets strings are raw UTF-8 bytes)");
        if (e.callee.property === "localeCompare" || e.callee.property.startsWith("toLocale"))
          throw nyi(NYI.WEBAPI, `String#${e.callee.property} (locale-aware ${e.callee.property === "localeCompare" ? "collation" : "formatting"} needs ICU; use ${e.callee.property === "localeCompare" ? "`<` / `>` (code-point order, see docs/divergences.md)" : "the non-locale form"})`);
        const sig = STRING_METHODS[e.callee.property];
        if (!sig) throw nyi(NYI.OBJECT, `string method '${e.callee.property}'`);
        this.checkArgs(e.args, sig, scope, `'.${e.callee.property}'`);
        return sig.ret;
      }
      throw nyi(NYI.OBJECT, `method call on ${recv}`);
    }

    // stdlib Batch 1: structuredClone(v) — a TYPE-DIRECTED deep copy, so its result
    // type is its argument's type (identity), like the structured-clone algorithm.
    if (e.callee.kind === "Identifier" && e.callee.name === "structuredClone" && !scope.lookup("structuredClone")) {
      if (e.args.length !== 1) throw typeError("structuredClone expects 1 argument");
      const t = this.type(e.args[0]!, scope);
      if (!(t === "number" || t === "string" || t === "boolean" || isObjectTy(t) || isArrayTy(t)))
        throw nyi(NYI.OBJECT, `structuredClone of ${t} (only scalars, objects and arrays are cloneable — node throws DataCloneError for functions)`);
      return t;
    }

    // Host FFI (SH4) — in scope only because a `node:` import brought it in.
    if (e.callee.kind === "Identifier" && this.hostImports.has(e.callee.name)) {
      const h = HOST_FUNCS[e.callee.name]!;
      this.checkHostCall(e.callee.name, e.args);
      this.checkArgs(e.args, h, scope, e.callee.name);
      return h.ret;
    }

    // global builtin, function value, or user function
    if (e.callee.kind === "Identifier") {
      const g = GLOBAL_FUNCS[e.callee.name];
      if (g) { this.checkArgs(e.args, g, scope, e.callee.name); return g.ret; }

      // calling a function VALUE (a variable/param whose type is a function type)
      const bound = scope.lookup(e.callee.name);
      if (bound && isFuncTy(bound.ty)) {
        const ps = funcParams(bound.ty);
        if (e.args.length !== ps.length) throw typeError(`'${e.callee.name}' expects ${ps.length} arguments, got ${e.args.length}`);
        e.args.forEach((a, i) => {
          const at = this.typeArg(a, ps[i]!, scope);
          if (at !== ps[i]) throw typeError(`'${e.callee.name}' arg ${i} expects ${ps[i]}, got ${at}`);
        });
        return funcRet(bound.ty);
      }

      // M3: a call to a GENERIC declaration resolves its type arguments, instantiates the
      // matching specialization, and rewrites the callee to it — after which the argument
      // checking below is exactly the ordinary concrete-signature path.
      const sig = this.generics.has(e.callee.name)
        ? this.instantiate(e.callee.name, e, scope)
        : this.functions.get(e.callee.name);
      if (!sig) {
        // An unknown name that this module IMPORTS is not the closure gap — it is an
        // unlinked check. Say so, rather than sending the reader at captured environments.
        const from = this.importedFrom.get(e.callee.name);
        if (from !== undefined) throw unlinkedImportError(e.callee.name, from);
        throw nyi(NYI.CLOSURE, `call to '${e.callee.name}' (function values / unknown callee)`);
      }
      if (sig.rest) {
        const fixed = sig.params.length - 1;
        if (e.args.length < sig.required) throw typeError(`'${e.callee.name}' expects at least ${sig.required} args`);
        const restElem = elemTy(sig.params[fixed]!);
        e.args.forEach((a, i) => {
          const exp = i < fixed ? sig.params[i]! : restElem;
          const at = this.typeArg(a, exp, scope);
          if (!this.fitsArg(exp, at, a)) throw typeError(`'${e.callee.name}' arg ${i} expects ${exp}, got ${at}`);
        });
        return sig.ret;
      }
      if (e.args.length < sig.required || e.args.length > sig.params.length) {
        throw typeError(`'${e.callee.name}' expects ${sig.required}..${sig.params.length} args, got ${e.args.length}`);
      }
      e.args.forEach((a, i) => {
        const at = this.typeArg(a, sig.params[i]!, scope); // contextual: function-typed params type their arrow args
        if (!this.fitsArg(sig.params[i]!, at, a)) throw typeError(`'${e.callee.name}' arg ${i} expects ${sig.params[i]}, got ${at}`);
      });
      return sig.ret;
    }
    // arbitrary expression callee of function type, e.g. compose(f, g)(x)
    const ct = this.type(e.callee, scope);
    if (isFuncTy(ct)) {
      const ps = funcParams(ct);
      if (e.args.length !== ps.length) throw typeError(`call expects ${ps.length} arguments, got ${e.args.length}`);
      e.args.forEach((a, i) => { const at = this.typeArg(a, ps[i]!, scope); if (!this.fitsArg(ps[i]!, at, a)) throw typeError(`arg ${i} expects ${ps[i]}, got ${at}`); });
      return funcRet(ct);
    }
    throw nyi(NYI.CLOSURE, "unsupported call target");
  }

  /**
   * `fetch(url, init?)` → Response. `init` is an ordinary object literal/value whose
   * shape is read STATICALLY (like everything else here): `method`/`body` are strings
   * and `headers` is an object of string values, so codegen can unroll the header
   * block at compile time. Unknown init keys are refused rather than dropped silently.
   */
  private inferFetch(e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope): Ty {
    if (e.args.length < 1 || e.args.length > 2) throw typeError("fetch(url, init?) expects 1 or 2 arguments");
    if (this.type(e.args[0]!, scope) !== "string") throw typeError("fetch: url must be a string");
    if (e.args.length === 2) {
      const it = this.type(e.args[1]!, scope);
      if (!isObjectTy(it)) throw typeError("fetch: init must be an object ({ method, headers, body })");
      for (const f of objectFields(it)) {
        if (f.key === "method" || f.key === "body") {
          if (f.ty !== "string") throw typeError(`fetch: init.${f.key} must be a string`);
        } else if (f.key === "headers") {
          if (!isObjectTy(f.ty)) throw typeError("fetch: init.headers must be an object of string values");
          for (const h of objectFields(f.ty)) if (h.ty !== "string") throw typeError(`fetch: header '${h.key}' must be a string`);
        } else {
          throw nyi(NYI.OBJECT, `fetch init option '${f.key}' (supported: method, headers, body)`);
        }
      }
    }
    return "Response";
  }

  /** Immutable Map methods (B2): .set/.get/.has/.delete. `.set`/`.delete` return a NEW map. */
  /**
   * `for (const [k, v] of m)` / `of m.entries()`. Strips a trailing `.entries()` so
   * `iterable` is the Map itself, then binds k:K and v:V for the body. Iteration is
   * insertion-ordered (the runtime's key log), matching node exactly.
   */
  private checkMapEntriesLoop(s: ForOfStmt, scope: Scope, ret: Ty): void {
    let src = s.iterable;
    if (src.kind === "CallExpr" && src.callee.kind === "MemberExpr" && src.callee.property === "entries" && src.args.length === 0
        && isMapTy(this.type(src.callee.object, scope))) src = src.callee.object;
    const t = this.type(src, scope);
    if (!isMapTy(t)) throw nyi(NYI.DESTRUCTURE, `for-of with a \`[a, b]\` binding over ${t} (only Map entries are supported)`);
    s.iterable = src;
    s.elemTy = mapKeyTy(t);
    s.valTy = mapValTy(t);
    const inner = scope.child();
    inner.declare(s.name, s.elemTy, false);
    inner.declare(s.name2!, s.valTy, false);
    this.loopDepth++; this.checkBlock(s.body, inner, ret); this.loopDepth--;
  }

  /* ============================================================
   * stdlib Batch 3 — Date + URLSearchParams instance methods.
   * ============================================================ */

  /** Date component getters. All take no arguments and return a `number`, except
   * `toISOString()` (a `string`). A Date is an immutable time value here, so the
   * `setX` MUTATORS are refused (NT1023) pointing at reconstruction. */
  private inferDateMethod(method: string, args: Expr[], scope: Scope): Ty {
    void scope;
    if (DATE_GETTERS.has(method) || method === "getTime" || method === "valueOf" || method === "toISOString"
        || method === "toJSON") {
      if (args.length !== 0) throw typeError(`Date.${method}() takes no arguments`);
      return method === "toISOString" || method === "toJSON" ? "string" : "number";
    }
    if (method.startsWith("set"))
      throw nyi(NYI.WEBAPI, `Date method '.${method}' (a Date is an immutable time value — build a new one, e.g. \`new Date(d.getTime() + ms)\`)`);
    throw nyi(NYI.WEBAPI, `Date method '.${method}'`);
  }

  /** URLSearchParams: the read-only lookups. `.get` is `string | null` (node's exact
   * shape, so `?? "…"` composes); `.getAll` is `string[]`. */
  private inferSearchParamsMethod(method: string, args: Expr[], scope: Scope): Ty {
    if (method === "toString") {
      if (args.length !== 0) throw typeError("URLSearchParams.toString() takes no arguments");
      return "string";
    }
    if (method !== "get" && method !== "has" && method !== "getAll")
      throw nyi(NYI.WEBAPI, `URLSearchParams method '.${method}' (supported: .get(k), .has(k), .getAll(k), .toString())`);
    if (args.length !== 1 || this.type(args[0]!, scope) !== "string") throw typeError(`URLSearchParams.${method}(name: string)`);
    if (method === "has") return "boolean";
    return method === "getAll" ? "string[]" : makeNullable("null", "string");
  }

  private inferMapMethod(recv: Ty, method: string, args: Expr[], scope: Scope, node: Expr): Ty {
    const k = mapKeyTy(recv), v = mapValTy(recv);
    // Iterators (insertion-ordered) — a real K[] / V[] array, valid only in an
    // iteration position (for-of / Array.from / [...spread]); see `iterOk`.
    if (method === "keys" || method === "values" || method === "entries") {
      if (args.length !== 0) throw typeError(`.${method} takes no arguments`);
      if (!this.iterOk.has(node)) throw nyi(NYI.COLLECTION, `a Map iterator outside for-of / Array.from / [...spread] (\`.${method}()\`)`);
      if (method === "entries") throw nyi(NYI.COLLECTION, "`.entries()` outside `for (const [k, v] of …)` (no tuple type yet)");
      return `${method === "keys" ? k : v}[]` as Ty;
    }
    if (method === "forEach") throw nyi(NYI.COLLECTION, "Map .forEach (use `for (const [k, v] of map)` — insertion-ordered, same visit order)");
    const argTys = args.map((a) => this.type(a, scope));
    const needKey = (i: number) => { if (argTys[i] !== k) throw typeError(`.${method} key expects ${k}, got ${argTys[i]}`); };
    switch (method) {
      case "set": if (args.length !== 2) throw typeError(".set expects (key, value)"); needKey(0);
        if (argTys[1] !== v) throw typeError(`.set value expects ${v}, got ${argTys[1]}`); return recv; // NEW map
      case "get": if (args.length !== 1) throw typeError(".get expects (key)"); needKey(0); return makeNullable("undefined", v); // V | undefined (miss → undefined)
      case "has": if (args.length !== 1) throw typeError(".has expects (key)"); needKey(0); return "boolean";
      case "delete": if (args.length !== 1) throw typeError(".delete expects (key)"); needKey(0); return recv; // NEW map
      default: throw nyi(NYI.COLLECTION, `Map method '.${method}'`);
    }
  }

  /** Immutable Set methods (B2): .add/.has/.delete. `.add`/`.delete` return a NEW set. */
  private inferSetMethod(recv: Ty, method: string, args: Expr[], scope: Scope, node: Expr): Ty {
    const el = setElemTy(recv);
    // node's Set iterators: `.values()`/`.keys()` are the same thing (the elements).
    if (method === "keys" || method === "values") {
      if (args.length !== 0) throw typeError(`.${method} takes no arguments`);
      if (!this.iterOk.has(node)) throw nyi(NYI.COLLECTION, `a Set iterator outside for-of / Array.from / [...spread] (\`.${method}()\`)`);
      return `${el}[]` as Ty;
    }
    if (method === "forEach") throw nyi(NYI.COLLECTION, "Set .forEach (use `for (const v of set)` — insertion-ordered, same visit order)");
    const argTys = args.map((a) => this.type(a, scope));
    const needEl = () => { if (args.length !== 1) throw typeError(`.${method} expects (value)`); if (argTys[0] !== el) throw typeError(`.${method} expects ${el}, got ${argTys[0]}`); };
    switch (method) {
      case "add": needEl(); return recv;      // NEW set
      case "has": needEl(); return "boolean";
      case "delete": needEl(); return recv;   // NEW set
      default: throw nyi(NYI.COLLECTION, `Set method '.${method}'`);
    }
  }

  private inferArrayMethod(recv: Ty, callee: MemberExpr, args: Expr[], scope: Scope): Ty {
    const method = callee.property;
    const el = elemTy(recv);
    if (method === "map" || method === "filter" || method === "reduce" || method === "flatMap") return this.inferHof(el, method, args, scope);
    // stdlib Batch 1 (part 2): the predicate HOFs, same inline-arrow contract as map/filter.
    if (SEARCH_HOFS.has(method)) return this.inferSearchHof(recv, el, method, args, scope);
    if (["forEach"].includes(method)) throw nyi(NYI.CLOSURE, `array .${method} (needs first-class function values)`);

    // --- ordering primitives (ES2023, non-mutating: node is the oracle) --------
    // `.toSorted()` with no comparator uses node's default (compare the elements'
    // STRING forms).
    //
    // `.sort` mutates its receiver, which the immutable model forbids — UNLESS the
    // receiver is a FRESH array (`[...xs]`, an array literal, a `.map`/`.filter`/…
    // result). Fresh storage has no other owner, so sorting it is unobservable to any
    // other binding: there is no shared array to protect. On such a receiver `.sort()`
    // is exactly `.toSorted()` (same VALUE; the temporary it would sort in place is
    // discarded either way), so it is REWRITTEN to `toSorted` here and lowers through
    // the already node-exact copying path — including node's LEXICOGRAPHIC default
    // order. That also keeps `.sort` from ever returning its receiver, so it cannot
    // mint the alias that in-place mutation would need. See docs/divergences.md.
    //
    // `.reverse` is the one in-place mutator ACCEPTED on ANY receiver (see the
    // `case "reverse"` below): it is node-compatible, and memory-safe because it DOES
    // return its receiver and the ownership pass therefore treats a binding of its
    // result as an ALIAS rather than a second owner. Do not read this block as
    // rejecting it — an earlier comment here claimed it did, and that was never true.
    // Note `freshArray` passes freshness THROUGH it, so `[3,1,2].reverse().sort()` is
    // still a fresh receiver, while `a.reverse().sort()` is `a` and stays refused.
    if (method === "sort") {
      if (!freshArray(callee.object))
        throw mutationError("arrays are immutable: `.sort` would sort the array in place", "use `.toSorted()` (ES2023) — it returns a NEW sorted array and leaves the original alone");
      callee.property = "toSorted";
      return this.inferArrayMethod(recv, callee, args, scope);
    }
    if (method === "toSorted") {
      if (args.length > 1) throw typeError(".toSorted expects 0..1 args");
      if (args.length === 0) {
        if (el !== "number" && el !== "string") throw nyi(NYI.ARRAY, `.toSorted() without a comparator on ${el}[] (node compares String(x) — pass a comparator)`);
        return recv;
      }
      const want = makeFuncTy([el, el], "number");
      const at = this.typeArg(args[0]!, want, scope);
      if (at !== want) throw typeError(`.toSorted comparator must be ${want}, got ${at}`);
      return recv;
    }
    if (method === "toReversed") { if (args.length !== 0) throw typeError(".toReversed expects 0 args"); return recv; }

    const argTys = args.map((a) => this.type(a, scope));
    const need = (n: number) => { if (args.length !== n) throw typeError(`.${method} expects ${n} args`); };
    switch (method) {
      // Immutable-by-default (Phase B): `.push`/`.pop` mutate in place, which the
      // model forbids. Reject with NT1606 pointing at the non-mutating replacement
      // (rather than silently diverging from node's mutate-and-return semantics).
      //
      // `.push` gets NO fresh-receiver permission, unlike `.sort` just above — see the
      // note on `freshArray` in ast.ts. The hint names the ACCUMULATOR form as well as
      // the one-shot spread: `[...arr, x]` answers "append once" but not "build this up
      // in a loop", which is the shape that actually reaches here. The reassignment form
      // is not a copy per element — codegen's consuming-append (`consumingSpread`)
      // lowers it to an in-place append whenever nothing else shares the storage, so it
      // is O(1) amortized. The hint SAYS so, because otherwise it reads as "rewrite your
      // loop to be quadratic": under node that spelling really is O(n²) (12.4s for 100k
      // appends, against 21ms for the same program built here), so the reader's
      // scepticism is well earned and has to be answered in the hint itself.
      case "push": throw mutationError("arrays are immutable: `.push` would mutate the array in place", "build a new array instead: `[...arr, x]` — the original is unchanged. To accumulate in a loop, reassign: `let acc: T[] = []; acc = [...acc, x]` — that is not a copy per element, it appends in place (O(1) amortized) when nothing else shares the storage");
      // The rest of node's in-place mutators (stdlib Batch 1): same treatment as
      // .push/.pop — refuse and name the immutable replacement.
      case "fill": throw mutationError("arrays are immutable: `.fill` would overwrite the array in place", "build a new array instead, e.g. `arr.map(() => v)` for a same-length fill, or `arr.with(i, v)` for one slot");
      // (`.sort` is rejected above, next to `.toSorted` — the ordering primitives are
      // handled together so the hint can point at the implemented copying form.)
      case "splice": throw mutationError("arrays are immutable: `.splice` would mutate the array in place", "use `.slice(0, i)` / `.slice(j)` plus spread — `[...a.slice(0, i), ...a.slice(j)]`");
      case "shift": throw mutationError("arrays are immutable: `.shift` would mutate the array in place", "use `arr.slice(1)` for the shorter array, or `arr[0]` for the first element");
      case "unshift": throw mutationError("arrays are immutable: `.unshift` would mutate the array in place", "build a new array instead: `[x, ...arr]`");
      case "copyWithin": throw mutationError("arrays are immutable: `.copyWithin` would overwrite the array in place", "build a new array from `.slice` + spread instead");
      case "pop": throw mutationError("arrays are immutable: `.pop` would mutate the array in place", "use `arr.slice(0, -1)` for the shorter array, or `arr[arr.length - 1]` for the last element");
      case "includes": need(1); if (argTys[0] !== el) throw typeError(`.includes expects ${el}`); return "boolean";
      case "indexOf": need(1); if (argTys[0] !== el) throw typeError(`.indexOf expects ${el}`); return "number";
      // ACCEPTED, unlike its in-place siblings above: `.reverse` returns its RECEIVER,
      // so the result type is `recv` and the two are the SAME array. `RETAINS_RECEIVER`
      // (src/ownership.ts) is what keeps that single-owner; adding another such method
      // means adding it there too, or its result binding double-frees.
      case "reverse": need(0); return recv;
      // --- stdlib Batch 1 (part 2): array fills ---
      case "flat": { // ONE level only (node's default depth); an explicit depth must be 1
        if (args.length > 1) throw typeError(".flat expects 0..1 args");
        if (args.length === 1 && !(args[0]!.kind === "NumberLiteral" && (args[0] as { value: number }).value === 1))
          throw nyi(NYI.ARRAY, ".flat(depth) with a depth other than 1 (chain .flat().flat() instead)");
        if (!isArrayTy(el)) throw typeError(".flat expects an array of arrays");
        return el;
      }
      case "lastIndexOf":
        need(1);
        if (argTys[0] !== el) throw typeError(`.lastIndexOf expects ${el}`);
        if (el !== "number" && el !== "string") throw nyi(NYI.ARRAY, `.lastIndexOf on ${recv}`);
        return "number";
      case "concat": // variadic; every argument must be an array of the same element type
        if (args.length < 1) throw typeError(".concat expects at least 1 array");
        for (const t of argTys) if (t !== recv) throw typeError(`.concat expects ${recv}, got ${t}`);
        return recv;
      case "at": // T | undefined (node: out-of-range is undefined, negative counts from the end)
        need(1);
        if (argTys[0] !== "number") throw typeError(".at index must be a number");
        if (el !== "number" && el !== "string" && el !== "boolean")
          throw nyi(NYI.ARRAY, `.at on ${recv} (only number/string/boolean elements — a heap element would alias its owner)`);
        return makeNullable("undefined", el);
      case "with": // ES2023 immutable update: with(index, value) -> NEW array (CoW)
        need(2);
        if (argTys[0] !== "number") throw typeError(".with index must be a number");
        if (argTys[1] !== el) throw typeError(`.with value expects ${el}`);
        return recv;
      case "slice":
        if (args.length < 1 || args.length > 2) throw typeError(".slice expects 1..2 args");
        if (argTys.some((t) => t !== "number")) throw typeError(".slice args must be numbers");
        return recv;
      case "join":
        if (args.length > 1) throw typeError(".join expects 0..1 args");
        if (args.length === 1 && argTys[0] !== "string") throw typeError(".join separator must be string");
        return "string";
      default:
        throw nyi(NYI.ARRAY, `array method '.${method}'`);
    }
  }

  /** some/every/find/findIndex/findLast/findLastIndex — one inline boolean-returning
   *  arrow over the elements. `.find`/`.findLast` return `T | undefined` like node. */
  private inferSearchHof(recv: Ty, el: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const arrow = args[0];
    if (!arrow || arrow.kind !== "ArrowFunction") throw nyi(NYI.CLOSURE, `array .${method} needs an inline arrow (function values are not inlined yet)`);
    if (args.length !== 1) throw typeError(`.${method} expects 1 argument`);
    if (arrow.params.length !== 1) throw typeError(`.${method} callback takes (elem)`);
    const bodyTy = this.typeArrowBody(arrow, [el], scope);
    if (bodyTy !== "boolean") throw typeError(`.${method} callback must return boolean`);
    if (method === "some" || method === "every") return "boolean";
    if (method === "findIndex" || method === "findLastIndex") return "number";
    if (el !== "number" && el !== "string" && el !== "boolean")
      throw nyi(NYI.ARRAY, `.${method} on ${recv} (only number/string/boolean elements — a heap element would alias its owner)`);
    return makeNullable("undefined", el); // .find / .findLast → T | undefined
  }

  /** map/filter/reduce with an INLINE arrow callback (contextually typed). */
  private inferHof(el: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const arrow = args[0];
    if (!arrow || arrow.kind !== "ArrowFunction") throw nyi(NYI.CLOSURE, `array .${method} needs an inline arrow (first-class functions not yet supported)`);

    if (method === "reduce") {
      if (args.length !== 2) throw typeError(".reduce expects (callback, initialValue)");
      if (arrow.params.length !== 2) throw typeError(".reduce callback takes (acc, elem)");
      const initTy = this.type(args[1]!, scope);
      const bodyTy = this.typeArrowBody(arrow, [initTy, el], scope);
      if (bodyTy !== initTy) throw typeError(`.reduce callback must return the accumulator type ${initTy}, got ${bodyTy}`);
      return initTy;
    }
    if (args.length !== 1) throw typeError(`.${method} expects 1 argument`);
    if (arrow.params.length !== 1) throw typeError(`.${method} callback takes (elem)`);
    const bodyTy = this.typeArrowBody(arrow, [el], scope);
    if (method === "flatMap") { // callback returns an array; the results are concatenated (one level)
      if (!isArrayTy(bodyTy)) throw typeError(".flatMap callback must return an array");
      return bodyTy;
    }
    if (method === "filter") {
      if (bodyTy !== "boolean") throw typeError(".filter callback must return boolean");
      return `${el}[]`;
    }
    if (bodyTy !== "number" && bodyTy !== "string" && bodyTy !== "boolean" && !isObjectTy(bodyTy) && !isArrayTy(bodyTy)) throw nyi(NYI.ARRAY, `.map producing ${bodyTy}`);
    return `${bodyTy}[]`;
  }

  /** Type an inlined HOF callback body (map/filter/reduce). Supports both an
   *  expression body and a BLOCK body — the block's statements run per-element in
   *  the generated loop and its `return` yields the element result. `arrow.retTy`
   *  is recorded for codegen. */
  private typeArrowBody(arrow: Extract<Expr, { kind: "ArrowFunction" }>, paramTypes: Ty[], scope: Scope): Ty {
    const inner = scope.child();
    arrow.params.forEach((p, i) => inner.declare(p.name, paramTypes[i]!, false));
    arrow.paramTys = paramTypes;
    // Inlined or not, a value-arrow nested inside this callback needs this body in its
    // enclosing chain (NT1031) — the callback's own statements are one of the places an
    // "is the binding used outside the closure?" question has to look.
    this.bodyChain.push(arrowBody(arrow));
    let retTy: Ty;
    try {
      if (arrow.exprBody) {
        retTy = this.type(arrow.body as Expr, inner);
      } else {
        retTy = this.inferBlockReturn(arrow.body as Stmt[], inner); // first top-level `return`
        this.checkBlock(arrow.body as Stmt[], inner.child(), retTy); // validate every return against it
      }
    } finally {
      this.bodyChain.pop();
    }
    arrow.retTy = retTy;
    return retTy;
  }

  /** Type an arrow used as a VALUE → a function type, with capture analysis. */
  private typeArrow(arrow: ArrowFunction, expected: Ty | undefined, scope: Scope): Ty {
    const expParams = expected && isFuncTy(expected) ? funcParams(expected) : undefined;
    const paramTys = arrow.params.map((p, i) => {
      // M3: an arrow's OWN type parameters (`<T>(x: T) => …`) leave `#T` markers. An arrow
      // is a value, so there is no instantiation site to specialize on: prefer the
      // contextual type where the arrow is used as an argument, and otherwise erase the
      // marker to `number` (the pre-M3 behavior, kept so generic arrows still compile).
      if (p.annot && hasTypeParam(p.annot)) p.annot = expParams?.[i] ?? eraseTypeParams(p.annot); // resolve the marker IN the AST
      const t = p.annot ?? expParams?.[i];
      if (!t) throw typeError(`cannot infer type of arrow parameter '${p.name}'`);
      return t;
    });
    arrow.paramTys = paramTys;
    const inner = scope.child();
    arrow.params.forEach((p, i) => inner.declare(p.name, paramTys[i]!, false));
    // An arrow used as a VALUE may escape and run long after the guard that narrowed an
    // enclosing binding, so a `let` narrowing stops at this boundary (a `const` one
    // cannot be invalidated, so it crosses). TypeScript draws the line in the same
    // place. The INLINED HOF callbacks (`typeArrowBody`) run inside the expression that
    // creates them, so they are not a boundary.
    // The arrow's own body joins `bodyChain` while its body is typed, so a NESTED arrow
    // sees it as one of ITS enclosing bodies (NT1031) — and comes back off before
    // `computeCaptures`, which asks about the bodies OUTSIDE this arrow.
    this.bodyChain.push(arrowBody(arrow));
    let retTy: Ty;
    try {
      retTy = this.inArrow(() => {
        if (arrow.exprBody) return this.type(arrow.body as Expr, inner);
        const t = this.inferBlockReturn(arrow.body as Stmt[], inner);
        this.checkBlock(arrow.body as Stmt[], inner.child(), t);
        return t;
      });
    } finally {
      this.bodyChain.pop();
    }
    arrow.retTy = retTy;
    arrow.captures = this.computeCaptures(arrow, scope);
    const ty = makeFuncTy(paramTys, retTy);
    arrow.ty = ty;
    return ty;
  }

  /** First top-level return's type in a body (for closure/function return inference). */
  private inferBlockReturn(body: Stmt[], scope: Scope): Ty {
    const inner = scope.child();
    for (const s of body) {
      if (s.kind === "ReturnStmt") return s.argument ? this.type(s.argument, inner) : "number";
      this.checkStmt(s, inner, "void"); // declare vars; don't validate returns
    }
    return "number";
  }

  /** Return type of an unannotated function, inferred from its first top-level return. */
  inferReturnType(fn: FuncDecl, base: Scope): Ty {
    for (const p of fn.params) base.declare(p.name, p.annot ?? "number", false);
    return this.inferBlockReturn(fn.body, base);
  }

  private computeCaptures(arrow: ArrowFunction, scope: Scope): { name: string; ty: Ty }[] {
    const params = new Set(arrow.params.map((p) => p.name));
    const locals = new Set<string>();
    const free = new Set<string>();
    if (arrow.exprBody) collectIdents(arrow.body as Expr, free);
    else for (const s of arrow.body as Stmt[]) { collectIdentsStmt(s, free); collectBlockLocals(s, locals); }
    const caps: { name: string; ty: Ty }[] = [];
    for (const n of free) {
      if (params.has(n) || locals.has(n) || BUILTIN_NUMBERS.includes(n)) continue;
      const b = scope.lookup(n); // bound in an enclosing scope ⇒ captured
      if (b) caps.push({ name: n, ty: b.ty });
    }
    this.checkCapturedWrites(arrow, scope);
    return caps;
  }

  /**
   * NT1031 — a closure that WRITES a binding it captured, in a shape where the write
   * would be lost.
   *
   * A capture is a by-VALUE snapshot: codegen fills the closure's env block when the
   * closure is BUILT, and `writeCapture` stores back into that block, never into the
   * enclosing frame's `%x.addr`. JS captures by REFERENCE, so the two disagree — but
   * only where the difference is OBSERVABLE, and that carve-out matters, because the
   * escaping-counter idiom lands squarely in it:
   *
   *     function makeCounter() { let count = 0; return () => { count++; return count; }; }
   *
   * Here `count` is never touched again in `makeCounter`, whose frame is gone by the
   * time the closure runs, so the env slot IS the variable and `1 2 3` is correct. That
   * program is `test/fixtures/stage11/counter.ts`, differential-tested against node, and
   * a blanket "no writes to captures" rule would have deleted it. The condition for
   * safety is exactly that nothing outside the closure can observe the stale copy:
   *
   *   1. no ENCLOSING body mentions the name anywhere outside this arrow — that covers a
   *      later read (`return n`), a later write (`n = 10`, which the snapshot predates),
   *      and a SECOND closure over the same binding (which would get its own env slot and
   *      diverge from this one); and
   *   2. the binding is a `number`. Measured, on the pre-refusal compiler and in the
   *      no-outside-reference shape above: a `number[]` capture written this way died
   *      with `panic: index out of bounds: the length is 0` where node printed `1 2 3`,
   *      and a `string` one printed correctly but LEAKS — `writeCapture` emits a bare
   *      `store i64` with no release of the string it overwrites, which is a red
   *      LeakSanitizer run on Linux CI. Only `number` needs neither.
   *
   * Everything else is refused. The enclosing bodies come from `bodyChain`; when it is
   * short (the early return-type inference pass runs before it is built) this can only
   * find FEWER references and so allow more, and every such arrow is typed again from
   * `checkBlock` with the full chain, which is the run that decides.
   */
  private checkCapturedWrites(arrow: ArrowFunction, scope: Scope): void {
    const writes = new Map<string, string>();
    collectEscapingWrites(arrow, writes);
    // No params/locals guard: `collectEscapingWrites` applies exactly that set itself, at
    // every arrow level rather than only this one — measured, by deleting a second copy
    // of the guard here and seeing no test change.
    for (const [name, op] of writes) {
      const b = scope.lookup(name);
      if (!b) continue; // not an enclosing binding at all — not this rule's business
      const observed = this.bodyChain.some((body) => referencesName(body, name, arrow));
      if (!observed && b.ty === "number") continue; // the escaping-counter shape: safe
      const why = observed
        ? `'${name}' is also used outside the closure, so it would be read at its stale value`
        : `'${name}' is a ${b.ty}, whose captured slot cannot be rewritten safely`;
      throw nyi(
        NYI.CAPTURE_WRITE,
        `a write to a captured binding (\`${op}\`, where '${name}' is bound in an enclosing scope)`,
        `closures capture by VALUE here, so \`${op}\` updates the closure's own copy rather than the outer binding, and ${why}. node captures by reference, so this is refused rather than miscompiled. ` +
        `Return the new value and assign it at the call site (\`${name} = step(${name})\`), or accumulate with \`map\`/\`filter\`/\`reduce\`, whose callbacks run inline in the enclosing frame and so may write it. ` +
        `A counter whose state lives ONLY in the closure — nothing outside it mentions '${name}' — does compile`,
      );
    }
  }

  /**
   * Does an argument / return value of type `actual` fit a declared `expected`?
   * Type IDENTITY, as it always was — widened by exactly one rule, for SH2: a member
   * of a discriminated union fits the union, because a union value simply IS its
   * member's object block. Deliberately not the general `assignable` relation, whose
   * structural-object and nullable arms would accept values codegen does not box here.
   */
  private fitsParam(expected: Ty, actual: Ty): boolean {
    return actual === expected || ((isUnionTy(expected) || isGeneralUnionTy(expected)) && this.assignable(expected, actual));
  }

  /**
   * Does this ARGUMENT fit the parameter — reshaping it if that is what makes it fit?
   *
   * `assignable` already decides object compatibility structurally, optional fields and
   * all, so `f({a:1})` against `f(o: {a?: number})` is a legal call. What stopped it was
   * that nothing retyped the literal: the caller emitted `{a:1}`'s own one-raw-double
   * layout while the callee reads that slot as a POINTER to a nullable box, so accepting
   * the call on the predicate alone compiles a program that dereferences `1.0` and dies
   * (exit 255, empty stdout — measured, and pinned in test/optional-props.test.ts).
   *
   * The declaration path solved this long ago: `const o: Opts = {a:1}` type-checks with
   * `assignable` and then calls `retypeLiteral` to rebuild the initializer in the DECLARED
   * layout. This is that same recipe, reused rather than reinvented — which is also why
   * acceptance is conditional on the reshape being POSSIBLE. `retypeLiteral` only rewrites
   * an object literal, so only an object literal may be accepted here. An argument that is
   * a variable, a call result or any other expression of a merely structurally-compatible
   * type has a layout already fixed by its own declaration and nothing to rewrite, so it
   * keeps being REFUSED. Widening that too is the memory bug, not the feature.
   */
  private fitsArg(expected: Ty, actual: Ty, arg: Expr): boolean {
    if (this.fitsParam(expected, actual)) return true;
    if (arg.kind !== "ObjectLiteral") return false;
    if (!isObjectTy(baseTy(expected)) || !this.assignable(expected, actual)) return false;
    this.retypeLiteral(arg, expected);
    return true;
  }

  private typeArg(a: Expr, expected: Ty, scope: Scope): Ty {
    // The parameter type is the CONTEXT for the argument: it types an arrow's params
    // (closures) and supplies the element type of an empty `[]` (e.g. `g([])`).
    return a.kind === "ArrowFunction" ? this.typeArrow(a, expected, scope) : this.type(a, scope, baseTy(expected));
  }

  /**
   * The extra, non-type constraints a host builtin carries (SH4) — the arguments whose
   * VALUE, not just type, decides what node returns. `readFileSync(p)` with no encoding
   * yields a Buffer, and `readFileSync(p, enc)` with a computed `enc` could be any of
   * them, so both are refused rather than compiled as if they said "utf8".
   */
  private checkHostCall(name: string, args: Expr[]): void {
    if (name === "readFileSync") {
      const enc = args[1];
      if (!enc || enc.kind !== "StringLiteral" || enc.value !== "utf8")
        throw nyi(NYI.HOSTMOD, `readFileSync without the literal encoding "utf8" (node returns a Buffer, which has no representation here — write \`readFileSync(path, "utf8")\`)`);
    }
    if (name === "rmSync" && args.length === 2) {
      // Only `recursive`/`force`, and only literal `true`: a `false` means the OTHER
      // behaviour, and every other node option (maxRetries, retryDelay) changes what
      // the call does, so neither is accepted and ignored.
      const opts = args[1]!;
      const props = opts.kind === "ObjectLiteral" ? opts.properties : null;
      const ok = props !== null && props.length > 0 && props.every((p) =>
        (p.key === "recursive" || p.key === "force") && p.value.kind === "BooleanLiteral" && p.value.value === true);
      if (!ok)
        throw nyi(NYI.HOSTMOD, `rmSync with options other than literal \`{ recursive: true }\` / \`{ force: true }\` (a \`false\` selects the other behaviour, and the retry options change what the call does)`);
    }
    if (name === "spawnSync") {
      // Exactly `{ encoding: "utf8" }`. Every other node option (cwd, env, input,
      // shell, timeout, maxBuffer) CHANGES what the call does, so accepting and
      // ignoring one would be a silent divergence — refuse instead.
      const opts = args[2];
      const props = opts?.kind === "ObjectLiteral" ? opts.properties : null;
      const bad = !props
        || props.length !== 1
        || props[0]!.key !== "encoding"
        || props[0]!.value.kind !== "StringLiteral"
        || props[0]!.value.value !== "utf8";
      if (bad)
        throw nyi(NYI.HOSTMOD, `spawnSync with options other than the literal \`{ encoding: "utf8" }\` (without it node yields Buffers, and every other option — cwd/env/input/shell/timeout — changes what the call does)`);
    }
  }

  private checkArgs(args: Expr[], sig: MethodSig, scope: Scope, label: string): void {
    if (args.length < sig.min || args.length > sig.max) throw typeError(`${label} expects ${sig.min}..${sig.max} args, got ${args.length}`);
    args.forEach((a, i) => {
      // The declared argument type is the CONTEXT for the argument, so a bare `[]`
      // takes its element type from it (Stage 33) — `spawnSync(cmd, [], …)` is the
      // forcing case. `null` in argTys means "any type", hence no hint.
      const want = sig.argTys[i];
      const at = want ? this.type(a, scope, want) : this.type(a, scope);
      if (want && at !== want) throw typeError(`${label} arg ${i} expects ${want}, got ${at}`);
    });
  }
}

/** Does this case body definitely LEAVE the enclosing function (as opposed to merely
 *  leaving the switch, which `break` does)? Conservative in the safe direction: an
 *  unrecognized shape means "not total", so the exhaustiveness check stands down. */
function leavesFunction(body: Stmt[]): boolean {
  const last = body[body.length - 1];
  return last !== undefined && (last.kind === "ReturnStmt" || last.kind === "ThrowStmt");
}

/**
 * Does this statement list always leave its enclosing block? Two SH2 narrowings read
 * it: elimination after a guard clause, and whether a switch case can fall through
 * into the next one. Conservative — a `return` in both arms of an `if` is not
 * recognized — and conservative is the safe direction for both: less elimination,
 * and a WIDER set of tags carried into the next case.
 */
function leavesBlock(body: Stmt[]): boolean {
  const last = body[body.length - 1];
  return last !== undefined &&
    (last.kind === "ReturnStmt" || last.kind === "ThrowStmt" || last.kind === "BreakStmt" || last.kind === "ContinueStmt");
}

/* ============================================================
 * Definite assignment — NT1600, ≈ rustc E0381 "used binding is possibly-uninitialized".
 *
 * WHAT IT GUARDS. A bare `let x: T;` whose `T` does not admit `undefined` starts with no
 * value at all. node prints `undefined` for a read before the first assignment; we have
 * nothing of type `T` to print and no slot to hold `undefined` in, so codegen would have
 * to serve the slot's zero — `(null)` for a string, `0` for a number. That is the
 * silent wrong answer the prime directive forbids, so such a read is REFUSED.
 *
 * `let x: T | undefined;` never reaches this pass: it admits `undefined`, so `checkStmt`
 * has already materialized that initializer and the binding is genuinely initialized.
 *
 * SHAPE. Forward, path-sensitive, merge = INTERSECTION (assigned only if assigned on
 * every incoming path). A path that DIVERGES — `return`/`throw`/`break`/`continue`, or a
 * `process.exit(…)` call, which codegen already treats as non-falling-through — cannot
 * reach the merge, so it contributes nothing to the intersection. That is what makes the
 * guard-clause idiom compile, and it is exactly the shape `src/cli.ts` needs:
 *
 *     let source: string;
 *     try { source = readFileSync(file, "utf8"); }
 *     catch { console.error(…); process.exit(1); }   // diverges — contributes nothing
 *     …source…                                        // definitely assigned
 *
 * CONSERVATIVE, AND CONSERVATIVE MEANS REFUSE. Unsure is a refusal, never an accept:
 *   - a loop body may run zero times, so what it assigns is not assigned after it
 *     (`do…while` is the exception — its body always runs once);
 *   - a `try` block's assignments are NOT in force in its `catch`: the throw may have
 *     happened before any of them, so the handler starts from the try's ENTRY state;
 *   - a `switch` only assigns if it has a `default` AND every case assigns or diverges;
 *   - an assignment nested inside a call argument or an arrow body is not counted as an
 *     assignment, while a READ anywhere inside one IS counted as a read.
 * ============================================================ */

/** The names PROVEN assigned on the path reaching a given program point. */
type DAFlow = Set<string>;

/** The bindings this pass must prove, mapped to the declared type the hint names. */
type DATracked = Map<string, Ty>;

/**
 * Every identifier READ inside `node`, with the location of its first occurrence.
 *
 * Shape-blind on purpose — the `hasHostCall` idiom above, for the reason given there:
 * "the AST is plain data, and a shape-blind walk cannot miss a node kind added later".
 * A hand-written switch over expression kinds (like `collectIdents`, whose `default`
 * silently returns) would go stale, and a read missed HERE is a miscompile, not a lost
 * optimization.
 *
 * The two write-only forms carry their target as a bare STRING rather than an
 * `Identifier` node, so the node walk sees them as non-reads. That is right for `x = v`
 * and wrong for `x += v` and `x++`, which read `x` before writing it — hence the
 * explicit cases.
 */
function daReads(node: unknown, out: Map<string, Loc | undefined>): void {
  if (Array.isArray(node)) { for (const x of node) daReads(x, out); return; }
  if (node === null || typeof node !== "object") return;
  const n = node as { kind?: string; name?: unknown; op?: unknown; target?: unknown; loc?: Loc };
  if (n.kind === "Identifier" && typeof n.name === "string") {
    if (!out.has(n.name)) out.set(n.name, n.loc);
    return;
  }
  if (typeof n.target === "string" &&
      (n.kind === "UpdateExpr" || (n.kind === "AssignExpr" && n.op !== "="))) {
    if (!out.has(n.target)) out.set(n.target, n.loc);
  }
  for (const v of Object.values(node)) daReads(v, out);
}

/** Refuse every read in `e` of a tracked binding not yet proven assigned. */
function daUse(e: unknown, tracked: DATracked, flow: DAFlow): void {
  if (e === null || e === undefined) return;
  const reads = new Map<string, Loc | undefined>();
  daReads(e, reads);
  for (const [name, loc] of reads) {
    const ty = tracked.get(name);
    if (ty === undefined || flow.has(name)) continue;
    throw useBeforeAssign(
      `'${name}' is used before being assigned`,
      loc,
      `\`let ${name}: ${ty};\` starts with no value. Assign it on every path that reaches this read — ` +
      `or declare it \`let ${name}: ${ty} | undefined;\`, which starts as \`undefined\` and can be tested for it`);
  }
}

/** `process.exit(…)` — the one call that never returns (codegen agrees: see genCall). */
function daIsExit(e: Expr): boolean {
  return e.kind === "CallExpr" && e.callee.kind === "MemberExpr" &&
    e.callee.property === "exit" &&
    e.callee.object.kind === "Identifier" && e.callee.object.name === "process";
}

/** Intersect `flow` down to the names assigned on every non-diverging incoming path. */
function daMerge(paths: { flow: DAFlow; diverged: boolean }[], fallback: DAFlow): DAFlow {
  const live = paths.filter((p) => !p.diverged);
  if (live.length === 0) return new Set(fallback); // every path left; nothing merges here
  const out = new Set(live[0]!.flow);
  for (const p of live.slice(1)) for (const n of [...out]) if (!p.flow.has(n)) out.delete(n);
  return out;
}

/** Analyze a statement list. Returns true if it always DIVERGES (never falls through). */
function daBlock(body: Stmt[], tracked: DATracked, flow: DAFlow): boolean {
  for (const s of body) if (daStmt(s, tracked, flow)) return true;
  return false;
}

/** Analyze one statement in place, mutating `flow`. Returns true if it DIVERGES. */
function daStmt(s: Stmt, tracked: DATracked, flow: DAFlow): boolean {
  switch (s.kind) {
    case "VarDecl":
      for (const d of s.decls) {
        // This analysis is NAME-based, and so is codegen (one slot per name per
        // function). A redeclaration of a name already being tracked is therefore
        // indistinguishable from an assignment to the outer binding, and treating it as
        // one would let a later read of the OUTER binding pass on the INNER one's proof.
        // We cannot tell them apart, so we refuse rather than guess.
        if (tracked.has(d.name)) {
          throw useBeforeAssign(
            `'${d.name}' is redeclared while an outer '${d.name}' is still unassigned`,
            undefined,
            `a nested \`let ${d.name}\` shadows the outer one, and the two are not distinguishable here — rename one of them`);
        }
        // An initializer assigns right here. Its ABSENCE is the binding this whole pass
        // exists for: by now `checkStmt` has filled one in for every type that admits
        // `undefined`, so what is left has no legal starting value.
        if (d.init) { daUse(d.init, tracked, flow); flow.add(d.name); }
        else { tracked.set(d.name, d.ty ?? d.annot ?? "unknown"); flow.delete(d.name); }
      }
      return false;

    case "ExprStmt": {
      const e = s.expr;
      // The one form that ASSIGNS: `x = v` at statement level. The value is evaluated
      // first, so its reads are checked against the state BEFORE the write lands.
      if (e.kind === "AssignExpr" && e.op === "=" && tracked.has(e.target)) {
        daUse(e.value, tracked, flow);
        flow.add(e.target);
        return false;
      }
      daUse(e, tracked, flow);
      return daIsExit(e);
    }

    case "ReturnStmt": daUse(s.argument, tracked, flow); return true;
    case "ThrowStmt": daUse(s.argument, tracked, flow); return true;
    case "BreakStmt": case "ContinueStmt": return true;

    case "IfStmt": {
      daUse(s.test, tracked, flow);
      const con = new Set(flow);
      const conDiv = daBlock(s.consequent, tracked, con);
      const alt = new Set(flow);
      const altDiv = s.alternate ? daBlock(s.alternate, tracked, alt) : false;
      const merged = daMerge([{ flow: con, diverged: conDiv }, { flow: alt, diverged: altDiv }], flow);
      flow.clear(); for (const n of merged) flow.add(n);
      return conDiv && altDiv;
    }

    case "WhileStmt": {
      daUse(s.test, tracked, flow);
      daBlock(s.body, tracked, new Set(flow)); // may run zero times — assignments discarded
      return false;
    }

    case "DoWhileStmt": {
      const body = new Set(flow);
      const div = daBlock(s.body, tracked, body); // always runs once — assignments KEPT
      flow.clear(); for (const n of body) flow.add(n);
      daUse(s.test, tracked, flow);
      return div;
    }

    case "ForStmt": {
      if (s.init) { // the init runs exactly once, so its assignments are kept
        if ((s.init as Stmt).kind === "VarDecl") daStmt(s.init as Stmt, tracked, flow);
        else daUse(s.init as Expr, tracked, flow);
      }
      daUse(s.test, tracked, flow);
      const body = new Set(flow);
      daBlock(s.body, tracked, body); // may run zero times — assignments discarded
      daUse(s.update, tracked, body);
      return false;
    }

    case "ForOfStmt": {
      daUse(s.iterable, tracked, flow);
      daBlock(s.body, tracked, new Set(flow)); // may run zero times
      return false;
    }

    case "ForInStmt": {
      daUse(s.object, tracked, flow);
      daBlock(s.body, tracked, new Set(flow)); // may run zero times
      return false;
    }

    case "SwitchStmt": {
      daUse(s.discriminant, tracked, flow);
      // Without a `default` there is a path that runs NO case at all, so nothing the
      // cases assign can be relied on afterwards. A case body that falls through into
      // the next one is handled by analyzing each from the switch's entry state, which
      // under-approximates what is assigned — the safe direction.
      const paths = s.cases.map((c) => {
        const f = new Set(flow);
        if (c.test) daUse(c.test, tracked, f);
        return { flow: f, diverged: daBlock(c.body, tracked, f) };
      });
      const hasDefault = s.cases.some((c) => c.test === null);
      const merged = hasDefault ? daMerge(paths, flow) : new Set(flow);
      flow.clear(); for (const n of merged) flow.add(n);
      return hasDefault && paths.every((p) => p.diverged);
    }

    case "TryStmt": {
      const tryFlow = new Set(flow);
      const tryDiv = daBlock(s.block, tracked, tryFlow);
      let after: DAFlow;
      let diverged: boolean;
      if (s.handler) {
        // The handler starts from the try's ENTRY state: the throw may have happened
        // before any assignment in the block landed, so none of them can be assumed.
        const catchFlow = new Set(flow);
        const catchDiv = daBlock(s.handler, tracked, catchFlow);
        after = daMerge([{ flow: tryFlow, diverged: tryDiv }, { flow: catchFlow, diverged: catchDiv }], flow);
        diverged = tryDiv && catchDiv;
      } else {
        // try/finally with no catch: reaching past it means the block COMPLETED.
        after = tryFlow;
        diverged = tryDiv;
      }
      flow.clear(); for (const n of after) flow.add(n);
      if (s.finalizer) { // the finalizer always runs, so its assignments are kept
        if (daBlock(s.finalizer, tracked, flow)) diverged = true;
      }
      return diverged;
    }

    case "BlockStmt": return daBlock(s.body, tracked, flow);
    case "MultiStmt": return daBlock(s.stmts, tracked, flow);
    case "FuncDecl": return false; // its body is analyzed on its own, below
  }
}

/**
 * Run definite assignment over `body` as one control-flow region, then over every
 * nested function body — each independently, with its own tracked set, because each is
 * its own control-flow region and its own set of slots.
 *
 * Both callable forms must be reached. A `FuncDecl` covers plain functions and class
 * methods (the parser desugars `class C { m() {} }` into a `FuncDecl` named `C.m`); an
 * `ArrowFunction` with a statement body is the other, and missing it would leave
 * `const f = () => { let a: string; return a; };` unanalyzed — a miscompile, since
 * codegen would hand back the slot's zero.
 *
 * A nested body starts with an EMPTY tracked set: an outer binding is not tracked
 * inside it. That is not a hole — a read of an outer unassigned binding from inside a
 * nested body is already refused at the point the function VALUE appears, because
 * `daUse` is shape-blind and descends into it.
 */
function checkDefiniteAssignment(body: Stmt[]): void {
  daBlock(body, new Map<string, Ty>(), new Set<string>());
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as { kind?: string; body?: unknown };
    if ((n.kind === "FuncDecl" || n.kind === "ArrowFunction") && Array.isArray(n.body)) {
      daBlock(n.body as Stmt[], new Map<string, Ty>(), new Set<string>());
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
}

/** A union rendered the way it was written (`A | B`), for diagnostics. */
function showUnion(t: Ty): string { return unionWidenedMembers(t).join(" | "); }

/**
 * SH4: does this statement (anywhere inside it, at any depth) CALL a host builtin?
 * A host call is fallible — a missing file, a failed spawn — and node reports the
 * failure as an `Error`, so a try block containing one binds its catch parameter to
 * `{message:string}`. Structural, like codegen's `mentions`: the AST is plain data,
 * and a shape-blind walk cannot miss a node kind added later.
 */
function hasHostCall(node: unknown, hosts: Set<string>): boolean {
  if (Array.isArray(node)) return node.some((x) => hasHostCall(x, hosts));
  if (!node || typeof node !== "object") return false;
  const n = node as { kind?: string; callee?: { kind?: string; name?: string } };
  if (n.kind === "CallExpr" && n.callee?.kind === "Identifier" && n.callee.name && hosts.has(n.callee.name)) return true;
  return Object.values(node).some((v) => hasHostCall(v, hosts));
}

/** A bare `[]` — the one expression whose type must come from context, not from itself. */
function isEmptyArrayLit(e: Expr): boolean {
  return e.kind === "ArrayLiteral" && e.elements.length === 0;
}

/** Collect every identifier name referenced in an expression (for capture analysis). */
function collectIdents(e: Expr, out: Set<string>): void {
  switch (e.kind) {
    case "Identifier": out.add(e.name); return;
    case "TemplateLiteral": e.exprs.forEach((x) => collectIdents(x, out)); return;
    case "MemberExpr": collectIdents(e.object, out); return;
    case "IndexExpr": collectIdents(e.object, out); collectIdents(e.index, out); return;
    case "UnaryExpr": collectIdents(e.operand, out); return;
    case "TypeofExpr": collectIdents(e.operand, out); return;
    case "UpdateExpr": if (e.targetExpr) collectIdents(e.targetExpr, out); else out.add(e.target); return;
    case "BinaryExpr": collectIdents(e.left, out); collectIdents(e.right, out); return;
    case "LogicalExpr": collectIdents(e.left, out); collectIdents(e.right, out); return;
    case "ConditionalExpr": collectIdents(e.test, out); collectIdents(e.consequent, out); collectIdents(e.alternate, out); return;
    case "AssignExpr": out.add(e.target); collectIdents(e.value, out); return;
    case "IndexAssign": collectIdents(e.object, out); collectIdents(e.index, out); collectIdents(e.value, out); return;
    case "FieldAssign": collectIdents(e.object, out); collectIdents(e.value, out); return;
    case "CallExpr": collectIdents(e.callee, out); e.args.forEach((a) => collectIdents(a, out)); return;
    case "ArrayLiteral": e.elements.forEach((x) => collectIdents(x, out)); return;
    case "ObjectLiteral": e.properties.forEach((p) => collectIdents(p.value, out)); return;
    case "SpreadExpr": collectIdents(e.argument, out); return;
    case "SequenceExpr": e.exprs.forEach((x) => collectIdents(x, out)); return;
    case "AsExpr": case "SatisfiesExpr": collectIdents(e.expr, out); return;
    case "NonNullExpr": collectIdents(e.expr, out); return;
    case "InstanceOfExpr": collectIdents(e.object, out); return; // the class name is not a value
    case "ArrowFunction": if (e.exprBody) collectIdents(e.body as Expr, out); return;
    default: return; // literals
  }
}

function collectIdentsStmt(s: Stmt, out: Set<string>): void {
  switch (s.kind) {
    case "VarDecl": for (const d of s.decls) if (d.init) collectIdents(d.init, out); return;
    case "ReturnStmt": if (s.argument) collectIdents(s.argument, out); return;
    case "ExprStmt": collectIdents(s.expr, out); return;
    case "IfStmt": collectIdents(s.test, out); s.consequent.forEach((x) => collectIdentsStmt(x, out)); s.alternate?.forEach((x) => collectIdentsStmt(x, out)); return;
    case "WhileStmt": case "DoWhileStmt": collectIdents(s.test, out); s.body.forEach((x) => collectIdentsStmt(x, out)); return;
    case "ForStmt": if (s.init && (s.init as any).kind === "VarDecl") collectIdentsStmt(s.init as Stmt, out); else if (s.init) collectIdents(s.init as Expr, out); if (s.test) collectIdents(s.test, out); if (s.update) collectIdents(s.update, out); s.body.forEach((x) => collectIdentsStmt(x, out)); return;
    case "ForOfStmt": collectIdents(s.iterable, out); s.body.forEach((x) => collectIdentsStmt(x, out)); return;
    case "ForInStmt": collectIdents(s.object, out); s.body.forEach((x) => collectIdentsStmt(x, out)); return;
    case "SwitchStmt": collectIdents(s.discriminant, out); for (const c of s.cases) { if (c.test) collectIdents(c.test, out); c.body.forEach((x) => collectIdentsStmt(x, out)); } return;
    case "BlockStmt": s.body.forEach((x) => collectIdentsStmt(x, out)); return;
    default: return;
  }
}
/* ------------------------------------------------------------
 * Narrowing support: which NAMES a region assigns to.
 *
 * An assignment invalidates a narrowing, so a fact is only established over a region
 * that provably contains none. Two sinks: `direct` for assignments in ordinary code and
 * `closure` for ones inside an arrow body — the caller passes the same set for a region
 * scan (either kind kills the fact) and separate ones for the whole-program scan, where
 * only the closure assignments matter (they can run at any time later).
 * ------------------------------------------------------------ */
function collectAssigned(e: Expr, direct: Set<string>, closure: Set<string>, inArrow: boolean): void {
  const go = (x: Expr) => collectAssigned(x, direct, closure, inArrow);
  switch (e.kind) {
    case "AssignExpr": (inArrow ? closure : direct).add(e.target); go(e.value); return;
    case "UpdateExpr":
      if (e.targetExpr) go(e.targetExpr); else (inArrow ? closure : direct).add(e.target);
      return;
    case "ArrowFunction":
      if (e.exprBody) collectAssigned(e.body as Expr, direct, closure, true);
      else collectAssignedStmts(e.body as Stmt[], direct, closure, true);
      return;
    case "MemberExpr": go(e.object); return;
    case "IndexExpr": go(e.object); go(e.index); return;
    case "UnaryExpr": go(e.operand); return;
    case "TypeofExpr": go(e.operand); return;
    case "AsExpr": case "SatisfiesExpr": case "NonNullExpr": go(e.expr); return;
    case "InstanceOfExpr": go(e.object); return;
    case "BinaryExpr": case "LogicalExpr": go(e.left); go(e.right); return;
    case "ConditionalExpr": go(e.test); go(e.consequent); go(e.alternate); return;
    case "SequenceExpr": case "TemplateLiteral": (e.exprs as Expr[]).forEach(go); return;
    case "CallExpr": go(e.callee); e.args.forEach(go); return;
    case "NewExpr": e.args.forEach(go); return;
    case "IndexAssign": go(e.object); go(e.index); go(e.value); return;
    case "FieldAssign": go(e.object); go(e.value); return;
    case "ArrayLiteral": e.elements.forEach(go); return;
    case "ObjectLiteral": e.properties.forEach((p) => go(p.value)); return;
    case "SpreadExpr": go(e.argument); return;
    default: return;
  }
}

function collectAssignedStmts(body: Stmt[], direct: Set<string>, closure: Set<string>, inArrow: boolean): void {
  const goE = (x: Expr) => collectAssigned(x, direct, closure, inArrow);
  const goS = (b: Stmt[]) => collectAssignedStmts(b, direct, closure, inArrow);
  for (const s of body) {
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) if (d.init) goE(d.init); break;
      case "ReturnStmt": if (s.argument) goE(s.argument); break;
      case "ThrowStmt": goE(s.argument); break;
      case "ExprStmt": goE(s.expr); break;
      case "IfStmt": goE(s.test); goS(s.consequent); if (s.alternate) goS(s.alternate); break;
      case "WhileStmt": case "DoWhileStmt": goE(s.test); goS(s.body); break;
      case "ForStmt":
        if (s.init) { if ((s.init as Stmt).kind === "VarDecl") goS([s.init as Stmt]); else goE(s.init as Expr); }
        if (s.test) goE(s.test);
        if (s.update) goE(s.update);
        goS(s.body);
        break;
      case "ForOfStmt": goE(s.iterable); goS(s.body); break;
      case "ForInStmt": goE(s.object); goS(s.body); break;
      case "SwitchStmt": goE(s.discriminant); for (const c of s.cases) { if (c.test) goE(c.test); goS(c.body); } break;
      case "TryStmt": goS(s.block); if (s.handler) goS(s.handler); if (s.finalizer) goS(s.finalizer); break;
      case "BlockStmt": goS(s.body); break;
      case "MultiStmt": goS(s.stmts); break;
      // A function/class body is its own flow; its assignments run when it is CALLED,
      // which — like an arrow's — may be any time after the narrowing was established.
      case "FuncDecl": collectAssignedStmts(s.body, direct, closure, true); break;
      default: break;
    }
  }
}

/** An expression as a one-statement region, so `factsFor` takes one shape of region. */
function exprRegion(e: Expr): Stmt[] { return [{ kind: "ExprStmt", expr: e }]; }

/** True if control cannot fall out of the bottom of `body`. */
function alwaysExits(body: Stmt[]): boolean {
  return body.some((s) =>
    s.kind === "ReturnStmt" || s.kind === "ThrowStmt" || s.kind === "BreakStmt" || s.kind === "ContinueStmt");
}

function collectBlockLocals(s: Stmt, out: Set<string>): void {
  if (s.kind === "VarDecl") for (const d of s.decls) out.add(d.name);
  else if (s.kind === "ForOfStmt" || s.kind === "ForInStmt") out.add(s.name);
}

/* ------------------------------------------------------------
 * ESCAPING WRITES (NT1031) — which names an arrow assigns that it does not itself bind.
 *
 * `collectAssigned` above answers a different question (does this REGION assign the
 * name, at all, anywhere) and deliberately ignores shadowing, because a narrowing has
 * to be invalidated conservatively. Here the conservative direction is the opposite
 * one: a name that is bound INSIDE the arrow is not a capture, and refusing a write to
 * it would reject correct code — `(n: number) => { n = n + 1; return n; }` writes its
 * own parameter, and a closure-local `let n` shadowing an outer `n` is a different
 * variable. So this walker carries the bound set down, and a nested arrow contributes
 * only what escapes IT.
 *
 * The shadowing model is deliberately the SAME one `computeCaptures` uses (params plus
 * the body's top-level `let`/`const`/`for-of` names) so that the set refused here is
 * exactly the set codegen would treat as a capture — no wider, no narrower.
 *
 * The value in the map is the offending write as written, for the diagnostic.
 * ------------------------------------------------------------ */
function collectEscapingWrites(arrow: ArrowFunction, out: Map<string, string>): void {
  const bound = new Set(arrow.params.map((p) => p.name));
  if (arrow.exprBody) { escapingWritesExpr(arrow.body as Expr, bound, out); return; }
  const body = arrow.body as Stmt[];
  for (const s of body) collectBlockLocals(s, bound);
  escapingWritesStmts(body, bound, out);
}

/** Record the FIRST write to a name the arrow does not bind (later ones say the same). */
function noteEscapingWrite(name: string, op: string, bound: Set<string>, out: Map<string, string>): void {
  if (!bound.has(name) && !out.has(name)) out.set(name, op);
}

function escapingWritesExpr(e: Expr, bound: Set<string>, out: Map<string, string>): void {
  const go = (x: Expr) => escapingWritesExpr(x, bound, out);
  switch (e.kind) {
    case "AssignExpr": noteEscapingWrite(e.target, `${e.target} ${e.op} …`, bound, out); go(e.value); return;
    case "UpdateExpr":
      if (e.targetExpr) go(e.targetExpr);
      else noteEscapingWrite(e.target, e.prefix ? `${e.op}${e.target}` : `${e.target}${e.op}`, bound, out);
      return;
    case "ArrowFunction": {
      // A nested arrow binds its own params/locals; whatever still escapes IT escapes
      // this arrow too, unless this one binds the name. This is also what catches a
      // write from an INLINED `map`/`filter`/`reduce` callback: inlining puts the write
      // in the enclosing frame, which is the right place only when that frame OWNS the
      // binding — inside a lifted closure the frame holds a capture, so it is not.
      const inner = new Map<string, string>();
      collectEscapingWrites(e, inner);
      for (const [n, op] of inner) noteEscapingWrite(n, op, bound, out);
      return;
    }
    // `o.f = v` / `xs[i] = v` through a capture mutate the pointed-to heap value, which
    // IS shared with the enclosing scope — a different question, already answered by the
    // immutability rule (NT1606) and the ownership checker. Only recurse.
    case "IndexAssign": go(e.object); go(e.index); go(e.value); return;
    case "FieldAssign": go(e.object); go(e.value); return;
    case "MemberExpr": go(e.object); return;
    case "IndexExpr": go(e.object); go(e.index); return;
    case "UnaryExpr": go(e.operand); return;
    case "TypeofExpr": go(e.operand); return;
    case "AsExpr": case "SatisfiesExpr": case "NonNullExpr": go(e.expr); return;
    case "InstanceOfExpr": go(e.object); return;
    case "BinaryExpr": case "LogicalExpr": go(e.left); go(e.right); return;
    case "ConditionalExpr": go(e.test); go(e.consequent); go(e.alternate); return;
    case "SequenceExpr": case "TemplateLiteral": (e.exprs as Expr[]).forEach(go); return;
    case "CallExpr": go(e.callee); e.args.forEach(go); return;
    case "NewExpr": e.args.forEach(go); return;
    case "ArrayLiteral": e.elements.forEach(go); return;
    case "ObjectLiteral": e.properties.forEach((p) => go(p.value)); return;
    case "SpreadExpr": go(e.argument); return;
    default: return; // literals and identifiers hold no assignment
  }
}

/** An arrow's body as statements — an expression body as the one statement it is. */
function arrowBody(arrow: ArrowFunction): Stmt[] {
  return arrow.exprBody ? exprRegion(arrow.body as Expr) : (arrow.body as Stmt[]);
}

/**
 * Is `name` mentioned anywhere in `stmts`, other than inside `skip`?
 *
 * The second half of the NT1031 rule: a closure may rewrite its captured slot only when
 * nothing outside it can observe the enclosing frame's now-stale copy. That question is
 * about USES, so this walks the enclosing body looking for any occurrence of the name at
 * all — a read, a write, a call, a mention inside a SECOND closure (which would hold its
 * own snapshot and diverge from this one). The binding's own declarator is not an
 * occurrence: only initializers are visited, so `let count = 0` does not count itself.
 *
 * Deliberately FLAT — it models no shadowing, so an unrelated binding of the same name
 * counts as a use. Every imprecision therefore produces MORE refusals, never fewer,
 * which is the only safe direction for a rule standing between a program and a silently
 * wrong answer.
 */
function referencesName(stmts: Stmt[], name: string, skip: ArrowFunction): boolean {
  return stmts.some((s) => refsInStmt(s, name, skip));
}

function refsInExpr(e: Expr, name: string, skip: ArrowFunction): boolean {
  if (e === skip) return false; // the closure under judgement is not "outside" itself
  const any = (xs: Expr[]) => xs.some((x) => refsInExpr(x, name, skip));
  switch (e.kind) {
    case "Identifier": return e.name === name;
    case "AssignExpr": return e.target === name || refsInExpr(e.value, name, skip);
    case "UpdateExpr": return e.targetExpr ? refsInExpr(e.targetExpr, name, skip) : e.target === name;
    case "MemberExpr": return refsInExpr(e.object, name, skip);
    case "IndexExpr": return any([e.object, e.index]);
    case "IndexAssign": return any([e.object, e.index, e.value]);
    case "FieldAssign": return any([e.object, e.value]);
    case "UnaryExpr": return refsInExpr(e.operand, name, skip);
    case "TypeofExpr": return refsInExpr(e.operand, name, skip);
    case "AsExpr": case "SatisfiesExpr": case "NonNullExpr": return refsInExpr(e.expr, name, skip);
    case "InstanceOfExpr": return refsInExpr(e.object, name, skip);
    case "BinaryExpr": case "LogicalExpr": return any([e.left, e.right]);
    case "ConditionalExpr": return any([e.test, e.consequent, e.alternate]);
    case "SequenceExpr": case "TemplateLiteral": return any(e.exprs as Expr[]);
    case "CallExpr": return refsInExpr(e.callee, name, skip) || any(e.args);
    case "NewExpr": return any(e.args);
    case "ArrayLiteral": return any(e.elements);
    case "ObjectLiteral": return any(e.properties.map((p) => p.value));
    case "SpreadExpr": return refsInExpr(e.argument, name, skip);
    case "ArrowFunction": return referencesName(arrowBody(e), name, skip);
    default: return false; // literals
  }
}

function refsInStmt(s: Stmt, name: string, skip: ArrowFunction): boolean {
  const goE = (x: Expr) => refsInExpr(x, name, skip);
  const goS = (b: Stmt[]) => referencesName(b, name, skip);
  switch (s.kind) {
    // Same optional-`init` hazard as `escapingWritesStmts` below: an uninitialized
    // `let a: string;` anywhere in the ENCLOSING body is walked by this pass, and a
    // declarator with no initializer contributes no occurrence of the name.
    case "VarDecl": return s.decls.some((d) => (d.init ? goE(d.init) : false));
    case "ReturnStmt": return s.argument ? goE(s.argument) : false;
    case "ThrowStmt": return goE(s.argument);
    case "ExprStmt": return goE(s.expr);
    case "IfStmt": return goE(s.test) || goS(s.consequent) || (s.alternate ? goS(s.alternate) : false);
    case "WhileStmt": case "DoWhileStmt": return goE(s.test) || goS(s.body);
    case "ForStmt":
      return (s.init ? ((s.init as Stmt).kind === "VarDecl" ? goS([s.init as Stmt]) : goE(s.init as Expr)) : false)
        || (s.test ? goE(s.test) : false) || (s.update ? goE(s.update) : false) || goS(s.body);
    case "ForOfStmt": return goE(s.iterable) || goS(s.body);
    case "ForInStmt": return goE(s.object) || goS(s.body);
    case "SwitchStmt":
      return goE(s.discriminant) || s.cases.some((c) => (c.test ? goE(c.test) : false) || goS(c.body));
    case "TryStmt": return goS(s.block) || (s.handler ? goS(s.handler) : false) || (s.finalizer ? goS(s.finalizer) : false);
    case "BlockStmt": return goS(s.body);
    case "MultiStmt": return goS(s.stmts);
    // A named function CAN read a module-level binding, so its body counts as a use.
    case "FuncDecl": return goS(s.body);
    default: return false;
  }
}

function escapingWritesStmts(body: Stmt[], bound: Set<string>, out: Map<string, string>): void {
  const goE = (x: Expr) => escapingWritesExpr(x, bound, out);
  const goS = (b: Stmt[]) => escapingWritesStmts(b, bound, out);
  for (const s of body) {
    switch (s.kind) {
      // `d.init` is OPTIONAL: `let a: string;` (definite assignment) declares without
      // initializing, and an uninitialized declarator holds no expression to walk. This
      // walker used to assume every declarator had one and crashed on `e.kind` of
      // `undefined` — a compiler crash, not a diagnostic, on correct TypeScript.
      case "VarDecl": for (const d of s.decls) if (d.init) goE(d.init); break;
      case "ReturnStmt": if (s.argument) goE(s.argument); break;
      case "ThrowStmt": goE(s.argument); break;
      case "ExprStmt": goE(s.expr); break;
      case "IfStmt": goE(s.test); goS(s.consequent); if (s.alternate) goS(s.alternate); break;
      case "WhileStmt": case "DoWhileStmt": goE(s.test); goS(s.body); break;
      case "ForStmt":
        if (s.init) { if ((s.init as Stmt).kind === "VarDecl") goS([s.init as Stmt]); else goE(s.init as Expr); }
        if (s.test) goE(s.test);
        if (s.update) goE(s.update);
        goS(s.body);
        break;
      case "ForOfStmt": goE(s.iterable); goS(s.body); break;
      case "ForInStmt": goE(s.object); goS(s.body); break;
      case "SwitchStmt": goE(s.discriminant); for (const c of s.cases) { if (c.test) goE(c.test); goS(c.body); } break;
      case "TryStmt": goS(s.block); if (s.handler) goS(s.handler); if (s.finalizer) goS(s.finalizer); break;
      case "BlockStmt": goS(s.body); break;
      case "MultiStmt": goS(s.stmts); break;
      // A nested `function` declaration is not a closure here (it does not capture), so
      // its assignments are its own frame's; nothing escapes to this arrow's captures.
      default: break;
    }
  }
}

/** True if `e` is a member access that is part of an optional chain (some `?.` to its left). */
export function isOptChainExpr(e: Expr): boolean {
  return e.kind === "MemberExpr" && (!!e.optional || isOptChainExpr(e.object));
}

/**
 * `console.<m>(…)` — the method name, or null if this is not a console call.
 * Recognized like `Math.*` (not shadowable by a user binding), as `console.log`
 * always has been.
 */
export function consoleMethod(e: Expr): string | null {
  if (e.kind !== "CallExpr") return null;
  const c = e.callee;
  if (c.kind !== "MemberExpr" || c.object.kind !== "Identifier" || c.object.name !== "console") return null;
  return c.property;
}

/** The stream each supported `console` method writes to — node's mapping. */
export const CONSOLE_STREAMS: ReadonlyMap<string, "out" | "err"> = new Map([
  ["log", "out"], ["info", "out"], ["debug", "out"],
  ["error", "err"], ["warn", "err"],
] as const);

/* ============================================================
 * Format specifiers (Stage 49) — a faithful port of node's
 * `formatWithOptionsInternal` (lib/internal/util/inspect.js).
 *
 * The rules that matter, all of them observable:
 *   - specifiers are only read from a LEADING STRING argument, and only while
 *     an unconsumed argument remains (`a + 1 !== args.length`), so
 *     `console.log("100%% done")` — one argument — is not formatted at all;
 *   - the scan stops at `length - 1`, so a trailing `%` is never a specifier;
 *   - an unknown specifier (`%z`) is left LITERAL, `%%` collapses to `%`;
 *   - if anything was consumed, the format string itself is consumed too and
 *     the remaining arguments are appended space-separated (as always).
 *
 * The plan is computed from the SOURCE, so both the checker (which validates
 * each argument for the role it plays) and codegen (which renders it) derive
 * the same thing from the same function.
 * ============================================================ */

export type FmtSpec = "s" | "d" | "i" | "f" | "j" | "o" | "O" | "c";
export type FmtPiece = { text: string; spec?: undefined } | { text?: undefined; spec: FmtSpec; arg: number };
export interface FmtPlan {
  /** The formatted prefix, in order: literal chunks and argument substitutions. */
  pieces: FmtPiece[];
  /** Index of the first argument appended space-separated after the prefix. */
  restStart: number;
}

const FMT_SPECS: ReadonlyMap<string, FmtSpec> = new Map([
  ["s", "s"], ["d", "d"], ["i", "i"], ["f", "f"], ["j", "j"], ["o", "o"], ["O", "O"], ["c", "c"],
] as const);

/**
 * The compile-time format plan for a `console.*` call, or null when there is
 * none — a single argument (node returns it verbatim), a non-literal format
 * string, or a literal that consumes nothing. A null plan means "print every
 * argument space-separated", which is what the pre-Stage-49 path already did.
 */
export function planConsoleFormat(args: Expr[]): FmtPlan | null {
  if (args.length < 2) return null;
  const first = args[0]!;
  const fmt = first.kind === "StringLiteral" ? first.value
    : first.kind === "TemplateLiteral" && first.exprs.length === 0 ? first.quasis[0] ?? "" : null;
  if (fmt === null) return null;
  return planFormatString(fmt, args.length);
}

/** node's `formatWithOptionsInternal` scan, transcribed. `argc` counts the format string. */
export function planFormatString(first: string, argc: number): FmtPlan | null {
  const pieces: FmtPiece[] = [];
  const push = (text: string) => { if (text !== "") pieces.push({ text }); };
  let a = 0;
  let lastPos = 0;
  for (let i = 0; i < first.length - 1; i++) {
    if (first.charCodeAt(i) !== 37 /* % */) continue;
    const next = first[++i]!;
    if (a + 1 !== argc) {
      if (next === "%") { push(first.slice(lastPos, i)); lastPos = i + 1; continue; }
      const spec = FMT_SPECS.get(next);
      if (spec === undefined) continue; // not a placeholder — left literal
      const arg = ++a;
      if (lastPos !== i - 1) push(first.slice(lastPos, i - 1));
      pieces.push({ spec, arg });
      lastPos = i + 1;
    } else if (next === "%") {
      push(first.slice(lastPos, i));
      lastPos = i + 1;
    }
  }
  if (lastPos === 0) return null; // nothing consumed: the plain space-separated path
  if (lastPos < first.length) push(first.slice(lastPos));
  return { pieces, restStart: a + 1 };
}

/** Which specifier consumes each argument index (indices below `restStart`). */
export function fmtSpecByArg(plan: FmtPlan): Map<number, FmtSpec> {
  const m = new Map<number, FmtSpec>();
  for (const p of plan.pieces) if (p.spec !== undefined) m.set(p.arg, p.spec);
  return m;
}

/**
 * The full printability net for one `console.*` argument printed on its own
 * (Stage 47) — `checkInspectable` plus the handle types that keep their own
 * long-standing code at the root. `depth` is where node's renderer starts:
 * 0 for a plain argument, and higher for a `%s`, which inspects at `depth: 0`
 * so a nested compound is cut to `[Object]` immediately.
 */
export function checkConsoleArg(at: Ty, depth = 0): void {
  // Stage 47: compound values (objects, class instances, arrays, Map/Set, Dyn)
  // render through node's util.inspect, generated from the static type in
  // codegen. What is left below is what has NO node-identical rendering here —
  // each refused, never printed as a raw pointer.
  checkInspectable(at, at, depth);
  // (Stage 49 closed the old NT1016 here: node's typed-array layout IS the array
  // layout with the length folded into the opening brace, which the Stage-47
  // builder already owns — `Uint8Array(3) [ 1, 2, 3 ]`, grouped past six.)
  // A Response/Headers handle has no printable form here (node prints an inspected
  // `Response { … }`); reject rather than print the raw pointer.
  if (isResponseTy(at) || isHeadersTy(at)) throw nyi(NYI.OBJECT, `console.log of a ${at} (print .status / .ok / await res.text() instead)`);
  // stdlib Batch 3: node's util.inspect of a Date IS its ISO string (and the
  // literal "Invalid Date" for a NaN time value), so `console.log(d)` is exact.
  // A URL/URLSearchParams inspects as `URL { href: …, … }` — refused, not guessed.
  if (isUrlTy(at) || isSearchParamsTy(at))
    throw nyi(NYI.WEBAPI, `console.log of a ${at} (node prints an inspected \`${at} { … }\`; print a component, e.g. \`u.href\`-less \`u.origin + u.pathname\`, or \`${at === "URL" ? "u.searchParams" : "p"}.toString()\`)`);
  // The net: no argument type may reach codegen without a renderer. Printing a
  // heap handle used to emit the raw pointer — i.e. nothing at all.
  checkUnionRenderable(at, "console.log");
  if (!isPrintableTy(at)) throw nyi(NYI.INSPECT, `console.log of a ${at}`);
}

/**
 * SH2: rendering — `console.log`, `JSON.stringify` — is generated from the STATIC type,
 * walking a known field layout. An un-narrowed union has no single one, and the fallback
 * in each renderer is silent (a bare newline / the literal `null`), so it is refused with
 * the fix named. The union's own tag is what supplies the missing shape, at runtime and
 * with one branch per member; that is a follow-on, not a guess to make now.
 */
/**
 * Refuse an operation that would read a GENERAL union's box as if it were the value.
 *
 * Everything the box supports — printing, `typeof`, `Array.isArray` — dispatches on
 * its tag. Everything else reaches code generated from the STATIC type, which for a
 * `G<…>` describes the two-slot block, not the arm inside it. Each case below was
 * measured against node before being refused, and each was silently wrong rather
 * than loud: truthiness tested the box POINTER (always true, so `0` came out truthy),
 * `===` compared TAGS (so `1 === 2` was true), `JSON.stringify` rendered the literal
 * `null`, and concatenation emitted invalid IR.
 *
 * Every one of them is a tag dispatch away from working — the printer already is one
 * — but "reject, never miscompile" says the refusal lands first.
 */
function refuseUnboxedUnion(ty: Ty, what: string): void {
  if (!isGeneralUnionTy(ty)) return;
  throw nyi(
    NYI.OPTIONAL_CHAIN,
    `${what} of the un-narrowed union ${generalUnionMembers(ty).join(" | ")} — it is a tagged box, so which arm it holds ` +
      `is only known at RUNTIME. Narrow it first (\`if (typeof x === "${typeofTagOf(generalUnionMembers(ty)[0]!)}") { … }\`) and use the arm`,
  );
}

/**
 * Refuse the two `JSON.stringify` shapes an `undefined` arm cannot express here.
 *
 * node DROPS an undefined rather than rendering it, and drops it differently by
 * position: at the root `JSON.stringify(x)` returns the VALUE `undefined` (not a
 * string — our `JSON.stringify` is typed `string`, so there is nothing correct to
 * return), and in an object the KEY IS OMITTED (`{}`, not `{"k":null}`), which needs
 * the key and its separator decided at runtime. Both used to render the literal
 * `null`, silently. An ARRAY element is the one position where node does render
 * `null`, so it is unaffected — as is a `T | null` everywhere.
 */
function refuseUndefinedStringify(ty: Ty): void {
  if (!isNullableTy(ty) || nullishKind(ty) !== "undefined") return;
  throw nyi(
    NYI.JSON,
    `JSON.stringify of a \`${baseTy(ty)} | undefined\` at the ROOT — node returns the undefined VALUE there, not a string, ` +
      `so the literal \`null\` this used to render was wrong and no string is right either. ` +
      `Give it a value first (\`x ?? null\`), or use \`${baseTy(ty)} | null\`, which serializes as \`null\` exactly like node. ` +
      `(As an object FIELD it is fine — the key is omitted, as node does.)`,
  );
}

/**
 * Where a value sits in the JSON being built. node treats the positions
 * differently for anything it DROPS — at the ROOT `JSON.stringify` returns the
 * undefined VALUE, in an object the KEY IS OMITTED, and in an array it writes
 * `null` — so the three are decided separately rather than one standing in for
 * the others. (Today no droppable type can actually reach `"element"`: an array
 * OF a function/Map/Set/Uint8Array is `NT1001`. The case is kept anyway, so that
 * lifting NT1001 produces a refusal here rather than a fresh wrong answer.)
 */
type JsonPos = "root" | "field" | "element";

/**
 * Can `JSON.stringify` render `ty` EXACTLY as node does, in position `pos`?
 * Throws the refusal naming the type and the fix if not.
 *
 * This is the checker half of removing `genJsonStringify`'s default-to-`null`.
 * That function used to end in `return this.mod.intern("null")`, so every type
 * nobody had written a rule for silently serialized as the literal `null` —
 * `Map`, `Set`, `Uint8Array`, a function, a `JSON.parse` result and the
 * `undefined` VALUE were all already wrong against node, and the nested ones were
 * invisible because they sat inside an otherwise-correct object
 * (`{"m":null,"ok":1}`). Same shape as the `truthyOf` fall-through in
 * `docs/divergences.md`, and the same fix: be exhaustive on both sides.
 *
 * The walk MIRRORS `genJsonStringify`'s, case for case, so the two are one
 * decision written twice — a type admitted here has a rule there, and a type with
 * no rule there is refused here. Codegen's tail is an `internalError`, i.e. a
 * broken invariant between the pair, never a user-facing path.
 *
 * `%j` IS `JSON.stringify`, so `checkFormatArg` routes through this too and the
 * two accept the same set by construction rather than by being kept in step.
 */
export function checkJsonStringifyArg(ty: Ty, pos: JsonPos): void {
  if (ty === "number" || ty === "boolean" || ty === "string" || ty === "null") return;
  if (isDateTy(ty)) return; // Date.prototype.toJSON — the quoted ISO string
  // A Map/Set has no own ENUMERABLE property, so node serializes EVERY one of them
  // as `{}` whatever it holds. A constant, not an approximation, so it is rendered.
  if (isMapTy(ty) || isSetTy(ty)) return;
  // A typed array's own enumerable properties are its INDICES: `{"0":1,"1":255}`.
  if (isBytesTy(ty)) return;
  // A function serializes as `undefined`, so it follows the positional rule below.
  if (isFuncTy(ty)) {
    if (pos === "field") return; // node omits the key; genJsonObject drops the field
    throw nyi(
      NYI.JSON,
      `JSON.stringify of a function at the ${pos === "root" ? "ROOT" : "position of an ARRAY element"} — node ` +
        (pos === "root"
          ? `returns the undefined VALUE there, not a string, so the literal \`null\` this used to render was wrong and no string is right either. `
          : `writes \`null\` there, which nativets does not generate for a function element. `) +
        `Serialize the data instead of the callback. (As an object FIELD it is fine — the key is omitted, as node does.)`,
    );
  }
  // The bare nullish VALUES. `undefined` at the root is the same shape as
  // `T | undefined` at the root, and gets the same answer: there is no right string.
  if (ty === "undefined" || ty === "void") {
    if (pos === "element") return; // node writes `null`, which genJsonNullable emits
    throw nyi(
      NYI.JSON,
      `JSON.stringify of \`${ty}\` — node returns the undefined VALUE, not a string, so the literal \`null\` ` +
        `this used to render was wrong and no string is right either. Pass \`null\`, which serializes as \`null\` exactly like node.`,
    );
  }
  if (isNullableTy(ty)) {
    if (pos === "root") refuseUndefinedStringify(ty); // a `?U` box: no right string here
    return checkJsonStringifyArg(baseTy(ty), pos);    // a `?N` box renders `null`; check what it carries
  }
  if (isArrayTy(ty)) return checkJsonStringifyArg(elemTy(ty), "element");
  if (isObjectTy(ty)) { for (const f of objectFields(ty)) checkJsonStringifyArg(f.ty, "field"); return; }
  throw nyi(NYI.JSON, `JSON.stringify of a ${ty} — nativets generates the serializer from the STATIC type and has ` +
    `no node-exact rendering for this one, and the literal \`null\` it used to emit was a silent wrong answer. ` +
    jsonStringifyFix(ty));
}

/** The nearest thing that DOES serialize, per refused type — a refusal is only
 *  useful with the fix attached (`src/diagnostics.ts`, the `NT****` contract). */
function jsonStringifyFix(ty: Ty): string {
  if (ty === "Dyn")
    return "A `JSON.parse` result is already JSON — keep the original string rather than re-stringifying it, " +
      "or narrow it (`d as T`) and stringify the `T`.";
  if (isUrlTy(ty)) return "node serializes a URL through `URL.prototype.toJSON`, i.e. `u.href` — stringify that string.";
  if (isSearchParamsTy(ty)) return "node writes `{}` for it (no own enumerable property); write `p.toString()` if you want the query.";
  if (isBytesRefTy(ty)) return "a TextEncoder/TextDecoder carries no data; stringify the `Uint8Array` or the string instead.";
  if (isResponseTy(ty) || isHeadersTy(ty)) return "stringify the parts you want (e.g. `r.status`, or the parsed body).";
  return "Build the JSON from values that do have one.";
}

export function checkUnionRenderable(ty: Ty, what: string): void {
  const u = findUnionIn(ty);
  if (u === undefined) return;
  const d = unionDiscriminant(u)!;
  const where = u === ty ? "" : ` inside \`${ty}\``;
  throw nyi(
    NYI.INSPECT,
    `${what} of the un-narrowed union ${unionWidenedMembers(u).join(" | ")}${where} — its shape is only known from its tag at RUNTIME. ` +
      `Narrow it first (\`if (x.${d.key} === "…")\` / \`switch (x.${d.key})\`) and render the member`,
  );
}

/** The first union reachable in `ty`, at the root or nested in a rendered container.
 *  Both renderers recurse into elements/fields, so a union ANYWHERE inside is the same
 *  silent fallback as one at the root. */
function findUnionIn(ty: Ty): Ty | undefined {
  if (isUnionTy(ty)) return ty;
  if (isNullableTy(ty)) return findUnionIn(baseTy(ty));
  if (isArrayTy(ty)) return findUnionIn(elemTy(ty));
  if (isSetTy(ty)) return findUnionIn(setElemTy(ty));
  if (isMapTy(ty)) return findUnionIn(mapKeyTy(ty)) ?? findUnionIn(mapValTy(ty));
  if (isObjectTy(ty)) for (const f of objectFields(ty)) { const u = findUnionIn(f.ty); if (u) return u; }
  return undefined;
}

/**
 * What a format specifier needs of the argument it consumes (Stage 49). Each
 * rule is node's, and each refusal is a conversion whose node result depends on
 * machinery we do not have — never an approximation:
 *
 *   `%c` discards its argument, so any type goes;
 *   `%s`/`%O` inspect (at depth 0 / the default depth), so the Stage-47 net applies;
 *   `%o` adds `showHidden` (`[ 1, 2, 3, [length]: 3 ]`), which we only match for
 *        a scalar, where it is identical to `%O`;
 *   `%j` is `JSON.stringify`, which has no meaning for a Map/Set/Dyn handle here;
 *   `%d`/`%i`/`%f` are ToNumber / parseInt / parseFloat, which for an ARRAY go
 *        through `ToPrimitive` (`String([1,2,3])` is `"1,2,3"`, so `%f` of it is 1) —
 *        a coercion nativets does not implement for arrays.
 */
export function checkFormatArg(spec: FmtSpec, at: Ty): void {
  if (spec === "c") return; // consumed and ignored
  if (spec === "s") {
    // node's `%s` inspects an object only when it has no custom `toString`; a typed
    // array has one, so `%s` of a Uint8Array is `String(u8)` — the comma-joined
    // elements ("1,2,3"), NOT the `Uint8Array(3) [ … ]` form the others get.
    if (isBytesTy(at)) throw nyi(NYI.CONSOLE, "`%s` of a Uint8Array (node prints `String(u8)`, the comma-joined bytes) — use `%O`, or print it on its own");
    return checkConsoleArg(at, INSPECT_DEPTH_LIMIT - 1);
  }
  if (spec === "O") return checkConsoleArg(at);
  const scalar = at === "number" || at === "boolean" || at === "string" || at === "undefined" ||
    at === "void" || at === "null" || isDateTy(at);
  if (isNullableTy(at)) return checkFormatArg(spec, baseTy(at));
  if (spec === "o") {
    if (!scalar) throw nyi(NYI.CONSOLE, `\`%o\` of a ${at} (node's \`showHidden\` inspect, e.g. \`[ 1, 2, 3, [length]: 3 ]\`) — use \`%O\``);
    return;
  }
  if (spec === "j") {
    // `%j` IS `JSON.stringify`, so it accepts exactly what the direct call accepts —
    // ONE predicate, not two lists kept in step. They used to disagree: `%j` refused
    // a Map/Set outright while the direct call rendered the literal `null` for one.
    // Now both render `{}`, as node does. (The nullable strip above is why the one
    // asymmetry survives: `%j` of a `T | undefined` prints `undefined` at runtime,
    // which node does too, where the `string`-typed direct call cannot.)
    return checkJsonStringifyArg(at, "root");
  }
  // %d / %i / %f
  if (!scalar && !isObjectTy(at) && !isMapTy(at) && !isSetTy(at))
    throw nyi(NYI.CONSOLE, `\`%${spec}\` of a ${at} (node coerces it through ToPrimitive) — use \`%s\``);
}

/**
 * Can `console.log` render this type EXACTLY as node does? (Stage 47.)
 *
 * The walk mirrors what codegen will actually print, so it stops where node's own
 * renderer stops: below `depth 2` a compound prints as `[Object]`/`[Array]`, so what
 * it contains is never reached and never needs to be renderable. Anything reachable
 * that has no node-identical form is refused with `NT1025` — the one thing we must
 * never do is print nothing (or a raw pointer), which is what this replaced.
 */
export function checkInspectable(ty: Ty, root: Ty, depth = 0): void {
  // A HANDLE type at the ROOT keeps its own long-standing diagnostic
  // (NT1002 Response/Headers, NT1024 URL), applied by the caller right after this walk;
  // here we catch the same types NESTED inside a printed value, plus function values
  // anywhere (node names a function from its binding — a name our lifted arrows lack).
  if (ty !== root) {
    const what = () => nyi(NYI.INSPECT, `console.log of a ${isFuncTy(ty) ? "function value" : ty} inside \`${root}\``);
    // A Uint8Array is renderable ANYWHERE since Stage 49; its two companion handles
    // (TextEncoder/TextDecoder) are not, and neither is a fetch/URL handle.
    if (isFuncTy(ty) || isTextEncoderTy(ty) || isTextDecoderTy(ty) || isFetchRefTy(ty) || isUrlRefTy(ty)) throw what();
  } else if (isFuncTy(ty)) {
    throw nyi(NYI.INSPECT, "console.log of a function value");
  }
  if (isNullableTy(ty)) return checkInspectable(baseTy(ty), root, depth);
  // A GENERAL union carries its own tag, so codegen can dispatch and print the arm it
  // actually holds — byte-for-byte what node prints. (A `U<…>` object union has no
  // outer tag and stays refused; that is the case just below.)
  if (isGeneralUnionTy(ty)) { for (const m of generalUnionMembers(ty)) checkInspectable(m, root, depth); return; }
  if (depth >= INSPECT_DEPTH_LIMIT) return; // rendered as `[Object]`/`[Array]`; contents unread
  if (isArrayTy(ty)) return checkInspectable(elemTy(ty), root, depth + 1);
  if (isSetTy(ty)) return checkInspectable(setElemTy(ty), root, depth + 1);
  if (isMapTy(ty)) {
    checkInspectable(mapKeyTy(ty), root, depth + 1);
    return checkInspectable(mapValTy(ty), root, depth + 1);
  }
  if (isObjectTy(ty)) for (const f of objectFields(ty)) checkInspectable(f.ty, root, depth + 1);
}
/** node's `util.inspect` default `depth` — a compound below it renders as a placeholder. */
const INSPECT_DEPTH_LIMIT = 3;

/**
 * The safety net behind `console.log`: does codegen have a renderer for this type at
 * all? Anything not on this list used to fall through to `js_print_str` on the raw
 * value — which for a heap handle printed a POINTER (usually nothing at all). A type
 * that reaches here unlisted is refused, never printed.
 */
export function isPrintableTy(t: Ty): boolean {
  return (
    t === "number" || t === "boolean" || t === "string" || t === "undefined" || t === "void" ||
    t === "null" || t === "Dyn" || isDateTy(t) || isNullableTy(t) || isGeneralUnionTy(t) ||
    isObjectTy(t) || isArrayTy(t) || isMapTy(t) || isSetTy(t) || isBytesTy(t)
  );
}
