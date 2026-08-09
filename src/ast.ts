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

/**
 * The array encoding is a SUFFIX (`${elem}[]`), and it is the only one that is — every
 * sibling predicate anchors at the front (`{`/`U<`/`@`/`Map<`/`?U`). So `isArrayTy` is
 * the only one a FUNCTION type can be mistaken for: `() => number[]` is encoded
 * `()=>number[]`, which ends with `[]`. It did, and the cost was a wild free —
 * `isLinearTy` (src/ownership.ts) put the closure in the scope's drop set and
 * `emitDrops` (src/codegen.ts) reclaimed the `nt_obj_new` slot block with
 * `nt_arr_free`, which reads slots 2 and 3 PAST THE END of it and `free()`s them.
 * `const g = () => arr` died with exit 255 and no output. See
 * test/arrow-returns-array.test.ts.
 *
 * `isFuncTy` is depth-aware (`topArrow`), so an ARRAY OF FUNCTIONS — `((n)=>number)[]`,
 * whose `=>` is nested inside the parens — is still an array, and a function returning
 * one (`()=>((n)=>number)[]`) is still a function. The check only runs for a type that
 * already ends with `[]`, and short-circuits on the leading `(`.
 */
export function isArrayTy(t: Ty): boolean {
  return typeof t === "string" && t.endsWith("[]") && !isNullableTy(t) && !isFuncTy(t);
}
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

/*
 * Character classes, spelled out — the same discipline as `src/lexer.ts`. nativets has no
 * `RegExp` (docs/divergences.md), so the compiler's own source may not use one. Kept local
 * to the module rather than shared, so the import graph the bootstrap measurement walks is
 * unchanged. `test/no-regex.test.ts` pins each against the regex it replaced.
 */
/** `[A-Za-z_$]`. */
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}
/** `[A-Za-z0-9_$]` (= `[\w$]`). */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}
/** `^[A-Za-z_$][\w$]*$` — is the WHOLE of `s` a plain identifier? */
function isIdentifier(s: string): boolean {
  if (s.length === 0 || !isIdentStart(s[0]!)) return false;
  for (let i = 1; i < s.length; i++) if (!isIdentPart(s[i]!)) return false;
  return true;
}

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
  return isIdentifier(tag) ? tag : undefined;
}
export function isObjectTy(t: Ty): boolean {
  if (typeof t !== "string" || isNullableTy(t) || t.endsWith("[]")) return false;
  const i = t.indexOf("{");
  if (i < 0 || !t.endsWith("}")) return false;
  return i === 0 || isIdentifier(t.slice(0, i)); // untagged literal or class-tagged
}
/** Parse an object type into ordered [key, type] fields (nesting-aware; tag-tolerant). */
export function objectFields(t: Ty): { key: string; ty: Ty }[] {
  // A NON-object answers with the empty field list, not with garbage. Without this guard
  // the slicing below runs on a string that has no `{`: `objectFields("number")` returned
  // `[{key:"numb", ty:"numbe"}]` and `objectFields("@N")` returned `[{key:"", ty:"@"}]` —
  // a PHANTOM one-field record. Callers use `.length` as an allocation size and
  // `fieldIndex` (-1 when the key is absent) as a `getelementptr` offset, so a phantom
  // field is a one-slot `nt_obj_new` for an N-field record and a gep into the malloc
  // header. Every caller happens to guard with `isObjectTy` today, which is why this has
  // never fired; it is a landmine under any new encoding that is not an object type.
  const open = t.indexOf("{");
  if (open < 0 || !t.endsWith("}")) return [];
  const inner = t.slice(open + 1, -1);
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
 * Discriminated (tagged) unions — SH2, "the crux" of self-hosting.
 *
 * A union of object types with a common LITERAL-typed discriminant field is
 * encoded `U<{k:"a",…}|{k:"b",…}>`. The `U<` prefix / `>` suffix keep it distinct
 * from every other encoding: it does not end in `}` (so `isObjectTy`/`classTag`
 * miss it), not in `[]`, does not start with `(`/`?U`/`?N`/`Map<`/`Set<`.
 *
 * REPRESENTATION: a union value IS the member object pointer — there is no box.
 * The tag already lives in the value as the discriminant field, so a union is only
 * accepted when that field sits at the SAME slot index in every member (checked by
 * `unionDiscriminant`). Consequences: `u.kind` on an un-narrowed union is an
 * ordinary slot load, narrowing is a pure retype costing nothing at runtime, and
 * literals / slots / drop are the existing object machinery unchanged.
 *
 * STRING-LITERAL TYPES (`"square"`) exist ONLY to carry those tags. They are
 * `widenLiteralTys`'d to `string` the moment a member type escapes the union — at
 * narrowing, at a field read, and at every non-union annotation — so no pass past
 * the checker ever sees one, and `type Dir = "n" | "s"` still collapses to `string`
 * exactly as before.
 * ============================================================ */

/** A string-literal type, e.g. `"square"` (quotes included). */
export function isStringLitTy(t: Ty): boolean {
  return typeof t === "string" && t.length >= 2 && t.startsWith(`"`) && t.endsWith(`"`) && !t.slice(1, -1).includes(`"`);
}
/** The VALUE of a string-literal type (`"square"` → `square`). */
export function stringLitValue(t: Ty): string { return t.slice(1, -1); }
/** Make the literal type for a string value. */
export function stringLitTy(v: string): Ty { return `"${v}"` as Ty; }
/**
 * Characters a tag value may not contain: the type encoding is a flat string split
 * structurally (`splitTopLevel` knows nothing about quotes), so a tag carrying one
 * of these would corrupt every downstream parse. Rejected with a diagnostic rather
 * than mis-split — see the parser.
 */
const TAG_FORBIDDEN = ",{}<>|[]()\"\\"; // the class `[,{}<>|[\]()"\\]`, as a character set
export function tagValueIsEncodable(v: string): boolean {
  for (let i = 0; i < v.length; i++) if (TAG_FORBIDDEN.includes(v[i]!)) return false;
  return true;
}

export function isUnionTy(t: Ty): boolean { return typeof t === "string" && t.startsWith("U<") && t.endsWith(">"); }
export function unionMembers(t: Ty): Ty[] { return splitTopLevel(t.slice(2, -1), "|") as Ty[]; }
export function makeUnionTy(members: Ty[]): Ty { return `U<${members.join("|")}>` as Ty; }

/* ============================================================
 * GENERAL unions — arms that are not all object types, so nothing INSIDE the value
 * can tell them apart. Encoded `G<a|b>`, deliberately a DIFFERENT prefix from the
 * discriminated `U<…>`: a `U<…>` value is the bare member pointer, so sharing the
 * prefix would let every existing `isUnionTy` site apply unboxed-object logic to
 * what is in fact a box, which is a miscompile rather than an error.
 *
 * REPRESENTATION: a 2-slot heap block [tag, value] — the same shape as the A2
 * nullable box — where `tag` is the member's index in the CANONICAL member order
 * and `value` is the arm packed by the ordinary `toSlot`. The tag is an index, so
 * the order is load-bearing at runtime: members are SORTED and de-duplicated by
 * `makeGeneralUnionTy`, which makes `number | string` and `string | number` the
 * same `Ty` with the same tag numbering (`===` stays type comparison, and a value
 * can cross between the two spellings without renumbering).
 * ============================================================ */
export function isGeneralUnionTy(t: Ty): boolean { return typeof t === "string" && t.startsWith("G<") && t.endsWith(">"); }
export function generalUnionMembers(t: Ty): Ty[] { return splitTopLevel(t.slice(2, -1), "|") as Ty[]; }
/** Canonicalize: de-duplicate and sort, so member order never depends on spelling. */
export function makeGeneralUnionTy(members: Ty[]): Ty {
  return `G<${[...new Set(members)].sort().join("|")}>` as Ty;
}
/** The tag a member carries in `t`, or -1 when it is not a member. */
export function generalUnionTagOf(t: Ty, member: Ty): number { return generalUnionMembers(t).indexOf(member); }
/**
 * What `typeof` reports for a value of this static type — the ONLY discriminant a
 * general union has, so it is also what decides whether one can be represented.
 */
export function typeofTagOf(t: Ty): string {
  if (t === "number" || t === "string" || t === "boolean") return t;
  return "object";
}
/**
 * An arm a general union may carry. Kept deliberately narrow: only shapes whose
 * `typeof` is a compile-time constant AND whose value round-trips through the
 * box's `toSlot`/`fromSlot` unchanged. Nullables are excluded — `T | undefined`
 * is already its own encoding and nesting the two boxes would give a value two
 * different representations.
 */
export function isGeneralUnionArm(t: Ty): boolean {
  return t === "number" || t === "string" || t === "boolean" || isArrayTy(t);
}

/**
 * The discriminant of a union: a field that is present at the SAME index in every
 * member, string-literal-typed in every member, with a DISTINCT value per member.
 * `undefined` when no such field exists — which is exactly when the union cannot be
 * represented (and so is refused, never guessed at).
 */
export function unionDiscriminant(t: Ty): { key: string; index: number } | undefined {
  const members = unionMembers(t);
  if (members.length < 2) return undefined;
  const first = objectFields(members[0]!);
  for (let i = 0; i < first.length; i++) {
    const key = first[i]!.key;
    const values = new Set<Ty>();
    let ok = true;
    for (const m of members) {
      const f = objectFields(m)[i];
      if (!f || f.key !== key || !isStringLitTy(f.ty)) { ok = false; break; }
      values.add(f.ty);
    }
    if (ok && values.size === members.length) return { key, index: i };
  }
  return undefined;
}

/** Every tag value of a union, in declaration order (drives exhaustiveness). */
export function unionTagValues(t: Ty): string[] {
  const d = unionDiscriminant(t);
  if (!d) return [];
  return unionMembers(t).map((m) => stringLitValue(objectFields(m)[d.index]!.ty));
}

/** The (widened) member selected by a tag value — the result of narrowing. */
export function unionMemberFor(t: Ty, tag: string): Ty | undefined {
  const d = unionDiscriminant(t);
  if (!d) return undefined;
  const m = unionMembers(t).find((m) => objectFields(m)[d.index]!.ty === stringLitTy(tag));
  return m === undefined ? undefined : widenLiteralTys(m);
}

/** Every member of a union as it is seen OUTSIDE it (literal tags widened). */
export function unionWidenedMembers(t: Ty): Ty[] { return unionMembers(t).map(widenLiteralTys); }

/**
 * Replace every string-literal type with `string`, EXCEPT inside a nested `U<…>`
 * (whose members must keep their tags to stay narrowable). Applied wherever a type
 * leaves union space, so a literal type never reaches ownership or codegen.
 */
export function widenLiteralTys(t: Ty): Ty {
  if (typeof t !== "string" || !t.includes(`"`)) return t;
  let out = "";
  for (let i = 0; i < t.length; ) {
    if (t.startsWith("U<", i)) {
      const end = matchAngle(t, i + 1);
      out += t.slice(i, end + 1);
      i = end + 1;
    } else if (t[i] === `"`) {
      const close = t.indexOf(`"`, i + 1);
      if (close < 0) { out += t.slice(i); break; }
      out += "string";
      i = close + 1;
    } else {
      out += t[i];
      i++;
    }
  }
  return out as Ty;
}
/** Index of the `>` closing the `<` at `open`. */
function matchAngle(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "<") depth++;
    else if (s[i] === ">" && --depth === 0) return i;
  }
  return s.length - 1;
}

/* ============================================================
 * RECURSIVE types — the nominal back-edge (`@Name`).
 *
 * `Ty` is a flat structural string, so a type that contains itself has no finite
 * structural encoding: substituting the shape for the name never terminates. That is what
 * NT1030 has been reporting, and it is what gates src/ast.ts (a 44-declaration mutual
 * cycle) and src/checker.ts (`class Scope { parent: Scope | null }`, self-recursive).
 *
 * The encoding is NOMINAL and applies to the recursive POSITION only: a declaration in a
 * cycle keeps its structural shape at the top level and encodes the back-edge as a
 * reference, `@Name`, whose shape lives in a table carried on the `Program`.
 *
 *     interface N { v: number; next?: N }   ->   {v:number,next:?U@N}
 *     class Scope { parent: Scope | null }  ->   Scope{parent:?N@Scope}
 *
 * Three properties this buys, and they are the whole argument for it over the
 * alternatives (arena ids; equirecursive mu-types):
 *
 *   1. `Ty` stays a STRING and `===` stays type comparison. That assumption is load-bearing
 *      at ~400 sites and nothing else preserves it.
 *   2. No `Ty` contained `@` before this, so `@N` matches NONE of the existing structural
 *      predicates. A type that is not recursive keeps its EXACT previous encoding, so this
 *      is additive rather than a rewrite — and a `@N` that reaches a site which has not
 *      been taught about it fails loudly instead of being mistaken for something else.
 *   3. It is finite and small. A depth-limited structural expansion of src/ast.ts's `Stmt`
 *      grows ~4x per level (5.8e6 chars by depth 9) and is unsound past the limit; a
 *      canonical mu-encoding needs DFA minimization to keep `===` correct and still leaves
 *      a ~40 KB string compared on every type test.
 *
 * The cost, stated: recursive types become NOMINAL, so two structurally identical recursive
 * declarations are not interchangeable the way tsc says they are. That is a refusal, never a
 * miscompile — see docs/divergences.md.
 *
 * INVARIANT: `@Name` appears only NESTED inside a shape (a field type, an element type). A
 * value's own static type is always the expanded shape, so every pass that reasons about a
 * value sees an ordinary object type. The reference is unfolded on demand — exactly when a
 * field carrying one is read — which terminates because each unfold is driven by a real
 * source-level access.
 * ============================================================ */

/** The nominal reference for a recursive declaration (`N` -> `@N`). */
export function typeRefTy(name: string): Ty { return `@${name}` as Ty; }
/** Is `t` EXACTLY a nominal type reference (`@N`, not `@N[]`)? */
export function isTypeRefTy(t: Ty): boolean {
  return typeof t === "string" && t.startsWith("@") && isIdentifier(t.slice(1));
}
/** The declaration name a reference points at (`@N` -> `N`). */
export function typeRefName(t: Ty): string { return t.slice(1); }
/** Does `t` mention a nominal reference anywhere (`?U@N`, `@N[]`, `{a:@N}`)? */
export function hasTypeRef(t: Ty): boolean { return typeof t === "string" && t.includes("@"); }
/**
 * Unfold ONE level: replace a bare `@N` with the shape it names. Identity on everything
 * else, including a type that merely CONTAINS a reference — unfolding those eagerly is what
 * would not terminate. An unknown name is left alone rather than guessed at; it then fails
 * loudly at whichever site needed the shape, which is the point of property 2 above.
 */
export function expandTypeRef(t: Ty, table: Map<string, Ty>): Ty {
  return isTypeRefTy(t) ? (table.get(typeRefName(t)) ?? t) : t;
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

/** The marker type for type parameter `name` (`T` → `#T`). */
export function typeParamTy(name: string): Ty { return `#${name}` as Ty; }
/** Is `t` EXACTLY a bare type parameter (`^#[A-Za-z_$][\w$]*$` — `#T`, not `#T[]`)? */
export function isTypeParamTy(t: Ty): boolean {
  return typeof t === "string" && t.startsWith("#") && isIdentifier(t.slice(1));
}

/**
 * Rewrite every `#Name` marker in `t`, left to right, exactly as `/#([A-Za-z_$][\w$]*)/g`
 * did: non-overlapping, replacements are never rescanned, and a `#` not followed by an
 * identifier start is left alone (the scan resumes at the very next character, so `##T`
 * still rewrites the SECOND `#T`). A bound marker becomes its binding; an UNBOUND one
 * becomes `number` when `eraseUnbound`, and is otherwise left as the marker.
 *
 * Deliberately a `Map` + a flag rather than a rename CALLBACK: a callback returning
 * `string | undefined` would need a nullable-returning function type, which nativets does
 * not accept at a call site (it rejects a plain `(s) => string` argument against it). That
 * would have planted a self-hosting blocker BEHIND ast.ts's current one, where the
 * bootstrap ratchet could not see it. Concrete types only.
 */
const EMPTY_BINDINGS = new Map<string, Ty>();
function mapTypeParams(t: string, bindings: Map<string, Ty>, eraseUnbound: boolean): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (t[i] !== "#" || i + 1 >= t.length || !isIdentStart(t[i + 1]!)) {
      out += t[i];
      i++;
      continue;
    }
    let j = i + 1;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const bound = bindings.get(t.slice(i + 1, j));
    out += bound ?? (eraseUnbound ? "number" : t.slice(i, j));
    i = j;
  }
  return out;
}
/** Does `t` mention any type parameter anywhere (`#T[]`, `(#T)=>#U`, `{a:#T}`)? */
export function hasTypeParam(t: Ty): boolean { return typeof t === "string" && t.includes("#"); }
/** Substitute bound type parameters through `t`; unbound ones are left as markers. */
export function substTypeParams(t: Ty, bindings: Map<string, Ty>): Ty {
  if (!hasTypeParam(t)) return t;
  return mapTypeParams(t, bindings, false) as Ty;
}
/** Erase any REMAINING type parameters to `number` (the pre-M3 fallback, kept for
 *  generic ARROWS, which are values and so have no instantiation site to specialize). */
export function eraseTypeParams(t: Ty): Ty {
  return hasTypeParam(t) ? (mapTypeParams(t, EMPTY_BINDINGS, true) as Ty) : t;
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
const TY_FIELDS = new Set(["annot", "ty", "returnAnnot", "retAnnot", "retTy", "catchTy", "elemTy"]);
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

/**
 * Rewrite every read of a STATIC field — `C.f` on a bare class name — into the plain
 * Identifier `C.f`, the module-level `const` the parser lowered it to.
 *
 * This runs at the END of parsing, before any analysis, and that is the point: a static
 * field is not a slot on a receiver, it is a module binding, so every pass that reasons
 * about NAMES (globals promotion, closure capture, ownership) has to see an identifier or
 * it does not see the read at all. No source identifier can contain a `.`, so the dotted
 * name is unambiguous. Reflective, like `mapTypesDeep` — a rewrite that must not miss a
 * position is safer written once over the object graph than per node kind.
 *
 * A `?.` link is left alone (rewriting it would silently drop the optional; a class name
 * is never nullish, so the read is rejected instead).
 */
export function resolveStaticFieldReads(n: unknown, names: Set<string>, onAssign?: (name: string) => never): void {
  if (!n || typeof n !== "object") return;
  const o = n as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (!v || typeof v !== "object") continue;
    // One flat view of the two node shapes this pass cares about. Deliberately NOT
    // `Partial<MemberExpr> & {…}`: an intersection type is outside the subset nativets
    // compiles, and this file is part of the compiler's own source (docs/self-hosting.md).
    const e = v as { kind?: string; optional?: boolean; property?: string; field?: string; object?: { kind?: string; name?: string } };
    const head = e.object?.kind === "Identifier" ? e.object.name : undefined;
    if (head === undefined) { resolveStaticFieldReads(v, names, onAssign); continue; }
    // `C.f = v` — a WRITE to a static field. Not a read, so never rewritten; the caller
    // refuses it by name (a static field lowers to a `const`).
    if (onAssign && e.kind === "FieldAssign" && names.has(`${head}.${e.field}`)) onAssign(`${head}.${e.field}`);
    if (e.kind === "MemberExpr" && !e.optional && names.has(`${head}.${e.property}`)) {
      o[k] = { kind: "Identifier", name: `${head}.${e.property}` } as Identifier;
      continue;
    }
    resolveStaticFieldReads(v, names, onAssign);
  }
}

/**
 * Every name the program BINDS — declarations, function/arrow parameters, loop and catch
 * bindings. Used to protect the static-field rewrite above: that rewrite is name-based and
 * has no scope, so a binding that shadows a class name would silently redirect `C.f` to
 * the class's static instead of the shadowing value. Collecting the binders lets the
 * parser refuse that program outright rather than answer it wrongly.
 */
export function collectBindingNames(n: unknown, out: Set<string>): void {
  if (!n || typeof n !== "object") return;
  const o = n as Record<string, unknown>; // no intersection type: see `resolveStaticFieldReads`
  const params = o.params as { name?: string }[] | undefined;
  if (params && Array.isArray(params)) for (const p of params) if (p?.name) out.add(p.name);
  switch (o.kind as string | undefined) {
    case "VarDecl": for (const d of o.decls as { name: string }[]) out.add(d.name); break;
    case "FuncDecl": out.add(o.name as string); break;
    case "ForOfStmt": out.add(o.name as string); if (o.name2) out.add(o.name2 as string); break;
    case "ForInStmt": out.add(o.name as string); break;
    case "TryStmt": if (o.param) out.add(o.param as string); break;
  }
  for (const k of Object.keys(o)) collectBindingNames(o[k], out);
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
  | SatisfiesExpr
  | NonNullExpr
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
  | ContinueStmt
  | BlockDropsStmt;

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
  /** Control-flow narrowing: the checker proved that on THIS path the binding — whose
   *  declared type is a nullable `?U`/`?N` pair — is not nullish, so `ty` above is the
   *  BASE type and codegen must unwrap the tagged pair at this read (same unwrap as
   *  `x!`). Set on every read, so a stale `true` from an earlier typing pass cannot
   *  survive. */
  narrowed?: boolean;
}

export interface MemberExpr {
  kind: "MemberExpr";
  object: Expr;
  property: string;
  optional?: boolean; // `?.` optional-chaining link (A2)
  ty?: Ty;
  /** Set by the parser on a field read the programmer actually wrote (the `.` token).
   *  Two consumers: the "possibly undefined" diagnostic points here, and a NARROWED
   *  read (below) unwraps with this location so a wrong proof panics where it was used. */
  loc?: Loc;
  /** Control-flow narrowing of a DOTTED NAME — the same flag `Identifier` carries, for
   *  the same reason: `ty` above is the BASE type and codegen must unwrap the tagged
   *  pair at this read. Written on every read, so a stale `true` cannot survive. */
  narrowed?: boolean;
}

/** obj[expr] element access */
/**
 * `obj[i]`. `loc` is set ONLY by the parser, on an index the programmer actually wrote —
 * that is exactly the set of reads whose out-of-range access must PANIC (and the location
 * the panic reports). Desugarings that synthesize an IndexExpr (destructuring, spread-call
 * expansion) leave it undefined and keep the internal, non-panicking accessor.
 */
/** `optional` marks the `?.[i]` spelling: the BASE is guarded, so a nullish base
 *  short-circuits the whole chain to `undefined` WITHOUT evaluating `index`. It says
 *  nothing about the index rule — a present base out of range panics exactly as `a[i]`
 *  does (Stage 41). */
export interface IndexExpr { kind: "IndexExpr"; object: Expr; index: Expr; optional?: boolean; ty?: Ty; loc?: Loc; }

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
 * Field assignment `o.field = expr` — a static slot store on the receiver.
 *
 * The parser emits it for EVERY `member = value` target and defers the legality question
 * to the checker, which knows types. Two things may legitimately be assigned:
 *   - `this.f` inside a class member body — a constructor building the instance, or a
 *     setter method (`viaThis`, vetted syntactically by the parser);
 *   - a field of a `@@mutable` record or class instance (nominal, by tag).
 * Everything else is NT1606 (values are immutable — Stage 29). WHO may mutate is a
 * separate, ownership question, answered by src/ownership.ts (NT1607).
 */
export interface FieldAssign {
  kind: "FieldAssign"; object: Expr; field: string; value: Expr; ty?: Ty;
  /** The parser proved this is `this.f = v` inside a member body where that is legal. */
  viaThis?: boolean;
  /**
   * The DEFINITIONAL store of a constructor parameter property (`constructor(readonly d: T)`
   * desugars to a field plus `this.d = d`). It is the one assignment in the language that
   * does not move its value out of the enclosing scope: the parameter is CONSUMING, so the
   * value it names arrived owned by this object and the caller already gave it up.
   * src/ownership.ts reads this to keep the store from being a move-out-of-borrow (NT1604).
   */
  paramProp?: boolean;
}

export interface TypeofExpr { kind: "TypeofExpr"; operand: Expr; ty?: Ty; }

// `typeArgs` are EXPLICIT call-site type arguments (`id<string>("x")`) — they pin the
// instantiation of a generic callee instead of inferring it from the argument types.
export interface CallExpr { kind: "CallExpr"; callee: Expr; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; loc?: Loc; }
export interface NewExpr { kind: "NewExpr"; callee: string; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; }
export interface AsExpr { kind: "AsExpr"; expr: Expr; ty: Ty; } // `expr as Type` — identity retype
/**
 * `expr satisfies Type` — CHECKED but never ADOPTED. `as` replaces the expression's
 * type with `ty`; `satisfies` only proves assignability to `ty` and leaves the
 * expression's own inferred type in place, which is the entire reason the operator
 * exists. Erases at codegen, exactly like `as`.
 */
export interface SatisfiesExpr { kind: "SatisfiesExpr"; expr: Expr; ty: Ty; }
/**
 * `expr!` — TypeScript's NON-NULL ASSERTION. Unlike `as`, it is not an identity: it
 * NARROWS `T | undefined` / `T | null` to `T`, which is the whole reason it exists and
 * why erasing it is not enough (`const v: number = m.get(k)!` must typecheck). On a
 * value that is not nullable it IS the identity. `loc` drives the runtime panic when the
 * assertion is false — see the codegen comment.
 */
export interface NonNullExpr { kind: "NonNullExpr"; expr: Expr; loc?: Loc; }

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
  /** The DECLARED return type as written — `(x): T => …`. `parseArrow` used to parse this
   *  and discard it (keeping only "was it a `Promise<…>`" for the async bookkeeping), so
   *  nothing downstream could compare it against the body and an arrow's annotation was
   *  the one return type in the language that was never checked. Keeping it lets the
   *  checker do for an arrow what it already does for a `function`/method: use it as the
   *  body's CONTEXT and reject a body that does not fit (NT2001). */
  retAnnot?: Ty;
  retTy?: Ty;
  captures?: { name: string; ty: Ty }[];
  liftedName?: string; // @arrow_N assigned during codegen
}

// `paramProp` marks a constructor *parameter property* (`constructor(private x: T)`):
// the parser desugars it into a class field + a `this.x = x` init in the ctor body.
export interface Param { name: string; annot?: Ty; default?: Expr; rest?: boolean; paramProp?: boolean; }

/*
 * `init` is OPTIONAL, and its absence means a bare `let x: T;` — a declaration with no
 * initializer at all. This used to be non-optional, and the parser synthesized an
 * `UndefinedLiteral` to fill it, which made `let s: string;` (legal) and
 * `let s: string = undefined;` (correctly rejected) indistinguishable downstream: both
 * were NT2001. Keeping the absence REPRESENTABLE is what lets the checker run
 * definite-assignment analysis on the first and still reject the second.
 *
 * A consumer that merely WALKS the initializer should skip an absent one. Codegen, which
 * needs a VALUE, stores the slot's `defaultZero` instead — the checker has by then proved
 * the binding is assigned before any read, so that zero is never observed.
 *
 * `annotHead` is the annotation's leading identifier AS WRITTEN (`Record`, `Map`, an
 * alias name). `annot` is the ERASED type, so the two differ wherever a utility type maps
 * onto a supported shape — and a diagnostic that prints only the erasure names a type the
 * user never typed. Diagnostics only; nothing lowers from it.
 */
export interface Declarator { name: string; annot?: Ty; annotHead?: string; init?: Expr; ty?: Ty; }
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
  /** A `static` class member: `C.m(…)` lowered WITHOUT the leading `this` parameter, so
   *  it is called through the class name (`C.m(a)`) and never through an instance. The
   *  flag is what separates it from the instance method of the same shape — both lower
   *  to a top-level `C.m`, and only this says which one a call site may reach. */
  isStatic?: boolean;
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
 * the set belongs to the LIST, not to a field on each of a dozen statement kinds.
 *
 * SYNTHESIZED, never parsed: the ownership pass appends one of these to the block whose
 * exit it describes, and codegen frees the names when it reaches it. Putting the drop
 * point IN the list makes it an ordinary node — it shows up in an AST dump, and a block
 * that already terminated (`return`/`break`/`continue`) skips it by the same rule that
 * skips any later statement, rather than by a second check spelled out in codegen.
 *
 * It used to be an expando property on the array, typed `Stmt[] & { blockDrops?… }`.
 * That was the only intersection type in the compiler's own source, and an array with
 * extra properties has no representation here (`NtArray` is a fixed 4-field struct), so
 * this file could not compile itself — the same constraint the note at `Partial<…> & {…}`
 * above records. `structuredClone` (generic specialization) runs BEFORE ownership, so
 * the marker is appended after the last clone and nothing is lost.
 */
export interface BlockDropsStmt { kind: "BlockDrops"; names: string[]; }

/**
 * Attach `names` as the block's fall-through drop set. IDEMPOTENT — it replaces an
 * existing marker rather than appending a second one, because `loop()` re-walks a loop
 * body up to five times to reach its fixpoint and each walk sets the set again. Five
 * appended markers would be five frees of the same value: a double free, not a leak.
 */
export function setBlockDrops(list: Stmt[], names: string[]): void {
  const last = list[list.length - 1];
  if (last !== undefined && last.kind === "BlockDrops") { last.names = names; return; }
  list.push({ kind: "BlockDrops", names });
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
/** `line`/`col` are the `throw` keyword's own position — codegen refuses a throw it cannot
 *  lower (one with no enclosing `try` in the same function) and has no other way to say
 *  WHICH throw, since the statement is otherwise position-free. */
export interface ThrowStmt { kind: "ThrowStmt"; argument: Expr; line?: number; col?: number; }
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
 * SH5 — a COMPILE-TIME text import: `import src from "./x.c" with { type: "text" }`.
 *
 * Not a module edge: the target is not TypeScript and is never parsed. The linker
 * reads it (relative to the importing file) and materializes `const <local> = "…"`,
 * a plain string constant, at the top of that module's body. So the identifier is an
 * ordinary `const string` by the time the checker runs, and the bytes end up in the
 * `.ll` as an interned string — no runtime file I/O, no `node:fs` dependency.
 *
 * `col` is carried alongside `line` because a bad attribute or an unreadable file is
 * reported at the `import` keyword, like every other module diagnostic.
 */
export interface TextImport { local: string; source: string; line: number; col: number; }

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
  /** Exported names declared `export async function` — `async` is ERASED, so an
   *  importing module cannot tell from the value alone. It has to, because calling
   *  one without `await` yields a Promise under node and a plain value here; the
   *  floating-async guard (NT1020) is seeded from this. */
  asyncValues: Set<string>;
}

/**
 * SH4 — the host FFI surface: the `node:` builtin modules a self-hosted nativets
 * needs to read a `.ts`, write a `.ll`, stat a path and invoke `clang`. A named
 * import binds the SAME-NAMED compiler builtin (so `readFileSync(p, "utf8")` is
 * ordinary TypeScript that node runs too), and the import is then erased.
 *
 * The list is deliberately exactly what `src/*.ts` imports — nothing speculative.
 * A module or member outside it is refused with NT1028, never half-implemented.
 * The signatures live in the checker (`HOST_FUNCS`) and the lowering in codegen.
 */
/* `string[]`, NOT `readonly string[]`: `src/*.ts` must stay inside the subset nativets
 * can compile ITSELF in, and a `readonly` type modifier does not parse — adding one here
 * made this file's first blocker an NT0001 in the self-host histogram. */
export const HOST_MODULES: Record<string, string[]> = {
  "node:fs": ["readFileSync", "writeFileSync", "existsSync", "mkdtempSync", "readdirSync", "rmSync"],
  "node:path": ["join", "dirname", "basename", "resolve", "relative"],
  "node:os": ["tmpdir", "homedir"],
  "node:url": ["fileURLToPath"],
  "node:child_process": ["spawnSync"],
};

export interface Program {
  kind: "Program";
  body: Stmt[];
  endDrops?: string[];
  /** Host builtins (SH4) this program imported from a `node:` module, by their
   *  CANONICAL name (an `as` alias is rewritten at parse time). A host builtin is
   *  only in scope when imported — unlike an ambient global — so user code that
   *  defines its own `join` is unaffected. */
  hostImports?: string[];
  /** Present only when the source declared imports (the linker's input). */
  imports?: ImportDecl[];
  /** `with { type: "text" }` imports (SH5). Present only when the source used one;
   *  the linker turns each into a `const` string and then they are gone. */
  textImports?: TextImport[];
  exports?: ExportTable;
  /** Class names carrying the `@@mutable` compile-time attribute (decorators lane).
   *  Present only when the source used the attribute. A mutable class's instances
   *  mutate IN PLACE, so the ownership pass treats their bindings differently
   *  (alias-not-move + owner-only mutation) — see docs/decorators.md. */
  mutableClasses?: string[];
  /** RECORD type names carrying `@@mutable` (`@@mutable type Cell = { n: number }`) — the
   *  extension of the class attribute to a `type`/`interface` declaration. Such a record is
   *  TAGGED with its name (`Cell{n:number}`), exactly like a class instance type, so the
   *  tag is what makes mutability nominal rather than structural. Everything downstream
   *  treats these tags exactly like `mutableClasses` — see `mutableTags`. */
  mutableRecords?: string[];
  /**
   * RECURSIVE type shapes, by declaration name — the table the `@Name` back-edge resolves
   * through (see "RECURSIVE types" above). `{ N: "{v:number,next:?U@N}" }`. Present only
   * when the source declared a recursive type, so every existing Program is byte-identical.
   *
   * On the `Program` rather than a module-level registry in this file, deliberately, for
   * two reasons. A module global would be shared across compilations in one process (the
   * test suite compiles hundreds), and — the binding one — nativets `Map`s are IMMUTABLE,
   * so a growing module-level table is not expressible in the subset this compiler must
   * eventually compile itself with. Putting it here would plant a self-hosting blocker in
   * the very module being unblocked. Every pass already receives the Program.
   */
  recTypes?: [string, Ty][];
}

/** The recursive-shape table as a lookup. Stored as pairs on the Program (JSON-shaped,
 *  and linker-mergeable); every consumer wants a Map. */
export function recTypeTable(p: Program): Map<string, Ty> {
  return new Map(p.recTypes ?? []);
}

/** Every tag whose values mutate in place: `@@mutable` classes AND `@@mutable` records.
 *  One concept downstream — the checker's field-assignment rule and the ownership pass's
 *  NT1607/NT1604/NT1602 read this and nothing else. */
export function mutableTags(p: Program): Set<string> {
  return new Set([...(p.mutableClasses ?? []), ...(p.mutableRecords ?? [])]);
}

/** Array-producing calls that mint a FRESH, unaliased array. A user function call is
 *  deliberately absent: it may return a module-level array the caller does not own. */
const FRESH_ARRAY_CALLS = new Set([
  "map", "filter", "slice", "concat", "with", "toSorted", "toReversed", "flat", "flatMap",
  "split", "keys", "values", "entries",
]);

/**
 * …and the array methods that return their RECEIVER rather than a fresh array — node's
 * in-place mutators. `.reverse` is the only one accepted; every other one
 * (`.push`/`.pop`/`.fill`/`.splice`/`.shift`/`.unshift`/`.copyWithin`) is refused with
 * NT1606, and `.sort` only survives by being rewritten to `.toSorted` on a fresh
 * receiver — which is exactly what keeps it from ever returning its receiver.
 *
 * Stated as a SET, and kept here beside `freshArray`, because THREE passes must agree on
 * it: the checker (result type is the receiver's), codegen (never free a retained
 * receiver temp), and the ownership pass (binding such a result makes an ALIAS, not a
 * second owner — otherwise it double-frees). One canonical copy; do not re-declare it.
 */
export const RETAINS_RECEIVER = new Set(["reverse"]);

/**
 * Does `e` evaluate to a NEWLY CONSTRUCTED array that nothing else aliases?
 *
 * The single source of truth for array freshness, used by two passes that must agree:
 * codegen frees a fresh receiver temporary after a method call, and the checker permits
 * `.sort()` on a fresh receiver (sorting storage with no other owner is unobservable —
 * see docs/divergences.md). Two copies of this judgment could drift into a codegen that
 * frees what the checker thinks is shared, so there is exactly one.
 *
 * Conservative and purely SYNTACTIC: an array literal (including a spread copy
 * `[...xs]`, which builds a new array) and the array-returning methods above. A plain
 * function call is NOT fresh — it may hand back an array the callee still owns.
 *
 * Freshness justifies `.sort` and NOTHING ELSE among the mutators. It is tempting to
 * extend it to `.push` — the reasoning does hold, since `e.push(x)` on a fresh `e` is
 * just `[...e, x].length` — but a fresh receiver is a temporary nothing can name, so
 * such a push is dead code (`[1,2].push(3)`) and permitting it buys no expressiveness
 * while adding an in-place path to the method that has already caused a double free and
 * a leak. The useful shape is `named.push(x)`, which is NOT fresh and must stay refused.
 * The accumulator `acc = [...acc, x]` covers it — see test/immutable.test.ts.
 *
 * A RETAINS_RECEIVER call PASSES freshness through rather than ending it: it hands back
 * the pointer it was given, so its result is unowned exactly when its receiver was.
 * `[1,2].reverse()` is still a temporary (codegen must free it; `.sort()` on it is still
 * unobservable), while `a.reverse()` is `a` itself — the recursion bottoms out at the
 * non-fresh Identifier, which is what stops either pass touching an owned binding.
 */
export function freshArray(e: Expr): boolean {
  if (e.kind === "ArrayLiteral") return true;
  if (e.kind === "CallExpr" && e.callee.kind === "MemberExpr") {
    if (FRESH_ARRAY_CALLS.has(e.callee.property)) return true;
    if (RETAINS_RECEIVER.has(e.callee.property)) return freshArray(e.callee.object);
  }
  return false;
}

/**
 * The nearest source location an expression can offer, for a diagnostic that would
 * otherwise have none.
 *
 * Only SOME node kinds carry a `loc` (Identifier, MemberExpr, IndexExpr, CallExpr, …) —
 * a literal or a binary operator does not — so `e.loc` alone is `undefined` for most
 * expressions and the diagnostics built from them came out unlocatable. That is not a
 * cosmetic problem: `[NT2001] return type string does not match declared number` with no
 * span, on a 4000-line file, cost a lane an instrumented build of the compiler to find
 * the line. Descending to the first child that DOES carry one is exact enough to jump to
 * (it is inside the offending expression) and always better than nothing.
 */
export function exprLoc(e: Expr | undefined): Loc | undefined {
  if (!e) return undefined;
  const own = (e as { loc?: Loc }).loc;
  if (own) return own;
  switch (e.kind) {
    case "BinaryExpr": case "LogicalExpr": return exprLoc(e.left) ?? exprLoc(e.right);
    case "UnaryExpr": return exprLoc(e.argument);
    case "AsExpr": case "SatisfiesExpr": case "NonNullExpr": return exprLoc(e.expr);
    case "ConditionalExpr": return exprLoc(e.test) ?? exprLoc(e.consequent) ?? exprLoc(e.alternate);
    case "TemplateLiteral": return e.exprs.map((x) => exprLoc(x)).find((l) => l !== undefined);
    case "ArrayLiteral": return e.elements.map((x) => exprLoc(x)).find((l) => l !== undefined);
    case "ObjectLiteral":
      return e.properties.map((p) => exprLoc(p.value)).find((l) => l !== undefined);
    default: return undefined;
  }
}

/**
 * The source text of an expression, for a diagnostic that has to NAME the thing it is
 * about. Deliberately partial: names, field reads, element reads and calls over those —
 * the shapes a "this value needs handling" message points at. Anything else returns
 * undefined and the caller says something generic, because the alternative (the old
 * `(e as any).name ?? "value"`) reported every dotted receiver as the word `value`, an
 * identifier that appears nowhere in the program being compiled.
 */
export function exprText(e: Expr): string | undefined {
  if (e.kind === "Identifier") return e.name;
  if (e.kind === "MemberExpr") {
    const o = exprText(e.object);
    return o === undefined ? undefined : o + (e.optional === true ? "?." : ".") + e.property;
  }
  if (e.kind === "IndexExpr") {
    const o = exprText(e.object);
    if (o === undefined) return undefined;
    if (e.index.kind === "NumberLiteral") return o + "[" + String(e.index.value) + "]";
    if (e.index.kind === "StringLiteral") return o + '["' + e.index.value + '"]';
    const i = exprText(e.index);
    return i === undefined ? undefined : o + "[" + i + "]";
  }
  if (e.kind === "NonNullExpr") {
    const x = exprText(e.expr);
    return x === undefined ? undefined : x + "!";
  }
  if (e.kind === "AsExpr" || e.kind === "SatisfiesExpr") return exprText(e.expr);
  if (e.kind === "CallExpr") {
    const c = exprText(e.callee);
    return c === undefined ? undefined : c + (e.args.length === 0 ? "()" : "(...)");
  }
  return undefined;
}
