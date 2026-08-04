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
import { isConsoleLog } from "./checker.ts";
import type { Stmt, Expr, Ty, FuncDecl, VarDecl } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectFields, fieldIndex, fieldType, isFuncTy, funcParams, funcRet } from "./ast.ts";
import type { ArrowFunction } from "./ast.ts";
import { nyi, NYI } from "./diagnostics.ts";

export function llvmDouble(n: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, n, false);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += dv.getUint8(i).toString(16).padStart(2, "0");
  return "0x" + hex.toUpperCase();
}

function llvmTy(ty: Ty): string {
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty)) return "ptr";
  switch (ty) {
    case "number": return "double";
    case "boolean": return "i1";
    case "string": return "ptr";
    case "Dyn": return "ptr"; // heap-boxed tagged value from JSON.parse
    case "void": return "void";
    default: return "i8"; // undefined | null — unit value; the static type carries meaning
  }
}

function defaultZero(ty: Ty): string {
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty)) return "null";
  switch (ty) {
    case "number": return "0x0000000000000000";
    case "boolean": return "false";
    case "string": return "null";
    case "void": return "";
    default: return "0"; // undefined | null
  }
}

const POS_INF = "0x7FF0000000000000";

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

const DECLARES = [
  "declare void @js_print_num(double)",
  "declare void @js_print_bool(i32)",
  "declare void @js_print_str(ptr)",
  "declare void @js_print_sep()",
  "declare void @js_print_newline()",
  "declare double @pow(double, double)",
  "declare ptr @js_str_concat(ptr, ptr)",
  "declare double @js_str_len(ptr)",
  "declare i32 @js_str_eq(ptr, ptr)",
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
  "declare double @fmax(double, double)",
  "declare double @fmin(double, double)",
  // string methods
  "declare ptr @js_str_upper(ptr)",
  "declare ptr @js_str_lower(ptr)",
  "declare ptr @js_str_trim(ptr)",
  "declare ptr @js_str_char_at(ptr, double)",
  "declare ptr @js_str_slice(ptr, double, double)",
  "declare ptr @js_str_substring(ptr, double, double)",
  "declare ptr @js_str_repeat(ptr, double)",
  "declare ptr @js_str_pad_start(ptr, double, ptr)",
  "declare i32 @js_str_includes(ptr, ptr)",
  "declare double @js_str_index_of(ptr, ptr)",
  // arrays
  "declare ptr @nt_arr_new(double)",
  "declare double @nt_arr_push(ptr, i64)",
  "declare i64 @nt_arr_get(ptr, double)",
  "declare i64 @nt_arr_pop(ptr)",
  "declare double @nt_arr_len(ptr)",
  "declare ptr @nt_arr_join_num(ptr, ptr)",
  "declare ptr @nt_arr_join_str(ptr, ptr)",
  "declare i32 @nt_arr_includes_num(ptr, double)",
  "declare i32 @nt_arr_includes_str(ptr, ptr)",
  "declare double @nt_arr_indexof_num(ptr, double)",
  "declare double @nt_arr_indexof_str(ptr, ptr)",
  "declare void @nt_arr_free(ptr)",
  "declare double @nt_arr_live()",
  "declare ptr @nt_obj_new(double)",
  "declare void @nt_obj_free(ptr)",
  "declare ptr @nt_str_split(ptr, ptr)",
  "declare ptr @nt_arr_reverse(ptr)",
  "declare ptr @nt_arr_slice(ptr, double, double)",
  "declare void @nt_arr_extend(ptr, ptr)",
  "declare ptr @js_json_quote(ptr)",
  "declare ptr @nt_json_parse(ptr)",
  "declare double @nt_dyn_as_number(ptr)",
  "declare i32 @nt_dyn_as_bool(ptr)",
  "declare ptr @nt_dyn_as_string(ptr)",
  "declare i32 @nt_exc_pending()",
  "declare ptr @nt_exc_message()",
  "declare void @nt_exc_clear()",
  "declare void @nt_exc_abort()",
];

interface Val { v: string; ty: Ty; }

class ModuleGen {
  private strings = new Map<string, string>();
  private strDefs: string[] = [];
  readonly liftedFns: string[] = [];
  private arrowCounter = 0;
  constructor(readonly functions: Map<string, Sig>) {}

  /** Lambda-lift an arrow to a top-level function `@arrow_N(ptr env, params)`. Idempotent. */
  liftArrow(arrow: ArrowFunction): string {
    if (arrow.liftedName) return arrow.liftedName;
    const name = `arrow_${this.arrowCounter++}`;
    arrow.liftedName = name;
    this.liftedFns.push(new FnGen(this).genArrow(name, arrow));
    return name;
  }

  intern(s: string): string {
    const existing = this.strings.get(s);
    if (existing) return existing;
    const sym = `@.str.${this.strings.size}`;
    const { body, len } = encodeCString(s);
    this.strDefs.push(`${sym} = private unnamed_addr constant [${len} x i8] c"${body}"`);
    this.strings.set(s, sym);
    return sym;
  }

  build(program: CheckedProgram["program"]): string {
    const fns: string[] = [];
    for (const s of program.body) {
      if (s.kind === "FuncDecl") fns.push(new FnGen(this).genFunction(s));
    }
    const main = new FnGen(this).genMain(program.body, program.endDrops ?? []);
    return [
      "; ModuleID = 'nativets'",
      ...DECLARES,
      "",
      ...this.strDefs,
      this.strDefs.length ? "" : null,
      ...this.liftedFns.flatMap((f) => [f, ""]), // lifted arrows (populated during gen)
      ...fns.flatMap((f) => [f, ""]),
      main,
      "",
    ].filter((x) => x !== null).join("\n");
  }
}

const FCMP: Record<string, string> = {
  "<": "olt", "<=": "ole", ">": "ogt", ">=": "oge", "===": "oeq", "==": "oeq", "!==": "une", "!=": "une",
};
const ARITH: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "%": "frem" };
const BITFN: Record<string, string> = {
  "&": "js_bit_and", "|": "js_bit_or", "^": "js_bit_xor", "<<": "js_shl", ">>": "js_shr", ">>>": "js_ushr",
};
const MATH_FN1: Record<string, string> = {
  floor: "floor", ceil: "ceil", sqrt: "sqrt", trunc: "trunc", abs: "fabs", round: "js_math_round",
};

class FnGen {
  private entryAllocas: string[] = [];
  private blocks: { label: string; lines: string[]; terminated: boolean }[] = [];
  private cur = 0;
  private tmp = 0;
  private lbl = 0;
  private varTypes = new Map<string, Ty>();
  private retTy: Ty = "number";
  private loops: { brk: string; cont: string }[] = [];
  /** In a lifted arrow: captured var name -> its slot in the closure env (%__clo). */
  private captures = new Map<string, { index: number; ty: Ty }>();
  /** Active catch targets (a `throw` branches to the innermost). */
  private tryHandlers: { catchLbl: string; excVar: string | null; eType: Ty }[] = [];
  /** Active finally blocks (a `return` inside runs finally first, mode=1). */
  private finallyStack: { finallyLbl: string; modeSlot: string; retSlot: string | null }[] = [];

  constructor(private mod: ModuleGen) {}

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
  private get terminated(): boolean { return this.blocks[this.cur]!.terminated; }

  private reset(): void {
    this.entryAllocas = []; this.blocks = []; this.cur = 0; this.tmp = 0; this.lbl = 0;
    this.varTypes = new Map();
    this.loops = [];
    this.captures = new Map();
    this.tryHandlers = [];
    this.finallyStack = [];
  }

  /** Generate a statement sequence, stopping once the block is terminated
   *  (so code after return/break/continue isn't emitted as unreachable IR). */
  private genStmts(list: Stmt[]): void {
    for (const s of list) {
      if (this.terminated) break;
      this.genStmt(s);
    }
  }

  /** Emit deterministic drops (RAII frees) for owned linear locals. */
  private emitDrops(names: string[]): void {
    for (const n of names) {
      const p = this.fresh();
      this.emit(`${p} = load ptr, ptr %${n}.addr`);
      this.emit(`call void @nt_arr_free(ptr ${p})`);
    }
  }

  private addLocal(name: string, ty: Ty): void {
    if (!this.varTypes.has(name)) { this.varTypes.set(name, ty); this.alloca(name, ty); }
  }

  private collectLocals(body: Stmt[]): void {
    for (const s of body) {
      switch (s.kind) {
        case "VarDecl":
          for (const d of s.decls) this.addLocal(d.name, d.ty ?? "number");
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
          this.collectLocals(s.block);
          if (s.handler) this.collectLocals(s.handler);
          if (s.finalizer) this.collectLocals(s.finalizer);
          break;
        default: break;
      }
    }
  }

  // ---- functions ----
  genFunction(fn: FuncDecl): string {
    this.reset();
    this.retTy = fn.returnTy ?? "number";
    const sig = this.mod.functions.get(fn.name)!;
    fn.params.forEach((p, i) => {
      const ty = sig.params[i]!;
      this.varTypes.set(p.name, ty);
      this.alloca(p.name, ty);
    });
    this.collectLocals(fn.body);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    fn.params.forEach((p, i) => {
      const ty = sig.params[i]!;
      this.emit(`store ${llvmTy(ty)} %${p.name}, ptr %${p.name}.addr`);
    });
    this.genStmts(fn.body);
    if (!this.terminated) {
      this.emitDrops(fn.endDrops ?? []);
      this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
    }
    const params = fn.params.map((p, i) => `${llvmTy(sig.params[i]!)} %${p.name}`).join(", ");
    return this.assemble(`define ${llvmTy(this.retTy)} @${fn.name}(${params})`, b0);
  }

  genMain(body: Stmt[], endDrops: string[]): string {
    this.reset();
    this.retTy = "number";
    this.collectLocals(body);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    this.genStmts(body);
    if (!this.terminated) { this.emitDrops(endDrops); this.terminate("ret i32 0"); }
    return this.assemble("define i32 @main()", b0);
  }

  /** Generate a lifted arrow `define <ret> @name(ptr %__clo, params) { ... }`. */
  genArrow(name: string, arrow: ArrowFunction): string {
    this.reset();
    this.retTy = arrow.retTy ?? "number";
    const paramTys = arrow.paramTys ?? [];
    this.captures = new Map((arrow.captures ?? []).map((c, i) => [c.name, { index: i, ty: c.ty }]));
    arrow.params.forEach((p, i) => { this.varTypes.set(p.name, paramTys[i]!); this.alloca(p.name, paramTys[i]!); });
    if (!arrow.exprBody) this.collectLocals(arrow.body as Stmt[]);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    arrow.params.forEach((p, i) => this.emit(`store ${llvmTy(paramTys[i]!)} %${p.name}, ptr %${p.name}.addr`));
    if (arrow.exprBody) {
      const bodyVal = this.genExpr(arrow.body as Expr);
      this.terminate(`ret ${llvmTy(this.retTy)} ${bodyVal.v}`);
    } else {
      this.genStmts(arrow.body as Stmt[]);
      if (!this.terminated) this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`);
    }
    const params = ["ptr %__clo", ...arrow.params.map((p, i) => `${llvmTy(paramTys[i]!)} %${p.name}`)].join(", ");
    return this.assemble(`define ${llvmTy(this.retTy)} @${name}(${params})`, b0);
  }

  private assemble(header: string, firstBlock: number): string {
    const out: string[] = [`${header} {`, "entry:"];
    for (const a of this.entryAllocas) out.push("  " + a);
    out.push(`  br label %${this.blocks[firstBlock]!.label}`);
    for (const b of this.blocks) {
      out.push(`${b.label}:`);
      out.push(...b.lines);
    }
    out.push("}");
    return out.join("\n");
  }

  // ---- statements ----
  private genStmt(s: Stmt): void {
    switch (s.kind) {
      case "VarDecl": {
        for (const d of s.decls) {
          const val = this.genExpr(d.init);
          this.emit(`store ${llvmTy(d.ty ?? "number")} ${val.v}, ptr %${d.name}.addr`);
        }
        return;
      }
      case "ExprStmt": this.genExpr(s.expr); return;
      case "ReturnStmt": {
        if (this.finallyStack.length > 0) {
          // return inside a try/catch with a finally: stash value, run finally (mode=1)
          const f = this.finallyStack[this.finallyStack.length - 1]!;
          if (s.argument && f.retSlot) { const v = this.genExpr(s.argument); this.emit(`store ${llvmTy(this.retTy)} ${v.v}, ptr ${f.retSlot}`); }
          this.emit(`store double ${llvmDouble(1)}, ptr ${f.modeSlot}`);
          this.terminate(`br label %${f.finallyLbl}`);
          return;
        }
        if (s.argument) {
          const val = this.genExpr(s.argument);
          this.emitDrops(s.drops ?? []); // free owned locals before returning (not the moved-out value)
          this.terminate(`ret ${llvmTy(val.ty)} ${val.v}`);
        } else {
          this.emitDrops(s.drops ?? []);
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
        if (!this.terminated) this.terminate(`br label %${endLbl}`);
        if (s.alternate) {
          const elseIdx = this.block(elseLbl);
          this.to(elseIdx);
          this.genStmts(s.alternate);
          if (!this.terminated) this.terminate(`br label %${endLbl}`);
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
        const cond = this.genCond(s.test);
        this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(bodyLbl));
        this.loops.push({ brk: endLbl, cont: condLbl });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.terminated) this.terminate(`br label %${condLbl}`);
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
        if (s.test) {
          const cond = this.genCond(s.test);
          this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        } else {
          this.terminate(`br label %${bodyLbl}`);
        }
        this.to(this.block(bodyLbl));
        this.loops.push({ brk: endLbl, cont: updLbl });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.terminated) this.terminate(`br label %${updLbl}`);
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
        this.loops.push({ brk: endLbl, cont: condLbl });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.terminated) this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
        const cond = this.genCond(s.test);
        this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "ForOfStmt": {
        const src = this.genExpr(s.iterable);
        const isStr = src.ty === "string";
        const el = s.elemTy ?? "string";
        const idx = this.slot("number");
        this.emit(`store double 0x0000000000000000, ptr ${idx}`);
        const lenT = this.fresh();
        this.emit(`${lenT} = call double @${isStr ? "js_str_len" : "nt_arr_len"}(ptr ${src.v})`);
        const condLbl = this.label("of");
        const bodyLbl = this.label("ofbody");
        const updLbl = this.label("ofupd");
        const endLbl = this.label("endof");
        this.terminate(`br label %${condLbl}`);
        this.to(this.block(condLbl));
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
          this.emit(`store ptr ${ch}, ptr %${s.name}.addr`);
        } else {
          const slot = this.fresh();
          this.emit(`${slot} = call i64 @nt_arr_get(ptr ${src.v}, double ${iB})`);
          this.emit(`store ${llvmTy(el)} ${this.fromSlot(slot, el)}, ptr %${s.name}.addr`);
        }
        this.loops.push({ brk: endLbl, cont: updLbl });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.terminated) this.terminate(`br label %${updLbl}`);
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
      case "SwitchStmt": {
        const disc = this.genExpr(s.discriminant);
        const endLbl = this.label("endsw");
        const bodyLbls = s.cases.map(() => this.label("case"));
        const defaultIdx = s.cases.findIndex((c) => c.test === null);
        const outerCont = this.loops.length ? this.loops[this.loops.length - 1]!.cont : endLbl;
        this.loops.push({ brk: endLbl, cont: outerCont });
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
          if (!this.terminated) this.terminate(`br label %${i + 1 < s.cases.length ? bodyLbls[i + 1] : endLbl}`);
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
        this.emit(`store ptr ${this.fromSlot(slot, "string")}, ptr %${s.name}.addr`);
        this.loops.push({ brk: endLbl, cont: updLbl });
        this.genStmts(s.body);
        this.loops.pop();
        if (!this.terminated) this.terminate(`br label %${updLbl}`);
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
        const h = this.tryHandlers[this.tryHandlers.length - 1];
        if (!h) throw new Error("throw outside a try (unsupported)");
        const v = this.genExpr(s.argument);
        if (h.excVar) this.emit(`store ${llvmTy(h.eType)} ${v.v}, ptr %${h.excVar}.addr`);
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
        this.tryHandlers.push({ catchLbl, excVar: s.param, eType });
        if (hasFinally) this.finallyStack.push({ finallyLbl, modeSlot, retSlot: retSlot || null });
        this.genStmts(s.block);
        this.tryHandlers.pop();
        if (!this.terminated) gotoFinally();
        if (s.handler) {
          this.to(this.block(catchLbl));
          this.genStmts(s.handler);
          if (!this.terminated) gotoFinally();
        }
        if (hasFinally) {
          this.finallyStack.pop();
          this.to(this.block(finallyLbl));
          this.genStmts(s.finalizer!);
          if (!this.terminated) {
            const m = this.fresh(); this.emit(`${m} = load double, ptr ${modeSlot}`);
            const isRet = this.fresh(); this.emit(`${isRet} = fcmp oeq double ${m}, ${llvmDouble(1)}`);
            const retLbl = this.label("finret");
            this.terminate(`br i1 ${isRet}, label %${retLbl}, label %${endLbl}`);
            this.to(this.block(retLbl));
            if (this.retTy === "void" || !retSlot) this.terminate("ret void");
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
      case "BreakStmt":
        this.terminate(`br label %${this.loops[this.loops.length - 1]!.brk}`);
        return;
      case "ContinueStmt":
        this.terminate(`br label %${this.loops[this.loops.length - 1]!.cont}`);
        return;
      case "FuncDecl":
        return;
    }
  }

  /** Lower an expression to an i1 truthiness value. */
  private genCond(e: Expr): string {
    const val = this.genExpr(e);
    if (val.ty === "boolean") return val.v;
    if (val.ty === "number") {
      const t = this.fresh();
      this.emit(`${t} = fcmp one double ${val.v}, 0.0`);
      return t;
    }
    // string: truthy iff non-empty
    const len = this.fresh();
    this.emit(`${len} = call double @js_str_len(ptr ${val.v})`);
    const t = this.fresh();
    this.emit(`${t} = fcmp one double ${len}, 0.0`);
    return t;
  }

  private coerceToString(val: Val): string {
    if (val.ty === "string") return val.v;
    if (val.ty === "undefined") return this.mod.intern("undefined");
    if (val.ty === "null") return this.mod.intern("null");
    if (val.ty === "number") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @js_num_to_str(double ${val.v})`);
      return t;
    }
    const z = this.fresh();
    this.emit(`${z} = zext i1 ${val.v} to i32`);
    const t = this.fresh();
    this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
    return t;
  }

  /** Coerce any value to a `double` (JS ToNumber for the supported types). */
  private coerceToNumber(val: Val): string {
    if (val.ty === "number") return val.v;
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
    return llvmDouble(NaN); // undefined
  }

  /** Pack a value into a 64-bit array slot. */
  private toSlot(val: Val): string {
    const t = this.fresh();
    if (val.ty === "number") this.emit(`${t} = bitcast double ${val.v} to i64`);
    else if (val.ty === "string" || isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty)) this.emit(`${t} = ptrtoint ptr ${val.v} to i64`);
    else if (val.ty === "boolean") this.emit(`${t} = zext i1 ${val.v} to i64`);
    else this.emit(`${t} = zext i8 ${val.v} to i64`);
    return t;
  }
  /** Unpack a 64-bit slot into a value of the given type. */
  private fromSlot(slot: string, ty: Ty): string {
    const t = this.fresh();
    if (ty === "number") this.emit(`${t} = bitcast i64 ${slot} to double`);
    else if (ty === "string" || isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty)) this.emit(`${t} = inttoptr i64 ${slot} to ptr`);
    else if (ty === "boolean") this.emit(`${t} = trunc i64 ${slot} to i1`);
    else this.emit(`${t} = trunc i64 ${slot} to i8`);
    return t;
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

  // ---- expressions ----
  private genExpr(e: Expr): Val {
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
            this.emit(`call void @nt_arr_extend(ptr ${arr}, ptr ${src.v})`);
          } else {
            this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(this.genExpr(element))})`);
          }
        }
        void el;
        return { v: arr, ty };
      }

      case "IndexExpr": {
        const obj = this.genExpr(e.object);
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
        if (obj.ty === "string") {
          const t = this.fresh();
          this.emit(`${t} = call ptr @js_str_char_at(ptr ${obj.v}, double ${idx.v})`);
          return { v: t, ty: "string" };
        }
        const el = elemTy(obj.ty);
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_arr_get(ptr ${obj.v}, double ${idx.v})`);
        return { v: this.fromSlot(slot, el), ty: el };
      }

      case "ObjectLiteral": {
        const ty = e.ty as Ty;
        const nfields = objectFields(ty).length;
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(nfields)})`);
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
            }
          } else {
            const slot = this.toSlot(this.genExpr(p.value));
            const g = this.fresh();
            this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, p.key)}`);
            this.emit(`store i64 ${slot}, ptr ${g}`);
          }
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
        throw new Error(`codegen reached unsupported expression ${e.kind}`);

      case "TemplateLiteral": {
        let acc = this.mod.intern(e.quasis[0]!);
        for (let i = 0; i < e.exprs.length; i++) {
          const part = this.coerceToString(this.genExpr(e.exprs[i]!));
          acc = this.concat(acc, part);
          acc = this.concat(acc, this.mod.intern(e.quasis[i + 1]!));
        }
        return { v: acc, ty: "string" };
      }

      case "Identifier": {
        if (e.name === "NaN") return { v: llvmDouble(NaN), ty: "number" };
        if (e.name === "Infinity") return { v: llvmDouble(Infinity), ty: "number" };
        if (this.captures.has(e.name)) return this.readCapture(e.name);
        const ty = this.varTypes.get(e.name) ?? (e.ty ?? "number");
        const t = this.fresh();
        this.emit(`${t} = load ${llvmTy(ty)}, ptr %${e.name}.addr`);
        return { v: t, ty };
      }

      case "MemberExpr": {
        const obj = this.genExpr(e.object);
        if (e.property === "length" && (obj.ty === "string" || isArrayTy(obj.ty))) {
          const t = this.fresh();
          if (obj.ty === "string") this.emit(`${t} = call double @js_str_len(ptr ${obj.v})`);
          else this.emit(`${t} = call double @nt_arr_len(ptr ${obj.v})`);
          return { v: t, ty: "number" };
        }
        if (isObjectTy(obj.ty)) {
          const idx = fieldIndex(obj.ty, e.property);
          const ft = fieldType(obj.ty, e.property)!;
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${idx}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          return { v: this.fromSlot(slot, ft), ty: ft };
        }
        throw new Error(`Unsupported member .${e.property}`);
      }

      case "TypeofExpr": {
        const inner = e.operand.ty ?? "number";
        const name = inner === "undefined" || inner === "void" ? "undefined" : inner === "null" ? "object" : inner;
        return { v: this.mod.intern(name), ty: "string" };
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
        if (this.captures.has(e.target)) {
          const cur = this.readCapture(e.target);
          const nv = this.fresh();
          this.emit(`${nv} = ${e.op === "++" ? "fadd" : "fsub"} double ${cur.v}, 1.0`);
          this.writeCapture(e.target, { v: nv, ty: "number" });
          return { v: e.prefix ? nv : cur.v, ty: "number" };
        }
        const old = this.fresh();
        this.emit(`${old} = load double, ptr %${e.target}.addr`);
        const nv = this.fresh();
        this.emit(`${nv} = ${e.op === "++" ? "fadd" : "fsub"} double ${old}, 1.0`);
        this.emit(`store double ${nv}, ptr %${e.target}.addr`);
        return { v: e.prefix ? nv : old, ty: "number" };
      }

      case "BinaryExpr": {
        const op = e.op;
        if (op in FCMP) {
          const lt = e.left.ty ?? "number";
          const l = this.genExpr(e.left);
          const r = this.genExpr(e.right);
          const t = this.fresh();
          if (lt === "number") {
            this.emit(`${t} = fcmp ${FCMP[op]} double ${l.v}, ${r.v}`);
          } else if (lt === "boolean") {
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "eq" : "ne"} i1 ${l.v}, ${r.v}`);
          } else {
            const eq = this.fresh();
            this.emit(`${eq} = call i32 @js_str_eq(ptr ${l.v}, ptr ${r.v})`);
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "ne" : "eq"} i32 ${eq}, 0`);
          }
          return { v: t, ty: "boolean" };
        }
        if (op in BITFN) {
          const l = this.genExpr(e.left);
          const r = this.genExpr(e.right);
          const t = this.fresh();
          this.emit(`${t} = call double @${BITFN[op]}(double ${l.v}, double ${r.v})`);
          return { v: t, ty: "number" };
        }
        if (op === "+" && e.ty === "string") {
          const l = this.coerceToString(this.genExpr(e.left));
          const r = this.coerceToString(this.genExpr(e.right));
          return { v: this.concat(l, r), ty: "string" };
        }
        const l = this.genExpr(e.left);
        const r = this.genExpr(e.right);
        const t = this.fresh();
        if (op === "**") this.emit(`${t} = call double @pow(double ${l.v}, double ${r.v})`);
        else this.emit(`${t} = ${ARITH[op]} double ${l.v}, ${r.v}`);
        return { v: t, ty: "number" };
      }

      case "LogicalExpr": {
        if (e.op === "??") {
          // statically resolved: left is either definitely-nullish or definitely not
          const lt = e.left.ty ?? "number";
          return (lt === "null" || lt === "undefined") ? this.genExpr(e.right) : this.genExpr(e.left);
        }
        const slot = this.slot("boolean");
        const l = this.genExpr(e.left);
        this.emit(`store i1 ${l.v}, ptr ${slot}`);
        const evalLbl = this.label("rhs");
        const endLbl = this.label("logend");
        if (e.op === "&&") this.terminate(`br i1 ${l.v}, label %${evalLbl}, label %${endLbl}`);
        else this.terminate(`br i1 ${l.v}, label %${endLbl}, label %${evalLbl}`);
        this.to(this.block(evalLbl));
        const r = this.genExpr(e.right);
        this.emit(`store i1 ${r.v}, ptr ${slot}`);
        this.terminate(`br label %${endLbl}`);
        this.to(this.block(endLbl));
        const t = this.fresh();
        this.emit(`${t} = load i1, ptr ${slot}`);
        return { v: t, ty: "boolean" };
      }

      case "ConditionalExpr": {
        const ty = e.ty ?? "number";
        const slot = this.slot(ty);
        const cond = this.genCond(e.test);
        const thenLbl = this.label("tern");
        const elseLbl = this.label("ternelse");
        const endLbl = this.label("ternend");
        this.terminate(`br i1 ${cond}, label %${thenLbl}, label %${elseLbl}`);
        this.to(this.block(thenLbl));
        const c = this.genExpr(e.consequent);
        this.emit(`store ${llvmTy(ty)} ${c.v}, ptr ${slot}`);
        this.terminate(`br label %${endLbl}`);
        this.to(this.block(elseLbl));
        const a = this.genExpr(e.alternate);
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
          if (bare0 in ARITH) this.emit(`${t0} = ${ARITH[bare0]} double ${cur.v}, ${rv.v}`);
          else this.emit(`${t0} = call double @${BITFN[bare0]}(double ${cur.v}, double ${rv.v})`);
          this.writeCapture(e.target, { v: t0, ty: "number" });
          return { v: t0, ty: "number" };
        }
        const ty = this.varTypes.get(e.target) ?? "number";
        if (e.op === "=") {
          const val = this.genExpr(e.value);
          this.emit(`store ${llvmTy(ty)} ${val.v}, ptr %${e.target}.addr`);
          return { v: val.v, ty };
        }
        if (e.op === "+=" && ty === "string") {
          const old = this.fresh();
          this.emit(`${old} = load ptr, ptr %${e.target}.addr`);
          const rv = this.coerceToString(this.genExpr(e.value));
          const cat = this.concat(old, rv);
          this.emit(`store ptr ${cat}, ptr %${e.target}.addr`);
          return { v: cat, ty: "string" };
        }
        const old = this.fresh();
        this.emit(`${old} = load double, ptr %${e.target}.addr`);
        const rv = this.genExpr(e.value);
        const bare = e.op.slice(0, -1); // "+", "&", "<<", ...
        const t = this.fresh();
        if (bare in ARITH) this.emit(`${t} = ${ARITH[bare]} double ${old}, ${rv.v}`);
        else this.emit(`${t} = call double @${BITFN[bare]}(double ${old}, double ${rv.v})`);
        this.emit(`store double ${t}, ptr %${e.target}.addr`);
        return { v: t, ty: "number" };
      }

      case "AsExpr": {
        // Narrowing a dynamic value (`dyn as T`) emits a runtime validator that
        // checks the tag and unboxes; a plain `expr as Type` is an identity retype.
        if (e.expr.ty === "Dyn") return this.genDynNarrow(this.genExpr(e.expr).v, e.ty);
        return { v: this.genExpr(e.expr).v, ty: e.ty };
      }
      case "NewExpr": {
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
    if (isConsoleLog(e)) return this.genConsoleLog(e.args);

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
      return this.genJsonStringify(this.genExpr(e.args[0]!));
    }

    // Object.keys(o) — keys are compile-time known from o's type; build a string[].
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object") {
      const o = this.genExpr(e.args[0]!); // evaluate for side effects
      return this.buildStringArray(objectFields(o.ty).map((f) => f.key));
    }

    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Math") {
      return this.genMath(e.callee.property, e.args);
    }
    if (e.callee.kind === "MemberExpr") {
      const recv = this.genExpr(e.callee.object);
      if (isArrayTy(recv.ty)) return this.genArrayMethod(e.callee.property, recv, e.args);
      return this.genStringMethod(e.callee.property, recv, e.args);
    }
    if (e.callee.kind === "Identifier") {
      const g = this.genGlobal(e.callee.name, e.args);
      if (g) return g;
      const cap = this.captures.get(e.callee.name);
      if (cap && isFuncTy(cap.ty)) return this.genCallValueFrom(this.readCapture(e.callee.name).v, cap.ty, e.args);
      const vt = this.varTypes.get(e.callee.name);
      if (vt && isFuncTy(vt)) {
        const clo = this.fresh();
        this.emit(`${clo} = load ptr, ptr %${e.callee.name}.addr`);
        return this.genCallValueFrom(clo, vt, e.args);
      }
      return this.genUserCall(e.callee.name, e.args);
    }
    // arbitrary expression callee of function type, e.g. compose(f,g)(x)
    const ct = e.callee.ty;
    if (ct && isFuncTy(ct)) return this.genCallValueFrom(this.genExpr(e.callee).v, ct, e.args);
    throw new Error("Unsupported call target in codegen");
  }

  /**
   * Narrow a Dyn box (ptr) to a static type `target`, emitting a runtime validator
   * that throws (native TypeError) on a tag/shape mismatch and hands back a value of
   * `target`'s LLVM type. io-ts/zod semantics generated from the static type.
   */
  private genDynNarrow(dyn: string, target: Ty): Val {
    if (target === "number") {
      const t = this.fresh();
      this.emit(`${t} = call double @nt_dyn_as_number(ptr ${dyn})`);
      this.emitExcCheck();
      return { v: t, ty: "number" };
    }
    if (target === "boolean") {
      const t = this.fresh();
      this.emit(`${t} = call i32 @nt_dyn_as_bool(ptr ${dyn})`);
      this.emitExcCheck();
      const b = this.fresh();
      this.emit(`${b} = trunc i32 ${t} to i1`);
      return { v: b, ty: "boolean" };
    }
    if (target === "string") {
      const t = this.fresh();
      this.emit(`${t} = call ptr @nt_dyn_as_string(ptr ${dyn})`);
      this.emitExcCheck();
      return { v: t, ty: "string" };
    }
    throw nyi(NYI.JSON, `narrowing a dynamic value to ${target}`);
  }

  /**
   * After a fallible runtime call, branch to the innermost catch (clearing the
   * pending flag) if an exception was raised; at top level, abort (exit 1). Keeps
   * the lexical throw model — no unwinder — while making runtime throws catchable.
   */
  private emitExcCheck(): void {
    const p = this.fresh();
    this.emit(`${p} = call i32 @nt_exc_pending()`);
    const cond = this.fresh();
    this.emit(`${cond} = icmp ne i32 ${p}, 0`);
    const throwLbl = this.label("exc");
    const contLbl = this.label("cont");
    this.terminate(`br i1 ${cond}, label %${throwLbl}, label %${contLbl}`);
    this.to(this.block(throwLbl));
    const h = this.tryHandlers[this.tryHandlers.length - 1];
    if (h) {
      if (h.excVar && h.eType === "string") {
        const m = this.fresh();
        this.emit(`${m} = call ptr @nt_exc_message()`);
        this.emit(`store ptr ${m}, ptr %${h.excVar}.addr`);
      }
      this.emit(`call void @nt_exc_clear()`);
      this.terminate(`br label %${h.catchLbl}`);
    } else {
      this.emit(`call void @nt_exc_abort()`);
      this.terminate(`unreachable`);
    }
    this.to(this.block(contLbl));
  }

  /** Call a function VALUE (closure ptr already computed): indirect call through slot 0. */
  private genCallValueFrom(clo: string, fnTy: Ty, args: Expr[]): Val {
    const fpSlot = this.fresh();
    this.emit(`${fpSlot} = getelementptr i64, ptr ${clo}, i64 0`);
    const fpInt = this.fresh();
    this.emit(`${fpInt} = load i64, ptr ${fpSlot}`);
    const fp = this.fresh();
    this.emit(`${fp} = inttoptr i64 ${fpInt} to ptr`);
    const ps = funcParams(fnTy);
    const ret = funcRet(fnTy);
    const argVals = args.map((a, i) => `${llvmTy(ps[i]!)} ${this.genExpr(a).v}`);
    const argStr = [`ptr ${clo}`, ...argVals].join(", ");
    if (ret === "void") { this.emit(`call void ${fp}(${argStr})`); return { v: "", ty: "void" }; }
    const t = this.fresh();
    this.emit(`${t} = call ${llvmTy(ret)} ${fp}(${argStr})`);
    return { v: t, ty: ret };
  }

  private genConsoleLog(args: Expr[]): Val {
    args.forEach((a, i) => {
      const val = this.genExpr(a);
      if (i > 0) this.emit(`call void @js_print_sep()`);
      if (val.ty === "number") this.emit(`call void @js_print_num(double ${val.v})`);
      else if (val.ty === "boolean") {
        const z = this.fresh();
        this.emit(`${z} = zext i1 ${val.v} to i32`);
        this.emit(`call void @js_print_bool(i32 ${z})`);
      } else if (val.ty === "undefined") this.emit(`call void @js_print_str(ptr ${this.mod.intern("undefined")})`);
      else if (val.ty === "null") this.emit(`call void @js_print_str(ptr ${this.mod.intern("null")})`);
      else this.emit(`call void @js_print_str(ptr ${val.v})`);
    });
    this.emit(`call void @js_print_newline()`);
    return { v: "0", ty: "void" };
  }

  private genMath(method: string, args: Expr[]): Val {
    const vals = args.map((a) => this.genExpr(a).v);
    if (method === "pow") {
      const t = this.fresh();
      this.emit(`${t} = call double @pow(double ${vals[0]}, double ${vals[1]})`);
      return { v: t, ty: "number" };
    }
    if (method === "max" || method === "min") {
      const fn = method === "max" ? "fmax" : "fmin";
      if (vals.length === 0) return { v: llvmDouble(method === "max" ? -Infinity : Infinity), ty: "number" };
      let acc = vals[0]!;
      for (let i = 1; i < vals.length; i++) {
        const t = this.fresh();
        this.emit(`${t} = call double @${fn}(double ${acc}, double ${vals[i]})`);
        acc = t;
      }
      return { v: acc, ty: "number" };
    }
    const fn = MATH_FN1[method];
    if (!fn) throw new Error(`unsupported Math.${method}`);
    const t = this.fresh();
    this.emit(`${t} = call double @${fn}(double ${vals[0]})`);
    return { v: t, ty: "number" };
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
      case "charAt": return { v: call("js_str_char_at", `ptr ${recv.v}, double ${a[0]!.v}`), ty: "string" };
      case "repeat": return { v: call("js_str_repeat", `ptr ${recv.v}, double ${a[0]!.v}`), ty: "string" };
      case "slice": return { v: call("js_str_slice", `ptr ${recv.v}, double ${a[0]!.v}, double ${a[1]?.v ?? POS_INF}`), ty: "string" };
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
        const t = this.fresh();
        this.emit(`${t} = call double @js_str_index_of(ptr ${recv.v}, ptr ${a[0]!.v})`);
        return { v: t, ty: "number" };
      }
      case "split": return { v: call("nt_str_split", `ptr ${recv.v}, ptr ${a[0]!.v}`), ty: "string[]" };
      default: throw new Error(`unsupported string method .${method}`);
    }
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

  private genArrayMethod(method: string, recv: Val, args: Expr[]): Val {
    const el = elemTy(recv.ty);
    const numeric = el === "number";
    switch (method) {
      case "push": {
        const slot = this.toSlot(this.genExpr(args[0]!));
        const t = this.fresh();
        this.emit(`${t} = call double @nt_arr_push(ptr ${recv.v}, i64 ${slot})`);
        return { v: t, ty: "number" };
      }
      case "pop": {
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_arr_pop(ptr ${recv.v})`);
        return { v: this.fromSlot(slot, el), ty: el };
      }
      case "join": {
        const sep = args[0] ? this.genExpr(args[0]).v : this.mod.intern(",");
        const t = this.fresh();
        this.emit(`${t} = call ptr @${numeric ? "nt_arr_join_num" : "nt_arr_join_str"}(ptr ${recv.v}, ptr ${sep})`);
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
      case "indexOf": {
        const x = this.genExpr(args[0]!).v;
        const t = this.fresh();
        if (numeric) this.emit(`${t} = call double @nt_arr_indexof_num(ptr ${recv.v}, double ${x})`);
        else this.emit(`${t} = call double @nt_arr_indexof_str(ptr ${recv.v}, ptr ${x})`);
        return { v: t, ty: "number" };
      }
      case "reverse": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_arr_reverse(ptr ${recv.v})`); return { v: t, ty: recv.ty }; }
      case "slice": {
        const a0 = this.genExpr(args[0]!).v;
        const a1 = args[1] ? this.genExpr(args[1]).v : POS_INF;
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_slice(ptr ${recv.v}, double ${a0}, double ${a1})`);
        return { v: t, ty: recv.ty };
      }
      case "map": return this.genMap(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>);
      case "filter": return this.genFilter(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>);
      case "reduce": return this.genReduce(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>, args[1]!);
      default: throw new Error(`unsupported array method .${method}`);
    }
  }

  /** HOF loop skeleton. `setup(len)` runs in the pre-loop block (create output
   *  arrays etc. exactly once); then the cond/body blocks are set up and entered. */
  private hofLoop(recv: Val, tag: string, setup: (len: string) => void): { idx: string; cond: string; upd: string; end: string; elem: (el: Ty, pName: string) => string } {
    const src = recv.v;
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${src})`);
    setup(len); // pre-loop, runs once
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
    const elem = (el: Ty, pName: string): string => {
      const iB = this.fresh();
      this.emit(`${iB} = load double, ptr ${idx}`);
      const slot = this.fresh();
      this.emit(`${slot} = call i64 @nt_arr_get(ptr ${src}, double ${iB})`);
      const v = this.fromSlot(slot, el);
      this.emit(`store ${llvmTy(el)} ${v}, ptr %${pName}.addr`);
      return v;
    };
    return { idx, cond, upd, end, elem };
  }

  private hofStep(idx: string, upd: string, cond: string): void {
    if (!this.terminated) this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh();
    this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh();
    this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
  }

  private genMap(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    const el = elemTy(recv.ty);
    const R = ((arrow.body as Expr).ty ?? "number") as Ty;
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    let out = "";
    const L = this.hofLoop(recv, "map", (len) => { out = this.fresh(); this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); });
    L.elem(el, p);
    const rv = this.genExpr(arrow.body as Expr);
    this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot(rv)})`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: `${R}[]` as Ty };
  }

  private genFilter(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    let out = "";
    const L = this.hofLoop(recv, "flt", (len) => { out = this.fresh(); this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); });
    const pv = L.elem(el, p);
    const keep = this.genExpr(arrow.body as Expr); // boolean
    const pushLbl = this.label("fltp");
    const skipLbl = this.label("flts");
    this.terminate(`br i1 ${keep.v}, label %${pushLbl}, label %${skipLbl}`);
    this.to(this.block(pushLbl));
    this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot({ v: pv, ty: el })})`);
    this.terminate(`br label %${skipLbl}`);
    this.to(this.block(skipLbl));
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: `${el}[]` as Ty };
  }

  private genReduce(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, initExpr: Expr): Val {
    const el = elemTy(recv.ty);
    const accName = arrow.params[0]!.name;
    const xName = arrow.params[1]!.name;
    const init = this.genExpr(initExpr);
    const A = init.ty;
    this.addLocal(accName, A);
    this.addLocal(xName, el);
    this.emit(`store ${llvmTy(A)} ${init.v}, ptr %${accName}.addr`); // pre-loop init
    const L = this.hofLoop(recv, "red", () => {});
    L.elem(el, xName);
    const rv = this.genExpr(arrow.body as Expr);
    this.emit(`store ${llvmTy(A)} ${rv.v}, ptr %${accName}.addr`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    const t = this.fresh();
    this.emit(`${t} = load ${llvmTy(A)}, ptr %${accName}.addr`);
    return { v: t, ty: A };
  }

  /** JSON.stringify — generated recursively from the static type. */
  private genJsonStringify(val: Val): Val {
    const ty = val.ty;
    if (ty === "number") { const t = this.fresh(); this.emit(`${t} = call ptr @js_num_to_str(double ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "boolean") {
      const z = this.fresh(); this.emit(`${z} = zext i1 ${val.v} to i32`);
      const t = this.fresh(); this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
      return { v: t, ty: "string" };
    }
    if (ty === "string") { const t = this.fresh(); this.emit(`${t} = call ptr @js_json_quote(ptr ${val.v})`); return { v: t, ty: "string" }; }
    if (isArrayTy(ty)) return this.genJsonArray(val);
    if (isObjectTy(ty)) return this.genJsonObject(val);
    return { v: this.mod.intern("null"), ty: "string" };
  }

  private genJsonObject(val: Val): Val {
    let acc = this.mod.intern("{");
    objectFields(val.ty).forEach((f, i) => {
      if (i > 0) acc = this.concat(acc, this.mod.intern(","));
      acc = this.concat(acc, this.mod.intern(`"${f.key}":`));
      const gep = this.fresh();
      this.emit(`${gep} = getelementptr i64, ptr ${val.v}, i64 ${fieldIndex(val.ty, f.key)}`);
      const slot = this.fresh();
      this.emit(`${slot} = load i64, ptr ${gep}`);
      acc = this.concat(acc, this.genJsonStringify({ v: this.fromSlot(slot, f.ty), ty: f.ty }).v);
    });
    acc = this.concat(acc, this.mod.intern("}"));
    return { v: acc, ty: "string" };
  }

  private genJsonArray(val: Val): Val {
    const el = elemTy(val.ty);
    const accSlot = this.slot("string");
    this.emit(`store ptr ${this.mod.intern("[")}, ptr ${accSlot}`);
    const idx = this.slot("number");
    this.emit(`store double 0x0000000000000000, ptr ${idx}`);
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${val.v})`);
    const cond = this.label("js"), body = this.label("jsb"), upd = this.label("jsu"), end = this.label("jse");
    const comma = this.label("jsc"), after = this.label("jsa");
    this.terminate(`br label %${cond}`);
    this.to(this.block(cond));
    const iC = this.fresh(); this.emit(`${iC} = load double, ptr ${idx}`);
    const cmp = this.fresh(); this.emit(`${cmp} = fcmp olt double ${iC}, ${len}`);
    this.terminate(`br i1 ${cmp}, label %${body}, label %${end}`);
    this.to(this.block(body));
    const iB = this.fresh(); this.emit(`${iB} = load double, ptr ${idx}`);
    const first = this.fresh(); this.emit(`${first} = fcmp oeq double ${iB}, 0.0`);
    this.terminate(`br i1 ${first}, label %${after}, label %${comma}`);
    this.to(this.block(comma));
    const a1 = this.fresh(); this.emit(`${a1} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(a1, this.mod.intern(","))}, ptr ${accSlot}`);
    this.terminate(`br label %${after}`);
    this.to(this.block(after));
    const iB2 = this.fresh(); this.emit(`${iB2} = load double, ptr ${idx}`);
    const slot = this.fresh(); this.emit(`${slot} = call i64 @nt_arr_get(ptr ${val.v}, double ${iB2})`);
    const es = this.genJsonStringify({ v: this.fromSlot(slot, el), ty: el });
    const a3 = this.fresh(); this.emit(`${a3} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(a3, es.v)}, ptr ${accSlot}`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    const af = this.fresh(); this.emit(`${af} = load ptr, ptr ${accSlot}`);
    return { v: this.concat(af, this.mod.intern("]")), ty: "string" };
  }

  private genGlobal(name: string, args: Expr[]): Val | null {
    switch (name) {
      case "parseInt": {
        const s = this.genExpr(args[0]!).v;
        const radix = args[1] ? this.genExpr(args[1]).v : llvmDouble(0);
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
      case "move": return this.genExpr(args[0]!); // ownership marker; runtime identity
      case "__arrLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_live()`); return { v: t, ty: "number" }; }
      default: return null;
    }
  }

  private genUserCall(name: string, args: Expr[]): Val {
    const sig = this.mod.functions.get(name)!;
    if (sig.rest) {
      const fixed = sig.params.length - 1;
      const argVals: string[] = [];
      for (let i = 0; i < fixed; i++) argVals.push(`${llvmTy(sig.params[i]!)} ${this.genExpr(args[i]!).v}`);
      const arr = this.fresh(); // pack trailing args into the rest array
      this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(args.length - fixed, 1))})`);
      for (let i = fixed; i < args.length; i++) this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(this.genExpr(args[i]!))})`);
      argVals.push(`ptr ${arr}`);
      const argstr = argVals.join(", ");
      if (sig.ret === "void") { this.emit(`call void @${name}(${argstr})`); return { v: "", ty: "void" }; }
      const t = this.fresh();
      this.emit(`${t} = call ${llvmTy(sig.ret)} @${name}(${argstr})`);
      return { v: t, ty: sig.ret };
    }
    const argVals: string[] = [];
    for (let i = 0; i < sig.params.length; i++) {
      const provided = args[i];
      argVals.push(provided ? this.genExpr(provided).v : this.genExpr(sig.defaults[i]!).v);
    }
    const argstr = argVals.map((v, i) => `${llvmTy(sig.params[i]!)} ${v}`).join(", ");
    if (sig.ret === "void") {
      this.emit(`call void @${name}(${argstr})`);
      return { v: "", ty: "void" };
    }
    const t = this.fresh();
    this.emit(`${t} = call ${llvmTy(sig.ret)} @${name}(${argstr})`);
    return { v: t, ty: sig.ret };
  }
}

export function codegen(checked: CheckedProgram): string {
  return new ModuleGen(checked.functions).build(checked.program);
}
