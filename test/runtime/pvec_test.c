/*
 * pvec_test — standalone C unit tests for runtime/nt_pvec.c (persistent vector).
 *
 * Drives the C module directly (build a nt_pv, call ops, assert on the returned
 * structure), NOT through node — the differential-vs-node oracle only applies
 * once the trie is behind array codegen. Implements the 20 ordered vectors from
 * docs/research/B2-vector-trie.md plus the model-based property test.
 *
 * Build & run:
 *   clang -O0 -g test/runtime/pvec_test.c runtime/nt_pvec.c -o /tmp/pvec_test \
 *     && /tmp/pvec_test
 * main() returns nonzero if any check fails; prints PASS/FAIL per vector.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "../../runtime/nt_pvec.h"

/* ============================================================
 * tiny assert harness
 * ============================================================ */

static int g_fail = 0;
static int g_checks = 0;

#define CHECK(cond) do {                                            \
    g_checks++;                                                     \
    if (!(cond)) {                                                  \
        g_fail++;                                                   \
        printf("    FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);  \
    }                                                              \
} while (0)

/* ============================================================
 * structural-sharing invariant helpers (implemented first)
 * ============================================================ */

static int same_ptr(const void *a, const void *b) { return a == b; }

/* number of non-NULL slots — the analogue of a HAMT popcount */
static int child_count(nt_pv_node *n) {
    int c = 0;
    for (int i = 0; i < NT_PV_WIDTH; i++) if (n->slots[i] != 0) c++;
    return c;
}

/* every root->leaf path has length shift/5; internal nodes are dense
 * left-packed (non-NULL slots contiguous from 0); leaves are kind==1. */
static int check_dense_depth(nt_pv_node *n, uint32_t level) {
    if (level == 0) return n->kind == 1;          /* must be a leaf here */
    if (n->kind != 0) return 0;                   /* must be internal here */
    int cc = child_count(n);
    for (int i = 0; i < NT_PV_WIDTH; i++) {
        int nonnull = n->slots[i] != 0;
        if (i < cc && !nonnull) return 0;         /* gap before the end -> not dense */
        if (i >= cc && nonnull) return 0;         /* something past the packed run */
    }
    for (int i = 0; i < cc; i++)
        if (!check_dense_depth((nt_pv_node *)(intptr_t) n->slots[i], level - NT_PV_BITS))
            return 0;
    return 1;
}

/* whole-structure invariant #19: uniform leaf depth, dense packing,
 * tailoff identity, tail_len bounds. */
static int assert_full(nt_pv *v) {
    if (nt_pv_tailoff(v) != v->count - v->tail_len) return 0;
    if (v->count == 0) return v->tail_len == 0;
    if (v->tail_len < 1 || v->tail_len > NT_PV_WIDTH) return 0;
    return check_dense_depth(v->root, v->shift);
}

/* snapshot of a header for the old-version-immutability sweep (#20) */
typedef struct { uint32_t count, shift, tail_len; nt_pv_node *root, *tail; } snap_t;
static snap_t snapshot(nt_pv *v) {
    snap_t s = { v->count, v->shift, v->tail_len, v->root, v->tail };
    return s;
}
/* re-check every get(i) unchanged and header fields byte-identical to the snap */
static void check_unchanged(nt_pv *v, snap_t s) {
    CHECK(v->count == s.count);
    CHECK(v->shift == s.shift);
    CHECK(v->tail_len == s.tail_len);
    CHECK(same_ptr(v->root, s.root));
    CHECK(same_ptr(v->tail, s.tail));
    for (uint32_t i = 0; i < v->count; i++) CHECK(nt_pv_get(v, i) == (int64_t) i);
}

/* build a vector holding 0..n-1 via repeated push */
static nt_pv *build(uint32_t n) {
    nt_pv *v = nt_pv_empty();
    for (uint32_t i = 0; i < n; i++) v = nt_pv_push(v, (int64_t) i);
    return v;
}
static void check_range(nt_pv *v, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) CHECK(nt_pv_get(v, i) == (int64_t) i);
}

/* per-vector runner bookkeeping */
static int g_vec_fail_before;
static void begin(const char *name) { printf("vector: %s\n", name); g_vec_fail_before = g_fail; }
static void end(void) { printf("  [%s]\n", g_fail == g_vec_fail_before ? "PASS" : "FAIL"); }

/* ============================================================
 * the 20 ordered vectors
 * ============================================================ */

/* 1. Empty + first element. */
static void v01_empty_first(void) {
    begin("01 empty + first element");
    nt_pv *e = nt_pv_empty();
    nt_pv *v = nt_pv_push(e, 10);
    CHECK(v->count == 1);
    CHECK(v->shift == 5);
    CHECK(v->tail_len == 1);
    CHECK(nt_pv_get(v, 0) == 10);
    /* root is the *shared* empty node — no tree allocated yet */
    CHECK(same_ptr(v->root, nt_pv_empty_node()));
    CHECK(assert_full(v));
    end();
}

/* 2. Fill the tail exactly (the 31->32 danger zone) — still tail-only at 32. */
static void v02_fill_tail(void) {
    begin("02 fill tail exactly to 32 (flat/trie boundary)");
    nt_pv *v = build(32);
    CHECK(v->count == 32);
    CHECK(v->tail_len == 32);
    CHECK(v->shift == 5);
    CHECK(nt_pv_tailoff(v) == 0);
    CHECK(same_ptr(v->root, nt_pv_empty_node()));   /* tree still empty at exactly 32 */
    check_range(v, 32);
    CHECK(assert_full(v));
    end();
}

/* 3. First tail->tree promotion (index 32). */
static void v03_first_promotion(void) {
    begin("03 first tail->tree promotion (index 32)");
    nt_pv *v0 = build(32);
    nt_pv_node *old_tail = v0->tail;
    nt_pv *v = nt_pv_push(v0, 32);
    CHECK(v->count == 33);
    CHECK(v->shift == 5);
    CHECK(nt_pv_tailoff(v) == 32);
    CHECK(v->tail_len == 1);
    CHECK(nt_pv_get(v, 32) == 32);
    check_range(v, 33);
    /* root now has exactly one child: the leaf holding 0..31 (old tail re-homed) */
    CHECK(child_count(v->root) == 1);
    CHECK(same_ptr((nt_pv_node *)(intptr_t) v->root->slots[0], old_tail));
    CHECK(!same_ptr(v->root, nt_pv_empty_node()));  /* root is a fresh internal node */
    CHECK(!same_ptr(v->tail, old_tail));             /* tail is a fresh 1-slot leaf */
    CHECK(assert_full(v));
    end();
}

/* 4. Build N and get every index — small trie (fills tree exactly at 1024). */
static void v04_build_1024(void) {
    begin("04 build 1024, get every index");
    nt_pv *v = build(1024);
    CHECK(v->count == 1024);
    CHECK(v->shift == 5);
    CHECK(nt_pv_tailoff(v) == 992);
    CHECK(v->tail_len == 32);
    CHECK(child_count(v->root) == 31);        /* 31 leaves in the tree, tail holds the 32nd */
    check_range(v, 1024);
    CHECK(assert_full(v));
    end();
}

/* 5. Get spot-checks across all three leaf regions (tail short-circuit). */
static void v05_spot_checks(void) {
    begin("05 get spot-checks across leaf regions");
    nt_pv *v = build(1024);
    uint32_t idx[] = { 0, 31, 32, 63, 991, 992, 1023 };
    for (int k = 0; k < 7; k++) CHECK(nt_pv_get(v, idx[k]) == (int64_t) idx[k]);
    /* 992 and 1023 hit the i>=tailoff tail branch; the rest hit the tree */
    CHECK(992 >= nt_pv_tailoff(v));
    CHECK(991 < nt_pv_tailoff(v));
    end();
}

/* 6. The shift 5->10 bump (the 1024/1056 delayed-overflow danger zone). */
static void v06_bump_5_to_10(void) {
    begin("06 shift 5->10 bump at append index 1056");
    nt_pv *v = build(1056);              /* count 1056, still shift 5, tail = 1024..1055 */
    CHECK(v->shift == 5);
    CHECK(nt_pv_tailoff(v) == 1024);
    nt_pv_node *old_root = v->root;
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_push(v, 1056);
    CHECK(v2->count == 1057);
    CHECK(v2->shift == 10);
    check_range(v2, 1057);
    /* new root: 2 children; slots[0] is the pointer-identical old root (shared) */
    CHECK(child_count(v2->root) == 2);
    CHECK(same_ptr((nt_pv_node *)(intptr_t) v2->root->slots[0], old_root));
    /* slots[1] is a fresh single-child new_path chain down to the promoted leaf */
    nt_pv_node *side = (nt_pv_node *)(intptr_t) v2->root->slots[1];
    CHECK(child_count(side) == 1);
    CHECK(assert_full(v2));
    check_unchanged(v, s);              /* old vector unchanged */
    end();
}

/* 7. Off-by-one around the bump — pins the *delayed* overflow at C+32. */
static void v07_off_by_one(void) {
    begin("07 delayed overflow: shift flips only at count 1057");
    nt_pv *v1055 = build(1055);
    CHECK(v1055->shift == 5);
    nt_pv *v1056 = nt_pv_push(v1055, 1055);
    CHECK(v1056->count == 1056);
    CHECK(v1056->shift == 5);            /* still 5 at 1056, NOT bumped at 1024 */
    nt_pv *v1057 = nt_pv_push(v1056, 1056);
    CHECK(v1057->count == 1057);
    CHECK(v1057->shift == 10);           /* flips only when index 1056 lands */
    end();
}

/* 8. The shift 10->15 bump (one level deeper; delayed overflow at 32800). */
static void v08_bump_10_to_15(void) {
    begin("08 shift 10->15 bump at append index 32800");
    nt_pv *v = build(32800);            /* shift 10, tree full at 32768, tail = 32768..32799 */
    CHECK(v->shift == 10);
    CHECK(nt_pv_tailoff(v) == 32768);
    nt_pv_node *old_root = v->root;
    nt_pv *v2 = nt_pv_push(v, 32800);
    CHECK(v2->count == 32801);
    CHECK(v2->shift == 15);
    check_range(v2, 32801);
    CHECK(child_count(v2->root) == 2);
    CHECK(same_ptr((nt_pv_node *)(intptr_t) v2->root->slots[0], old_root)); /* old root shared */
    CHECK(assert_full(v2));             /* all leaves at uniform depth shift/5 == 3 */
    end();
}

/* 9. Update into the tail shares the whole tree. */
static void v09_update_tail(void) {
    begin("09 update into tail shares the tree");
    nt_pv *v = build(1024);
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_update(v, 1000, 777);   /* 1000 is in the tail (tailoff 992) */
    CHECK(nt_pv_get(v2, 1000) == 777);
    CHECK(nt_pv_get(v, 1000) == 1000);        /* old untouched */
    CHECK(same_ptr(v2->root, v->root));       /* tree fully shared */
    CHECK(!same_ptr(v2->tail, v->tail));      /* only the tail differs */
    CHECK(assert_full(v2));
    check_unchanged(v, s);
    end();
}

/* 10. Update into the tree copies exactly one path; siblings shared. */
static void v10_update_tree(void) {
    begin("10 update into tree copies one path");
    nt_pv *v = build(1024);
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_update(v, 100, 999);    /* index 100 -> leaf (100>>5)=3, slot 4 */
    CHECK(nt_pv_get(v2, 100) == 999);
    CHECK(nt_pv_get(v, 100) == 100);          /* old untouched */
    CHECK(same_ptr(v2->tail, v->tail));       /* tail shared */
    CHECK(!same_ptr(v2->root, v->root));      /* root re-copied */
    uint32_t path = (100 >> 5) & 31;          /* == 3 */
    for (uint32_t sub = 0; sub < NT_PV_WIDTH; sub++) {
        if (v->root->slots[sub] == 0) continue;
        if (sub == path)
            CHECK(!same_ptr((void *)(intptr_t) v2->root->slots[sub],
                            (void *)(intptr_t) v->root->slots[sub]));  /* on-path: new */
        else
            CHECK(same_ptr((void *)(intptr_t) v2->root->slots[sub],
                           (void *)(intptr_t) v->root->slots[sub]));    /* off-path: shared */
    }
    CHECK(assert_full(v2));
    check_unchanged(v, s);
    end();
}

/* 11. Two independent updates diverge, base intact. */
static void v11_two_updates(void) {
    begin("11 two independent updates diverge, base intact");
    nt_pv *v = build(1024);
    nt_pv *a = nt_pv_update(v, 100, 111);
    nt_pv *b = nt_pv_update(v, 200, 222);
    CHECK(nt_pv_get(a, 100) == 111);
    CHECK(nt_pv_get(a, 200) == 200);
    CHECK(nt_pv_get(b, 100) == 100);
    CHECK(nt_pv_get(b, 200) == 222);
    CHECK(nt_pv_get(v, 100) == 100);
    CHECK(nt_pv_get(v, 200) == 200);
    /* a's leaf for 100 differs from v's; a's leaf for 200 stays same_ptr to v's */
    uint32_t leaf100 = (100 >> 5) & 31, leaf200 = (200 >> 5) & 31;
    CHECK(!same_ptr((void *)(intptr_t) a->root->slots[leaf100],
                    (void *)(intptr_t) v->root->slots[leaf100]));
    CHECK(same_ptr((void *)(intptr_t) a->root->slots[leaf200],
                   (void *)(intptr_t) v->root->slots[leaf200]));
    CHECK(assert_full(a));
    CHECK(assert_full(b));
    end();
}

/* 12. Update across the height boundary shares the deep spine. */
static void v12_update_deep(void) {
    begin("12 update across height boundary shares deep spine");
    nt_pv *v = nt_pv_push(build(1056), 1056);  /* result of #6: shift 10, count 1057 */
    CHECK(v->shift == 10);
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_update(v, 5, 5555);       /* deep in the old, now-shared subtree */
    CHECK(nt_pv_get(v2, 5) == 5555);
    CHECK(nt_pv_get(v, 5) == 5);
    /* slots[1] (the new_path side) is shared; only slots[0]'s spine is re-copied */
    CHECK(same_ptr((void *)(intptr_t) v2->root->slots[1],
                   (void *)(intptr_t) v->root->slots[1]));
    CHECK(!same_ptr((void *)(intptr_t) v2->root->slots[0],
                    (void *)(intptr_t) v->root->slots[0]));
    CHECK(assert_full(v2));
    check_unchanged(v, s);
    end();
}

/* 13. Append with tail room shares the tree (the 31/32 fast path). */
static void v13_append_tail_room(void) {
    begin("13 append with tail room shares the tree");
    nt_pv *v = nt_pv_push(build(32), 32);      /* result of #3: count 33, shift 5 */
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_push(v, 33);
    CHECK(v2->count == 34);
    CHECK(nt_pv_get(v2, 33) == 33);
    CHECK(v->count == 33);                     /* old unchanged */
    CHECK(same_ptr(v2->root, v->root));        /* tree wholly shared */
    CHECK(!same_ptr(v2->tail, v->tail));       /* only the tail grew */
    CHECK(assert_full(v2));
    check_unchanged(v, s);
    end();
}

/* 14. Append that promotes a tail shares all but the right spine. */
static void v14_append_promote_sharing(void) {
    begin("14 append promoting tail shares left sibling");
    nt_pv *v = build(64);                      /* tree leaf0 = 0..31, tail = 32..63 */
    CHECK(v->count == 64);
    nt_pv_node *leaf0 = (nt_pv_node *)(intptr_t) v->root->slots[0];
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_push(v, 64);             /* promotes the full tail into the tree */
    CHECK(v2->count == 65);
    CHECK(child_count(v2->root) == 2);
    check_range(v2, 65);
    /* the already-present leaf (0..31) is shared; root is re-cloned for the 2nd child */
    CHECK(same_ptr((nt_pv_node *)(intptr_t) v2->root->slots[0], leaf0));
    CHECK(!same_ptr(v2->root, v->root));
    CHECK(assert_full(v2));
    check_unchanged(v, s);
    end();
}

/* 15. Pop from tail (fast path). */
static void v15_pop_tail(void) {
    begin("15 pop from tail (fast path)");
    nt_pv *v = build(1024);
    snap_t s = snapshot(v);
    nt_pv *v2 = nt_pv_pop(v);
    CHECK(v2->count == 1023);
    CHECK(v2->shift == 5);
    CHECK(nt_pv_get(v2, 1022) == 1022);
    CHECK(same_ptr(v2->root, v->root));       /* tree shared; only tail shortened */
    CHECK(v2->tail_len == 31);
    check_range(v2, 1023);
    CHECK(assert_full(v2));
    check_unchanged(v, s);                     /* old count 1024 unchanged */
    end();
}

/* 16. Pop that pulls a leaf back out of the tree (mirror of #3). */
static void v16_pop_pull_leaf(void) {
    begin("16 pop pulls a leaf back out of the tree");
    nt_pv *v = nt_pv_push(build(32), 32);      /* result of #3: count 33, tail_len 1 */
    nt_pv *v2 = nt_pv_pop(v);
    CHECK(v2->count == 32);
    CHECK(v2->tail_len == 32);                  /* the last tree leaf became the new tail */
    CHECK(nt_pv_tailoff(v2) == 0);             /* tailoff dropped by 32 */
    CHECK(same_ptr(v2->root, nt_pv_empty_node()));
    check_range(v2, 32);
    CHECK(assert_full(v2));
    nt_pv *v3 = nt_pv_pop(v2);
    CHECK(v3->count == 31);
    check_range(v3, 31);
    CHECK(assert_full(v3));
    end();
}

/* 17. Pop triggers root demotion (shift 10->5, the mirror of #6). */
static void v17_pop_demotion(void) {
    begin("17 pop triggers root demotion (shift 10->5)");
    nt_pv *v = nt_pv_push(build(1056), 1056);  /* shift 10, count 1057 */
    CHECK(v->shift == 10);
    /* pop down to 1024, checking demotion fires exactly at the crossing */
    for (uint32_t c = 1057; c > 1024; c--) {
        CHECK(v->count == c);
        for (uint32_t i = 0; i < c; i++) CHECK(nt_pv_get(v, i) == (int64_t) i);
        CHECK(v->shift == (c >= 1057 ? 10u : 5u));   /* demotes at the 1057->1056 step */
        CHECK(assert_full(v));
        v = nt_pv_pop(v);
    }
    CHECK(v->count == 1024);
    CHECK(v->shift == 5);
    check_range(v, 1024);
    CHECK(assert_full(v));
    end();
}

/* 18. push o pop round-trip identity of values (not of pointers). */
static void v18_roundtrip(void) {
    begin("18 push o pop round-trip value identity");
    uint32_t sizes[] = { 0, 1, 31, 32, 33, 63, 64, 1023, 1024, 1055, 1056, 1057 };
    for (int k = 0; k < 12; k++) {
        uint32_t n = sizes[k];
        nt_pv *v = build(n);
        snap_t s = snapshot(v);
        nt_pv *rt = nt_pv_pop(nt_pv_push(v, 999999));
        CHECK(rt->count == n);
        for (uint32_t i = 0; i < n; i++) CHECK(nt_pv_get(rt, i) == (int64_t) i);
        CHECK(assert_full(rt));
        check_unchanged(v, s);                 /* base untouched */
    }
    end();
}

/* Stronger structural check for #19: interior internal nodes are FULL
 * (child_count == 32); only the right spine may be partial. Leaves (level 0)
 * are not inspected — element value 0 is legal and would look "NULL". */
static int check_spine(nt_pv_node *n, uint32_t level, int rightmost) {
    if (level == 0) return n->kind == 1;
    if (n->kind != 0) return 0;
    int cc = child_count(n);
    if (cc < 1) return 0;
    if (!rightmost && cc != NT_PV_WIDTH) return 0;   /* interior nodes must be full */
    for (int i = 0; i < cc; i++) {
        int child_right = rightmost && (i == cc - 1);
        if (!check_spine((nt_pv_node *)(intptr_t) n->slots[i], level - NT_PV_BITS, child_right))
            return 0;
    }
    return 1;
}

/* 19. Uniform leaf depth + dense left-packing across boundary sizes. */
static void v19_uniform_depth(void) {
    begin("19 uniform leaf depth + dense left-packing");
    uint32_t sizes[] = { 0, 1, 31, 32, 33, 64, 100, 1023, 1024, 1055, 1056, 1057, 32800, 32801 };
    for (int k = 0; k < 14; k++) {
        uint32_t n = sizes[k];
        nt_pv *v = build(n);
        CHECK(assert_full(v));                       /* depth + dense + tailoff identity */
        CHECK(nt_pv_tailoff(v) == v->count - v->tail_len);
        if (n == 0) CHECK(v->tail_len == 0);
        else CHECK(v->tail_len >= 1 && v->tail_len <= NT_PV_WIDTH);
        if (n > NT_PV_WIDTH) CHECK(check_spine(v->root, v->shift, 1)); /* tree present */
    }
    end();
}

/* 20. Old-version immutability sweep: many later ops never touch old versions. */
static void v20_immutability_sweep(void) {
    begin("20 old-version immutability sweep");
    nt_pv *base = build(1057);                        /* shift 10 */
    snap_t sb = snapshot(base);
    /* stash snapshots as we mutate forward */
    nt_pv *a = nt_pv_update(base, 5, -1);
    snap_t sa = snapshot(a);
    nt_pv *b = nt_pv_push(a, 2000);
    snap_t sbb = snapshot(b);
    nt_pv *c = nt_pv_pop(nt_pv_pop(b));
    nt_pv *d = nt_pv_update(c, 1000, -2);
    (void) d;
    /* every earlier version must be byte-for-byte what it was, values intact */
    check_unchanged(base, sb);
    CHECK(a->count == sa.count && a->shift == sa.shift);
    CHECK(same_ptr(a->root, sa.root) && same_ptr(a->tail, sa.tail));
    CHECK(nt_pv_get(a, 5) == -1);
    CHECK(b->count == sbb.count && same_ptr(b->root, sbb.root) && same_ptr(b->tail, sbb.tail));
    CHECK(b->count == 1058 && nt_pv_get(b, 1057) == 2000);  /* appended at index 1057 */
    /* base still reads its original values everywhere */
    for (uint32_t i = 0; i < base->count; i++) CHECK(nt_pv_get(base, i) == (int64_t) i);
    end();
}

/* ============================================================
 * Part 3 — model-based property test vs a plain-array reference,
 * biased hard to the danger zones. Checks value agreement + the
 * structural invariants each step, and old-snapshot persistence at end.
 * ============================================================ */

typedef struct { int64_t *a; uint32_t len, cap; } Ref;
static void ref_push(Ref *r, int64_t x) {
    if (r->len == r->cap) { r->cap = r->cap ? r->cap * 2 : 8;
        r->a = (int64_t *)realloc(r->a, r->cap * sizeof(int64_t)); }
    r->a[r->len++] = x;
}
static Ref ref_copy(Ref *r) {
    Ref c = { NULL, r->len, r->len ? r->len : 1 };
    c.a = (int64_t *)malloc(c.cap * sizeof(int64_t));
    memcpy(c.a, r->a, r->len * sizeof(int64_t));
    return c;
}
/* verify pv against ref: full compare (used at end / on snapshots) */
static int pv_eq_ref_full(nt_pv *v, Ref *r) {
    if (v->count != r->len) return 0;
    for (uint32_t i = 0; i < r->len; i++) if (nt_pv_get(v, i) != r->a[i]) return 0;
    return 1;
}
/* per-step sampled compare: boundaries + a few random indices */
static int pv_eq_ref_sample(nt_pv *v, Ref *r) {
    if (v->count != r->len) return 0;
    if (r->len == 0) return 1;
    uint32_t to = nt_pv_tailoff(v);
    uint32_t probes[6] = { 0, r->len - 1, to ? to - 1 : 0, to < r->len ? to : r->len - 1,
                           (uint32_t)(rand() % r->len), (uint32_t)(rand() % r->len) };
    for (int k = 0; k < 6; k++) if (nt_pv_get(v, probes[k]) != r->a[probes[k]]) return 0;
    return 1;
}

static void v21_property(void) {
    begin("21 model-based property test (danger-zone biased)");
    srand(0xC0FFEE);
    const uint32_t spikes[] = { 31,32,33, 1023,1024,1055,1056,1057, 32767,32768,32799,32800,32801 };
    const int NSPIKE = (int)(sizeof(spikes) / sizeof(spikes[0]));

    Ref ref = { NULL, 0, 0 };
    nt_pv *v = nt_pv_empty();

    /* snapshot history for the persistence check */
    struct { nt_pv *v; Ref ref; } hist[64];
    int nhist = 0;

    uint32_t target = 33;
    const int ITERS = 60000;
    for (int step = 0; step < ITERS; step++) {
        if (step % 37 == 0) {
            if (rand() % 100 < 70) {
                int32_t base = (int32_t) spikes[rand() % NSPIKE];
                int32_t jit = (rand() % 5) - 2;
                target = (uint32_t)(base + jit < 0 ? 0 : base + jit);
            } else target = (uint32_t)(rand() % 2100);
        }

        int op;
        if (rand() % 2 == 0) {                 /* steer toward target -> guarantees crossings */
            op = (v->count < target) ? 0 : (v->count > target ? 1 : 2);
        } else {                               /* weighted: push45 pop20 update25 persist10 */
            int r = rand() % 100;
            op = r < 45 ? 0 : r < 65 ? 1 : r < 90 ? 2 : 3;
        }
        if (op == 1 && v->count == 0) op = 0;  /* guard pop on empty */
        if (op == 2 && v->count == 0) op = 0;  /* guard update on empty */

        if (op == 0) {                         /* push */
            int64_t x = (int64_t)(rand() & 0x7fffffff);
            nt_pv *nv = nt_pv_push(v, x);
            ref_push(&ref, x);
            v = nv;
        } else if (op == 1) {                  /* pop */
            nt_pv *nv = nt_pv_pop(v);
            ref.len--;
            v = nv;
        } else if (op == 2) {                  /* update, biased to the tail/tree seam */
            uint32_t to = nt_pv_tailoff(v);
            uint32_t cands[5] = { 0, v->count - 1, to ? to - 1 : 0,
                                  to < v->count ? to : v->count - 1,
                                  (uint32_t)(rand() % v->count) };
            uint32_t idx = cands[rand() % 5];
            int64_t x = (int64_t)(rand() & 0x7fffffff);
            nt_pv_node *old_root = v->root;
            uint32_t old_shift = v->shift, old_to = to;
            nt_pv *nv = nt_pv_update(v, idx, x);
            ref.a[idx] = x;
            /* sibling pointer-identity witness: an in-tree update on a multi-child
             * root must leave at least one off-path child same_ptr. */
            if (idx < old_to && child_count(old_root) >= 2) {
                uint32_t path = (idx >> old_shift) & NT_PV_MASK;
                int shared = 0;
                for (uint32_t sub = 0; sub < NT_PV_WIDTH; sub++)
                    if (old_root->slots[sub] && sub != path &&
                        same_ptr((void *)(intptr_t) nv->root->slots[sub],
                                 (void *)(intptr_t) old_root->slots[sub])) shared = 1;
                CHECK(shared);
            }
            v = nv;
        } else {                               /* persist: stash a snapshot */
            if (nhist < 64) { hist[nhist].v = v; hist[nhist].ref = ref_copy(&ref); nhist++; }
        }

        /* structural + value invariants every step */
        if (!assert_full(v))          { CHECK(0 && "assert_full"); break; }
        if (!pv_eq_ref_sample(v, &ref)) { CHECK(0 && "value agreement"); break; }
    }

    /* final full verify + every stashed snapshot still equals its stashed ref */
    CHECK(pv_eq_ref_full(v, &ref));
    int snaps_ok = 1;
    for (int i = 0; i < nhist; i++) if (!pv_eq_ref_full(hist[i].v, &hist[i].ref)) snaps_ok = 0;
    CHECK(snaps_ok);
    printf("  (%d iterations, %d snapshots persisted & re-verified)\n", ITERS, nhist);
    end();
}

/* ============================================================
 * 22 · reference counting: a shared node dies with its LAST owner
 *
 * The integration gate for B2 step 2 (docs §4.2). Arrays are linear with a
 * deterministic drop, but a shared trie node has MANY owners, so `nt_arr_free`
 * releases the header instead of freeing nodes. This walks the danger-zone sizes
 * doing update/push/pop churn, releases every version, and asserts the live-node
 * count returns exactly to its starting value — no leak and (under ASan/UBSan,
 * which this file is also run with) no double free or dangling child.
 * ============================================================ */
static void v22_refcount_balance(void) {
    begin("22 rc: every version released -> live node count returns to base");
    static const uint32_t sizes[] = { 0, 1, 31, 32, 33, 1023, 1024, 1055, 1056,
                                      1057, 2000, 32800, 32801 };
    for (size_t si = 0; si < sizeof(sizes) / sizeof(*sizes); si++) {
        uint32_t n = sizes[si];
        double base = nt_pv_node_live();

        int64_t *flat = (int64_t *)malloc(sizeof(int64_t) * (n ? n : 1));
        for (uint32_t i = 0; i < n; i++) flat[i] = (int64_t)i;
        nt_pv *v = nt_pv_from_slots(flat, n);
        free(flat);
        CHECK(v->count == n);
        for (uint32_t i = 0; i < n; i++) CHECK(nt_pv_get(v, i) == (int64_t)i);

        /* derived versions: each shares v's off-path subtrees, then is released */
        for (uint32_t i = 0; i < n; i += (n / 7 + 1)) {
            nt_pv *w = nt_pv_update(v, i, -1);
            CHECK(nt_pv_get(w, i) == -1);
            CHECK(nt_pv_get(v, i) == (int64_t)i);   /* source untouched */
            nt_pv_release(w);                        /* only w's path nodes die */
            CHECK(nt_pv_get(v, i) == (int64_t)i);   /* ...and v still reads fine */
        }

        /* push/pop churn across the height bump, releasing each intermediate */
        nt_pv *p = v; nt_pv_retain(p);
        for (int k = 0; k < 200; k++) { nt_pv *q = nt_pv_push(p, 1000 + k); nt_pv_release(p); p = q; }
        CHECK(p->count == n + 200);
        for (int k = 0; k < 200; k++) { nt_pv *q = nt_pv_pop(p); nt_pv_release(p); p = q; }
        CHECK(p->count == n);
        for (uint32_t i = 0; i < n; i++) CHECK(nt_pv_get(p, i) == (int64_t)i);
        nt_pv_release(p);
        nt_pv_release(v);

        if (nt_pv_node_live() != base) {
            printf("    LEAK at n=%u: %g live before, %g after\n", n, base, nt_pv_node_live());
            g_fail++;
        }
        g_checks++;
    }
    end();
}

int main(void) {
    v01_empty_first();
    v02_fill_tail();
    v03_first_promotion();
    v04_build_1024();
    v05_spot_checks();
    v06_bump_5_to_10();
    v07_off_by_one();
    v08_bump_10_to_15();
    v09_update_tail();
    v10_update_tree();
    v11_two_updates();
    v12_update_deep();
    v13_append_tail_room();
    v14_append_promote_sharing();
    v15_pop_tail();
    v16_pop_pull_leaf();
    v17_pop_demotion();
    v18_roundtrip();
    v19_uniform_depth();
    v20_immutability_sweep();
    v21_property();
    v22_refcount_balance();

    printf("\n%d checks, %d failures\n", g_checks, g_fail);
    return g_fail ? 1 : 0;
}
