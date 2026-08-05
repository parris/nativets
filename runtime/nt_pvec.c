/*
 * nt_pvec — persistent vector (32-way bit-partitioned trie + tail buffer).
 *
 * See nt_pvec.h and docs/research/B2-vector-trie.md. Standalone module: depends
 * only on libc (like runtime.c), malloc-based.
 *
 * MEMORY: nodes are REFERENCE COUNTED (docs §4.2). A shared node has many owners,
 * so the linear `nt_arr_free` cannot free trie nodes directly — it releases the
 * header, and a node dies exactly when the last version referencing it does.
 * Ownership convention (the thing to keep straight when editing):
 *   - every constructor (new_node / clone_node / do_assoc / push_tail / pop_tail /
 *     new_path) returns an OWNED reference, rc = 1;
 *   - `mk_header` CONSUMES the root and tail references it is given, so a caller
 *     passing an already-shared node (v->root, v->tail) retains it first;
 *   - a slot store transfers ownership; overwriting a slot releases its old value.
 * The EMPTY-node singleton is pinned (retain/release are no-ops on it) and is not
 * counted, so the live-node counter reads 0 at rest. rc is non-atomic (like the
 * string rc): correct for the cooperative scheduler, not for M:N threads.
 */

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "nt_pvec.h"

/* ---- allocation + reference counting ---- */

static long g_pv_node_allocs = 0;
static long g_pv_node_frees  = 0;

static void *pv_alloc(size_t n) {
    void *p = malloc(n);
    if (!p) { fputs("nt_pvec: out of memory\n", stderr); abort(); }
    return p;
}

/* A fresh node is born OWNED (rc = 1) by whoever called for it. */
static nt_pv_node *new_node(int kind) {
    nt_pv_node *n = (nt_pv_node *)pv_alloc(sizeof(nt_pv_node));
    n->refcount = 1;
    n->kind = kind;
    for (int i = 0; i < NT_PV_WIDTH; i++) n->slots[i] = 0;
    g_pv_node_allocs++;
    return n;
}

static nt_pv_node *g_empty_node = NULL;   /* pinned; see release_node/retain_node */

static void retain_node(nt_pv_node *n) {
    if (!n || n == g_empty_node) return;
    n->refcount++;
}

static void release_node(nt_pv_node *n) {
    if (!n || n == g_empty_node) return;
    if (--n->refcount > 0) return;
    /* last owner: an internal node owns its children; a leaf's slots are VALUES
     * (numbers / element pointers the array does not own), so recursion stops. */
    if (n->kind == 0)
        for (int i = 0; i < NT_PV_WIDTH; i++)
            release_node((nt_pv_node *)(intptr_t) n->slots[i]);
    free(n);
    g_pv_node_frees++;
}

/* shallow copy of a node's 32 slots (path copying). The copy becomes a second
 * parent of every child, so an internal node's children are each retained. */
static nt_pv_node *clone_node(nt_pv_node *n) {
    nt_pv_node *r = new_node(n->kind);
    memcpy(r->slots, n->slots, sizeof(r->slots));
    if (n->kind == 0)
        for (int i = 0; i < NT_PV_WIDTH; i++)
            retain_node((nt_pv_node *)(intptr_t) r->slots[i]);
    return r;
}

long   nt_pv_node_allocs(void) { return g_pv_node_allocs; }
long   nt_pv_node_frees(void)  { return g_pv_node_frees; }
double nt_pv_node_live(void)   { return (double)(g_pv_node_allocs - g_pv_node_frees); }

/* ---- the shared empty internal node singleton ---- */

nt_pv_node *nt_pv_empty_node(void) {
    if (!g_empty_node) {
        g_empty_node = new_node(0);
        g_pv_node_allocs--;   /* pinned + never freed: keep it out of the leak counter */
    }
    return g_empty_node;
}

/* ---- header helpers ---- */

/* CONSUMES the `root` and `tail` references. Returns an owned header (rc = 1). */
static nt_pv *mk_header(uint32_t count, uint32_t shift,
                        nt_pv_node *root, nt_pv_node *tail, uint32_t tail_len) {
    nt_pv *v = (nt_pv *)pv_alloc(sizeof(nt_pv));
    v->refcount = 1;
    v->count = count;
    v->shift = shift;
    v->root = root;
    v->tail = tail;
    v->tail_len = tail_len;
    return v;
}

void nt_pv_retain(nt_pv *v) { if (v) v->refcount++; }

void nt_pv_release(nt_pv *v) {
    if (!v) return;
    if (--v->refcount > 0) return;
    release_node(v->root);
    release_node(v->tail);
    free(v);
}

nt_pv *nt_pv_empty(void) {
    return mk_header(0, NT_PV_BITS, nt_pv_empty_node(), new_node(1), 0);
}

/* tailoff = number of elements currently held in the tree (not the tail).
 * Equivalent to count - tail_len; the bit form is used so the tree logic
 * stays independent of tail_len. */
uint32_t nt_pv_tailoff(nt_pv *v) {
    if (v->count < NT_PV_WIDTH) return 0;
    return ((v->count - 1) >> NT_PV_BITS) << NT_PV_BITS;
}

/* ---- lookup ---- */

int64_t *nt_pv_array_for(nt_pv *v, uint32_t i) {
    if (i >= nt_pv_tailoff(v)) return v->tail->slots;   /* the tail short-circuit */
    nt_pv_node *n = v->root;
    for (uint32_t s = v->shift; s > 0; s -= NT_PV_BITS)
        n = (nt_pv_node *)(intptr_t) n->slots[(i >> s) & NT_PV_MASK];
    return n->slots;
}

int64_t nt_pv_get(nt_pv *v, uint32_t i) {
    return nt_pv_array_for(v, i)[i & NT_PV_MASK];
}

/* ---- update (assoc) — path copying ---- */

static nt_pv_node *do_assoc(uint32_t level, nt_pv_node *node, uint32_t i, int64_t val) {
    nt_pv_node *ret = clone_node(node);
    if (level == 0) {
        ret->slots[i & NT_PV_MASK] = val;               /* leaf */
    } else {
        uint32_t sub = (i >> level) & NT_PV_MASK;
        nt_pv_node *sub_new =
            do_assoc(level - NT_PV_BITS, (nt_pv_node *)(intptr_t) node->slots[sub], i, val);
        release_node((nt_pv_node *)(intptr_t) ret->slots[sub]);  /* drop the cloned ref */
        ret->slots[sub] = (int64_t)(intptr_t) sub_new;           /* transfer ownership  */
    }
    return ret;
}

nt_pv *nt_pv_update(nt_pv *v, uint32_t i, int64_t val) {
    if (i >= v->count) { nt_pv_retain(v); return v; }     /* out of range: no-op */
    if (i >= nt_pv_tailoff(v)) {                          /* in the tail: share the whole tree */
        nt_pv_node *newtail = clone_node(v->tail);
        newtail->slots[i & NT_PV_MASK] = val;
        retain_node(v->root);
        return mk_header(v->count, v->shift, v->root, newtail, v->tail_len);
    }
    nt_pv_node *newroot = do_assoc(v->shift, v->root, i, val);
    retain_node(v->tail);
    return mk_header(v->count, v->shift, newroot, v->tail, v->tail_len);
}

/* ---- append (push) ---- */

/* a chain of single-child internal nodes down to a promoted leaf. CONSUMES `node`. */
static nt_pv_node *new_path(uint32_t level, nt_pv_node *node) {
    if (level == 0) return node;
    nt_pv_node *r = new_node(0);
    r->slots[0] = (int64_t)(intptr_t) new_path(level - NT_PV_BITS, node);  /* transfer */
    return r;
}

/* copy the rightmost root->leaf path, inserting the promoted tail leaf.
 * `count` is the PRE-push element count. `tailnode` is BORROWED (retained at the
 * single point where it is installed). */
static nt_pv_node *push_tail(uint32_t count, uint32_t level,
                             nt_pv_node *parent, nt_pv_node *tailnode) {
    uint32_t sub = ((count - 1) >> level) & NT_PV_MASK;
    nt_pv_node *ret = clone_node(parent);               /* copy this node; siblings shared */
    nt_pv_node *insert;
    if (level == NT_PV_BITS) {
        retain_node(tailnode);
        insert = tailnode;                              /* parent is one above the leaves */
    } else {
        nt_pv_node *child = (nt_pv_node *)(intptr_t) parent->slots[sub];
        if (child) {
            insert = push_tail(count, level - NT_PV_BITS, child, tailnode);
        } else {
            retain_node(tailnode);                      /* new_path consumes its argument */
            insert = new_path(level - NT_PV_BITS, tailnode);
        }
    }
    release_node((nt_pv_node *)(intptr_t) ret->slots[sub]);  /* drop the cloned ref */
    ret->slots[sub] = (int64_t)(intptr_t) insert;            /* transfer ownership  */
    return ret;
}

nt_pv *nt_pv_push(nt_pv *v, int64_t val) {
    uint32_t cnt = v->count;

    /* (a) room in the tail? true ~31/32 of the time — O(1) fast path */
    if (cnt - nt_pv_tailoff(v) < NT_PV_WIDTH) {
        nt_pv_node *newtail = clone_node(v->tail);
        newtail->kind = 1;
        newtail->slots[v->tail_len] = val;
        retain_node(v->root);
        return mk_header(cnt + 1, v->shift, v->root, newtail, v->tail_len + 1);
    }

    /* (b) tail is full (32) -> promote it into the tree as a leaf */
    nt_pv_node *tailnode = v->tail;
    nt_pv_node *newroot;
    uint32_t newshift = v->shift;

    /* (c) ROOT OVERFLOW? the exact Clojure condition. Delayed past the round
     * power of 32: with tree capacity C, this fires at count == C + 32. */
    if ((cnt >> NT_PV_BITS) > (1u << v->shift)) {
        newroot = new_node(0);
        retain_node(v->root);
        newroot->slots[0] = (int64_t)(intptr_t) v->root;                 /* share old root */
        retain_node(tailnode);                                           /* new_path consumes */
        newroot->slots[1] = (int64_t)(intptr_t) new_path(v->shift, tailnode);
        newshift = v->shift + NT_PV_BITS;                                /* height + 1 */
    } else {
        newroot = push_tail(cnt, v->shift, v->root, tailnode);
    }

    nt_pv_node *newtail = new_node(1);
    newtail->slots[0] = val;
    return mk_header(cnt + 1, newshift, newroot, newtail, 1);
}

/* ---- pop — the inverse of push ---- */

/* `count` is the PRE-pop element count. Returns the copied node, or NULL if the
 * subtree became empty (so the parent should drop the child). */
static nt_pv_node *pop_tail(uint32_t count, uint32_t level, nt_pv_node *node) {
    uint32_t sub = ((count - 2) >> level) & NT_PV_MASK;
    if (level > NT_PV_BITS) {
        nt_pv_node *child = pop_tail(count, level - NT_PV_BITS,
                                     (nt_pv_node *)(intptr_t) node->slots[sub]);
        if (child == NULL && sub == 0) return NULL;
        nt_pv_node *ret = clone_node(node);
        release_node((nt_pv_node *)(intptr_t) ret->slots[sub]);
        ret->slots[sub] = (int64_t)(intptr_t) child;   /* transfer (may be NULL) */
        return ret;
    } else if (sub == 0) {
        return NULL;
    } else {
        nt_pv_node *ret = clone_node(node);
        release_node((nt_pv_node *)(intptr_t) ret->slots[sub]);
        ret->slots[sub] = 0;
        return ret;
    }
}

nt_pv *nt_pv_pop(nt_pv *v) {
    if (v->count == 0) { fputs("nt_pvec: pop of empty vector\n", stderr); abort(); }
    if (v->count == 1) return nt_pv_empty();

    /* >1 element in the tail: just shrink the tail, share the whole tree */
    if (v->count - nt_pv_tailoff(v) > 1) {
        nt_pv_node *newtail = clone_node(v->tail);
        retain_node(v->root);
        return mk_header(v->count - 1, v->shift, v->root, newtail, v->tail_len - 1);
    }

    /* exactly 1 element in the tail: the last tree leaf becomes the new tail */
    int64_t *last_leaf = nt_pv_array_for(v, v->count - 2);
    nt_pv_node *newtail = new_node(1);
    memcpy(newtail->slots, last_leaf, sizeof(newtail->slots));

    nt_pv_node *newroot = pop_tail(v->count, v->shift, v->root);
    uint32_t newshift = v->shift;
    if (newroot == NULL) newroot = nt_pv_empty_node();

    /* ROOT DEMOTION: height shrinks when the new root has a single child
     * (mirror of root overflow). We take an owning ref on the surviving child
     * BEFORE dropping the node above it, so it is never transiently unreferenced. */
    if (v->shift > NT_PV_BITS && newroot->slots[1] == 0) {
        nt_pv_node *inner = (nt_pv_node *)(intptr_t) newroot->slots[0];
        retain_node(inner);
        release_node(newroot);
        newroot = inner;
        newshift -= NT_PV_BITS;
    }

    return mk_header(v->count - 1, newshift, newroot, newtail, NT_PV_WIDTH);
}

/* ---- bulk build ("freeze" a flat block) ----
 *
 * The vector under construction is exclusively ours and has never been published,
 * so its tail — always a node WE just allocated (nt_pv_empty / the fresh tail
 * nt_pv_push installs) — can be filled IN PLACE. That is Clojure's transient
 * trick: no per-element tail clone, so the whole build costs ~n/32 leaves plus
 * the internal spine instead of n node copies. Nothing shared is ever touched.
 */
nt_pv *nt_pv_from_slots(const int64_t *src, uint32_t n) {
    nt_pv *v = nt_pv_empty();
    uint32_t i = 0;
    while (i < n) {
        while (i < n && v->tail_len < NT_PV_WIDTH) {
            v->tail->slots[v->tail_len++] = src[i++];
            v->count++;
        }
        if (i < n) {                       /* tail full: promote it, start a new one */
            nt_pv *nv = nt_pv_push(v, src[i++]);
            nt_pv_release(v);
            v = nv;
        }
    }
    return v;
}
