/*
 * nt_pvec — persistent vector (32-way bit-partitioned trie + tail buffer).
 *
 * See nt_pvec.h and docs/research/B2-vector-trie.md. Standalone module: depends
 * only on libc (like runtime.c), malloc-based, allocate-and-never-free for the
 * pure-persistent phase (a live-node counter is kept for leak/sharing tests).
 * The refcount fields exist to match the B2 step-4 model but are unused here.
 */

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "nt_pvec.h"

/* ---- allocation (never-free; mirrors runtime.c's nativets_alloc style) ---- */

static long g_pv_node_allocs = 0;
static long g_pv_node_frees  = 0;   /* stays 0 in the pure-persistent phase */

static void *pv_alloc(size_t n) {
    void *p = malloc(n);
    if (!p) { fputs("nt_pvec: out of memory\n", stderr); abort(); }
    return p;
}

static nt_pv_node *new_node(int kind) {
    nt_pv_node *n = (nt_pv_node *)pv_alloc(sizeof(nt_pv_node));
    n->refcount = 0;
    n->kind = kind;
    for (int i = 0; i < NT_PV_WIDTH; i++) n->slots[i] = 0;
    g_pv_node_allocs++;
    return n;
}

/* shallow copy of a node's 32 slots (path copying) */
static nt_pv_node *clone_node(nt_pv_node *n) {
    nt_pv_node *r = new_node(n->kind);
    memcpy(r->slots, n->slots, sizeof(r->slots));
    return r;
}

long   nt_pv_node_allocs(void) { return g_pv_node_allocs; }
long   nt_pv_node_frees(void)  { return g_pv_node_frees; }
double nt_pv_node_live(void)   { return (double)(g_pv_node_allocs - g_pv_node_frees); }

/* ---- the shared empty internal node singleton ---- */

static nt_pv_node *g_empty_node = NULL;
nt_pv_node *nt_pv_empty_node(void) {
    if (!g_empty_node) g_empty_node = new_node(0);
    return g_empty_node;
}

/* ---- header helpers ---- */

static nt_pv *mk_header(uint32_t count, uint32_t shift,
                        nt_pv_node *root, nt_pv_node *tail, uint32_t tail_len) {
    nt_pv *v = (nt_pv *)pv_alloc(sizeof(nt_pv));
    v->refcount = 0;
    v->count = count;
    v->shift = shift;
    v->root = root;
    v->tail = tail;
    v->tail_len = tail_len;
    return v;
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
        ret->slots[sub] = (int64_t)(intptr_t)
            do_assoc(level - NT_PV_BITS, (nt_pv_node *)(intptr_t) node->slots[sub], i, val);
    }
    return ret;
}

nt_pv *nt_pv_update(nt_pv *v, uint32_t i, int64_t val) {
    if (i >= v->count) return v;                          /* out of range: no-op */
    if (i >= nt_pv_tailoff(v)) {                          /* in the tail: share the whole tree */
        nt_pv_node *newtail = clone_node(v->tail);
        newtail->slots[i & NT_PV_MASK] = val;
        return mk_header(v->count, v->shift, v->root, newtail, v->tail_len);
    }
    nt_pv_node *newroot = do_assoc(v->shift, v->root, i, val);
    return mk_header(v->count, v->shift, newroot, v->tail, v->tail_len);
}

/* ---- append (push) ---- */

/* a chain of single-child internal nodes down to a promoted leaf */
static nt_pv_node *new_path(uint32_t level, nt_pv_node *node) {
    if (level == 0) return node;
    nt_pv_node *r = new_node(0);
    r->slots[0] = (int64_t)(intptr_t) new_path(level - NT_PV_BITS, node);
    return r;
}

/* copy the rightmost root->leaf path, inserting the promoted tail leaf.
 * `count` is the PRE-push element count. */
static nt_pv_node *push_tail(uint32_t count, uint32_t level,
                             nt_pv_node *parent, nt_pv_node *tailnode) {
    uint32_t sub = ((count - 1) >> level) & NT_PV_MASK;
    nt_pv_node *ret = clone_node(parent);               /* copy this node; siblings shared */
    nt_pv_node *insert;
    if (level == NT_PV_BITS) {
        insert = tailnode;                              /* parent is one above the leaves */
    } else {
        nt_pv_node *child = (nt_pv_node *)(intptr_t) parent->slots[sub];
        insert = child ? push_tail(count, level - NT_PV_BITS, child, tailnode)
                       : new_path(level - NT_PV_BITS, tailnode);
    }
    ret->slots[sub] = (int64_t)(intptr_t) insert;
    return ret;
}

nt_pv *nt_pv_push(nt_pv *v, int64_t val) {
    uint32_t cnt = v->count;

    /* (a) room in the tail? true ~31/32 of the time — O(1) fast path */
    if (cnt - nt_pv_tailoff(v) < NT_PV_WIDTH) {
        nt_pv_node *newtail = clone_node(v->tail);
        newtail->kind = 1;
        newtail->slots[v->tail_len] = val;
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
        newroot->slots[0] = (int64_t)(intptr_t) v->root;                 /* share old root */
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
        ret->slots[sub] = (int64_t)(intptr_t) child;
        return ret;
    } else if (sub == 0) {
        return NULL;
    } else {
        nt_pv_node *ret = clone_node(node);
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
     * (mirror of root overflow). */
    if (v->shift > NT_PV_BITS && newroot->slots[1] == 0) {
        newroot = (nt_pv_node *)(intptr_t) newroot->slots[0];
        newshift -= NT_PV_BITS;
    }

    return mk_header(v->count - 1, newshift, newroot, newtail, NT_PV_WIDTH);
}
