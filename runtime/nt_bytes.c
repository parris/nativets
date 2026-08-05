/*
 * nt_bytes.c — Uint8Array + TextEncoder/TextDecoder (UTF-8) for nativets (stdlib
 * batch 2, "bytes"). A Uint8Array is a compact byte buffer (`uint8_t[]`), NOT the
 * generic 8-byte-slot vector — one byte per element, matching the platform typed
 * array. UTF-8 encode/decode is trivial here: a nativets string is ALREADY a
 * NUL-terminated UTF-8 byte sequence (the source bytes flow through unchanged), so
 * encode = copy the bytes and decode = wrap them back into a string.
 *
 * libc-only (no other runtime deps beyond `nativets_alloc` / `nt_str_register`,
 * declared extern below), so it cross-links to every target. Linked ONLY when a
 * program actually calls one of these builtins (see driver.ts).
 */
#include "nt_bytes.h"
#include <string.h>
#include <math.h>

/* From runtime.c: the shared bump/GC allocator + the RC string side-table register
 * (a decoded string must join the RC table so scope-exit release balances it). */
extern void *nativets_alloc(size_t n);
extern void  nt_str_register(void *p);

/* Arrays are read through runtime.c's EXPORTED accessors, never through a local copy
 * of the NtArray layout. That copy used to exist here and silently went stale when
 * arrays gained persistent-trie storage (B2 step 2): past 32 elements the flat `data`
 * pointer is NULL, so reading it crashed. nt_arr_get/nt_arr_len are representation-
 * agnostic, so this file no longer cares how an array is stored. Slots hold a double
 * bit-cast to int64. */
extern int64_t nt_arr_get(void *a, double idx);
extern double  nt_arr_len(void *a);

/* JS ToUint8: NaN/±Inf -> 0; else truncate toward zero, then modulo 256 (wrap, not
 * clamp — that is Uint8ClampedArray). Done in double space so huge magnitudes that
 * overflow int64 still wrap correctly (fmod stays exact for integral doubles). */
static uint8_t to_uint8(double v) {
  if (!(v == v)) return 0;                 /* NaN */
  double t = trunc(v);
  double m = fmod(t, 256.0);               /* (-256, 256); Inf -> NaN below */
  if (!(m == m)) return 0;                 /* ±Inf */
  if (m < 0) m += 256.0;
  return (uint8_t)m;
}

NtBytes *nt_bytes_new(double nd) {
  int64_t n = (int64_t)nd;
  if (n < 0) n = 0;
  NtBytes *b = (NtBytes *)nativets_alloc(sizeof(NtBytes));
  b->len = n;
  b->data = (uint8_t *)nativets_alloc((size_t)(n > 0 ? n : 1));
  memset(b->data, 0, (size_t)n);
  return b;
}

NtBytes *nt_bytes_from_arr(void *arrp) {
  int64_t n = (int64_t)nt_arr_len(arrp);
  NtBytes *b = nt_bytes_new((double)n);
  for (int64_t i = 0; i < n; i++) {
    int64_t slot = nt_arr_get(arrp, (double)i);
    double d;
    memcpy(&d, &slot, sizeof d);
    b->data[i] = to_uint8(d);
  }
  return b;
}

double nt_bytes_get(NtBytes *b, double id) {
  int64_t i = (int64_t)id;
  if (i < 0 || i >= b->len) return 0;      /* OOB read is `undefined` in JS; 0 here (kept in-bounds by fixtures) */
  return (double)b->data[i];
}

void nt_bytes_set(NtBytes *b, double id, double v) {
  int64_t i = (int64_t)id;
  if (i < 0 || i >= b->len) return;        /* OOB write is a silent no-op for typed arrays */
  b->data[i] = to_uint8(v);
}

double nt_bytes_len(NtBytes *b) { return (double)b->len; }

NtBytes *nt_bytes_encode(const char *s) {
  size_t n = strlen(s);                    /* nativets strings are UTF-8 already */
  NtBytes *b = nt_bytes_new((double)n);
  memcpy(b->data, s, n);
  return b;
}

const char *nt_bytes_decode(NtBytes *b) {
  size_t n = (size_t)b->len;
  char *o = (char *)nativets_alloc(n + 1);
  memcpy(o, b->data, n);
  o[n] = 0;
  nt_str_register(o);                      /* join the RC table like any heap string */
  return o;
}
