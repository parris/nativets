# B2 · Step 1 — Copy-on-write + structural sharing over flat arrays/objects

Red-green test-vector spec for **B2 step 1** (ROADMAP §B2.1 / phase2-design §1): make
`.push` / `.pop` / field-set / `arr[i]=` and the new `.with(i,v)` / `set(k,v)` **return NEW
values** (copy the flat block, apply the change) instead of mutating in place. Immutable
semantics + structural sharing: old versions stay unchanged; **untouched sibling subtrees are
shared by pointer identity**.

Distilled from the **immer** (`__tests__/base.js`, `curry.js`) and **immutable.js**
(`__tests__/List.ts`, `Map.ts`) suites — the canonical corpora for these behaviors.

## How the node oracle is expressed

node arrays/objects are **mutable**, so B2's non-mutating ops are written with patterns node
*can* run, and these become the differential oracle:

| nativets (intended) | node-runnable oracle | note |
|---|---|---|
| `b = a.push(x)` (returns new arr) | `const b = [...a, x]` | node's `.push` mutates + returns length — must use spread |
| `b = a.pop()` (returns new arr) | `const b = a.slice(0, -1)` | node's `.pop` mutates + returns the element |
| `b = a.with(i, v)` | `const b = a.with(i, v)` | **`Array.prototype.with` is real node (ES2023)** — same syntax IS the oracle |
| `p = o.set("f", v)` | `const p = { ...o, f: v }` | node objects have no `.set`; spread is the oracle |
| `p = o.with({f: v})` (bulk) | `const p = { ...o, f: v }` | spread oracle |

**Structural sharing is node-observable.** `{...o1}` / `.with` copy the *top* block but keep
the **nested references**, so `o2.other === o1.other` is genuinely `true` in node when `other`
was untouched — that is exactly the invariant nativets copy-on-write must reproduce. Each
snippet below prints those identity checks; every printed line was verified against
`node v24.11.1`.

> **One behavior is NOT node-observable** (§9, no-op identity): immer/immutable return the
> *same top reference* when you set a field to its existing value, but node's spread **always**
> allocates a fresh object. That optimization must be tested with nativets' own pointer-identity
> primitive (`__arrLive()`-style introspection), never through node stdout — flagged inline.

---

## Ordered behaviors (simplest → hardest)

### 1. Non-mutating array append → new array, original unchanged
```ts
const a = [1, 2, 3];
const b = [...a, 4];              // nativets: const b = a.push(4);  (returns a NEW array)
console.log(b.join(","), a.join(","), a.length, a === b);
```
**Expected stdout:** `1,2,3,4 1,2,3 3 false`
**Sharing assertion:** `a !== b`; `a` is length 3 and unchanged after the "push".

### 2. Non-mutating array pop → new array, original unchanged
```ts
const a = [1, 2, 3];
const b = a.slice(0, -1);         // nativets: const b = a.pop();  (returns the NEW shorter array)
console.log(b.join(","), a.join(","), a === b);
```
**Expected stdout:** `1,2 1,2,3 false`
**Sharing assertion:** `a !== b`; original still `[1,2,3]`. (nativets `.pop` returns the new
array, not the removed element — a deliberate divergence from JS; document in `divergences.md`.)

### 3. Array element update → new array, original unchanged
```ts
const a = [10, 20, 30];
const b = a.with(1, 99);          // nativets: same syntax;  also  a[1] = 99  yields a NEW array
console.log(b.join(","), a.join(","), a === b);
```
**Expected stdout:** `10,99,30 10,20,30 false`
**Sharing assertion:** `a !== b`; `a[1]` is still `20`.

### 4. Object struct-update → new object, original unchanged
```ts
const o = { x: 1, y: 2 };
const p = { ...o, y: 9 };         // nativets: const p = o.set("y", 9);   (or  p = { ...o, y: 9 })
console.log(p.x, p.y, o.y, o === p);
```
**Expected stdout:** `1 9 2 false`
**Sharing assertion:** `o !== p`; `o.y` stays `2`; unchanged field `x` copied by value.

### 5. Array-of-scalars: update one element, verify only that slot differs
```ts
const a = [1, 2, 3, 4];
const b = a.with(2, 30);
console.log(a[0] === b[0], a[1] === b[1], a[2] === b[2], a[3] === b[3]);
```
**Expected stdout:** `true true true false`
**Sharing assertion:** scalar slots compare equal everywhere except the changed index — the
flat-block copy touched only slot 2. (For scalars `===` is value equality; §6 makes the
*pointer*-identity version.)

### 6. Array-of-objects: update one element, siblings shared by identity
```ts
const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
const b = a.with(1, { id: 20 }); // nativets: same
console.log(a[0] === b[0], a[1] === b[1], a[2] === b[2], a === b, a[1].id, b[1].id);
```
**Expected stdout:** `true false true false 2 20`
**Sharing assertion:** the new array **shares the element pointers** of untouched indices
(`a[0]===b[0]`, `a[2]===b[2]`); only the replaced slot differs; `a !== b`; original element
`a[1].id` still `2`. This is the core structural-sharing invariant at one level.

### 7. Nested object update: root→leaf path copied, untouched sibling shared
```ts
const o = { a: { x: 1 }, other: { y: 2 } };
const p = { ...o, a: { ...o.a, x: 9 } };   // nativets: p = o.set("a", o.a.set("x", 9));
console.log(o.other === p.other, o.a === p.a, o.a.x, p.a.x);
```
**Expected stdout:** `true false 1 9`
**Sharing assertion:** `p.other === o.other` (untouched sibling shared by pointer); `p.a !== o.a`
(changed path got a fresh block); `o.a.x` still `1`. Cost is O(depth), not O(size).

### 8. Deep nested update (2+ levels): whole path fresh, every off-path sibling shared
```ts
const s = { user: { name: "n", roles: ["r1"] }, meta: { v: 1 } };
const t = { ...s, user: { ...s.user, name: "m" } };
// nativets: t = s.set("user", s.user.set("name", "m"));
console.log(s.meta === t.meta, s.user === t.user, s.user.roles === t.user.roles,
            s.user.name, t.user.name);
```
**Expected stdout:** `true false true n m`
**Sharing assertion:** the phase2-design headline invariant — `t.user.roles === s.user.roles`
holds after a deep update (the untouched array is shared), and `t.meta === s.meta` (untouched
top-level sibling shared), while the copied path `s.user` → fresh. Original `s.user.name` still
`"n"`.

### 9. Update to same value → no-op returns the SAME reference *(optimization; NOT node-observable)*
```ts
// immer: "state stays the same if the same item is assigned" → nextState === baseState
// immutable.js List/Map: "no-ops return the same reference"
const o = { x: 1, y: 2 };
const p = { ...o, y: 2 };          // node's spread ALWAYS allocates: o === p is FALSE here
console.log(o.y, p.y);             // node oracle only covers the VALUES:  2 2
```
**Expected stdout (node, values only):** `2 2`
**nativets extra invariant (test via pointer-identity primitive, not node stdout):**
`o.set("y", 2)` should return the **same pointer** as `o` (`ptr(result) === ptr(o)`), and
likewise `a.with(i, a[i])` and a `.push` that changes nothing. node cannot express this because
spread always copies — assert it with the `__arrLive()`/identity introspection hook, as an
allocation-count / pointer-equality test. Pairs with B2's `rc==1 ⇒ mutate in place` transients.
Ordered last because it needs infrastructure beyond the node differential.

### 10. Persistent versions coexist — a chain of updates, every version still valid
```ts
// immutable.js "is persistent to sets": v0..v5 all remain independently readable.
const v0 = [1];
const v1 = [...v0, 2];             // nativets: v1 = v0.push(2)
const v2 = [...v1, 3];             // nativets: v2 = v1.push(3)
const v3 = v2.with(0, 100);        // nativets: v3 = v2.with(0, 100)
console.log(v0.join(","), v1.join(","), v2.join(","), v3.join(","));
```
**Expected stdout:** `1 1,2 1,2,3 100,2,3`
**Sharing assertion:** all four versions are simultaneously live and unchanged by later ops —
no operation reached back and mutated an earlier value. (The allocate-and-drop memory model must
keep each version's block alive while referenced; deterministic drop frees when a version dies.)

---

## Intended nativets API surface

Immutable ops on the existing **flat** array/object backing (`nt_arr_*`, fixed slot block).
Every op is **pure**: it copies the flat block, applies the change, and returns the new value;
the receiver is never mutated.

**Arrays** (`T[]`):
- `a.push(v) : T[]` — new array = old slots + `v` appended. *(was: mutate + return length)*
- `a.pop()  : T[]` — new array = old slots minus last. *(diverges from JS: returns the array,
  not the element — document in `divergences.md`)*
- `a.with(i, v) : T[]` — new array with slot `i` set to `v` (real node syntax, ES2023).
- `a[i] = v` (as an expression/rebind) — sugar for `a = a.with(i, v)`; the old binding's value
  is unchanged, the name rebinds to the new array.

**Objects** (structural record `{k:t,…}`):
- `o.set(k, v) : {…}` — new object with field `k` set to `v` (single field).
- `o.with({k: v, …}) : {…}` — bulk struct-update (multi-field), ≡ chained `set`.
- `o.f = v` (as rebind) — sugar for `o = o.set("f", v)`.

**Structural-sharing contract (what codegen must guarantee):**
1. Update copies **only the receiver's flat block**; nested field/element pointers are copied
   **by value**, so untouched children keep identity (`§6`, `§7`, `§8`).
2. A nested update `o.set("a", o.a.set("x", 9))` copies exactly the root→leaf chain
   (`o`, `o.a`) and shares every off-path sibling (`o.other`, `o.meta`, `o.user.roles`).
3. Old versions are structurally frozen — no op mutates a value reachable from an earlier
   binding (`§10`).
4. *(optimization, later)* setting a slot/field to its current value returns the **same
   pointer** (`§9`), enabling `rc==1 ⇒ mutate-in-place` transients.

**Diagnostics:** ops that can't preserve the flat-block CoW contract (e.g. aliased mutation
that would need refcounting, or updates on not-yet-linear objects/strings) reject with an
`NT16xx` code rather than silently deep-copying or GC-ing — same reject-don't-miscompile
discipline. Structural sharing of siblings interacts with linear ownership/drop: a shared
child now has **two owners** across versions, so §6–§8 are also the first cases that force the
drop pass to become refcount-aware (phase2-design §1 "memory: atomic rc").

---

## Test wiring notes (for the implementer)

- **§1–§8, §10** go under `test/fixtures/immutable/` as node-differential fixtures (`.ts` +
  `.ts.expected`), gated by `test/fixtures.test.ts` — they run identically on node today (spread
  / `.with`) and must run identically after `.push`/`.pop`/`.set`/`.with` are lowered to CoW.
- **§9** is an allocation/pointer-identity test, not a node-differential — extend the
  `__arrLive()` introspection to assert same-pointer on no-op and a bounded allocation count.
- Bias future property tests (per phase2-design) to the **structural-sharing edges**: deepest
  path (§8), and array-of-objects sibling identity under repeated single-element updates (§6).
