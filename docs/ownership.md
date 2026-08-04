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
| — | E0507 / E0508 | move out of borrow / array element | ⏳ later |

**Borrows (phase 2, done for for-of).** A `for-of (const x of arr)` holds a borrow of `arr`
for the whole loop body. Inside the body: reads (`.length`, `arr[i]`, `.includes`) are shared
borrows and fine; **mutating** `arr` (`.push`/`.pop`) is `NT1603` (iterator invalidation ≈
E0502); **moving** `arr` (`move`/binding/return) is `NT1602` (≈ E0505). Borrows are tracked as
a lexical, nesting-aware set separate from the move lattice.

Diagnostics mirror rustc's phrasing and multi-span style, e.g.
`error[NT1601]: use of moved value: \`a\` (moved at line 3, used at line 4)`.

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

Conservative for safety: only top-level linear locals are dropped. Conditionally-created
(nested-block) and temporary (unbound) arrays are not yet freed — safe (no double free), may
leak. Element strings of a `string[]` are shared and not freed with the array.

## Roadmap

1. ✅ Move + use-after-move (`NT1601` ≈ E0382).
2. ✅ Deterministic drop/free at scope exit — leak eliminated for owned arrays.
3. ✅ Borrows for `for-of` — move-while-borrowed (`NT1602` ≈ E0505) and mutate-while-borrowed
   (`NT1603` ≈ E0502, iterator invalidation).
4. Drops for nested-scope and temporary values (needs block-scoped drop points / drop flags).
5. General borrows beyond for-of (if we add reference bindings) + `E0507`/`E0508`.
6. Extend linearity to **objects** (M1 part 2) and eventually owned strings.
