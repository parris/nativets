# A2 — Nullable / optional types → close `optional-chaining`

Red-green test-vector spec for Phase A2 (ROADMAP §A2). Goal: parse optional
object fields `{ a?: T }` (= `T | undefined`), a restricted nullable type
`T | undefined` / `T | null`, the `o.a?.b` runtime null-check, composition with
`??`, and `{}` assignable to `{ a?: T }`.

**Oracle:** every snippet below was run under plain `node` (v via `node case.ts`)
and the "Expected" block is its literal stdout. If nativets disagrees, nativets is
wrong.

**Subset:** number | string | boolean | object fields only. `?.` on **property
access** only (`o.a?.b`). Optional **call** `f?.()` and optional **index**
`a?.[i]` are explicitly out of subset → reject with a diagnostic (see §Excluded).

**Semantics we must honor (TC39 optional chaining, stage 4):**
- `x?.y` evaluates `x`; if `x` is `null` **or** `undefined`, the result is
  `undefined` and **the whole rest of the chain is short-circuited** (not just the
  one `.y`). Otherwise it is `x.y`.
- "Short-circuit the rest of the chain" is the sharp point: in `a?.b.c`, if `a` is
  nullish the `.c` is **not** evaluated, so the result is `undefined`, not a crash.
- `a ?? b` yields `a` unless `a` is `null`/`undefined`, in which case `b`. Unlike
  `||`, `0`, `""`, and `false` are **not** coalesced.
- node prints bare `null` as `null` and bare `undefined` as `undefined` — they
  are distinct and must not be conflated.

Legend for the work column: **P** = parser, **C** = checker/type-system, **G** =
codegen/runtime.

---

## Ordered behaviors (simplest → hardest)

### 1. Parse an optional field type `{ a?: T }` (= `T | undefined`) — foundation
The type syntax must parse and the field must be encodable. Nothing runtime-visible
yet beyond a normal present field.
```ts
const o: { a?: number } = { a: 5 };
console.log(o.a);
```
Expected:
```
5
```
Work: **P** (parse `?` after the key in an object type → mark field optional). **C**
(field type becomes `number | undefined`; internally the optional flag is what
matters). No new codegen — a present field reads as today.

### 2. `{}` empty object literal assignable to `{ a?: T }`
Structural, optional-aware assignability: an absent optional field is legal.
```ts
const o: { a?: number } = {};
console.log(typeof o);
```
Expected:
```
object
```
Work: **C** (assignability: a target field that is optional need not be present in
the source). **G** (the object still needs a physical slot for `a` so a later
`o.a` read is well-defined — allocate the slot and initialize it to the undefined
sentinel; see §Encoding).

### 3. Read an **absent** optional field → `undefined`
```ts
const o: { a?: number } = {};
console.log(o.a);
```
Expected:
```
undefined
```
Work: **C** (`o.a` has type `number | undefined`). **G** (the slot holds the
undefined sentinel; printing it must yield `undefined`, reusing Stage-6 undefined
printing).

### 4. Read a **present** optional field → the value
```ts
const o: { a?: number } = { a: 42 };
console.log(o.a);
```
Expected:
```
42
```
Work: **C**/**G** — same slot, holds a real value. (Distinguishes present from
absent: the sentinel vs a stored double.)

### 5. Restricted nullable type annotation `T | undefined` / `T | null`
Only the two nullable shapes from ROADMAP; a general union stays rejected.
```ts
let x: number | undefined = undefined;
console.log(x);
x = 7;
console.log(x);
let y: string | null = null;
console.log(y);
```
Expected:
```
undefined
7
null
```
Work: **P** (parse a two-arm union where exactly one arm is `undefined` or `null`).
**C** (represent as "nullable T"; a general `A | B` where neither arm is
null/undefined → reject, see §Excluded). **G** (the variable's slot must be able to
hold either a `T` or the null/undefined sentinel — a tagged/sentinel encoding).

### 6. Distinguish `null` vs `undefined` when printing
They are different values and print differently; the nullable encoding must remember
which one it is.
```ts
const a: number | null = null;
const b: number | undefined = undefined;
console.log(a);
console.log(b);
```
Expected:
```
null
undefined
```
Work: **G** (two distinct sentinels — a `null` sentinel and an `undefined`
sentinel — so §5's slot round-trips the exact one). **C** (track which arm).

### 7. `??` with a nullable operand (extend existing static `??` to runtime)
Today `??` is statically resolved (operand is *definitely* nullish or *definitely*
not). Now the left operand can be a runtime-nullable value, so `??` needs a runtime
null-check. Note `0`, `""`, `false` are **not** coalesced (unlike `||`).
```ts
const x: number | undefined = undefined;
console.log(x ?? 10);
const y: number | undefined = 0;
console.log(y ?? 10);
console.log(0 ?? 5, 0 || 5);
console.log("" ?? "x", "" || "x");
const z: number | null = null;
console.log(z ?? -1);
```
Expected:
```
10
0
0 5
 x
-1
```
Work: **C** (result type = non-nullable arm of the left, unified with the right).
**G** (emit a runtime branch: `is_nullish(left) ? right : left`; the nullish test is
"equals null-sentinel OR undefined-sentinel", **not** truthiness — `0`/`""`/`false`
pass through).

### 8. `o.a?.b` where `o.a` is **present** → `o.a.b`
First real optional-chain link.
```ts
const o = { a: { b: 7 } };
console.log(o.a?.b);
```
Expected:
```
7
```
Work: **P** (parse `?.` as an optional property-access operator). **C** (`o.a?.b`
has type `typeof(a.b) | undefined`). **G** (branch on `o.a` nullish; here non-nullish
so read `.b`).

### 9. `o.a?.b` where `o.a` is **absent/nullish** → `undefined`
```ts
const o: { a?: { b: number } } = {};
console.log(o.a?.b);
```
Expected:
```
undefined
```
Work: **G** (the `?.` branch: `o.a` is the undefined sentinel → the whole access
yields `undefined` **without** dereferencing `.b`, which would otherwise be a null
pointer read). This is where `?.` earns its keep.

### 10. `?.` short-circuits the **whole rest of the chain** (the sharp case)
`a?.b.c` where `a` is nullish must be `undefined` — the trailing non-optional `.c`
is skipped, no crash.
```ts
const a: { b: { c: number } } | null = null;
console.log(a?.b.c);
```
Expected:
```
undefined
```
Work: **C**/**G** (this is the semantic subtlety: `?.` guards **everything to its
right in the same chain**, not just the immediately following member. Lower the
chain so that a nullish check at the `?.` jumps past the entire remaining member
sequence to a result of `undefined`. Implementation note: treat a chain
`head ?. m1 . m2 . m3` as "evaluate head; if nullish → undefined; else read
m1.m2.m3". Any second `?.` inserts another guard/short-circuit target.)

### 11. Chained `o?.a?.b?.c` — multiple guards, all present
```ts
const o = { a: { b: { c: 42 } } };
console.log(o?.a?.b?.c);
```
Expected:
```
42
```
Work: **G** (each `?.` is its own nullish guard, all falling through to the final
read; several short-circuit targets, one shared `undefined` result).

### 12. Chained `?.` with a **middle** link absent → `undefined`
```ts
const o: { a?: { b?: { c: number } } } = { a: {} };
console.log(o.a?.b?.c);
```
Expected:
```
undefined
```
Work: **G** (`o.a` present, `o.a.b` absent → second guard fires → `undefined`;
confirms guards compose and any one firing short-circuits the rest).

### 13. `a?.b ?? default` — optional chain composed with `??`
The headline pattern from the gap case: an optional chain feeds a coalesce.
```ts
const o: { a?: { c: number } } = {};
console.log(o.a?.c ?? -1);
const p: { a?: { c: number } } = { a: { c: 9 } };
console.log(p.a?.c ?? -1);
```
Expected:
```
-1
9
```
Work: **C** (type of `o.a?.c` is `number | undefined`; `?? -1` collapses to
`number`). **G** (§7 nullish branch consuming §9/§12's chain result — precedence:
`??` binds looser than the whole `?.` chain).

### 14. Optional **string** field + `?.` + `??` and `.length`
Exercises the string field type through the chain and coalescing to a string.
```ts
const o: { name?: string } = {};
console.log(o.name ?? "none");
console.log(o.name?.length ?? 0);
const p: { name?: string } = { name: "hi" };
console.log(p.name ?? "none");
console.log(p.name?.length ?? 0);
```
Expected:
```
none
0
hi
2
```
Work: **G** (chain result is `ptr | undefined`; `?.length` guards the string
pointer, and the whole thing coalesces). Reuses string `.length` (Stage 3).

### 15. Optional **boolean** field — `false` must survive `??`
Guards against the classic `||` bug: `false ?? d` is `false`, not `d`.
```ts
const o: { flag?: boolean } = { flag: false };
console.log(o.flag ?? true);
const p: { flag?: boolean } = {};
console.log(p.flag ?? true);
```
Expected:
```
false
true
```
Work: **G** (nullish test must be sentinel-based, not truthiness — `false` (`i1 0`)
is a real value and passes through).

### 16. Chain result used in arithmetic / template (result is a real `number`/`string`)
Confirms the coalesced value is a first-class typed value, not a boxed thing.
```ts
const o: { x?: number } = {};
console.log((o.x ?? 3) + 1);
const t: { name?: string } = {};
console.log(`hello ${t.name ?? "world"}`);
```
Expected:
```
4
hello world
```
Work: **C** (post-`??` type is the non-nullable arm → normal `number`/`string`, so
`+`, template coercion, etc. all apply). **G** (nothing new beyond §7 + existing
arithmetic/template).

### 17. Both `null` and `undefined` sources flow through `?.` and `??` identically
Confirms the two sentinels are both treated as "nullish" by the guards, even though
they print differently.
```ts
const a: { c: number } | null = null;
const b: { c: number } | undefined = undefined;
console.log(a?.c, b?.c);
console.log(a?.c ?? 1, b?.c ?? 2);
```
Expected:
```
undefined undefined
1 2
```
Work: **G** (the nullish predicate = "null-sentinel OR undefined-sentinel"; both
short-circuit `?.` to `undefined` and both trigger `??`). Ties together §6 (they
print differently) with §7/§10 (they behave identically under the guards).

---

## Excluded from the A2 subset → reject with a diagnostic (never miscompile)

These are valid TS optional-chaining forms outside the ROADMAP subset. Each should be
rejected with an `NT1xxx` NYI diagnostic (code numbers **proposed** — implementer's
choice), surfaced by `coverage`, not silently miscompiled.

| Form | Example | Why excluded | Suggested diagnostic |
|------|---------|--------------|----------------------|
| Optional **call** | `f?.()`, `o.m?.()` | needs callable-nullable + call lowering; out of subset | `NT1610`-style NYI: "optional call `?.()` not yet supported" |
| Optional **index** | `a?.[i]` | needs element-access chain over arrays; out of subset | NYI: "optional element access `?.[]` not yet supported" |
| **General** union `A \| B` (neither arm null/undefined) | `let x: number \| string` | nullable is restricted to `T \| undefined` / `T \| null` | reuse existing union-reject NYI (§5 checker) |
| Union with **>2** arms / `T \| null \| undefined` | `let x: number \| null \| undefined` | beyond the two restricted shapes; node runs it, we don't yet | NYI (may relax later) |
| **Non-null assertion** in a chain | `o?.b!.c` | assertion operator not in subset | reuse `as`/assertion NYI |
| `?.` on **array/other non-object** receiver | `arr?.length` where `arr` array | receiver typing beyond flat objects/strings | NYI |
| `delete o?.a` | — | delete not in subset | NYI |

Note: node **runs** all of the above (they are valid JS), so they remain
node-verifiable cases waiting in `KNOWN_UNSUPPORTED` — the reject-don't-miscompile
discipline, same as the rest of the gap.

---

## Encoding / implementation notes (for the GREEN pass)

- **Two sentinels, kept distinct.** Reuse Stage-6's `undefined` and `null`
  representations. A nullable slot must round-trip *which* nullish it holds (§6),
  so a single "is-null" bit is insufficient — the `null` sentinel and `undefined`
  sentinel must be separately recoverable when printed. For object fields the slot
  is one of the 8-byte heap slots (Stage 11), so a reserved sentinel bit-pattern per
  nullish value works; for a scalar-typed local (`number | undefined`) the slot
  likewise needs a tag or reserved NaN-payload/​pointer sentinel.
- **Absent optional field == `undefined`.** When an object literal omits an optional
  field (§2/§3), codegen must still allocate its static slot (slot index is
  compile-time, Stage 11) and initialize it to the **undefined** sentinel — so a
  later read is defined behavior, not garbage.
- **Nullish predicate is sentinel-equality, not truthiness.** Both `?.` guards and
  `??` test `value == null-sentinel || value == undefined-sentinel`. `0`, `""`,
  `false` are **not** nullish (§7, §15) — this is the whole point of `??`/`?.` over
  `||`/`&&`.
- **`?.` short-circuits the rest of the chain (§10).** Lower an optional chain as a
  single unit: evaluate the head, guard at each `?.`, and on any guard firing jump to
  a shared "result = undefined" join — do **not** evaluate the trailing
  member accesses. A per-`?.` basic-block guard with a common `undefined` merge block
  is the natural LLVM shape (like an `&&`-cascade that lands on `undefined`).
- **`??` precedence:** binds looser than the entire `?.` chain, so `a?.b ?? d`
  parses as `(a?.b) ?? d` (§13). (TS/JS also forbid mixing `??` with `||`/`&&`
  without parens — a parse-level check.)
- **Result type after `??`** is the non-nullable arm unified with the right operand
  (§16), so downstream arithmetic/template/`.length` all just work.

---

## Coverage impact

Closing these 17 behaviors closes the gap case **`optional-chaining`**, taking the
gap corpus from **53/55 → 54/55**. The only remaining gap case is **`json-roundtrip`**
(`JSON.parse`), owned by Phase A1.
