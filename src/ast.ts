/*
 * AST for the growing TypeScript subset.
 *
 * Types are tracked statically. Every Expr carries an optional `ty` the checker
 * fills in; codegen reads it to choose LLVM types/instructions.
 */

export type ScalarTy = "number" | "boolean" | "string" | "void" | "undefined" | "null" | "Dyn";
/**
 * Array types: `${elem}[]` (e.g. "number[]").
 * Object types: `{k1:t1,k2:t2}` in field-insertion order (e.g. "{name:string,age:number}").
 * Both encodings keep `===` type comparison working as plain string equality.
 */
export type Ty = ScalarTy | `${string}[]` | `{${string}}`;

export function isArrayTy(t: Ty): boolean { return typeof t === "string" && !isNullableTy(t) && t.endsWith("[]"); }
export function elemTy(t: Ty): Ty { return t.slice(0, -2) as Ty; }

/**
 * Nullable / optional encoding (A2). A runtime-nullable value — `T | undefined`,
 * `T | null`, and optional object fields `{ a?: T }` — is encoded `?U<base>`
 * (undefined arm) or `?N<base>` (null arm). Kept DISTINCT from object/array/func
 * encodings: a nullable never reports as object/array/func (the predicates guard
 * against it), so `isObjectTy`/`isArrayTy`/`isFuncTy` still pattern-match the base
 * shapes only. At runtime a nullable is a heap block of 2 i64 slots
 * [tag, value] (tag 0=undefined, 1=null, 2=present); `is_nullish = tag < 2`.
 */
export function isNullableTy(t: Ty): boolean { return typeof t === "string" && (t.startsWith("?U") || t.startsWith("?N")); }
/** The non-nullable base of a nullable type (identity on a non-nullable). */
export function baseTy(t: Ty): Ty { return isNullableTy(t) ? (t.slice(2) as Ty) : t; }
/** Which nullish arm a nullable type carries (`undefined` or `null`). */
export function nullishKind(t: Ty): "undefined" | "null" { return typeof t === "string" && t.startsWith("?N") ? "null" : "undefined"; }
/** Wrap `base` as nullable with the given nullish arm (idempotent on the base). */
export function makeNullable(which: "undefined" | "null", base: Ty): Ty {
  const b = isNullableTy(base) ? baseTy(base) : base; // no double-wrap
  return `?${which === "null" ? "N" : "U"}${b}` as Ty;
}

/** Split on `sep` at nesting depth 0 (respecting (), [], {}) — for nested types. */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, angle = 0, start = 0; // `angle` tracks `Map<…>`/`Set<…>` generic brackets
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "<") angle++;
    // `>` closes a generic only when one is open — so the `>` of a function type's `=>`
    // (angle === 0) is left alone and never miscounts depth.
    else if (c === ">" && angle > 0) angle--;
    else if (c === sep && depth === 0 && angle === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}
/** Index of the top-level `=>` (depth 0). -1 if none. */
function topArrow(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "=" && s[i + 1] === ">") return i;
  }
  return -1;
}

/** Function types are encoded `(t1,t2)=>tr` (supports nested via depth-aware splitting). */
export function isFuncTy(t: Ty): boolean { return typeof t === "string" && t.startsWith("(") && topArrow(t) >= 0; }
export function funcParams(t: Ty): Ty[] {
  const arrow = topArrow(t);
  const inner = t.slice(1, arrow - 1).trimEnd(); // between "(" and ")" before "=>"
  const body = inner.endsWith(")") ? inner.slice(0, -1) : inner;
  return body === "" ? [] : (splitTopLevel(body, ",") as Ty[]);
}
export function funcRet(t: Ty): Ty { return t.slice(topArrow(t) + 2) as Ty; }
export function makeFuncTy(params: Ty[], ret: Ty): Ty { return `(${params.join(",")})=>${ret}` as Ty; }

/**
 * Immutable collection encodings (B2). Kept DISTINCT from object/array/func/
 * nullable: `Map<K,V>` and `Set<T>` start with `Map<`/`Set<` and end with `>`,
 * so none of `isObjectTy` (`{`), `isArrayTy` (`[]`), `isFuncTy` (`(`…`=>`),
 * `isNullableTy` (`?U`/`?N`) ever match them. Both are heap handles (`NtMap*`),
 * lowered to `ptr`; their ops are immutable (return a NEW handle).
 */
export function isMapTy(t: Ty): boolean { return typeof t === "string" && t.startsWith("Map<") && t.endsWith(">"); }
export function isSetTy(t: Ty): boolean { return typeof t === "string" && t.startsWith("Set<") && t.endsWith(">"); }
export function makeMapTy(k: Ty, v: Ty): Ty { return `Map<${k},${v}>` as Ty; }
export function makeSetTy(el: Ty): Ty { return `Set<${el}>` as Ty; }
/**
 * Bytes value type (stdlib batch 2). `Uint8Array` is a compact byte buffer (NtBytes*),
 * `TextEncoder`/`TextDecoder` are stateless singleton handles — all three lowered to
 * `ptr`. Kept as plain reserved type names (no `{`/`[]`/`(`/`<`/`?`), so none of the
 * structural predicates match them.
 */
export function isBytesTy(t: Ty): boolean { return t === "Uint8Array"; }
export function isTextEncoderTy(t: Ty): boolean { return t === "TextEncoder"; }
export function isTextDecoderTy(t: Ty): boolean { return t === "TextDecoder"; }
export function isBytesRefTy(t: Ty): boolean { return t === "Uint8Array" || t === "TextEncoder" || t === "TextDecoder"; }

/**
 * Networking tier (`fetch`). A `Response` is a 3-slot heap block
 * `[status(double bits), body(ptr), rawHeaders(ptr)]`; `Headers` is just the raw
 * header block that came back on the wire (case-insensitive lookup happens in the
 * runtime). Both are lowered to `ptr`, and — like the bytes handles — they are plain
 * reserved type names (no `{`/`[]`/`(`/`<`/`?`), so no structural predicate matches
 * them and they are neither linear nor printable as objects.
 */
export function isResponseTy(t: Ty): boolean { return t === "Response"; }
export function isHeadersTy(t: Ty): boolean { return t === "Headers"; }
export function isFetchRefTy(t: Ty): boolean { return t === "Response" || t === "Headers"; }

/**
 * stdlib Batch 3 — the object-shaped web APIs, as reserved type names (no
 * `{`/`[]`/`(`/`<`/`?`, so no structural predicate matches them).
 *
 * `Date` is a VALUE type: its representation IS the epoch-ms `double` (the ES
 * "time value"; NaN == Invalid Date), so `getTime()` is the identity and a Date
 * costs no allocation and needs no drop. `URL` / `URLSearchParams` are string
 * handles — the URL text and the raw query text respectively — so every accessor
 * is a pure re-parse in the runtime and both are lowered to `ptr`.
 */
export function isDateTy(t: Ty): boolean { return t === "Date"; }
export function isUrlTy(t: Ty): boolean { return t === "URL"; }
export function isSearchParamsTy(t: Ty): boolean { return t === "URLSearchParams"; }
export function isUrlRefTy(t: Ty): boolean { return t === "URL" || t === "URLSearchParams"; }

/**
 * Date component getters → `nt_date_field(t, which, utc)`. `which`: 0 fullYear,
 * 1 month (0-based), 2 date, 3 hours, 4 minutes, 5 seconds, 6 ms, 7 day-of-week.
 * `utc: 0` is the LOCAL breakdown (libc's zone, the same one node's ICU reads);
 * the `getUTC*` aliases pass 1 and are zone-independent. `getTime()` is NOT here:
 * a Date IS its time value, so it lowers to the identity.
 */
/* A Map, NOT a Record: a plain object would answer `DATE_GETTERS["toString"]`
 * with `Object.prototype.toString` and accept `d.toString()` as a getter. */
export const DATE_GETTERS = new Map<string, { which: number; utc: number }>([
  ["getFullYear", { which: 0, utc: 0 }], ["getMonth", { which: 1, utc: 0 }], ["getDate", { which: 2, utc: 0 }],
  ["getHours", { which: 3, utc: 0 }], ["getMinutes", { which: 4, utc: 0 }], ["getSeconds", { which: 5, utc: 0 }],
  ["getMilliseconds", { which: 6, utc: 0 }], ["getDay", { which: 7, utc: 0 }],
  ["getUTCFullYear", { which: 0, utc: 1 }], ["getUTCMonth", { which: 1, utc: 1 }], ["getUTCDate", { which: 2, utc: 1 }],
  ["getUTCHours", { which: 3, utc: 1 }], ["getUTCMinutes", { which: 4, utc: 1 }], ["getUTCSeconds", { which: 5, utc: 1 }],
  ["getUTCMilliseconds", { which: 6, utc: 1 }], ["getUTCDay", { which: 7, utc: 1 }],
]);

/** `new URL(u)` components, each a plain `string` → one `nt_url_<name>` call. */
export const URL_COMPONENTS = ["protocol", "host", "hostname", "port", "pathname", "search", "hash", "origin"];

export function mapKeyTy(t: Ty): Ty { return splitTopLevel(t.slice(4, -1), ",")[0] as Ty; }
export function mapValTy(t: Ty): Ty { return splitTopLevel(t.slice(4, -1), ",")[1] as Ty; }
export function setElemTy(t: Ty): Ty { return t.slice(4, -1) as Ty; }

/**
 * Class instance types (minimal classes) are structural object types with a leading
 * class-name TAG: `Name{field:ty,...}` (e.g. `Point{x:number,y:number}`). The `{...}`
 * body reuses ALL object machinery (field slots, printing, JSON, equality); the tag is
 * read only for method resolution (`inst.m()` → `Name.m(inst, …)`). A plain object literal
 * type has no tag (`{a:number}`). `classTag` returns the tag when present.
 */
export function classTag(t: Ty): string | undefined {
  if (typeof t !== "string") return undefined;
  const i = t.indexOf("{");
  if (i <= 0 || !t.endsWith("}")) return undefined;
  const tag = t.slice(0, i);
  return /^[A-Za-z_$][\w$]*$/.test(tag) ? tag : undefined;
}
export function isObjectTy(t: Ty): boolean {
  if (typeof t !== "string" || isNullableTy(t) || t.endsWith("[]")) return false;
  const i = t.indexOf("{");
  if (i < 0 || !t.endsWith("}")) return false;
  return i === 0 || /^[A-Za-z_$][\w$]*$/.test(t.slice(0, i)); // untagged literal or class-tagged
}
/** Parse an object type into ordered [key, type] fields (nesting-aware; tag-tolerant). */
export function objectFields(t: Ty): { key: string; ty: Ty }[] {
  const inner = t.slice(t.indexOf("{") + 1, -1);
  if (inner === "") return [];
  return splitTopLevel(inner, ",").map((part) => {
    const i = part.indexOf(":");
    return { key: part.slice(0, i), ty: part.slice(i + 1) as Ty };
  });
}
export function fieldIndex(t: Ty, key: string): number { return objectFields(t).findIndex((f) => f.key === key); }
export function fieldType(t: Ty, key: string): Ty | undefined { return objectFields(t).find((f) => f.key === key)?.ty; }
export function objectType(fields: { key: string; ty: Ty }[]): Ty {
  return `{${fields.map((f) => `${f.key}:${f.ty}`).join(",")}}`;
}

/* ============================================================
 * Generic type parameters (M3 — monomorphization).
 *
 * While parsing a generic function `function f<T>(x: T): T`, a use of an in-scope type
 * parameter resolves to the MARKER type `#T` instead of erasing to `number`. The marker
 * is deliberately un-representable — no other Ty starts with `#` and none of the
 * structural predicates (`{`, `[]`, `(`…`=>`, `?U`/`?N`, `Map<`/`Set<`) match it — so a
 * `#T` that survives to codegen is always a bug, never a silently wrong lowering.
 *
 * The checker never lets one survive: at every call site it UNIFIES the parameter
 * patterns against the actual argument types, SUBSTITUTES the resulting bindings through
 * a clone of the declaration, and emits that clone as an ordinary (fully concrete)
 * function. `#` is not a legal TypeScript type character, so a marker can never collide
 * with a user-written type name.
 * ============================================================ */

const TYPE_PARAM_RE = /^#[A-Za-z_$][\w$]*$/;
/** The marker type for type parameter `name` (`T` → `#T`). */
export function typeParamTy(name: string): Ty { return `#${name}` as Ty; }
/** Is `t` EXACTLY a bare type parameter (`#T`, not `#T[]`)? */
export function isTypeParamTy(t: Ty): boolean { return typeof t === "string" && TYPE_PARAM_RE.test(t); }
/** Does `t` mention any type parameter anywhere (`#T[]`, `(#T)=>#U`, `{a:#T}`)? */
export function hasTypeParam(t: Ty): boolean { return typeof t === "string" && t.includes("#"); }
/** Substitute bound type parameters through `t`; unbound ones are left as markers. */
export function substTypeParams(t: Ty, bindings: Map<string, Ty>): Ty {
  if (!hasTypeParam(t)) return t;
  return t.replace(/#([A-Za-z_$][\w$]*)/g, (m, n: string) => bindings.get(n) ?? m) as Ty;
}
/** Erase any REMAINING type parameters to `number` (the pre-M3 fallback, kept for
 *  generic ARROWS, which are values and so have no instantiation site to specialize). */
export function eraseTypeParams(t: Ty): Ty {
  return hasTypeParam(t) ? (t.replace(/#[A-Za-z_$][\w$]*/g, "number") as Ty) : t;
}
/**
 * Structural unification of a parameter PATTERN (which may mention `#T`) against a
 * concrete ARGUMENT type, accumulating bindings. First binding wins (so `pair(a: T, b: T)`
 * called as `pair(1, 2)` binds T=number once); a mismatch simply contributes nothing and
 * is reported later as an ordinary argument type error against the substituted signature.
 */
export function unifyTypeParams(pattern: Ty, actual: Ty, out: Map<string, Ty>): void {
  if (!hasTypeParam(pattern)) return;
  if (isTypeParamTy(pattern)) {
    const name = pattern.slice(1);
    if (!out.has(name)) out.set(name, actual);
    return;
  }
  if (isArrayTy(pattern) && isArrayTy(actual)) return unifyTypeParams(elemTy(pattern), elemTy(actual), out);
  if (isNullableTy(pattern) && isNullableTy(actual)) return unifyTypeParams(baseTy(pattern), baseTy(actual), out);
  if (isFuncTy(pattern) && isFuncTy(actual)) {
    const pp = funcParams(pattern), ap = funcParams(actual);
    pp.forEach((p, i) => { if (ap[i] !== undefined) unifyTypeParams(p, ap[i]!, out); });
    return unifyTypeParams(funcRet(pattern), funcRet(actual), out);
  }
  if (isMapTy(pattern) && isMapTy(actual)) {
    unifyTypeParams(mapKeyTy(pattern), mapKeyTy(actual), out);
    return unifyTypeParams(mapValTy(pattern), mapValTy(actual), out);
  }
  if (isSetTy(pattern) && isSetTy(actual)) return unifyTypeParams(setElemTy(pattern), setElemTy(actual), out);
  if (isObjectTy(pattern) && isObjectTy(actual)) {
    for (const f of objectFields(pattern)) {
      const af = fieldType(actual, f.key);
      if (af !== undefined) unifyTypeParams(f.ty, af, out);
    }
  }
}

/* AST fields that hold a `Ty` (or a list of them). Deep rewrites touch exactly these —
 * never a `name`/`property`/string-literal `value` — so a program that happens to contain
 * the text "#T" in a string is untouched. */
const TY_FIELDS = new Set(["annot", "ty", "returnAnnot", "retTy", "catchTy", "elemTy"]);
const TY_LIST_FIELDS = new Set(["typeArgs", "paramTys"]);
/** Deep-rewrite every type-bearing field of an AST subtree, in place. */
export function mapTypesDeep(n: unknown, f: (t: Ty) => Ty): void {
  if (Array.isArray(n)) { for (const x of n) mapTypesDeep(x, f); return; }
  if (!n || typeof n !== "object") return;
  const o = n as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string") { if (TY_FIELDS.has(k)) o[k] = f(v as Ty); }
    else if (Array.isArray(v) && TY_LIST_FIELDS.has(k)) o[k] = v.map((t) => (typeof t === "string" ? f(t as Ty) : t));
    else mapTypesDeep(v, f);
  }
}

export type Expr =
  | NumberLiteral
  | BooleanLiteral
  | StringLiteral
  | TemplateLiteral
  | UndefinedLiteral
  | NullLiteral
  | ArrayLiteral
  | ObjectLiteral
  | Identifier
  | MemberExpr
  | IndexExpr
  | UnaryExpr
  | UpdateExpr
  | BinaryExpr
  | LogicalExpr
  | ConditionalExpr
  | SequenceExpr
  | AssignExpr
  | IndexAssign
  | FieldAssign
  | TypeofExpr
  | SpreadExpr
  | ArrowFunction
  | NewExpr
  | AsExpr
  | InstanceOfExpr
  | CallExpr;

export type Stmt =
  | VarDecl
  | FuncDecl
  | ReturnStmt
  | IfStmt
  | WhileStmt
  | DoWhileStmt
  | ForStmt
  | ForOfStmt
  | ForInStmt
  | SwitchStmt
  | ThrowStmt
  | TryStmt
  | ExprStmt
  | BlockStmt
  | MultiStmt
  | BreakStmt
  | ContinueStmt;

export interface NumberLiteral { kind: "NumberLiteral"; value: number; ty?: Ty; }
export interface BooleanLiteral { kind: "BooleanLiteral"; value: boolean; ty?: Ty; }
export interface StringLiteral { kind: "StringLiteral"; value: string; ty?: Ty; }

/** `hi ${x} there` — quasis.length === exprs.length + 1 */
export interface TemplateLiteral {
  kind: "TemplateLiteral";
  quasis: string[];
  exprs: Expr[];
  ty?: Ty;
}

export interface UndefinedLiteral { kind: "UndefinedLiteral"; ty?: Ty; }
export interface NullLiteral { kind: "NullLiteral"; ty?: Ty; }
export interface ArrayLiteral { kind: "ArrayLiteral"; elements: Expr[]; ty?: Ty; }
export interface ObjectProperty { key: string; value: Expr; spread?: boolean; }
export interface ObjectLiteral { kind: "ObjectLiteral"; properties: ObjectProperty[]; ty?: Ty; }
export interface SpreadExpr { kind: "SpreadExpr"; argument: Expr; ty?: Ty; }

export interface Loc { line: number; col: number; file?: string; }
export interface Identifier {
  kind: "Identifier"; name: string; ty?: Ty; loc?: Loc;
  /** Ownership drop flag (B2 step 4): this read MOVES the value out of a binding that
   *  is dropped on some other path, so the slot is nulled here. `free(NULL)` is a
   *  no-op, which makes the pointer itself rustc's runtime drop flag. */
  nullOnMove?: boolean;
}

export interface MemberExpr {
  kind: "MemberExpr";
  object: Expr;
  property: string;
  optional?: boolean; // `?.` optional-chaining link (A2)
  ty?: Ty;
}

/** obj[expr] element access */
/**
 * `obj[i]`. `loc` is set ONLY by the parser, on an index the programmer actually wrote —
 * that is exactly the set of reads whose out-of-range access must PANIC (and the location
 * the panic reports). Desugarings that synthesize an IndexExpr (destructuring, spread-call
 * expansion) leave it undefined and keep the internal, non-panicking accessor.
 */
export interface IndexExpr { kind: "IndexExpr"; object: Expr; index: Expr; ty?: Ty; loc?: Loc; }

export type UnaryOp = "-" | "+" | "!" | "~" | "void";
export interface UnaryExpr { kind: "UnaryExpr"; op: UnaryOp; operand: Expr; ty?: Ty; }

/**
 * ++x / x++ / --x / x--, and the member/index forms `this.f++` / `u[i]++`.
 *
 * `target` names the local for the (overwhelmingly common) identifier case. A
 * member/index target instead carries `targetExpr` — a MemberExpr or IndexExpr —
 * with `target` left empty. Mutability is decided exactly as for a plain assignment:
 * `this.f` inside a constructor and a `Uint8Array` element are writable, everything
 * else is NT1606 (objects/arrays are immutable — Stage 29).
 */
export interface UpdateExpr {
  kind: "UpdateExpr";
  op: "++" | "--";
  prefix: boolean;
  target: string;
  targetExpr?: Expr;
  ty?: Ty;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "<" | "<=" | ">" | ">=" | "===" | "!==" | "==" | "!="
  | "&" | "|" | "^" | "<<" | ">>" | ">>>";
export interface BinaryExpr { kind: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr; ty?: Ty; }

export interface LogicalExpr { kind: "LogicalExpr"; op: "&&" | "||" | "??"; left: Expr; right: Expr; ty?: Ty; }

export interface SequenceExpr { kind: "SequenceExpr"; exprs: Expr[]; ty?: Ty; }

export interface ConditionalExpr {
  kind: "ConditionalExpr";
  test: Expr;
  consequent: Expr;
  alternate: Expr;
  ty?: Ty;
}

/** simple assignment or compound (+= -= *= /= %= &= |= ^= <<= >>= >>>=) */
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | ">>>=";
export interface AssignExpr {
  kind: "AssignExpr";
  op: AssignOp;
  target: string;
  value: Expr;
  ty?: Ty;
  /** Ownership (B2 step 4): the value being OVERWRITTEN is a linear heap value this
   *  scope still owns, so the assignment must free it (RAII on reassignment). Set by
   *  `src/ownership.ts` only when it can prove the old value is dead — not moved out,
   *  not captured by a closure. */
  dropOld?: boolean;
}

/**
 * Element assignment `obj[index] = value` (and compound `obj[i] += v`). The parser emits
 * this for ANY index target and DEFERS the mutability decision to the checker: for an
 * immutable array/object it is rejected (NT1606, the "sharp turn"); for a `Uint8Array`
 * (a genuinely mutable typed array — node allows `u[i] = v`) it is allowed and lowered
 * to `nt_bytes_set` with JS ToUint8 wrap. `ty` is the element type (number for bytes).
 */
export interface IndexAssign {
  kind: "IndexAssign";
  op: AssignOp;
  object: Expr;
  index: Expr;
  value: Expr;
  ty?: Ty;
  loc?: Loc; // the written `[` — an out-of-range element WRITE panics from here
}

/**
 * Field initialization `this.field = expr` — permitted ONLY inside a class constructor
 * (the parser emits this in place of an `AssignExpr` for a `this.f = v` target while
 * parsing a ctor body). It is the single place field assignment is allowed: everywhere
 * else `o.f = v` stays rejected (NT1606) since values are immutable, and a method
 * mutating `this` is likewise rejected. Lowers to a static slot store on the instance.
 */
export interface FieldAssign { kind: "FieldAssign"; object: Expr; field: string; value: Expr; ty?: Ty; }

export interface TypeofExpr { kind: "TypeofExpr"; operand: Expr; ty?: Ty; }

// `typeArgs` are EXPLICIT call-site type arguments (`id<string>("x")`) — they pin the
// instantiation of a generic callee instead of inferring it from the argument types.
export interface CallExpr { kind: "CallExpr"; callee: Expr; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; loc?: Loc; }
export interface NewExpr { kind: "NewExpr"; callee: string; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; }
export interface AsExpr { kind: "AsExpr"; expr: Expr; ty: Ty; } // `expr as Type` — identity retype

/**
 * `x instanceof C` — decided at COMPILE TIME from the static type of `x`.
 *
 * A value's static type IS its exact class in this subset: user classes have no
 * inheritance (only `extends Error`), and there are no polymorphic references, so
 * "does this value's runtime class chain contain C" has one answer per site, and the
 * checker fills it into `result`. `C` must be a class the compiler can name (a user
 * class, or `Array`/`Map`/`Set`/`Uint8Array`); anything else is rejected (NT1022)
 * rather than guessed.
 */
export interface InstanceOfExpr { kind: "InstanceOfExpr"; object: Expr; className: string; result?: boolean; ty?: Ty; }

/** Arrow function. `captures` (filled by the checker) are free vars closed over. */
export interface ArrowFunction {
  kind: "ArrowFunction";
  params: Param[];
  body: Expr | Stmt[];
  exprBody: boolean;
  ty?: Ty;
  paramTys?: Ty[]; // resolved param types (from annotations or context)
  retTy?: Ty;
  captures?: { name: string; ty: Ty }[];
  liftedName?: string; // @arrow_N assigned during codegen
}

// `paramProp` marks a constructor *parameter property* (`constructor(private x: T)`):
// the parser desugars it into a class field + a `this.x = x` init in the ctor body.
export interface Param { name: string; annot?: Ty; default?: Expr; rest?: boolean; paramProp?: boolean; }

export interface Declarator { name: string; annot?: Ty; init: Expr; ty?: Ty; }
export interface VarDecl {
  kind: "VarDecl";
  declKind: "let" | "const";
  decls: Declarator[];
}

export interface FuncDecl {
  kind: "FuncDecl";
  name: string;
  params: Param[];
  returnAnnot?: Ty;
  body: Stmt[];
  returnTy?: Ty; // resolved
  endDrops?: string[]; // owned linear locals to free at fall-through exit
  // M3: declared type parameters (`function f<T, U>(…)`). A decl carrying these is a
  // TEMPLATE — it is never checked or emitted itself; the checker replaces it with one
  // fully-concrete specialization per distinct instantiation (see `monomorphize`).
  typeParams?: string[];
  /** Decorators lane: a COPY-ON-WRITE setter lowered from an ordinary (undecorated)
   *  class method that assigns `this.f`. Codegen rebinds `this` to a fresh shallow copy
   *  of the receiver on entry, so the caller's instance is unchanged and the method's
   *  `return this` hands back the NEW instance. `@@mutable` classes never set it —
   *  their setters mutate the receiver in place. See docs/decorators.md. */
  copyThis?: boolean;
  /** Decorators lane: this class method ASSIGNS a field (`this.f = …` / `this.f++`) —
   *  a "setter". For an `@@mutable` class that is real in-place mutation, so the
   *  ownership pass requires the receiver to be OWNED (Rust's `&mut self`). */
  setter?: boolean;
  /** Decorators lane: `this` must not be move-tracked in this frame — it is either the
   *  method's own private copy (copy-on-write setter) or a borrow it legitimately hands
   *  straight back (`return this` from a decorated constructor / an `@@mutable` method). */
  untrackThis?: boolean;
}

export interface ReturnStmt { kind: "ReturnStmt"; argument: Expr | null; drops?: string[]; }

/**
 * BLOCK-SCOPED drops (B2 step 4). A nested statement list (an `if` arm, a loop body, a
 * `switch` case, a `try` block) owns the linear locals it declares directly, and frees
 * them at its own fall-through exit — the RAII scope exit, one level down from
 * `FuncDecl.endDrops`. Every block-owning statement already holds a plain `Stmt[]`, so
 * the set is attached to the LIST rather than adding a field to a dozen statement kinds.
 * `structuredClone` (generic specialization) runs BEFORE ownership, so nothing is lost.
 */
export function setBlockDrops(list: Stmt[], names: string[]): void {
  (list as Stmt[] & { blockDrops?: string[] }).blockDrops = names;
}
export function blockDrops(list: Stmt[]): string[] {
  return (list as Stmt[] & { blockDrops?: string[] }).blockDrops ?? [];
}
export interface IfStmt { kind: "IfStmt"; test: Expr; consequent: Stmt[]; alternate: Stmt[] | null; }
export interface WhileStmt { kind: "WhileStmt"; test: Expr; body: Stmt[]; }
export interface DoWhileStmt { kind: "DoWhileStmt"; body: Stmt[]; test: Expr; }
export interface ForStmt {
  kind: "ForStmt";
  init: VarDecl | Expr | null;
  test: Expr | null;
  update: Expr | null;
  body: Stmt[];
}
/**
 * `for (const x of it)`, plus the Map-entries form `for (const [k, v] of m)` /
 * `of m.entries()`: `name2` holds the value binding and the checker rewrites
 * `iterable` to the MAP itself (the loop walks its insertion-ordered keys and
 * looks each value up — no tuple type required).
 */
export interface ForOfStmt { kind: "ForOfStmt"; name: string; annot?: Ty; iterable: Expr; body: Stmt[]; elemTy?: Ty; name2?: string; valTy?: Ty; }
export interface ForInStmt { kind: "ForInStmt"; name: string; object: Expr; body: Stmt[]; }
export interface SwitchCase { test: Expr | null; body: Stmt[]; } // test null === default
export interface SwitchStmt { kind: "SwitchStmt"; discriminant: Expr; cases: SwitchCase[]; }
export interface ThrowStmt { kind: "ThrowStmt"; argument: Expr; }
export interface TryStmt { kind: "TryStmt"; block: Stmt[]; param: string | null; handler: Stmt[] | null; finalizer: Stmt[] | null; catchTy?: Ty; }
export interface ExprStmt { kind: "ExprStmt"; expr: Expr; }
export interface BlockStmt { kind: "BlockStmt"; body: Stmt[]; }
/** Transparent group (NOT a scope) — flattened inline. Used for desugaring. */
export interface MultiStmt { kind: "MultiStmt"; stmts: Stmt[]; }
export interface BreakStmt { kind: "BreakStmt"; }
export interface ContinueStmt { kind: "ContinueStmt"; }

/* ---- modules (SH1) -------------------------------------------------------
 * A module's import/export surface lives OUTSIDE the statement stream: `import`
 * declarations bind names, they do not execute, and `export` is a marker on an
 * ordinary declaration. The linker (src/modules.ts) reads these, resolves the
 * graph from the entry file, and merges every module into ONE Program (with
 * per-module renaming) — so the checker/ownership/codegen passes never see a
 * module at all. Type-only imports/exports are erased here, not later.
 */

/**
 * One `{ imported as local }` binding of an import clause. `typeOnly` marks a
 * binding that exists only in type space (`import type { T }`, or an inline
 * `import { type T, x }`): it seeds the importer's type aliases but binds no value.
 */
export interface ImportSpec { imported: string; local: string; typeOnly?: boolean; }

/** `import { a, b as c } from "./m.ts"` — `specs` empty ⇒ side-effect-only import. */
export interface ImportDecl { source: string; specs: ImportSpec[]; line: number; }

/**
 * A module's export table. `values` maps an exported name to the LOCAL name that
 * backs it (`export { a as b }` ⇒ b→a); `reexports` maps an exported name to a
 * binding in another module (`export { x } from "./y.ts"`); `types` carries the
 * erased type-level exports (`export type`/`interface`/`class`) so an importing
 * module's annotations resolve to the same shape.
 */
export interface ExportTable {
  values: Map<string, string>;
  reexports: Map<string, { source: string; imported: string; line: number }>;
  types: Map<string, Ty>;
}

export interface Program {
  kind: "Program";
  body: Stmt[];
  endDrops?: string[];
  /** Present only when the source declared imports (the linker's input). */
  imports?: ImportDecl[];
  exports?: ExportTable;
  /** Class names carrying the `@@mutable` compile-time attribute (decorators lane).
   *  Present only when the source used the attribute. A mutable class's instances
   *  mutate IN PLACE, so the ownership pass treats their bindings differently
   *  (alias-not-move + owner-only mutation) — see docs/decorators.md. */
  mutableClasses?: string[];
}
