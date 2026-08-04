/*
 * nt_hamt.c — immutable Map/Set core (see nt_hamt.h for the design summary).
 *
 * Layout: small sorted-flat maps that share the key array on value-only updates;
 * a Bagwell single-bitmap 32-way HAMT (5-bit slices, pos = popcount(bitmap &
 * (bit-1))) for large maps; collision nodes when the full 32-bit hash is
 * exhausted and still equal; collapse/demote on shrink to keep one canonical
 * representation per key-set. libc-only, never-free placeholder, live counter.
 */
#include "nt_hamt.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* ============================================================
 * allocation + live-node accounting (mirrors runtime.c discipline)
 * ============================================================ */
static long g_map_allocs = 0;
static long g_map_frees  = 0;

static void *xalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) { abort(); }
  return p;
}
double nt_map_live(void) { return (double)(g_map_allocs - g_map_frees); }

/* ============================================================
 * key hashing + SameValueZero equality
 * ============================================================ */
static uint32_t (*g_hash_hook)(NtKey) = NULL;
void nt_map__set_hash_hook(uint32_t (*hook)(NtKey)) { g_hash_hook = hook; }

static double slot_to_num(int64_t s) { double d; memcpy(&d, &s, 8); return d; }
static int64_t num_to_slot(double d) { int64_t s; memcpy(&s, &d, 8); return s; }

static uint32_t fnv1a(const unsigned char *p, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 16777619u; }
  return h;
}

uint32_t nt_key_hash(NtKey k) {
  if (g_hash_hook) return g_hash_hook(k);
  if (k.type == NT_K_NUM) {
    /* key slots are already normalized (see nt_key_num), so raw bytes are canonical */
    return fnv1a((const unsigned char *)&k.slot, 8);
  }
  const char *s = (const char *)(intptr_t)k.slot;
  return fnv1a((const unsigned char *)s, strlen(s));
}

int nt_key_eq(NtKey a, NtKey b) {
  if (a.type != b.type) return 0;               /* 1 != "1" */
  if (a.type == NT_K_NUM) {
    double x = slot_to_num(a.slot), y = slot_to_num(b.slot);
    if (isnan(x) && isnan(y)) return 1;          /* NaN == NaN */
    return x == y ? 1 : 0;                        /* +0 == -0 */
  }
  return strcmp((const char *)(intptr_t)a.slot, (const char *)(intptr_t)b.slot) == 0;
}

NtKey nt_key_num(double d) {
  NtKey k;
  k.type = NT_K_NUM;
  if (d == 0.0) d = 0.0;                          /* collapse -0 -> +0 */
  else if (isnan(d)) { uint64_t bits = 0x7ff8000000000000ULL; memcpy(&d, &bits, 8); }
  k.slot = num_to_slot(d);
  return k;
}
NtKey nt_key_str(const char *s) {
  NtKey k; k.type = NT_K_STR; k.slot = (int64_t)(intptr_t)s; return k;
}

/* total order over keys: (hash, type, slot/content). Consistent with nt_key_eq. */
static int key_cmp(NtKey a, uint32_t ha, NtKey b, uint32_t hb) {
  if (ha != hb) return ha < hb ? -1 : 1;
  if (a.type != b.type) return a.type < b.type ? -1 : 1;
  if (a.type == NT_K_NUM) {
    uint64_t ua = (uint64_t)a.slot, ub = (uint64_t)b.slot;
    if (ua == ub) return 0;
    return ua < ub ? -1 : 1;
  }
  return strcmp((const char *)(intptr_t)a.slot, (const char *)(intptr_t)b.slot);
}

static int popcnt(uint32_t x) { return __builtin_popcount(x); }

/* ============================================================
 * small (sorted flat) map
 * ============================================================ */
static NtSmall *small_alloc(int64_t n) {
  NtSmall *s = (NtSmall *)xalloc(sizeof(NtSmall)); g_map_allocs++;
  s->n = n; s->cap = n > 0 ? n : 1;
  s->ktype = (uint8_t *)xalloc((size_t)s->cap);
  s->keys  = (int64_t *)xalloc(sizeof(int64_t) * (size_t)s->cap);
  s->vals  = (int64_t *)xalloc(sizeof(int64_t) * (size_t)s->cap);
  return s;
}

/* binary search: returns index if found, else -(insertpos)-1 */
static int64_t small_find(NtSmall *s, NtKey key, uint32_t hash) {
  int64_t lo = 0, hi = s->n - 1;
  while (lo <= hi) {
    int64_t mid = (lo + hi) / 2;
    NtKey mk = { s->ktype[mid], s->keys[mid] };
    int c = key_cmp(key, hash, mk, nt_key_hash(mk));
    if (c == 0) return mid;
    if (c < 0) hi = mid - 1; else lo = mid + 1;
  }
  return -(lo) - 1;
}

static NtMap *map_wrap_small(NtSmall *s, int has_vals) {
  NtMap *m = (NtMap *)xalloc(sizeof(NtMap)); g_map_allocs++;
  m->kind = NT_MAP_SMALL; m->count = s->n; m->has_vals = has_vals;
  m->small = s; m->root = NULL;
  return m;
}
static NtMap *map_wrap_hamt(NtHamt *root, int64_t count, int has_vals) {
  NtMap *m = (NtMap *)xalloc(sizeof(NtMap)); g_map_allocs++;
  m->kind = NT_MAP_HAMT; m->count = count; m->has_vals = has_vals;
  m->small = NULL; m->root = root;
  return m;
}

/* ============================================================
 * HAMT node construction helpers (all produce fresh, path-copied nodes)
 * ============================================================ */
static NtHamt *hnode_alloc(uint8_t kind, int count) {
  NtHamt *n = (NtHamt *)xalloc(sizeof(NtHamt)); g_map_allocs++;
  int c = count > 0 ? count : 1;
  n->kind = kind; n->bitmap = 0; n->count = count;
  n->ctype = (uint8_t *)xalloc((size_t)c);
  n->ktype = (uint8_t *)xalloc((size_t)c);
  n->k     = (int64_t *)xalloc(sizeof(int64_t) * (size_t)c);
  n->v     = (int64_t *)xalloc(sizeof(int64_t) * (size_t)c);
  return n;
}

static NtHamt *bitmap_copy(NtHamt *node) {
  NtHamt *n = hnode_alloc(NT_HAMT_BITMAP, node->count);
  n->bitmap = node->bitmap;
  memcpy(n->ctype, node->ctype, (size_t)node->count);
  memcpy(n->ktype, node->ktype, (size_t)node->count);
  memcpy(n->k, node->k, sizeof(int64_t) * (size_t)node->count);
  memcpy(n->v, node->v, sizeof(int64_t) * (size_t)node->count);
  return n;
}

/* copy `node`, set leaf value at dense pos (value-only update) */
static NtHamt *bitmap_set_val(NtHamt *node, int pos, int64_t val) {
  NtHamt *n = bitmap_copy(node); n->v[pos] = val; return n;
}
/* copy `node`, replace subnode child at dense pos */
static NtHamt *bitmap_set_sub(NtHamt *node, int pos, NtHamt *child) {
  NtHamt *n = bitmap_copy(node);
  n->ctype[pos] = NT_C_SUB; n->v[pos] = (int64_t)(intptr_t)child; return n;
}
/* copy `node`, replace slot at dense pos with an inlined LEAF */
static NtHamt *bitmap_set_leaf(NtHamt *node, int pos, uint8_t kt, int64_t k, int64_t v) {
  NtHamt *n = bitmap_copy(node);
  n->ctype[pos] = NT_C_LEAF; n->ktype[pos] = kt; n->k[pos] = k; n->v[pos] = v; return n;
}
/* copy `node`, splice a new LEAF into dense pos, set bit `idx` */
static NtHamt *bitmap_insert_leaf(NtHamt *node, int pos, int idx, NtKey key, int64_t val) {
  NtHamt *n = hnode_alloc(NT_HAMT_BITMAP, node->count + 1);
  n->bitmap = node->bitmap | (1u << idx);
  for (int i = 0; i < pos; i++) {
    n->ctype[i] = node->ctype[i]; n->ktype[i] = node->ktype[i];
    n->k[i] = node->k[i]; n->v[i] = node->v[i];
  }
  n->ctype[pos] = NT_C_LEAF; n->ktype[pos] = key.type; n->k[pos] = key.slot; n->v[pos] = val;
  for (int i = pos; i < node->count; i++) {
    n->ctype[i + 1] = node->ctype[i]; n->ktype[i + 1] = node->ktype[i];
    n->k[i + 1] = node->k[i]; n->v[i + 1] = node->v[i];
  }
  return n;
}
/* copy `node`, splice OUT dense pos, clear its bit */
static NtHamt *bitmap_remove_pos(NtHamt *node, int pos, int idx) {
  NtHamt *n = hnode_alloc(NT_HAMT_BITMAP, node->count - 1);
  n->bitmap = node->bitmap & ~(1u << idx);
  int j = 0;
  for (int i = 0; i < node->count; i++) {
    if (i == pos) continue;
    n->ctype[j] = node->ctype[i]; n->ktype[j] = node->ktype[i];
    n->k[j] = node->k[i]; n->v[j] = node->v[i]; j++;
  }
  return n;
}

/* collision node with two entries */
static NtHamt *make_collision2(NtKey a, int64_t av, NtKey b, int64_t bv) {
  NtHamt *n = hnode_alloc(NT_HAMT_COLLISION, 2);
  n->ctype[0] = NT_C_LEAF; n->ktype[0] = a.type; n->k[0] = a.slot; n->v[0] = av;
  n->ctype[1] = NT_C_LEAF; n->ktype[1] = b.type; n->k[1] = b.slot; n->v[1] = bv;
  return n;
}
static NtHamt *collision_append(NtHamt *node, NtKey key, int64_t val) {
  NtHamt *n = hnode_alloc(NT_HAMT_COLLISION, node->count + 1);
  memcpy(n->ctype, node->ctype, (size_t)node->count);
  memcpy(n->ktype, node->ktype, (size_t)node->count);
  memcpy(n->k, node->k, sizeof(int64_t) * (size_t)node->count);
  memcpy(n->v, node->v, sizeof(int64_t) * (size_t)node->count);
  int p = node->count;
  n->ctype[p] = NT_C_LEAF; n->ktype[p] = key.type; n->k[p] = key.slot; n->v[p] = val;
  return n;
}
static NtHamt *collision_set_val(NtHamt *node, int pos, int64_t val) {
  NtHamt *n = hnode_alloc(NT_HAMT_COLLISION, node->count);
  memcpy(n->ctype, node->ctype, (size_t)node->count);
  memcpy(n->ktype, node->ktype, (size_t)node->count);
  memcpy(n->k, node->k, sizeof(int64_t) * (size_t)node->count);
  memcpy(n->v, node->v, sizeof(int64_t) * (size_t)node->count);
  n->v[pos] = val;
  return n;
}
static NtHamt *collision_without(NtHamt *node, int drop) {
  NtHamt *n = hnode_alloc(NT_HAMT_COLLISION, node->count - 1);
  int j = 0;
  for (int i = 0; i < node->count; i++) {
    if (i == drop) continue;
    n->ctype[j] = node->ctype[i]; n->ktype[j] = node->ktype[i];
    n->k[j] = node->k[i]; n->v[j] = node->v[i]; j++;
  }
  return n;
}

/* single-SUBNODE bitmap node (a required link in a shared-prefix chain) */
static NtHamt *make_bitmap_single_sub(int idx, NtHamt *child) {
  NtHamt *n = hnode_alloc(NT_HAMT_BITMAP, 1);
  n->bitmap = (1u << idx);
  n->ctype[0] = NT_C_SUB; n->k[0] = 0; n->v[0] = (int64_t)(intptr_t)child;
  return n;
}
/* bitmap node holding two leaves at distinct slots i1,i2 (dense in slot order) */
static NtHamt *make_bitmap_two_leaves(int i1, NtKey k1, int64_t v1,
                                      int i2, NtKey k2, int64_t v2) {
  NtHamt *n = hnode_alloc(NT_HAMT_BITMAP, 2);
  n->bitmap = (1u << i1) | (1u << i2);
  /* lower slot index goes into dense[0] */
  int lo_first = i1 < i2;
  NtKey  ka = lo_first ? k1 : k2; int64_t va = lo_first ? v1 : v2;
  NtKey  kb = lo_first ? k2 : k1; int64_t vb = lo_first ? v2 : v1;
  n->ctype[0] = NT_C_LEAF; n->ktype[0] = ka.type; n->k[0] = ka.slot; n->v[0] = va;
  n->ctype[1] = NT_C_LEAF; n->ktype[1] = kb.type; n->k[1] = kb.slot; n->v[1] = vb;
  return n;
}

/* split two distinct keys starting at depth d into a fresh subtree */
static NtHamt *make_split(int d, NtKey k1, uint32_t h1, int64_t v1,
                          NtKey k2, uint32_t h2, int64_t v2) {
  if (h1 == h2 || d >= 7) return make_collision2(k1, v1, k2, v2);
  int i1 = (int)((h1 >> (5 * d)) & 31);
  int i2 = (int)((h2 >> (5 * d)) & 31);
  if (i1 == i2) {
    NtHamt *child = make_split(d + 1, k1, h1, v1, k2, h2, v2);
    return make_bitmap_single_sub(i1, child);
  }
  return make_bitmap_two_leaves(i1, k1, v1, i2, k2, v2);
}

/* ============================================================
 * HAMT get / put
 * ============================================================ */
static int hamt_get(NtHamt *node, int d, NtKey key, uint32_t hash, int64_t *out) {
  for (;;) {
    if (node->kind == NT_HAMT_COLLISION) {
      for (int i = 0; i < node->count; i++) {
        NtKey ek = { node->ktype[i], node->k[i] };
        if (nt_key_eq(ek, key)) { *out = node->v[i]; return 1; }
      }
      return 0;
    }
    int idx = (int)((hash >> (5 * d)) & 31);
    uint32_t bit = 1u << idx;
    if (!(node->bitmap & bit)) return 0;
    int pos = popcnt(node->bitmap & (bit - 1));
    if (node->ctype[pos] == NT_C_LEAF) {
      NtKey ek = { node->ktype[pos], node->k[pos] };
      if (nt_key_eq(ek, key)) { *out = node->v[pos]; return 1; }
      return 0;
    }
    node = (NtHamt *)(intptr_t)node->v[pos];
    d++;
  }
}

static NtHamt *hamt_put(NtHamt *node, int d, NtKey key, uint32_t hash, int64_t val, int *added) {
  if (node->kind == NT_HAMT_COLLISION) {
    for (int i = 0; i < node->count; i++) {
      NtKey ek = { node->ktype[i], node->k[i] };
      if (nt_key_eq(ek, key)) { *added = 0; return collision_set_val(node, i, val); }
    }
    *added = 1; return collision_append(node, key, val);
  }
  int idx = (int)((hash >> (5 * d)) & 31);
  uint32_t bit = 1u << idx;
  int pos = popcnt(node->bitmap & (bit - 1));
  if (!(node->bitmap & bit)) {
    *added = 1; return bitmap_insert_leaf(node, pos, idx, key, val);
  }
  if (node->ctype[pos] == NT_C_LEAF) {
    NtKey ek = { node->ktype[pos], node->k[pos] };
    if (nt_key_eq(ek, key)) { *added = 0; return bitmap_set_val(node, pos, val); }
    uint32_t eh = nt_key_hash(ek);
    NtHamt *sub = make_split(d + 1, ek, eh, node->v[pos], key, hash, val);
    *added = 1; return bitmap_set_sub(node, pos, sub);
  }
  NtHamt *child = (NtHamt *)(intptr_t)node->v[pos];
  NtHamt *nc = hamt_put(child, d + 1, key, hash, val, added);
  return bitmap_set_sub(node, pos, nc);
}

/* ============================================================
 * HAMT remove (with collapse / canonicalization)
 * ============================================================ */
enum { R_UNCHANGED = 0, R_NODE = 1, R_LEAF = 2, R_EMPTY = 3 };
typedef struct { int kind; NtHamt *node; uint8_t lkt; int64_t lk, lv; } RemoveRes;

static RemoveRes finalize_bitmap(NtHamt *nn) {
  RemoveRes r;
  if (nn->count == 0) { r.kind = R_EMPTY; return r; }
  if (nn->count == 1 && nn->ctype[0] == NT_C_LEAF) {
    r.kind = R_LEAF; r.lkt = nn->ktype[0]; r.lk = nn->k[0]; r.lv = nn->v[0]; return r;
  }
  r.kind = R_NODE; r.node = nn; return r;
}

static RemoveRes hamt_remove(NtHamt *node, int d, NtKey key, uint32_t hash) {
  RemoveRes r;
  if (node->kind == NT_HAMT_COLLISION) {
    int found = -1;
    for (int i = 0; i < node->count; i++) {
      NtKey ek = { node->ktype[i], node->k[i] };
      if (nt_key_eq(ek, key)) { found = i; break; }
    }
    if (found < 0) { r.kind = R_UNCHANGED; return r; }
    if (node->count == 2) {
      int o = found == 0 ? 1 : 0;
      r.kind = R_LEAF; r.lkt = node->ktype[o]; r.lk = node->k[o]; r.lv = node->v[o]; return r;
    }
    r.kind = R_NODE; r.node = collision_without(node, found); return r;
  }
  int idx = (int)((hash >> (5 * d)) & 31);
  uint32_t bit = 1u << idx;
  if (!(node->bitmap & bit)) { r.kind = R_UNCHANGED; return r; }
  int pos = popcnt(node->bitmap & (bit - 1));
  if (node->ctype[pos] == NT_C_LEAF) {
    NtKey ek = { node->ktype[pos], node->k[pos] };
    if (!nt_key_eq(ek, key)) { r.kind = R_UNCHANGED; return r; }
    return finalize_bitmap(bitmap_remove_pos(node, pos, idx));
  }
  NtHamt *child = (NtHamt *)(intptr_t)node->v[pos];
  RemoveRes cr = hamt_remove(child, d + 1, key, hash);
  if (cr.kind == R_UNCHANGED) { r.kind = R_UNCHANGED; return r; }
  NtHamt *nn;
  if (cr.kind == R_EMPTY)      nn = bitmap_remove_pos(node, pos, idx);
  else if (cr.kind == R_LEAF)  nn = bitmap_set_leaf(node, pos, cr.lkt, cr.lk, cr.lv);
  else                         nn = bitmap_set_sub(node, pos, cr.node);
  return finalize_bitmap(nn);
}

/* ============================================================
 * HAMT enumeration (for demotion)
 * ============================================================ */
typedef struct { uint8_t *kt; int64_t *k; int64_t *v; int n; } Entries;
static void hamt_collect(NtHamt *node, Entries *e) {
  if (node->kind == NT_HAMT_COLLISION) {
    for (int i = 0; i < node->count; i++) {
      e->kt[e->n] = node->ktype[i]; e->k[e->n] = node->k[i]; e->v[e->n] = node->v[i]; e->n++;
    }
    return;
  }
  for (int i = 0; i < node->count; i++) {
    if (node->ctype[i] == NT_C_LEAF) {
      e->kt[e->n] = node->ktype[i]; e->k[e->n] = node->k[i]; e->v[e->n] = node->v[i]; e->n++;
    } else {
      hamt_collect((NtHamt *)(intptr_t)node->v[i], e);
    }
  }
}

/* build a canonical sorted small map from an unordered entry list */
static NtSmall *small_from_entries(Entries *e) {
  NtSmall *s = small_alloc(e->n);
  s->n = 0;
  for (int i = 0; i < e->n; i++) {
    NtKey key = { e->kt[i], e->k[i] };
    uint32_t h = nt_key_hash(key);
    /* insertion sort into (already sorted) prefix */
    int64_t pos = s->n;
    while (pos > 0) {
      NtKey pk = { s->ktype[pos - 1], s->keys[pos - 1] };
      if (key_cmp(key, h, pk, nt_key_hash(pk)) < 0) pos--; else break;
    }
    for (int64_t j = s->n; j > pos; j--) {
      s->ktype[j] = s->ktype[j - 1]; s->keys[j] = s->keys[j - 1]; s->vals[j] = s->vals[j - 1];
    }
    s->ktype[pos] = e->kt[i]; s->keys[pos] = e->k[i]; s->vals[pos] = e->v[i];
    s->n++;
  }
  return s;
}

/* build a HAMT from an entry list (for promotion) */
static NtHamt *hamt_from_entries(Entries *e) {
  NtHamt *root = hnode_alloc(NT_HAMT_BITMAP, 0); /* empty */
  for (int i = 0; i < e->n; i++) {
    NtKey key = { e->kt[i], e->k[i] };
    int added;
    root = hamt_put(root, 0, key, nt_key_hash(key), e->v[i], &added);
  }
  return root;
}

/* ============================================================
 * top-level map ops
 * ============================================================ */
NtMap *nt_map_new(void) {
  NtSmall *s = small_alloc(0);
  return map_wrap_small(s, 1);
}

int64_t nt_map_size(NtMap *m) { return m->count; }

int64_t nt_map_get(NtMap *m, NtKey key) {
  uint32_t h = nt_key_hash(key);
  if (m->kind == NT_MAP_SMALL) {
    int64_t i = small_find(m->small, key, h);
    return i >= 0 ? m->small->vals[i] : 0;
  }
  int64_t out;
  return hamt_get(m->root, 0, key, h, &out) ? out : 0;
}

int nt_map_has(NtMap *m, NtKey key) {
  uint32_t h = nt_key_hash(key);
  if (m->kind == NT_MAP_SMALL) return small_find(m->small, key, h) >= 0;
  int64_t out;
  return hamt_get(m->root, 0, key, h, &out);
}

NtMap *nt_map_put(NtMap *m, NtKey key, int64_t val) {
  uint32_t h = nt_key_hash(key);
  if (m->kind == NT_MAP_SMALL) {
    NtSmall *s = m->small;
    int64_t i = small_find(s, key, h);
    if (i >= 0) {
      /* value-only update: SHARE keys/ktype arrays, fresh vals */
      NtSmall *ns = (NtSmall *)xalloc(sizeof(NtSmall)); g_map_allocs++;
      ns->n = s->n; ns->cap = s->n > 0 ? s->n : 1;
      ns->ktype = s->ktype; ns->keys = s->keys;      /* shared! */
      ns->vals = (int64_t *)xalloc(sizeof(int64_t) * (size_t)ns->cap);
      memcpy(ns->vals, s->vals, sizeof(int64_t) * (size_t)s->n);
      ns->vals[i] = val;
      return map_wrap_small(ns, m->has_vals);
    }
    /* new key */
    if (s->n + 1 <= NT_MAP_SMALL_MAX) {
      int64_t pos = -(i) - 1;
      NtSmall *ns = small_alloc(s->n + 1);
      for (int64_t j = 0; j < pos; j++) { ns->ktype[j] = s->ktype[j]; ns->keys[j] = s->keys[j]; ns->vals[j] = s->vals[j]; }
      ns->ktype[pos] = key.type; ns->keys[pos] = key.slot; ns->vals[pos] = val;
      for (int64_t j = pos; j < s->n; j++) { ns->ktype[j + 1] = s->ktype[j]; ns->keys[j + 1] = s->keys[j]; ns->vals[j + 1] = s->vals[j]; }
      return map_wrap_small(ns, m->has_vals);
    }
    /* promote to HAMT: small entries + new one */
    int total = (int)s->n + 1;
    uint8_t *kt = (uint8_t *)xalloc((size_t)total);
    int64_t *k = (int64_t *)xalloc(sizeof(int64_t) * (size_t)total);
    int64_t *v = (int64_t *)xalloc(sizeof(int64_t) * (size_t)total);
    for (int64_t j = 0; j < s->n; j++) { kt[j] = s->ktype[j]; k[j] = s->keys[j]; v[j] = s->vals[j]; }
    kt[s->n] = key.type; k[s->n] = key.slot; v[s->n] = val;
    Entries e = { kt, k, v, total };
    NtHamt *root = hamt_from_entries(&e);
    return map_wrap_hamt(root, total, m->has_vals);
  }
  /* HAMT put */
  int added;
  NtHamt *root = hamt_put(m->root, 0, key, h, val, &added);
  return map_wrap_hamt(root, m->count + (added ? 1 : 0), m->has_vals);
}

NtMap *nt_map_remove(NtMap *m, NtKey key) {
  uint32_t h = nt_key_hash(key);
  if (m->kind == NT_MAP_SMALL) {
    NtSmall *s = m->small;
    int64_t i = small_find(s, key, h);
    if (i < 0) return m;                     /* absent: pointer-stable no-op */
    NtSmall *ns = small_alloc(s->n - 1 > 0 ? s->n - 1 : 0);
    ns->n = s->n - 1;
    int64_t j = 0;
    for (int64_t x = 0; x < s->n; x++) {
      if (x == i) continue;
      ns->ktype[j] = s->ktype[x]; ns->keys[j] = s->keys[x]; ns->vals[j] = s->vals[x]; j++;
    }
    return map_wrap_small(ns, m->has_vals);
  }
  /* HAMT remove */
  RemoveRes r = hamt_remove(m->root, 0, key, h);
  if (r.kind == R_UNCHANGED) return m;       /* absent: reuse source root */
  int64_t newcount = m->count - 1;
  if (newcount <= NT_MAP_SMALL_MAX) {
    /* demote to canonical sorted small */
    uint8_t *kt = (uint8_t *)xalloc((size_t)(newcount > 0 ? newcount : 1));
    int64_t *k = (int64_t *)xalloc(sizeof(int64_t) * (size_t)(newcount > 0 ? newcount : 1));
    int64_t *v = (int64_t *)xalloc(sizeof(int64_t) * (size_t)(newcount > 0 ? newcount : 1));
    Entries e = { kt, k, v, 0 };
    if (r.kind == R_NODE)      hamt_collect(r.node, &e);
    else if (r.kind == R_LEAF) { e.kt[0] = r.lkt; e.k[0] = r.lk; e.v[0] = r.lv; e.n = 1; }
    /* R_EMPTY -> 0 entries */
    NtSmall *ns = small_from_entries(&e);
    return map_wrap_small(ns, m->has_vals);
  }
  /* stays HAMT (count large => result is a NODE) */
  return map_wrap_hamt(r.node, newcount, m->has_vals);
}

/* ============================================================
 * sets (thin wrapper: keys only, unit value, idempotent add)
 * ============================================================ */
NtMap  *nt_set_new(void) { NtSmall *s = small_alloc(0); return map_wrap_small(s, 0); }
NtMap  *nt_set_add(NtMap *s, NtKey key) {
  if (nt_map_has(s, key)) return s;          /* idempotent, pointer-stable */
  return nt_map_put(s, key, 1);
}
int     nt_set_has(NtMap *s, NtKey key) { return nt_map_has(s, key); }
NtMap  *nt_set_remove(NtMap *s, NtKey key) { return nt_map_remove(s, key); }
int64_t nt_set_size(NtMap *s) { return s->count; }

/* ============================================================
 * introspection + structural-invariant validator
 * ============================================================ */
int      nt_map_kind(NtMap *m) { return m->kind; }
int64_t *nt_small_keys(NtMap *m) { return m->kind == NT_MAP_SMALL ? m->small->keys : NULL; }
int64_t *nt_small_vals(NtMap *m) { return m->kind == NT_MAP_SMALL ? m->small->vals : NULL; }
NtHamt  *nt_hamt_root(NtMap *m) { return m->kind == NT_MAP_HAMT ? m->root : NULL; }

NtHamt  *nt_hamt_child_ptr(NtHamt *node, int slot) {
  if (!node || node->kind != NT_HAMT_BITMAP) return NULL;
  uint32_t bit = 1u << slot;
  if (!(node->bitmap & bit)) return NULL;
  int pos = popcnt(node->bitmap & (bit - 1));
  if (node->ctype[pos] != NT_C_SUB) return NULL;
  return (NtHamt *)(intptr_t)node->v[pos];
}

static int check_node(NtHamt *node, int d, int is_root) {
  if (node->kind == NT_HAMT_COLLISION) {
    if (node->count < 2) return 0;
    NtKey k0 = { node->ktype[0], node->k[0] };
    uint32_t h0 = nt_key_hash(k0);
    for (int i = 0; i < node->count; i++) {
      NtKey ki = { node->ktype[i], node->k[i] };
      if (node->ctype[i] != NT_C_LEAF) return 0;
      if (nt_key_hash(ki) != h0) return 0;                /* all share full hash */
      for (int j = i + 1; j < node->count; j++) {
        NtKey kj = { node->ktype[j], node->k[j] };
        if (nt_key_eq(ki, kj)) return 0;                  /* pairwise distinct */
      }
    }
    return 1;
  }
  /* BITMAP */
  if (popcnt(node->bitmap) != node->count) return 0;      /* central sparse invariant */
  if (node->count == 0 && !is_root) return 0;
  if (node->count == 1 && node->ctype[0] == NT_C_LEAF && !is_root) return 0; /* singleton leaf must inline */
  /* walk dense slots in ascending slot order */
  int pos = 0;
  for (int si = 0; si < 32; si++) {
    if (!(node->bitmap & (1u << si))) continue;
    if (pos != popcnt(node->bitmap & ((1u << si) - 1))) return 0;
    if (node->ctype[pos] == NT_C_LEAF) {
      NtKey key = { node->ktype[pos], node->k[pos] };
      uint32_t h = nt_key_hash(key);
      if ((int)((h >> (5 * d)) & 31) != si) return 0;      /* routes to its slot */
    } else {
      NtHamt *child = (NtHamt *)(intptr_t)node->v[pos];
      if (!child) return 0;
      if (!check_node(child, d + 1, 0)) return 0;
    }
    pos++;
  }
  return 1;
}

int nt_hamt_check(NtMap *m) {
  if (m->kind == NT_MAP_SMALL) {
    NtSmall *s = m->small;
    if (s->n != m->count) return 0;
    if (m->count > NT_MAP_SMALL_MAX) return 0;             /* canonical kind */
    for (int64_t i = 1; i < s->n; i++) {
      NtKey a = { s->ktype[i - 1], s->keys[i - 1] };
      NtKey b = { s->ktype[i], s->keys[i] };
      if (key_cmp(a, nt_key_hash(a), b, nt_key_hash(b)) >= 0) return 0; /* strictly sorted */
    }
    return 1;
  }
  if (m->count <= NT_MAP_SMALL_MAX) return 0;              /* canonical kind */
  return check_node(m->root, 0, 1);
}
