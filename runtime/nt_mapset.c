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
 * Additive: this file is NEW and only calls the public nt_hamt.h API — nt_hamt.c
 * is untouched. Linked (with nt_hamt.c) only when a program uses Map/Set.
 */
#include "nt_hamt.h"
#include <string.h>

static NtKey ntk(int ktype, int64_t slot) {
  if (ktype == NT_K_STR) return nt_key_str((const char *)slot);
  double d;
  memcpy(&d, &slot, sizeof d);
  return nt_key_num(d);
}

NtMap  *nt_map_put_slot(NtMap *m, int ktype, int64_t kslot, int64_t val) { return nt_map_put(m, ntk(ktype, kslot), val); }
int64_t nt_map_get_slot(NtMap *m, int ktype, int64_t kslot)              { return nt_map_get(m, ntk(ktype, kslot)); }
int     nt_map_has_slot(NtMap *m, int ktype, int64_t kslot)             { return nt_map_has(m, ntk(ktype, kslot)); }
NtMap  *nt_map_remove_slot(NtMap *m, int ktype, int64_t kslot)          { return nt_map_remove(m, ntk(ktype, kslot)); }

NtMap  *nt_set_add_slot(NtMap *s, int ktype, int64_t kslot)    { return nt_set_add(s, ntk(ktype, kslot)); }
int     nt_set_has_slot(NtMap *s, int ktype, int64_t kslot)    { return nt_set_has(s, ntk(ktype, kslot)); }
NtMap  *nt_set_remove_slot(NtMap *s, int ktype, int64_t kslot) { return nt_set_remove(s, ntk(ktype, kslot)); }
