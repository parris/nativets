# B2 · Persistent Vector (32-way trie + tail) — C-runtime design + red-green test vectors

Research deliverable for **ROADMAP B2 step 2 (arrays)** and **phase2-design §1**: a
32-way, bit-partitioned **persistent vector trie with a tail buffer** (Clojure
`PersistentVector`) to back large immutable arrays past a size threshold, with structural
sharing. This document is (1) a concise **design note** of the C data structure and (2) an
**ordered list of C-level unit-test vectors** that drive the red-green loop for the C module
*before* it is wired into codegen. These tests exercise the runtime data structure directly
(in C / a small harness), **not** through `node` — the differential-vs-node oracle only
applies once the structure is behind array codegen.

Sources: hyPiRion "Understanding Clojure's Persistent Vectors" pt.1 (branching/why-32),
pt.2 (bit-partitioned lookup), pt.3 (tail buffer); Krukow, "Understanding Clojure's
PersistentVector implementation" (blog.higher-order.net, the canonical `cons`/`pushTail`
walk-through); Clojure `clojure.lang.PersistentVector` source (`cons`/`pushTail`/`newPath`/
`doAssoc`/`popTail`); Bagwell "Ideal Hash Trees" + Bagwell/Rompf RRB-Trees (branching-factor
and balanced-trie rationale).

---

## Part 1 — Design note: the C data structure

### 1.1 The shape

A persistent vector is a **wide, balanced trie** (branching factor **32**) whose **leaves
all sit at the same depth**, plus a **tail buffer** — a direct reference to the rightmost
(not-yet-pushed) leaf. ~96.9% (31/32) of appends only touch the tail, giving **O(1)
amortized append**; `get`/`update` are **O(log₃₂ n)** (≤ ~6 levels below 10⁹ elements, ~7
below 3.5×10¹⁰). Nothing is ever mutated in place, so updates copy **only the root→leaf
path** (path copying); every untouched sibling subtree is shared by pointer.

```
        vector header
   ┌────────────────────────────┐
   │ count  shift  root   tail   │
   └───┬──────────────┬──────────┘
       │ root         │ tail  (the live rightmost leaf, 1..32 slots)
       ▼              ▼
   [internal node]  [ e992 e993 … e1023 ]      ← tail, appended-to directly
   32 child ptrs
     ├─►[leaf 0..31]
     ├─►[leaf 32..63]
     …
```

### 1.2 Node layout (match nativets' existing 8-byte-slot convention)

nativets arrays (`nt_arr_*`) already store every element as an **8-byte slot** and bitcast
`number`↔`i64` / `ptr`↔`i64` through it. The trie keeps that contract: **every slot is an
`int64_t`**, whether it holds a child-node pointer (internal) or a value (leaf).

```c
#define NT_PV_BITS   5
#define NT_PV_WIDTH  32          /* 1 << NT_PV_BITS  */
#define NT_PV_MASK   31          /* NT_PV_WIDTH - 1  */

typedef struct nt_pv_node {
    int32_t  refcount;           /* structural sharing / rc (B2 step 4); tests read it   */
    int32_t  kind;               /* 0 = internal (slots are nt_pv_node*), 1 = leaf (values) */
    int64_t  slots[NT_PV_WIDTH]; /* children OR values; unused slots are 0/NULL           */
} nt_pv_node;

typedef struct nt_pv {
    int32_t      refcount;
    uint32_t     count;          /* total element count                                   */
    uint32_t     shift;          /* = 5 * (levels_of_internal_nodes); root-level shift    */
    nt_pv_node*  root;           /* trie root (may be a shared node)                      */
    nt_pv_node*  tail;           /* rightmost leaf buffer                                 */
    uint32_t     tail_len;       /* live element count in tail, 1..32                     */
} nt_pv;
```

Notes:
- **`kind`** lets a leaf-vs-internal assert be O(1) in tests; production codegen knows depth
  statically from `shift` and can drop it.
- **`refcount`** exists now so the model matches B2 step 4 (atomic rc + transients) and so
  structural-sharing tests can assert pointer identity *and* rc bookkeeping. For the pure
  persistent (immutable, no-transient) phase, treat a node as frozen once published.
- **Empty vector**: `count=0`, `shift=5`, `root = EMPTY_NODE` (a shared, all-NULL internal
  node), `tail_len=0`. Clojure's invariant — first 32 elements live only in the tail.

### 1.3 Shift / level math (bit partitioning)

Index `i` is split into 5-bit groups, most-significant group chosen at the root:

```
child index at a node with shift s :  (i >>> s) & NT_PV_MASK
descend                             :  s -= 5   (until s == 0)
final leaf slot                     :  i & NT_PV_MASK
```

`shift` is the right-shift applied **at the root**. `shift == 5` ⇒ the root's children are
leaves (tree capacity 32² = 1024). Each extra level adds 5 to `shift` and ×32 to capacity:

| shift | internal levels | **tree capacity** (`32^(shift/5 + 1)`) | note                          |
|------:|----------------:|---------------------------------------:|-------------------------------|
|   5   |        1        | **1 024** (32²)                        | root's children are leaves    |
|  10   |        2        | **32 768** (32³)                       |                               |
|  15   |        3        | 1 048 576 (32⁴)                        |                               |

The **tail** always holds the last ≤ 32 elements *not yet pushed into the tree*.

```
tailoff(v) = v->count - v->tail_len          /* = # elements currently in the tree */
           = (count < 32) ? 0 : ((count - 1) >>> 5) << 5   /* equivalent form      */
```

### 1.4 Lookup — `nt_pv_get(v, i)` → `int64_t`

```c
int64_t* nt_pv_array_for(nt_pv* v, uint32_t i) {      /* returns the leaf slot array */
    if (i >= tailoff(v)) return v->tail->slots;       /* in the tail buffer          */
    nt_pv_node* n = v->root;
    for (int s = v->shift; s > 0; s -= NT_PV_BITS)
        n = (nt_pv_node*)(intptr_t) n->slots[(i >> s) & NT_PV_MASK];
    return n->slots;                                  /* leaf                        */
}
int64_t nt_pv_get(nt_pv* v, uint32_t i){ return nt_pv_array_for(v,i)[i & NT_PV_MASK]; }
```

The **`i >= tailoff` short-circuit is the tail's whole point** — the common
recently-appended read never traverses the tree.

### 1.5 Update — `nt_pv_update(v, i, val)` → new `nt_pv` (path copying)

- **`i` in the tail** → copy the tail leaf (one node), apply, **share the entire tree**
  (`new->root == v->root`, pointer-identical).
- **`i` in the tree** → `doAssoc`: clone the root, recurse copying **exactly one node per
  level** down to the leaf, replace the target slot; **every sibling slot is copied by
  value = pointer-identical shared subtree**.

```c
static nt_pv_node* do_assoc(int level, nt_pv_node* node, uint32_t i, int64_t val){
    nt_pv_node* ret = clone_node(node);               /* shallow copy of 32 slots     */
    if (level == 0) ret->slots[i & NT_PV_MASK] = val; /* leaf                          */
    else { int sub = (i >> level) & NT_PV_MASK;
           ret->slots[sub] = (int64_t)(intptr_t)
               do_assoc(level - NT_PV_BITS,(nt_pv_node*)(intptr_t)node->slots[sub],i,val); }
    return ret;
}
```

Newly allocated nodes per tree-update = **`shift/5 + 1`** (levels + leaf). Everything else
is shared.

### 1.6 Append — `nt_pv_push(v, val)` → new `nt_pv` (O(1) amortized)

```c
nt_pv* nt_pv_push(nt_pv* v, int64_t val){
    /* (a) room in tail? true 31/32 of the time */
    if (v->count - tailoff(v) < NT_PV_WIDTH) {
        tail' = copy_leaf(v->tail); tail'->slots[v->tail_len] = val;
        return header(count+1, shift, root=SHARED(v->root), tail', tail_len+1);
    }
    /* (b) tail is full (32) -> promote it into the tree as a leaf */
    nt_pv_node* tailnode = v->tail;                 /* the full 32-slot leaf          */
    nt_pv_node* newroot; int newshift = v->shift;
    /* (c) ROOT OVERFLOW?  the exact Clojure condition: */
    if ((v->count >>> NT_PV_BITS) > (1u << v->shift)) {
        newroot = new_internal();
        newroot->slots[0] = (int64_t)(intptr_t) v->root;          /* share old root   */
        newroot->slots[1] = (int64_t)(intptr_t) new_path(v->shift, tailnode);
        newshift = v->shift + NT_PV_BITS;           /* height + 1                     */
    } else {
        newroot = push_tail(v->shift, v->root, tailnode);         /* copy rightmost path */
    }
    return header(count+1, newshift, newroot, tail=leaf_of(val), tail_len=1);
}

static nt_pv_node* new_path(int level, nt_pv_node* node){         /* chain of 1-child nodes */
    if (level == 0) return node;
    nt_pv_node* r = new_internal();
    r->slots[0] = (int64_t)(intptr_t) new_path(level - NT_PV_BITS, node);
    return r;
}
static nt_pv_node* push_tail(int level, nt_pv_node* parent, nt_pv_node* tailnode){
    int sub = ((count - 1) >> level) & NT_PV_MASK;   /* count = pre-push size          */
    nt_pv_node* ret = clone_node(parent);            /* copy this node; siblings shared */
    nt_pv_node* insert;
    if (level == NT_PV_BITS) insert = tailnode;      /* parent is one above leaves      */
    else { nt_pv_node* child = (nt_pv_node*)(intptr_t) parent->slots[sub];
           insert = child ? push_tail(level-NT_PV_BITS, child, tailnode)
                          : new_path(level - NT_PV_BITS, tailnode); }
    ret->slots[sub] = (int64_t)(intptr_t) insert;
    return ret;
}
```

**The overflow condition `(count >>> 5) > (1 << shift)` is the single most bug-prone line**
and the flat→trie boundary math the references stress. It is *delayed* past the round power
of 32: with `shift == 5`, tree capacity is 1024 and it overflows only when
`count == 1024 + 32 = 1056` (the tree is already full at 1024, and the *previous* full tail
occupies 992..1023; the height bump fires when the append at **index 1056** must push a 33rd
leaf). General rule: with tree capacity `C = 32^(shift/5+1)`, the height bump fires at
**`count == C + 32`** (appending element index `C+32`).

| current shift | tree capacity C | **height bump fires at append index** |
|--------------:|----------------:|--------------------------------------:|
| 5             | 1 024           | **1 056** (→ shift 10)                |
| 10            | 32 768          | **32 800** (→ shift 15)               |

### 1.7 Pop — `nt_pv_pop(v)` → new `nt_pv`

```c
nt_pv* nt_pv_pop(nt_pv* v){
    if (v->count == 0) trap();
    if (v->count == 1) return EMPTY;
    if (v->count - tailoff(v) > 1) {                 /* >1 in tail: just shrink tail   */
        tail' = copy_leaf_shorter(v->tail);          /* share tree                     */
        return header(count-1, shift, SHARED(root), tail', tail_len-1);
    }
    int64_t* newtail = nt_pv_array_for(v, v->count - 2);  /* last tree leaf becomes tail */
    nt_pv_node* newroot = pop_tail(v->shift, v->root);
    int newshift = v->shift;
    if (newroot == NULL) newroot = EMPTY_NODE;
    /* ROOT DEMOTION: height shrinks when the new root has a single child */
    if (v->shift > NT_PV_BITS && newroot->slots[1] == 0) {
        newroot = (nt_pv_node*)(intptr_t) newroot->slots[0];
        newshift -= NT_PV_BITS;
    }
    return header(count-1, newshift, newroot, newtail_copied, 32);
}

static nt_pv_node* pop_tail(int level, nt_pv_node* node){
    int sub = ((count - 2) >> level) & NT_PV_MASK;   /* count = pre-pop size           */
    if (level > NT_PV_BITS) {
        nt_pv_node* child = pop_tail(level-NT_PV_BITS,(nt_pv_node*)(intptr_t)node->slots[sub]);
        if (child == NULL && sub == 0) return NULL;
        nt_pv_node* ret = clone_node(node); ret->slots[sub] = (int64_t)(intptr_t)child; return ret;
    } else if (sub == 0) return NULL;
    else { nt_pv_node* ret = clone_node(node); ret->slots[sub] = 0; return ret; }
}
```

`pop` is the exact inverse of `push`; **root demotion** (`shift > 5 && newroot->slots[1] ==
NULL`) is the mirror of root overflow and the second-most bug-prone spot.

### 1.8 Flat → trie threshold (the nativets integration boundary)

Per phase2-design §1, arrays keep the **existing flat `nt_arr` block below ~32 elements**
and switch to the persistent trie above it. The natural, zero-waste threshold is **32**: a
vector of ≤ 32 elements is exactly "tail-only" (`root == EMPTY_NODE`, everything in `tail`),
so the persistent representation *is* a flat 32-slot buffer at that size — the switch is
free and the boundary index (**31 → 32**) is the same one the trie's first tail-push lands
on. Keep the two representations behavior-identical across the boundary; the test list below
straddles it explicitly.

---

## Part 2 — Ordered C-level unit-test vectors (the red-green loop)

Each test drives the C module directly (build a `nt_pv`, call ops, assert on returned
structure), **not** via node. Do them **in this order** — each builds the invariant the next
relies on. For every test: **setup · operation · expected result · structural-sharing
invariant to assert**. "old untouched" always means: the pre-op vector still answers every
`get(i)` with its original value and its `count`/`shift`/`root` are unchanged.

**Shared invariant helpers to implement first (used throughout):**
- `assert_full(v)`: every leaf reachable from `root` is at depth `shift/5`; every internal
  node has its live children packed in slots `[0..k-1]` with the rest NULL (a vector is a
  *dense left-packed* trie); `tailoff(v) == count - tail_len`.
- `child_count(node)`: number of non-NULL slots (the analogue of HAMT popcount; here it must
  equal 32 for every internal node except possibly the right spine).
- `same_ptr(a,b)`: pointer identity (structural sharing witness).

### Build & get

1. **Empty + first element.** Setup: `EMPTY`. Op: `push(EMPTY, 10)`. Expect: `count==1`,
   `shift==5`, `root==EMPTY_NODE`, `tail_len==1`, `get(0)==10`. Invariant: `root` is the
   *shared* empty node (`same_ptr(v->root, EMPTY_NODE)`) — no tree allocated yet.

2. **Fill the tail exactly (the 31→32 danger zone).** Setup: `EMPTY`. Op: push `0..31`
   (32 pushes). Expect: `count==32`, `tail_len==32`, `shift==5`, `tailoff==0`,
   `root==EMPTY_NODE`; `get(i)==i` for all `i∈[0,32)`. Invariant: **still tail-only** — the
   tree is empty at exactly 32; nothing has been promoted. (This is the flat/trie boundary.)

3. **First tail→tree promotion (index 32).** Setup: result of #2. Op: `push(v, 32)`.
   Expect: `count==33`, `shift==5`, `tailoff==32`, `tail_len==1`, `get(32)==32`, `get(i)==i`
   for all `i∈[0,33)`. Invariant: `root` now has exactly **one** child (a leaf holding
   0..31), `child_count(root)==1`; that leaf is a *new* node (the old tail, re-homed),
   `tail` is a fresh 1-slot leaf.

4. **Build N and get every index — small trie.** Setup: `EMPTY`. Op: push `0..1023` (fills
   the tree exactly, one leaf per 32). Expect: `count==1024`, `shift==5`, `tailoff==992`,
   tree holds indices 0..991 across 31 leaves, `tail` holds 992..1023 (`tail_len==32`);
   `get(i)==i` ∀ `i∈[0,1024)`. Invariant: `assert_full` — `child_count(root)==31`, every
   child a full 32-slot leaf at depth 1; **still shift 5** (no overflow yet).

5. **Get spot-checks across all three leaf regions.** Setup: result of #4. Op: `get` at the
   boundary indices `{0, 31, 32, 63, 991, 992, 1023}`. Expect each `== i`. Invariant:
   exercises the `i >= tailoff` branch (last two) vs tree branch (rest) — the tail
   short-circuit.

### Height bump (root overflow)

6. **The shift 5→10 bump (the 1024/1056 danger zone).** Setup: push `0..1055` (count 1056,
   still `shift==5`: tree full at 1024, tail = 1024..1055). Assert pre-state
   `shift==5, tailoff==1024`. Op: `push(v, 1056)`. Expect: `count==1057`, **`shift==10`**,
   `get(i)==i` ∀ `i∈[0,1057)`. Invariant: new root has `child_count==2`; `root->slots[0]` is
   the **pointer-identical old root** (`same_ptr`, whole old subtree shared);
   `root->slots[1]` is a fresh `new_path` chain (single-child down to the promoted leaf);
   old vector unchanged.

7. **Off-by-one around the bump.** Setup: `EMPTY`. Op: build to `count==1055` then to
   `1056`, `1057`. Expect: `shift` stays `5` at 1055 **and** 1056; flips to `10` only when
   the append at index 1056 lands (result count 1057). Invariant: pins the *delayed*
   overflow — the bump is at `C+32 == 1056`, **not** at 1024. (`count >>> 5 > 1 << shift`
   is false at count 1024 and 1055, true at count 1056.)

8. **The shift 10→15 bump.** Setup: push `0..32799` (`shift==10`, tree full at 32768, tail =
   32768..32799). Op: `push(v, 32800)`. Expect: `shift==15`, `get(i)==i` ∀
   `i∈[0,32801)`. Invariant: same as #6 one level deeper — old root shared under
   `newroot->slots[0]`, all leaves at uniform depth `shift/5 == 3`.

### Update (assoc) — structural sharing

9. **Update into the tail shares the whole tree.** Setup: result of #4 (count 1024). Op:
   `v2 = update(v, 1000, 777)` (1000 is in the tail). Expect: `get(v2,1000)==777`,
   `get(v,1000)==992+8 → original`. Invariant: **`same_ptr(v2->root, v->root)`** (tree fully
   shared); only `tail` differs; `same_ptr(v2->tail, v->tail)` is **false**.

10. **Update into the tree copies exactly one path.** Setup: result of #4. Op:
    `v2 = update(v, 100, 999)` (index 100 → leaf 3, slot 4, in the tree). Expect:
    `get(v2,100)==999`; `get(v,100)==100` (**old untouched**). Invariant: `same_ptr(v2->tail,
    v->tail)` (tail shared); `v2->root != v->root` (new); for the root, **every child slot
    except the one on the path to index 100 is pointer-identical** to `v->root`'s
    (`same_ptr` for all `sub != (100>>5)&31`); recurse down — exactly `shift/5 + 1 == 2` new
    nodes allocated, all siblings shared.

11. **Two independent updates diverge, base intact.** Setup: result of #4. Op:
    `a = update(v, 100, 111)`, `b = update(v, 200, 222)`. Expect: `get(a,100)==111,
    get(a,200)==200`; `get(b,100)==100, get(b,200)==222`; `get(v,100)==100,
    get(v,200)==200`. Invariant: `a` and `b` each share every subtree of `v` not on their
    own path; the leaf holding 100 in `a` and the leaf holding 200 in `b` are distinct new
    nodes while their *sibling* leaves remain `same_ptr` to `v`'s.

12. **Update across the height boundary shares the deep spine.** Setup: result of #6
    (`shift==10`, count 1057). Op: `update(v, 5, 5555)` (deep in the old, now-shared
    subtree). Expect: `get(v2,5)==5555`, old `get(v,5)==5`. Invariant: `v2->root->slots[1]`
    (the `new_path` side) is `same_ptr` to `v`'s; only `slots[0]`'s spine down to index 5's
    leaf is re-copied (`shift/5+1 == 3` new nodes).

### Append sharing (not just correctness)

13. **Append with tail room shares the tree.** Setup: result of #3 (count 33, `shift==5`).
    Op: `v2 = push(v, 33)`. Expect: `count==34`, `get(v2,33)==33`, old `count==33`.
    Invariant: `same_ptr(v2->root, v->root)` (tree wholly shared — the 31/32 fast path); only
    `tail` grows.

14. **Append that promotes a tail shares all but the right spine.** Setup: a vector at
    `count==64` (`shift==5`, two leaves in tree at indices 0..31,32..63? — build to 95 so
    tree=64, tail full=64..95, then this push promotes). Precisely: setup `count==96` state
    isn't needed — build to `count==64` with tail full is `count==64`, tailoff 32… simplest:
    push `0..63` (tree has leaf0 = 0..31, tail = 32..63, `count==64`), then `push(v,64)`
    promotes the tail. Op: `push(v,64)`. Expect: `count==65`, `child_count(root)==2`,
    `get(i)==i` ∀ i. Invariant: the **already-present leaf (0..31) is `same_ptr`** in
    `v2->root` and `v->root` (left sibling shared); only the root node itself is re-cloned to
    hold the new second child; old vector unchanged.

### Pop (inverse + demotion)

15. **Pop from tail (fast path).** Setup: result of #4 (count 1024, tail_len 32). Op:
    `v2 = pop(v)`. Expect: `count==1023`, `shift==5`, `get(v2, 1022)` valid, `get(v2,1023)`
    out of range; old `count==1024` unchanged. Invariant: `same_ptr(v2->root, v->root)` (tree
    shared); only `tail` shortened.

16. **Pop that pulls a leaf back out of the tree.** Setup: result of #3 (count 33, tail_len
    1). Op: `pop(v)` twice → back to count 31. Expect: after first pop `count==32`, the last
    tree leaf becomes the new tail (`tail_len==32`), `root` back toward empty;
    `get(i)==i` ∀ remaining. Invariant: mirror of #3 — `tailoff` drops by 32; new tail is a
    copy of the demoted leaf.

17. **Pop triggers root demotion (shift 10→5, the mirror of #6).** Setup: result of #6/#7
    (`shift==10`, count 1057). Op: `pop` down to `count==1024`. Expect: at the crossing back
    below the 2-child root, **`shift` returns to 5**; `get(i)==i` ∀ `i∈[0,count)` at every
    step. Invariant: when `pop_tail` leaves `newroot->slots[1]==NULL` and `shift>5`, the root
    is replaced by `newroot->slots[0]` and `shift-=5` — assert the demotion fires **exactly**
    at the symmetric count, not one early/late.

18. **push∘pop round-trip identity of values (not of pointers).** Setup: any `v`. Op:
    `pop(push(v, x))`. Expect: resulting vector `get(i)` equals `v`'s for all `i`, and
    `count` equal. Invariant: value-level round-trip holds across every boundary; pointer
    identity is **not** required (persistent ops allocate), but base `v` is untouched.

### Whole-structure invariants (run after any op in the suite)

19. **Uniform leaf depth + dense left-packing.** After any op producing `v`: every path
    root→leaf has length `shift/5`; internal nodes are full (`child_count==32`) except along
    the right spine; `tailoff(v) == count - tail_len` and `1 <= tail_len <= 32` (or the empty
    vector). This is the persistent-vector analogue of the HAMT `popcount(bitmap)==children`
    invariant.

20. **Old-version immutability sweep.** For every test that returns a new `v2` from `v`:
    re-run `get(v,i)` over all `i` and assert unchanged, and assert `v->count`, `v->shift`,
    `v->root`, `v->tail` fields are byte-for-byte what they were pre-op. (Cheap, catches
    accidental in-place mutation — the cardinal persistent-structure bug.)

---

## Part 3 — Model-based property test recipe

Run a random op sequence against a **plain-array reference model** and assert agreement plus
the structural invariants. This is the generator the references insist on, **biased hard to
the danger zones**.

**Model.** `ref` = a growable `int64_t[]` (plain dynamic array). `pv` = the trie under test.
Maintain both; after every op assert `pv->count == ref.len` and `nt_pv_get(pv,i) ==
ref[i]` for all `i` (or a random sample for large sizes).

**Op generator** (weighted):
- `push(x)` — 45%
- `pop()` — 20% (no-op/guard when empty)
- `update(i, x)` for random `i < count` — 25%
- **`persist` (snapshot)** — 10%: stash `(pv, ref-copy)` in a history list, then keep
  mutating the *newer* versions. **After the run, re-verify every stashed snapshot still
  equals its stashed reference** — this is the actual persistence/structural-sharing test
  (old versions must be untouched by later ops).

**Danger-zone biasing** (this is where real trie bugs live — the references are emphatic):
- Seed sizes so the walk repeatedly crosses **31↔32** (tail fill/drain), **1023↔1057**
  (shift 5↔10 bump/demote), and at least once **32767↔32801** (shift 10↔15). E.g. draw the
  target size from a mixture that spikes at `{31,32,33, 1023,1024,1055,1056,1057, 32767,
  32768,32799,32800,32801}`.
- Bias `update` indices toward `{0, count-1, tailoff-1, tailoff}` — the tail/tree seam.
- Include long monotone `push` runs and long `pop` runs (not just random walk) so overflow
  and demotion each fire many times consecutively.

**Structural assertions each step** (beyond value agreement): run invariant #19
(`assert_full`: uniform depth, dense packing, `tailoff` identity) and, on `update`/`push`,
spot-check **sibling pointer identity** against the immediately-prior version (at least one
off-path subtree must be `same_ptr`). On the `persist` snapshots, invariant #20 (old
untouched).

**Shrinking.** On failure, shrink the op sequence (drop ops, then reduce sizes) toward the
minimal reproducer — the shrunk case almost always collapses onto one of the boundary
indices above, which is the point.

---
*(No source files were modified. This is a design + test-vector spec only — the C module and
its harness are the GREEN step that follows.)*
