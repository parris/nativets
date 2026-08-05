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
import { NUMBER_CONSTS } from "./checker.ts";
import { isArrayTy, elemTy, isObjectTy, objectFields, fieldIndex, fieldType, isFuncTy, funcParams, funcRet, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, mapKeyTy, mapValTy, setElemTy, classTag, isBytesTy, isBytesRefTy, isTextEncoderTy, isTextDecoderTy } from "./ast.ts";
import { isOptChainExpr } from "./checker.ts";
import type { ArrowFunction } from "./ast.ts";
import { nyi, NYI } from "./diagnostics.ts";

export function llvmDouble(n: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, n, false);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += dv.getUint8(i).toString(16).padStart(2, "0");
  return "0x" + hex.toUpperCase();
}

const ACTOR_BUILTINS = new Set([
  "spawn", "send", "receive", "self", "__drain",
  // v2 links/monitors/trap + fault injection; v3 supervision + registry
  "register", "whereis", "link", "monitor", "trapExit", "exit", "__crash", "__kill", "supervise",
]);

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

function llvmTy(ty: Ty): string {
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || isBytesRefTy(ty)) return "ptr"; // nullable = ptr to [tag,val]; Map/Set = NtMap*; Uint8Array = NtBytes*
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
  if (isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || isBytesRefTy(ty)) return "null";
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
  // string reference counting (value-semantics strings; rc side-table in the runtime)
  "declare ptr @nt_str_retain(ptr)",
  "declare void @nt_str_release(ptr)",
  "declare double @nt_str_live()",
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
  "declare ptr @nt_arr_copy(ptr)",
  "declare ptr @nt_arr_with(ptr, double, i64)",
  "declare void @nt_arr_free(ptr)",
  "declare double @nt_arr_live()",
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
  "declare double @js_str_last_index_of(ptr, ptr)",
  "declare ptr @nt_str_split_n(ptr, ptr, double)",
  "declare double @nt_arr_at_index(ptr, double)",
  "declare double @nt_arr_last_indexof_num(ptr, double)",
  "declare double @nt_arr_last_indexof_str(ptr, ptr)",
  "declare ptr @nt_arr_concat(ptr, ptr)",
  "declare ptr @nt_arr_flat1(ptr)",
  "declare ptr @js_num_to_fixed(double, double)",
  "declare ptr @js_num_to_radix_string(double, double)",
  // --- stdlib: URL parsing (WHATWG URL functional subset) ---
  "declare ptr @nt_url_protocol(ptr)",
  "declare ptr @nt_url_host(ptr)",
  "declare ptr @nt_url_hostname(ptr)",
  "declare ptr @nt_url_pathname(ptr)",
  "declare ptr @nt_url_search(ptr)",
  "declare ptr @nt_url_hash(ptr)",
  "declare ptr @nt_url_search_param(ptr, ptr)",
  // Networking tier (L-d): libcurl-backed HTTP(S) client (host/Linux only; conditionally linked).
  // Return the response body (rc-string); write the numeric status through the trailing double*.
  "declare ptr @nt_http_post(ptr, ptr, ptr, ptr)",
  "declare ptr @nt_http_get(ptr, ptr, ptr)",
  "declare ptr @nt_arr_slice(ptr, double, double)",
  "declare void @nt_arr_extend(ptr, ptr)",
  "declare ptr @js_json_quote(ptr)",
  "declare ptr @nt_json_parse(ptr)",
  "declare double @nt_dyn_as_number(ptr)",
  "declare i32 @nt_dyn_as_bool(ptr)",
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
  "declare ptr @nt_read_line()",
  "declare ptr @nt_read_stdin()",
  "declare ptr @nt_read_key()",
  "declare void @nt_raw_mode(i32)",
  "declare void @nt_exit(double)",
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
  "declare ptr @nt_map_new()",
  "declare ptr @nt_map_put_slot(ptr, i32, i64, i64)",
  "declare i64 @nt_map_get_slot(ptr, i32, i64)",
  "declare i32 @nt_map_has_slot(ptr, i32, i64)",
  "declare ptr @nt_map_remove_slot(ptr, i32, i64)",
  "declare i64 @nt_map_size(ptr)",
  "declare ptr @nt_set_new()",
  "declare ptr @nt_set_add_slot(ptr, i32, i64)",
  "declare i32 @nt_set_has_slot(ptr, i32, i64)",
  "declare ptr @nt_set_remove_slot(ptr, i32, i64)",
  "declare i64 @nt_set_size(ptr)",
  // --- stdlib batch 2: bytes (Uint8Array + TextEncoder/TextDecoder, nt_bytes.c) ---
  "declare ptr @nt_bytes_new(double)",
  "declare ptr @nt_bytes_from_arr(ptr)",
  "declare double @nt_bytes_get(ptr, double)",
  "declare void @nt_bytes_set(ptr, double, double)",
  "declare double @nt_bytes_len(ptr)",
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
    this.actorEntries.set(key, name);
    // slot(i64) -> param: number is a bit-cast double; heap types are inttoptr.
    const conv = argTy === "number"
      ? `%arg = bitcast i64 %slot to double`
      : `%arg = inttoptr i64 %slot to ptr`;
    this.liftedFns.push(
      [
        `define void @${name}(ptr %env, i64 %slot) {`,
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
    this.usesActors = scanUsesActors(program);
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
      ...(this.usesActors ? ["declare void @nt_reduction_tick()"] : []),
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
  /** Is `name` a user-bound local/param/capture (so a `Foo.bar` isn't a builtin namespace)? */
  private isBound(name: string): boolean { return this.varTypes.has(name) || this.captures.has(name); }
  /** String-typed VarDecl locals in this frame — reference-counted: retained on
   *  bind/alias, released at scope exit. Params are excluded (the caller owns them). */
  private strLocals = new Set<string>();
  /** Active catch targets (a `throw` branches to the innermost). */
  private tryHandlers: { catchLbl: string; excVar: string | null; eType: Ty }[] = [];
  /** Active finally blocks (a `return` inside runs finally first, mode=1). */
  private finallyStack: { finallyLbl: string; modeSlot: string; retSlot: string | null }[] = [];
  /** Active inlined-HOF callbacks (map/filter/reduce with a BLOCK body): a `return`
   *  inside stores the per-element result and branches to the callback's join, rather
   *  than returning from the enclosing function. */
  private hofReturnStack: { slot: string; done: string; ty: Ty }[] = [];
  /** Per-inlining counter: gives each inlined HOF callback a frame-unique name suffix
   *  (see freshenHofArrow) so two sibling callbacks reusing a param/local name — possibly
   *  at DIFFERENT types — each get their own correctly-typed slot instead of colliding in
   *  the flat frame (addLocal keeps the first type → a silent miscompile). */
  private hofSeq = 0;

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

  /** v1 reduction-counted preemption: emit a safepoint (budget tick + maybe-yield)
   *  at loop back-edges and function-call sites. Emitted ONLY in programs that use
   *  actors, so non-actor programs keep byte-identical IR; the runtime tick is itself
   *  a no-op unless a spawned actor is running. */
  private emitSafepoint(): void {
    if (this.mod.usesActors) this.emit(`call void @nt_reduction_tick()`);
  }

  private reset(): void {
    this.entryAllocas = []; this.blocks = []; this.cur = 0; this.tmp = 0; this.lbl = 0;
    this.varTypes = new Map();
    this.loops = [];
    this.captures = new Map();
    this.tryHandlers = [];
    this.finallyStack = [];
    this.hofReturnStack = [];
    this.strLocals = new Set();
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
    for (const n of this.strLocals) this.emit(`store ptr null, ptr %${n}.addr`);
  }
  /** Release owned string locals at scope exit (except one transferred out). */
  private emitStrDrops(exclude?: string): void {
    for (const n of this.strLocals) {
      if (n === exclude) continue;
      const p = this.fresh();
      this.emit(`${p} = load ptr, ptr %${n}.addr`);
      this.emit(`call void @nt_str_release(ptr ${p})`);
    }
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
      // Move-aware RAII: objects free via nt_obj_free, arrays via nt_arr_free.
      const free = isObjectTy(this.varTypes.get(n) ?? "number") ? "nt_obj_free" : "nt_arr_free";
      this.emit(`call void @${free}(ptr ${p})`);
    }
  }

  private addLocal(name: string, ty: Ty): void {
    if (!this.varTypes.has(name)) { this.varTypes.set(name, ty); this.alloca(name, ty); }
  }

  private collectLocals(body: Stmt[]): void {
    for (const s of body) {
      switch (s.kind) {
        case "VarDecl":
          for (const d of s.decls) {
            this.addLocal(d.name, d.ty ?? "number");
            if ((d.ty ?? "number") === "string") this.strLocals.add(d.name);
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
    this.emitStrInit();
    this.genStmts(fn.body);
    if (!this.terminated) {
      this.emitDrops(fn.endDrops ?? []);
      this.emitStrDrops();
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
    // Host I/O: stash argc/argv into runtime globals so process.argv can read them.
    this.emit(`call void @nt_init_args(i32 %argc, ptr %argv)`);
    // Bring up the v0 actor scheduler + actor 0 (main) before any actor call.
    if (this.mod.usesActors) this.emit(`call void @nt_sched_init()`);
    this.emitStrInit();
    this.genStmts(body);
    if (!this.terminated) { this.emitDrops(endDrops); this.emitStrDrops(); this.terminate("ret i32 0"); }
    return this.assemble("define i32 @main(i32 %argc, ptr %argv)", b0);
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
    this.emitStrInit();
    if (arrow.exprBody) {
      const bodyVal = this.genExpr(arrow.body as Expr);
      this.terminate(`ret ${llvmTy(this.retTy)} ${bodyVal.v}`);
    } else {
      this.genStmts(arrow.body as Stmt[]);
      if (!this.terminated) { this.emitStrDrops(); this.terminate(this.retTy === "void" ? "ret void" : `ret ${llvmTy(this.retTy)} ${defaultZero(this.retTy)}`); }
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
          const ty = d.ty ?? "number";
          const val = this.coerce(this.genExpr(d.init), ty);
          // RC: an aliased string (identifier/field/index/literal) gains a new owner
          // → retain. A fresh producer is consumed (its rc=1 transfers to this local).
          if (ty === "string" && this.strLocals.has(d.name)) this.retainStrBind(d.init, val.v);
          this.emit(`store ${llvmTy(ty)} ${val.v}, ptr %${d.name}.addr`);
        }
        return;
      }
      case "ExprStmt": this.genExpr(s.expr); return;
      case "ReturnStmt": {
        // Inside an inlined HOF block callback: a `return` yields the per-element
        // result — store it and branch to the callback's join (not a function ret).
        if (this.hofReturnStack.length > 0 && this.finallyStack.length === 0) {
          const h = this.hofReturnStack[this.hofReturnStack.length - 1]!;
          const v = s.argument ? this.coerce(this.genExpr(s.argument), h.ty) : { v: defaultZero(h.ty), ty: h.ty };
          this.emit(`store ${llvmTy(h.ty)} ${v.v}, ptr ${h.slot}`);
          this.terminate(`br label %${h.done}`);
          return;
        }
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
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
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
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
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
        this.emitSafepoint(); // back-edge: preempt on budget exhaustion
        const cond = this.genCond(s.test);
        this.terminate(`br i1 ${cond}, label %${bodyLbl}, label %${endLbl}`);
        this.to(this.block(endLbl));
        return;
      }
      case "ForOfStmt": {
        const src = this.genExpr(s.iterable);
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
          this.emit(`store ptr ${ch}, ptr %${s.name}.addr`);
        } else if (isBytes) {
          const by = this.fresh();
          this.emit(`${by} = call double @nt_bytes_get(ptr ${src.v}, double ${iB})`);
          this.emit(`store double ${by}, ptr %${s.name}.addr`);
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
    return this.truthyOf(this.genExpr(e));
  }

  /** i1 truthiness of an already-evaluated value (JS ToBoolean for the supported types). */
  private truthyOf(val: Val): string {
    if (val.ty === "boolean") return val.v;
    if (val.ty === "number") {
      const t = this.fresh();
      this.emit(`${t} = fcmp one double ${val.v}, 0.0`); // NaN and 0 are falsy
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
    // RC: a string packed into a heap slot (array element, object field, closure
    // capture, map entry, nullable box) gains a persistent owner → retain. These
    // slot owners are never released (arrays/objects don't reclaim their string
    // elements), so this is a conservative, leak-safe over-retain that guarantees a
    // slot never holds a dangling pointer after a local owner is dropped.
    if (val.ty === "string") this.emit(`%rc${this.tmp++} = call ptr @nt_str_retain(ptr ${val.v})`);
    const t = this.fresh();
    if (val.ty === "number") this.emit(`${t} = bitcast double ${val.v} to i64`);
    else if (val.ty === "string" || isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty) || isNullableTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) || isBytesRefTy(val.ty)) this.emit(`${t} = ptrtoint ptr ${val.v} to i64`);
    else if (val.ty === "boolean") this.emit(`${t} = zext i1 ${val.v} to i64`);
    else this.emit(`${t} = zext i8 ${val.v} to i64`);
    return t;
  }
  /** Unpack a 64-bit slot into a value of the given type. */
  private fromSlot(slot: string, ty: Ty): string {
    const t = this.fresh();
    if (ty === "number") this.emit(`${t} = bitcast i64 ${slot} to double`);
    else if (ty === "string" || isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || isBytesRefTy(ty)) this.emit(`${t} = inttoptr i64 ${slot} to ptr`);
    else if (ty === "boolean") this.emit(`${t} = trunc i64 ${slot} to i1`);
    else this.emit(`${t} = trunc i64 ${slot} to i8`);
    return t;
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
    return val;
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
        if (obj.ty === "string") {
          const t = this.fresh();
          this.emit(`${t} = call ptr @js_str_char_at(ptr ${obj.v}, double ${idx.v})`);
          return { v: t, ty: "string" };
        }
        if (isBytesTy(obj.ty)) {
          const t = this.fresh();
          this.emit(`${t} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
          return { v: t, ty: "number" };
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
        const written = new Set<string>();
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
              written.add(f.key);
            }
          } else {
            const ft = fieldType(ty, p.key) ?? (p.value.ty as Ty);
            const slot = this.toSlot(this.coerce(this.genExpr(p.value), ft)); // box into a nullable field
            const g = this.fresh();
            this.emit(`${g} = getelementptr i64, ptr ${obj}, i64 ${fieldIndex(ty, p.key)}`);
            this.emit(`store i64 ${slot}, ptr ${g}`);
            written.add(p.key);
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
        // stdlib Batch 1: `Number.*` numeric constants — folded to their exact IEEE-754 value.
        if (e.object.kind === "Identifier" && e.object.name === "Number" && !this.isBound("Number")) {
          const c = NUMBER_CONSTS[e.property];
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
        if (isNullableTy(e.ty ?? "") && isOptChainExpr(e)) return this.genOptChain(e);
        const obj = this.genExpr(e.object);
        if (obj.ty === "Dyn") { // dynamic field access: nt_dyn_get_field returns a Dyn
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_dyn_get_field(ptr ${obj.v}, ptr ${this.mod.intern(e.property)})`);
          return { v: t, ty: "Dyn" };
        }
        if (e.property === "length" && (obj.ty === "string" || isArrayTy(obj.ty) || isBytesTy(obj.ty))) {
          const t = this.fresh();
          if (obj.ty === "string") this.emit(`${t} = call double @js_str_len(ptr ${obj.v})`);
          else if (isBytesTy(obj.ty)) this.emit(`${t} = call double @nt_bytes_len(ptr ${obj.v})`);
          else this.emit(`${t} = call double @nt_arr_len(ptr ${obj.v})`);
          return { v: t, ty: "number" };
        }
        if ((isMapTy(obj.ty) || isSetTy(obj.ty)) && e.property === "size") {
          const sz = this.fresh();
          this.emit(`${sz} = call i64 @${isMapTy(obj.ty) ? "nt_map_size" : "nt_set_size"}(ptr ${obj.v})`);
          const d = this.fresh();
          this.emit(`${d} = sitofp i64 ${sz} to double`);
          return { v: d, ty: "number" };
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
        // A runtime-nullable value's typeof depends on its tag: undefined→"undefined",
        // null→"object", present→typeof(base). Branch at runtime.
        if (isNullableTy(inner)) return this.genTypeofNullable(this.genExpr(e.operand).v, baseTy(inner));
        const name =
          inner === "undefined" || inner === "void" ? "undefined" :
          inner === "null" ? "object" :
          isFuncTy(inner) ? "function" :
          isObjectTy(inner) || isArrayTy(inner) ? "object" :
          inner; // number | boolean | string
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
          } else if (isArrayTy(lt) || isObjectTy(lt)) {
            // Heap reference identity: arrays/objects compare by pointer (as node
            // does for `===`), so a CoW copy is `!==` its source. NOT strcmp.
            this.emit(`${t} = icmp ${op === "===" || op === "==" ? "eq" : "ne"} ptr ${l.v}, ${r.v}`);
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
          const lt = e.left.ty ?? "number";
          if (lt === "null" || lt === "undefined") return this.genExpr(e.right); // statically nullish → right
          if (!isNullableTy(lt)) return this.genExpr(e.left);                     // statically present → left
          // runtime-nullable left: TAG-based branch (never truthiness), collapse to base.
          const base = baseTy(lt);
          const box = this.genExpr(e.left);
          const slot = this.slot(base);
          const isN = this.isNullish(box.v);
          const rLbl = this.label("nc"), lLbl = this.label("ncl"), endLbl = this.label("nce");
          this.terminate(`br i1 ${isN}, label %${rLbl}, label %${lLbl}`);
          this.to(this.block(rLbl));
          const rv = this.genExpr(e.right);
          this.emit(`store ${llvmTy(base)} ${rv.v}, ptr ${slot}`);
          this.terminate(`br label %${endLbl}`);
          this.to(this.block(lLbl));
          const lv = this.fromSlot(this.nullVal(box.v), base); // unbox the present value
          this.emit(`store ${llvmTy(base)} ${lv}, ptr ${slot}`);
          this.terminate(`br label %${endLbl}`);
          this.to(this.block(endLbl));
          const t = this.fresh();
          this.emit(`${t} = load ${llvmTy(base)}, ptr ${slot}`);
          return { v: t, ty: base };
        }
        // `&&` / `||` — value-returning short-circuit (result type = operand type).
        const ty = (e.ty ?? "boolean") as Ty;
        const slot = this.slot(ty);
        const l = this.genExpr(e.left);
        this.emit(`store ${llvmTy(ty)} ${l.v}, ptr ${slot}`);
        const cond = this.truthyOf(l);
        const evalLbl = this.label("rhs");
        const endLbl = this.label("logend");
        if (e.op === "&&") this.terminate(`br i1 ${cond}, label %${evalLbl}, label %${endLbl}`);
        else this.terminate(`br i1 ${cond}, label %${endLbl}, label %${evalLbl}`);
        this.to(this.block(evalLbl));
        const r = this.genExpr(e.right);
        this.emit(`store ${llvmTy(ty)} ${r.v}, ptr ${slot}`);
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
          const val = this.coerce(this.genExpr(e.value), ty); // box into a nullable slot if needed
          // RC: reassigning a string local. Retain an aliased borrow so the new value
          // outlives the assignment (safe if it escapes); the previous value is left
          // to leak (a conservative over-retention) rather than risk a premature free.
          if (ty === "string" && this.strLocals.has(e.target)) this.retainStrBind(e.value, val.v);
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
      case "IndexAssign": {
        // Element write `u[i] = v` (+ compound) — only Uint8Array reaches codegen (the
        // checker rejects immutable array/object index-assign with NT1606). The store
        // clamps/wraps to a byte in the runtime (JS ToUint8). Evaluate obj + index once.
        const obj = this.genExpr(e.object);
        const idx = this.genExpr(e.index);
        let out: string;
        if (e.op === "=") {
          out = this.genExpr(e.value).v;
        } else {
          const cur = this.fresh();
          this.emit(`${cur} = call double @nt_bytes_get(ptr ${obj.v}, double ${idx.v})`);
          const rv = this.genExpr(e.value);
          const bare = e.op.slice(0, -1); // "+", "&", "<<", ...
          out = this.fresh();
          if (bare in ARITH) this.emit(`${out} = ${ARITH[bare]} double ${cur}, ${rv.v}`);
          else this.emit(`${out} = call double @${BITFN[bare]}(double ${cur}, double ${rv.v})`);
        }
        this.emit(`call void @nt_bytes_set(ptr ${obj.v}, double ${idx.v}, double ${out})`);
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
        if (e.callee === "Map") { const m = this.fresh(); this.emit(`${m} = call ptr @nt_map_new()`); return { v: m, ty: e.ty! }; }
        if (e.callee === "Set") { const s = this.fresh(); this.emit(`${s} = call ptr @nt_set_new()`); return { v: s, ty: e.ty! }; }
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
        // `new C(args)` on a user class: allocate the field slot block, then run the
        // constructor (`C.constructor(this, …args)`), and hand back the instance ptr.
        const cls = classTag(e.ty ?? "");
        if (cls) {
          const objTy = e.ty!;
          const nfields = objectFields(objTy).length;
          const obj = this.fresh();
          this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(nfields, 1))})`);
          const csig = this.mod.functions.get(`${cls}.constructor`)!;
          const argVals: string[] = [`ptr ${obj}`];
          for (let i = 1; i < csig.params.length; i++) {
            const provided = e.args[i - 1];
            const v = provided ? this.genExpr(provided) : this.genExpr(csig.defaults[i]!);
            argVals.push(`${llvmTy(csig.params[i]!)} ${this.coerce(v, csig.params[i]!).v}`);
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
    if (isConsoleLog(e)) return this.genConsoleLog(e.args);

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
      return this.genJsonStringify(this.genExpr(e.args[0]!), this.jsonIndentUnit(e.args[2]), 0);
    }

    // Object.keys(o) / Object.values(o) — keys are compile-time known from o's type.
    if (e.callee.kind === "MemberExpr" && e.callee.object.kind === "Identifier" && e.callee.object.name === "Object" && !this.isBound("Object")) {
      if (e.callee.property === "fromEntries") {
        // Literal entries (checker-verified): build the object block slot by slot.
        const pairs = (e.args[0] as { elements: Expr[] }).elements;
        const obj = this.fresh();
        this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(pairs.length)})`);
        pairs.forEach((pair, i) => {
          const v = this.genExpr((pair as { elements: Expr[] }).elements[1]!);
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj}, i64 ${i}`);
          this.emit(`store i64 ${this.toSlot(v)}, ptr ${gep}`);
        });
        return { v: obj, ty: e.ty ?? "number" };
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
        return { v: arr, ty: "string[][]" };
      }
      if (e.callee.property === "keys") return this.buildStringArray(objectFields(o.ty).map((f) => f.key));
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
      return { v: arr, ty: `${fields[0]!.ty}[]` as Ty };
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
          this.genExpr(e.args[0]!); // evaluate for side effects
          return { v: isArrayTy(at) ? "true" : "false", ty: "boolean" };
        }
        if (p === "from") {
          const src = this.genExpr(e.args[0]!);
          const t = this.fresh();
          if (isArrayTy(src.ty)) { // shallow copy (node-compatible; also keeps single-ownership)
            this.emit(`${t} = call ptr @nt_arr_copy(ptr ${src.v})`);
            return { v: t, ty: src.ty };
          }
          this.emit(`${t} = call ptr @nt_arr_from_str(ptr ${src.v})`);
          return { v: t, ty: "string[]" };
        }
        if (p === "of") { // Array.of(...items) — build the array directly
          const vals = e.args.map((x) => this.genExpr(x));
          const arr = this.fresh();
          this.emit(`${arr} = call ptr @nt_arr_new(double ${llvmDouble(Math.max(vals.length, 1))})`);
          for (const v of vals) this.emit(`call double @nt_arr_push(ptr ${arr}, i64 ${this.toSlot(v)})`);
          return { v: arr, ty: `${vals[0]!.ty}[]` as Ty };
        }
      }
    }
    // stdlib Batch 1: structuredClone(v) — the type-directed deep copy.
    if (e.callee.kind === "Identifier" && e.callee.name === "structuredClone" && !this.isBound("structuredClone")) {
      return this.genDeepClone(this.genExpr(e.args[0]!));
    }
    // class instance method call: `inst.m(args)` → `C.m(inst, …args)` (the lowered fn).
    if (e.callee.kind === "MemberExpr") {
      const cls = classTag(e.callee.object.ty ?? "");
      if (cls && this.mod.functions.has(`${cls}.${e.callee.property}`)) {
        return this.genUserCall(`${cls}.${e.callee.property}`, [e.callee.object, ...e.args]);
      }
    }
    if (e.callee.kind === "MemberExpr") {
      const recv = this.genExpr(e.callee.object);
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
    this.emitSafepoint(); // call site: preempt long / deeply-recursive call chains
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
      this.emitPrint(val);
    });
    this.emit(`call void @js_print_newline()`);
    return { v: "0", ty: "void" };
  }

  /** Print one value per its static type (used by console.log, incl. nullable unbox). */
  private emitPrint(val: Val): void {
    if (val.ty === "number") { this.emit(`call void @js_print_num(double ${val.v})`); return; }
    if (val.ty === "boolean") {
      const z = this.fresh();
      this.emit(`${z} = zext i1 ${val.v} to i32`);
      this.emit(`call void @js_print_bool(i32 ${z})`);
      return;
    }
    if (val.ty === "undefined" || val.ty === "void") { this.emit(`call void @js_print_str(ptr ${this.mod.intern("undefined")})`); return; }
    if (val.ty === "null") { this.emit(`call void @js_print_str(ptr ${this.mod.intern("null")})`); return; }
    if (val.ty === "Dyn") { this.emit(`call void @nt_dyn_print(ptr ${val.v})`); return; }
    if (isNullableTy(val.ty)) { this.emitPrintNullable(val.v, baseTy(val.ty)); return; }
    this.emit(`call void @js_print_str(ptr ${val.v})`);
  }

  /** Print a nullable box: tag 0 → `undefined`, 1 → `null`, else unbox and print the base value. */
  private emitPrintNullable(ptr: string, base: Ty): void {
    const tag = this.nullTag(ptr);
    const isU = this.fresh(); this.emit(`${isU} = icmp eq i64 ${tag}, 0`);
    const uLbl = this.label("pu"), nChk = this.label("pnc"), nLbl = this.label("pn"), pLbl = this.label("pp"), end = this.label("pe");
    this.terminate(`br i1 ${isU}, label %${uLbl}, label %${nChk}`);
    this.to(this.block(uLbl)); this.emit(`call void @js_print_str(ptr ${this.mod.intern("undefined")})`); this.terminate(`br label %${end}`);
    this.to(this.block(nChk));
    const isN = this.fresh(); this.emit(`${isN} = icmp eq i64 ${tag}, 1`);
    this.terminate(`br i1 ${isN}, label %${nLbl}, label %${pLbl}`);
    this.to(this.block(nLbl)); this.emit(`call void @js_print_str(ptr ${this.mod.intern("null")})`); this.terminate(`br label %${end}`);
    this.to(this.block(pLbl)); this.emitPrint({ v: this.fromSlot(this.nullVal(ptr), base), ty: base }); this.terminate(`br label %${end}`);
    this.to(this.block(end));
  }

  /** Runtime typeof of a nullable box: tag 0→"undefined", 1→"object" (null), else typeof(base). */
  private genTypeofNullable(ptr: string, base: Ty): Val {
    const baseName = base === "undefined" || base === "void" ? "undefined" : isFuncTy(base) ? "function" : isObjectTy(base) || isArrayTy(base) ? "object" : base;
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

  /** Read `.prop` from a NON-nullable object/string/array value (object slot, or `.length`). */
  private genFieldRead(obj: Val, prop: string): Val {
    if (prop === "length" && (obj.ty === "string" || isArrayTy(obj.ty) || isBytesTy(obj.ty))) {
      const t = this.fresh();
      if (obj.ty === "string") this.emit(`${t} = call double @js_str_len(ptr ${obj.v})`);
      else if (isBytesTy(obj.ty)) this.emit(`${t} = call double @nt_bytes_len(ptr ${obj.v})`);
      else this.emit(`${t} = call double @nt_arr_len(ptr ${obj.v})`);
      return { v: t, ty: "number" };
    }
    const ft = fieldType(obj.ty, prop)!;
    const gep = this.fresh();
    this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, prop)}`);
    const slot = this.fresh();
    this.emit(`${slot} = load i64, ptr ${gep}`);
    return { v: this.fromSlot(slot, ft), ty: ft };
  }

  /**
   * Lower an optional chain to a single unit. Flatten `head .m1 .m2 …` into ordered
   * links; walk them, and at every step where the current value is nullable, guard:
   * if nullish, branch to a SHARED `undefined`-result join (short-circuiting the rest
   * of the chain — no trailing member is evaluated); otherwise unbox and read on.
   * The result is always a nullable box (tag 0 on any short-circuit, else present).
   */
  private genOptChain(e: Extract<Expr, { kind: "MemberExpr" }>): Val {
    const links: { prop: string }[] = [];
    let node: Expr = e;
    while (node.kind === "MemberExpr") { links.unshift({ prop: node.property }); node = node.object; }
    const resultSlot = this.slot(e.ty!); // holds the resulting nullable box (ptr)
    const nullJoin = this.label("ocnull");
    const endLbl = this.label("ocend");
    let cur = this.genExpr(node); // chain head
    for (const link of links) {
      if (isNullableTy(cur.ty)) {
        const isN = this.isNullish(cur.v);
        const contLbl = this.label("occ");
        this.terminate(`br i1 ${isN}, label %${nullJoin}, label %${contLbl}`);
        this.to(this.block(contLbl));
        const base = baseTy(cur.ty);
        cur = { v: this.fromSlot(this.nullVal(cur.v), base), ty: base }; // unbox the present value
      }
      cur = this.genFieldRead(cur, link.prop);
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
        this.emit(`${t} = call double @js_str_last_index_of(ptr ${recv.v}, ptr ${a[0]!.v})`);
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
      default: throw new Error(`unsupported string method .${method}`);
    }
  }

  /** structuredClone: a deep copy generated from the STATIC type (the same
   *  type-directed walk shape as JSON.stringify). Scalars/strings are values and
   *  pass through; an object becomes a fresh slot block with each field cloned;
   *  an array becomes a fresh vector with each element cloned in a loop. */
  private genDeepClone(v: Val): Val {
    const ty = v.ty;
    if (isObjectTy(ty)) {
      const fields = objectFields(ty);
      const obj = this.fresh();
      this.emit(`${obj} = call ptr @nt_obj_new(double ${llvmDouble(Math.max(fields.length, 1))})`);
      fields.forEach((f, i) => {
        const gep = this.fresh();
        this.emit(`${gep} = getelementptr i64, ptr ${v.v}, i64 ${i}`);
        const slot = this.fresh();
        this.emit(`${slot} = load i64, ptr ${gep}`);
        const cloned = this.genDeepClone({ v: this.fromSlot(slot, f.ty), ty: f.ty });
        const dst = this.fresh();
        this.emit(`${dst} = getelementptr i64, ptr ${obj}, i64 ${i}`);
        this.emit(`store i64 ${this.toSlot(cloned)}, ptr ${dst}`);
      });
      return { v: obj, ty };
    }
    if (isArrayTy(ty)) {
      const el = elemTy(ty);
      // A scalar element array is a flat block — one runtime copy is already deep.
      if (!isObjectTy(el) && !isArrayTy(el)) {
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
      const cloned = this.genDeepClone({ v: this.fromSlot(slot, el), ty: el });
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
  private genMapMethod(method: string, recv: Val, args: Expr[]): Val {
    const k = mapKeyTy(recv.ty), v = mapValTy(recv.ty);
    const tag = this.keyTag(k);
    const keySlot = () => this.toSlot(this.genExpr(args[0]!)); // arg[0] typed as k
    switch (method) {
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
      // --- stdlib Batch 1 (part 2): array fills ---
      case "lastIndexOf": {
        const x = this.genExpr(args[0]!).v;
        const t = this.fresh();
        this.emit(`${t} = call double @${numeric ? "nt_arr_last_indexof_num" : "nt_arr_last_indexof_str"}(ptr ${recv.v}, ${numeric ? "double" : "ptr"} ${x})`);
        return { v: t, ty: "number" };
      }
      case "concat": { // variadic: fold each argument array onto a fresh copy
        let acc = recv.v;
        for (const arg of args) {
          const b = this.genExpr(arg).v;
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_arr_concat(ptr ${acc}, ptr ${b})`);
          acc = t;
        }
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
        const idx = this.genExpr(args[0]!).v;
        const slot = this.toSlot(this.genExpr(args[1]!));
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_with(ptr ${recv.v}, double ${idx}, i64 ${slot})`);
        return { v: t, ty: recv.ty };
      }
      case "slice": {
        const a0 = this.genExpr(args[0]!).v;
        const a1 = args[1] ? this.genExpr(args[1]).v : POS_INF;
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_slice(ptr ${recv.v}, double ${a0}, double ${a1})`);
        return { v: t, ty: recv.ty };
      }
      case "flat": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_arr_flat1(ptr ${recv.v})`); return { v: t, ty: el }; }
      case "flatMap": return this.genFlatMap(recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>);
      case "some": case "every": case "find": case "findIndex": case "findLast": case "findLastIndex":
        return this.genSearchHof(method, recv, args[0] as Extract<Expr, { kind: "ArrowFunction" }>);
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

  /** Element type produced by an inlined HOF callback — its `retTy` (recorded by the
   *  checker for both expression and block bodies). */
  private hofRetTy(arrow: Extract<Expr, { kind: "ArrowFunction" }>): Ty {
    return (arrow.retTy ?? (arrow.exprBody ? (arrow.body as Expr).ty : "number") ?? "number") as Ty;
  }

  /** Collect the names an arrow's block body BINDS in the flat frame (params handled by
   *  the caller) — VarDecls, for-loop/for-of/for-in vars, catch params — WITHOUT descending
   *  into nested arrows (those are their own binders). Mirrors collectLocals's shape. */
  private collectBoundNames(body: Stmt[], out: Set<string>): void {
    for (const s of body) {
      switch (s.kind) {
        case "VarDecl": for (const d of s.decls) out.add(d.name); break;
        case "IfStmt": this.collectBoundNames(s.consequent, out); if (s.alternate) this.collectBoundNames(s.alternate, out); break;
        case "WhileStmt": case "DoWhileStmt": this.collectBoundNames(s.body, out); break;
        case "ForStmt":
          if (s.init && (s.init as VarDecl).kind === "VarDecl") for (const d of (s.init as VarDecl).decls) out.add(d.name);
          this.collectBoundNames(s.body, out); break;
        case "ForOfStmt": out.add(s.name); this.collectBoundNames(s.body, out); break;
        case "ForInStmt": out.add(s.name); this.collectBoundNames(s.body, out); break;
        case "SwitchStmt": for (const c of s.cases) this.collectBoundNames(c.body, out); break;
        case "BlockStmt": this.collectBoundNames(s.body, out); break;
        case "MultiStmt": this.collectBoundNames(s.stmts, out); break;
        case "TryStmt":
          if (s.param) out.add(s.param);
          this.collectBoundNames(s.block, out);
          if (s.handler) this.collectBoundNames(s.handler, out);
          if (s.finalizer) this.collectBoundNames(s.finalizer, out); break;
        default: break;
      }
    }
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
    const bound = new Set<string>();
    for (const p of arrow.params) bound.add(p.name);
    if (!arrow.exprBody) this.collectBoundNames(arrow.body as Stmt[], bound);
    if (bound.size === 0) return;
    const map = new Map<string, string>();
    for (const n of bound) map.set(n, n + suffix);
    for (const p of arrow.params) { if (p.default) this.subExpr(p.default, map); p.name = map.get(p.name)!; }
    if (arrow.exprBody) this.subExpr(arrow.body as Expr, map);
    else this.subStmts(arrow.body as Stmt[], map);
  }

  /** The names a nested arrow/function binds — remove from the active rename map for its
   *  subtree so an inner re-binding (shadow) isn't rewritten to the outer's fresh name. */
  private childRenameMap(params: { name: string }[], body: Expr | Stmt[], exprBody: boolean, map: Map<string, string>): Map<string, string> {
    const shadow = new Set<string>();
    for (const p of params) shadow.add(p.name);
    if (!exprBody) this.collectBoundNames(body as Stmt[], shadow);
    const child = new Map(map);
    for (const n of shadow) child.delete(n);
    return child;
  }

  private subStmts(stmts: Stmt[], map: Map<string, string>): void {
    for (const s of stmts) this.subStmt(s, map);
  }

  private subStmt(s: Stmt, map: Map<string, string>): void {
    switch (s.kind) {
      case "VarDecl": for (const d of s.decls) { this.subExpr(d.init, map); if (map.has(d.name)) d.name = map.get(d.name)!; } break;
      case "ReturnStmt": if (s.argument) this.subExpr(s.argument, map); break;
      case "IfStmt": this.subExpr(s.test, map); this.subStmts(s.consequent, map); if (s.alternate) this.subStmts(s.alternate, map); break;
      case "WhileStmt": this.subExpr(s.test, map); this.subStmts(s.body, map); break;
      case "DoWhileStmt": this.subStmts(s.body, map); this.subExpr(s.test, map); break;
      case "ForStmt":
        if (s.init) { if ((s.init as VarDecl).kind === "VarDecl") this.subStmt(s.init as VarDecl, map); else this.subExpr(s.init as Expr, map); }
        if (s.test) this.subExpr(s.test, map);
        if (s.update) this.subExpr(s.update, map);
        this.subStmts(s.body, map); break;
      case "ForOfStmt": this.subExpr(s.iterable, map); if (map.has(s.name)) s.name = map.get(s.name)!; this.subStmts(s.body, map); break;
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
        const child = this.childRenameMap(s.params, s.body, false, map);
        for (const p of s.params) if (p.default) this.subExpr(p.default, child);
        this.subStmts(s.body, child); break;
      }
      default: break; // BreakStmt / ContinueStmt
    }
  }

  private subExpr(e: Expr, map: Map<string, string>): void {
    switch (e.kind) {
      case "Identifier": if (map.has(e.name)) e.name = map.get(e.name)!; return;
      case "UpdateExpr": if (map.has(e.target)) e.target = map.get(e.target)!; return;
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
      case "AsExpr": this.subExpr(e.expr, map); return;
      case "ArrowFunction": {
        const child = this.childRenameMap(e.params, e.body, e.exprBody, map);
        for (const p of e.params) if (p.default) this.subExpr(p.default, child);
        if (e.exprBody) this.subExpr(e.body as Expr, child);
        else this.subStmts(e.body as Stmt[], child);
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
    this.collectLocals(arrow.body as Stmt[]);
    for (const n of this.strLocals) if (!before.has(n)) this.emit(`store ptr null, ptr %${n}.addr`);
  }

  /** Emit an inlined HOF callback body and yield its result Val (type `retTy`). An
   *  expression body evaluates directly; a BLOCK body runs its statements — a `return`
   *  inside stores to a result slot (via hofReturnStack) and branches to the join. */
  private genHofBody(arrow: Extract<Expr, { kind: "ArrowFunction" }>, retTy: Ty): Val {
    if (arrow.exprBody) return this.genExpr(arrow.body as Expr);
    const slot = this.slot(retTy);
    const done = this.label("hofr");
    this.hofReturnStack.push({ slot, done, ty: retTy });
    this.genStmts(arrow.body as Stmt[]);
    this.hofReturnStack.pop();
    if (!this.terminated) this.terminate(`br label %${done}`); // fall-through (no return hit)
    this.to(this.block(done));
    const v = this.fresh();
    this.emit(`${v} = load ${llvmTy(retTy)}, ptr ${slot}`);
    return { v, ty: retTy };
  }

  private genMap(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const R = this.hofRetTy(arrow);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    this.prepHofLocals(arrow);
    let out = "";
    const L = this.hofLoop(recv, "map", (len) => { out = this.fresh(); this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); });
    L.elem(el, p);
    const rv = this.genHofBody(arrow, R);
    this.emit(`call double @nt_arr_push(ptr ${out}, i64 ${this.toSlot(rv)})`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: `${R}[]` as Ty };
  }

  /** flatMap — map's loop, but each callback result (an array) is CONCATENATED
   *  into the output instead of pushed, i.e. exactly one level of flattening. */
  private genFlatMap(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    this.freshenHofArrow(arrow);
    const el = elemTy(recv.ty);
    const R = this.hofRetTy(arrow); // an array type (checker-enforced)
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    this.prepHofLocals(arrow);
    let out = "";
    const L = this.hofLoop(recv, "fmap", () => { out = this.fresh(); this.emit(`${out} = call ptr @nt_arr_new(double 1.0)`); });
    L.elem(el, p);
    const rv = this.genHofBody(arrow, R);
    this.emit(`call void @nt_arr_extend(ptr ${out}, ptr ${rv.v})`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    return { v: out, ty: R };
  }

  private genFilter(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    this.addLocal(p, el);
    this.prepHofLocals(arrow);
    let out = "";
    const L = this.hofLoop(recv, "flt", (len) => { out = this.fresh(); this.emit(`${out} = call ptr @nt_arr_new(double ${len})`); });
    const pv = L.elem(el, p);
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
    return { v: out, ty: `${el}[]` as Ty };
  }

  /** some/every/find/findIndex/findLast/findLastIndex — ONE inlined predicate loop.
   *  Forward with early exit for some/every/find/findIndex (node's iteration order);
   *  `findLast`/`findLastIndex` iterate BACKWARDS, also node's order, so a callback
   *  with side effects still observes the same sequence. The hit index lives in a
   *  slot; `.find*` then boxes it as `T | undefined`. */
  private genSearchHof(method: string, recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>): Val {
    this.freshenHofArrow(arrow);
    const el = elemTy(recv.ty);
    const p = arrow.params[0]!.name;
    const backwards = method === "findLast" || method === "findLastIndex";
    this.addLocal(p, el);
    this.prepHofLocals(arrow);

    const src = recv.v;
    const len = this.fresh();
    this.emit(`${len} = call double @nt_arr_len(ptr ${src})`);
    const hit = this.slot("number"); // index of the first (last) match, -1 = none
    this.emit(`store double 0xBFF0000000000000, ptr ${hit}`); // -1
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
    this.emit(`${slot} = call i64 @nt_arr_get(ptr ${src}, double ${iB})`);
    this.emit(`store ${llvmTy(el)} ${this.fromSlot(slot, el)}, ptr %${p}.addr`);
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
    this.emit(`${es} = call i64 @nt_arr_get(ptr ${src}, double ${h})`);
    const miss = this.fresh();
    this.emit(`${miss} = xor i1 ${found}, true`);
    return { v: this.nullBox(this.nullTagIf(miss), es), ty: makeNullable("undefined", el) };
  }

  private genReduce(recv: Val, arrow: Extract<Expr, { kind: "ArrowFunction" }>, initExpr: Expr): Val {
    this.freshenHofArrow(arrow); // unique per-inlining slots — no cross-callback name collision
    const el = elemTy(recv.ty);
    const accName = arrow.params[0]!.name;
    const xName = arrow.params[1]!.name;
    const init = this.genExpr(initExpr);
    const A = init.ty;
    this.addLocal(accName, A);
    this.addLocal(xName, el);
    this.emit(`store ${llvmTy(A)} ${init.v}, ptr %${accName}.addr`); // pre-loop init
    this.prepHofLocals(arrow);
    const L = this.hofLoop(recv, "red", () => {});
    L.elem(el, xName);
    const rv = this.genHofBody(arrow, A);
    this.emit(`store ${llvmTy(A)} ${rv.v}, ptr %${accName}.addr`);
    this.hofStep(L.idx, L.upd, L.cond);
    this.to(this.block(L.end));
    const t = this.fresh();
    this.emit(`${t} = load ${llvmTy(A)}, ptr %${accName}.addr`);
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
    if (ty === "number") { const t = this.fresh(); this.emit(`${t} = call ptr @js_num_to_str(double ${val.v})`); return { v: t, ty: "string" }; }
    if (ty === "boolean") {
      const z = this.fresh(); this.emit(`${z} = zext i1 ${val.v} to i32`);
      const t = this.fresh(); this.emit(`${t} = call ptr @js_bool_to_str(i32 ${z})`);
      return { v: t, ty: "string" };
    }
    if (ty === "string") { const t = this.fresh(); this.emit(`${t} = call ptr @js_json_quote(ptr ${val.v})`); return { v: t, ty: "string" }; }
    if (isArrayTy(ty)) return this.genJsonArray(val, indent, depth);
    if (isObjectTy(ty)) return this.genJsonObject(val, indent, depth);
    return { v: this.mod.intern("null"), ty: "string" };
  }

  private genJsonObject(val: Val, indent = "", depth = 0): Val {
    const fields = objectFields(val.ty);
    const pretty = indent !== "";
    // node prints an empty object inline as `{}` even with an indent.
    if (fields.length === 0) return { v: this.mod.intern("{}"), ty: "string" };
    const inner = pretty ? indent.repeat(depth + 1) : "";
    const close = pretty ? indent.repeat(depth) : "";
    let acc = this.mod.intern(pretty ? `{\n${inner}` : "{");
    fields.forEach((f, i) => {
      if (i > 0) acc = this.concat(acc, this.mod.intern(pretty ? `,\n${inner}` : ","));
      acc = this.concat(acc, this.mod.intern(pretty ? `"${f.key}": ` : `"${f.key}":`));
      const gep = this.fresh();
      this.emit(`${gep} = getelementptr i64, ptr ${val.v}, i64 ${fieldIndex(val.ty, f.key)}`);
      const slot = this.fresh();
      this.emit(`${slot} = load i64, ptr ${gep}`);
      acc = this.concat(acc, this.genJsonStringify({ v: this.fromSlot(slot, f.ty), ty: f.ty }, indent, depth + 1).v);
    });
    acc = this.concat(acc, this.mod.intern(pretty ? `\n${close}}` : "}"));
    return { v: acc, ty: "string" };
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
    if (pretty) {
      const af0 = this.fresh(); this.emit(`${af0} = load ptr, ptr ${accSlot}`);
      this.emit(`store ptr ${this.concat(af0, this.mod.intern(`\n${inner}`))}, ptr ${accSlot}`);
    }
    this.terminate(`br label %${after}`);
    // Subsequent elements: separator (compact `,` or pretty `,\n<indent>`).
    this.to(this.block(comma));
    const a1 = this.fresh(); this.emit(`${a1} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(a1, this.mod.intern(pretty ? `,\n${inner}` : ","))}, ptr ${accSlot}`);
    this.terminate(`br label %${after}`);
    this.to(this.block(after));
    const iB2 = this.fresh(); this.emit(`${iB2} = load double, ptr ${idx}`);
    const slot = this.fresh(); this.emit(`${slot} = call i64 @nt_arr_get(ptr ${val.v}, double ${iB2})`);
    const es = this.genJsonStringify({ v: this.fromSlot(slot, el), ty: el }, indent, depth + 1);
    const a3 = this.fresh(); this.emit(`${a3} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(a3, es.v)}, ptr ${accSlot}`);
    this.terminate(`br label %${upd}`);
    this.to(this.block(upd));
    const iU = this.fresh(); this.emit(`${iU} = load double, ptr ${idx}`);
    const iN = this.fresh(); this.emit(`${iN} = fadd double ${iU}, 1.0`);
    this.emit(`store double ${iN}, ptr ${idx}`);
    this.terminate(`br label %${cond}`);
    this.to(this.block(end));
    if (!pretty) {
      const af = this.fresh(); this.emit(`${af} = load ptr, ptr ${accSlot}`);
      return { v: this.concat(af, this.mod.intern("]")), ty: "string" };
    }
    // Pretty close: an empty array stays inline `[]`; a non-empty one gets `\n<close>]`.
    const emptyL = this.label("jsE"), neL = this.label("jsN"), joinL = this.label("jsJ");
    const isEmpty = this.fresh(); this.emit(`${isEmpty} = fcmp oeq double ${len}, 0.0`);
    this.terminate(`br i1 ${isEmpty}, label %${emptyL}, label %${neL}`);
    this.to(this.block(emptyL));
    const ae = this.fresh(); this.emit(`${ae} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(ae, this.mod.intern("]"))}, ptr ${accSlot}`);
    this.terminate(`br label %${joinL}`);
    this.to(this.block(neL));
    const an = this.fresh(); this.emit(`${an} = load ptr, ptr ${accSlot}`);
    this.emit(`store ptr ${this.concat(an, this.mod.intern(`\n${close}]`))}, ptr ${accSlot}`);
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
      // --- stdlib (web standards) Batch 1: base64 globals ---
      case "btoa": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_btoa(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "atob": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_atob(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      // --- stdlib: URL parsing (WHATWG URL functional subset) — string in, string out ---
      case "urlProtocol": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_protocol(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlHost": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_host(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlHostname": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_hostname(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlPathname": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_pathname(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlSearch": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_search(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlHash": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_hash(ptr ${this.genExpr(args[0]!).v})`); return { v: t, ty: "string" }; }
      case "urlSearchParam": { const u = this.genExpr(args[0]!).v; const k = this.genExpr(args[1]!).v; const t = this.fresh(); this.emit(`${t} = call ptr @nt_url_search_param(ptr ${u}, ptr ${k})`); return { v: t, ty: "string" }; }
      case "move": return this.genExpr(args[0]!); // ownership marker; runtime identity
      // Host I/O stdin builtins — return a fresh (rc-tracked) heap string.
      case "readLine": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_line()`); return { v: t, ty: "string" }; }
      case "readStdin": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_stdin()`); return { v: t, ty: "string" }; }
      case "readKey": { const t = this.fresh(); this.emit(`${t} = call ptr @nt_read_key()`); return { v: t, ty: "string" }; }
      case "rawMode": { const b = this.fresh(); this.emit(`${b} = zext i1 ${this.genExpr(args[0]!).v} to i32`); this.emit(`call void @nt_raw_mode(i32 ${b})`); return { v: "", ty: "void" }; }
      case "__arrLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_arr_live()`); return { v: t, ty: "number" }; }
      case "__objLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_obj_live()`); return { v: t, ty: "number" }; }
      case "__strLive": { const t = this.fresh(); this.emit(`${t} = call double @nt_str_live()`); return { v: t, ty: "number" }; }
      // Networking tier (L-d): HTTP(S) client → {status:number, body:string}.
      case "httpGet": return this.genHttp("nt_http_get", args, false);
      case "httpPost": return this.genHttp("nt_http_post", args, true);

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
        // spawn(body, arg): body is a closure value; message rides in an i64 slot.
        const fn = this.genExpr(args[0]!);              // ptr: [fn_ptr, caps...]
        const argTy = funcParams(fn.ty)[0] ?? "number"; // the body's message type
        const entry = this.mod.actorEntry(argTy);
        const slot = this.toSlot(this.genExpr(args[1]!));
        const pidI = this.fresh();
        this.emit(`${pidI} = call i64 @nt_spawn_closure(ptr @${entry}, ptr ${fn.v}, i64 ${slot})`);
        const pid = this.fresh();
        this.emit(`${pid} = sitofp i64 ${pidI} to double`);
        return { v: pid, ty: "number" };
      }
      case "send": {
        const pidV = this.genExpr(args[0]!).v;          // double
        const pidI = this.fresh();
        this.emit(`${pidI} = fptosi double ${pidV} to i64`);
        const slot = this.toSlot(this.genExpr(args[1]!));
        this.emit(`call void @nt_send_slot(i64 ${pidI}, i64 ${slot})`);
        return { v: "", ty: "void" };
      }
      case "receive": {
        const slot = this.fresh();
        this.emit(`${slot} = call i64 @nt_receive_slot()`);
        return { v: this.fromSlot(slot, "number"), ty: "number" }; // v0: number messages
      }
      case "self": {
        const p = this.fresh();
        this.emit(`${p} = call i64 @nt_self()`);
        const d = this.fresh();
        this.emit(`${d} = sitofp i64 ${p} to double`);
        return { v: d, ty: "number" };
      }
      case "__drain": { this.emit(`call void @nt_drain()`); return { v: "", ty: "void" }; }

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

  private genUserCall(name: string, args: Expr[]): Val {
    this.emitSafepoint(); // call site: preempt long / deeply-recursive call chains
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
      // An omitted default is coerced to the param type — boxing an `undefined`
      // default into a nullable optional param (`f(x?: T)`). No-op for same-typed
      // defaults, so ordinary default params are unaffected.
      argVals.push(provided ? this.genExpr(provided).v : this.coerce(this.genExpr(sig.defaults[i]!), sig.params[i]!).v);
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
