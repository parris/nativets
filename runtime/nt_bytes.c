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
#include <stdio.h>  /* snprintf, for nt_bytes_json */
#include <stdlib.h> /* abort, for the invalid-length panic */

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

/* ES 23.2.5.1 -> ToIndex: NaN maps to 0, a fraction truncates, and anything negative or
 * past 2^53-1 is a RangeError. node: `RangeError: Invalid typed array length: -1`.
 *
 * The LENGTH is decided in DOUBLE space for the same reason `to_uint8` above does its
 * arithmetic there, and this is the case that proves the rule. `(int64_t)nd` on a
 * non-finite or out-of-range double is UNDEFINED in C, and the two hosts disagree in the
 * worst possible way (the split `nt_to_integer_or_infinity` in runtime.c was written for):
 * arm64 SATURATES to INT64_MAX, so `new Uint8Array(1e30)` tried to allocate that and died
 * "out of memory"; x86-64 yields INT64_MIN, which the old `if (n < 0) n = 0` guard then
 * turned into a SILENT length-0 array at exit 0. Same source, same program, answer decided
 * by the host — and the silent side is the architecture CI runs on.
 *
 * A negative length was wrong on both hosts anyway: we answered 0 where node throws. The
 * header documented that as "n<0 -> 0", which read as a decision rather than the bug it
 * was. */
#define NT_MAX_BYTES_LEN 9007199254740991.0 /* 2^53-1, ToIndex's ceiling */

static void nt_panic_bytes_len(double want) {
  char w[64];
  /* %.17g so a huge or fractional argument is reported as WRITTEN rather than rounded
     into looking valid; `inf` prints as `inf`, which is the answer node names too. */
  snprintf(w, sizeof(w), "%.17g", want);
  fflush(stdout);
  fprintf(stderr, "panic: invalid typed array length: %s\n", w);
  fprintf(stderr, "  help: a Uint8Array length must be a non-negative integer no larger "
                  "than 2^53-1; node throws `RangeError: Invalid typed array length` here\n");
  fflush(stderr);
  abort();
}

NtBytes *nt_bytes_new(double nd) {
  double d = (nd != nd) ? 0.0 : trunc(nd);   /* NaN -> 0, per ToIndex */
  if (d < 0.0 || d > NT_MAX_BYTES_LEN) nt_panic_bytes_len(nd);
  int64_t n = (int64_t)d;                    /* in range by the guard above */
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
  if (i < 0 || i >= b->len) return 0;      /* internal accessor: in-bounds by construction */
  return (double)b->data[i];
}

void nt_bytes_set(NtBytes *b, double id, double v) {
  int64_t i = (int64_t)id;
  if (i < 0 || i >= b->len) return;        /* internal accessor: in-bounds by construction */
  b->data[i] = to_uint8(v);
}

/* `u[i]` / `u[i] = v` as WRITTEN in the source. A typed array's OOB read is `undefined`
 * in JS and its OOB WRITE is a SILENT NO-OP — the worst of the old policies, because the
 * program then reads back a value it believes it stored. Both panic here. (Declared in
 * runtime.c, which is always linked; nt_bytes.c is linked only when a program uses bytes.) */
extern void nt_panic_bounds(const char *what, double len, double idx, const char *loc);

/* Guarded copy of runtime.c's index predicate — a separate translation unit with no
 * shared runtime header. runtime.c holds the definition of record and the reasoning:
 * NaN, ±Inf and any FRACTION are not indices (node reads `undefined` for `u[1.5]`, it
 * does not truncate to `u[1]`), so they are out of bounds rather than truncated. */
#ifndef NT_IS_INDEX
#define NT_IS_INDEX(d) (floor(d) == (d) && !isinf(d))
#endif

double nt_bytes_index(NtBytes *b, double id, const char *loc) {
  int64_t i = (int64_t)id;
  if (!NT_IS_INDEX(id) || i < 0 || i >= b->len) nt_panic_bounds("Uint8Array index", (double)b->len, id, loc);
  return (double)b->data[i];
}

/* NOTE the `what`: "Uint8Array WRITE index", not the read's "Uint8Array index". It is the
 * key `nt_panic_bounds` composes the help line from, and the write is the one caller for
 * which `.at()` — a READ — cannot express the operation at all. It used to share the
 * read's string and was therefore told to "use `.at(i)`". */
void nt_bytes_index_set(NtBytes *b, double id, double v, const char *loc) {
  int64_t i = (int64_t)id;
  if (!NT_IS_INDEX(id) || i < 0 || i >= b->len) nt_panic_bounds("Uint8Array write index", (double)b->len, id, loc);
  b->data[i] = to_uint8(v);
}

double nt_bytes_len(NtBytes *b) { return (double)b->len; }

/* JSON for a Uint8Array (codegen `genJsonStringify`).
 *
 * `JSON.stringify` walks a value's own ENUMERABLE properties, and a typed array's
 * are its INDICES — so node writes an index-keyed OBJECT, `{"0":1,"1":255}`, not
 * the array form `[1,255]`. An empty buffer is `{}`, inline even under an indent,
 * exactly as node prints an empty object. This used to fall through to the literal
 * `null`.
 *
 * `unit` is the compile-time indent unit ("" = compact) and `depth` the nesting
 * level, so entries sit at depth+1 and the closing brace at the parent's depth —
 * the same contract `genJsonObject` follows. */
const char *nt_bytes_json(NtBytes *b, const char *unit, double depth) {
  int64_t n = b->len;
  if (n == 0) return "{}";
  size_t ulen = strlen(unit);
  int64_t d = (int64_t)depth;
  /* Per entry: `"<index>": <0..255>,` plus a newline and the inner indent. 32 covers
   * the punctuation and the widest index/value an int64 length can produce. */
  size_t cap = (size_t)n * (32 + ulen * (size_t)(d + 1) + 1) + ulen * (size_t)d + 8;
  char *out = (char *)nativets_alloc(cap);
  size_t k = 0;
  out[k++] = '{';
  for (int64_t i = 0; i < n; i++) {
    if (i > 0) out[k++] = ',';
    if (ulen > 0) {
      out[k++] = '\n';
      for (int64_t j = 0; j <= d; j++) { memcpy(out + k, unit, ulen); k += ulen; }
    }
    k += (size_t)snprintf(out + k, cap - k, ulen > 0 ? "\"%lld\": %u" : "\"%lld\":%u",
                          (long long)i, (unsigned)b->data[i]);
  }
  if (ulen > 0) {
    out[k++] = '\n';
    for (int64_t j = 0; j < d; j++) { memcpy(out + k, unit, ulen); k += ulen; }
  }
  out[k++] = '}';
  out[k] = 0;
  nt_str_register(out);                    /* join the RC table like any heap string */
  return out;
}

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
