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

export interface Loc { line: number; col: number; }
export interface Identifier { kind: "Identifier"; name: string; ty?: Ty; loc?: Loc; }

export interface MemberExpr {
  kind: "MemberExpr";
  object: Expr;
  property: string;
  optional?: boolean; // `?.` optional-chaining link (A2)
  ty?: Ty;
}

/** obj[expr] element access */
export interface IndexExpr { kind: "IndexExpr"; object: Expr; index: Expr; ty?: Ty; }

export type UnaryOp = "-" | "+" | "!" | "~" | "void";
export interface UnaryExpr { kind: "UnaryExpr"; op: UnaryOp; operand: Expr; ty?: Ty; }

/** ++x / x++ / --x / x-- */
export interface UpdateExpr {
  kind: "UpdateExpr";
  op: "++" | "--";
  prefix: boolean;
  target: string;
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

export interface CallExpr { kind: "CallExpr"; callee: Expr; args: Expr[]; ty?: Ty; }
export interface NewExpr { kind: "NewExpr"; callee: string; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; }
export interface AsExpr { kind: "AsExpr"; expr: Expr; ty: Ty; } // `expr as Type` — identity retype

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
}

export interface ReturnStmt { kind: "ReturnStmt"; argument: Expr | null; drops?: string[]; }
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

export interface Program { kind: "Program"; body: Stmt[]; endDrops?: string[]; }
