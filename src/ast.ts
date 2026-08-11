/*
 * AST for the growing TypeScript subset.
 *
 * Types are tracked statically. Every Expr carries an optional `ty` the checker
 * fills in; codegen reads it to choose LLVM types/instructions.
 */

/**
 * Nominal type names with no structural marker. NOT "types that are a machine scalar" —
 * `Dyn` is a tagged heap box and `unknown` has no representation at all. What the arms
 * share is that each is recognized by plain string equality, which is why they live in one
 * union: `parseTypeAtom`'s `SCALARS` (src/parser.ts) is the smaller, genuinely-scalar set
 * and deliberately holds neither of those two.
 *
 * `"unknown"` IS TypeScript's `unknown`, as an OPAQUE PLACEHOLDER — a type-level name with
 * no machine representation and, in practice, no inhabitants. It is spelled as the bare
 * word so every diagnostic that interpolates a `Ty` prints the type the programmer
 * actually wrote. That is the whole point of it: `unknown` used to erase to `number` (see
 * `ERASURE_STILL_ALLOWED`, src/parser.ts), so a reflective walk written `f(node: unknown)`
 * was refused with `Cannot compare number with null` — a diagnostic naming a type its
 * source never contains, which sends the reader to fix the wrong thing.
 *
 * NOTHING ELSE CLAIMS IT, and that is what makes it safe. Every structural `Ty` predicate
 * anchors on a sigil (`{`, `U<`, `@`, `?U`/`?N`, `#`, a `[]` suffix), and the nominal ones
 * test exact names; `"unknown"` is in no `SCALARS`, `BuiltinTy` or container set. So it
 * falls off the end of every classifier, including `reprClass` (src/checker.ts), whose
 * documented answer for "no opinion" is `undefined` and whose caller refuses on it.
 * Assignability here is string equality, so ONLY another `unknown` is assignable to an
 * `unknown` slot — which means no value ever carries the type and codegen is never reached
 * with it.
 *
 * DO NOT give it a representation to "finish" it. A `Ty` that can hold a value needs a
 * runtime tag to narrow from, and the only tagged box this compiler has is `Dyn` — not a
 * candidate: `Dyn` refuses `d === null` and `Object.keys(d)`, ICEs on `typeof d` in value
 * position, is not spellable in source, and could only receive an AST node by DEEP-COPYING
 * it into a box tree, which would silently break the reference-identity sets
 * (`Set<object>`, the `seen` cycle guards) the ownership walks depend on. That is the
 * miscompile direction, so the placeholder stays uninhabited on purpose.
 */
export type ScalarTy =
  | "number" | "boolean" | "string" | "void" | "undefined" | "null" | "Dyn" | "unknown";
/**
 * The NOMINAL builtin types: reserved type names with no structural marker
 * (`{`/`[]`/`(`/`<`/`?`), so no structural predicate matches them and each is
 * recognized by plain string equality — `isBytesTy`, `isDateTy`, `isUrlTy`,
 * `isResponseTy` and friends below.
 *
 * These are arms of `Ty` and always were: the checker writes them into `Expr.ty`
 * and codegen switches on them. They were simply MISSING from the union, and
 * nothing noticed, because `tsc` had never semantically checked this project (see
 * `tsconfig.src.json` for why — `test/pipeline/*.ts` masked every type error in the
 * repo behind 16 syntax errors). With the mask lifted, their absence was 19 of the
 * 21 "the types have no overlap" errors: `t === "Date"` on a `t: Ty` is provably
 * false when `Ty` cannot BE "Date", so every one of those predicates read as dead
 * code and every `e.ty = "Uint8Array"` read as an illegal assignment. The type model
 * was the lie, not the code.
 *
 * Kept as an explicit, closed list rather than widening `Ty` toward `string`: the
 * narrowness is what makes `tsc` able to find the next dead comparison.
 */
export type BuiltinTy =
  | "Uint8Array" | "TextEncoder" | "TextDecoder"   // bytes value type (stdlib batch 2)
  | "Response" | "Headers"                          // networking tier (`fetch`)
  | "Date" | "URL" | "URLSearchParams";             // stdlib batch 3, the web APIs
/**
 * Array types: `${elem}[]` (e.g. "number[]").
 * Object types: `{k1:t1,k2:t2}` in field-insertion order (e.g. "{name:string,age:number}").
 * Both encodings keep `===` type comparison working as plain string equality.
 */
export type Ty = ScalarTy | BuiltinTy | `${string}[]` | `{${string}}`;

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
export function elemTy(t: Ty): Ty { return unparen(t.slice(0, -2) as Ty); }
/**
 * BUILD an array type. Not `${el}[]`, because the nullable encoding is a PREFIX and the
 * array encoding is a SUFFIX, so the two compose ambiguously:
 *
 *   makeNullable("null", "string")  + "[]"  === "?Nstring[]"   // (string | null)[]
 *   makeNullable("null", "string[]")        === "?Nstring[]"   // string[] | null
 *
 * `isNullableTy` anchors at the front and wins, so the concatenated spelling has always
 * READ as the second one. `(string|null)[]` was therefore typed `string[] | null` — which
 * surfaced as `NT2001 array elements must share a type (got string, null)` on the literal
 * and, worse, as `'a' is possibly null` on `const a: (string|null)[] = ["x","y"]; a.length`,
 * a nullability diagnostic about a program containing no null at all.
 *
 * The fix is the one `parseTypeAtom` (src/parser.ts) already prescribes for the identical
 * collision between an array-of-functions and a function-returning-an-array: PARENTHESIZE
 * the element. `(?Nstring)[]` cannot be confused with anything — it does not start with
 * `?U`/`?N`, and `isFuncTy` needs a top-level `=>` that a bare paren group has not got.
 * Only the nullable element needs it; every other element type is unambiguous, so every
 * existing `Ty` string in the tree is unchanged byte for byte.
 */
export function makeArrayTy(el: Ty): Ty { return (isNullableTy(el) ? `(${el})[]` : `${el}[]`) as Ty; }
/** Strip ONE balanced wrapping paren pair (the `makeArrayTy` element guard, undone). */
function unparen(t: Ty): Ty {
  if (typeof t !== "string" || !t.startsWith("(") || !t.endsWith(")")) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") { depth--; if (depth === 0) return i === t.length - 1 ? (t.slice(1, -1) as Ty) : t; }
  }
  return t;
}

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
  //@@mutable
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
 * with `Object.prototype.toString` and accept `d.toString()` as a getter.
 *
 * A `.set` CHAIN, not the `[[k, v], …]` entries form: the entries form needs a
 * `[key, value]` tuple type nativets does not have, and this table was the FIRST
 * blocker for five of the twelve compiler modules (docs/self-hosting.md). The two
 * spellings are the same program by construction — ES2024 24.1.1.1 step 8 builds
 * the entries form by calling `set` once per entry in order, and 24.1.3.9 step 8
 * is "Return M" — so the chain costs nothing extra under bun either (contrast
 * `.push` -> `xs = [...xs, v]`, measured at 1036x). Pinned against node running
 * the entries form in `test/collections.test.ts`. */
export const DATE_GETTERS = new Map<string, { which: number; utc: number }>()
  .set("getFullYear", { which: 0, utc: 0 }).set("getMonth", { which: 1, utc: 0 }).set("getDate", { which: 2, utc: 0 })
  .set("getHours", { which: 3, utc: 0 }).set("getMinutes", { which: 4, utc: 0 }).set("getSeconds", { which: 5, utc: 0 })
  .set("getMilliseconds", { which: 6, utc: 0 }).set("getDay", { which: 7, utc: 0 })
  .set("getUTCFullYear", { which: 0, utc: 1 }).set("getUTCMonth", { which: 1, utc: 1 }).set("getUTCDate", { which: 2, utc: 1 })
  .set("getUTCHours", { which: 3, utc: 1 }).set("getUTCMinutes", { which: 4, utc: 1 }).set("getUTCSeconds", { which: 5, utc: 1 })
  .set("getUTCMilliseconds", { which: 6, utc: 1 }).set("getUTCDay", { which: 7, utc: 1 });

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
// `.find(…)?.ty` is the natural spelling and nativets refuses it (`NT1001`): the
// element is a HEAP object, so handing it back would alias its owning array. Written
// as an INDEX search instead — `findIndex` yields a number, and reading one field off
// `fs[i]` is a borrow, not a handoff. Identical under bun; see docs/self-hosting.md.
export function fieldType(t: Ty, key: string): Ty | undefined {
  const fs = objectFields(t);
  const i = fs.findIndex((f) => f.key === key);
  return i < 0 ? undefined : fs[i]!.ty;
}
/**
 * Is `k` a canonical ARRAY INDEX string, per ECMA-262 §6.1.7? That is the exact predicate
 * `OrdinaryOwnPropertyKeys` uses to decide which keys enumerate FIRST, and it is much
 * narrower than "looks like a number": `P` is an array index iff
 * `ToString(ToUint32(P)) === P` and `ToUint32(P) !== 2**32 - 1`.
 *
 * Written as a spelling test rather than a round trip through `Number`, because the round
 * trip is where every near-miss implementation goes wrong. Requiring digits-only, no
 * leading zero, and a value below 2**32-1 is EXACTLY equivalent and has no parse step:
 *   - `""`      → `ToString(ToUint32("")) === "0"`, not `""`                → not an index
 *   - `"01"`    → `"1"` ≠ `"01"` (a leading zero never round-trips)         → not an index
 *   - `"1.5"`   → `"1"` ≠ `"1.5"`                                          → not an index
 *   - `"-1"`    → `ToUint32` wraps to 4294967295, `"4294967295"` ≠ `"-1"`  → not an index
 *   - `" 2"`    → `ToNumber` strips the space, `"2"` ≠ `" 2"`              → not an index
 *   - `"1e2"`   → `"100"` ≠ `"1e2"`                                        → not an index
 *   - `"4294967295"` → round-trips, but IS 2**32-1, explicitly excluded    → not an index
 *   - `"0"`, `"2"`, `"10"`, `"4294967294"`                                 → indices
 * Each of those is pinned in test/fixtures/stage22-objarr/key-order.ts (differential vs
 * node) and test/fuzz-diff.test.ts; a key that is NOT an index keeps its insertion
 * position, so a predicate that is too GENEROUS reorders keys node leaves alone — the same
 * silent wrong answer in the other direction.
 */
export function isArrayIndexKey(k: string): boolean {
  if (k.length === 0) return false;
  if (k.length > 1 && k[0] === "0") return false;          // a leading zero never round-trips
  for (let i = 0; i < k.length; i++) {
    const c = k[i]!;
    if (c < "0" || c > "9") return false;                  // sign, dot, space, exponent, letters
  }
  // Value < 2**32-1, decided on the SPELLING so no number is ever parsed: with no leading
  // zero, a shorter digit string is always the smaller value, and equal lengths compare
  // lexicographically. 4294967295 has 10 digits, so anything longer is out on length alone.
  if (k.length > 10) return false;
  return k.length < 10 || k < "4294967295";
}

/**
 * Order a field list the way `OrdinaryOwnPropertyKeys` does: every ARRAY-INDEX key first
 * in ascending NUMERIC order, then every other key in INSERTION order.
 *
 * This is applied when an object type is MINTED, not when it is read, because an object
 * here is a flat slot array whose layout IS its type string — so making the type canonical
 * makes the slot order canonical, and `Object.keys`, `for-in`, `JSON.stringify` and
 * `console.log` all read that one order through `objectFields`. Doing it on the read side
 * instead would leave two type strings that describe the same layout non-identical, and
 * tagged-union membership (see `assignable`) is a string-identity test.
 *
 * The index keys are compared by SPELLING for the same reason `isArrayIndexKey` tests
 * spelling: with no leading zeros, a shorter digit string is the smaller number, and equal
 * lengths order lexicographically. The non-index partition is built by a straight filter,
 * so it is stable by construction and does not lean on `Array#sort` being stable.
 *
 * `.sort` is chained DIRECTLY onto `.filter` rather than applied to a bound local, and that
 * is a subset requirement, not a style choice: arrays are immutable here, so `.sort` is only
 * accepted on a FRESH receiver — storage with no other owner, where sorting in place is
 * unobservable. Binding the filter result first (`const idx = …; idx.sort(…)`) makes it an
 * ordinary array and `NT1606` refuses it, which reintroduces a blocker in ast.ts — a module
 * that already self-compiles. The self-host ratchet catches exactly that.
 */
export function canonicalKeyOrder<T extends { key: string }>(fields: T[]): T[] {
  // The common case is that no key is an index and nothing moves. It still returns a fresh
  // array rather than `fields` itself: `fields` is BORROWED from the caller, so handing it
  // back is a move-out of a borrow (`NT1604`) — the same subset rule that shapes the `.sort`
  // above. `.map` in `objectType` already allocates, so the copy costs no extra allocation.
  if (!fields.some((f) => isArrayIndexKey(f.key))) return [...fields];
  return [
    ...fields.filter((f) => isArrayIndexKey(f.key))
      .sort((a, b) => (a.key.length !== b.key.length ? a.key.length - b.key.length : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    ...fields.filter((f) => !isArrayIndexKey(f.key)),
  ];
}

export function objectType(fields: { key: string; ty: Ty }[]): Ty {
  return `{${canonicalKeyOrder(fields).map((f) => `${f.key}:${f.ty}`).join(",")}}`;
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

/**
 * Can `k` be an object KEY without corrupting the layout? An object's slot list IS its
 * type string — `{k1:t1,k2:t2}`, split back by `objectFields` above — so a key carrying a
 * character that split reacts to does not merely look odd, it MOVES THE SLOT BOUNDARIES.
 * Measured on a scan of every printable ASCII character through `{ "a<C>b": 1, z: 2 }`,
 * with node as the oracle, nine of them did, all at exit 0 with no diagnostic:
 *
 *   for (const k in { "a,b": 1, z: 2 })   node → "a,b","z"    was → "","b","z"
 *   for (const k in { "a:b": 1, z: 2 })   node → "a:b","z"    was → "a","z"
 *   for (const k in { "a<b": 1, z: 2 })   node → "a<b","z"    was → "a<b"   ← `z` GONE
 *
 * This is a ROUND TRIP and deliberately not a forbidden-character list, because the
 * property that matters is not "contains a suspicious byte", it is "`objectFields` of the
 * minted type gives back the fields that were minted" — which is exactly what every
 * consumer relies on (`fields.length` is an allocation size and `fieldIndex` is a
 * `getelementptr` offset). Testing the property directly cannot be too NARROW, the way a
 * hand-written list can: a list wide enough to be safe has to ban `>`, `|`, `"`, `\` and a
 * balanced `<…>` as well, and every one of those encodes faithfully and works today.
 *
 * The probe carries a SECOND, known-good field, and that is the whole subtlety: `a<b` on
 * its own round-trips perfectly (there is no separator for its dangling angle to swallow)
 * and only eats the comma once a neighbour exists. A single-field probe would have passed
 * it. `x:boolean` is the neighbour; `k === "x"` is harmless, since then both fields are
 * genuinely named `x` and the encoding is still faithful.
 *
 * The string is built by hand rather than through `objectType` so the probe is not
 * reordered by `canonicalKeyOrder` — position is irrelevant here, only faithfulness is.
 *
 * `KEY_MARKERS` is the one part that CANNOT be a round trip, and the reason is worth
 * stating: `#` and `"` are read against the whole type string by SUBSTRING, so whether a
 * key carrying one is safe depends on what its NEIGHBOURS contain, which no single-key
 * probe can see.
 *   - `"` — `widenLiteralTys` pairs quotes across the entire string and replaces what lies
 *     between them with `string`. One quoted key alone is harmless (there is no closing
 *     quote, so the scan bails); TWO of them, or one beside a field with a string-LITERAL
 *     type, are not. Measured: `{ 'a"b': 1, 'c"d': 2, z: 3 }` enumerated `astringd`, `z` —
 *     two keys silently fused into one, at exit 0.
 *   - `#` — `hasTypeParam` is `t.includes("#")`, so a key carrying one makes a fully
 *     substituted type look like it still has an open parameter. Already refused today,
 *     but as an `NT1013` naming the whole mangled type rather than the key.
 * `@` is NOT here, and was checked rather than assumed: `hasTypeRef` is also a bare
 * `includes`, but every consumer behind it walks by POSITION, so `{ "x@N": 1, z: 2 }`
 * agrees with node even with a recursive `type N` in the table. Banning it would have
 * refused a program that works.
 */
const KEY_MARKERS = "#\""; // whole-string markers in the Ty encoding — see above
export function keyIsEncodable(k: string): boolean {
  for (let i = 0; i < k.length; i++) if (KEY_MARKERS.includes(k[i]!)) return false;
  const probe = objectFields(`{${k}:number,x:boolean}` as Ty);
  if (probe.length !== 2) return false;
  return probe[0]!.key === k && probe[0]!.ty === "number" && probe[1]!.key === "x" && probe[1]!.ty === "boolean";
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
 * What `typeof` reports for a value of this static type, or `undefined` when the answer
 * is not a compile-time constant. THE ONE CANONICAL COPY: it is both the general union's
 * only discriminant (so it decides what a union can be represented as) and the whole
 * lowering of the `typeof` operator.
 *
 * WHY THE DEFAULT IS `"object"` AND NOT THE SPELLING. `typeof` answers from a CLOSED set
 * of eight strings, of which five are reachable in this subset — `"undefined"`,
 * `"boolean"`, `"number"`, `"string"`, `"function"` — and EVERYTHING else in the language
 * is `"object"`. There is no sixth answer, so enumerating the five and defaulting to
 * `"object"` is exhaustive BY CONSTRUCTION: a type encoding added tomorrow is an object
 * unless it is one of those five, and those five are not growing.
 *
 * The lowering used to be written the other way round — enumerate the object-ish kinds,
 * fall through to the raw `Ty` — and a kind nobody remembered to list printed the
 * compiler's internal spelling as if it were a JavaScript answer. `typeof new Set(…)` was
 * `"Set<string>"` against node's `"object"`, at exit 0, and since `typeof` is a BRANCH
 * primitive `if (typeof s === "object")` took the wrong arm. SIX kinds were wrong, found
 * by a differential probe rather than by reading the code: `Uint8Array`, `TextEncoder`,
 * `TextDecoder`, `Map<K,V>`, `Set<T>`, and a discriminated union — which printed its
 * entire member list. Enumerating the object side is the defect; the direction is the fix.
 *
 * `undefined` means one of three things, and every one of them is the CALLER's to handle
 * rather than to guess at:
 *   - the nullable box (`?U…`/`?N…`) and the general union (`G<…>`) — `typeof` is a
 *     genuine RUNTIME fact there, decided by the box's tag, which is the point of the tag;
 *   - `Dyn` (the actor-message ABI) — likewise carries no static kind;
 *   - a bare type-parameter marker (`#T`) — no value has this type; monomorphization
 *     substitutes it, so reaching here means a specialization escaped and the honest
 *     answer is an internal error, not `"object"`.
 *
 * This function is the reason `typeofTagOf` no longer exists. That one was correct only
 * over `isGeneralUnionArm`'s domain (number/string/boolean/array) and answered `"object"`
 * for `undefined` and for a FUNCTION type — right for its one caller, a landmine for the
 * next. Same shape as the `objectFields("@N")` phantom-record hazard documented above:
 * a rule that holds only over its current caller's inputs is not a rule.
 */
export function staticTypeofName(t: Ty): string | undefined {
  if (t === "number" || t === "string" || t === "boolean") return t;
  if (t === "undefined" || t === "void") return "undefined";
  if (isStringLitTy(t)) return "string";           // literal tags widen to `string`
  if (isNullableTy(t) || isGeneralUnionTy(t)) return undefined; // a RUNTIME fact
  if (t === "Dyn" || isTypeParamTy(t)) return undefined;        // no static kind at all
  if (isFuncTy(t)) return "function";
  // `null`, arrays, records, class instances, tagged unions, nominal back-edges, and every
  // builtin handle (Map/Set/Uint8Array/TextEncoder/TextDecoder/Response/Headers/Date/URL/
  // URLSearchParams). node says `"object"` for all of them whatever our representation is —
  // a `Date` is a bare double here and still an object there.
  return "object";
}
/**
 * The `typeof` tag of a general-union ARM — the union's only discriminant, and what
 * decides whether one can be represented at all.
 *
 * A DOMAIN ADAPTER over `staticTypeofName`, not a second rule: arms are restricted by
 * `isGeneralUnionArm` to number/string/boolean/array, on which `staticTypeofName` is
 * total, so the `?? "object"` is unreachable. It is spelled out rather than asserted
 * because a `!` on a `string | undefined` is outside the subset `src/` must stay inside,
 * and because "object" is the answer an array arm gets anyway — the fallback cannot be
 * a wrong answer even if the arm set is widened to another object kind later.
 */
export function generalUnionArmTypeof(t: Ty): string { return staticTypeofName(t) ?? "object"; }
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
    // `values.add(x)` with the result DISCARDED is a no-op here: nativets `Set`s are
    // persistent (docs/divergences.md §A), so `.add` returns a new set. The rebinding
    // spelling means the same thing under bun, where `.add` returns the receiver.
    let values = new Set<Ty>();
    let ok = true;
    for (const m of members) {
      // `const f = fs[i]` is the natural spelling and nativets refuses it (`NT1605`):
      // the element is a HEAP object, so binding it would make `f` a second owner of a
      // slot the array still holds. Read THROUGH the index instead — `fs[i]!.key` is a
      // borrow, not a handoff — exactly as `fieldType` above does for the same reason.
      // The `i >= fs.length` guard replaces the old `!f` undefined-test and must come
      // FIRST: an out-of-range index PANICS here (Stage 41) rather than yielding
      // `undefined`, so the short-circuit is load-bearing, not a style choice. Members
      // may legitimately be shorter than `first`. Identical under bun.
      const fs = objectFields(m);
      if (i >= fs.length) { ok = false; break; }
      const fkey = fs[i]!.key;
      const fty = fs[i]!.ty;
      if (fkey !== key || !isStringLitTy(fty)) { ok = false; break; }
      values = values.add(fty);
    }
    if (ok && values.size === members.length) return { key, index: i };
  }
  return undefined;
}

/**
 * A field readable on an un-narrowed union — present in EVERY member, at the SAME slot
 * index, with the SAME type once tags are widened. `undefined` when any of that fails.
 *
 * tsc's rule is only the first clause: a property in every constituent is readable, and
 * its type is the union of the per-member types. Ours has to add the other two, and the
 * reason is REPRESENTATION rather than typing. A `U<…>` value IS the member object
 * pointer (see the SH2 note above) — there is no box and no per-member vtable — so a
 * field read lowers to one `getelementptr` at a CONSTANT slot. A field sitting at slot 1
 * in one member and slot 3 in another has no such constant, and a field whose type
 * differs between members has no single way to interpret the 64 bits once loaded.
 * Reading it anyway is the type-confusion this project exists to refuse: a `{r:number}`
 * / `{label:string}` pair at the same slot hands back a string pointer bit-cast to a
 * double (`2.1e-314`), not a wrong number.
 *
 * So this is deliberately the SOUND PARTIAL rule. Agreeing slots across a union's
 * members (by laying members out to match) and branching on the tag to pick a slot are
 * both strictly wider and both cost something — a layout change and a runtime test
 * respectively — and neither is needed for the shape that actually blocks self-hosting,
 * `case "BinaryExpr": case "LogicalExpr": return exprLoc(e.left)`, where the shared
 * field is at the same slot in both members already.
 *
 * The DISCRIMINANT is the degenerate case of exactly this rule, not a separate one: it
 * is in every member at one index by construction, and its per-member string-LITERAL
 * types all widen to `string`. That is why the tag read and the shared-field read are
 * one code path in both the checker and codegen.
 */
export function unionCommonField(t: Ty, key: string): { index: number; ty: Ty } | undefined {
  const members = unionMembers(t);
  if (members.length === 0) return undefined;
  let index = -1;
  let ty: Ty = "number";
  for (const m of members) {
    const fs = objectFields(m);
    const i = fs.findIndex((f) => f.key === key);
    if (i < 0) return undefined;                       // absent from this member
    const w = widenLiteralTys(fs[i]!.ty);
    if (index < 0) { index = i; ty = w; continue; }
    if (i !== index || w !== ty) return undefined;     // different slot, or different type
  }
  return index < 0 ? undefined : { index, ty };
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
// Spelled with an INLINE arrow rather than point-free `.map(widenLiteralTys)`: a
// function VALUE is `NT1003` here (M2, first-class functions). The arrow is also the
// safer spelling under bun — `.map` passes (element, index, array), so a point-free
// callback silently receives two extra arguments.
export function unionWidenedMembers(t: Ty): Ty[] { return unionMembers(t).map((m) => widenLiteralTys(m)); }

/**
 * Can a value laid out as `concrete` be READ through the shape `view` without any slot
 * arithmetic going wrong? True when every field of `view` sits at the SAME index in
 * `concrete` with the same (widened) type — so `view` is a layout PREFIX-compatible
 * window onto `concrete`, not merely a structural subtype of it.
 *
 * The index is what makes this stricter than assignability: a field read compiles to a
 * slot offset, so finding the key elsewhere in `concrete` is worthless — `{a,b}` read as
 * `{b,a}` would take both at the wrong offset. Extra fields at the END of `concrete` are
 * fine (they are simply never read); extra fields in `view` are not (they are not there).
 *
 * This is the predicate behind `expr as T` on a union: the assertion is CHECKABLE exactly
 * when some member satisfies it, and free when every member does. Shared by the checker
 * (which refuses when NO member does) and codegen (which tag-checks against the ones that
 * do), so the two can never disagree about which casts are sound.
 */
export function objectLayoutFits(view: Ty, concrete: Ty): boolean {
  if (!isObjectTy(view) || !isObjectTy(concrete)) return false;
  const want = objectFields(view);
  const have = objectFields(concrete);
  if (want.length > have.length) return false;
  for (let i = 0; i < want.length; i++) {
    // Read THROUGH the index rather than binding the element: `const w = want[i]!` is
    // `NT1605` (binding a heap element makes the local a second owner of a slot the
    // array still holds). `want[i]!.key` is a borrow. Same reason as `fieldType` above.
    // In bounds by construction — `i < want.length`, and `want.length <= have.length`
    // was checked before the loop, so neither index can panic.
    if (want[i]!.key !== have[i]!.key) return false;
    if (widenLiteralTys(want[i]!.ty) !== widenLiteralTys(have[i]!.ty)) return false;
  }
  return true;
}

/**
 * `Extract<T, U>`'s per-member test: is the union member `member` assignable to the
 * pattern `U`? TypeScript's `Extract` is `T extends U ? T : never` distributed over `T`,
 * and `extends` on two object types means "has every property of `U`, at an assignable
 * type" — so this asks exactly that, key by key.
 *
 * DELIBERATELY NOT SLOT-SENSITIVE, and this is the line that separates it from
 * `objectLayoutFits` one function up. That predicate answers a LAYOUT question — "may a
 * value laid out as `concrete` be READ through the shape `view`" — so it is index-keyed,
 * because a field read compiles to a constant `getelementptr` and finding the key at some
 * other offset is worthless. `Extract` asks nothing of the kind: it SELECTS whole members
 * out of a union and hands one of them back unchanged, so the value is always read at its
 * own layout and there is no reinterpretation to get wrong. Using the layout rule here
 * would be a silent narrowing of what `Extract` means (`Extract<Expr, {ty?: string}>`
 * would answer the empty set because `ty` is at slot 1, not slot 0) and `tsc` — which is
 * authoritative on what a TYPE means — would disagree with us about a type. Where the two
 * systems genuinely differ is the `as` that consumes this result, and that cast is checked
 * against `objectLayoutFits` on its own.
 *
 * A STRING-LITERAL pattern field is matched EXACTLY (`"square"` selects the member tagged
 * `"square"` and no other); every other field is matched by WIDENED type, which is the
 * same equality `unionCommonField` and `objectLayoutFits` use, so all three agree about
 * when two field types are "the same one".
 */
export function extractMatchesPattern(member: Ty, pattern: Ty): boolean {
  if (!isObjectTy(member) || !isObjectTy(pattern)) return false;
  const want = objectFields(pattern);
  const have = objectFields(member);
  for (let i = 0; i < want.length; i++) {
    const wantKey = want[i]!.key;
    const wantTy = want[i]!.ty;
    let ok = false;
    for (let j = 0; j < have.length; j++) {
      if (have[j]!.key !== wantKey) continue;
      const haveTy = have[j]!.ty;
      ok = isStringLitTy(wantTy) ? haveTy === wantTy : widenLiteralTys(haveTy) === widenLiteralTys(wantTy);
      break;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * The members of the discriminated union `subject` that survive `Extract<subject, pattern>`,
 * in declaration order. Empty when `subject` is not a union, when `pattern` is not an object
 * type, or when nothing matches — the caller distinguishes those, since only the last is
 * TypeScript's `never`.
 *
 * A pattern that constrains NOTHING keeps every member, and that is the load-bearing
 * degenerate case rather than an oversight: `{ kind: "MemberExpr" | "IndexExpr" }` has
 * already collapsed to `{kind:string}` by the time any of this runs (a union of string
 * literals widens in `parseTypeInner`, long before `Extract` sees it), so every member's
 * `kind` matches by widened type and the answer is the whole union — which is precisely the
 * erasure `Extract` had before, i.e. the conservative direction. See the parser.
 */
export function extractUnionMembers(subject: Ty, pattern: Ty): Ty[] {
  //@@mutable
  const keep: Ty[] = [];
  // SINGLE return, rather than the natural `if (…) return keep;` guard clause. The
  // ownership pass merges an `if`'s consequent state into the join UNCONDITIONALLY
  // (`IfStmt` in ownership.ts), even when that branch diverges — so an early `return
  // keep` marks `keep` moved along a path it cannot reach, and the later `keep.push`
  // is a spurious `NT1601`. Refusing correct code, not miscompiling it, so this is a
  // safe spelling workaround rather than a correctness hazard; the guard-clause form
  // is restored once the pass drops diverging branches at the join. Identical in node.
  if (isUnionTy(subject) && isObjectTy(pattern)) {
    const members = unionMembers(subject);
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (extractMatchesPattern(m, pattern)) keep.push(m);
    }
  }
  return keep;
}

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
/**
 * A cheap PRE-FILTER: could `t` mention a reference at all? `@` never appears in a
 * structural type, so a `false` here is conclusive and costs one scan.
 *
 * A `true` is NOT. `@` is legal inside a string-literal TAG (`kind: "user@host"`) and
 * inside a property KEY (`{ "x@y": 1 }`), both of which land verbatim in the encoding — so
 * this said "recursive" about `{x@y:number,b:number}` and structuredClone refused a program
 * node runs. Ask `containsTypeRef` when the answer decides anything; the same lesson as
 * `objectFields("@N")` returning a phantom record, which is one line up in this file: a
 * substring test over a structural encoding is not a structural question.
 */
export function hasTypeRef(t: Ty): boolean { return typeof t === "string" && t.includes("@"); }
/**
 * Does `t` contain a nominal back-edge in a TYPE position, anywhere (`?U@N`, `@N[]`,
 * `{a:@N}`, a union member's field)? STRUCTURAL, so a `@` in a key or a tag is not one.
 *
 * This is what the deep walks ask before refusing: `structuredClone`, the actor-message
 * copy and `JSON.stringify` all recurse over the static type, and a back-edge is the one
 * carrier that does not shrink. Carriers with no walk of their own (`Map`, `Set`, a
 * function) answer `false` — their contents are unreachable from the encoding, and they are
 * already refused by the callers on their own terms.
 */
export function containsTypeRef(t: Ty): boolean {
  if (!hasTypeRef(t)) return false;              // the cheap half: conclusive when false
  if (isTypeRefTy(t)) return true;
  if (isNullableTy(t)) return containsTypeRef(baseTy(t));
  if (isArrayTy(t)) return containsTypeRef(elemTy(t));
  if (isUnionTy(t)) return unionMembers(t).some((m) => containsTypeRef(m));
  if (isGeneralUnionTy(t)) return generalUnionMembers(t).some((m) => containsTypeRef(m));
  if (isObjectTy(t)) return objectFields(t).some((f) => containsTypeRef(f.ty));
  return false;
}
/**
 * Unfold ONE level: replace a bare `@N` with the shape it names. Identity on everything
 * else, including a type that merely CONTAINS a reference — unfolding those eagerly is what
 * would not terminate. An unknown name is left alone rather than guessed at; it then fails
 * loudly at whichever site needed the shape, which is the point of property 2 above.
 */
export function expandTypeRef(t: Ty, table: Map<string, Ty>): Ty {
  return isTypeRefTy(t) ? (table.get(typeRefName(t)) ?? t) : t;
}
/**
 * Unfold a back-edge that sits under a TYPE CONSTRUCTOR — `expandTypeRef` distributed
 * through `?U`/`?N` and `[]`.
 *
 * WHY THIS EXISTS. `expandTypeRef` is the identity on anything that is not a BARE `@N`, so
 * an OPTIONAL back-edge — `interface Node { next?: Node }`, the single commonest spelling
 * there is — produced `?U@Node` as a value's own static type. That is precisely what the
 * INVARIANT above forbids: `@Name` is allowed only NESTED inside a shape, and `?U` is not a
 * shape, it is a constructor applied to the value itself. Two symptoms, one cause:
 *
 *   - `if (n.next)` reached codegen's `truthyOf`, which unwrapped the nullable box and asked
 *     for the truthiness of the bare `@Node` inside — `InternalError: no truthiness rule`.
 *   - `depth(e.next)` was refused `NT2001 expects ?UU<…>, got ?U@E`, because the PARAMETER's
 *     annotation `E | undefined` is parsed to the expanded shape while the ARGUMENT read out
 *     of the field is not. That is the shape every AST walker is written in.
 *
 * TERMINATION is the same O(1) argument `expandTypeRef` makes, and this does not weaken it.
 * The recursion strips one constructor per step off a finite string, and it does NOT descend
 * into an object's fields or a union's members — those are the "nested inside a shape"
 * positions where a back-edge legitimately stays folded, and descending into them is exactly
 * the fixpoint that would diverge. So the result is concrete at the top and folded again one
 * real access deeper.
 *
 * REBUILT, NOT CONCATENATED. `?N` is a prefix and `[]` is a suffix, so `?Nstring` + `[]`
 * reads back as `string[] | null` — the collision `makeArrayTy` was written for. The nullable
 * arm therefore keeps the original 2-char prefix and swaps only the base, and the array arm
 * goes through `makeArrayTy` so a nullable element is parenthesized.
 */
export function unfoldTypeRef(t: Ty, table: Map<string, Ty>): Ty {
  // The cheap half FIRST: `@` never appears in a structural type, so a `false` is conclusive
  // and costs one scan — and this runs on every expression type in `genExpr`. Any reference
  // starts with `@`, so nothing is skipped by asking this before `isTypeRefTy`.
  if (!hasTypeRef(t)) return t;
  if (isTypeRefTy(t)) return table.get(typeRefName(t)) ?? t;
  if (isNullableTy(t)) {
    const base = baseTy(t);
    const un = unfoldTypeRef(base, table);
    return un === base ? t : ((t.slice(0, 2) + un) as Ty);
  }
  if (isArrayTy(t)) {
    const el = elemTy(t);
    const un = unfoldTypeRef(el, table);
    return un === el ? t : makeArrayTy(un);
  }
  return t;                                      // a shape: its back-edges stay folded
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
 *
 * RETURNS the accumulated bindings rather than mutating the `out` argument in place. A
 * nativets `Map` is PERSISTENT (docs/divergences.md §A) — `.set` returns a new map and
 * leaves the receiver untouched — so an out-parameter accumulator is a silent no-op
 * here, and the checker refuses the discarded spelling outright (`NT1606`). Threading
 * the result means the same thing under bun, where `.set` returns the receiver.
 */
export function unifyTypeParams(pattern: Ty, actual: Ty, out: Map<string, Ty>): Map<string, Ty> {
  if (!hasTypeParam(pattern)) return out;
  if (isTypeParamTy(pattern)) {
    const name = pattern.slice(1);
    return out.has(name) ? out : out.set(name, actual); // first binding wins
  }
  if (isArrayTy(pattern) && isArrayTy(actual)) return unifyTypeParams(elemTy(pattern), elemTy(actual), out);
  if (isNullableTy(pattern) && isNullableTy(actual)) return unifyTypeParams(baseTy(pattern), baseTy(actual), out);
  if (isFuncTy(pattern) && isFuncTy(actual)) {
    const pp = funcParams(pattern), ap = funcParams(actual);
    // A plain `for`, not `forEach`: the arrow would WRITE a captured binding, which is
    // its own refusal (`NT1031`) — and the point of returning is to have no writes.
    let acc = out;
    // The bound is the SHORTER list, stated rather than discovered by probing `ap[i]`
    // for `undefined`. That probe is what the old spelling did, and here it would be a
    // dead guard anyway: an out-of-range `[]` PANICS (Stage 41), so its element type is
    // `Ty`, never `Ty | undefined`.
    const n = pp.length < ap.length ? pp.length : ap.length;
    for (let i = 0; i < n; i++) acc = unifyTypeParams(pp[i]!, ap[i]!, acc);
    return unifyTypeParams(funcRet(pattern), funcRet(actual), acc);
  }
  if (isMapTy(pattern) && isMapTy(actual)) {
    const acc = unifyTypeParams(mapKeyTy(pattern), mapKeyTy(actual), out);
    return unifyTypeParams(mapValTy(pattern), mapValTy(actual), acc);
  }
  if (isSetTy(pattern) && isSetTy(actual)) return unifyTypeParams(setElemTy(pattern), setElemTy(actual), out);
  if (isObjectTy(pattern) && isObjectTy(actual)) {
    let acc = out;
    for (const f of objectFields(pattern)) {
      const af = fieldType(actual, f.key);
      if (af !== undefined) acc = unifyTypeParams(f.ty, af, acc);
    }
    return acc;
  }
  return out;
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
  | InExpr
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
// `**=` is here with the rest of the compound family, but it is the ONLY one whose bare
// operator is not an LLVM instruction or a `BITFN` entry — `**` is `Number::exponentiate`,
// lowered to `js_pow`. See `compoundArith` in codegen.ts, which is the single place that
// knows it; adding an operator to this list without adding it there emits a call to
// `@undefined`.
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "**=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | ">>>=";
export interface AssignExpr {
  kind: "AssignExpr";
  op: AssignOp;
  target: string;
  value: Expr;
  ty?: Ty;
  /** Where the assignment is. Added for the same reason `ArrowFunction.loc` was: the
   *  refusals in this arm (`Cannot assign X to Y 'name'`, `Cannot assign to const`) had
   *  no location and no span, so finding one in a 5,000-line module meant grepping the
   *  BINDING NAME — measured, twice, on `base` and on `n`. */
  loc?: Loc;
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
  /** `xs[i] = v` on a `@@mutable` binding — codegen emits the in-place element store
   *  (`nt_arr_set_inplace`) instead of refusing. One-way: the checker is the only writer
   *  (it is the pass that knows the binding carries the attribute), codegen the only
   *  reader — same arrangement as `nullOnMove`, `awaited` and `inPlaceColl`. */
  inPlaceElem?: boolean;
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
  /**
   * This `viaThis` write is in a CONSTRUCTOR body rather than a method's — including the
   * two the parser synthesizes there, a field initializer and a parameter property.
   *
   * It is the CYCLE rule that needs the distinction (`Checker.cycleCapableThisWrite`). A
   * constructor writes into a freshly allocated block that nothing else can reach yet, so
   * the value it stores cannot already point back at the receiver; a method's receiver
   * already exists and can be pointed at. Without the distinction the rule would refuse
   * `parent: Scope | null = null`, which desugars to a constructor write of the recursive
   * field and is the whole reason recursive `@@mutable` classes exist.
   */
  inCtor?: boolean;
}

export interface TypeofExpr { kind: "TypeofExpr"; operand: Expr; ty?: Ty; }

// `typeArgs` are EXPLICIT call-site type arguments (`id<string>("x")`) — they pin the
// instantiation of a generic callee instead of inferring it from the argument types.
/** `awaited` is a one-way STAMP, in the family of `nullOnMove`/`narrowed`/`result`: the
 *  parser sets it on a call that is the operand of an `await`, and the floating-async check
 *  reads it. It replaced a `Set<Expr>` — identity-keyed collections over the `Expr` union
 *  are `NT1014` ("Set of U<…>"), which was the first blocker of FIVE of the twelve modules
 *  through the link. Stamping the node also deletes the sub-parser merge the set needed
 *  (`for (const n of sub.awaitedCalls) …`): the nodes are shared, so the mark travels. */
export interface CallExpr {
  kind: "CallExpr"; callee: Expr; args: Expr[]; typeArgs?: Ty[]; ty?: Ty; loc?: Loc; awaited?: boolean;
  /** A `Map`/`Set` mutator on a `@@mutable` binding whose result is DISCARDED — codegen
   *  emits the in-place runtime entry point for it. Another one-way stamp: the checker is
   *  the only writer (it is the pass that knows the binding carries the attribute) and
   *  codegen the only reader, exactly like `nullOnMove` and `awaited`. */
  inPlaceColl?: boolean;
}
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
/* `ty` was MISSING from this interface while four modules already used it. The checker
 * writes it through an `(e as { ty?: Ty })` cast like every other expression's, codegen
 * and the ownership pass read it back the same way, and `tsc` never said a word — see the
 * note in `walkExprChildren` about why the project's type errors were invisible. Declaring
 * it changes no behaviour (the field was always there at runtime, on 82 nodes in this
 * repo's own corpus); what it changes is that the typed AST walk can now SEE it, which the
 * reflective walk it replaces always could. */
export interface NonNullExpr { kind: "NonNullExpr"; expr: Expr; loc?: Loc; ty?: Ty; }

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

/**
 * `k in o` — key PRESENCE, decided at compile time exactly as `instanceof` is, and for
 * the same reason: an object's key set here comes from its TYPE.
 *
 * That reason cuts both ways, which is the whole split. When the type carries no OPTIONAL
 * field the presence set IS the field set and a LITERAL key has one static answer
 * (`result`). When it carries one, `{}` and `{a:1}` share the type and have different key
 * sets — no answer exists, and the construct is refused with the same words `Object.keys`
 * uses. A non-literal key is refused too: the own-key half would be a runtime string
 * compare against a static list, but node also walks the PROTOTYPE CHAIN (test262
 * `S8.12.6_A2_T1`: `"valueOf" in {}` is true), and an unseen key cannot be checked
 * against it. A literal key can, so the inherited names are answered `true`.
 */
export interface InExpr { kind: "InExpr"; key: Expr; object: Expr; result?: boolean; ty?: Ty; loc?: Loc; }

/**
 * The own-property names of node's `Object.prototype` — the only reason `"valueOf" in {}`
 * is `true` (test262 `S8.12.6_A2_T1.js`). nativets objects have no prototype chain, so a
 * lowering that consulted own fields alone would answer `false` there; a LITERAL key is
 * checked against this list instead and folded to node's answer.
 *
 * Verified against the running oracle, not recalled:
 *   node -e 'console.log(Object.getOwnPropertyNames(Object.prototype))'
 * Spelled as an ARRAY, not a `Set`: `new Set([…])` is NT1014, and this file has to stay
 * inside the subset it compiles (the two `new Set([…])` tables further down predate that
 * rule and sit behind an earlier blocker).
 */
export const OBJECT_PROTO_KEYS: string[] = [
  "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__",
  "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf",
  "__proto__", "toLocaleString",
];

/**
 * Arrow function. `captures` (filled by the checker) are free vars closed over.
 *
 * THE BODY IS TWO FIELDS, NOT A UNION, and that is a self-hosting requirement rather
 * than a style choice. This used to be `body: Expr | Stmt[]` — a union of a
 * discriminated union and an ARRAY. An array has no tag slot, so nothing inside the
 * value tells the arms apart, and it was one of the four residuals holding `ast.ts`'s
 * 45-member recursive component hostage (`NT1009`, through `NT1030`).
 *
 * Three shapes were MEASURED, not argued (see docs/self-hosting.md):
 *
 *   body: Expr | Stmt[]   — no representation. `typeof` cannot separate an object union
 *                           from an array, and the boxed `G<…>` alternative is not
 *                           linear today, so it would leak both box and payload.
 *   body: Expr | Block    — LOOKS right, DEADLOCKS. `Expr` selects over `ArrowFunction`,
 *                           so while the component is being encoded `Expr` is still a
 *                           bare `@Expr` with no shape, and a union member may not be a
 *                           bare `@Name` (`unionDiscriminant` needs each member's SHAPE).
 *                           Flattening cannot help: there is nothing to flatten.
 *   body? + stmts?        — THIS. Two folded back-edges, `?U@Expr` and `?U@Stmt[]`,
 *                           neither of which needs any shape. No union, no deadlock.
 *
 * `exprBody` remains the discriminator, and it says which field is populated: `true` ⇒
 * `body`, `false` ⇒ `stmts`. Exactly one is ever set.
 */
export interface ArrowFunction {
  kind: "ArrowFunction";
  params: Param[];
  /** The expression body — set iff `exprBody`. */
  body?: Expr;
  /** The block body's statements — set iff NOT `exprBody`. */
  stmts?: Stmt[];
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
  /** `async () => …`. A one-way STAMP set by the parser and read by the floating-async
   *  checks, in the family of `nullOnMove`/`narrowed`/`awaited`. It replaced a
   *  `Set<Expr>`: an identity-keyed collection over the `Expr` union is `NT1014`
   *  ("Set of U<…>"), which was the first blocker of five of the twelve modules through
   *  the link. The stamp also removes the sub-parser merge the set required, because the
   *  node itself is shared. */
  isAsync?: boolean;
  /** Indices of this arrow's parameters that take an async function. Another one-way
   *  stamp, for the same reason as `isAsync`: it replaced a `Map<Expr, …>`, and an
   *  identity-KEYED map over the union is `NT1014` just as the set was. */
  promiseParams?: number[];
  /** Where the arrow starts. Added so `cannot infer type of arrow parameter` can SAY
   *  where it is: it shipped with no location and no span, and locating it by grepping
   *  the parameter name is what a reader was left with (two wrong guesses, measured). */
  loc?: Loc;
  /** The name this arrow is bound to, when it is the initializer of a fully-annotated
   *  `const` and may therefore call ITSELF — `const walk = (s: Stmt): void => { … walk(…) … }`.
   *  Set by the checker's `VarDecl` arm (which types an initializer BEFORE it declares the
   *  binding, so the name would otherwise not be in scope inside its own body) and read by
   *  three places that must agree: `typeArrow` declares it in the arrow's OWN body scope,
   *  `computeCaptures` EXCLUDES it (capturing it would snapshot the binding's slot while
   *  the closure is still being built), and codegen lowers a call to it as a call through
   *  `%__clo`, which already holds this very closure. `alphaRenameShadows` rewrites it in
   *  lockstep with the declarator so a shadowed self-call keeps pointing at itself. */
  selfName?: string;
  captures?: { name: string; ty: Ty }[];
  liftedName?: string; // @arrow_N assigned during codegen
}

// `paramProp` marks a constructor *parameter property* (`constructor(private x: T)`):
// the parser desugars it into a class field + a `this.x = x` init in the ctor body.
//
// `mutable` marks the PER-PARAMETER `@@mutable` opt-in (`//@@mutable` on its own line
// before the parameter): `.push` may append to this array parameter in place, and the
// caller observes the append. It is the array's answer to the question `@@mutable`
// answers nominally for a record — an array type is STRUCTURAL, so there is no name to
// tag, and the marker goes on the parameter, which is still part of the SIGNATURE and so
// still visible at the call site. See docs/decorators.md.
export interface Param { name: string; annot?: Ty; default?: Expr; rest?: boolean; paramProp?: boolean; mutable?: boolean; }

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
  /** `@@mutable` (or `//@@mutable`) on the declaration — an ACCUMULATOR binding whose
   *  array may be appended to in place with `.push`. Opt-in, per BINDING: it never
   *  travels with the type, so a value handed out of this scope is an ordinary
   *  immutable array again. See docs/decorators.md. */
  mutable?: boolean;
}

export interface FuncDecl {
  kind: "FuncDecl";
  name: string;
  params: Param[];
  returnAnnot?: Ty;
  body: Stmt[];
  // NO `returnTy` HERE. The RESOLVED return type lives in the checker's signature table
  // (`Sig.ret`), keyed by this declaration's name, and both readers — `Checker.checkFunction`
  // and codegen's `genFunction` — already had that table in hand at the point they used to
  // read the field. It was a second copy kept in sync by four `o.f = v` writes, which is a
  // shape this compiler refuses (NT1606: records are immutable), and it was also the
  // documented "latent trap" in the `mapTypesDeep` note below — a `Ty`-bearing field the
  // type rewrite deliberately skipped. One home, no trap, no mutation.
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
//@@mutable
export interface BlockDropsStmt { kind: "BlockDrops"; names: string[]; }

/**
 * Attach `names` as the block's fall-through drop set. IDEMPOTENT — it replaces an
 * existing marker rather than appending a second one, because `loop()` re-walks a loop
 * body up to five times to reach its fixpoint and each walk sets the set again. Five
 * appended markers would be five frees of the same value: a double free, not a leak.
 *
 * The EMPTINESS test is a `length` check, and that is load-bearing rather than stylistic.
 * It used to be `const last = list[list.length - 1]; if (last !== undefined && …)`, which
 * looks like a defensive `undefined` guard and is not one: on an empty list the index is
 * `-1`, where node answers `undefined` and nativets PANICS by design (Stage 41,
 * docs/divergences.md). So the old spelling put this file outside the subset it has to
 * compile — and the guard could never be true anyway, since nativets types the read
 * `Stmt` and comparing an 18-member union with `undefined` has no overlap (`NT2001`).
 * Pinned by an out-of-range-throws proxy in test/block-drops.test.ts, because node's own
 * answer is precisely the one this function must not depend on.
 *
 * REPLACE IS SPELLED POP-THEN-PUSH rather than as an in-place `last.names = names`, and
 * all three reasons are ownership rules this file must stay inside:
 *   1. `const last = list[n - 1]!` BINDS a heap element, making the local a second owner
 *      of a slot the array still holds — `NT1605`. Reading THROUGH the index is a borrow,
 *      so the `kind` test below is fine; it is the binding that was not.
 *   2. Mutating through that index instead (`list[n-1]!.names = …`) does not help: it is
 *      `NT1606` (the receiver is not a `@@mutable` path through an index), and tsc will
 *      not narrow an element access behind a computed index either (TS2339).
 *   3. `names` is a BORROWED parameter, so storing it into a node that outlives the call
 *      would give the marker a pointer the caller still frees — `NT1604`. The marker
 *      takes its OWN copy (`[...names]`), which is what makes the store sound.
 * Still idempotent, which is the property that matters: the list ends with exactly one
 * `BlockDrops` carrying `names`, however many times `loop()` re-walks the body. Only the
 * marker's object IDENTITY changes, and nothing reads it — the node is created here and
 * only ever consumed positionally by codegen. Identical under node.
 */
export function setBlockDrops(
  //@@mutable
  list: Stmt[],
  names: string[],
): void {
  const n = list.length;
  // `!` because `n > 0` is not something `noUncheckedIndexedAccess` can see: tsc types
  // every indexed read `Stmt | undefined` regardless of the guard beside it (TS18048).
  // The `n > 0 &&` short-circuit is what keeps index `-1` from ever being FORMED.
  if (n > 0 && list[n - 1]!.kind === "BlockDrops") { list.pop(); }
  list.push({ kind: "BlockDrops", names: [...names] });
}
export interface IfStmt { kind: "IfStmt"; test: Expr; consequent: Stmt[]; alternate: Stmt[] | null; }

/* ---- `body` IS SLOT 1 IN EVERY BODY-CARRYING STATEMENT. Keep it that way. ----------
 *
 * A field is readable off a union narrowed to several members only when it sits at the
 * SAME SLOT INDEX in each, with the same type (`unionCommonField`) — a read compiles to
 * one `getelementptr` at a constant offset, and members that disagree give it no single
 * offset to use. Source order here IS the layout.
 *
 * This started as `WhileStmt`/`DoWhileStmt` alone, which had disagreed on `test` vs
 * `body` and thereby made every `case "WhileStmt": case "DoWhileStmt":` arm touching
 * either one a blocker — five in `src/`. Nothing in the compiler needed changing; the
 * layouts just had to agree.
 *
 * The SAME defect, one size up, was the compiler's whole first self-hosting blocker.
 * `src/parser.ts`'s `valueReturns` walks a loop or block body with
 *
 *     case "WhileStmt": case "DoWhileStmt": case "ForStmt":
 *     case "ForOfStmt": case "ForInStmt": case "BlockStmt": walk(s.body);
 *
 * and `body` sat at slot 2, 2, 4, 4, 3 and 1 respectively — every member has it, all six
 * at `Stmt[]`, and it was unreadable purely because six declarations had drifted. That
 * arm is the first blocker of `cli`, `coverage`, `driver`, `modules` and `parser`, and of
 * the stage-1 program itself. It is fixed here, by declaration order, and not by splitting
 * the arm six ways: `BlockStmt` is `{kind, body}` and can only ever put `body` at slot 1,
 * so slot 1 is the only choice that lets it join any group at all.
 *
 * Falling out of the same move, `body` at 1 pushes `name` to slot 2 in BOTH `ForOfStmt`
 * and `ForInStmt`, which is what makes `src/modules.ts`'s
 * `case "ForOfStmt": case "ForInStmt": out.push(s.name); walk(s.body);` legal on both
 * fields at once. `WhileStmt`/`DoWhileStmt` keep their agreement too — `test` moves from
 * 1 to 2 in both together.
 *
 * SO: a new field goes AFTER `body`, never before it, and a new body-carrying statement
 * declares `kind` then `body`. Getting it wrong is a refusal, not a wrong answer, which
 * is the point — but it is a refusal that costs a self-hosting rung.
 *
 * Field order in an object LITERAL does not have to match (the checker reorders a literal
 * to its contextual type), so none of the construction sites in `src/parser.ts` moved.
 */
export interface WhileStmt { kind: "WhileStmt"; body: Stmt[]; test: Expr; }
export interface DoWhileStmt { kind: "DoWhileStmt"; body: Stmt[]; test: Expr; }
export interface ForStmt {
  kind: "ForStmt";
  body: Stmt[];
  init: VarDecl | Expr | null;
  test: Expr | null;
  update: Expr | null;
}
/**
 * `for (const x of it)`, plus the Map-entries form `for (const [k, v] of m)` /
 * `of m.entries()`: `name2` holds the value binding and the checker rewrites
 * `iterable` to the MAP itself (the loop walks its insertion-ordered keys and
 * looks each value up — no tuple type required).
 */
export interface ForOfStmt { kind: "ForOfStmt"; body: Stmt[]; name: string; annot?: Ty; iterable: Expr; elemTy?: Ty; name2?: string; valTy?: Ty; }
export interface ForInStmt { kind: "ForInStmt"; body: Stmt[]; name: string; object: Expr; }
export interface SwitchCase { test: Expr | null; body: Stmt[]; } // test null === default
export interface SwitchStmt { kind: "SwitchStmt"; discriminant: Expr; cases: SwitchCase[]; }
/** `line`/`col` are the `throw` keyword's own position — codegen refuses a throw it cannot
 *  lower (one with no enclosing `try` in the same function) and has no other way to say
 *  WHICH throw, since the statement is otherwise position-free.
 *
 *  `drops` is `ReturnStmt.drops` for the exceptional exit: the linear locals this frame
 *  still owns at the throw. A throw that PROPAGATES out of its frame (see `scanEscaping`
 *  in src/codegen.ts) leaves by a `ret`, so it must free exactly what a `return` here
 *  would free — the same `ownedInScope` set, computed at the same program point. Unset
 *  for a throw that stays in-frame (a branch to a local catch, which reaches the block's
 *  own drop points normally). */
export interface ThrowStmt { kind: "ThrowStmt"; argument: Expr; line?: number; col?: number; drops?: string[]; }
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
 * made this file's first blocker an NT0001 in the self-host histogram.
 *
 * A `Map` built with the `.set` chain, NOT `const HOST_MODULES: Record<string, string[]>
 * = { … }`, and the same reason applies to every dictionary table in `src/*.ts` (see
 * `test/record-dict.test.ts` for the census and the argument). The `Record` ANNOTATION was
 * always honest — this is a dictionary read with a RUNTIME key (`HOST_MODULES.get(mod)` in
 * `src/parser.ts`) — but an object literal cannot construct one: an object's fields are
 * fixed slots named by its TYPE, so nativets erases `Record<K,V>` to `Map<K,V>` and refuses
 * the literal (NT2001). Annotating the exact shape instead is not available either, because
 * the key is a variable and node's `o[k]` consults the PROTOTYPE CHAIN.
 * The chain is free under bun: `Map.prototype.set` returns its receiver (ES2024 24.1.3.9
 * step 8), so this is the same program the entries form would build. */
export const HOST_MODULES: Map<string, string[]> = new Map<string, string[]>()
  .set("node:fs", ["readFileSync", "writeFileSync", "existsSync", "mkdtempSync", "readdirSync", "rmSync"])
  .set("node:path", ["join", "dirname", "basename", "resolve", "relative"])
  .set("node:os", ["tmpdir", "homedir"])
  .set("node:url", ["fileURLToPath"])
  .set("node:child_process", ["spawnSync"]);

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
   *
   * SPELLED AS A NAMED RECORD, not as `[string, Ty][]`. A tuple type has no
   * representation in nativets — `parseTupleType` models `[T, U]` as `T[]`, so the
   * declaration read back as `string[][]` and `new Map(entries)` over it was `NT1014`,
   * the first blocker of NINE of the twelve modules. A two-field record is a shape the
   * compiler already handles everywhere, so this needs no new `Ty` encoding.
   */
  recTypes?: RecTypeEntry[];
}

/** One entry of {@link Program.recTypes} — the record spelling of a `[name, shape]` pair.
 *  See the note on that field for why this is not a tuple. */
export interface RecTypeEntry {
  name: string;
  ty: Ty;
}

/** The recursive-shape table as a lookup. Stored as pairs on the Program (JSON-shaped,
 *  and linker-mergeable); every consumer wants a Map.
 *
 *  Built with a `.set` LOOP rather than `new Map(entries)`: that is exactly what the
 *  constructor does internally (ES2024 24.1.1.1 §8 calls `set` per entry), and `Map` here
 *  is persistent, so the result of each `.set` is what carries forward. */
export function recTypeTable(p: Program): Map<string, Ty> {
  let m = new Map<string, Ty>();
  for (const e of p.recTypes ?? []) m = m.set(e.name, e.ty);
  return m;
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
/**
 * Strings that are syntactically FRESH — a new allocation the expression itself made,
 * which no binding names and no callee still owns.
 *
 * The string half of `freshArray`, and deliberately a WHITELIST for the same reason that
 * one is. The tempting predicate is codegen's `isStrProducer`, but it admits a plain
 * `CallExpr`, and a callee that hands back a string it still owns would then be freed by
 * its caller — a use-after-free traded for a leak, which is the wrong direction. Concat
 * and interpolation are the two forms that ALWAYS allocate, so they are the two here.
 *
 * `+` reaches this only where the iterable is already known to be a `string` (codegen's
 * `ForOfStmt` tests `src.ty`), so numeric addition never arrives. A constant-folded
 * concatenation is safe too: `nt_str_release` is a documented no-op for an untracked
 * pointer, which is exactly what a literal is.
 */
export function freshString(e: Expr): boolean {
  return e.kind === "TemplateLiteral" || (e.kind === "BinaryExpr" && e.op === "+");
}

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
 * Exactly SEVEN of the 30 `Expr` members carry a `loc` — Identifier, MemberExpr,
 * IndexExpr, IndexAssign, NonNullExpr, InExpr, CallExpr — and those seven are also the
 * only kinds anything in `src/` ever writes one onto. A literal, a binary operator or an
 * assignment does not, so `e.loc` alone is `undefined` for most expressions and the
 * diagnostics built from them came out unlocatable. That is not a
 * cosmetic problem: `[NT2001] return type string does not match declared number` with no
 * span, on a 4000-line file, cost a lane an instrumented build of the compiler to find
 * the line. Descending to the first child that DOES carry one is exact enough to jump to
 * (it is inside the offending expression) and always better than nothing.
 */
export function exprLoc(e: Expr | undefined): Loc | undefined {
  if (!e) return undefined;
  switch (e.kind) {
    /*
     * THE SEVEN members that declare a `loc`, read through the TAG rather than through a
     * cast. This block used to be one line above the switch:
     *
     *     const own = (e as { loc?: Loc }).loc;
     *     if (own) return own;
     *
     * which is correct under `bun` — property access is dynamic, so it really did fetch
     * `loc` — and a MISCOMPILE the moment nativets compiles itself. `loc` is at slot 0 of
     * the asserted shape `{loc?: Loc}`, and slot 0 of every `Expr` member is `kind`, so
     * compiled this loads a STRING POINTER and hands it back as a `?ULoc` box. Not for the
     * 23 members that lack a `loc` — for ALL 30, the seven real carriers included, because
     * the cast never consulted the member layout at all. The checked-`as` work turned it
     * into an NT2001 refusal, which is the only reason it was ever noticed.
     *
     * Exactly seven members declare the field (verified against the parser's resolved
     * `Expr` type, and against the fact that these same seven are the ONLY kinds any code
     * in `src/` ever writes a `loc` onto — so tag dispatch loses nothing the dynamic read
     * found). The multi-tag arm is legal because `unionCommonField` holds for it: `loc` is
     * at slot 5 with the same widened type in all four. IF YOU ADD A FIELD to MemberExpr,
     * IndexExpr, InExpr or CallExpr, put it AFTER `loc` or split this arm — the slots must
     * agree. Getting that wrong is a refusal, not a wrong answer, which is the point.
     */
    case "Identifier": return e.loc; // slot 3, on its own
    case "MemberExpr": case "IndexExpr": case "InExpr": case "CallExpr": return e.loc; // slot 5
    // The two carriers that ALSO have a structural fallback, kept in that order: the
    // node's own `loc` wins, and the descent answers only when the parser left it unset
    // (a desugared node). `NonNullExpr` is split out of the `AsExpr`/`SatisfiesExpr` arm
    // below for exactly this reason — the other two have no `loc` to prefer.
    case "NonNullExpr": return e.loc ?? exprLoc(e.expr);
    case "IndexAssign": return e.loc ?? exprLoc(e.object) ?? exprLoc(e.index) ?? exprLoc(e.value);
    case "BinaryExpr": case "LogicalExpr": return exprLoc(e.left) ?? exprLoc(e.right);
    // `operand`, NOT `argument` — this read `e.argument` (an ESTree name; the interface
    // at `UnaryExpr` above has no such field) from the day it was written, so it was
    // `exprLoc(undefined)` and EVERY unary expression reported no location at all.
    // `f(-n)` where `f` takes a string got a bare `NT2001 … got number`; `f(n)` got the
    // same error `at 3:3` with a source frame. Found by tsc (TS2339) once the pipeline
    // fixtures stopped masking semantic diagnostics — see tsconfig.src.json.
    case "UnaryExpr": return exprLoc(e.operand);
    case "AsExpr": case "SatisfiesExpr": return exprLoc(e.expr);
    // The ASSIGNMENT forms. None of `FieldAssign`/`AssignExpr`/`UpdateExpr` carries a
    // `loc`, and none had an arm here, so `exprLoc(fieldAssign)` was `undefined` while
    // `exprLoc(fieldAssign.object)` gave a real position two lines away — which is why
    // NT1606, the most-hit refusal in the tree, printed no location at all. A store is
    // located by its RECEIVER: that is where the statement starts and what a reader
    // scans for (`IndexAssign` DOES carry the written `[`, so it prefers its own `loc`
    // and keeps this descent as its fallback — see its arm above). An `AssignExpr` names
    // its target with a bare string, so the value is the only child that can carry a
    // position.
    case "FieldAssign": return exprLoc(e.object) ?? exprLoc(e.value);
    case "AssignExpr": return exprLoc(e.value);
    case "UpdateExpr": return exprLoc(e.targetExpr);
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
/**
 * The type the checker recorded on an expression — `e.ty`, read through the TAG.
 *
 * ALL THIRTY `Expr` members declare `ty`, and it sits at FIVE DIFFERENT SLOTS across them
 * (1 for the two nullish literals, 2, 3, 4, and 5 for `UpdateExpr`/`IndexAssign`/
 * `ArrowFunction`). So `unionCommonField` does not hold and there is no free shared read:
 * `(e as { ty?: Ty }).ty`, which is how `guardFacts` used to spell it, names slot 0 — and
 * slot 0 of every member is `kind`. Compiled, that returned the kind STRING for all 30.
 *
 * ONE ARM PER KIND, deliberately, where `exprLoc` groups its tags. Grouping is what makes
 * a multi-tag arm depend on the grouped members agreeing on a slot, and that agreement is
 * exactly what is false here. A per-kind arm cannot be slot-wrong: the compiler resolves
 * each narrowed member's own offset.
 *
 * EXHAUSTIVENESS IS TESTED, NOT TYPED. The `default: { const impossible: never = e; … }`
 * idiom `walkExprChildren` uses would be the natural spelling and it is deliberately not
 * used here: `never` erases to `number` in this compiler's own subset, so that arm is an
 * NT2001 blocker — `walkExprChildren` carries exactly that blocker today, and copying the
 * idiom into a new function measurably added one. test/cast-write.test.ts reads the `Expr`
 * union out of this file and asserts every member has an arm below, which is the same
 * guarantee without the self-host cost.
 */
export function exprTy(e: Expr): Ty | undefined {
  switch (e.kind) {
    case "NumberLiteral": return e.ty;
    case "BooleanLiteral": return e.ty;
    case "StringLiteral": return e.ty;
    case "TemplateLiteral": return e.ty;
    case "UndefinedLiteral": return e.ty;
    case "NullLiteral": return e.ty;
    case "ArrayLiteral": return e.ty;
    case "ObjectLiteral": return e.ty;
    case "Identifier": return e.ty;
    case "MemberExpr": return e.ty;
    case "IndexExpr": return e.ty;
    case "UnaryExpr": return e.ty;
    case "UpdateExpr": return e.ty;
    case "BinaryExpr": return e.ty;
    case "LogicalExpr": return e.ty;
    case "ConditionalExpr": return e.ty;
    case "SequenceExpr": return e.ty;
    case "AssignExpr": return e.ty;
    case "IndexAssign": return e.ty;
    case "FieldAssign": return e.ty;
    case "TypeofExpr": return e.ty;
    case "SpreadExpr": return e.ty;
    case "ArrowFunction": return e.ty;
    case "NewExpr": return e.ty;
    case "AsExpr": return e.ty;
    case "SatisfiesExpr": return e.ty;
    case "NonNullExpr": return e.ty;
    case "InstanceOfExpr": return e.ty;
    case "InExpr": return e.ty;
    case "CallExpr": return e.ty;
    default: return undefined;
  }
}

/**
 * The elements of an `ArrayLiteral`, and the text of a `StringLiteral` — the two literal
 * shapes `Object.fromEntries` has to read out of the AST, in the checker to build the
 * result type and again in codegen to fill the object's slots.
 *
 * THEY LIVE HERE, not at either call site, and that is the entire point. Both used to be
 * duck-typed windows — `(x as { elements: Expr[] }).elements`, `(x as { value: string })
 * .value` — which name their field at slot 0 while `ArrayLiteral` and `StringLiteral`
 * carry it at slot 1 and slot 0 is `kind`. Compiled, both read the `kind` STRING POINTER
 * and used it as an array / a key.
 *
 * The obvious repair, widening each window to `{kind, elements}` so it is slot-correct,
 * does not work from another module and it is worth recording why: `Expr` resolves to the
 * EXPANDED union at an importing call site but to the type REF `@…Expr` in this file's own
 * declarations, and `objectLayoutFits` compares those two spellings as strings, so it
 * reports "no member of the union can be read through that shape" for a window that is in
 * fact laid out correctly. Inside THIS module the tag test narrows directly and no window
 * is needed at all — no cast, no runtime tag check, and the accessor is the only place
 * that has to know the layout.
 *
 * `undefined` for any other expression, so a caller that has already proved the shape can
 * `??` a fallback and one that has not can fail loudly. Neither may assume.
 */
export function arrayElements(e: Expr): Expr[] | undefined {
  return e.kind === "ArrayLiteral" ? e.elements : undefined;
}

/** The text of a `StringLiteral`; `undefined` for anything else. See `arrayElements`. */
export function stringLiteralValue(e: Expr): string | undefined {
  return e.kind === "StringLiteral" ? e.value : undefined;
}

export function exprText(e: Expr): string | undefined {
  if (e.kind === "Identifier") return e.name;
  if (e.kind === "MemberExpr") {
    const o = exprText(e.object);
    return o === undefined ? undefined : o + ((e.optional ?? false) ? "?." : ".") + e.property;
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

/* ---------------------------------------------------------------------------
 * TYPED AST TRAVERSAL — one exhaustive walker, three passes driven by it
 *
 * The three passes below (`mapTypesDeep`, `resolveStaticFieldReads`,
 * `collectBindingNames`) used to be REFLECTIVE: `n: unknown`, `Array.isArray(n)`, a cast
 * to `Record<string, unknown>`, and a walk over `Object.keys(o)`. Nine reflection sites
 * over an AST with 48 node kinds. Two things were wrong with that, and only one of them
 * is about self-hosting.
 *
 *   1. It was the last STRUCTURAL blocker for NINE of the twelve compiler modules —
 *      `NT1011`, `for-of` over `unknown`, with `Object.keys expects an object` behind it.
 *      Every module that imports this one — which is every module — inherited it through
 *      the link, so nine modules reported a blocker that lived in these seventy lines.
 *   2. A reflective walk cannot be told that it MISSED something. It visits whichever
 *      keys happen to be present, so a node kind nobody thought about is traversed as an
 *      anonymous bag of fields: the per-node decision (does this bind a name? does this
 *      field hold a `Ty`?) that nobody wrote simply does not happen, silently. That is
 *      the same hazard that let `ModuleGen.expr` fall through on `NonNullExpr`, here at
 *      48× the surface.
 *
 * So the recursion is factored ONCE, into `walkExprChildren`/`walkStmtChildren`, and each
 * of those ends in a `default:` arm that binds `never`: a kind added to `Expr` or `Stmt`
 * without a case here is a COMPILE-TIME type error, not a silently skipped subtree. The
 * three passes supply only their own per-node work.
 *
 * WHY THE `Ty` REWRITE LIVES IN THE SHARED WALKER instead of in `mapTypesDeep`'s own
 * per-node body. The reflective walk visited a node's `Ty`-bearing fields INTERLEAVED with
 * its children, in `Object.keys` (i.e. construction) order: `Param.annot` before
 * `Param.default`, `Declarator.annot` before `Declarator.init`, `FuncDecl.returnAnnot`
 * between `params` and `body`, `ForOfStmt.annot` before `iterable` and `elemTy` after
 * `body`. Hoisting them all before or all after the children would REORDER the calls to
 * `f`, and `f` is allowed to throw — the checker's belt-and-braces "`#T` survived
 * monomorphization" guard does — so the order is observable in a diagnostic. The walker
 * therefore takes the `Ty` rewrite too and applies it exactly where the old key order did; the
 * two passes that do not rewrite types pass `KEEP_TY`.
 *
 * The fields that hold a `Ty` are exactly the old `TY_FIELDS`/`TY_LIST_FIELDS` tables,
 * now spelled as the field accesses themselves: `annot`, `ty`, `returnAnnot`, `retAnnot`,
 * `retTy`, `catchTy`, `elemTy`, plus the lists `typeArgs` and `paramTys`. Never a
 * `name`/`property`/string-literal `value`, so a program that happens to contain the text
 * `#T` in a string is untouched, exactly as before.
 *
 * ONE ASYMMETRY IS PRESERVED ON PURPOSE, because it was in the old tables and this
 * rewrite is meant to be observationally null: `ForOfStmt.valTy` holds a `Ty` and is NOT
 * rewritten (its sibling `ForOfStmt.elemTy` is). It is a checker-RESOLVED type, set after
 * the only pass that substitutes type parameters has run, so nothing observable depends
 * on it today — but it is a latent trap for anyone who adds a `Ty` rewrite that runs later.
 *
 * `FuncDecl.returnTy` was the other half of that pair and is GONE: the resolved return
 * type is `Sig.ret` in the checker's signature table and nowhere else, so there is no
 * second copy for a later `Ty` rewrite to miss.
 */

/** The identity `Ty` rewrite, for the two passes that only WALK the type fields.
 *  Written `(t: Ty): Ty` rather than through a `type TyFn = …` alias, for the same reason
 *  `ExprFn`/`StmtFn` are inlined below plus one more: `coverage` strips undecorated type
 *  declarations, so an arrow whose parameter type comes only from such an alias reports
 *  "cannot infer type of arrow parameter" in that tool and nowhere else. */
const KEEP_TY = (t: Ty): Ty => t;
/* EVERY child slot is a REWRITE (the parent stores what comes back), and the walkers
 * RETURN a new node rather than assigning into the one they were given. That is how
 * `resolveStaticFieldReads` replaces a `MemberExpr` with an `Identifier` without needing
 * the reflective `o[k] = …` it used to do — and it is the only spelling of an AST
 * rewrite this compiler can compile ITSELF.
 *
 * WHY RETURN INSTEAD OF ASSIGN. `walkExprChildren(e: Expr, …)` used to write `e.object =
 * fe(e.object)` and `e.ty = ft(e.ty)`. Both are `o.f = v` on a PARAMETER, which is
 * refused twice over: the receiver's type is not `@@mutable` (NT1606 in the checker), and
 * even tagged it would be a write through a BORROW (NT1607 in the ownership pass). The
 * tag is not available either — `@@mutable` is nominal, and a tagged member makes the
 * `Expr`/`Stmt` union `NT1009` (measured, one member tagged and both). Reconstruction
 * needs no new language rule at all: `{ ...e, kind: "K", f: v }` typechecks, runs, and
 * gives the right answer today, including through a recursive union.
 *
 * NECESSARY, NOT SUFFICIENT: this clears the 45 `o.f = v` sites in these walkers and NONE
 * of the other ~154 in the tree (`setBlockDrops` right here is one of them). See
 * docs/self-hosting.md for the census and the general answer.
 *
 * COST, stated because it is real: a pass now allocates a node per node instead of
 * writing a slot, and the old spine is not freed (drop is shallow), so a rewrite leaks
 * its input. `collectBindingNames` builds a tree it throws away entirely; it is only
 * reached when the program declares a static field.
 *
 * Spelled INLINE at every position rather than as `type ExprFn = (e: Expr) => Expr`. An
 * alias whose shape mentions a RECURSIVE type is `NT1030` — this compiler refuses it —
 * and `Expr` is a 30-member mutually recursive component, so the alias would have planted
 * a parse-stage blocker in the file this rewrite exists to unblock. */

/** A `Ty` slot that may be absent: rewrite it where it is present, leave it alone where
 *  it is not. Spelled as a helper because the shape appears ~40 times below and the
 *  reconstruction has to keep the ORDER of the `ft` calls (see the header). */
function mapTy(t: Ty | undefined, ft: (t: Ty) => Ty): Ty | undefined {
  return t === undefined ? undefined : ft(t);
}
function mapTyList(ts: Ty[] | undefined, ft: (t: Ty) => Ty): Ty[] | undefined {
  return ts === undefined ? undefined : ts.map((t: Ty): Ty => ft(t));
}
function mapExprList(list: Expr[], fe: (x: Expr) => Expr): Expr[] {
  return list.map((x: Expr): Expr => fe(x));
}
function mapStmtList(list: Stmt[], fs: (x: Stmt) => Stmt): Stmt[] {
  return list.map((x: Stmt): Stmt => fs(x));
}
/** A parameter list: `annot` first, then `default` — the old key order. */
function mapParams(params: Param[], fe: (x: Expr) => Expr, ft: (t: Ty) => Ty): Param[] {
  return params.map((p: Param): Param => ({
    ...p,
    annot: mapTy(p.annot, ft),
    default: p.default === undefined ? undefined : fe(p.default),
  }));
}

/**
 * Every child of an expression, rewritten — the parent stores what comes back.
 *
 * NO `default:` ARM, and that is what makes the switch exhaustive. Every arm returns and
 * the declared return type is `Expr`, so a new `Expr` member with no arm lets control
 * reach the end of the body and tsc rejects it: TS2366, "function lacks ending return
 * statement and return type does not include 'undefined'". test/tsc.test.ts proves it by
 * deleting an arm from a copy of this file and reading tsc's answer.
 *
 * The `default: { const impossible: never = e; return impossible; }` witness that used to
 * stand here was REDUNDANT with that check and not free: `never` erases to `number` in
 * this compiler's own subset, so the arm was an NT2001 blocker — and it was the ONLY
 * blocker this function carried. The exhaustiveness is unchanged; the blocker is gone.
 * Note the asymmetry — the same deletion in `bindStmt` below is SILENT under tsc, because
 * its arms `break` into a shared tail return, so that witness stays. Measured per site,
 * not applied as a rule.
 *
 * Each arm restates its own `kind` even though `...e` already carries it. That is NOT
 * redundant here: a spread does not carry a string-LITERAL type, so `{ ...e, ty: … }`
 * on a narrowed union member is "an object literal … must set 'kind' to one of the
 * literals" (NT2001) under nativets itself. Measured, not assumed.
 */
export function walkExprChildren(e: Expr, fe: (x: Expr) => Expr, fs: (x: Stmt) => Stmt, ft: (t: Ty) => Ty): Expr {
  switch (e.kind) {
    // Leaves: no child expressions. Spelled one arm each rather than sharing a fallthrough
    // label, because each arm has to name its own tag literal (see the note above).
    case "NumberLiteral": return { ...e, kind: "NumberLiteral", ty: mapTy(e.ty, ft) };
    case "BooleanLiteral": return { ...e, kind: "BooleanLiteral", ty: mapTy(e.ty, ft) };
    case "StringLiteral": return { ...e, kind: "StringLiteral", ty: mapTy(e.ty, ft) };
    case "UndefinedLiteral": return { ...e, kind: "UndefinedLiteral", ty: mapTy(e.ty, ft) };
    case "NullLiteral": return { ...e, kind: "NullLiteral", ty: mapTy(e.ty, ft) };
    case "Identifier": return { ...e, kind: "Identifier", ty: mapTy(e.ty, ft) };
    case "TemplateLiteral":
      return { ...e, kind: "TemplateLiteral", exprs: mapExprList(e.exprs, fe), ty: mapTy(e.ty, ft) };
    case "ArrayLiteral":
      return { ...e, kind: "ArrayLiteral", elements: mapExprList(e.elements, fe), ty: mapTy(e.ty, ft) };
    case "ObjectLiteral":
      return { ...e, kind: "ObjectLiteral",
        properties: e.properties.map((p: ObjectProperty): ObjectProperty => ({ ...p, value: fe(p.value) })),
        ty: mapTy(e.ty, ft) };
    case "SpreadExpr": return { ...e, kind: "SpreadExpr", argument: fe(e.argument), ty: mapTy(e.ty, ft) };
    case "MemberExpr": return { ...e, kind: "MemberExpr", object: fe(e.object), ty: mapTy(e.ty, ft) };
    case "IndexExpr": return { ...e, kind: "IndexExpr", object: fe(e.object), index: fe(e.index), ty: mapTy(e.ty, ft) };
    case "UnaryExpr": return { ...e, kind: "UnaryExpr", operand: fe(e.operand), ty: mapTy(e.ty, ft) };
    case "TypeofExpr": return { ...e, kind: "TypeofExpr", operand: fe(e.operand), ty: mapTy(e.ty, ft) };
    case "UpdateExpr":
      return { ...e, kind: "UpdateExpr",
        targetExpr: e.targetExpr === undefined ? undefined : fe(e.targetExpr), ty: mapTy(e.ty, ft) };
    case "BinaryExpr": return { ...e, kind: "BinaryExpr", left: fe(e.left), right: fe(e.right), ty: mapTy(e.ty, ft) };
    case "LogicalExpr": return { ...e, kind: "LogicalExpr", left: fe(e.left), right: fe(e.right), ty: mapTy(e.ty, ft) };
    case "SequenceExpr": return { ...e, kind: "SequenceExpr", exprs: mapExprList(e.exprs, fe), ty: mapTy(e.ty, ft) };
    case "ConditionalExpr":
      return { ...e, kind: "ConditionalExpr",
        test: fe(e.test), consequent: fe(e.consequent), alternate: fe(e.alternate), ty: mapTy(e.ty, ft) };
    case "AssignExpr": return { ...e, kind: "AssignExpr", value: fe(e.value), ty: mapTy(e.ty, ft) };
    case "IndexAssign":
      return { ...e, kind: "IndexAssign", object: fe(e.object), index: fe(e.index), value: fe(e.value), ty: mapTy(e.ty, ft) };
    case "FieldAssign":
      return { ...e, kind: "FieldAssign", object: fe(e.object), value: fe(e.value), ty: mapTy(e.ty, ft) };
    case "InstanceOfExpr": return { ...e, kind: "InstanceOfExpr", object: fe(e.object), ty: mapTy(e.ty, ft) };
    case "InExpr": return { ...e, kind: "InExpr", key: fe(e.key), object: fe(e.object), ty: mapTy(e.ty, ft) };
    // `AsExpr.ty`/`SatisfiesExpr.ty` are REQUIRED (`ty: Ty`, not `ty?: Ty`), so the
    // guarded `mapTy` would widen them to `Ty | undefined`. tsc catches it; the old
    // `if (e.ty !== undefined)` was simply always true for these two.
    case "AsExpr": return { ...e, kind: "AsExpr", expr: fe(e.expr), ty: ft(e.ty) };
    case "SatisfiesExpr": return { ...e, kind: "SatisfiesExpr", expr: fe(e.expr), ty: ft(e.ty) };
    case "NonNullExpr": return { ...e, kind: "NonNullExpr", expr: fe(e.expr), ty: mapTy(e.ty, ft) };
    case "NewExpr":
      return { ...e, kind: "NewExpr", args: mapExprList(e.args, fe), typeArgs: mapTyList(e.typeArgs, ft), ty: mapTy(e.ty, ft) };
    case "CallExpr":
      return { ...e, kind: "CallExpr",
        callee: fe(e.callee), args: mapExprList(e.args, fe), typeArgs: mapTyList(e.typeArgs, ft), ty: mapTy(e.ty, ft) };
    case "ArrowFunction":
      // Exactly one of `body`/`stmts` is populated — `exprBody` says which (see the note
      // on the interface: it is two fields rather than a union for a self-hosting reason).
      return { ...e, kind: "ArrowFunction",
        params: mapParams(e.params, fe, ft),
        body: e.body === undefined ? undefined : fe(e.body),
        stmts: e.stmts === undefined ? undefined : mapStmtList(e.stmts, fs),
        retAnnot: mapTy(e.retAnnot, ft),
        paramTys: mapTyList(e.paramTys, ft),
        retTy: mapTy(e.retTy, ft),
        captures: e.captures === undefined ? undefined
          : e.captures.map((c: { name: string; ty: Ty }): { name: string; ty: Ty } => ({ ...c, ty: ft(c.ty) })),
        ty: mapTy(e.ty, ft) };
  }
}

/**
 * Every child of a statement, rewritten — the parent stores what comes back.
 *
 * NO `default:` ARM, for the reason on `walkExprChildren`: every arm returns and the
 * declared return type is `Stmt`, so a missing arm is TS2366 at this line. The `never`
 * witness that used to stand here was an NT2001 blocker (this compiler erases `never` to
 * `number`) buying nothing tsc was not already checking. It was MASKED behind this
 * function's first blocker, so removing it moved no number today — it was a blocker that
 * would have surfaced the moment the one above it cleared.
 */
export function walkStmtChildren(s: Stmt, fe: (x: Expr) => Expr, fs: (x: Stmt) => Stmt, ft: (t: Ty) => Ty): Stmt {
  switch (s.kind) {
    case "VarDecl":
      return { ...s, kind: "VarDecl",
        decls: s.decls.map((d: Declarator): Declarator => ({
          ...d,
          annot: mapTy(d.annot, ft),
          init: d.init === undefined ? undefined : fe(d.init),
          ty: mapTy(d.ty, ft),
        })) };
    case "FuncDecl":
      return { ...s, kind: "FuncDecl",
        params: mapParams(s.params, fe, ft),
        returnAnnot: mapTy(s.returnAnnot, ft),
        body: mapStmtList(s.body, fs) };
    case "ReturnStmt":
      return { ...s, kind: "ReturnStmt", argument: s.argument === null ? null : fe(s.argument) };
    case "IfStmt":
      return { ...s, kind: "IfStmt",
        test: fe(s.test),
        consequent: mapStmtList(s.consequent, fs),
        alternate: s.alternate === null ? null : mapStmtList(s.alternate, fs) };
    case "WhileStmt": return { ...s, kind: "WhileStmt", test: fe(s.test), body: mapStmtList(s.body, fs) };
    case "DoWhileStmt": return { ...s, kind: "DoWhileStmt", body: mapStmtList(s.body, fs), test: fe(s.test) };
    case "ForStmt":
      return { ...s, kind: "ForStmt",
        init: s.init === null ? null : s.init.kind === "VarDecl" ? (fs(s.init) as VarDecl) : fe(s.init),
        test: s.test === null ? null : fe(s.test),
        update: s.update === null ? null : fe(s.update),
        body: mapStmtList(s.body, fs) };
    case "ForOfStmt":
      return { ...s, kind: "ForOfStmt",
        annot: mapTy(s.annot, ft),
        iterable: fe(s.iterable),
        body: mapStmtList(s.body, fs),
        elemTy: mapTy(s.elemTy, ft) }; // `valTy` is NOT rewritten — see the header
    case "ForInStmt": return { ...s, kind: "ForInStmt", object: fe(s.object), body: mapStmtList(s.body, fs) };
    case "SwitchStmt":
      return { ...s, kind: "SwitchStmt",
        discriminant: fe(s.discriminant),
        cases: s.cases.map((c: SwitchCase): SwitchCase => ({
          ...c, test: c.test === null ? null : fe(c.test), body: mapStmtList(c.body, fs),
        })) };
    case "ThrowStmt": return { ...s, kind: "ThrowStmt", argument: fe(s.argument) };
    case "TryStmt":
      return { ...s, kind: "TryStmt",
        block: mapStmtList(s.block, fs),
        handler: s.handler === null ? null : mapStmtList(s.handler, fs),
        finalizer: s.finalizer === null ? null : mapStmtList(s.finalizer, fs),
        catchTy: mapTy(s.catchTy, ft) };
    case "ExprStmt": return { ...s, kind: "ExprStmt", expr: fe(s.expr) };
    case "BlockStmt": return { ...s, kind: "BlockStmt", body: mapStmtList(s.body, fs) };
    case "MultiStmt": return { ...s, kind: "MultiStmt", stmts: mapStmtList(s.stmts, fs) };
    // No children, and nothing type-bearing. `BlockDrops` is the ownership pass's
    // synthesized scope-exit marker; the other two are leaves.
    //
    // Spelled `{ ...s }` rather than the bare `return s` these three used to be. `s` is a
    // BORROWED parameter, so handing it straight back makes the result a second owner of
    // a node the caller still frees — `NT1604`, and the only three arms of this walker
    // that did it (every other arm already builds a fresh node). A shallow spread is the
    // right copy depth here precisely because these kinds have no children to alias:
    // `BreakStmt`/`ContinueStmt` are `kind`-only, and `BlockDrops.names` is rebuilt
    // rather than shared, since it is the one field that is a heap array. Observationally
    // null in node — this is a MAPPING walker whose callers rebind the result, so nothing
    // depended on the returned node being reference-identical to the input.
    case "BreakStmt": return { ...s, kind: "BreakStmt" };
    case "ContinueStmt": return { ...s, kind: "ContinueStmt" };
    case "BlockDrops": return { ...s, kind: "BlockDrops", names: [...s.names] };
  }
}

/* ---- pass 1: rewrite every type-bearing field ------------------------------ */

function tyExpr(e: Expr, f: (t: Ty) => Ty): Expr {
  return walkExprChildren(e, (x: Expr): Expr => tyExpr(x, f), (s: Stmt): Stmt => tyStmt(s, f), f);
}
function tyStmt(s: Stmt, f: (t: Ty) => Ty): Stmt {
  return walkStmtChildren(s, (x: Expr): Expr => tyExpr(x, f), (y: Stmt): Stmt => tyStmt(y, f), f);
}
/** Deep-rewrite every type-bearing field of a statement LIST. Returns the NEW list —
 *  the caller must rebind (see the header). */
export function mapTypesDeep(list: Stmt[], f: (t: Ty) => Ty): Stmt[] {
  return list.map((s: Stmt): Stmt => tyStmt(s, f));
}
/** …of one statement (a generic template's specialized `FuncDecl`, in practice). */
export function mapTypesDeepStmt(s: Stmt, f: (t: Ty) => Ty): Stmt { return tyStmt(s, f); }
/** …of one expression (a generic ARROW, in practice). */
export function mapTypesDeepExpr(e: Expr, f: (t: Ty) => Ty): Expr { return tyExpr(e, f); }

/* ---- pass 2: `C.f` static-field reads → the `C.f` module binding ----------- */

/**
 * The dotted name `C.f` for a `Ident.prop` member expression, or `""` for anything else —
 * the one shape a static field can be reached by, since the rewrite below is by NAME.
 *
 * `""` rather than `undefined` as the miss: the caller tests it against `names`, and an
 * empty string is not a binding name any more than a dotted one is a source identifier.
 */
function staticDottedName(t: Expr): string {
  if (t.kind === "MemberExpr" && t.object.kind === "Identifier") return `${t.object.name}.${t.property}`;
  return "";
}

function staticExpr(e: Expr, names: Set<string>, onAssign?: (name: string, at: Loc | undefined) => never): Expr {
  // `C.f = v` — a WRITE to a static field. Not a read, so never rewritten; the caller
  // refuses it by name (a static field lowers to a `const`).
  //
  // The POSITION goes out with the name. Both callers (src/parser.ts, src/modules.ts)
  // raise NT1606 from here, and neither had anything to locate it with — the handler took
  // a name and nothing else, so the most-hit refusal in the tree reported a static-field
  // write with no line at all. The offending node is right here, and `e.object` is the
  // class name, which is where the statement starts.
  //
  // The handler's type is spelled INLINE, and `at` is `Loc | undefined` rather than
  // `at?: Loc`: a function TYPE with an OPTIONAL parameter does not parse in the subset
  // this file must stay inside — `type F = (at?: T) => R` is refused NT2003 "Cannot find
  // name 'at'", blaming the parameter NAME as an unresolved type, while the identical
  // optional parameter on a real function declaration compiles. The two spellings are the
  // same type at every call site here, so this costs nothing and keeps ast.ts parse-clean
  // (test/sh6.test.ts's twelve-module list).
  if (onAssign !== undefined && e.kind === "FieldAssign" && e.object.kind === "Identifier"
      && names.has(`${e.object.name}.${e.field}`)) {
    onAssign(`${e.object.name}.${e.field}`, exprLoc(e));
  }
  // `C.f++` / `++C.f` / `C.f--` / `--C.f` — the SAME write, in the other spelling, and it
  // has to be caught HERE, above the read rewrite, for the same reason `FieldAssign` is.
  //
  // This arm was missing, and its absence was a compiler CRASH rather than a wrong answer
  // or a missing refusal. An `UpdateExpr` was not a write to this pass, so the walk fell
  // through to the rewrite below, which found the `C.f` MemberExpr sitting in `targetExpr`
  // and replaced it with the bare Identifier `"C.f"`. Codegen's UpdateExpr arm dispatches
  // `targetExpr` on `IndexExpr` and then ASSERTS MemberExpr for everything else, so it
  // read `.object` off an Identifier and handed `undefined` to `genExpr` — an internal
  // `TypeError`, no NT code, no location. (Codegen's assertion is now a checked narrowing
  // that raises `internalError` instead; this arm is what keeps it unreachable.)
  //
  // WHY IT WAS MISSED, since the same hole is worth not re-cutting: the write forms were
  // enumerated by LISTING them, not by exhausting them. `C.f = v` and `C.f += v` both
  // parse to `FieldAssign` (a compound store is one node with an `op`), so a single arm
  // covered two spellings and looked complete; `++`/`--` parse to a different node and
  // fell through. `C.f[i] = v`, `C.f.g = v` and `C.f.push(x)` do NOT need an arm — they
  // are refused downstream, by the immutability rules for the array/object the static
  // holds, and a census of all four update spellings × top level / function body / static
  // method body found no other form that reached codegen.
  if (onAssign !== undefined && e.kind === "UpdateExpr") {
    // The optional child is unwrapped with a TERNARY, not by binding it to an
    // `Expr`-typed local behind an `if (… !== undefined)`. This file must stay inside the
    // subset it compiles, and that narrowing is not in it: `const tgt: Expr = e.targetExpr`
    // is `NT2001 'tgt' declared Expr<<UNION>> but initialized with ?UU<<UNION>>` — the
    // guard does not reach a member path. It took `ast.ts` from 0 blockers to 1, measured.
    // `tyExpr`'s own `UpdateExpr` arm (`e.targetExpr === undefined ? undefined : fe(…)`)
    // is the spelling that works, so this matches it.
    const name = e.targetExpr === undefined ? "" : staticDottedName(e.targetExpr);
    if (name !== "" && names.has(name)) onAssign(name, exprLoc(e));
  }
  // A `?.` link is left alone (rewriting it would silently drop the optional; a class name
  // is never nullish, so the read is rejected instead).
  if (e.kind === "MemberExpr" && !(e.optional ?? false) && e.object.kind === "Identifier"
      && names.has(`${e.object.name}.${e.property}`)) {
    const id: Identifier = { kind: "Identifier", name: `${e.object.name}.${e.property}` };
    return id; // rewritten: its only child WAS the class name, so there is nothing below
  }
  return walkExprChildren(e, (x: Expr): Expr => staticExpr(x, names, onAssign),
    (s: Stmt): Stmt => staticStmt(s, names, onAssign), KEEP_TY);
}
function staticStmt(s: Stmt, names: Set<string>, onAssign?: (name: string, at: Loc | undefined) => never): Stmt {
  return walkStmtChildren(s, (x: Expr): Expr => staticExpr(x, names, onAssign),
    (y: Stmt): Stmt => staticStmt(y, names, onAssign), KEEP_TY);
}
/**
 * Rewrite every read of a STATIC field — `C.f` on a bare class name — into the plain
 * Identifier `C.f`, the module-level `const` the parser lowered it to. Returns the NEW
 * list; the caller must rebind.
 *
 * This runs at the END of parsing, before any analysis, and that is the point: a static
 * field is not a slot on a receiver, it is a module binding, so every pass that reasons
 * about NAMES (globals promotion, closure capture, ownership) has to see an identifier or
 * it does not see the read at all. No source identifier can contain a `.`, so the dotted
 * name is unambiguous.
 */
export function resolveStaticFieldReads(list: Stmt[], names: Set<string>, onAssign?: (name: string, at: Loc | undefined) => never): Stmt[] {
  return list.map((s: Stmt): Stmt => staticStmt(s, names, onAssign));
}

/* ---- pass 3: every name the program binds --------------------------------- */

/**
 * The name accumulator this pass threads down the walk — a RECORD around the set rather
 * than the bare `Set<string>` it used to be, and the difference is the whole reason both
 * binders now compile.
 *
 * `Set` here is PERSISTENT: `.add` returns a new set and leaves the receiver alone, so
 * `out.add(name)` on a bare parameter did nothing at all and was refused NT1606. There is
 * nowhere to return the updated set to either — the accumulator is threaded through
 * `walkExprChildren`/`walkStmtChildren`, whose callbacks are `(x: Expr) => Expr` and
 * `(y: Stmt) => Stmt`, so the "rebind at the call site" answer the rest of the tree uses
 * is structurally unavailable here.
 *
 * `//@@mutable` on a RECORD is the answer, and it is the one `ThisHit` below already
 * uses: a by-borrow parameter whose type is a `@@mutable` record may be assigned in place
 * (src/ownership.ts, `checkOwnedReceiver`'s signature arm — docs/decorators.md piece 3),
 * so `out.names = out.names.add(n)` is legal where `out.add(n)` was both refused and
 * wrong. The tag is NOMINAL, so it travels in the signature and every call site can see
 * that this parameter is written through.
 *
 * A `@@mutable` CLASS in the same position does NOT work, which is the distinction that
 * makes this a record: a class's write is a SETTER CALL on a borrowed receiver, and
 * `checkOwnedReceiver`'s signature arm is restricted to `mutable.records`. `out.note(n)`
 * on a `@@mutable class` collector is NT1607 "cannot mutate `out` through a borrow".
 * Measured both ways before this was written.
 */
//@@mutable
interface BoundNames { names: Set<string> }

function bindExpr(e: Expr, out: BoundNames): Expr {
  if (e.kind === "ArrowFunction") for (const p of e.params) if (p.name) out.names = out.names.add(p.name);
  return walkExprChildren(e, (x: Expr): Expr => bindExpr(x, out), (s: Stmt): Stmt => bindStmt(s, out), KEEP_TY);
}
/** The shared tail of every `bindStmt` arm. Spelled as a function rather than left as the
 *  statement after the switch so that EVERY arm can `return` it — see `bindStmt`. */
function bindChildren(s: Stmt, out: BoundNames): Stmt {
  return walkStmtChildren(s, (x: Expr): Expr => bindExpr(x, out), (y: Stmt): Stmt => bindStmt(y, out), KEEP_TY);
}
/**
 * NO `default:` ARM, for the reason `walkExprChildren` gives above: every arm RETURNS and
 * the declared return type is `Stmt`, so a new `Stmt` member with no arm lets control
 * reach the end of the body and tsc rejects it (TS2366).
 *
 * It used to `break` into a shared tail return, which made that check unavailable — tsc
 * has nothing to object to when the body ends in a statement — so it carried a
 * `default: { const impossible: never = s; return impossible; }` witness instead. That
 * witness was not free: `never` erases to `number` in the subset this file must stay
 * inside, so it was an NT2001 blocker in `src/ast.ts`, the module every other one is
 * measured through. Returning from each arm buys the same guarantee from tsc for nothing.
 * test/tsc.test.ts proves it by deleting an arm from a copy of this file and reading
 * tsc's answer, exactly as it does for the two walkers.
 */
function bindStmt(s: Stmt, out: BoundNames): Stmt {
  switch (s.kind) {
    // Parameters BEFORE the declared name, which is the order the old walk produced.
    case "FuncDecl": {
      for (const p of s.params) if (p.name) out.names = out.names.add(p.name);
      out.names = out.names.add(s.name);
      return bindChildren(s, out);
    }
    case "VarDecl": {
      for (const d of s.decls) out.names = out.names.add(d.name);
      return bindChildren(s, out);
    }
    case "ForOfStmt": {
      out.names = out.names.add(s.name);
      if (s.name2) out.names = out.names.add(s.name2);
      return bindChildren(s, out);
    }
    case "ForInStmt": out.names = out.names.add(s.name); return bindChildren(s, out);
    case "TryStmt": if (s.param) out.names = out.names.add(s.param); return bindChildren(s, out);
    // Every other statement kind binds NOTHING. Enumerated rather than defaulted, so a
    // new statement kind that DOES bind a name cannot slip past this pass in silence —
    // which is exactly the failure the old reflective spelling could not detect.
    case "ReturnStmt": case "IfStmt": case "WhileStmt": case "DoWhileStmt": case "ForStmt":
    case "SwitchStmt": case "ThrowStmt": case "ExprStmt": case "BlockStmt": case "MultiStmt":
    case "BreakStmt": case "ContinueStmt": case "BlockDrops":
      return bindChildren(s, out);
  }
}
/**
 * Every name the program BINDS — declarations, function/arrow parameters, loop and catch
 * bindings. A pure VISITOR: the reconstructed tree it builds on the way is discarded, so
 * no caller has to rebind anything; the SET is what comes back.
 *
 * It RETURNS the set rather than filling one the caller passes in, which is not a style
 * choice: `Set` is persistent here, so a caller's set could never have observed an append
 * made inside this call at all. The old out-parameter spelling only ever "worked" under
 * node, where `.add` mutates.
 *
 * Used to protect the static-field rewrite above: that rewrite is name-based and
 * has no scope, so a binding that shadows a class name would silently redirect `C.f` to
 * the class's static instead of the shadowing value. Collecting the binders lets the
 * parser refuse that program outright rather than answer it wrongly.
 */
export function collectBindingNames(list: Stmt[]): Set<string> {
  const out: BoundNames = { names: new Set<string>() };
  for (const s of list) bindStmt(s, out);
  return out.names;
}

/* ---- pass 4: does an expression name the receiver? ------------------------- */

/** The one-bit accumulator `mentionsThis` threads down the walk. `//@@mutable` because it
 *  IS mutated in place through a by-borrow parameter, which is exactly what the attribute
 *  legalizes for a record (docs/decorators.md, piece 3) — the same reason `BoundNames`
 *  above carries it. Non-recursive, so the cycle rule this very type serves is inert. */
//@@mutable
interface ThisHit { hit: boolean }

function thisExpr(e: Expr, out: ThisHit): Expr {
  if (e.kind === "Identifier" && e.name === "this") out.hit = true;
  return walkExprChildren(e, (x: Expr): Expr => thisExpr(x, out), (s: Stmt): Stmt => thisStmt(s, out), KEEP_TY);
}
function thisStmt(s: Stmt, out: ThisHit): Stmt {
  return walkStmtChildren(s, (x: Expr): Expr => thisExpr(x, out), (y: Stmt): Stmt => thisStmt(y, out), KEEP_TY);
}
/**
 * Does this expression name `this` ANYWHERE inside it? A pure VISITOR, in the shape
 * `collectBindingNames` established: it walks with the shared rewriter and throws the
 * rebuilt tree away.
 *
 * The one caller is the CYCLE rule (`Checker.cycleCapableThisWrite`). A constructor writes
 * into a block nothing else can reach yet, so `this.f = v` there cannot close a cycle —
 * unless `v` names the block being built, and `this` is the only name it has at that
 * point. (An aliased spelling, `const t = this; this.next = t`, does not need catching
 * here: it is already NT1604, "cannot move out of `t`: it is borrowed".)
 *
 * Terminates trivially — the AST is a finite TREE, and this walk predates any value-level
 * back-edge. It answers a SYNTACTIC question and must stay syntactic for that reason.
 */
export function mentionsThis(e: Expr): boolean {
  const out: ThisHit = { hit: false };
  thisExpr(e, out);
  return out.hit;
}

/* ---- pass 5: which fields does a constructor body store into? -------------- */

/** The accumulator for `fieldsStoredViaThis`, in the shape `BoundNames`/`ThisHit` set.
 *
 * `ctorOnly` restricts the scan to CONSTRUCTOR stores — `inCtor`, which the parser sets
 * exactly where it sets `inCtorBody`. Both callers walk the same bodies, so the two ask
 * one visitor rather than keeping a second copy that can drift from it. */
//@@mutable
interface StoredFields { names: Set<string>; ctorOnly: boolean }

function storedExpr(e: Expr, out: StoredFields): Expr {
  // TRUTHINESS, not `=== true`: `viaThis` is `?Uboolean`, and comparing a nullable
  // boolean against a plain one is outside the subset src/ must stay inside (NT2001,
  // "Cannot compare ?Uboolean with boolean") — the spelling `parseClass`'s own
  // `if (!p.paramProp) continue` already uses.
  // `out.names = out.names.add(…)`, not `out.names.add(…)`: `Set` is PERSISTENT here, so
  // the bare call returns a new set and leaves the receiver untouched (NT1606) — the same
  // reason `BoundNames` above is written this way.
  // Spelled as nested `if`s rather than `(!out.ctorOnly || e.inCtor)`: `inCtor` is the
  // same `?Uboolean` as `viaThis`, and mixing one into a `||` with a plain `boolean` is
  // the compare this subset refuses (NT2001), for the reason stated just above.
  if (e.kind === "FieldAssign" && e.viaThis) {
    if (out.ctorOnly) { if (e.inCtor) out.names = out.names.add(e.field); }
    else out.names = out.names.add(e.field);
  }
  return walkExprChildren(e, (x: Expr): Expr => storedExpr(x, out), (s: Stmt): Stmt => storedStmt(s, out), KEEP_TY);
}
function storedStmt(s: Stmt, out: StoredFields): Stmt {
  return walkStmtChildren(s, (x: Expr): Expr => storedExpr(x, out), (y: Stmt): Stmt => storedStmt(y, out), KEEP_TY);
}
/**
 * Every field a constructor body stores into via `this.f = …`, ANYWHERE inside it — a pure
 * visitor in the shape `mentionsThis` established.
 *
 * DELIBERATELY AN OVER-APPROXIMATION of "definitely assigned", and the caller depends on
 * that direction. It answers a purely SYNTACTIC question ("is there such a store at all"),
 * so a store under an `if` counts even though the else path leaves the slot unwritten. The
 * over-approximation is the SAFE direction for the one caller (`parseClass`'s
 * uninitialized-field refusal): erring towards "covered" can only ever accept a program,
 * never refuse a valid one, so this cannot turn a working class into a false NT1015. The
 * conditional-store hole it leaves is real and stated at that call site — closing it needs
 * the flow analysis `checkDefiniteAssignment` runs for locals, which is a checker pass and
 * not a syntactic question the parser can answer.
 */
export function fieldsStoredViaThis(body: Stmt[]): Set<string> {
  return storedFields(body, false);
}

/**
 * The same scan, restricted to stores the parser marked `inCtor`.
 *
 * This is the set of fields a CONSTRUCTOR body puts a value in somewhere — the tracked
 * set for the path-sensitive question `checkDefiniteAssignment` then answers ("…and on
 * every path out?"). Restricting to `inCtor` is what keeps a METHOD's `this.f = …` from
 * making the method look like a constructor: only the constructor is obliged to leave
 * every field written, and a method that assigns a field is the ordinary case.
 *
 * Starting from what the constructor stores SOMEWHERE, rather than from the class's full
 * field list, also keeps this from re-deciding cases it cannot see. A field the
 * constructor never mentions is the SYNTACTIC case, already decided by the caller of
 * `fieldsStoredViaThis` above, together with the one exemption it carries (a `class E extends
 * Error` that declares NO constructor, whose inherited `message` node sets through the
 * implicit `super(...arguments)` — an explicit `super(msg)` is a plain `this.message = msg`
 * store and needs no exemption).
 */
export function ctorFieldsStored(body: Stmt[]): Set<string> {
  return storedFields(body, true);
}

function storedFields(body: Stmt[], ctorOnly: boolean): Set<string> {
  const out: StoredFields = { names: new Set<string>(), ctorOnly: ctorOnly };
  for (const s of body) storedStmt(s, out);
  return out.names;
}
