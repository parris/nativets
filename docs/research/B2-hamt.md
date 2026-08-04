# B2 — Maps & Sets: small-flat + HAMT (design note + C-unit test vectors)

Scope: the **C-runtime data structure** for `Map`/`Set` under B2 (immutable-by-default,
structural sharing). This is built and unit-tested **directly in C** (`assert`-based,
`node` is *not* the oracle here — it becomes the oracle only later, once codegen wires
these into `.ts`). Small maps (≤ ~32) are a **sorted flat key array + parallel value
array**; large maps (> ~32) are a **HAMT** (hash array mapped trie). Sets are the same
HAMT/flat layout with keys only.

Sources mined: Bagwell *Ideal Hash Trees* (5-bit slices, 32-way bitmap+popcount);
popcount.org HAMT intro (confirms 5-bit/32-wide, popcount indexing); immutable.js
`Map.js` (node zoo + concrete thresholds + `packNodes` collapse); Clojure
`PersistentHashMap` (BitmapIndexed/Array/HashCollision, collapse-on-remove); jlouis
*Breaking Erlang Maps* (model-based `statem` testing, generators biased to the
resize boundary + hash collisions). Aligns with `docs/phase2-design.md` §1 and
`docs/ROADMAP.md` B2.

---

## 1. Design note

### 1.1 Slot & key model (reuse the array runtime's conventions)

Follow `nt_arr_*`: every key and value is an **8-byte slot** (`int64_t`); numbers are
`double`↔`int64_t` bitcasts, strings are `char*` (`ptr`) reinterpreted as `int64_t`. A
key is therefore `{ uint8_t type; int64_t slot }` with `type ∈ {NT_K_NUM, NT_K_STR}`.

Two internal helpers, defined once, used everywhere:

- **`nt_key_hash(k) -> uint32_t`** — numbers: hash the 8 raw bytes of the `double`
  (with `-0.0` normalized to `+0.0`, see SameValueZero below); strings: hash the bytes
  (FNV-1a or similar). Must be a *full 32-bit* hash so the trie has 32 bits = ⌈32/5⌉ = 7
  levels before it is exhausted and a collision node is forced.
- **`nt_key_eq(a, b) -> int`** — **SameValueZero** to match JS `Map`: `NaN` **equals**
  `NaN`; `+0` **equals** `-0`; a number key and a string key are **never** equal even if
  they print the same (`1` ≠ `"1"`). Equality — never hash — is the source of truth for
  membership; the hash only routes.

### 1.2 Small map — sorted flat, share-on-value-update

```c
typedef struct {           // canonical for count <= NT_MAP_SMALL_MAX (~32)
  int64_t  n, cap;
  uint8_t *ktype;          // parallel: key type tags        (len n)
  int64_t *keys;           // parallel: key slots, SORTED     (len n)  <-- shareable
  int64_t *vals;           // parallel: value slots           (len n)
} NtSmall;
```

- **Sorted order** = by `(hash, type, slot)` — a total order over mixed number/string
  keys. Gives O(log n) **binary-search** get and a *deterministic* layout (two maps with
  the same keys have byte-identical `keys`/`ktype` arrays → makes sharing decidable).
- **`put(k,v)` on an EXISTING key = value-only update** → allocate a new `NtSmall` and a
  new `vals` array (one slot changed), **but point `keys`/`ktype` at the *same* arrays as
  the source** (the key set is unchanged). This is the headline sharing invariant:
  `new->keys == old->keys` (pointer identity).
- **`put(k,v)` on a NEW key** → new `NtSmall`, new `keys`/`ktype`/`vals` (element inserted
  at its sorted position). Source untouched.
- **`remove(k)`** → new `NtSmall` with the entry spliced out (new backing arrays). Removing
  an absent key returns a map equal in contents (may return the source pointer as an
  optimization — spec: **return the source unchanged** so callers can pointer-compare).
- Immutability everywhere: an operation **never** writes through the source's arrays.

immutable.js reference thresholds (for calibration): `ArrayMapNode ≤ 8`, `BitmapIndexed
≤ 16`. We deliberately push the flat boundary to **~32** per `phase2-design.md` (BEAM's
small-map cutoff) — one tunable constant `NT_MAP_SMALL_MAX`.

### 1.3 Large map — HAMT (Bagwell single-bitmap)

5-bit hash slices ⇒ **32-way** branching. Level `d` uses bits `[5d, 5d+5)` of the hash:
`idx = (hash >> (5*d)) & 31`.

```c
enum { NT_HAMT_BITMAP, NT_HAMT_COLLISION };

typedef struct NtHamt {
  uint8_t  kind;           // BITMAP or COLLISION
  uint32_t bitmap;         // BITMAP: bit i set  <=>  slot i occupied
  int32_t  count;          // BITMAP: popcount(bitmap); COLLISION: #entries
  // dense, length == count. Each dense slot is a tagged child:
  uint8_t *ctype;          // per dense slot: LEAF vs SUBNODE (BITMAP);
                           //   COLLISION: all LEAF, key type tag
  int64_t *k;              // LEAF: key slot;      SUBNODE: unused
  int64_t *v;              // LEAF: value slot;    SUBNODE: NtHamt* (as int64)
} NtHamt;
```

**The two load-bearing formulas** (Bagwell):

```c
uint32_t bit = 1u << idx;                    // idx = (hash >> 5*d) & 31
int      present = (node->bitmap & bit) != 0;
int      pos     = popcount(node->bitmap & (bit - 1));  // dense array index
```

`popcount` = `__builtin_popcount` (codegen later emits `llvm.ctpop.i32`). The dense array
holds **only** occupied slots, in ascending slot order; `pos` is where slot `idx` lives.

**Insertion at a slot:**
- slot empty (`!present`) → splice a new LEAF into the dense arrays at `pos`, set `bit`.
- slot has a LEAF with the same key → value update (copy node, replace `v[pos]`).
- slot has a LEAF with a *different* key → the two keys **split**: create a subnode for
  level `d+1` holding both; if we've run out of hash bits (`d` past the last 5-bit slice
  and the two full hashes are equal) → make a **COLLISION** node instead.
- slot has a SUBNODE → recurse into it, then copy this node with the new child ptr.

**Removal + collapse (canonicalization — Clojure/immutable.js `packNodes`):**
- delete a LEAF → clear `bit`, splice out of dense arrays.
- a BITMAP subnode that collapses to a **single remaining LEAF** must be pulled up and
  inlined as a LEAF in the parent slot (no chains of single-child nodes).
- a COLLISION node that drops to **1 entry** collapses back to a plain LEAF.
- a node emptied entirely is removed from its parent (parent bit cleared).
- These keep the trie in **canonical form**: no singleton-child bitmap nodes, no
  1-entry collision nodes.

**Collision nodes:** hold ≥2 entries sharing the *full* 32-bit hash; linear scan with
`nt_key_eq`. Only ever created when the hash is exhausted (7 levels) *and* still equal —
keys that merely share a low slice split normally at a deeper level.

### 1.4 Small ⇄ HAMT boundary

- `NtMap` is a small handle carrying `kind ∈ {SMALL, HAMT}`, `count`, and a union
  `{ NtSmall*; NtHamt* root }`, plus `nt_map_size` reads `count` in O(1).
- **Promote** when a `put` of a *new* key would make `count > NT_MAP_SMALL_MAX`: build a
  HAMT by inserting all small entries + the new one. Source small map untouched.
- **Demote** when a `remove` drops a HAMT to `count == NT_MAP_SMALL_MAX`: rebuild the
  canonical sorted flat map (mirrors immutable.js demoting `HashArrayMap → BitmapIndexed`
  and `BitmapIndexed → ArrayMapNode` on shrink). Keeps a single canonical representation
  per key-set so equality/sharing stays decidable.

### 1.5 Sets

`Set` = the identical machinery with **no `vals`/`v` arrays** (keys only). `add` =
`put` with a unit value; `add` of a present key is idempotent and returns a set equal in
contents (spec: return the source unchanged, so a no-op add is pointer-stable). `has` /
`remove` / `size` / boundary / collisions all mirror the map. Implement Set as a thin
wrapper over the map core, or share code paths guarded by a `has_vals` flag.

### 1.6 Memory / leak accounting

Reuse the array runtime's counter discipline: a global `g_map_allocs`/`g_map_frees` with
`nt_map_live()` exposed, so unit tests assert no leaks once drops are wired. Until B2's
rc/transients land, maps may sit on the never-free placeholder — but every test that can
should still assert `nt_map_live()` returns to baseline.

### 1.7 Test-only hooks (make the danger zones reachable)

- **Forced collisions.** Do **not** hunt for real 32-bit hash collisions. Compile the
  test module with a hook — `nt_map__set_hash_hook(uint32_t (*)(NtKey))` (or
  `#ifdef NT_MAP_TEST_HASH`) — so a test can install a hash that maps a small,
  controlled key domain (e.g. `id % 8`) and thereby **construct exact full-hash
  collisions and exact slot placements on demand**. This is the single most important
  affordance for testing the collision + bitmap-index paths deterministically.
- **Introspection accessors** (test build only): `nt_map_kind(m)`, `nt_small_keys(m)`
  (pointer for the share-check), `nt_hamt_root(m)`, `nt_hamt_child_ptr(node, slot)`
  (for structural-sharing pointer checks), and **`nt_hamt_check(m)`** — a recursive
  validator returning 1/0 that asserts every structural invariant (see §3).

---

## 2. Ordered C-level unit-test vectors (red-green loop)

Each is `assert`-based in a standalone `runtime/test/map_test.c`, built + run directly
(exit 0 = green). Build the module minimally to pass each in order. Format per vector:
**setup · op · expected · invariant**.

### Group A — small flat map basics

1. **empty get/has** · new empty map · `get(any)` → miss, `has(any)` → 0, `size` 0 ·
   *inv:* kind==SMALL, `count==0`.
2. **put/get single** · `m=put(empty, k1, v1)` · `get(k1)==v1`, `has(k1)` 1, `has(k2)` 0,
   `size` 1 · *inv:* SMALL, `keys` sorted (trivially).
3. **put several distinct** · insert k1..k5 in scrambled order · all `get` hit with right
   vals; `size` 5 · *inv:* internal `keys` in ascending `(hash,type,slot)` order.
4. **overwrite value** · `put(k1,v1)` then `put(k1,v2)` · `get(k1)==v2`; `size` **still 1**
   · *inv:* SMALL, one entry.
5. **put is non-mutating (old unchanged)** · `m1=put(empty,k1,a)`; `m2=put(m1,k2,b)` ·
   `get(m1,k2)` miss, `size(m1)==1`; `get(m2,k1)==a && get(m2,k2)==b`, `size(m2)==2` ·
   *inv:* `m1 != m2`; m1 wholly intact.
6. **value-update SHARES key array (pointer identity)** ⚠️ · `m1` with keys {a,b,c};
   `m2=put(m1, b, newv)` · `get(m2,b)==newv`, `get(m1,b)==oldv` · *inv:*
   **`nt_small_keys(m2) == nt_small_keys(m1)`** (same pointer) **and** `vals` pointers
   differ. The core sharing guarantee.
7. **new-key put does NOT share key array** · `m2=put(m1, d, v)` (d ∉ m1) · d present in
   m2 only · *inv:* `nt_small_keys(m2) != nt_small_keys(m1)`; both sorted; m1 unchanged.
8. **remove present** · from {a,b,c} `remove(b)` · b gone, a&c intact, `size` 2, returns
   new map · *inv:* source {a,b,c} unchanged; result sorted.
9. **remove absent** · `remove(z)` from {a,b,c} · contents unchanged, `size` 3 · *inv:*
   spec — returns the **source pointer** (no-op is pointer-stable).
10. **SameValueZero key semantics** ⚠️ · (a) `put(NaN, x)` then `get(NaN)==x`; (b)
    `put(+0,p)` then `put(-0,q)` → `size` 1, `get(0.0)==q`; (c) `put(1,α)`, `put("1",β)` →
    `size` 2, both distinct · *inv:* matches JS `Map` membership exactly.

### Group B — the small→HAMT boundary (~32) ⚠️ danger zone

11. **fill to threshold stays SMALL** · insert exactly `NT_MAP_SMALL_MAX` distinct keys ·
    all gettable, `size==MAX` · *inv:* kind==SMALL, `keys` sorted.
12. **cross threshold promotes to HAMT** · insert one more (MAX+1) · all MAX+1 gettable,
    `size==MAX+1` · *inv:* kind==HAMT **and `nt_hamt_check` passes** (popcount==children
    at every node).
13. **promotion leaves source intact** · hold `m_at_max` (SMALL); `m_over=put(m_at_max,
    k_new,v)` · `m_at_max` still SMALL, `size` MAX, all MAX present; `m_over` HAMT with
    MAX+1 · *inv:* promotion built a fresh trie, did not mutate the small source.
14. **remove across boundary demotes to SMALL** · from a (MAX+1)-entry HAMT `remove` one ·
    `size` MAX, all present · *inv:* kind==SMALL (canonical single representation);
    `keys` sorted; source HAMT unchanged.

### Group C — HAMT bitmap / popcount internals

15. **bulk get/put/has** · insert ~1000 distinct keys, then get every one + probe absentees
    · all hits correct, absentees miss, `size` 1000 · *inv:* `nt_hamt_check` passes.
16. **sparse bitmap index** ⚠️ · via the hash hook, place two keys in **non-adjacent** root
    slots (e.g. slots 3 and 30) · both retrievable · *inv:* root `count==2`,
    `popcount(bitmap)==2`; the key routed to slot 30 sits at dense `pos==popcount(bitmap &
    (bit30-1))==1`; slot 3 at `pos==0`.
17. **deep trie via shared prefix** · hook keys to share the first *k* 5-bit slices, then
    diverge · all retrievable at depth · *inv:* `nt_hamt_check` passes at every level;
    nested BITMAP subnodes (not collision) formed at the split depth.

### Group D — forced hash collisions ⚠️ prime danger zone

18. **collision → collision node** · hook so 2 distinct keys share the **full** hash;
    insert both with different vals · both `get` return their own val · *inv:* the housing
    node is `kind==COLLISION` with `count==2`; both entries by `nt_key_eq`.
19. **collision node put/update/remove** · add a 3rd colliding distinct key; update one;
    remove one · remaining two gettable with correct vals · *inv:* collision `count`
    tracks (3→3 after update→2 after remove); **equality, not hash**, disambiguates.
20. **collision collapses on shrink** · remove colliding keys down to 1 · the surviving key
    still gettable · *inv:* the COLLISION node has **collapsed to a plain LEAF** (no
    1-entry collision node remains); `nt_hamt_check` passes.
21. **prefix-collision is NOT a hash-collision** ⚠️ · hook two keys sharing the same *low
    5-bit slice* at the root but **different full hashes** · both retrievable · *inv:* they
    split into a **BITMAP subnode** at depth 1 — node kind is **not** COLLISION. Guards the
    classic bug of conflating slice-collision with full-hash-collision.

### Group E — removal / node collapse (canonical form)

22. **subnode collapses to inlined leaf** ⚠️ · build a state with a 2-leaf BITMAP subnode,
    then remove one leaf · remaining leaf still gettable · *inv:* the subnode is **pulled
    up and inlined** as a LEAF in the parent slot; `nt_hamt_check` confirms **no
    singleton-child BITMAP node** exists anywhere.
23. **remove everything → empty** · insert N (into HAMT range) then remove all · every key
    misses, `size` 0 · *inv:* kind demoted to SMALL/empty; if drops wired,
    `nt_map_live()` back to baseline.
24. **remove absent from HAMT** · `remove(z ∉ m)` on a large map · contents + `size`
    unchanged · *inv:* `nt_hamt_check` passes; structural sharing preserved (result may
    reuse the source root).

### Group F — sets

25. **set semantics** · `s=add(add(add(new,a),b),a)` (duplicate a) · `has(a)&has(b)` 1,
    `has(c)` 0, `size` **2** (dup ignored) · *inv:* re-`add` of a present key returns a set
    equal in contents (spec: pointer-stable no-op); `remove` + boundary + a forced
    collision case (mirror #12 & #18 with keys only) all pass `nt_hamt_check`.

### Group G — immutability / structural sharing

26. **sibling subtree pointer identity** ⚠️ · in a HAMT, `m2 = put(m1, k, v)` where `k`
    routes into root slot `i` · a **different, untouched** root slot `j` · *inv:*
    `nt_hamt_child_ptr(root(m2), j) == nt_hamt_child_ptr(root(m1), j)` (**shared subtree**);
    only the root→leaf path along slot `i` is freshly copied (path copying).
27. **many versions all intact** · chain `m0 → m1 → … → mK` by puts/removes, keeping every
    handle · each `mi` still agrees with its expected contents; none leaked forward or
    backward · *inv:* full immutability across a long history.

Interleave `nt_hamt_check` after every mutating op in Groups B–G, and assert
`nt_map_live()` returns to baseline at each test's end wherever drops are in effect.

---

## 3. Structural invariants asserted by `nt_hamt_check` (and the model tests)

For every node reached from the root:

- **`popcount(node->bitmap) == node->count == len(dense arrays)`** (BITMAP nodes) — the
  central sparse-node invariant.
- Dense children are in **ascending slot order**; the `pos` computed by
  `popcount(bitmap & (bit-1))` addresses the intended slot.
- **No singleton-child BITMAP node** (canonical: single leaves are inlined upward).
- **COLLISION nodes hold ≥ 2 entries**, all with an equal full hash, all pairwise
  `!nt_key_eq`.
- **Uniform routing:** a leaf at depth `d` reached via slots `s0..s{d-1}` has
  `(hash >> 5*i) & 31 == si` for each level (its hash actually routes there).
- **`count`** at the root equals `nt_map_size`.
- **Canonical kind:** `count <= NT_MAP_SMALL_MAX` ⇒ SMALL; `> MAX` ⇒ HAMT.

---

## 4. Model-based property-test recipe (jlouis `statem` style)

**Reference model** — an assoc-list (array of `(key,val)`, last-write-wins) with trivial
`put/get/has/remove/size`. Obviously correct, O(n), the oracle.

**Command generator** — random sequence of `put(k, v)`, `remove(k)`, `get(k)`, `has(k)`
over a **deliberately small key domain**:

- **Bias to the ~32 boundary:** draw keys from a domain of ≈ `NT_MAP_SMALL_MAX * 1.3`
  distinct keys (≈40) and weight `put:remove` ≈ 55:45, so the sequence **repeatedly
  crosses and re-crosses** the small⇄HAMT threshold (promote + demote both exercised).
- **Bias to collisions:** install the **test hash hook** mapping keys to a small hash
  domain (e.g. `key % 8` for one sub-domain), so a meaningful fraction of inserts land in
  the **same slot / same full hash** — collision nodes form, grow, and dissolve.
- **Bias to prefix-collisions:** a second key sub-domain engineered to share low slices
  but differ in full hash, to hit the deep-split path (#21).

**Per-step oracle check** — after each op, for **every key in the domain** assert `get`
and `has` agree between map and model, and `size` agrees. Then run **`nt_hamt_check`**
on the result.

**Immutability property** — keep a random sample of prior versions with a snapshot of the
model at their creation; after later ops, assert each old version *still* agrees with its
own snapshot (proves old-unchanged / no aliasing writes).

**Sharing property** — on a **value-only small update**, assert `nt_small_keys` pointer
identity (#6); on a **HAMT deep put**, assert ≥1 untouched sibling `nt_hamt_child_ptr` is
pointer-identical (#26).

**Leak property** — if drops are wired, after dropping all live versions assert
`nt_map_live()` is back to baseline.

**Shrinking** — on failure, shrink the op sequence (drop ops) and the key domain (shrink
key ids toward 0) to the minimal reproducing case — the classic PropEr/QuickCheck
`statem` shrink that made the original *Breaking Erlang Maps* bugs legible.

**Directed seed cases** (always run, not just random): (a) fill to exactly MAX then MAX+1
then back to MAX; (b) insert N full-hash-colliding keys then remove them in several
orders; (c) build into HAMT range then tear all the way down to empty; (d) alternate
value-only updates on a fixed key set and assert key-array sharing holds every time.
