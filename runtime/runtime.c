/*
 * nativets runtime — the tiny native support library linked into every program.
 *
 * Design constraints:
 *   - Depends ONLY on libc (stdio/string/stdlib/math). No external libraries, so
 *     it cross-compiles+links unchanged for macOS, iOS, and Android.
 *   - Memory safety by construction: we allocate and NEVER free. No manual free
 *     means no use-after-free and no double-free — the whole class of bugs is
 *     gone. Reclamation (a precise/tracing GC) can be added later behind
 *     nativets_alloc without touching generated code.
 *
 * Value representations in generated IR:
 *   number  -> double
 *   boolean -> i1 (widened to i32 across this ABI)
 *   string  -> ptr to a NUL-terminated UTF-8 byte buffer (JS .length is byte
 *              length here; true UTF-16 length is a tracked divergence)
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>

/* ---- allocation (never-free; see header comment) ---- */

void *nativets_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) {
    fputs("nativets: out of memory\n", stderr);
    abort();
  }
  return p;
}

/* ---- number -> string, matching JS Number#toString / node console.log ---- */

static void js_number_to_string(double v, char *out, size_t out_len) {
  if (isnan(v)) { snprintf(out, out_len, "NaN"); return; }
  if (isinf(v)) { snprintf(out, out_len, v < 0 ? "-Infinity" : "Infinity"); return; }
  if (v == 0.0) { snprintf(out, out_len, "0"); return; } /* also collapses -0 -> "0" */

  if (v == floor(v) && fabs(v) < 1e21) {
    snprintf(out, out_len, "%.0f", v);
    return;
  }
  for (int prec = 1; prec <= 17; prec++) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*g", prec, v);
    if (strtod(buf, NULL) == v) {
      snprintf(out, out_len, "%s", buf);
      return;
    }
  }
  snprintf(out, out_len, "%.17g", v);
}

/* ---- console.log building blocks ---- */

void js_print_num(double v) {
  char buf[64];
  js_number_to_string(v, buf, sizeof(buf));
  fputs(buf, stdout);
}

void js_print_bool(int32_t b) {
  fputs(b ? "true" : "false", stdout);
}

void js_print_str(const char *s) {
  fputs(s, stdout);
}

void js_print_sep(void) { fputc(' ', stdout); }
void js_print_newline(void) { fputc('\n', stdout); }

/* ---- string operations ---- */

const char *js_str_concat(const char *a, const char *b) {
  size_t la = strlen(a), lb = strlen(b);
  char *out = (char *)nativets_alloc(la + lb + 1);
  memcpy(out, a, la);
  memcpy(out + la, b, lb);
  out[la + lb] = '\0';
  return out;
}

double js_str_len(const char *s) { return (double)strlen(s); }

int32_t js_str_eq(const char *a, const char *b) { return strcmp(a, b) == 0 ? 1 : 0; }

/* number -> string, allocated (for template literals / string coercion) */
const char *js_num_to_str(double v) {
  char buf[64];
  js_number_to_string(v, buf, sizeof(buf));
  size_t n = strlen(buf);
  char *out = (char *)nativets_alloc(n + 1);
  memcpy(out, buf, n + 1);
  return out;
}

const char *js_bool_to_str(int32_t b) { return b ? "true" : "false"; }

/* ============================================================
 * Extended runtime (gap features): bitwise, coercions, Math,
 * parsing, and string methods. Still libc-only; still never-free.
 * ============================================================ */

/* ToInt32 / ToUint32 (ECMAScript 7.1.5/7.1.6) */
static uint32_t to_uint32(double x) {
  if (!isfinite(x)) return 0u;
  double m = fmod(trunc(x), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}
static int32_t to_int32(double x) { return (int32_t)to_uint32(x); }

double js_bit_and(double a, double b) { return (double)(to_int32(a) & to_int32(b)); }
double js_bit_or(double a, double b)  { return (double)(to_int32(a) | to_int32(b)); }
double js_bit_xor(double a, double b) { return (double)(to_int32(a) ^ to_int32(b)); }
double js_bit_not(double a)           { return (double)(~to_int32(a)); }
double js_shl(double a, double b)  { return (double)(to_int32(a)  << (to_uint32(b) & 31u)); }
double js_shr(double a, double b)  { return (double)(to_int32(a)  >> (to_uint32(b) & 31u)); }
double js_ushr(double a, double b) { return (double)(to_uint32(a) >> (to_uint32(b) & 31u)); }

/* Number(string) / unary + on string, matching JS ToNumber */
double js_str_to_num(const char *s) {
  while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  if (*s == '\0') return 0.0;
  char *end;
  double v = strtod(s, &end);
  while (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r') end++;
  return *end == '\0' ? v : NAN;
}

/* Math.round: JS semantics floor(x + 0.5) */
double js_math_round(double x) { return floor(x + 0.5); }

/* parseInt / parseFloat (prefix parsing, JS-style) */
double js_parse_int(const char *s, double radixd) {
  while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  int radix = (int)radixd;
  int sign = 1;
  if (*s == '+') s++; else if (*s == '-') { sign = -1; s++; }
  if ((radix == 0 || radix == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) { s += 2; radix = 16; }
  if (radix == 0) radix = 10;
  char *end;
  long v = strtol(s, &end, radix);
  if (end == s) return NAN;
  return (double)(sign * v);
}
double js_parse_float(const char *s) {
  while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  char *end;
  double v = strtod(s, &end);
  return end == s ? NAN : v;
}

/* ---- string methods (byte-oriented; ASCII-correct) ---- */

static char *alloc_str(size_t n) { return (char *)nativets_alloc(n + 1); }

const char *js_str_upper(const char *s) {
  size_t n = strlen(s); char *o = alloc_str(n);
  for (size_t i = 0; i < n; i++) o[i] = (s[i] >= 'a' && s[i] <= 'z') ? s[i] - 32 : s[i];
  o[n] = 0; return o;
}
const char *js_str_lower(const char *s) {
  size_t n = strlen(s); char *o = alloc_str(n);
  for (size_t i = 0; i < n; i++) o[i] = (s[i] >= 'A' && s[i] <= 'Z') ? s[i] + 32 : s[i];
  o[n] = 0; return o;
}
const char *js_str_char_at(const char *s, double id) {
  long n = (long)strlen(s); long i = (long)id;
  if (i < 0 || i >= n) { char *o = alloc_str(0); o[0] = 0; return o; }
  char *o = alloc_str(1); o[0] = s[i]; o[1] = 0; return o;
}
static const char *slice_impl(const char *s, double startd, double endd, int clampNeg) {
  long n = (long)strlen(s);
  long start = isinf(startd) ? (startd < 0 ? 0 : n) : (long)startd;
  long end = isinf(endd) ? (endd < 0 ? 0 : n) : (long)endd;
  if (clampNeg) { if (start < 0) start += n; if (end < 0) end += n; }
  if (start < 0) start = 0; if (start > n) start = n;
  if (end < 0) end = 0; if (end > n) end = n;
  if (end < start) end = start;
  long len = end - start;
  char *o = alloc_str((size_t)len);
  memcpy(o, s + start, (size_t)len); o[len] = 0; return o;
}
const char *js_str_slice(const char *s, double a, double b)     { return slice_impl(s, a, b, 1); }
const char *js_str_substring(const char *s, double a, double b) {
  if (a < 0 || isnan(a)) a = 0; if (b < 0 || isnan(b)) b = 0;
  double lo = a < b ? a : b, hi = a < b ? b : a;
  return slice_impl(s, lo, hi, 0);
}
const char *js_str_trim(const char *s) {
  const char *start = s; while (*start == ' ' || *start == '\t' || *start == '\n' || *start == '\r') start++;
  const char *end = s + strlen(s); while (end > start && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\n' || end[-1] == '\r')) end--;
  long len = end - start; char *o = alloc_str((size_t)len); memcpy(o, start, (size_t)len); o[len] = 0; return o;
}
const char *js_str_repeat(const char *s, double countd) {
  long count = (long)countd; if (count < 0) count = 0;
  size_t n = strlen(s); char *o = alloc_str(n * (size_t)count);
  for (long i = 0; i < count; i++) memcpy(o + i * n, s, n);
  o[n * count] = 0; return o;
}
const char *js_str_pad_start(const char *s, double targetd, const char *pad) {
  long target = (long)targetd; long n = (long)strlen(s); size_t pn = strlen(pad);
  if (n >= target || pn == 0) { char *o = alloc_str((size_t)n); memcpy(o, s, n); o[n] = 0; return o; }
  long padlen = target - n; char *o = alloc_str((size_t)target);
  for (long i = 0; i < padlen; i++) o[i] = pad[i % pn];
  memcpy(o + padlen, s, (size_t)n); o[target] = 0; return o;
}
int32_t js_str_includes(const char *s, const char *sub) { return strstr(s, sub) != NULL ? 1 : 0; }
double js_str_index_of(const char *s, const char *sub) {
  const char *p = strstr(s, sub); return p ? (double)(p - s) : -1.0;
}

/* ============================================================
 * Arrays — generic 8-byte-slot vector on the never-free allocator.
 * The codegen bitcasts number<->i64 and ptr<->i64 into/out of slots,
 * so one implementation serves number[]/string[]/boolean[].
 * ============================================================ */

typedef struct { int64_t len; int64_t cap; int64_t *data; } NtArray;

static double slot_to_num(int64_t s) { double d; memcpy(&d, &s, 8); return d; }

/* Live-array accounting so compiler-inserted drops are observable in tests. */
static long g_arr_allocs = 0;
static long g_arr_frees = 0;

NtArray *nt_arr_new(double capd) {
  int64_t cap = (int64_t)capd; if (cap < 1) cap = 1;
  NtArray *a = (NtArray *)nativets_alloc(sizeof(NtArray));
  a->len = 0; a->cap = cap;
  a->data = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)cap);
  g_arr_allocs++;
  return a;
}

/* Deterministic drop, inserted by the compiler at scope exit (RAII). This is the
 * ONLY place arrays are reclaimed — the ownership checker guarantees single-owner
 * so this frees exactly once and never a moved-out value. Element strings are
 * shared (not owned by the array) and are intentionally not freed here. */
void nt_arr_free(NtArray *a) {
  if (!a) return;
  free(a->data);
  free(a);
  g_arr_frees++;
}
double nt_arr_live(void) { return (double)(g_arr_allocs - g_arr_frees); }
double nt_arr_push(NtArray *a, int64_t slot) {
  if (a->len >= a->cap) {
    int64_t nc = a->cap * 2;
    int64_t *nd = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)nc);
    memcpy(nd, a->data, sizeof(int64_t) * (size_t)a->len);
    a->data = nd; a->cap = nc;
  }
  a->data[a->len++] = slot;
  return (double)a->len;
}
int64_t nt_arr_get(NtArray *a, double idxd) {
  int64_t i = (int64_t)idxd;
  if (i < 0 || i >= a->len) return 0;
  return a->data[i];
}
int64_t nt_arr_pop(NtArray *a) { return a->len == 0 ? 0 : a->data[--a->len]; }
double nt_arr_len(NtArray *a) { return (double)a->len; }

/* growable string builder (never-free) */
typedef struct { char *buf; size_t len; size_t cap; } SB;
static void sb_init(SB *s) { s->cap = 64; s->len = 0; s->buf = (char *)nativets_alloc(s->cap); }
static void sb_append(SB *s, const char *str, size_t n) {
  if (s->len + n + 1 > s->cap) {
    size_t nc = s->cap; while (nc < s->len + n + 1) nc *= 2;
    char *nb = (char *)nativets_alloc(nc); memcpy(nb, s->buf, s->len); s->buf = nb; s->cap = nc;
  }
  memcpy(s->buf + s->len, str, n); s->len += n;
}
static const char *sb_finish(SB *s) { s->buf[s->len] = 0; return s->buf; }

const char *nt_arr_join_num(NtArray *a, const char *sep) {
  SB sb; sb_init(&sb); size_t sl = strlen(sep);
  for (int64_t i = 0; i < a->len; i++) {
    if (i > 0) sb_append(&sb, sep, sl);
    char num[64]; js_number_to_string(slot_to_num(a->data[i]), num, sizeof(num));
    sb_append(&sb, num, strlen(num));
  }
  return sb_finish(&sb);
}
const char *nt_arr_join_str(NtArray *a, const char *sep) {
  SB sb; sb_init(&sb); size_t sl = strlen(sep);
  for (int64_t i = 0; i < a->len; i++) {
    if (i > 0) sb_append(&sb, sep, sl);
    const char *s = (const char *)a->data[i];
    sb_append(&sb, s, strlen(s));
  }
  return sb_finish(&sb);
}
int32_t nt_arr_includes_num(NtArray *a, double x) {
  for (int64_t i = 0; i < a->len; i++) if (slot_to_num(a->data[i]) == x) return 1;
  return 0;
}
int32_t nt_arr_includes_str(NtArray *a, const char *x) {
  for (int64_t i = 0; i < a->len; i++) if (strcmp((const char *)a->data[i], x) == 0) return 1;
  return 0;
}
double nt_arr_indexof_num(NtArray *a, double x) {
  for (int64_t i = 0; i < a->len; i++) if (slot_to_num(a->data[i]) == x) return (double)i;
  return -1.0;
}
double nt_arr_indexof_str(NtArray *a, const char *x) {
  for (int64_t i = 0; i < a->len; i++) if (strcmp((const char *)a->data[i], x) == 0) return (double)i;
  return -1.0;
}

/* ============================================================
 * Objects — a fixed block of 8-byte slots (one per field). Field
 * names/types are static, so access is a compile-time slot index
 * (no hashmap). Codegen bitcasts field values into/out of slots.
 * ============================================================ */

void *nt_obj_new(double nfields) {
  size_t n = (size_t)nfields;
  int64_t *slots = (int64_t *)nativets_alloc((n ? n : 1) * sizeof(int64_t));
  for (size_t i = 0; i < n; i++) slots[i] = 0;
  return slots;
}
void nt_obj_free(void *o) { free(o); }

/* ---- string split -> array, array reverse ---- */

NtArray *nt_str_split(const char *s, const char *sep) {
  NtArray *a = nt_arr_new(4);
  size_t seplen = strlen(sep);
  if (seplen == 0) { /* split into characters */
    for (size_t i = 0; s[i]; i++) { char *c = alloc_str(1); c[0] = s[i]; c[1] = 0; nt_arr_push(a, (int64_t)(intptr_t)c); }
    return a;
  }
  const char *start = s, *p;
  while ((p = strstr(start, sep)) != NULL) {
    size_t len = (size_t)(p - start);
    char *piece = alloc_str(len); memcpy(piece, start, len); piece[len] = 0;
    nt_arr_push(a, (int64_t)(intptr_t)piece);
    start = p + seplen;
  }
  size_t len = strlen(start);
  char *piece = alloc_str(len); memcpy(piece, start, len); piece[len] = 0;
  nt_arr_push(a, (int64_t)(intptr_t)piece);
  return a;
}

void *nt_arr_reverse(NtArray *a) {
  for (int64_t i = 0, j = a->len - 1; i < j; i++, j--) {
    int64_t t = a->data[i]; a->data[i] = a->data[j]; a->data[j] = t;
  }
  return a;
}

/* Array#slice(start, end) -> new array */
void *nt_arr_slice(NtArray *a, double startd, double endd) {
  long n = a->len;
  long start = (long)startd;
  long end = isinf(endd) ? n : (long)endd;
  if (start < 0) start += n; if (start < 0) start = 0; if (start > n) start = n;
  if (end < 0) end += n; if (end < 0) end = 0; if (end > n) end = n;
  NtArray *out = nt_arr_new(end - start > 0 ? (double)(end - start) : 1);
  for (long i = start; i < end; i++) nt_arr_push(out, a->data[i]);
  return out;
}

/* append all of src's elements to dst (array spread) */
void nt_arr_extend(NtArray *dst, NtArray *src) {
  for (int64_t i = 0; i < src->len; i++) nt_arr_push(dst, src->data[i]);
}

/* JSON-quote a string: wrap in quotes, escape " \ and control chars */
const char *js_json_quote(const char *s) {
  SB sb; sb_init(&sb);
  sb_append(&sb, "\"", 1);
  for (const char *p = s; *p; p++) {
    char c = *p;
    switch (c) {
      case '"':  sb_append(&sb, "\\\"", 2); break;
      case '\\': sb_append(&sb, "\\\\", 2); break;
      case '\n': sb_append(&sb, "\\n", 2); break;
      case '\t': sb_append(&sb, "\\t", 2); break;
      case '\r': sb_append(&sb, "\\r", 2); break;
      default:   sb_append(&sb, &c, 1);
    }
  }
  sb_append(&sb, "\"", 1);
  return sb_finish(&sb);
}
