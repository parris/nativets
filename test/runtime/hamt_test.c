/*
 * hamt_test.c — standalone C unit tests for the B2 Map/Set core (nt_hamt.c).
 *
 * Build + run (from repo root):
 *   clang -O0 -g test/runtime/hamt_test.c -o /tmp/hamt_test && /tmp/hamt_test
 *
 * The module is compiled directly into this translation unit (single TU), so the
 * whole thing builds from the one file named on the clang line. `node` is NOT the
 * oracle here — these are assert-based C-unit vectors per docs/research/B2-hamt.md.
 */
#include "../../runtime/nt_hamt.c"

#include <stdio.h>
#include <assert.h>

/* ---- tiny assert harness ---- */
static int g_checks = 0;
static int g_fails  = 0;
#define CHECK(cond) do { \
    g_checks++; \
    if (!(cond)) { g_fails++; \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

/* after every mutating op: popcount(bitmap)==count at every node + full invariants */
#define OK(m) CHECK(nt_hamt_check(m))

/* number/string key shorthands */
static NtKey N(double d) { return nt_key_num(d); }
static NtKey S(const char *s) { return nt_key_str(s); }

/* ============================================================
 * Group A — small flat map basics
 * ============================================================ */

/* 1. empty get/has */
static void v01_empty(void) {
  NtMap *m = nt_map_new();
  CHECK(nt_map_has(m, N(1)) == 0);
  CHECK(nt_map_has(m, N(42)) == 0);
  CHECK(nt_map_get(m, N(1)) == 0);
  CHECK(nt_map_size(m) == 0);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL);
  OK(m);
}

/* 2. put/get single */
static void v02_put_single(void) {
  NtMap *m0 = nt_map_new();
  NtMap *m = nt_map_put(m0, N(1), 100);
  CHECK(nt_map_get(m, N(1)) == 100);
  CHECK(nt_map_has(m, N(1)) == 1);
  CHECK(nt_map_has(m, N(2)) == 0);
  CHECK(nt_map_size(m) == 1);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL);
  OK(m);
}

/* 3. put several distinct (scrambled insertion order) */
static void v03_several(void) {
  NtMap *m = nt_map_new();
  double order[5] = { 3, 1, 5, 2, 4 };
  for (int i = 0; i < 5; i++) m = nt_map_put(m, N(order[i]), (int64_t)(order[i] * 10));
  for (int i = 1; i <= 5; i++) {
    CHECK(nt_map_has(m, N(i)) == 1);
    CHECK(nt_map_get(m, N(i)) == i * 10);
  }
  CHECK(nt_map_size(m) == 5);
  OK(m); /* internal keys strictly sorted by (hash,type,slot) */
}

/* 4. overwrite value */
static void v04_overwrite(void) {
  NtMap *m = nt_map_new();
  m = nt_map_put(m, N(1), 100);
  m = nt_map_put(m, N(1), 200);
  CHECK(nt_map_get(m, N(1)) == 200);
  CHECK(nt_map_size(m) == 1);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL);
  OK(m);
}

/* 5. put is non-mutating (old unchanged) */
static void v05_nonmutating(void) {
  NtMap *empty = nt_map_new();
  NtMap *m1 = nt_map_put(empty, N(1), 10);
  NtMap *m2 = nt_map_put(m1, N(2), 20);
  CHECK(m1 != m2);
  CHECK(nt_map_has(m1, N(2)) == 0);
  CHECK(nt_map_size(m1) == 1);
  CHECK(nt_map_get(m2, N(1)) == 10);
  CHECK(nt_map_get(m2, N(2)) == 20);
  CHECK(nt_map_size(m2) == 2);
  OK(m1); OK(m2);
}

/* 6. value-update SHARES the key array (pointer identity) -- headline invariant */
static void v06_share_keys(void) {
  NtMap *m1 = nt_map_new();
  m1 = nt_map_put(m1, S("a"), 1);
  m1 = nt_map_put(m1, S("b"), 2);
  m1 = nt_map_put(m1, S("c"), 3);
  NtMap *m2 = nt_map_put(m1, S("b"), 99);
  CHECK(nt_map_get(m2, S("b")) == 99);
  CHECK(nt_map_get(m1, S("b")) == 2);            /* old untouched */
  CHECK(nt_small_keys(m2) == nt_small_keys(m1)); /* SAME key array pointer */
  CHECK(nt_small_vals(m2) != nt_small_vals(m1)); /* fresh vals array */
  OK(m1); OK(m2);
}

/* 7. new-key put does NOT share the key array */
static void v07_newkey_no_share(void) {
  NtMap *m1 = nt_map_new();
  m1 = nt_map_put(m1, S("a"), 1);
  m1 = nt_map_put(m1, S("b"), 2);
  m1 = nt_map_put(m1, S("c"), 3);
  NtMap *m2 = nt_map_put(m1, S("d"), 4);
  CHECK(nt_map_has(m2, S("d")) == 1);
  CHECK(nt_map_has(m1, S("d")) == 0);
  CHECK(nt_small_keys(m2) != nt_small_keys(m1));
  CHECK(nt_map_size(m1) == 3);
  OK(m1); OK(m2);
}

/* 8. remove present */
static void v08_remove_present(void) {
  NtMap *m = nt_map_new();
  m = nt_map_put(m, S("a"), 1);
  m = nt_map_put(m, S("b"), 2);
  m = nt_map_put(m, S("c"), 3);
  NtMap *r = nt_map_remove(m, S("b"));
  CHECK(nt_map_has(r, S("b")) == 0);
  CHECK(nt_map_get(r, S("a")) == 1);
  CHECK(nt_map_get(r, S("c")) == 3);
  CHECK(nt_map_size(r) == 2);
  CHECK(nt_map_size(m) == 3);              /* source unchanged */
  CHECK(nt_map_has(m, S("b")) == 1);
  OK(r); OK(m);
}

/* 9. remove absent -> returns the source pointer (no-op is pointer-stable) */
static void v09_remove_absent(void) {
  NtMap *m = nt_map_new();
  m = nt_map_put(m, S("a"), 1);
  m = nt_map_put(m, S("b"), 2);
  m = nt_map_put(m, S("c"), 3);
  NtMap *r = nt_map_remove(m, S("z"));
  CHECK(r == m);
  CHECK(nt_map_size(r) == 3);
  OK(r);
}

/* 10. SameValueZero key semantics */
static void v10_svz(void) {
  double dnan = 0.0 / 0.0;
  /* (a) NaN key */
  NtMap *a = nt_map_put(nt_map_new(), N(dnan), 7);
  CHECK(nt_map_get(a, N(dnan)) == 7);
  CHECK(nt_map_has(a, N(0.0 / 0.0)) == 1);   /* NaN == NaN */
  /* (b) +0 and -0 collapse */
  NtMap *b = nt_map_put(nt_map_new(), N(0.0), 11);
  b = nt_map_put(b, N(-0.0), 22);
  CHECK(nt_map_size(b) == 1);
  CHECK(nt_map_get(b, N(0.0)) == 22);
  /* (c) 1 (number) and "1" (string) are distinct */
  NtMap *c = nt_map_put(nt_map_new(), N(1), 100);
  c = nt_map_put(c, S("1"), 200);
  CHECK(nt_map_size(c) == 2);
  CHECK(nt_map_get(c, N(1)) == 100);
  CHECK(nt_map_get(c, S("1")) == 200);
  OK(a); OK(b); OK(c);
}

/* ============================================================
 * Group B — the small -> HAMT boundary (~32) danger zone
 * ============================================================ */

/* 11. fill to exactly NT_MAP_SMALL_MAX distinct keys stays SMALL */
static void v11_fill_threshold(void) {
  NtMap *m = nt_map_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) m = nt_map_put(m, N(i), i * 7);
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) CHECK(nt_map_get(m, N(i)) == i * 7);
  CHECK(nt_map_size(m) == NT_MAP_SMALL_MAX);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL);
  OK(m);
}

/* 12. cross the threshold promotes to HAMT */
static void v12_cross_promote(void) {
  NtMap *m = nt_map_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX + 1; i++) m = nt_map_put(m, N(i), i * 7);
  for (int i = 1; i <= NT_MAP_SMALL_MAX + 1; i++) CHECK(nt_map_get(m, N(i)) == i * 7);
  CHECK(nt_map_size(m) == NT_MAP_SMALL_MAX + 1);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  OK(m); /* popcount==children at every node */
}

/* 13. promotion leaves the source intact */
static void v13_promote_source_intact(void) {
  NtMap *at_max = nt_map_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) at_max = nt_map_put(at_max, N(i), i);
  NtMap *over = nt_map_put(at_max, N(NT_MAP_SMALL_MAX + 1), 999);
  CHECK(nt_map_kind(at_max) == NT_MAP_SMALL);
  CHECK(nt_map_size(at_max) == NT_MAP_SMALL_MAX);
  CHECK(nt_map_has(at_max, N(NT_MAP_SMALL_MAX + 1)) == 0);
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) CHECK(nt_map_get(at_max, N(i)) == i);
  CHECK(nt_map_kind(over) == NT_MAP_HAMT);
  CHECK(nt_map_size(over) == NT_MAP_SMALL_MAX + 1);
  OK(at_max); OK(over);
}

/* 14. remove across the boundary demotes to SMALL (canonical) */
static void v14_demote(void) {
  NtMap *hamt = nt_map_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX + 1; i++) hamt = nt_map_put(hamt, N(i), i);
  CHECK(nt_map_kind(hamt) == NT_MAP_HAMT);
  NtMap *small = nt_map_remove(hamt, N(NT_MAP_SMALL_MAX + 1));
  CHECK(nt_map_kind(small) == NT_MAP_SMALL);
  CHECK(nt_map_size(small) == NT_MAP_SMALL_MAX);
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) CHECK(nt_map_get(small, N(i)) == i);
  CHECK(nt_map_kind(hamt) == NT_MAP_HAMT); /* source unchanged */
  OK(small); OK(hamt);
}

/* ============================================================
 * Group C — HAMT bitmap / popcount internals (use the hash hook)
 * ============================================================ */

/* 15. bulk get/put/has over ~1000 distinct keys */
static void v15_bulk(void) {
  NtMap *m = nt_map_new();
  for (int i = 0; i < 1000; i++) m = nt_map_put(m, N(i), (int64_t)i * 3 + 1);
  for (int i = 0; i < 1000; i++) {
    CHECK(nt_map_has(m, N(i)) == 1);
    CHECK(nt_map_get(m, N(i)) == (int64_t)i * 3 + 1);
  }
  CHECK(nt_map_has(m, N(-1)) == 0);
  CHECK(nt_map_has(m, N(1000)) == 0);
  CHECK(nt_map_has(m, N(99999)) == 0);
  CHECK(nt_map_size(m) == 1000);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  OK(m);
}

/* 16. sparse bitmap index: two occupied, non-adjacent root slots (3 and 30) */
static uint32_t hook16(NtKey k) {
  long v = (long)slot_to_num(k.slot);
  uint32_t root5 = (v % 2 == 0) ? 3u : 30u;   /* even -> slot 3, odd -> slot 30 */
  return root5 | ((uint32_t)v << 5);          /* higher slices keep hashes distinct */
}
static void v16_sparse(void) {
  nt_map__set_hash_hook(hook16);
  NtMap *m = nt_map_new();
  for (int i = 0; i < 40; i++) m = nt_map_put(m, N(i), (int64_t)i * 100 + 1);
  for (int i = 0; i < 40; i++) CHECK(nt_map_get(m, N(i)) == (int64_t)i * 100 + 1);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  NtHamt *root = nt_hamt_root(m);
  CHECK(root->count == 2);
  CHECK(__builtin_popcount(root->bitmap) == 2);
  CHECK(root->bitmap == ((1u << 3) | (1u << 30)));
  int pos3  = __builtin_popcount(root->bitmap & ((1u << 3) - 1));
  int pos30 = __builtin_popcount(root->bitmap & ((1u << 30) - 1));
  CHECK(pos3 == 0);
  CHECK(pos30 == 1);
  CHECK(nt_hamt_child_ptr(root, 3) != NULL);
  CHECK(nt_hamt_child_ptr(root, 30) != NULL);
  OK(m);
  nt_map__set_hash_hook(NULL);
}

/* 17. deep trie via a shared prefix: slices [5,7,...] shared, then diverge */
static uint32_t hook17(NtKey k) {
  uint32_t v = (uint32_t)(long)slot_to_num(k.slot);
  return 5u | (7u << 5) | (v << 10);          /* depth0 slice=5, depth1 slice=7 */
}
static void v17_deep(void) {
  nt_map__set_hash_hook(hook17);
  NtMap *m = nt_map_new();
  for (int i = 0; i < 40; i++) m = nt_map_put(m, N(i), (int64_t)i + 500);
  for (int i = 0; i < 40; i++) CHECK(nt_map_get(m, N(i)) == (int64_t)i + 500);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  NtHamt *root = nt_hamt_root(m);
  CHECK(root->count == 1);                     /* single shared root slice */
  CHECK(nt_hamt_child_ptr(root, 5) != NULL);   /* nested BITMAP subnode, not collision */
  NtHamt *d1 = nt_hamt_child_ptr(root, 5);
  CHECK(d1->kind == NT_HAMT_BITMAP);
  CHECK(nt_hamt_child_ptr(d1, 7) != NULL);
  OK(m); /* check confirms routing at every level */
  nt_map__set_hash_hook(NULL);
}

/* ============================================================
 * Group D — forced hash collisions (prime danger zone)
 * ============================================================ */

/* recursively locate the first COLLISION node reachable from a HAMT root */
static NtHamt *find_collision(NtHamt *node) {
  if (!node) return NULL;
  if (node->kind == NT_HAMT_COLLISION) return node;
  for (int i = 0; i < node->count; i++) {
    if (node->ctype[i] == NT_C_SUB) {
      NtHamt *r = find_collision((NtHamt *)(intptr_t)node->v[i]);
      if (r) return r;
    }
  }
  return NULL;
}
static int count_collisions(NtHamt *node) {
  if (!node) return 0;
  if (node->kind == NT_HAMT_COLLISION) return 1;
  int c = 0;
  for (int i = 0; i < node->count; i++)
    if (node->ctype[i] == NT_C_SUB) c += count_collisions((NtHamt *)(intptr_t)node->v[i]);
  return c;
}

/* hook: values >= 1000 all share ONE full hash (forced collision); fillers = v */
#define HC 12345678u
static uint32_t hookD(NtKey k) {
  long v = (long)slot_to_num(k.slot);
  return v >= 1000 ? HC : (uint32_t)v;
}
/* build a HAMT of 50 filler keys (0..49), keeping the map well above threshold */
static NtMap *with_fillers(void) {
  NtMap *m = nt_map_new();
  for (int i = 0; i < 50; i++) m = nt_map_put(m, N(i), (int64_t)i);
  return m;
}

/* 18. two distinct keys sharing a full hash -> a COLLISION node */
static void v18_collision_node(void) {
  nt_map__set_hash_hook(hookD);
  NtMap *m = with_fillers();
  m = nt_map_put(m, N(1000), 111);
  m = nt_map_put(m, N(2000), 222);
  CHECK(nt_map_get(m, N(1000)) == 111);
  CHECK(nt_map_get(m, N(2000)) == 222);
  NtHamt *c = find_collision(nt_hamt_root(m));
  CHECK(c != NULL);
  CHECK(c->kind == NT_HAMT_COLLISION);
  CHECK(c->count == 2);
  OK(m);
  nt_map__set_hash_hook(NULL);
}

/* 19. collision node put / update / remove (equality, not hash, disambiguates) */
static void v19_collision_ops(void) {
  nt_map__set_hash_hook(hookD);
  NtMap *m = with_fillers();
  m = nt_map_put(m, N(1000), 111);
  m = nt_map_put(m, N(2000), 222);
  m = nt_map_put(m, N(3000), 333);            /* 3rd colliding key */
  CHECK(find_collision(nt_hamt_root(m))->count == 3);
  m = nt_map_put(m, N(2000), 999);            /* update one */
  CHECK(find_collision(nt_hamt_root(m))->count == 3);
  CHECK(nt_map_get(m, N(2000)) == 999);
  CHECK(nt_map_get(m, N(1000)) == 111);
  CHECK(nt_map_get(m, N(3000)) == 333);
  m = nt_map_remove(m, N(1000));              /* remove one */
  CHECK(find_collision(nt_hamt_root(m))->count == 2);
  CHECK(nt_map_has(m, N(1000)) == 0);
  CHECK(nt_map_get(m, N(2000)) == 999);
  CHECK(nt_map_get(m, N(3000)) == 333);
  OK(m);
  nt_map__set_hash_hook(NULL);
}

/* 20. collision collapses on shrink to a plain LEAF (no 1-entry collision node) */
static void v20_collision_collapse(void) {
  nt_map__set_hash_hook(hookD);
  NtMap *m = with_fillers();
  m = nt_map_put(m, N(1000), 111);
  m = nt_map_put(m, N(2000), 222);
  CHECK(find_collision(nt_hamt_root(m)) != NULL);
  m = nt_map_remove(m, N(1000));              /* down to 1 colliding key */
  CHECK(nt_map_get(m, N(2000)) == 222);       /* survivor gettable */
  CHECK(count_collisions(nt_hamt_root(m)) == 0); /* collision node gone -> inlined leaf */
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);       /* fillers keep it a HAMT */
  OK(m);
  nt_map__set_hash_hook(NULL);
}

/* 21. prefix-collision is NOT a hash-collision (shares low slice, different full hash) */
static uint32_t hookP(NtKey k) {
  long v = (long)slot_to_num(k.slot);
  /* share low5 slice (14) but distinct full hashes, and clear of filler hashes 0..49 */
  if (v == 1000) return 14u | (100u << 5);
  if (v == 2000) return 14u | (101u << 5);
  return (uint32_t)v;
}
static void v21_prefix_not_collision(void) {
  nt_map__set_hash_hook(hookP);
  NtMap *m = with_fillers();
  m = nt_map_put(m, N(1000), 111);
  m = nt_map_put(m, N(2000), 222);
  CHECK(nt_map_get(m, N(1000)) == 111);
  CHECK(nt_map_get(m, N(2000)) == 222);
  CHECK(count_collisions(nt_hamt_root(m)) == 0); /* split into a BITMAP subnode, not COLLISION */
  OK(m);
  nt_map__set_hash_hook(NULL);
}

/* ============================================================
 * Group E — removal / node collapse (canonical form)
 * ============================================================ */

/* hook: fillers occupy root slots 0..30; keys A,B alone occupy root slot 31 */
static uint32_t hookE(NtKey k) {
  long v = (long)slot_to_num(k.slot);
  if (v == 1000) return 31u;                  /* root slot 31, depth1 slice 0 */
  if (v == 2000) return 31u | (1u << 5);      /* root slot 31, depth1 slice 1 */
  return (uint32_t)((v % 31) | ((uint32_t)v << 5)); /* root slice 0..30, never 31 */
}

/* 22. a 2-leaf subnode collapses to an inlined leaf on removal */
static void v22_subnode_inline(void) {
  nt_map__set_hash_hook(hookE);
  NtMap *m = nt_map_new();
  for (int i = 0; i < 40; i++) m = nt_map_put(m, N(i), (int64_t)i);
  m = nt_map_put(m, N(1000), 111);
  m = nt_map_put(m, N(2000), 222);
  NtHamt *root = nt_hamt_root(m);
  CHECK(nt_hamt_child_ptr(root, 31) != NULL); /* {A,B} live in a subnode at slot 31 */
  m = nt_map_remove(m, N(1000));              /* subnode {A,B} -> {B}, inline upward */
  CHECK(nt_map_get(m, N(2000)) == 222);
  CHECK(nt_map_has(m, N(1000)) == 0);
  CHECK(nt_hamt_child_ptr(nt_hamt_root(m), 31) == NULL); /* slot 31 now a LEAF, not a subnode */
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  OK(m); /* check confirms no singleton-child BITMAP node anywhere */
  nt_map__set_hash_hook(NULL);
}

/* 23. remove everything -> empty */
static void v23_remove_all(void) {
  NtMap *m = nt_map_new();
  for (int i = 0; i < 40; i++) m = nt_map_put(m, N(i), (int64_t)i);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT);
  for (int i = 0; i < 40; i++) m = nt_map_remove(m, N(i));
  for (int i = 0; i < 40; i++) CHECK(nt_map_has(m, N(i)) == 0);
  CHECK(nt_map_size(m) == 0);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL);
  OK(m);
}

/* 24. remove absent from a HAMT -> unchanged, source root reused */
static void v24_remove_absent_hamt(void) {
  NtMap *m = nt_map_new();
  for (int i = 0; i < 40; i++) m = nt_map_put(m, N(i), (int64_t)i);
  NtMap *r = nt_map_remove(m, N(99999));
  CHECK(r == m);                              /* pointer-stable no-op */
  CHECK(nt_hamt_root(r) == nt_hamt_root(m));  /* shared root */
  CHECK(nt_map_size(r) == 40);
  OK(r);
}

/* ============================================================
 * Group F — sets (keys only)
 * ============================================================ */

/* 25. set semantics + boundary + a forced collision (keys only) */
static void v25_sets(void) {
  /* dup ignored, re-add is a pointer-stable no-op */
  NtMap *s = nt_set_new();
  s = nt_set_add(s, S("a"));
  s = nt_set_add(s, S("b"));
  NtMap *s2 = nt_set_add(s, S("a"));          /* duplicate */
  CHECK(s2 == s);                             /* no-op returns source */
  CHECK(nt_set_has(s2, S("a")) == 1);
  CHECK(nt_set_has(s2, S("b")) == 1);
  CHECK(nt_set_has(s2, S("c")) == 0);
  CHECK(nt_set_size(s2) == 2);
  OK(s2);

  /* boundary: cross into a HAMT set (mirror #12) */
  NtMap *b = nt_set_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX + 1; i++) b = nt_set_add(b, N(i));
  CHECK(nt_set_size(b) == NT_MAP_SMALL_MAX + 1);
  CHECK(nt_map_kind(b) == NT_MAP_HAMT);
  for (int i = 1; i <= NT_MAP_SMALL_MAX + 1; i++) CHECK(nt_set_has(b, N(i)) == 1);
  OK(b);

  /* forced collision, keys only (mirror #18) */
  nt_map__set_hash_hook(hookD);
  NtMap *c = nt_set_new();
  for (int i = 0; i < 50; i++) c = nt_set_add(c, N(i));
  c = nt_set_add(c, N(1000));
  c = nt_set_add(c, N(2000));
  CHECK(nt_set_has(c, N(1000)) == 1);
  CHECK(nt_set_has(c, N(2000)) == 1);
  NtHamt *cn = find_collision(nt_hamt_root(c));
  CHECK(cn != NULL && cn->count == 2);
  c = nt_set_remove(c, N(1000));
  CHECK(nt_set_has(c, N(1000)) == 0);
  CHECK(nt_set_has(c, N(2000)) == 1);
  OK(c);
  nt_map__set_hash_hook(NULL);
}

/* ============================================================
 * Group G — immutability / structural sharing
 * ============================================================ */

/* 26. sibling subtree pointer identity (path copying) */
static void v26_sibling_sharing(void) {
  NtMap *m1 = nt_map_new();
  for (int i = 0; i < 1000; i++) m1 = nt_map_put(m1, N(i), (int64_t)i);
  NtKey knew = N(123456);
  int i = (int)(nt_key_hash(knew) & 31);      /* root slot the new key routes into */
  NtMap *m2 = nt_map_put(m1, knew, 7);
  NtHamt *r1 = nt_hamt_root(m1), *r2 = nt_hamt_root(m2);
  int shared = 0;
  for (int j = 0; j < 32; j++) {
    if (j == i) continue;
    CHECK(nt_hamt_child_ptr(r2, j) == nt_hamt_child_ptr(r1, j)); /* untouched sibling shared */
    if (nt_hamt_child_ptr(r1, j) != NULL) shared = 1;
  }
  CHECK(shared == 1);                          /* at least one genuinely shared subtree */
  if (nt_hamt_child_ptr(r1, i) != NULL)        /* the touched path was freshly copied */
    CHECK(nt_hamt_child_ptr(r2, i) != nt_hamt_child_ptr(r1, i));
  CHECK(nt_map_get(m2, knew) == 7);
  CHECK(nt_map_has(m1, knew) == 0);
  OK(m1); OK(m2);
}

/* 27. many versions all intact across a long history */
static void v27_many_versions(void) {
  enum { K = 50 };
  NtMap *ver[K + 1];
  ver[0] = nt_map_new();
  for (int i = 1; i <= K; i++) ver[i] = nt_map_put(ver[i - 1], N(i), (int64_t)i * 11);
  for (int i = 0; i <= K; i++) {
    CHECK(nt_map_size(ver[i]) == i);
    for (int j = 1; j <= i; j++) CHECK(nt_map_get(ver[i], N(j)) == (int64_t)j * 11);
    CHECK(nt_map_has(ver[i], N(i + 1)) == 0);  /* nothing leaked forward */
    OK(ver[i]);
  }
}

/* ============================================================
 * Model-based property test (jlouis `statem` style)
 *
 * Oracle = an assoc-list (present[]/val[], last-write-wins). Small key domain so
 * the op sequence repeatedly crosses and re-crosses the ~32 boundary; a collision-
 * biased hash hook so collision nodes form, grow, and dissolve; a prefix-collision
 * sub-domain to hit the deep-split path. Per step: every key in the domain agrees
 * with the model, size agrees, nt_hamt_check passes. Old snapshots stay intact
 * (immutability). Value-only small updates share the key array; HAMT puts keep
 * untouched sibling subtrees pointer-identical (structural sharing).
 * ============================================================ */
#define KEY_DOMAIN 40

/* collision-biased hook over the key domain */
static uint32_t hookProp(NtKey k) {
  long v = (long)slot_to_num(k.slot);
  if (v < 16)  return (uint32_t)(v % 8);                 /* heavy full-hash collisions (0..7) */
  if (v < 28)  return (uint32_t)((v & 7) | (v << 5));    /* shared low slice, distinct full hash */
  return (uint32_t)(v * 2654435761u);                    /* scrambled distinct */
}

static uint32_t g_rs = 0x9e3779b9u;
static uint32_t xr(void) { g_rs ^= g_rs << 13; g_rs ^= g_rs >> 17; g_rs ^= g_rs << 5; return g_rs; }

static void prop_verify(NtMap *m, int *present, int64_t *val) {
  int64_t sz = 0;
  for (int k = 0; k < KEY_DOMAIN; k++) {
    CHECK(nt_map_has(m, N(k)) == present[k]);
    if (present[k]) { CHECK(nt_map_get(m, N(k)) == val[k]); sz++; }
  }
  CHECK(nt_map_size(m) == sz);
  CHECK(nt_hamt_check(m));
}

static void prop_test(void) {
  nt_map__set_hash_hook(hookProp);
  const int STEPS = 8000;
  int present[KEY_DOMAIN]; int64_t val[KEY_DOMAIN];
  for (int i = 0; i < KEY_DOMAIN; i++) { present[i] = 0; val[i] = 0; }
  NtMap *m = nt_map_new();

  /* immutability snapshots: a small ring of (version, model copy) */
  enum { SNAP = 12 };
  NtMap *snap_m[SNAP];
  int snap_present[SNAP][KEY_DOMAIN]; int64_t snap_val[SNAP][KEY_DOMAIN];
  int snap_n = 0;

  int64_t counter = 1000000;
  for (int step = 0; step < STEPS; step++) {
    int key = (int)(xr() % KEY_DOMAIN);
    int do_put = (xr() % 100) < 55;            /* put:remove ~= 55:45 */

    if (do_put) {
      int64_t v = counter++;
      /* sharing pre-state */
      int was_small = (nt_map_kind(m) == NT_MAP_SMALL);
      int was_present = nt_map_has(m, N(key));
      int64_t *old_keys = was_small ? nt_small_keys(m) : NULL;
      NtHamt *old_root = (nt_map_kind(m) == NT_MAP_HAMT) ? nt_hamt_root(m) : NULL;
      int ri = (int)(nt_key_hash(N(key)) & 31);

      NtMap *nm = nt_map_put(m, N(key), v);

      /* value-only small update -> key array shared */
      if (was_small && was_present && nt_map_kind(nm) == NT_MAP_SMALL)
        CHECK(nt_small_keys(nm) == old_keys);
      /* HAMT put -> untouched sibling subtrees pointer-identical */
      if (old_root && nt_map_kind(nm) == NT_MAP_HAMT) {
        NtHamt *nr = nt_hamt_root(nm);
        for (int j = 0; j < 32; j++)
          if (j != ri) CHECK(nt_hamt_child_ptr(nr, j) == nt_hamt_child_ptr(old_root, j));
      }
      m = nm;
      present[key] = 1; val[key] = v;
    } else {
      m = nt_map_remove(m, N(key));
      present[key] = 0;
    }

    prop_verify(m, present, val);

    /* take a snapshot occasionally */
    if (step % 600 == 0 && snap_n < SNAP) {
      snap_m[snap_n] = m;
      for (int i = 0; i < KEY_DOMAIN; i++) { snap_present[snap_n][i] = present[i]; snap_val[snap_n][i] = val[i]; }
      snap_n++;
    }
    /* every so often, re-verify all snapshots still match their creation-time model */
    if (step % 500 == 0)
      for (int s = 0; s < snap_n; s++)
        prop_verify(snap_m[s], snap_present[s], snap_val[s]);
  }
  /* final: all snapshots still intact */
  for (int s = 0; s < snap_n; s++) prop_verify(snap_m[s], snap_present[s], snap_val[s]);
  nt_map__set_hash_hook(NULL);
}

/* directed seed cases (always run, not just random) */
static void prop_seeds(void) {
  /* (a) fill to exactly MAX, then MAX+1, then back to MAX */
  NtMap *m = nt_map_new();
  for (int i = 1; i <= NT_MAP_SMALL_MAX; i++) m = nt_map_put(m, N(i), i);
  CHECK(nt_map_kind(m) == NT_MAP_SMALL); OK(m);
  m = nt_map_put(m, N(NT_MAP_SMALL_MAX + 1), 999);
  CHECK(nt_map_kind(m) == NT_MAP_HAMT); OK(m);
  m = nt_map_remove(m, N(NT_MAP_SMALL_MAX + 1));
  CHECK(nt_map_kind(m) == NT_MAP_SMALL); OK(m);

  /* (b) N full-hash-colliding keys, removed in two different orders */
  nt_map__set_hash_hook(hookD);
  for (int order = 0; order < 2; order++) {
    NtMap *c = with_fillers();
    for (int i = 0; i < 5; i++) c = nt_map_put(c, N(1000 + i), 100 + i);
    CHECK(find_collision(nt_hamt_root(c))->count == 5); OK(c);
    if (order == 0) for (int i = 0; i < 5; i++)     c = nt_map_remove(c, N(1000 + i));
    else            for (int i = 4; i >= 0; i--)    c = nt_map_remove(c, N(1000 + i));
    for (int i = 0; i < 5; i++) CHECK(nt_map_has(c, N(1000 + i)) == 0);
    CHECK(count_collisions(nt_hamt_root(c)) == 0); OK(c);
  }
  nt_map__set_hash_hook(NULL);

  /* (c) build into HAMT range then tear all the way down to empty */
  NtMap *big = nt_map_new();
  for (int i = 0; i < 100; i++) big = nt_map_put(big, N(i), i);
  OK(big);
  for (int i = 99; i >= 0; i--) big = nt_map_remove(big, N(i));
  CHECK(nt_map_size(big) == 0); OK(big);

  /* (d) alternating value-only updates on a fixed key set keep key-array sharing */
  NtMap *f = nt_map_new();
  for (int i = 0; i < 10; i++) f = nt_map_put(f, N(i), i);
  int64_t *keys0 = nt_small_keys(f);
  for (int t = 0; t < 20; t++) {
    f = nt_map_put(f, N(t % 10), 5000 + t);
    CHECK(nt_small_keys(f) == keys0);          /* same key array every time */
  }
  OK(f);
}

int main(void) {
  v01_empty();
  v02_put_single();
  v03_several();
  v04_overwrite();
  v05_nonmutating();
  v06_share_keys();
  v07_newkey_no_share();
  v08_remove_present();
  v09_remove_absent();
  v10_svz();
  v11_fill_threshold();
  v12_cross_promote();
  v13_promote_source_intact();
  v14_demote();
  v15_bulk();
  v16_sparse();
  v17_deep();
  v18_collision_node();
  v19_collision_ops();
  v20_collision_collapse();
  v21_prefix_not_collision();
  v22_subnode_inline();
  v23_remove_all();
  v24_remove_absent_hamt();
  v25_sets();
  v26_sibling_sharing();
  v27_many_versions();
  prop_seeds();
  prop_test();
  /* CALLS */
  printf("%d checks, %d failures\n", g_checks, g_fails);
  printf("live nodes at exit: %.0f (never-free placeholder; drops not yet wired)\n", nt_map_live());
  return g_fails ? 1 : 0;
}
