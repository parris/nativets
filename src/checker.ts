/*
 * Static checker + type inference.
 *
 * Supported types: number | boolean | string | void | undefined | null.
 * Unsupported-but-valid TS is rejected here with an NT1xxx diagnostic (never
 * miscompiled), which `coverage` surfaces. Codegen only ever sees checked,
 * supported programs.
 */

import type { Program, Stmt, Expr, Ty, FuncDecl, VarDecl } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectType, objectFields, fieldType, isFuncTy, funcParams, funcRet, makeFuncTy, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, makeMapTy, makeSetTy, mapKeyTy, mapValTy, setElemTy } from "./ast.ts";
import type { ArrowFunction } from "./ast.ts";
import { NTError, NYI, nyi, typeError, mutationError } from "./diagnostics.ts";

export interface Sig { params: Ty[]; ret: Ty; required: number; defaults: (Expr | null)[]; rest: boolean; }
export interface CheckedProgram { program: Program; functions: Map<string, Sig>; }

interface Binding { ty: Ty; constant: boolean; }

class Scope {
  private vars = new Map<string, Binding>();
  constructor(private parent: Scope | null = null) {}
  child(): Scope { return new Scope(this); }
  declare(name: string, ty: Ty, constant: boolean): void { this.vars.set(name, { ty, constant }); }
  lookup(name: string): Binding | undefined { return this.vars.get(name) ?? this.parent?.lookup(name); }
}

const BUILTIN_NUMBERS = ["NaN", "Infinity"];
const RELATIONAL = new Set(["<", "<=", ">", ">="]);
const EQUALITY = new Set(["===", "!==", "==", "!="]);
const BITWISE = new Set(["&", "|", "^", "<<", ">>", ">>>"]);

const MATH_METHODS: Record<string, number | "var"> = {
  floor: 1, ceil: 1, round: 1, abs: 1, sqrt: 1, trunc: 1, pow: 2, max: "var", min: "var",
};
interface MethodSig { min: number; max: number; argTys: (Ty | null)[]; ret: Ty; }
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
  split: { min: 1, max: 1, argTys: ["string"], ret: "string[]" },
};
const GLOBAL_FUNCS: Record<string, MethodSig> = {
  parseInt: { min: 1, max: 2, argTys: ["string", "number"], ret: "number" },
  parseFloat: { min: 1, max: 1, argTys: ["string"], ret: "number" },
  isNaN: { min: 1, max: 1, argTys: ["number"], ret: "boolean" },
  Number: { min: 1, max: 1, argTys: [null], ret: "number" },
  String: { min: 1, max: 1, argTys: [null], ret: "string" },
  __arrLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live array count
  __objLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live object count
  __strLive: { min: 0, max: 0, argTys: [], ret: "number" }, // debug: live heap-string count
  // Host I/O FFI (stdin): the node oracle gets these via a harness polyfill prelude.
  readLine: { min: 0, max: 0, argTys: [], ret: "string" },  // next stdin line (no newline), "" at EOF
  readStdin: { min: 0, max: 0, argTys: [], ret: "string" }, // all remaining stdin
  readKey: { min: 0, max: 0, argTys: [], ret: "string" },   // next single keypress (raw), "" at EOF
  rawMode: { min: 1, max: 1, argTys: ["boolean"], ret: "void" }, // enter/leave terminal raw mode
  // Networking tier (L-d): libcurl-backed HTTP(S) client. `headers` is a newline-joined
  // list of "Name: Value" lines. Returns {status, body}; host/Linux only (see driver.ts).
  httpGet: { min: 2, max: 2, argTys: ["string", "string"], ret: "{status:number,body:string}" },
  httpPost: { min: 3, max: 3, argTys: ["string", "string", "string"], ret: "{status:number,body:string}" },
};
/** B3 v0 actor builtins — special-cased in inferCall (variadic / function-valued). */
const ACTOR_BUILTINS = new Set([
  "spawn", "send", "receive", "self", "__drain",
  // v2 registry / links / monitors / trap + fault injection; v3 supervision
  "register", "whereis", "link", "monitor", "trapExit", "exit", "__crash", "__kill", "supervise",
]);

export function check(program: Program): CheckedProgram {
  const functions = new Map<string, Sig>();
  const c = new Checker(functions);
  const builtins = () => {
    const s = new Scope();
    for (const n of BUILTIN_NUMBERS) s.declare(n, "number", true);
    return s;
  };

  for (const s of program.body) {
    if (s.kind !== "FuncDecl") continue;
    if (functions.has(s.name)) throw typeError(`Duplicate function '${s.name}'`);
    let rest = false;
    s.params.forEach((p, i) => { if (p.rest) { if (i !== s.params.length - 1) throw typeError("rest parameter must be last"); rest = true; } });
    const params = s.params.map((p) => p.annot ?? (p.default ? c.type(p.default, builtins()) : "number"));
    const fixed = rest ? s.params.length - 1 : s.params.length;
    const required = s.params.slice(0, fixed).filter((p) => !p.default).length;
    const defaults = s.params.map((p) => p.default ?? null);
    const ret = s.returnAnnot ?? "number";
    s.returnTy = ret;
    functions.set(s.name, { params, ret, required, defaults, rest });
  }

  // pass 2: infer return types for unannotated functions (e.g. ones returning closures)
  for (const s of program.body) {
    if (s.kind === "FuncDecl" && !s.returnAnnot) {
      const inferred = c.inferReturnType(s, builtins());
      s.returnTy = inferred;
      functions.get(s.name)!.ret = inferred;
    }
  }

  c.checkBlock(program.body, builtins());
  for (const s of program.body) if (s.kind === "FuncDecl") c.checkFunction(s, builtins());
  return { program, functions };
}

class Checker {
  private loopDepth = 0;
  private switchDepth = 0;
  constructor(private functions: Map<string, Sig>) {}

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
          const t = this.type(d.init, scope);
          if (d.annot && d.annot !== t && !this.assignable(d.annot, t)) {
            throw typeError(`'${d.name}' declared ${d.annot} but initialized with ${t}`);
          }
          // Reshape the initializer literal to the declared slot layout (fill omitted
          // optional fields, box scalars into nullable fields) — runs AFTER inference,
          // which sets the literal's own inferred `.ty`, so it must overwrite here.
          if (d.annot) this.retypeLiteral(d.init, d.annot);
          d.ty = d.annot ?? t;
          scope.declare(d.name, d.ty, s.declKind === "const");
        }
        return;
      case "FuncDecl": return;
      case "ReturnStmt":
        if (s.argument) {
          const t = this.type(s.argument, scope);
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
        const it = this.type(s.iterable, scope);
        const el: Ty = it === "string" ? "string" : isArrayTy(it) ? elemTy(it) : (() => { throw nyi(NYI.FOR_OF_NONSTRING, `for-of over ${it}`); })();
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

  type(e: Expr, scope: Scope): Ty { const t = this.infer(e, scope); e.ty = t; return t; }

  private infer(e: Expr, scope: Scope): Ty {
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
        if (e.elements.length === 0) throw nyi(NYI.ARRAY, "empty array literals (cannot infer element type)");
        const tys = e.elements.map((el) => {
          if (el.kind === "SpreadExpr") {
            const st = this.type(el.argument, scope);
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
            put(p.key, this.type(p.value, scope));
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
        if ((ot === "string" || isArrayTy(ot)) && e.property === "length") return "number";
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
        if (isArrayTy(ot)) return elemTy(ot);
        if (ot === "string") return "string";
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
        const b = scope.lookup(e.target);
        if (!b) throw typeError(`'${e.target}' is not defined`);
        if (b.ty !== "number") throw typeError(`'${e.op}' needs number`);
        return "number";
      }
      case "BinaryExpr": {
        const l = this.type(e.left, scope);
        const r = this.type(e.right, scope);
        if (RELATIONAL.has(e.op)) {
          if (l !== "number" || r !== "number") throw typeError(`Comparison needs numbers`);
          return "boolean";
        }
        if (EQUALITY.has(e.op)) {
          if (l !== r) throw typeError(`Cannot compare ${l} with ${r}`);
          return "boolean";
        }
        if (BITWISE.has(e.op)) {
          if (l !== "number" || r !== "number") throw typeError(`Bitwise op needs numbers`);
          return "number";
        }
        if (e.op === "+" && (l === "string" || r === "string")) return "string";
        if (l !== "number" || r !== "number") throw typeError(`Arithmetic needs numbers, got ${l} ${e.op} ${r}`);
        return "number";
      }
      case "LogicalExpr": {
        const l = this.type(e.left, scope);
        const r = this.type(e.right, scope);
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
        const a = this.type(e.consequent, scope);
        const b = this.type(e.alternate, scope);
        if (a !== b) throw typeError(`Ternary branches differ: ${a} vs ${b}`);
        return a;
      }
      case "AssignExpr": {
        const b = scope.lookup(e.target);
        if (!b) throw typeError(`'${e.target}' is not defined`);
        if (b.constant) throw typeError(`Cannot assign to const '${e.target}'`);
        const vt = this.type(e.value, scope);
        if (e.op === "=") {
          if (vt !== b.ty && !this.assignable(b.ty, vt)) throw typeError(`Cannot assign ${vt} to ${b.ty} '${e.target}'`);
        } else if (e.op === "+=" && b.ty === "string") {
          if (vt !== "string" && vt !== "number") throw typeError(`Cannot += ${vt} to string`);
        } else if (b.ty !== "number" || vt !== "number") {
          throw typeError(`'${e.op}' needs number`);
        }
        return b.ty;
      }
      case "NewExpr": {
        // Immutable collections (B2). `new Map<K,V>()` / `new Set<T>()`; bare
        // `new Map()`/`new Set()` default to Map<string,number> / Set<string>.
        if (e.callee === "Map") {
          if (e.args.length !== 0) throw nyi(NYI.COLLECTION, "new Map(iterable) (use .set)");
          const k = e.typeArgs?.[0] ?? "string", v = e.typeArgs?.[1] ?? "number";
          if (k !== "string") throw nyi(NYI.COLLECTION, `Map with ${k} keys`);
          if (v !== "number") throw nyi(NYI.COLLECTION, `Map with ${v} values`);
          return makeMapTy(k, v);
        }
        if (e.callee === "Set") {
          if (e.args.length !== 0) throw nyi(NYI.COLLECTION, "new Set(iterable) (use .add)");
          const el = e.typeArgs?.[0] ?? "string";
          if (el !== "string" && el !== "number") throw nyi(NYI.COLLECTION, `Set of ${el}`);
          return makeSetTy(el);
        }
        if (e.callee !== "Error") throw nyi(NYI.CLASS, `new ${e.callee}(...)`);
        if (e.args.length !== 1 || this.type(e.args[0]!, scope) !== "string") throw typeError("new Error(message: string)");
        return "{message:string}";
      }
      case "AsExpr": { this.type(e.expr, scope); return e.ty; } // identity retype
      case "CallExpr": return this.inferCall(e, scope);
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

  private inferCall(e: Extract<Expr, { kind: "CallExpr" }>, scope: Scope): Ty {
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
      for (const a of e.args) { const at = this.type(a, scope); if (isArrayTy(at)) throw nyi(NYI.ARRAY, "console.log of an array (node's array formatting)"); }
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
      if (name === "receive" || name === "self") {
        if (e.args.length !== 0) throw typeError(`${name}() takes no arguments`);
        return name === "self" ? "number" : "number"; // v0: number pid / message
      }
      if (name === "__drain") {
        if (e.args.length !== 0) throw typeError("__drain() takes no arguments");
        return "void";
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
        if (this.type(e.args[1]!, scope) !== "number") throw nyi(NYI.CLOSURE, "send of a non-number message (v0 actors carry number messages)");
        return "void";
      }
      // spawn(body, arg): body is (msg) => void; returns the new pid (number).
      const expected = makeFuncTy(["number"], "void"); // v0 message type
      const bodyTy = this.typeArg(e.args[0]!, expected, scope);
      if (!isFuncTy(bodyTy) || funcParams(bodyTy).length !== 1) throw typeError("spawn: body must be a one-argument function");
      // The body's return value is ignored (the actor entry trampoline discards it),
      // so any inferred return type is fine — nativets defaults empty blocks to number.
      const msgTy = funcParams(bodyTy)[0]!;
      if (msgTy !== "number") throw nyi(NYI.CLOSURE, "spawn body with a non-number message (v0 actors carry number messages)");
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
      if (e.args.length !== 1) throw typeError("JSON.stringify expects 1 argument");
      this.type(e.args[0]!, scope);
      return "string";
    }

    // Object.keys(o)
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object") {
      if (e.callee.property !== "keys") throw nyi(NYI.OBJECT, `Object.${e.callee.property}`);
      if (e.args.length !== 1) throw typeError("Object.keys expects 1 argument");
      if (!isObjectTy(this.type(e.args[0]!, scope))) throw typeError("Object.keys expects an object");
      return "string[]";
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
      if (isMapTy(recv)) return this.inferMapMethod(recv, e.callee.property, e.args, scope);
      if (isSetTy(recv)) return this.inferSetMethod(recv, e.callee.property, e.args, scope);
      if (isArrayTy(recv)) return this.inferArrayMethod(recv, e.callee.property, e.args, scope);
      if (recv === "string") {
        const sig = STRING_METHODS[e.callee.property];
        if (!sig) throw nyi(NYI.OBJECT, `string method '${e.callee.property}'`);
        this.checkArgs(e.args, sig, scope, `'.${e.callee.property}'`);
        return sig.ret;
      }
      throw nyi(NYI.OBJECT, `method call on ${recv}`);
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

      const sig = this.functions.get(e.callee.name);
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

  /** Immutable Map methods (B2): .set/.get/.has/.delete. `.set`/`.delete` return a NEW map. */
  private inferMapMethod(recv: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const k = mapKeyTy(recv), v = mapValTy(recv);
    const argTys = args.map((a) => this.type(a, scope));
    const needKey = (i: number) => { if (argTys[i] !== k) throw typeError(`.${method} key expects ${k}, got ${argTys[i]}`); };
    switch (method) {
      case "set": if (args.length !== 2) throw typeError(".set expects (key, value)"); needKey(0);
        if (argTys[1] !== v) throw typeError(`.set value expects ${v}, got ${argTys[1]}`); return recv; // NEW map
      case "get": if (args.length !== 1) throw typeError(".get expects (key)"); needKey(0); return v;
      case "has": if (args.length !== 1) throw typeError(".has expects (key)"); needKey(0); return "boolean";
      case "delete": if (args.length !== 1) throw typeError(".delete expects (key)"); needKey(0); return recv; // NEW map
      default: throw nyi(NYI.COLLECTION, `Map method '.${method}'`);
    }
  }

  /** Immutable Set methods (B2): .add/.has/.delete. `.add`/`.delete` return a NEW set. */
  private inferSetMethod(recv: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const el = setElemTy(recv);
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
    if (method === "map" || method === "filter" || method === "reduce") return this.inferHof(el, method, args, scope);
    if (["forEach", "some", "every", "find"].includes(method)) throw nyi(NYI.CLOSURE, `array .${method} (needs first-class function values)`);

    const argTys = args.map((a) => this.type(a, scope));
    const need = (n: number) => { if (args.length !== n) throw typeError(`.${method} expects ${n} args`); };
    switch (method) {
      // Immutable-by-default (Phase B): `.push`/`.pop` mutate in place, which the
      // model forbids. Reject with NT1606 pointing at the non-mutating replacement
      // (rather than silently diverging from node's mutate-and-return semantics).
      case "push": throw mutationError("arrays are immutable: `.push` would mutate the array in place", "build a new array instead: `[...arr, x]` — the original is unchanged");
      case "pop": throw mutationError("arrays are immutable: `.pop` would mutate the array in place", "use `arr.slice(0, -1)` for the shorter array, or `arr[arr.length - 1]` for the last element");
      case "includes": need(1); if (argTys[0] !== el) throw typeError(`.includes expects ${el}`); return "boolean";
      case "indexOf": need(1); if (argTys[0] !== el) throw typeError(`.indexOf expects ${el}`); return "number";
      case "reverse": need(0); return recv;
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

  /** map/filter/reduce with an INLINE arrow callback (contextually typed). */
  private inferHof(el: Ty, method: string, args: Expr[], scope: Scope): Ty {
    const arrow = args[0];
    if (!arrow || arrow.kind !== "ArrowFunction") throw nyi(NYI.CLOSURE, `array .${method} needs an inline arrow (first-class functions not yet supported)`);
    if (!arrow.exprBody) throw nyi(NYI.CLOSURE, `array .${method} needs an expression-body arrow`);

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
    if (method === "filter") {
      if (bodyTy !== "boolean") throw typeError(".filter callback must return boolean");
      return `${el}[]`;
    }
    if (bodyTy !== "number" && bodyTy !== "string" && bodyTy !== "boolean" && !isObjectTy(bodyTy) && !isArrayTy(bodyTy)) throw nyi(NYI.ARRAY, `.map producing ${bodyTy}`);
    return `${bodyTy}[]`;
  }

  private typeArrowBody(arrow: Extract<Expr, { kind: "ArrowFunction" }>, paramTypes: Ty[], scope: Scope): Ty {
    const inner = scope.child();
    arrow.params.forEach((p, i) => inner.declare(p.name, paramTypes[i]!, false));
    return this.type(arrow.body as Expr, inner);
  }

  /** Type an arrow used as a VALUE → a function type, with capture analysis. */
  private typeArrow(arrow: ArrowFunction, expected: Ty | undefined, scope: Scope): Ty {
    const expParams = expected && isFuncTy(expected) ? funcParams(expected) : undefined;
    const paramTys = arrow.params.map((p, i) => {
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
    return a.kind === "ArrowFunction" ? this.typeArrow(a, expected, scope) : this.type(a, scope);
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

/** Collect every identifier name referenced in an expression (for capture analysis). */
function collectIdents(e: Expr, out: Set<string>): void {
  switch (e.kind) {
    case "Identifier": out.add(e.name); return;
    case "TemplateLiteral": e.exprs.forEach((x) => collectIdents(x, out)); return;
    case "MemberExpr": collectIdents(e.object, out); return;
    case "IndexExpr": collectIdents(e.object, out); collectIdents(e.index, out); return;
    case "UnaryExpr": collectIdents(e.operand, out); return;
    case "TypeofExpr": collectIdents(e.operand, out); return;
    case "UpdateExpr": out.add(e.target); return;
    case "BinaryExpr": collectIdents(e.left, out); collectIdents(e.right, out); return;
    case "LogicalExpr": collectIdents(e.left, out); collectIdents(e.right, out); return;
    case "ConditionalExpr": collectIdents(e.test, out); collectIdents(e.consequent, out); collectIdents(e.alternate, out); return;
    case "AssignExpr": out.add(e.target); collectIdents(e.value, out); return;
    case "CallExpr": collectIdents(e.callee, out); e.args.forEach((a) => collectIdents(a, out)); return;
    case "ArrayLiteral": e.elements.forEach((x) => collectIdents(x, out)); return;
    case "ObjectLiteral": e.properties.forEach((p) => collectIdents(p.value, out)); return;
    case "SpreadExpr": collectIdents(e.argument, out); return;
    case "SequenceExpr": e.exprs.forEach((x) => collectIdents(x, out)); return;
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
