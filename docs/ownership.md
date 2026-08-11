# Ownership / linear-move checking

nativets uses a **linear, explicit-move** memory model (no GC, no manual free), and both its
design and its **test suite** are modeled on the Rust compiler's ownership/borrow checker.

## The model (phase 1)

- **Linear types = heap aggregates.** Today that's **arrays**. Scalars (`number`, `boolean`)
  are `Copy`; strings are treated as shared/immutable. Only linear values are tracked.
- **Single owner.** A linear value is owned by exactly one binding at a time.
- **Consuming positions (move):** binding to a new name (`let b = a`), returning a value, and
  the explicit `move(a)` form. After a move, the source is *moved-out*.
- **Borrowing positions (no consume):** method calls (`a.push(x)`), indexing (`a[i]`),
  `.length`, and `for-of (const x of a)`. Reads; the value stays owned.
- **Use-after-move is an error.** Reading (borrow or consume) a moved-out value ⇒ `NT1601`.
- **Revival.** Reassigning a moved binding (`a = [..]`) re-initializes it.
- The analysis (`src/ownership.ts`) is a forward dataflow with the lattice `{ Init, Moved }`
  (join = Moved), so `if` merges both branches and loops run to a fixpoint — a value moved in
  a loop body is seen as moved at the loop head.

`move(x)` is compile-time only (runtime identity — the same pointer); it exists to make
hand-off explicit and to satisfy the checker.

## Error codes (mapped to rustc)

| nativets | rustc | Meaning | Status |
|----------|-------|---------|--------|
| **NT1601** | E0382 | use of moved value | ✅ implemented |
| **NT1602** | E0505 | cannot move while borrowed (for-of borrow live) | ✅ implemented |
| **NT1603** | E0502 | cannot mutate while borrowed (iterator invalidation) | ✅ implemented |
| **NT1604** | E0507 | move out of borrowed content (a for-of element, a by-borrow param, a **module-level binding**, a `@@mutable` alias or method result) — but see **consuming parameters** below | ✅ implemented |
| **NT1605** | E0508 | move out of a linear array element (`arr[i]`) | ✅ implemented |
| **NT1607** | E0596 | cannot mutate through a borrow — a `@@mutable` setter needs an OWNED receiver | ✅ implemented |

**`@@mutable` classes (Stage 45, `docs/decorators.md`).** The one place a value mutates in
place. The linear model keeps it single-owner with **only the owner may mutate**: `const b = a`
(and a method RESULT, which *is* the receiver) is an **alias/borrow, not a move**, so ownership
never leaves the original binding and the value is dropped exactly once; an alias is a borrow
binding, so letting it escape is **NT1604**; calling a **setter** through an alias, a by-borrow
parameter, a `for-of` element, a container element, a callback parameter or a capture is
**NT1607**; and reassigning an owner something still aliases is **NT1602** (≈ E0506). This
proves no double-free / use-after-free from aliasing; it is deliberately *not* full `&mut`
exclusivity (the owner may mutate while an alias is live — that is the specified behaviour).

**Consuming parameters — the callee takes ownership.** A parameter is normally a **borrow**:
the caller owns the value and drops it when its scope ends, so storing one into anything that
outlives the call would give it two owners and free it twice (measured: exit 255). rustc draws
the same line between `fn f(x: T)` and `fn f(x: &T)`, and nativets now has the first side of it
in exactly one syntactic place — a **constructor parameter property**:

```ts
class NTError extends Error {
  constructor(readonly diag: Diagnostic) { super(diag.message); }
}
const d: Diagnostic = { code: "NT0001", message: "…" };
const e = new NTError(d);   // `d` MOVES into the error
console.log(d.code);        // NT1601 — use of moved value
```

A parameter property is the one parameter whose store is **guaranteed by the desugaring**
(`constructor(readonly d: T)` emits a field plus `this.d = d`), so "is it consuming?" has a
syntactic answer that needs no inference and no new spelling. The rule is two-sided and both
sides are required for soundness:

- **In the callee**, the definitional store is not a move-out — the value arrived owned by this
  object — and the parameter keeps *borrowing* it afterwards, so
  `constructor(readonly xs: T[]) { this.n = xs.length }` reads fine while a *second* hand-off
  (`const stolen = xs`, `move(xs)`, `return xs`) is still **NT1604**.
- **At every `new C(v)` site**, the argument MOVES: the caller stops dropping it and using it
  afterwards is **NT1601** (≈ E0382), including `new Pair(v, v)`.

Everything else stays a borrow, deliberately. A hand-written `this.f = p` in a constructor body
is still **NT1604** — only the parameter-property spelling is guaranteed to store — and its hint
names the form to write instead. Plain functions have no consuming parameter, so
`function wrap(d: T): Box { return new Box(d); }` is refused rather than miscompiled.

**A module-level binding is a borrow inside a function body.** The module scope owns
`const shared = { a: 1 }` and drops it when the program ends, so a function body may only read
*through* it. Handing it out makes the caller a second owner of the same pointer:

```ts
const shared = { a: 1 };
function getShared(): { a: number } { return shared; }   // NT1604
const x = getShared();
console.log(shared.a, x.a);                              // node: "1 1", exit 0
```

That program used to compile clean and emit two consecutive `nt_obj_free`s on one pointer in
`main`. It died in the allocator with exit 133/134 and — the reason it survived so long — an
**empty stdout and an empty stderr**, because the abort discards the buffered stream, so a
differential test comparing stdout alone saw two empty strings and passed. ASan reports
`attempting double-free`.

The rule is the by-borrow parameter rule with a different owner, and it is enforced by the same
`borrowBindings` machinery, over the set `checked.globals` — the very table codegen promotes to
`@nt.g.<name>` storage, so "what gets freed" and "what is a global" cannot drift apart. Every
consuming position is covered: `return g`, `const t = g` (which makes the *function* drop it,
a double free with no `return` involved), `return { w: g }`, `return [g]`, an arrow's expression
body (`=> g` — a return that used to be walked as a pure borrow, so it disagreed with its own
braced spelling), and the same shapes reached across a module boundary.

**Moving the global was not an option**, and this is the case that rules out the whole family of
"just transfer ownership" answers: the binding is still live and still readable afterwards —
node prints `shared.a` fine — so a move would produce a *wrong answer* rather than a refusal.
A return-position **borrow** would be the expressive fix, but it is a language feature (every
call site and every onward use would have to be proven not to outlive the module), not a bug
fix; until then this is a refusal, per *reject, never miscompile*.

Reads stay legal and are what the hint points at: `return g.field`, `for (const v of g)`,
`g.length`, a field *of* the global (`return g.inner` — a distinct allocation), a freshly built
value, and **strings**, which are refcounted rather than linear and were never affected.

**Borrows (phase 2, done for for-of).** A `for-of (const x of arr)` holds a borrow of `arr`
for the whole loop body. Inside the body: reads (`.length`, `arr[i]`, `.includes`) are shared
borrows and fine; **mutating** `arr` (`.push`/`.pop`) is `NT1603` (iterator invalidation ≈
E0502); **moving** `arr` (`move`/binding/return) is `NT1602` (≈ E0505). Borrows are tracked as
a lexical, nesting-aware set separate from the move lattice.

Diagnostics mirror rustc's phrasing and multi-span style, e.g.
`error[NT1601]: use of moved value: \`a\` (moved at line 3, used at line 4)`.

## Bounds: an out-of-range index PANICS (the other half of memory safety)

Ownership answers *whose* value this is; bounds answer *whether the element exists*. Every
indexed accessor in the runtime has always been bounds-checked — nativets never performs an
out-of-bounds **memory** access — but the *policy* on a failed check used to be to hand back a
benign value (`nt_arr_get` → `0`, `js_str_char_at` → `""`, a `Uint8Array` write → a silent
no-op, `.with` out of range → an unchanged copy). That is memory-safe and **still wrong**: it
matches neither node (`undefined`) nor a trap, so the program kept computing on a value that
was never there.

The policy is now rustc's: **panic**. `arr[i]`, `s[i]`, `u[i]`, `u[i] = v` and `arr.with(i, v)`
abort with `panic: index out of bounds: the length is N but the index is I`, the source
location, and a pointer at `.at(i)`. A panic is **not** an exception — it does not use the
pending-exception protocol, so `try`/`catch` cannot swallow it — and when both the length and
the index are compile-time constants the program is rejected outright (**NT2002**) instead.
See `docs/divergences.md` and `test/panic.test.ts`.

Indices the **programmer wrote** panic, and so do **the array HOFs** — `.map`/`.filter`/
`.forEach`/`.flatMap`/`.reduce` and `.some`/`.every`/`.find`/`.findIndex`/`.findLast`/
`.findLastIndex` all read through `nt_arr_hof_at`, which panics rather than returning 0.
Genuinely in-bounds compiler-generated reads (`JSON.stringify`, destructuring, spread-call
expansion) keep reading through the internal `nt_arr_get`, so nothing pays for a second check.

The HOFs used to be in that second list, and it was **wrong**: a HOF's loop bound is the
receiver's length read once, so a callback that shrinks the receiver walks off the end and used
to read 0 there — a silent wrong answer, and a hole in the panic guarantee above. `for-of` is
genuinely safe for a *different* reason than a snapshot bound: **NT1603** (iterator invalidation,
below) refuses the program that would outrun it. The HOF form of that same hazard has no such
refusal, because the shrink can happen one call deep, inside a callee, where nothing syntactic
is left to key on. See `docs/divergences.md` and `test/hof-resize.test.ts`.

## Tests (rustc `compiletest`-style)

`test/ownership/*.ts`, driven by `test/ownership.test.ts`:

- `//@ check-pass` — the checker must **accept** (zero diagnostics).
- `//~ ERROR NT1601` — a diagnostic with that code must occur **on that line**, and there
  must be no unexpected diagnostics.

Current corpus: `move-ok`, `borrow-ok`, `revival` (accept); `use-after-move`, `double-move`,
`implicit-move`, `conditional-move`, `loop-move` (reject) — mirroring rustc's `tests/ui/moves/`
phase-1 scenarios.

## Drop (deterministic free)

The ownership pass computes, for each `return` and for a scope's fall-through exit, the set of
owned (non-moved) **top-level linear locals** (`ReturnStmt.drops`, `FuncDecl.endDrops`,
`Program.endDrops`). Codegen emits `nt_arr_free` for them — after computing the return value,
and move-aware so a value is freed **exactly once by its final owner** and never a moved-out
value. No GC, no manual free. Observable via the runtime `__arrLive()` counter (allocated −
freed); see `test/drops.test.ts`.

### Shared storage: refcounted trie nodes (B2 step 2)

Linearity is a property of the **handle**, not of every byte behind it. Past 32 elements an array's
storage becomes a **persistent 32-way trie** (`runtime/nt_pvec.c`) whose nodes are *shared* between
versions — `a.with(i,v)` copies only the root→leaf path — so a node has many owners and the linear
drop must not free it directly. Resolution (chosen over the allocate-and-never-free placeholder):
**the trie nodes are reference counted**. Constructors return owned (rc = 1) references, header
construction *consumes* the root/tail references it is handed, a slot store transfers ownership and
overwriting a slot releases the old occupant; `release` frees at zero and recursively releases an
internal node's children (a leaf's slots are values, so recursion stops). `nt_arr_free` releases the
header: this version's private path nodes die immediately, anything another version still references
survives. **Exactly-once, never dangling** — the same guarantee the linear model gives, extended
through the shared DAG (immutable ⇒ acyclic ⇒ rc is complete, no cycle collector). Witnessed by
`__pvNodes()` (live nodes → 0 when all versions drop) in `test/sharing.test.ts` and by vector 22 of
`test/runtime/pvec_test.c`, which is also run under ASan/UBSan. The rc is non-atomic, like the
string rc.

### Where drops happen (B2 step 4 — the leaks closed)

Drop is no longer only "top-level locals at scope exit". Four drop points, all computed by the
ownership pass so they stay move-aware:

| Drop point | Set | Notes |
|---|---|---|
| function / module fall-through exit | `FuncDecl.endDrops`, `Program.endDrops` | as before |
| `return` | `ReturnStmt.drops` | now every **active scope**, not just the top level |
| nested block exit (`if` arm, loop body, `switch` case, `try` block) | `Stmt[].blockDrops` | a loop-body local is freed **each iteration** |
| **reassignment** `x = …` | `AssignExpr.dropOld` | the superseded value is freed after the RHS is evaluated |
| unbound **temporary** | emitted by codegen | a fresh array consumed as a method receiver (`xs.map(f).filter(g)`, `s.split(",").length`) is freed there |
| **discarded statement result** | `FnGen.discardFree`, emitted by codegen | `Object.keys(o);` / `a.concat(b);` / `JSON.stringify(o);` — see below |

**A discarded result is a temporary with no name at all.** `Object.keys(o);` in statement
position allocates an array that no binding owns, so no drop set can refer to it and the
receiver rule above never sees it (that rule frees the *receiver* of a chain, never its
result). Codegen marks such a value at the point it is **built** (`discardFree`, carrying the
reclaiming call) and the `ExprStmt` frees it on SSA identity.

Marked at construction rather than recognised by shape, deliberately. The shape test exists —
`freshArray` in `ast.ts` already answers "yes" for `.concat` and `.keys` — and is wrong here
because it matches on the **method name**: its two current callers are safe only because both
have already established that the receiver is a builtin array, and at a discard there is no
such context. A user class with a `keys()`/`concat()` method returning a field would match it,
and freeing that field is a use-after-free rather than a leak. Only lowerings whose freshness
is a fact of the lowering set the mark (`Object.keys`/`values`/`entries`/`getOwnPropertyNames`,
`Array#concat`, `JSON.stringify`); everything else stays unclaimed and keeps leaking, because a
wrong claim is a premature free.

`JSON.stringify` also releases the accumulators of its own fold (`jsonCat`): the serializer is
a left fold of `js_str_concat`, which always allocates and copies both inputs, so every
accumulator but the last is dead once the next concatenation has run. `{a, b}` allocated eight
strings and returned one.

**Conditional moves get a drop flag.** The move lattice tracks MAY-move (join = OR — what the
use-after-move check reads) *and* MUST-move (join = AND). A value moved on only some paths is
still dropped, under a flag that costs nothing: the move **nulls the binding's slot**
(`Identifier.nullOnMove`) and `nt_arr_free(NULL)` / `nt_obj_free(NULL)` are no-ops — so the
pointer itself is rustc's runtime drop flag and the drop stays one unconditional call.

Deliberately conservative (leak, never a double free / dangling pointer):

- a value that escapes a block via `break` / `continue` / `throw` jumps past the drop point;
- a name mentioned inside any **arrow body** is never dropped on reassignment (the closure env
  holds a second pointer we cannot see or null);
- a **module-level binding promoted to a global** is never dropped on reassignment — some
  function reads it and may have returned the pointer to a caller we cannot analyse;
- **temporaries in non-chain positions** (a call argument) — a callee may retain them;
- **elements**: freeing an array/object frees the handle, not what its slots point at. Element
  strings are refcounted separately; element objects/arrays are not freed at all.

### Transients: `rc == 1` ⇒ mutate in place

Cloning a 32-slot tail leaf per append costs ~36× a flat write. Clojure's answer is the
transient: if nobody else can observe the value, mutate it. Here that is *provable* rather than
hoped for — `nt_pv_push_own` writes the tail in place only when the vector header's refcount is 1
**and** its tail leaf's refcount is 1 (a `.with` into the tree retains the tail; a `.with` into
the tail clones it), and otherwise falls back to the persistent push. Old-version-unchanged
therefore holds by construction, decided by the refcount.

Linearity is what makes the fast path the common one: `x = [...x, e]` is compiled as a
**consuming append** (`nt_arr_extend_own`) — the ownership pass proves `x`'s old value is dead,
so the new array *moves* the storage instead of copying/retaining it, and the trailing push finds
rc = 1. Measured on 200k loop-appends: peak RSS 87.9 MB → 5.3 MB, 200001 abandoned handles → 0,
217660 trie-node allocations → 0. On an already-frozen (trie-backed) array, 320 appends allocate
30 nodes instead of ~320, with 309 of them written in place.

Element strings of a `string[]` are shared and not freed with the array.

## Roadmap

1. ✅ Move + use-after-move (`NT1601` ≈ E0382).
2. ✅ Deterministic drop/free at scope exit — leak eliminated for owned arrays.
3. ✅ Borrows for `for-of` — move-while-borrowed (`NT1602` ≈ E0505) and mutate-while-borrowed
   (`NT1603` ≈ E0502, iterator invalidation).
4. Drops for nested-scope and temporary values (needs block-scoped drop points / drop flags).
5. General borrows beyond for-of (if we add reference bindings) + `E0507`/`E0508`.
6. Extend linearity to **objects** (M1 part 2) and eventually owned strings.
7. ✅ Refcounted **shared trie nodes** for arrays past the 32-element threshold (B2 step 2) — the
   bridge between linear handles and structurally-shared storage.
8. ✅ Drops for **reassignment, nested scopes and temporaries** + **drop flags** for conditional
   moves, and **transients** (`rc == 1` ⇒ mutate in place) — B2 step 4. See the table above for
   what is still deliberately left leaking.
