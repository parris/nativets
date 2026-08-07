/*
 * nt_mapset.c — scalar-ABI wrappers over nt_hamt.{c,h} for nativets codegen (B2).
 *
 * The core Map/Set API (nt_hamt.h) passes keys by an `NtKey { uint8_t; int64_t }`
 * struct value. Passing/returning a small struct by value from hand-written LLVM
 * IR requires reproducing the target's C struct-passing ABI (register coercion),
 * which is platform-dependent and fragile. These wrappers expose a flat scalar
 * ABI — (ptr handle, i32 key-type-tag, i64 key-slot [, i64 value-slot]) — that
 * codegen can emit portably. The tag is NtKey.type (NT_K_NUM=0 / NT_K_STR=1); the
 * slot is the raw 8 bytes (double bitcast for numbers, char* for strings). We
 * route through nt_key_num/nt_key_str so SameValueZero normalization (-0→+0,
 * NaN canonicalization) still happens in the one canonical place.
 *
 * INSERTION ORDER (collections lane). node guarantees Map/Set iterate in insertion
 * order; the HAMT is hash-ordered (and its small-map form is sorted), so iterating
 * the storage would be a SILENT divergence. The TS-level Map/Set handle is therefore
 * an `NtColl` — the HAMT handle PLUS a persistent insertion-order key log:
 *
 *   NtColl { NtMap *m; NtOrd *buf; int64_t n; }   // this version sees buf[0..n)
 *
 * The log is kept CLEAN (exactly the live keys, in insertion order, no duplicates):
 *   - put/add of a NEW key appends;   put of an EXISTING key does not (node keeps
 *     the original position on re-set);
 *   - delete removes the entry, so a later re-insert appends at the END (node);
 * so iteration is a straight walk of buf[0..n) with no filtering or dedup.
 *
 * It stays PERSISTENT (old versions unchanged) with structural sharing via the
 * append-log trick: a child may write in place only when it is the buffer's tip
 * (`n == buf->used`) and capacity allows — otherwise it copies. Any other version
 * still reads only its own prefix `n`, so it can never observe a sibling's append.
 *
 * Additive: nt_hamt.c is UNTOUCHED — NtColl wraps it from the outside. Linked (with
 * nt_hamt.c) only when a program uses Map/Set.
 */
#include "nt_hamt.h"
#include <stdlib.h>
#include <string.h>

static NtKey ntk(int ktype, int64_t slot) {
  if (ktype == NT_K_STR) return nt_key_str((const char *)slot);
  double d;
  memcpy(&d, &slot, sizeof d);
  return nt_key_num(d);
}

/* ---- insertion-order log ---------------------------------------------- */

/* Append-shared key log. `used` is the high-water mark of the SHARED buffer; a
 * version's own length lives in NtColl.n (always <= used). */
typedef struct {
  int64_t  cap, used;
  uint8_t *ktype;
  int64_t *keys;
} NtOrd;

typedef struct {
  NtMap  *m;    /* the HAMT handle (equality/lookup/size) */
  NtOrd  *buf;  /* insertion-order key log (NULL when empty) */
  int64_t n;    /* this version's visible prefix of buf */
} NtColl;

static void *xalloc2(size_t n) {
  void *p = malloc(n);
  if (!p) abort();
  return p;
}

static NtColl *coll(NtMap *m, NtOrd *buf, int64_t n) {
  NtColl *c = (NtColl *)xalloc2(sizeof(NtColl));
  c->m = m; c->buf = buf; c->n = n;
  return c;
}

static NtOrd *ord_alloc(int64_t cap) {
  NtOrd *o = (NtOrd *)xalloc2(sizeof(NtOrd));
  o->cap = cap > 0 ? cap : 1;
  o->used = 0;
  o->ktype = (uint8_t *)xalloc2(sizeof(uint8_t) * (size_t)o->cap);
  o->keys = (int64_t *)xalloc2(sizeof(int64_t) * (size_t)o->cap);
  return o;
}

/* Append `k` to c's log, returning the child's (buf, n). In place when this
 * version is the buffer's tip; otherwise a fresh buffer (copy-on-branch), which
 * is what keeps every older handle unchanged. */
static NtOrd *ord_append(const NtColl *c, NtKey k, int64_t *out_n) {
  NtOrd *b = c->buf;
  if (b && c->n == b->used && c->n < b->cap) {
    b->ktype[c->n] = k.type;
    b->keys[c->n] = k.slot;
    b->used = c->n + 1;
    *out_n = c->n + 1;
    return b;
  }
  NtOrd *nb = ord_alloc((c->n + 1) * 2);
  if (b && c->n > 0) {
    memcpy(nb->ktype, b->ktype, sizeof(uint8_t) * (size_t)c->n);
    memcpy(nb->keys, b->keys, sizeof(int64_t) * (size_t)c->n);
  }
  nb->ktype[c->n] = k.type;
  nb->keys[c->n] = k.slot;
  nb->used = c->n + 1;
  *out_n = c->n + 1;
  return nb;
}

/* Drop `k` from c's log (it is known present). Always a fresh buffer — a removal
 * can never be expressed as an append to a shared one. */
static NtOrd *ord_remove(const NtColl *c, NtKey k, int64_t *out_n) {
  NtOrd *b = c->buf;
  NtOrd *nb = ord_alloc(c->n > 1 ? c->n - 1 : 1);
  int64_t j = 0;
  for (int64_t i = 0; i < c->n; i++) {
    NtKey e; e.type = b->ktype[i]; e.slot = b->keys[i];
    if (nt_key_eq(e, k)) continue;
    nb->ktype[j] = e.type; nb->keys[j] = e.slot; j++;
  }
  nb->used = j;
  *out_n = j;
  return nb;
}

/* ---- map/set ops (NtColl in, NtColl out; the HAMT stays authoritative) ---- */

NtColl *nt_coll_map_new(void) { return coll(nt_map_new(), NULL, 0); }
NtColl *nt_coll_set_new(void) { return coll(nt_set_new(), NULL, 0); }
int64_t nt_coll_size(NtColl *c) { return nt_map_size(c->m); }

static NtColl *coll_put(NtColl *c, NtKey k, int64_t val, int has_val) {
  NtMap *m2 = has_val ? nt_map_put(c->m, k, val) : nt_set_add(c->m, k);
  if (nt_map_has(c->m, k)) return coll(m2, c->buf, c->n); /* re-set keeps position */
  int64_t n2;
  NtOrd *b2 = ord_append(c, k, &n2);
  return coll(m2, b2, n2);
}

static NtColl *coll_remove(NtColl *c, NtKey k, int has_val) {
  if (!nt_map_has(c->m, k)) return c; /* absent: pointer-stable no-op */
  NtMap *m2 = has_val ? nt_map_remove(c->m, k) : nt_set_remove(c->m, k);
  int64_t n2;
  NtOrd *b2 = ord_remove(c, k, &n2);
  return coll(m2, b2, n2);
}

NtColl *nt_map_put_slot(NtColl *c, int ktype, int64_t kslot, int64_t val) { return coll_put(c, ntk(ktype, kslot), val, 1); }
int64_t nt_map_get_slot(NtColl *c, int ktype, int64_t kslot)              { return nt_map_get(c->m, ntk(ktype, kslot)); }
int     nt_map_has_slot(NtColl *c, int ktype, int64_t kslot)              { return nt_map_has(c->m, ntk(ktype, kslot)); }
NtColl *nt_map_remove_slot(NtColl *c, int ktype, int64_t kslot)           { return coll_remove(c, ntk(ktype, kslot), 1); }

NtColl *nt_set_add_slot(NtColl *c, int ktype, int64_t kslot)    { return coll_put(c, ntk(ktype, kslot), 0, 0); }
int     nt_set_has_slot(NtColl *c, int ktype, int64_t kslot)    { return nt_set_has(c->m, ntk(ktype, kslot)); }
NtColl *nt_set_remove_slot(NtColl *c, int ktype, int64_t kslot) { return coll_remove(c, ntk(ktype, kslot), 0); }

/* ---- iteration: materialize the insertion-ordered keys/values -------------
 * `.keys()`/`.values()`/`.entries()` hand back a REAL NtArray (runtime.c's slot
 * vector), so for-of / spread / Array.from all reuse the array machinery and the
 * element order is exactly node's. Declared locally against an opaque type — the
 * array vector lives in runtime.c, which does not export a header. */
typedef struct NtArrayOpaque NtArrayOpaque;
extern NtArrayOpaque *nt_arr_new(double capd);
extern double nt_arr_push(NtArrayOpaque *a, int64_t slot);
extern double nt_arr_len(NtArrayOpaque *a);
extern int64_t nt_arr_get(NtArrayOpaque *a, double idxd);

/* `new Set(array)` — bulk construction. Routed through coll_put, the SAME path
 * `.add` takes, so dedup (SameValueZero, via ntk) and the insertion-order log are
 * maintained identically: a duplicate keeps its FIRST position and does not append. */
NtColl *nt_coll_set_from_arr(NtArrayOpaque *a, int ktype) {
  NtColl *c = nt_coll_set_new();
  int64_t n = (int64_t)nt_arr_len(a);
  for (int64_t i = 0; i < n; i++) c = coll_put(c, ntk(ktype, nt_arr_get(a, (double)i)), 0, 0);
  return c;
}

/* `new Map(otherMap)` — walk the source's insertion-order log and re-put each pair,
 * so the copy's own log is built in the same order. A FRESH handle, as node's copy is
 * (`new Map(a) === a` is false, and `===` on a Map is handle identity here). */
NtColl *nt_coll_map_from_coll(NtColl *src) {
  NtColl *c = nt_coll_map_new();
  for (int64_t i = 0; i < src->n; i++) {
    NtKey k; k.type = src->buf->ktype[i]; k.slot = src->buf->keys[i];
    c = coll_put(c, k, nt_map_get(src->m, k), 1);
  }
  return c;
}

NtArrayOpaque *nt_coll_keys(NtColl *c) {
  NtArrayOpaque *out = nt_arr_new((double)(c->n > 0 ? c->n : 1));
  for (int64_t i = 0; i < c->n; i++) nt_arr_push(out, c->buf->keys[i]);
  return out;
}

NtArrayOpaque *nt_coll_values(NtColl *c) {
  NtArrayOpaque *out = nt_arr_new((double)(c->n > 0 ? c->n : 1));
  for (int64_t i = 0; i < c->n; i++) {
    NtKey k; k.type = c->buf->ktype[i]; k.slot = c->buf->keys[i];
    nt_arr_push(out, nt_map_get(c->m, k));
  }
  return out;
}
