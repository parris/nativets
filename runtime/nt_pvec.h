/*
 * nt_pvec — persistent vector (32-way bit-partitioned trie + tail buffer),
 * modeled on Clojure's clojure.lang.PersistentVector.
 *
 * Design + red-green test vectors: docs/research/B2-vector-trie.md.
 *
 * Contract (matches nativets' nt_arr convention): every slot is an int64_t,
 * whether it holds a child-node pointer (internal node) or a value (leaf).
 * Codegen bitcasts number<->i64 and ptr<->i64 through the slots, so one
 * implementation backs number[]/string[]/object[] alike, above the flat-array
 * threshold. Nothing is ever mutated in place; updates copy only the
 * root->leaf path (path copying) and share every untouched sibling by pointer.
 *
 * This header intentionally exposes the node/vector layout and a few internal
 * accessors (tailoff, empty-node singleton, node-alloc counter) so the C-level
 * unit tests can assert the structural-sharing invariants directly.
 */
#ifndef NT_PVEC_H
#define NT_PVEC_H

#include <stdint.h>

#define NT_PV_BITS   5
#define NT_PV_WIDTH  32          /* 1 << NT_PV_BITS */
#define NT_PV_MASK   31          /* NT_PV_WIDTH - 1 */

/* flat->trie switch point (docs/research/B2-vector-trie.md §1.8, §4.1): at or below
 * 32 elements the persistent representation IS a flat 32-slot tail, so a flat copy
 * is never worse; past it the trie's path copying wins. runtime.c reads this. */
#define NT_PV_THRESHOLD 32

typedef struct nt_pv_node {
    int32_t  refcount;           /* structural sharing / rc bookkeeping (tests read it) */
    int32_t  kind;               /* 0 = internal (slots are nt_pv_node*), 1 = leaf (values) */
    int64_t  slots[NT_PV_WIDTH]; /* children OR values; unused slots are 0/NULL */
} nt_pv_node;

typedef struct nt_pv {
    int32_t      refcount;
    uint32_t     count;          /* total element count */
    uint32_t     shift;          /* = 5 * (levels of internal nodes); root-level shift */
    nt_pv_node*  root;           /* trie root (may be a shared node) */
    nt_pv_node*  tail;           /* rightmost leaf buffer */
    uint32_t     tail_len;       /* live element count in tail, 0..32 */
} nt_pv;

/* ---- construction ---- */
nt_pv*      nt_pv_empty(void);
/* Bulk build from a flat slot block ("freeze"): O(n) once, ~n/32 nodes. Uses the
 * transient trick internally (the vector under construction is exclusively owned,
 * so its fresh tail is filled in place) — never touches a published node. */
nt_pv*      nt_pv_from_slots(const int64_t* src, uint32_t n);

/* ---- reference counting (B2 step 4 / the linear-drop bridge) ----
 * Every op below returns an OWNED header (rc = 1). Release it when the owning
 * NtArray is dropped; nodes reachable from another live version survive, a
 * version's private path nodes are freed immediately. See docs §4.2. */
void        nt_pv_retain(nt_pv* v);
void        nt_pv_release(nt_pv* v);

/* ---- core ops (all persistent: return a new header, never mutate the input) ---- */
int64_t*    nt_pv_array_for(nt_pv* v, uint32_t i);  /* leaf slot array for index i */
int64_t     nt_pv_get(nt_pv* v, uint32_t i);
nt_pv*      nt_pv_update(nt_pv* v, uint32_t i, int64_t val);
nt_pv*      nt_pv_push(nt_pv* v, int64_t val);
nt_pv*      nt_pv_pop(nt_pv* v);

/* ---- TRANSIENT append (B2 step 4) ----
 * CONSUMES the caller's owned reference and returns an owned reference to the
 * result. When the vector is UNIQUELY owned (header rc == 1 AND its tail leaf
 * rc == 1) no other version can observe its storage, so the element is written
 * into the tail IN PLACE — Clojure's transient trick, made provable here by the
 * linear ownership model. Otherwise it falls back to the persistent push and
 * releases the old reference, so the result is identical either way. */
nt_pv*      nt_pv_push_own(nt_pv* v, int64_t val);
long        nt_pv_transient_hits(void);   /* # in-place appends (test witness) */

/* ---- test/introspection helpers ---- */
uint32_t    nt_pv_tailoff(nt_pv* v);       /* # elements currently in the tree */
nt_pv_node* nt_pv_empty_node(void);        /* the shared all-NULL empty internal node */
long        nt_pv_node_allocs(void);        /* total nodes allocated (sharing witness) */
long        nt_pv_node_frees(void);         /* total nodes freed (0 in persistent phase) */
double      nt_pv_node_live(void);          /* allocs - frees */

#endif /* NT_PVEC_H */
