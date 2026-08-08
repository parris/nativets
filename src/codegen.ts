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
import { consoleMethod, CONSOLE_STREAMS, planConsoleFormat, type FmtSpec } from "./checker.ts";
import { blockDrops, freshArray, RETAINS_RECEIVER } from "./ast.ts";
import type { Stmt, Expr, Ty, FuncDecl, VarDecl, Loc } from "./ast.ts";
import { NUMBER_CONSTS } from "./checker.ts";
import { isGeneralUnionTy, generalUnionMembers, generalUnionTagOf, typeofTagOf } from "./ast.ts";
import { isArrayTy, elemTy, isObjectTy, objectFields, fieldIndex, fieldType, isFuncTy, funcParams, funcRet, isNullableTy, baseTy, nullishKind, makeNullable, isMapTy, isSetTy, mapKeyTy, mapValTy, setElemTy, classTag, isBytesTy, isBytesRefTy, isTextEncoderTy, isTextDecoderTy, isResponseTy, isHeadersTy, isFetchRefTy } from "./ast.ts";
// stdlib Batch 3 (the object-shaped web APIs): Date / URL / URLSearchParams.
import { isDateTy, isUrlTy, isSearchParamsTy, isUrlRefTy, DATE_GETTERS } from "./ast.ts";
// SH2 (discriminated unions): a union value IS its member's object block, so every
// lowering below treats it exactly like an object pointer.
import { isUnionTy, unionDiscriminant } from "./ast.ts";
import { isOptChainExpr, isStructMsgTy } from "./checker.ts";
import type { ArrowFunction, AssignExpr } from "./ast.ts";
import { nyi, NYI, internalError } from "./diagnostics.ts";

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

function llvmTy(ty: Ty): string {
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
  if (isUnionTy(ty) || isGeneralUnionTy(ty)) return "null";
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
  "declare double @pow(double, double)",
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
  // Bounds-PANIC accessors — used only where the programmer wrote the index (the
  // extra `ptr` is the interned "file:line:col" the panic reports).
  "declare i64 @nt_arr_index(ptr, double, ptr)",
  // `expr!` — unwrap the A2 tagged pair, PANIC when the assertion is false (Stage 41 shape)
  "declare i64 @nt_nonnull(ptr, ptr)",
  "declare i64 @nt_union_arm(ptr, double, ptr, ptr)",
  "declare ptr @nt_str_index(ptr, double, ptr)",
  "declare void @nt_panic_bounds(ptr, double, double, ptr)",
  "declare i64 @nt_arr_pop(ptr)",
  "declare double @nt_arr_len(ptr)",
  "declare ptr @nt_arr_join_num(ptr, ptr)",
  "declare ptr @nt_arr_join_str(ptr, ptr)",
  "declare i32 @nt_arr_includes_num(ptr, double)",
  "declare i32 @nt_arr_includes_str(ptr, ptr)",
  "declare double @nt_arr_indexof_num(ptr, double)",
  "declare double @nt_arr_indexof_str(ptr, ptr)",
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
  "declare double @js_str_last_index_of(ptr, ptr)",
  "declare ptr @nt_str_split_n(ptr, ptr, double)",
  "declare double @nt_arr_at_index(ptr, double)",
  "declare double @nt_arr_last_indexof_num(ptr, double)",
  "declare double @nt_arr_last_indexof_str(ptr, ptr)",
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

class ModuleGen {
  private strings = new Map<string, string>();
  private strDefs: string[] = [];
  readonly liftedFns: string[] = [];
  private arrowCounter = 0;
  /** Module-level bindings promoted to LLVM globals (SH1): the ones a function body
   *  reads. `main` uses the global as their storage; every other frame loads from it. */
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
    this.msgRenderers.set(key, name);
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
    this.cmpShims.set(lt, name);
    const conv = (reg: string, slot: string) =>
      lt === "double" ? `%${reg} = bitcast i64 %${slot} to double` : `%${reg} = inttoptr i64 %${slot} to ptr`;
    this.liftedFns.push(
      [
        `define i32 @${name}(ptr %env, i64 %sa, i64 %sb) {`,
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

  intern(s: string): string {
    const existing = this.strings.get(s);
    if (existing) return existing;
    const sym = `@.str.${this.strings.size}`;
    const { body, len } = encodeCString(s);
    this.strDefs.push(`${sym} = private unnamed_addr constant [${len} x i8] c"${body}"`);
    this.strings.set(s, sym);
    return sym;
  }

  /** Host builtins (SH4) the program imported from a `node:` module. Only these names
   *  lower to a host call; every other program's IR is unchanged. */
  hostImports = new Set<string>();

  build(program: CheckedProgram["program"]): string {
    this.usesActors = scanUsesActors(program);
    this.hostImports = new Set(program.hostImports ?? []);
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
      "",
      ...this.strDefs,
      this.strDefs.length ? "" : null,
      // Module-level bindings read from inside a function (SH1). Zero-initialized and
      // written by `main` when the declaration executes, in module (dependency) order.
      ...[...this.globals].map(([n, t]) => `${ModuleGen.globalSym(n)} = internal global ${llvmTy(t)} ${defaultZero(t)}`),
      this.globals.size ? "" : null,
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
   *  than returning from the enclosing function. */
  private hofReturnStack: { slot: string; done: string; ty: Ty }[] = [];
  /** Per-inlining counter: gives each inlined HOF callback a frame-unique name suffix
   *  (see freshenHofArrow) so two sibling callbacks reusing a param/local name — possibly
   *  at DIFFERENT types — each get their own correctly-typed slot instead of colliding in
   *  the flat frame (addLocal keeps the first type → a silent miscompile). */
  private hofSeq = 0;
  /** In the `main` frame: the module-level bindings whose storage IS the LLVM global
   *  (so the declaration's store and every top-level read/write hit the same cell a
   *  function body reads). Empty in every other frame. */
  private globalVars = new Set<string>();

  constructor(private mod: ModuleGen) {}

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
    this.captures = new Map();
    this.tryHandlers = [];
    this.finallyStack = [];
    this.hofReturnStack = [];
    this.strLocals = new Set();
    this.globalVars = new Set();
    this.inMain = false;
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
    for (const s of list) {
      if (this.terminated) break;
      this.genStmt(s);
    }
    // Block-scoped RAII: free the linear locals this NESTED list declared (empty for a
    // function/module body — those use endDrops). Skipped when the block already
    // terminated (return/break/continue), which is a leak, never a double free.
    if (!this.terminated) this.emitDrops(blockDrops(list));
  }

  /** Emit deterministic drops (RAII frees) for owned linear locals. */
  /** Set while generating a LIFTED arrow body (`@arrow_N`). The ownership pass walks
   *  arrow bodies inside their enclosing function, so a `return` inside a block-bodied
   *  arrow carries the ENCLOSING scope's drop list — locals that do not exist (and are
   *  not owned) in the lifted function. Dropping them there emitted a load of an
   *  undefined `%x.addr` (clang: "use of undefined value"). Suppress drops in a lifted
   *  arrow: conservative (the enclosing owner still frees at its own scope exit). */
  private liftedArrow = false;

  /** Suppress preemption safepoints in this function (B3 v5 message renderers run from
   *  inside the runtime's crash-record printer — yielding there would be catastrophic). */
  private noSafepoints = false;

  /** Set while lowering a CONSUMING APPEND `x = [...x, e]` (B2 step 4 transients): the
   *  spread source is the assignment's own dying value, so its storage is MOVED into
   *  the new array instead of copied+retained. `consumeNode` is the exact `...x`
   *  element (identity-compared, so a second `...x` in the same literal still copies);
   *  `consumedAssign` records that the assignment's `dropOld` is already satisfied. */
  private consumeNode: Expr | null = null;
  private consumeTaken = false;

  private emitDrops(names: string[]): void {
    if (this.liftedArrow) return;
    for (const n of names) {
      const p = this.fresh();
      this.emit(`${p} = load ptr, ptr ${this.addr(n)}`);
      // Move-aware RAII: objects free via nt_obj_free, arrays via nt_arr_free.
      const dropTy = this.varTypes.get(n) ?? "number";
      const free = isObjectTy(dropTy) || isUnionTy(dropTy) ? "nt_obj_free" : "nt_arr_free"; // a union IS an object block (SH2)
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
    this.varTypes.set(name, ty);
    // A promoted module-level binding lives in its LLVM global, not a frame slot.
    if (!this.globalVars.has(name)) this.alloca(name, ty);
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
    if (!this.terminated) {
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
    if (!this.terminated) { this.emitDrops(endDrops); this.emitStrDrops(); this.terminate("ret i32 0"); }
    return this.assemble("define i32 @main(i32 %argc, ptr %argv)", b0);
  }

  /** Generate a lifted arrow `define <ret> @name(ptr %__clo, params) { ... }`. */
  genArrow(name: string, arrow: ArrowFunction): string {
    this.reset();
    this.liftedArrow = true; // see `liftedArrow`: enclosing-scope drops don't apply here
    this.retTy = arrow.retTy ?? "number";
    const paramTys = arrow.paramTys ?? [];
    this.captures = new Map((arrow.captures ?? []).map((c, i) => [c.name, { index: i, ty: c.ty }]));
    arrow.params.forEach((p, i) => { this.varTypes.set(p.name, paramTys[i]!); this.alloca(p.name, paramTys[i]!); });
    if (!arrow.exprBody) this.collectLocals(arrow.body as Stmt[]);
    const b0 = this.block(this.label("L"));
    this.to(b0);
    arrow.params.forEach((p, i) => this.emit(`store ${llvmTy(paramTys[i]!)} %${p.name}, ptr ${this.addr(p.name)}`));
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
          this.emit(`store ${llvmTy(ty)} ${val.v}, ptr ${this.addr(d.name)}`);
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
        // `for (const [k, v] of map)`: the checker left `iterable` as the MAP, so
        // walk its insertion-ordered key array and look each value up per step.
        const mapV = s.name2 ? this.genExpr(s.iterable) : null;
        const src = mapV
          ? (() => { const a = this.fresh(); this.emit(`${a} = call ptr @nt_coll_keys(ptr ${mapV.v})`); return { v: a, ty: `${s.elemTy ?? "string"}[]` as Ty }; })()
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
        this.emit(`store ptr ${this.fromSlot(slot, "string")}, ptr ${this.addr(s.name)}`);
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
        // A `throw` is lowered as a BRANCH to the enclosing `try`'s catch block, so the
        // try must be in the same function frame. Crossing a frame — the ordinary "raise
        // in the callee, handle at the call site" idiom — needs real unwinding, which does
        // not exist yet. Refuse it; a raw internal error here used to print a Bun stack
        // trace naming our own source files (CLAUDE.md: an NT**** with a hint, always).
        if (!h) {
          throw nyi(NYI.EXCEPTION, `\`throw\`${where(s)} that is not inside a \`try\` in the same function`,
            "a throw is lowered as a branch to its enclosing `try`, so it must sit inside one IN THE SAME function — crossing a call boundary needs unwinding. Wrap the throwing code in a local `try`/`catch`, or return a result value (e.g. `T | undefined`) and check it at the call site");
        }
        const v = this.genExpr(s.argument);
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
            // In `main` this block is unreachable (no top-level `return`), but it must still
            // type-check against `define i32 @main` — see `inMain`.
            if (this.inMain) this.terminate("ret i32 0");
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
    if (
      isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) ||
      isBytesTy(val.ty) || isBytesRefTy(val.ty) || isFetchRefTy(val.ty) || isUrlRefTy(val.ty) ||
      isDateTy(val.ty) || isResponseTy(val.ty) || isHeadersTy(val.ty) || isTextEncoderTy(val.ty) || isTextDecoderTy(val.ty)
    ) return "true";
    throw new Error(`internal: no truthiness rule for ${val.ty} — add one rather than defaulting`);
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
    if (val.ty === "number" || isDateTy(val.ty)) this.emit(`${t} = bitcast double ${val.v} to i64`); // a Date IS a double (batch 3)
    else if (isUnionTy(val.ty) || isGeneralUnionTy(val.ty) || val.ty === "string" || isArrayTy(val.ty) || isObjectTy(val.ty) || isFuncTy(val.ty) || isNullableTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) || (isBytesRefTy(val.ty) || isFetchRefTy(val.ty)) || isUrlRefTy(val.ty)) this.emit(`${t} = ptrtoint ptr ${val.v} to i64`);
    else if (val.ty === "boolean") this.emit(`${t} = zext i1 ${val.v} to i64`);
    else this.emit(`${t} = zext i8 ${val.v} to i64`);
    return t;
  }
  /** Unpack a 64-bit slot into a value of the given type. */
  private fromSlot(slot: string, ty: Ty): string {
    const t = this.fresh();
    if (ty === "number" || isDateTy(ty)) this.emit(`${t} = bitcast i64 ${slot} to double`); // a Date IS a double (batch 3)
    else if (isUnionTy(ty) || isGeneralUnionTy(ty) || ty === "string" || isArrayTy(ty) || isObjectTy(ty) || isFuncTy(ty) || isNullableTy(ty) || isMapTy(ty) || isSetTy(ty) || (isBytesRefTy(ty) || isFetchRefTy(ty)) || isUrlRefTy(ty)) this.emit(`${t} = inttoptr i64 ${slot} to ptr`);
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
    return { v: this.fromSlot(slot, base), ty: base };
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
        throw internalError(`codegen reached the expression kind ${e.kind}, which the checker should have expanded or refused`);

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
        // Both narrowings reach a read: `narrowRead` unwraps a nullable that the checker
        // proved present, and the union case below keeps the binding's storage while
        // taking the checker's MEMBER type (same pointer, different layout).
        if (this.captures.has(e.name)) return this.narrowRead(e, this.readCapture(e.name));
        const declared = this.varTypes.get(e.name) ?? (e.ty ?? "number");
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
        let obj = this.genExpr(e.object);
        // SH2 narrowing: the checker may have retyped this receiver from the union to one
        // of its members. The POINTER is identical — only the slot layout the fields are
        // read with changes — so take the checker's answer wherever it narrowed. Done on
        // the MemberExpr (not on the Identifier) so it covers every producer of a union
        // value alike: a local, a closure capture, a `for-of` element, a call result.
        if (isUnionTy(obj.ty) && e.object.ty !== undefined && isObjectTy(e.object.ty)) obj = { v: obj.v, ty: e.object.ty };
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
        // SH2: on an un-narrowed union only the DISCRIMINANT is readable, and it sits at
        // the same slot in every member (that requirement is what lets the union go
        // unboxed) — so this is an ordinary slot load, of a string.
        if (isUnionTy(obj.ty)) {
          const gep = this.fresh();
          this.emit(`${gep} = getelementptr i64, ptr ${obj.v}, i64 ${unionDiscriminant(obj.ty)!.index}`);
          const slot = this.fresh();
          this.emit(`${slot} = load i64, ptr ${gep}`);
          return { v: this.fromSlot(slot, "string"), ty: "string" };
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
        const name =
          inner === "undefined" || inner === "void" ? "undefined" :
          inner === "null" ? "object" :
          isFuncTy(inner) ? "function" :
          isObjectTy(inner) || isArrayTy(inner) ? "object" :
          // stdlib Batch 3: a Date/URL/URLSearchParams is an OBJECT in node, whatever
          // our internal representation is (a Date is a bare double here).
          isDateTy(inner) || isUrlRefTy(inner) ? "object" :
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
          const m = tgt as Extract<Expr, { kind: "MemberExpr" }>;
          const obj = this.genExpr(m.object);
          const slot = this.fresh();
          this.emit(`${slot} = getelementptr i64, ptr ${obj.v}, i64 ${fieldIndex(obj.ty, m.property)}`);
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
        if (op in FCMP) {
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
          const t = this.fresh();
          if (lt === "number") {
            this.emit(`${t} = fcmp ${FCMP[op]} double ${l.v}, ${r.v}`);
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
          const consume = this.consumingSpread(e, ty);
          if (consume) { this.consumeNode = consume; this.consumedAssign = e; }
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
        if (bare in ARITH) this.emit(`${t} = ${ARITH[bare]} double ${old}, ${rv.v}`);
        else this.emit(`${t} = call double @${BITFN[bare]}(double ${old}, double ${rv.v})`);
        this.emit(`store double ${t}, ptr ${this.addr(e.target)}`);
        return { v: t, ty: "number" };
      }

      case "AsExpr": {
        // Narrowing a dynamic value (`dyn as T`) emits a runtime validator that
        // checks the tag and unboxes; a plain `expr as Type` is an identity retype.
        if (e.expr.ty === "Dyn") return this.genDynNarrow(this.genExpr(e.expr).v, e.ty);
        return { v: this.genExpr(e.expr).v, ty: e.ty };
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
          if (bare in ARITH) this.emit(`${out} = ${ARITH[bare]} double ${cur}, ${rv.v}`);
          else this.emit(`${out} = call double @${BITFN[bare]}(double ${cur}, double ${rv.v})`);
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
      // stdlib Batch 3: `Object.freeze(o)` is the identity (objects are ALREADY
      // immutable, Stage 29) and `isFrozen` is therefore the constant `true`.
      // `getOwnPropertyNames` == `keys` for a plain record.
      if (e.callee.property === "freeze") return o;
      if (e.callee.property === "isFrozen") return { v: "true", ty: "boolean" };
      if (e.callee.property === "keys" || e.callee.property === "getOwnPropertyNames")
        return this.buildStringArray(objectFields(o.ty).map((f) => f.key));
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
        if (p === "toISOString" || p === "toJSON") {
          const t = this.fresh();
          this.emit(`${t} = call ptr @nt_date_to_iso(double ${recv.v})`);
          this.emitExcCheck();
          return { v: t, ty: "string" };
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
        this.emit(`store ptr ${m}, ptr ${this.addr(h.excVar)}`);
      } else if (h.excVar && h.eType === "{message:string}") {
        // SH4: the block calls a host builtin, so its failure is an Error — box the
        // runtime message into `new Error(msg)`'s shape so `e.message` reads it.
        const m = this.fresh();
        this.emit(`${m} = call ptr @nt_exc_message()`);
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

  /** Call a function VALUE (closure ptr already computed): indirect call through slot 0. */
  private genCallValueFrom(clo: string, fnTy: Ty, args: Expr[]): Val {
    return this.callClosure(clo, fnTy, (ps) => args.map((a, i) => ({ v: this.genExpr(a).v, ty: ps[i]! })));
  }

  /** Call a closure value with ALREADY-generated argument values — B3 v4's
   *  selective-receive scan calls the user predicate with a value peeked out of the
   *  mailbox, which has no Expr form. */
  private callClosureWith(clo: string, fnTy: Ty, argVs: Val[]): Val {
    return this.callClosure(clo, fnTy, () => argVs);
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
        if (piece.spec === undefined) { this.emit(`call void @${P}_str(ptr ${this.mod.intern(piece.text)})`); continue; }
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
    if (isObjectTy(val.ty) || isArrayTy(val.ty) || isMapTy(val.ty) || isSetTy(val.ty) || isBytesTy(val.ty)) {
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
    const tag = classTag(val.ty);
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
  private emitPrintNullable(ptr: string, base: Ty, stream: "out" | "err" = "out"): void {
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

  /**
   * Runtime `typeof` of a general-union box: select the arm's `typeof` name by tag.
   * A chain of `select`s rather than blocks — every arm's answer is a constant string,
   * so there is nothing to branch around.
   */
  private genTypeofGeneralUnion(ptr: string, ty: Ty): Val {
    const members = generalUnionMembers(ty);
    const tag = this.nullTag(ptr);
    let acc = this.mod.intern(typeofTagOf(members[members.length - 1]!)); // the last arm needs no test
    for (let i = members.length - 2; i >= 0; i--) {
      const is = this.fresh();
      this.emit(`${is} = icmp eq i64 ${tag}, ${i}`);
      const sel = this.fresh();
      this.emit(`${sel} = select i1 ${is}, ptr ${this.mod.intern(typeofTagOf(members[i]!))}, ptr ${acc}`);
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
    if (!fn) throw internalError(`no lowering for Math.${method}, which the checker admitted`);
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
      default: throw internalError(`no lowering for string method .${method}, which the checker admitted`);
    }
  }

  /** structuredClone: a deep copy generated from the STATIC type (the same
   *  type-directed walk shape as JSON.stringify). Scalars/strings are values and
   *  pass through; an object becomes a fresh slot block with each field cloned;
   *  an array becomes a fresh vector with each element cloned in a loop. */
  private genDeepClone(v: Val, copyStrings = false): Val {
    const ty = v.ty;
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
        return { v: a, ty: `${method === "keys" ? k : v}[]` as Ty };
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
        return { v: a, ty: `${el}[]` as Ty };
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
        // Out of range PANICS: it used to leave the copy untouched, so the program
        // carried on with an array it believed it had updated (node throws RangeError).
        const idx = this.genExpr(args[0]!).v;
        const slot = this.toSlot(this.genExpr(args[1]!));
        const t = this.fresh();
        this.emit(`${t} = call ptr @nt_arr_with(ptr ${recv.v}, double ${idx}, i64 ${slot}, ptr ${this.locArg(loc) ?? "null"})`);
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
      default: throw internalError(`no lowering for array method .${method}, which the checker admitted`);
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
      this.emit(`store ${llvmTy(el)} ${v}, ptr ${this.addr(pName)}`);
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
    this.emit(`store ${llvmTy(A)} ${init.v}, ptr ${this.addr(accName)}`); // pre-loop init
    this.prepHofLocals(arrow);
    const L = this.hofLoop(recv, "red", () => {});
    L.elem(el, xName);
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
    if (ty === "number") { const t = this.fresh(); this.emit(`${t} = call ptr @js_num_to_str(double ${val.v})`); return { v: t, ty: "string" }; }
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
    return { v: this.mod.intern("null"), ty: "string" };
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
    const fields = objectFields(val.ty);
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
      fields.forEach((f, i) => {
        if (i > 0) acc = this.concat(acc, this.mod.intern(pretty ? `,\n${inner}` : ","));
        acc = this.concat(acc, this.mod.intern(pretty ? `"${f.key}": ` : `"${f.key}":`));
        acc = this.concat(acc, this.genJsonStringify(this.loadField(val, f.key, f.ty), indent, depth + 1).v);
      });
      return { v: this.concat(acc, this.mod.intern(pretty ? `\n${close}}` : "}")), ty: "string" };
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
      let a = this.concat(cur, lead);
      a = this.concat(a, this.mod.intern(pretty ? `"${key}": ` : `"${key}":`));
      a = this.concat(a, jsonV);
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
    return { v: this.concat(this.concat(openV, body), closeV), ty: "string" };
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
    return isStructMsgTy(val.ty) ? this.genDeepClone(val, /*copyStrings=*/true) : val;
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
      if (sig.ret === "void") { this.emit(`call void @${userSym(name)}(${argstr})`); return { v: "", ty: "void" }; }
      const t = this.fresh();
      this.emit(`${t} = call ${llvmTy(sig.ret)} @${userSym(name)}(${argstr})`);
      return { v: t, ty: sig.ret };
    }
    const argVals: string[] = [];
    for (let i = 0; i < sig.params.length; i++) {
      const provided = args[i];
      // Coerced to the param type — boxing an `undefined` default into a nullable
      // optional param (`f(x?: T)`), and boxing an ARM into a general-union param
      // (`f(v: number | string)`, called as `f(41)`). A no-op when the types already
      // match, so ordinary params are unaffected.
      argVals.push(this.coerce(this.genExpr(provided ?? sig.defaults[i]!), sig.params[i]!).v);
    }
    const argstr = argVals.map((v, i) => `${llvmTy(sig.params[i]!)} ${v}`).join(", ");
    if (sig.ret === "void") {
      this.emit(`call void @${userSym(name)}(${argstr})`);
      return { v: "", ty: "void" };
    }
    const t = this.fresh();
    this.emit(`${t} = call ${llvmTy(sig.ret)} @${userSym(name)}(${argstr})`);
    return { v: t, ty: sig.ret };
  }
}

export function codegen(checked: CheckedProgram): string {
  return new ModuleGen(checked.functions, checked.globals).build(checked.program);
}
