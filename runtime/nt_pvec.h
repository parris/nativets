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

/* ---- core ops (all persistent: return a new header, never mutate the input) ---- */
int64_t*    nt_pv_array_for(nt_pv* v, uint32_t i);  /* leaf slot array for index i */
int64_t     nt_pv_get(nt_pv* v, uint32_t i);
nt_pv*      nt_pv_update(nt_pv* v, uint32_t i, int64_t val);
nt_pv*      nt_pv_push(nt_pv* v, int64_t val);
nt_pv*      nt_pv_pop(nt_pv* v);

/* ---- test/introspection helpers ---- */
uint32_t    nt_pv_tailoff(nt_pv* v);       /* # elements currently in the tree */
nt_pv_node* nt_pv_empty_node(void);        /* the shared all-NULL empty internal node */
long        nt_pv_node_allocs(void);        /* total nodes allocated (sharing witness) */
long        nt_pv_node_frees(void);         /* total nodes freed (0 in persistent phase) */
double      nt_pv_node_live(void);          /* allocs - frees */

#endif /* NT_PVEC_H */
