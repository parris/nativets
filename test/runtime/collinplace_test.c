/*
 * collinplace_test.c — the IN-PLACE Map/Set update behind a `@@mutable` binding.
 *
 * Build + run (from repo root):
 *   clang -O0 -g test/runtime/collinplace_test.c runtime/nt_hamt.c runtime/runtime.c \
 *     -o /tmp/collinplace_test && /tmp/collinplace_test
 *
 * WHY THIS EXISTS. `Map`/`Set` here are persistent, so `m.set(k, v)` returns a NEW
 * collection and a discarded result is a no-op (NT1606). That refusal is correct, and it
 * blocks eight sites in src/ that want an ACCUMULATOR — including two `moduleOrder`
 * parameters for which NO spelling works today (rebinding a parameter is NT1608, and the
 * `//@@mutable` opt-in is array-only, NT1023).
 *
 * docs/self-hosting.md priced the fix as either a refcount-aware in-place HAMT insert or a
 * new cell-passing calling convention. BOTH WERE WRONG, and this file is the evidence:
 * `NtColl` is ALREADY a three-field wrapper over the persistent internals, so the cell
 * exists. An in-place update is the ordinary persistent op followed by copying the new
 * wrapper's fields back into the old one.
 *
 * The three properties that make it sound are asserted below: the receiver updates, every
 * holder of that wrapper observes it, and a version handed out EARLIER by the persistent
 * API is untouched — the internals are structurally shared, so nothing is freed or
 * overwritten and this is a lost-update question rather than a memory-safety one.
 */
#include "../../runtime/nt_mapset.c"

#include <stdio.h>

static int g_checks = 0;
static int g_fails  = 0;
#define CHECK(cond) do { \
    g_checks++; \
    if (!(cond)) { g_fails++; \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

int main(void) {
  /* 1. THE PERSISTENT OP LEAVES ITS RECEIVER ALONE — the property the refusal protects. */
  NtColl *m = nt_coll_map_new();
  NtColl *v1 = nt_map_put_slot(m, 0, 42, 7);
  CHECK(nt_coll_size(m) == 0);
  CHECK(nt_coll_size(v1) == 1);

  /* 2. THE IN-PLACE OP UPDATES THE RECEIVER, and an alias of that wrapper sees it. */
  NtColl *alias = m;
  nt_map_put_slot_inplace(m, 0, 42, 7);
  nt_map_put_slot_inplace(m, 0, 43, 9);
  CHECK(nt_coll_size(m) == 2);
  CHECK(nt_coll_size(alias) == 2);
  CHECK(nt_map_get_slot(m, 0, 42) == 7);
  CHECK(nt_map_get_slot(m, 0, 43) == 9);
  CHECK(nt_map_has_slot(m, 0, 43) == 1);

  /* 3. AN EARLIER PERSISTENT VERSION IS UNAFFECTED. This is what says the in-place write
   *    changes one wrapper's VIEW and never the shared internals. */
  CHECK(nt_coll_size(v1) == 1);
  CHECK(nt_map_has_slot(v1, 0, 43) == 0);

  /* 4. REMOVE, in place, and the same three properties. */
  nt_map_remove_slot_inplace(m, 0, 42);
  CHECK(nt_coll_size(m) == 1);
  CHECK(nt_map_has_slot(m, 0, 42) == 0);
  CHECK(nt_map_has_slot(m, 0, 43) == 1);
  CHECK(nt_coll_size(v1) == 1); /* still untouched */

  /* 5. SETS take the same path (a set IS a map with a 0 value — `coll_put`). */
  NtColl *s = nt_coll_set_new();
  NtColl *s1 = nt_set_add_slot(s, 0, 5);
  CHECK(nt_coll_size(s) == 0);   /* persistent: receiver unchanged */
  CHECK(nt_coll_size(s1) == 1);
  nt_set_add_slot_inplace(s, 0, 5);
  nt_set_add_slot_inplace(s, 0, 6);
  CHECK(nt_coll_size(s) == 2);
  CHECK(nt_set_has_slot(s, 0, 6) == 1);
  nt_set_remove_slot_inplace(s, 0, 5);
  CHECK(nt_coll_size(s) == 1);
  CHECK(nt_set_has_slot(s, 0, 5) == 0);

  /* 6. INSERTION ORDER survives in-place updates — `buf`/`n` are copied with `m`, so the
   *    order log is not left behind by the wrapper it belongs to. */
  NtColl *o = nt_coll_map_new();
  for (int64_t i = 0; i < 8; i++) nt_map_put_slot_inplace(o, 0, 100 + i, i);
  CHECK(nt_coll_size(o) == 8);
  NtArrayOpaque *keys = nt_coll_keys(o);
  CHECK((int64_t)nt_arr_len(keys) == 8);
  int ordered = 1;
  for (int64_t i = 0; i < 8; i++) if (nt_arr_get(keys, (double)i) != 100 + i) ordered = 0;
  CHECK(ordered);

  printf("collinplace_test: %d checks, %d failures\n", g_checks, g_fails);
  return g_fails ? 1 : 0;
}
