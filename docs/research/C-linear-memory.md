# Phase C — Finish the linear memory model: ordered test-vector spec

Red-green spec for finishing nativets' linear/move memory model. Distilled from rustc's
borrowck UI suite (E0382 / E0505 / E0502 / **E0507** / **E0508**) and the Rustonomicon
drop-flags chapter, mapped onto nativets' existing move checker (`src/ownership.ts`) and its
`compiletest`-style fixtures (`test/ownership/*.ts`).

## What Phase C adds (from `docs/ROADMAP.md` "Phase C" + CLAUDE.md Memory model)

1. Make **objects** (`{…}`) linear — move-check + deterministic drop, like arrays.
2. Make **strings** linear — same. (Roadmap decision: **strings are linear**, not `Copy`.
   See the string-nuance callout below — this is the one genuinely disruptive change.)
3. **Drops for nested-scope and temporary values** — arrays today only drop *top-level* owned
   locals (`ownedTopLevel`); extend to inner blocks and to **drop flags** for values moved on
   only some control-flow paths.
4. **Move-out-of-borrow** (E0507 → new **NT1604**) and **move-out-of-array-element**
   (E0508 → new **NT1605**).

## Oracle for these tests

These are **compile-time accept/reject** tests, **not** node-differential — node is *not* the
oracle here. The oracle is exactly the existing harness (`test/ownership.test.ts`):

- `//@ check-pass` → move checker must **ACCEPT** (zero diagnostics).
- `//~ ERROR NTxxxx` on a line → a diagnostic with that code **on that exact line**, and **no
  unexpected diagnostics** (diagnostic count must equal the annotation count).

`move(x)` is a compiler intrinsic (identity at runtime); it is fine that node has no `move` —
ownership fixtures never run under node.

**Exception — the drop behaviors (§6, §7, §8b, §9) additionally need a RUNTIME leak test.**
"Accepted by the move checker" does not prove the value is actually freed. Mirror the existing
array approach (CLAUDE.md: *"verified via `__arrLive()`"*): add debug live-counters
`__objLive()` / `__strLive()` (alongside `__arrLive()`) and a node-differential fixture under
`test/fixtures/` asserting the counter is **0** at program end — including the conditional-move
case where a drop flag must gate the free. Those runtime fixtures are called out per-behavior
but live in `test/fixtures/`, not `test/ownership/`.

## New diagnostic codes to add to `src/diagnostics.ts` (and `OWN_CODES` in `src/ownership.ts`)

| Code | ≈ Rust | Meaning |
|------|--------|---------|
| **NT1604** | E0507 | cannot move out of borrowed content (move out of a `for-of` element binding, or of a by-borrow parameter) |
| **NT1605** | E0508 | cannot move out of array element `arr[i]` (element type is linear) |

Existing (for reference): NT1601≈E0382 use-after-move, NT1602≈E0505 move-while-borrowed,
NT1603≈E0502 mutate-while-borrowed (iterator invalidation).

---

# Ordered behavior list

Ordered so each step builds on the last: objects-linear first (smallest generalization of the
array machinery), then strings, then the drop extensions, then the two new move-out codes.
Each behavior lists the fixture path, its full contents (compiletest annotations included), and
the expected accept/reject + code + line.

---

## 1. Objects are linear — implicit move + use-after-move (NT1601)

The core generalization: `isObjectTy(t)` joins `isArrayTy(t)` everywhere the checker decides
"is this a linear local" (`collectLinear`, the `VarDecl` case, param seeding, `topLevel`).
Binding an object to a new name **moves** it; using the source afterward is NT1601.

**`test/ownership/object-use-after-move.ts`** — REJECT, NT1601 on the last line:
```ts
// An object is linear: binding it to a new name moves it (mirrors Rust E0382).
const a: {x:number} = {x: 1};
const b = a;
console.log(a.x); //~ ERROR NT1601
```

**`test/ownership/object-move-ok.ts`** — ACCEPT (move, no later use of source):
```ts
//@ check-pass
const a: {x:number} = {x: 1};
const b = move(a);
console.log(b.x);
```

**`test/ownership/object-double-move.ts`** — REJECT, NT1601 on the second `move`:
```ts
// Moving twice reads an already-moved object.
const a: {x:number} = {x: 1};
const b = move(a);
const c = move(a); //~ ERROR NT1601
```

---

## 2. Object borrows do NOT consume — field read / `Object.keys` / `for-in` (ACCEPT)

Field access (`.f`, `o["f"]`), `Object.keys(o)`, and `for-in` are **borrows** (reads), exactly
as method calls / indexing / `.length` are for arrays. In `src/ownership.ts` these already flow
through `MemberExpr` / `IndexExpr` / `ForInStmt` with `consume:false`; the only change is that
`o` is now in `linear`, so this fixture guards that borrows still don't trip NT1601.

**`test/ownership/object-borrow-ok.ts`** — ACCEPT:
```ts
//@ check-pass
// Field reads, Object.keys, and for-in are borrows — they never consume.
const a: {x:number, y:number} = {x: 1, y: 2};
console.log(a.x, a["y"]);
for (const k of Object.keys(a)) {
  console.log(k);
}
console.log(a.x);
```

---

## 3. Strings are linear — implicit move + use-after-move (NT1601)

**Decision (per roadmap): strings are LINEAR, not `Copy`.** Binding a string variable to a new
name moves it; using the source afterward is NT1601.

**`test/ownership/string-use-after-move.ts`** — REJECT, NT1601 on the last line:
```ts
// A string is linear: binding it to a new name moves it.
const s: string = "hello world";
const t = s;
console.log(s.length); //~ ERROR NT1601
```

**`test/ownership/string-move-ok.ts`** — ACCEPT:
```ts
//@ check-pass
const s: string = "hello world";
const t = move(s);
console.log(t.length);
```

> ### ⚠ String-linearity nuance — a real design decision for the implementer
> Making *all* strings linear is the one disruptive change in Phase C, because strings appear
> everywhere the current model treats as `Copy`: `+` concat, template interpolation `${s}`,
> equality, being passed to `console.log`. Recommended split (mirrors Rust `&str` vs `String`):
> - **String literals / interned constants are `Copy`/static** (never freed) — a literal used
>   twice is not a double-move. Practically: a `VarDecl` whose init is a bare `StringLiteral`
>   *may* stay `Copy`, while a string produced by concat / a method / `split` is **owned**
>   (heap) and linear. The simplest correct rule that still passes these fixtures: treat every
>   `string`-typed **local** as linear for move-checking, and have literal materialization
>   produce an owned copy so drop is uniform.
> - **Interpolation and concat BORROW their operands** (`${s}` reads `s`, doesn't consume) —
>   otherwise `` `${s}${s}` `` would false-positive. See §5.
> - Drop needs a new `nt_str_free` + `__strLive()` counter (§7).
>
> If the implementer decides literals-stay-Copy makes §3's `"hello world"` a `Copy` value (no
> move), then flip these two fixtures to derive the string from a non-literal (e.g.
> `const s = "a" + "b";`) so the source is unambiguously owned. **Flag which rule was chosen in
> `docs/divergences.md`.**

---

## 4. String borrows do NOT consume — `.length` / methods / `for-of` / interpolation (ACCEPT)

**`test/ownership/string-borrow-ok.ts`** — ACCEPT:
```ts
//@ check-pass
// .length, methods, for-of over chars, and template interpolation are borrows.
const s: string = "hello";
console.log(s.length, s.slice(1), s.toUpperCase());
for (const c of s) {
  console.log(c);
}
console.log(`value is ${s} and again ${s}`);
```

---

## 5. Deterministic drop of an owned OBJECT (ACCEPT + runtime leak test)

Extend the drop analysis (`ownedTopLevel` / `ReturnStmt.drops` / `endDrops`) so owned objects
are freed at scope exit via a new `nt_obj_free`, exactly once, move-aware (a moved-out object is
freed by its final owner, never twice).

**`test/ownership/object-drop-ok.ts`** — ACCEPT (checker side):
```ts
//@ check-pass
// An owned object with no move is dropped at scope exit (no leak, no GC).
function f(): number {
  const a: {x:number} = {x: 42};
  return a.x;
}
console.log(f());
```

**Runtime companion — `test/fixtures/ownership/object-drop.ts`** (node-differential + assert
`__objLive() === 0` at end): allocate N objects in a function that returns a scalar, call it in
a loop, assert live-count returns to 0. Same shape as the existing `__arrLive()` array-drop
fixture.

---

## 6. Deterministic drop of an owned STRING (ACCEPT + runtime leak test)

**`test/ownership/string-drop-ok.ts`** — ACCEPT (checker side):
```ts
//@ check-pass
// An owned string is dropped at scope exit via nt_str_free.
function greet(): number {
  const s: string = "a" + "b" + "c";
  return s.length;
}
console.log(greet());
```

**Runtime companion — `test/fixtures/ownership/string-drop.ts`**: build heap strings in a loop
(concat / `.repeat`), assert `__strLive() === 0` at program end.

---

## 7. Conditional move needs a DROP FLAG (ACCEPT checker; runtime flag required)

The canonical Rustonomicon case: a value moved on **one** branch only. The move checker already
merges branches as *maybe-moved ⇒ moved* (`merge`), so **after** the `if` the value is "moved"
and correctly cannot be *used* (that reject case is the existing `conditional-move.ts`). The
**new** requirement is on the **drop side**: because the move happened on only one path, the
value must be freed *only if it was not moved* — a **runtime drop flag**, not a static drop.

Today `endDrops`/`ReturnStmt.drops` only free values statically known owned; a maybe-moved value
is excluded from the drop set, which is **safe but leaks** when the branch wasn't taken. Phase C
must emit a per-value boolean flag: set on move, cleared on init/revival, and `nt_*_free` at
scope exit **guarded by the flag**.

**`test/ownership/conditional-move-drop-ok.ts`** — ACCEPT (no use-after-move; the value is just
conditionally moved and the compiler must drop-flag it):
```ts
//@ check-pass
// Moved on one branch only: legal, but the drop at scope exit must be guarded by a
// runtime flag (free iff not moved). Mirrors Rust's dynamic-drop / drop-flag case.
function f(cond: boolean): number {
  const a: number[] = [1, 2, 3];
  if (cond) {
    const b = move(a);
    return b.length;
  }
  return a.length;
}
console.log(f(true), f(false));
```

**Runtime companion — `test/fixtures/ownership/conditional-move-drop.ts`** (the real gate):
call the function with **both** `true` and `false`, assert `__arrLive() === 0` afterward in
**both** cases. `true` frees via `b`'s owner, `false` frees via `a` — the flag must make each
path free exactly once and never double-free. This is the behavior a static drop set gets wrong.

**Reject companion already exists:** `test/ownership/conditional-move.ts` (use after a
one-branch move → NT1601). Keep it; it proves the *use* side while this proves the *drop* side.

---

## 8. Nested-scope drop — owned value in an inner block freed at inner-block exit (ACCEPT + runtime)

Arrays today only drop locals declared at a **scope's top level** (`topLevel` is built from
`for (const s of body)` — direct children only; CLAUDE.md notes "conditionally-created /
temporary arrays are not yet freed — safe, may leak"). Extend the drop points to **every
`BlockStmt`**: an owned value created inside an inner block is dropped at that block's exit, not
carried to the function end.

**`test/ownership/nested-scope-drop-ok.ts`** — ACCEPT:
```ts
//@ check-pass
// A linear value created in an inner block is dropped when that block exits.
function f(): number {
  let total: number = 0;
  {
    const a: number[] = [1, 2, 3];
    total = a.length;
  }
  {
    const b: {x:number} = {x: 5};
    total = total + b.x;
  }
  return total;
}
console.log(f());
```

**Runtime companion — `test/fixtures/ownership/nested-scope-drop.ts`**: loop the function many
times; assert `__arrLive() === 0` and `__objLive() === 0` after **each** iteration (the inner
`a` must be gone before the second block runs, not just at function end).

Implementation note: this generalizes `topLevel`/`endDrops` from "the function body" to "each
block scope" — compute an owned-at-exit drop set per `BlockStmt` and emit frees there. Watch
move-out: a value moved *out* of the inner block (returned, or moved to an outer binding) is
dropped by its new owner, not at block exit — reuse the same move-awareness as `ownedTopLevel`.

---

## 9. Move-out-of-borrow — E0507 → NT1604 (REJECT)

E0507 = "cannot move out of borrowed content." nativets' unambiguous borrow sources: the
**`for-of` loop variable** (a borrow of an array/string element) and a **by-borrow parameter**
(the callee borrows; the caller owns — see `src/ownership.ts` `runScope`, where params are
excluded from the drop set precisely because "those are borrowed, the caller owns them").
Moving out of either is NT1604.

**`test/ownership/move-out-of-borrow-forof.ts`** — REJECT, NT1604 on the `move` line
(requires object elements to be linear, from §1):
```ts
// The for-of variable borrows each element; moving it out is E0507.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
for (const e of xs) {
  const stolen = move(e); //~ ERROR NT1604
}
```

**`test/ownership/move-out-of-borrow-param.ts`** — REJECT, NT1604 on the `move`/return line
(a parameter is borrowed from the caller, so it cannot be moved out):
```ts
// A parameter is borrowed (the caller owns it); moving it out is E0507.
function steal(o: {x:number}): {x:number} {
  return move(o); //~ ERROR NT1604
}
```
> **Design flag:** the param case commits to *params are borrows* (matches the current
> drop-set comment). If instead the implementer decides *calling a function MOVES an owned arg
> into the callee* (callee then owns + drops it), this fixture flips to ACCEPT and the
> caller-side use-after-call becomes the NT1601 site. **Pick one and record it in
> `docs/divergences.md`.** The `for-of` fixture is unambiguous regardless — prefer it as the
> primary NT1604 case; ship the param case only once the param-ownership decision is made.

**`test/ownership/borrow-read-in-forof-ok.ts`** — ACCEPT (reading the borrowed element, not
moving it, is fine — guards against NT1604 false positives):
```ts
//@ check-pass
const xs: {x:number}[] = [{x: 1}, {x: 2}];
let total: number = 0;
for (const e of xs) {
  total = total + e.x;
}
console.log(total);
```

---

## 10. Move-out-of-array-element `arr[i]` — E0508 → NT1605 (REJECT)

E0508 = "cannot move out of a non-copy array index." Indexing an array whose element type is
**linear** (objects, or strings under §3) and binding/returning/moving that element leaves a
hole in the array → NT1605. (For `number[]`/`boolean[]` the element is `Copy`, so `arr[i]` is a
copy and stays legal — that's the accept companion.)

**`test/ownership/move-out-of-array-object.ts`** — REJECT, NT1605 on the binding line:
```ts
// Moving an object element out of the array leaves a hole — E0508.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
const first = xs[0]; //~ ERROR NT1605
```

**`test/ownership/move-out-of-array-string.ts`** — REJECT, NT1605 on the binding line (strings
linear, from §3):
```ts
// Moving a string element out of a string[] is E0508.
const names: string[] = ["ada", "grace"];
const n = names[0]; //~ ERROR NT1605
```

**`test/ownership/index-copy-ok.ts`** — ACCEPT (scalar elements are Copy; reads through the
index are fine):
```ts
//@ check-pass
const ns: number[] = [1, 2, 3];
const first = ns[0];             // number is Copy — this is a read, not a move
console.log(first, ns[1], ns.length);
```

**`test/ownership/index-borrow-ok.ts`** — ACCEPT (reading a *field* through the index borrows
the element, doesn't move it — guards NT1605 false positives):
```ts
//@ check-pass
const xs: {x:number}[] = [{x: 1}, {x: 2}];
console.log(xs[0].x, xs[1].x);
```

> **Checker mechanics for NT1605:** in `src/ownership.ts`, an `IndexExpr` currently always
> borrows (`consume:false` on both object and index). Add: when an `IndexExpr` over a
> linear-element array appears **in a consuming position** (RHS of a `VarDecl`/binding, a
> `return` argument, a `move(...)` arg), report **NT1605** on that expression's line. In a
> borrow position (receiver of `.field`, of a method, of another index) it stays a borrow →
> accept. This is the `consume` flag already threaded through `expr()`; NT1605 fires when
> `consume && isLinearElement(arrayTy)` at an `IndexExpr`.

---

## Implementation-order summary (dependency order)

| # | Behavior | Fixture(s) | Expect |
|---|----------|-----------|--------|
| 1 | object linear: use-after-move | `object-use-after-move.ts`, `object-move-ok.ts`, `object-double-move.ts` | NT1601 / accept / NT1601 |
| 2 | object borrows don't consume | `object-borrow-ok.ts` | accept |
| 3 | string linear: use-after-move | `string-use-after-move.ts`, `string-move-ok.ts` | NT1601 / accept |
| 4 | string borrows don't consume | `string-borrow-ok.ts` | accept |
| 5 | object deterministic drop | `object-drop-ok.ts` + `fixtures/ownership/object-drop.ts` | accept + `__objLive()==0` |
| 6 | string deterministic drop | `string-drop-ok.ts` + `fixtures/ownership/string-drop.ts` | accept + `__strLive()==0` |
| 7 | conditional move → drop flag | `conditional-move-drop-ok.ts` + `fixtures/ownership/conditional-move-drop.ts` | accept + `__arrLive()==0` both branches |
| 8 | nested-scope drop | `nested-scope-drop-ok.ts` + `fixtures/ownership/nested-scope-drop.ts` | accept + counters 0 per iter |
| 9 | move-out-of-borrow (E0507) | `move-out-of-borrow-forof.ts`, `move-out-of-borrow-param.ts`, `borrow-read-in-forof-ok.ts` | **NT1604** / NT1604 / accept |
| 10 | move-out-of-array-elem (E0508) | `move-out-of-array-object.ts`, `move-out-of-array-string.ts`, `index-copy-ok.ts`, `index-borrow-ok.ts` | **NT1605** / NT1605 / accept / accept |

New codes: **NT1604** (E0507, move out of borrow) and **NT1605** (E0508, move out of array
element) → add to `OWN_CODES` in `src/ownership.ts` and the catalog in `src/diagnostics.ts`.

Two design decisions to record in `docs/divergences.md`: (a) the **string literal = Copy vs
owned** rule (§3 callout); (b) **params-are-borrows vs call-moves-args** (§9 callout). Both
affect whether specific fixtures are reject or accept, so settle them before writing §3/§9.

## Sources (rustc borrowck reference)

- [E0507 — cannot move out of borrowed content](https://doc.rust-lang.org/error_codes/E0507.html)
- [E0508 — cannot move out of array index](https://doc.rust-lang.org/nightly/error_codes/E0508.html)
- [The Rustonomicon — Drop Flags (conditional-move / dynamic drop)](https://doc.rust-lang.org/nomicon/drop-flags.html)
- [rustc-dev-guide — Drop check](https://rustc-dev-guide.rust-lang.org/borrow_check/drop_check.html)
- [RFC 0320 — non-zeroing dynamic drop](https://rust-lang.github.io/rfcs/0320-nonzeroing-dynamic-drop.html)
