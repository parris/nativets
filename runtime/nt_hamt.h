/*
 * nt_hamt.h — immutable Map/Set core for nativets (B2).
 *
 * Small maps (count <= NT_MAP_SMALL_MAX) are a sorted flat key array + parallel
 * value array that SHARES the key array on value-only updates. Large maps are a
 * Bagwell single-bitmap 32-way HAMT (5-bit slices, popcount indexing) with
 * collision nodes for full-hash collisions. Sets are the same layout, keys only.
 *
 * Conventions mirror runtime.c: every key/value is an 8-byte int64 slot (numbers
 * are double<->int64 bitcasts, strings are char* reinterpreted as int64), malloc
 * allocation on a never-free placeholder, and a live-node counter for tests.
 *
 * Key equality is SameValueZero (JS Map): NaN==NaN, +0==-0, and a number key is
 * never equal to a string key. The hash only routes; equality is the truth.
 */
#ifndef NT_HAMT_H
#define NT_HAMT_H

#include <stdint.h>

/* ---- key model ---- */
enum { NT_K_NUM = 0, NT_K_STR = 1 };
typedef struct { uint8_t type; int64_t slot; } NtKey;

/* ---- node kinds / slot tags / handle kinds ---- */
enum { NT_HAMT_BITMAP = 0, NT_HAMT_COLLISION = 1 };
enum { NT_C_LEAF = 0, NT_C_SUB = 1 };
enum { NT_MAP_SMALL = 0, NT_MAP_HAMT = 1 };

/* flat-map boundary (BEAM's small-map cutoff); the one tunable constant */
#define NT_MAP_SMALL_MAX 32

/* ---- small (sorted flat) map ---- */
typedef struct {
  int64_t  n, cap;
  uint8_t *ktype;   /* parallel key type tags   (len n) — shareable */
  int64_t *keys;    /* parallel key slots, SORTED (len n) — shareable */
  int64_t *vals;    /* parallel value slots     (len n) */
} NtSmall;

/* ---- HAMT node ---- */
typedef struct NtHamt {
  uint8_t   kind;    /* NT_HAMT_BITMAP | NT_HAMT_COLLISION */
  uint32_t  bitmap;  /* BITMAP: bit i set <=> slot i occupied */
  int32_t   count;   /* dense length: popcount(bitmap) for BITMAP, #entries for COLLISION */
  uint8_t  *ctype;   /* BITMAP: NT_C_LEAF|NT_C_SUB per dense slot; COLLISION: all LEAF */
  uint8_t  *ktype;   /* LEAF/entry key type tag */
  int64_t  *k;       /* LEAF: key slot;   SUBNODE: unused */
  int64_t  *v;       /* LEAF: value slot; SUBNODE: (int64_t)NtHamt* child */
} NtHamt;

/* ---- map/set handle ---- */
typedef struct {
  uint8_t  kind;      /* NT_MAP_SMALL | NT_MAP_HAMT */
  int64_t  count;
  int      has_vals;  /* 1 = map, 0 = set */
  NtSmall *small;
  NtHamt  *root;
} NtMap;

/* ---- key constructors (normalize -0 -> +0, NaN -> canonical) ---- */
NtKey nt_key_num(double d);
NtKey nt_key_str(const char *s);

/* ---- map API (immutable: every op returns a new handle, source untouched) ---- */
NtMap  *nt_map_new(void);
NtMap  *nt_map_put(NtMap *m, NtKey key, int64_t val);
int     nt_map_has(NtMap *m, NtKey key);
int64_t nt_map_get(NtMap *m, NtKey key);          /* miss -> 0; use nt_map_has to disambiguate */
NtMap  *nt_map_remove(NtMap *m, NtKey key);
int64_t nt_map_size(NtMap *m);

/* ---- set API (thin wrapper over the map core, keys only) ---- */
NtMap  *nt_set_new(void);
NtMap  *nt_set_add(NtMap *s, NtKey key);
int     nt_set_has(NtMap *s, NtKey key);
NtMap  *nt_set_remove(NtMap *s, NtKey key);
int64_t nt_set_size(NtMap *s);

/* ---- introspection (test builds) ---- */
int      nt_map_kind(NtMap *m);
int64_t *nt_small_keys(NtMap *m);   /* pointer identity for the share-check */
int64_t *nt_small_vals(NtMap *m);
NtHamt  *nt_hamt_root(NtMap *m);
NtHamt  *nt_hamt_child_ptr(NtHamt *node, int slot); /* subnode ptr at slot idx, or NULL */
int      nt_hamt_check(NtMap *m);   /* recursive structural-invariant validator: 1 ok, 0 bad */
double   nt_map_live(void);         /* live nodes (allocs - frees) */

/* ---- test-only hash hook: force exact slot placement & full-hash collisions ---- */
void     nt_map__set_hash_hook(uint32_t (*hook)(NtKey));
uint32_t nt_key_hash(NtKey k);      /* exposed so tests can predict routing */
int      nt_key_eq(NtKey a, NtKey b);

#endif /* NT_HAMT_H */
