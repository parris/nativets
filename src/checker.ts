/*
 * Static checker + type inference.
 *
 * Supported types: number | boolean | string | void | undefined | null.
 * Unsupported-but-valid TS is rejected here with an NT1xxx diagnostic (never
 * miscompiled), which `coverage` surfaces. Codegen only ever sees checked,
 * supported programs.
 */

import type { Program, Stmt, Expr, Ty, FuncDecl, VarDecl, ForOfStmt } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectType, objectFields, fieldType, isFuncTy, funcParams, funcRet, makeFuncTy, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, makeMapTy, makeSetTy, mapKeyTy, mapValTy, setElemTy, classTag, isBytesTy, isTextEncoderTy, isTextDecoderTy, isResponseTy, isHeadersTy } from "./ast.ts";
import { hasTypeParam, substTypeParams, eraseTypeParams, unifyTypeParams, mapTypesDeep } from "./ast.ts";
import type { ArrowFunction } from "./ast.ts";
import { NTError, NYI, nyi, typeError, mutationError, emptyArrayError, boundsError } from "./diagnostics.ts";

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
interface Binding { ty: Ty; constant: boolean; len?: number }

class Scope {
  private vars = new Map<string, Binding>();
  /** Names of THIS scope's own bindings that some lookup resolved to. Used on the
   *  module scope to learn which top-level bindings a function body reads, so only
   *  those are promoted to LLVM globals (everything else stays a `main` local, and
   *  every single-file program's IR is unchanged). */
  readonly hits = new Set<string>();
  constructor(private parent: Scope | null = null) {}
  child(): Scope { return new Scope(this); }
  declare(name: string, ty: Ty, constant: boolean, len?: number): void { this.vars.set(name, { ty, constant, len }); }
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
const GLOBAL_FUNCS: Record<string, MethodSig> = {
  parseInt: { min: 1, max: 2, argTys: ["string", "number"], ret: "number" },
  parseFloat: { min: 1, max: 1, argTys: ["string"], ret: "number" },
  isNaN: { min: 1, max: 1, argTys: ["number"], ret: "boolean" },
  Number: { min: 1, max: 1, argTys: [null], ret: "number" },
  String: { min: 1, max: 1, argTys: [null], ret: "string" },
  // --- stdlib (web standards) Batch 1: base64 globals (differential vs node) ---
  btoa: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  atob: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  // --- stdlib: URL parsing (WHATWG URL functional subset; node is the oracle) ---
  urlProtocol: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlHost: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlHostname: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlPathname: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlSearch: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlHash: { min: 1, max: 1, argTys: ["string"], ret: "string" },
  urlSearchParam: { min: 2, max: 2, argTys: ["string", "string"], ret: "string" },
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
  const c = new Checker(functions);
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
    // Type each ANNOTATED default against its param type (the `??` above skips it when
    // annotated) so its `.ty` is set for codegen and an empty-array default `[]` gets
    // its element type from the annotation (`function f(a: T[] = [])`).
    s.params.forEach((p, i) => { if (p.default && p.annot) c.type(p.default, builtins(), params[i]); });
    const fixed = rest ? s.params.length - 1 : s.params.length;
    const required = s.params.slice(0, fixed).filter((p) => !p.default).length;
    const defaults = s.params.map((p) => p.default ?? null);
    const ret = s.returnAnnot ?? "number";
    s.returnTy = ret;
    functions.set(s.name, { params, ret, required, defaults, rest });
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
        moduleScope.declare(d.name, d.annot ?? c.type(d.init, moduleScope), s.declKind === "const");
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
  const spec = structuredClone({ ...tmpl, name, typeParams: undefined }) as FuncDecl;
  delete spec.typeParams;
  mapTypesDeep(spec, (t) => substTypeParams(t, bindings));
  return spec;
}

class Checker {
  private loopDepth = 0;
  private switchDepth = 0;
  /**
   * Call nodes allowed to be a Map/Set ITERATOR (`m.keys()/.values()/.entries()`).
   * node returns a lazy Iterator object there; we return a real array, so the two
   * agree exactly in `for-of` / `[...it]` / `Array.from(it)` and nowhere else
   * (`it.length` is 2 for us, `undefined` in node). Rather than diverge silently,
   * the iterator is only typed in those three positions — anywhere else it is an
   * NT1014 rejection. This set records the positions as they are checked.
   */
  private iterOk = new Set<Expr>();
  constructor(private functions: Map<string, Sig>) {}

  /* ============================================================
   * M3 — monomorphization of generic functions.
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
    const stem = `${base}$${args.map((t) => t.replace(/[^A-Za-z0-9_]/g, "_")).join("$")}`;
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
  private instantiate(name: string, e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope): Sig {
    const tmpl = this.generics.get(name)!;
    const tps = tmpl.typeParams!;
    const bindings = new Map<string, Ty>();

    if (e.typeArgs?.length) {
      // Explicit call-site type args pin the instantiation positionally.
      if (e.typeArgs.length > tps.length) throw typeError(`'${name}' takes ${tps.length} type argument(s), got ${e.typeArgs.length}`);
      e.typeArgs.forEach((t, i) => bindings.set(tps[i]!, t));
    }
    const patterns = tmpl.params.map((p) => p.annot ?? "number");
    // Round 1 — plain arguments. An ARROW argument is deferred: it needs the (possibly
    // still-unbound) parameter pattern as its contextual type before it can be typed.
    e.args.forEach((a, i) => {
      const pat = patterns[Math.min(i, patterns.length - 1)];
      if (!pat || !hasTypeParam(pat) || a.kind === "ArrowFunction") return;
      unifyTypeParams(tmpl.params[i]?.rest ? elemTy(pat) : pat, this.type(a, scope), bindings);
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
      throw nyi(NYI.GENERIC, `cannot infer type argument${missing.length > 1 ? "s" : ""} ${missing.map((m) => `'${m}'`).join(", ")} for generic function '${name}'; pass them explicitly (\`${name}<${tps.join(", ")}>(…)\`)`);
    }
    const typeArgs = tps.map((t) => bindings.get(t)!);
    for (const t of typeArgs) {
      if (hasTypeParam(t)) throw nyi(NYI.GENERIC, `generic function '${name}' instantiated with an unresolved type parameter (nested generics are not supported)`);
    }

    const key = `${name}|${typeArgs.join("|")}`;
    const memo = this.instances.get(key);
    if (memo) { (e.callee as { name: string }).name = memo; return this.functions.get(memo)!; }

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
    (e.callee as { name: string }).name = mangled;
    return sig;
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
    for (const p of fn.params) base.declare(p.name, p.annot ?? (p.default ? "number" : "number"), false);
    this.checkBlock(fn.body, base, fn.returnTy ?? "number");
  }

  checkBlock(body: Stmt[], scope: Scope, ret: Ty = "void"): void {
    for (const s of body) this.checkStmt(s, scope, ret);
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

  /** Resolve `.prop` on a NON-nullable base (object field, or string/array `.length`). */
  private fieldOnBase(base: Ty, prop: string): Ty {
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
          const t = this.type(d.init, scope, d.annot); // annotation is the context (e.g. `const a: T[] = []`)
          if (d.annot && d.annot !== t && !this.assignable(d.annot, t)) {
            throw typeError(`'${d.name}' declared ${d.annot} but initialized with ${t}`);
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
          if (ret !== "void" && t !== ret) throw typeError(`return type ${t} does not match declared ${ret}`);
        }
        return;
      case "IfStmt":
        this.type(s.test, scope);
        this.checkBlock(s.consequent, scope.child(), ret);
        if (s.alternate) this.checkBlock(s.alternate, scope.child(), ret);
        return;
      case "WhileStmt":
        this.type(s.test, scope);
        this.loopDepth++; this.checkBlock(s.body, scope.child(), ret); this.loopDepth--;
        return;
      case "DoWhileStmt":
        this.loopDepth++; this.checkBlock(s.body, scope.child(), ret); this.loopDepth--;
        this.type(s.test, scope);
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
        const inner = scope.child();
        inner.declare(s.name, "string", false); // keys are strings
        this.loopDepth++; this.checkBlock(s.body, inner, ret); this.loopDepth--;
        return;
      }
      case "SwitchStmt": {
        const dt = this.type(s.discriminant, scope);
        this.switchDepth++;
        for (const cse of s.cases) {
          if (cse.test) {
            const ct = this.type(cse.test, scope);
            if (ct !== dt) throw typeError(`switch case type ${ct} does not match discriminant ${dt}`);
          }
          this.checkBlock(cse.body, scope.child(), ret);
        }
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
        for (const x of e.exprs) this.type(x, scope);
        return "string";
      case "ArrayLiteral": {
        if (e.elements.length === 0) {
          // Empty `[]` has no element to infer from — take the element type from
          // CONTEXT: a binding/field annotation, a declared return type, a parameter
          // type, an assignment target, or the other arm of a `?:`/`??`. With no
          // context we still reject (don't guess) — see `emptyArrayError`.
          if (hint && isArrayTy(hint)) {
            const el = elemTy(hint);
            if (el !== "number" && el !== "string" && el !== "boolean" && !isObjectTy(el) && !isArrayTy(el)) throw nyi(NYI.ARRAY, `arrays of ${el}`);
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
          return this.type(el, scope);
        });
        const first = tys[0]!;
        if (!tys.every((t) => t === first)) throw typeError(`array elements must share a type (got ${[...new Set(tys)].join(", ")})`);
        if (first !== "number" && first !== "string" && first !== "boolean" && !isObjectTy(first) && !isArrayTy(first)) throw nyi(NYI.ARRAY, `arrays of ${first}`);
        return `${first}[]`;
      }
      case "ObjectLiteral": {
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
            const want = hint && isObjectTy(hint) ? fieldType(hint, p.key) : undefined;
            put(p.key, this.type(p.value, scope, want ? baseTy(want) : undefined));
          }
        }
        return objectType(fields);
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
        return b.ty;
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
            throw typeError(`'${(e.object as any).name ?? "value"}' is possibly ${nullishKind(ot)}; use '?.'`);
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
        if ((ot === "string" || isArrayTy(ot) || isBytesTy(ot)) && e.property === "length") return "number";
        if ((isMapTy(ot) || isSetTy(ot)) && e.property === "size") return "number";
        if (ot === "Dyn") return "Dyn"; // dynamic field access — runtime tag check
        if (isObjectTy(ot)) {
          const ft = fieldType(ot, e.property);
          if (!ft) throw typeError(`Property '${e.property}' does not exist on ${ot}`);
          return ft; // a redundant `?.` on a non-nullable object is allowed (result unchanged)
        }
        throw typeError(`Property '${e.property}' does not exist on ${ot}`);
      }
      case "IndexExpr": {
        const ot = this.type(e.object, scope);
        if (ot === "Dyn") { this.type(e.index, scope); return "Dyn"; } // dynamic element/field — runtime tag check
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
        const r = this.type(e.right, scope, rhint);
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
        this.type(e.test, scope);
        // Each arm sees the surrounding context; additionally an empty `[]` arm takes
        // its element type from the OTHER arm (`flag ? [1, 2] : []`), so type the
        // non-empty arm first and feed its type back.
        let a: Ty, b: Ty;
        if (isEmptyArrayLit(e.consequent) && !isEmptyArrayLit(e.alternate)) {
          b = this.type(e.alternate, scope, hint);
          a = this.type(e.consequent, scope, hint ?? b);
        } else {
          a = this.type(e.consequent, scope, hint);
          b = this.type(e.alternate, scope, hint ?? a);
        }
        if (a !== b) throw typeError(`Ternary branches differ: ${a} vs ${b}`);
        return a;
      }
      case "AssignExpr": {
        const b = scope.lookup(e.target);
        if (!b) throw typeError(`'${e.target}' is not defined`);
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
        // `this.field = expr` inside a constructor — initialize one instance slot.
        const ot = this.type(e.object, scope);
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
          if (e.args.length !== 0) throw nyi(NYI.COLLECTION, "new Map(iterable) (use .set)");
          const k = e.typeArgs?.[0] ?? "string", v = e.typeArgs?.[1] ?? "number";
          // Keys ride an i64 slot tagged NT_K_STR (string) or NT_K_NUM (number) —
          // those are the two the runtime canonicalizes (SameValueZero), so keys are
          // restricted to string|number. Values ride a raw i64 slot, so any storable
          // type works: scalars plus heap refs (array/object).
          if (k !== "string" && k !== "number") throw nyi(NYI.COLLECTION, `Map with ${k} keys (only string|number keys)`);
          if (!isMapValueTy(v)) throw nyi(NYI.COLLECTION, `Map with ${v} values`);
          return makeMapTy(k, v);
        }
        if (e.callee === "Set") {
          if (e.args.length !== 0) throw nyi(NYI.COLLECTION, "new Set(iterable) (use .add)");
          const el = e.typeArgs?.[0] ?? "string";
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
            if (at !== exp && !this.assignable(exp, at)) throw typeError(`new ${e.callee} arg ${i} expects ${exp}, got ${at}`);
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
    for (const s of stmts) {
      let t: Ty | undefined;
      if (s.kind === "ThrowStmt") t = this.type(s.argument, scope);
      else if (s.kind === "IfStmt") t = this.inferThrowType(s.consequent, scope) ?? (s.alternate ? this.inferThrowType(s.alternate, scope) : undefined);
      else if (s.kind === "WhileStmt" || s.kind === "DoWhileStmt" || s.kind === "ForOfStmt" || s.kind === "ForInStmt" || s.kind === "ForStmt") t = this.inferThrowType(s.body, scope);
      else if (s.kind === "BlockStmt") t = this.inferThrowType(s.body, scope);
      else if (s.kind === "MultiStmt") t = this.inferThrowType(s.stmts, scope);
      if (t) return t;
    }
    return undefined;
  }

  private calleeArity(callee: Expr, scope: Scope): number | undefined {
    if (callee.kind === "Identifier") {
      const b = scope.lookup(callee.name);
      if (b && isFuncTy(b.ty)) return funcParams(b.ty).length;
      const sig = this.functions.get(callee.name);
      if (sig) return sig.params.length;
    }
    return undefined; // variadic builtin / method
  }

  private inferCall(e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope, hint?: Ty): Ty {
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

    // console.log(...)
    if (isConsoleLog(e)) {
      for (const a of e.args) {
        const at = this.type(a, scope);
        if (isArrayTy(at)) throw nyi(NYI.ARRAY, "console.log of an array (node's array formatting)");
        // node prints a Uint8Array with a size-dependent, column-grouped multi-line
        // layout for 7+ elements (not statically known here) — not cheap to match
        // byte-for-byte, so reject rather than guess (reject-don't-miscompile).
        if (isBytesTy(at)) throw nyi(NYI.BYTES, "console.log of a Uint8Array (node's column-grouped typed-array formatting)");
        // A Response/Headers handle has no printable form here (node prints an inspected
        // `Response { … }`); reject rather than print the raw pointer.
        if (isResponseTy(at) || isHeadersTy(at)) throw nyi(NYI.OBJECT, `console.log of a ${at} (print .status / .ok / await res.text() instead)`);
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
      this.type(e.args[0]!, scope);
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
      if (p !== "keys" && p !== "values" && p !== "entries") throw nyi(NYI.OBJECT, `Object.${p}`);
      if (e.args.length !== 1) throw typeError(`Object.${p} expects 1 argument`);
      const ot = this.type(e.args[0]!, scope);
      if (!isObjectTy(ot)) throw typeError(`Object.${p} expects an object`);
      if (p === "keys") return "string[]";
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

    // receiver.method(...)
    if (e.callee.kind === "MemberExpr") {
      const recv = this.type(e.callee.object, scope);
      // class instance method: `inst.m(args)` → the lowered `C.m(this, …)`.
      const cls = classTag(recv);
      if (cls) {
        const msig = this.functions.get(`${cls}.${e.callee.property}`);
        if (!msig) {
          if (fieldType(recv, e.callee.property)) throw typeError(`'${e.callee.property}' is a field of ${cls}, not a method`);
          throw typeError(`Method '${e.callee.property}' does not exist on ${cls}`);
        }
        const min = msig.required - 1, max = msig.params.length - 1;
        if (e.args.length < min || e.args.length > max) throw typeError(`'${cls}.${e.callee.property}' expects ${min}..${max} args, got ${e.args.length}`);
        e.args.forEach((a, i) => {
          const exp = msig.params[i + 1]!;
          const at = this.typeArg(a, exp, scope);
          if (at !== exp && !this.assignable(exp, at)) throw typeError(`'${cls}.${e.callee.property}' arg ${i} expects ${exp}, got ${at}`);
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
      if (isArrayTy(recv)) return this.inferArrayMethod(recv, e.callee.property, e.args, scope);
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
      if (!sig) throw nyi(NYI.CLOSURE, `call to '${e.callee.name}' (function values / unknown callee)`);
      if (sig.rest) {
        const fixed = sig.params.length - 1;
        if (e.args.length < sig.required) throw typeError(`'${e.callee.name}' expects at least ${sig.required} args`);
        const restElem = elemTy(sig.params[fixed]!);
        e.args.forEach((a, i) => {
          const exp = i < fixed ? sig.params[i]! : restElem;
          const at = this.typeArg(a, exp, scope);
          if (at !== exp) throw typeError(`'${e.callee.name}' arg ${i} expects ${exp}, got ${at}`);
        });
        return sig.ret;
      }
      if (e.args.length < sig.required || e.args.length > sig.params.length) {
        throw typeError(`'${e.callee.name}' expects ${sig.required}..${sig.params.length} args, got ${e.args.length}`);
      }
      e.args.forEach((a, i) => {
        const at = this.typeArg(a, sig.params[i]!, scope); // contextual: function-typed params type their arrow args
        if (at !== sig.params[i]) throw typeError(`'${e.callee.name}' arg ${i} expects ${sig.params[i]}, got ${at}`);
      });
      return sig.ret;
    }
    // arbitrary expression callee of function type, e.g. compose(f, g)(x)
    const ct = this.type(e.callee, scope);
    if (isFuncTy(ct)) {
      const ps = funcParams(ct);
      if (e.args.length !== ps.length) throw typeError(`call expects ${ps.length} arguments, got ${e.args.length}`);
      e.args.forEach((a, i) => { const at = this.typeArg(a, ps[i]!, scope); if (at !== ps[i]) throw typeError(`arg ${i} expects ${ps[i]}, got ${at}`); });
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

  private inferArrayMethod(recv: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const el = elemTy(recv);
    if (method === "map" || method === "filter" || method === "reduce" || method === "flatMap") return this.inferHof(el, method, args, scope);
    // stdlib Batch 1 (part 2): the predicate HOFs, same inline-arrow contract as map/filter.
    if (SEARCH_HOFS.has(method)) return this.inferSearchHof(recv, el, method, args, scope);
    if (["forEach"].includes(method)) throw nyi(NYI.CLOSURE, `array .${method} (needs first-class function values)`);

    // --- ordering primitives (ES2023, non-mutating: node is the oracle) --------
    // `.sort`/`.reverse` sort IN PLACE, which the immutable model forbids; the
    // ES2023 copying pair is the supported spelling. `.toSorted()` with no
    // comparator uses node's default (compare the elements' STRING forms).
    if (method === "sort") throw mutationError("arrays are immutable: `.sort` would sort the array in place", "use `.toSorted()` (ES2023) — it returns a NEW sorted array and leaves the original alone");
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
      case "push": throw mutationError("arrays are immutable: `.push` would mutate the array in place", "build a new array instead: `[...arr, x]` — the original is unchanged");
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
    let retTy: Ty;
    if (arrow.exprBody) {
      retTy = this.type(arrow.body as Expr, inner);
    } else {
      retTy = this.inferBlockReturn(arrow.body as Stmt[], inner); // first top-level `return`
      this.checkBlock(arrow.body as Stmt[], inner.child(), retTy); // validate every return against it
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
    let retTy: Ty;
    if (arrow.exprBody) {
      retTy = this.type(arrow.body as Expr, inner);
    } else {
      retTy = this.inferBlockReturn(arrow.body as Stmt[], inner);
      this.checkBlock(arrow.body as Stmt[], inner.child(), retTy);
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
    return caps;
  }

  private typeArg(a: Expr, expected: Ty, scope: Scope): Ty {
    // The parameter type is the CONTEXT for the argument: it types an arrow's params
    // (closures) and supplies the element type of an empty `[]` (e.g. `g([])`).
    return a.kind === "ArrowFunction" ? this.typeArrow(a, expected, scope) : this.type(a, scope, baseTy(expected));
  }

  private checkArgs(args: Expr[], sig: MethodSig, scope: Scope, label: string): void {
    if (args.length < sig.min || args.length > sig.max) throw typeError(`${label} expects ${sig.min}..${sig.max} args, got ${args.length}`);
    args.forEach((a, i) => {
      const at = this.type(a, scope);
      const want = sig.argTys[i];
      if (want && at !== want) throw typeError(`${label} arg ${i} expects ${want}, got ${at}`);
    });
  }
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
    case "AsExpr": collectIdents(e.expr, out); return;
    case "InstanceOfExpr": collectIdents(e.object, out); return; // the class name is not a value
    case "ArrowFunction": if (e.exprBody) collectIdents(e.body as Expr, out); return;
    default: return; // literals
  }
}

function collectIdentsStmt(s: Stmt, out: Set<string>): void {
  switch (s.kind) {
    case "VarDecl": for (const d of s.decls) collectIdents(d.init, out); return;
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
function collectBlockLocals(s: Stmt, out: Set<string>): void {
  if (s.kind === "VarDecl") for (const d of s.decls) out.add(d.name);
  else if (s.kind === "ForOfStmt" || s.kind === "ForInStmt") out.add(s.name);
}

/** True if `e` is a member access that is part of an optional chain (some `?.` to its left). */
export function isOptChainExpr(e: Expr): boolean {
  return e.kind === "MemberExpr" && (!!e.optional || isOptChainExpr(e.object));
}

export function isConsoleLog(e: Expr): boolean {
  return (
    e.kind === "CallExpr" &&
    e.callee.kind === "MemberExpr" &&
    e.callee.object.kind === "Identifier" &&
    e.callee.object.name === "console" &&
    e.callee.property === "log"
  );
}
