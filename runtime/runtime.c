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
#include <stdatomic.h> /* relaxed stat counters (thread-safe under B3 v6 M:N schedulers) */
#include <stdint.h>
#include <time.h>     /* clock_gettime / time — Date.now */
#ifndef _WIN32
#include <unistd.h>   /* read, isatty (POSIX; libc-only, cross-compiles) */
#if !defined(__wasi__)
#include <termios.h>  /* tcgetattr/tcsetattr — raw-mode single-key input   */
#endif                /* termios: absent on wasi-libc */
#endif                /* unistd/termios: absent on Windows (raw-key TUI is a no-op on wasi/Windows) */

/* ---- allocation (never-free; see header comment) ---- */

void *nativets_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) {
    fputs("nativets: out of memory\n", stderr);
    abort();
  }
  return p;
}

/* ============================================================
 * String reference counting (RC) — a pointer->refcount SIDE TABLE.
 *
 * Strings keep their bare `char*` representation (no header). HEAP strings
 * (results of js_str_concat / methods / joins / split / num->str, etc.) are
 * REGISTERED here at creation with rc=1. Binding/copying a string to a new
 * owner RETAINs (rc++); an owner releases at scope exit (rc--), and the string
 * is freed + removed exactly when rc hits 0. A pointer NOT in the table — a
 * string LITERAL (`@.str` global) or any untracked value — makes retain/release
 * NO-OPS, so literals are never freed.
 *
 * This is the shared-immutable (rc) model for value-semantics strings, distinct
 * from the linear/move model used for arrays and objects. Open-addressed linear
 * probe with backward-shift deletion (no tombstones).
 *
 * THREAD SAFETY (B3 v6). This table IS shared state: one global open-addressed array
 * that REHASHES, so two scheduler threads registering strings concurrently would corrupt
 * it. Under M:N (nt_actor.c, NATIVETS_SCHED_THREADS > 1) every entry point below runs
 * under `nt_rt_lock`, a hook the actor runtime installs at nt_sched_init when — and only
 * when — it starts more than one scheduler thread. It is NULL for every other program:
 * a predictable NULL test, no pthread dependency in this file (which must keep compiling
 * for wasm/Android), and behaviour identical to Stage 30's single-threaded RC.
 * ============================================================ */

/* Installed by nt_actor.c ONLY in M:N mode; NULL everywhere else (see above).
 * nt_pvec.c uses the same hook for its node refcounts + Stage-44 transients. */
void (*nt_rt_lock)(int acquire) = 0;
#define NT_RC_LOCK()   do { if (nt_rt_lock) nt_rt_lock(1); } while (0)
#define NT_RC_UNLOCK() do { if (nt_rt_lock) nt_rt_lock(0); } while (0)

typedef struct { void *key; long rc; } NtStrEnt;
static NtStrEnt *g_str_tab = NULL;
static size_t g_str_cap = 0;    /* power of two, or 0 when unallocated */
static size_t g_str_count = 0;  /* number of live entries */
static long g_str_allocs = 0;   /* total registrations */
static long g_str_frees = 0;    /* total frees */

static size_t str_hash(void *p) {
  uintptr_t x = (uintptr_t)p;
  x ^= x >> 33; x *= 0xff51afd7ed558ccdULL; x ^= x >> 33;
  return (size_t)x;
}

/* Slot for `key`: its index if present, else the empty slot where it belongs.
 * The table is kept below 0.7 load so an empty slot always terminates the probe. */
static size_t str_tab_slot(void *key) {
  size_t mask = g_str_cap - 1;
  size_t i = str_hash(key) & mask;
  while (g_str_tab[i].key != NULL && g_str_tab[i].key != key) i = (i + 1) & mask;
  return i;
}

static void str_tab_grow(void) {
  size_t old_cap = g_str_cap;
  NtStrEnt *old = g_str_tab;
  g_str_cap = g_str_cap ? g_str_cap * 2 : 64;
  g_str_tab = (NtStrEnt *)nativets_alloc(g_str_cap * sizeof(NtStrEnt));
  for (size_t i = 0; i < g_str_cap; i++) { g_str_tab[i].key = NULL; g_str_tab[i].rc = 0; }
  g_str_count = 0;
  for (size_t i = 0; i < old_cap; i++) {
    if (old[i].key) { size_t j = str_tab_slot(old[i].key); g_str_tab[j] = old[i]; g_str_count++; }
  }
  if (old) free(old);
}

/* Standard linear-probing backward-shift deletion (keeps probe chains intact). */
static void str_tab_remove_at(size_t i) {
  size_t mask = g_str_cap - 1;
  for (;;) {
    g_str_tab[i].key = NULL; g_str_tab[i].rc = 0;
    size_t j = i;
    for (;;) {
      j = (j + 1) & mask;
      if (g_str_tab[j].key == NULL) { g_str_count--; return; }
      size_t k = str_hash(g_str_tab[j].key) & mask;
      int in_range = (i <= j) ? (i < k && k <= j) : (i < k || k <= j);
      if (!in_range) break; /* entry j can slide into the hole at i */
    }
    g_str_tab[i] = g_str_tab[j];
    i = j;
  }
}

/* Register a freshly-allocated heap string (rc=1). Called by every producer. */
void nt_str_register(void *p) {
  if (!p) return;
  NT_RC_LOCK();
  if (g_str_cap == 0 || (g_str_count + 1) * 10 >= g_str_cap * 7) str_tab_grow();
  size_t i = str_tab_slot(p);
  if (g_str_tab[i].key == NULL) { g_str_tab[i].key = p; g_str_count++; }
  g_str_tab[i].rc = 1; /* a reused (previously-freed) address starts fresh */
  g_str_allocs++;
  NT_RC_UNLOCK();
}

/* Add an owner. No-op (returns p) for untracked pointers, e.g. literals. */
void *nt_str_retain(void *p) {
  if (!p) return p;
  NT_RC_LOCK();
  if (g_str_cap != 0) {
    size_t i = str_tab_slot(p);
    if (g_str_tab[i].key == p) g_str_tab[i].rc++;
  }
  NT_RC_UNLOCK();
  return p;
}

/* Drop an owner; free + remove at rc 0. No-op for untracked pointers (literals)
 * and NULL. Freeing is the ONLY place a heap string is reclaimed. */
void nt_str_release(void *p) {
  if (!p) return;
  NT_RC_LOCK();
  if (g_str_cap != 0) {
    size_t i = str_tab_slot(p);
    if (g_str_tab[i].key == p) {       /* else: literal / already freed / untracked */
      if (--g_str_tab[i].rc <= 0) {
        free(p);
        str_tab_remove_at(i);
        g_str_frees++;
      }
    }
  }
  NT_RC_UNLOCK();
}

/* Live heap-string count (registered - freed), for leak tests (cf. nt_arr_live). */
double nt_str_live(void) { return (double)(g_str_allocs - g_str_frees); }

/* ============================================================
 * number -> string: ECMAScript §6.1.6.1.20, `Number::toString(x, 10)`.
 *
 * The spec defines the output in terms of three integers k, n, s with
 *
 *     k >= 1,  10^(k-1) <= s < 10^k,  s * 10^(n-k) = |x|,  k AS SMALL AS POSSIBLE
 *
 * i.e. s is the SHORTEST decimal digit string that round-trips to the same
 * double (Steele-White / Grisu / Ryu), n is the position of the decimal point,
 * and the k/n rules alone decide fixed vs exponential notation. `%g` is NOT that
 * function and disagrees three ways: it pads the exponent (`1e-07`), switches to
 * exponential at 1e-5 instead of 1e-6, and `%.0f` on an integer prints the
 * double's EXACT expansion (`123456789012345683968`) where the spec asks for the
 * shortest digits zero-filled (`123456789012345680000`).
 *
 * Shortest digits are obtained by trying precisions 1..17 with `%.*e` and taking
 * the first that `strtod`s back to the same bits — libc's decimal conversion is
 * correctly rounded, so the first round-tripping precision IS the minimal k and
 * its digits are the ones closest to the value (what V8's Ryu picks). 17 always
 * round-trips, so the loop always terminates. Seventeen snprintf calls is not
 * the fastest known algorithm; it is small enough to be read and verified, and
 * fast enough that no benchmark has asked for more.
 * ============================================================ */

/* The double nearest to 0.<digits> * 10^n — the round-trip side of the test. */
static double js_dec_value(const char *digits, int n) {
  char b[64];
  snprintf(b, sizeof(b), "0.%se%d", digits, n);
  return strtod(b, NULL);
}

/* Step `digits` (k of them, value 0.<digits> * 10^n) one unit in its LAST place,
 * renormalizing a carry (0.999 -> 0.100e+1) or a borrow (0.100 -> 0.990e-1). */
static void js_dec_bump(char *digits, int k, int *n, int up) {
  int i = k - 1;
  if (up) {
    for (; i >= 0; i--) { if (digits[i] != '9') { digits[i]++; break; } digits[i] = '0'; }
    if (i < 0) { digits[0] = '1'; for (int j = 1; j < k; j++) digits[j] = '0'; (*n)++; }
  } else {
    for (; i >= 0; i--) { if (digits[i] != '0') { digits[i]--; break; } digits[i] = '9'; }
    if (digits[0] == '0') { /* leading zero: shift left and drop the exponent */
      memmove(digits, digits + 1, (size_t)(k - 1));
      digits[k - 1] = '0';
      (*n)--;
    }
  }
}

/* Shortest round-tripping digits of a FINITE, NONZERO, POSITIVE double.
 * Writes k significant digits (no point, no sign) into `digits` and the decimal
 * point position n into *np; returns k. `digits` needs 18 bytes. */
static int js_shortest_digits(double v, char *digits, int *np) {
  char d[24];
  for (int p = 1; p <= 17; p++) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*e", p - 1, v);
    /* buf is  d[.ddd]e(+|-)XX  — collect the mantissa digits, then the exponent. */
    int k = 0;
    const char *q = buf;
    for (; *q && *q != 'e' && *q != 'E'; q++) {
      if (*q >= '0' && *q <= '9' && k < 17) d[k++] = *q;
    }
    d[k] = '\0';
    int n = (int)strtol(*q ? q + 1 : "0", NULL, 10) + 1; /* d.ddd*10^e == 0.ddd*10^(e+1) */

    if (p < 17 && js_dec_value(d, n) != v) {
      /* printf gives the p-digit decimal NEAREST to v; near a power of two the
       * rounding interval is asymmetric (the neighbouring double below is half
       * as far away), so the nearest decimal can fall outside it while the
       * ADJACENT one lands inside — and that adjacent one is what V8 prints
       * (e.g. 2^-24: printf says ...062, only ...063 round-trips). At most one
       * side can qualify once the nearest has failed, so order is irrelevant. */
      char alt[24];
      int an, ok = 0;
      for (int up = 1; up >= 0 && !ok; up--) {
        memcpy(alt, d, (size_t)k + 1);
        an = n;
        js_dec_bump(alt, k, &an, up);
        if (js_dec_value(alt, an) == v) { memcpy(d, alt, (size_t)k + 1); n = an; ok = 1; }
      }
      if (!ok) continue; /* p digits cannot name v at all — try one more */
    }
    /* Trailing zeros are not significant: dropping them shrinks k with s, leaving
     * s * 10^(n-k) unchanged — and k must be as small as possible. */
    while (k > 1 && d[k - 1] == '0') k--;
    memcpy(digits, d, (size_t)k);
    digits[k] = '\0';
    *np = n;
    return k;
  }
  /* Unreachable: 17 significant digits always round-trip. */
  digits[0] = '0'; digits[1] = '\0'; *np = 1;
  return 1;
}

static void js_number_to_string(double v, char *out, size_t out_len) {
  if (isnan(v)) { snprintf(out, out_len, "NaN"); return; }
  if (isinf(v)) { snprintf(out, out_len, v < 0 ? "-Infinity" : "Infinity"); return; }
  if (v == 0.0) { snprintf(out, out_len, "0"); return; } /* also collapses -0 -> "0" */

  const char *sign = "";
  if (v < 0) { sign = "-"; v = -v; }

  char d[20];
  int n = 0;
  int k = js_shortest_digits(v, d, &n);

  /* Longest body: -6 < n <= 0 gives "0." + 6 zeros + 17 digits = 25 chars. */
  char body[48];
  int b = 0;
  if (k <= n && n <= 21) {
    /* integer, shortest digits then n-k trailing zeros (NOT the exact expansion) */
    for (int i = 0; i < k; i++) body[b++] = d[i];
    for (int i = 0; i < n - k; i++) body[b++] = '0';
  } else if (0 < n && n <= 21) {
    /* point inside the digits: 12.34 */
    for (int i = 0; i < n; i++) body[b++] = d[i];
    body[b++] = '.';
    for (int i = n; i < k; i++) body[b++] = d[i];
  } else if (-6 < n && n <= 0) {
    /* leading zeros: 0.000001234 — fixed notation holds down to just above 1e-7 */
    body[b++] = '0'; body[b++] = '.';
    for (int i = 0; i < -n; i++) body[b++] = '0';
    for (int i = 0; i < k; i++) body[b++] = d[i];
  } else {
    /* exponential: one digit, optional fraction, then e(+|-)<exponent, and the
     * exponent is written with NO leading zeros (`1e-7`, `1e+21`). */
    body[b++] = d[0];
    if (k > 1) {
      body[b++] = '.';
      for (int i = 1; i < k; i++) body[b++] = d[i];
    }
    body[b++] = 'e';
    int e = n - 1;
    body[b++] = e < 0 ? '-' : '+';
    unsigned ae = (unsigned)(e < 0 ? -e : e);
    char ds[8];
    int di = 0;
    do { ds[di++] = (char)('0' + ae % 10); ae /= 10; } while (ae);
    while (di > 0) body[b++] = ds[--di];
  }
  body[b] = '\0';
  snprintf(out, out_len, "%s%s", sign, body);
}

/* ============================================================
 * PANIC — out-of-bounds index (see docs/divergences.md).
 *
 * Every indexed accessor here is bounds-checked, so nativets never performs an
 * out-of-bounds MEMORY access. What changed is the POLICY on a failed check: it
 * used to return a benign value (0 / "" / a no-op write), which matches neither
 * node (`undefined`) nor a trap — the program carried on computing with a value
 * that was never there. It now stops, rustc-style.
 *
 * A panic is NOT an exception: it deliberately does NOT go through the pending-
 * exception protocol (nt_exc_raise), so `try`/`catch` cannot swallow it. stdout is
 * flushed first so everything the program printed before the fault is still there
 * and byte-comparable; the report goes to stderr. abort() (SIGABRT -> shell exit
 * 134) matches the existing out-of-memory path.
 * ============================================================ */
void nt_panic_bounds(const char *what, double len, double idx, const char *loc) {
  char l[64], i[64];
  js_number_to_string(len, l, sizeof(l));
  js_number_to_string(idx, i, sizeof(i));
  fflush(stdout);
  fprintf(stderr, "panic: index out of bounds: the length is %s but the index is %s\n", l, i);
  if (loc && *loc) fprintf(stderr, "  at %s\n", loc);
  fprintf(stderr, "  help: %s is out of range; use `.at(%s)` to get `undefined` instead of panicking\n",
          what && *what ? what : "the index", i);
  fflush(stderr);
  abort();
}

/* ---- console.log building blocks ---- */

/* The same conversion, exported for the other runtime translation units (the
 * actor crash record renders a number message with it). */
void nt_num_to_buf(double v, char *out, size_t out_len) {
  js_number_to_string(v, out, out_len);
}

/* console.log's number renderer is util.inspect's `formatNumber`, NOT String():
 * it differs in exactly one place, showing the SIGN of negative zero
 * (`console.log(-0)` -> `-0`, but `String(-0)` / `"" + -0` -> `"0"`). Template
 * literals / string coercion keep js_num_to_str. */
void js_print_num(double v) {
  if (v == 0.0 && signbit(v)) { fputs("-0", stdout); return; }
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
  nt_str_register(out);
  return out;
}

double js_str_len(const char *s) { return (double)strlen(s); }

int32_t js_str_eq(const char *a, const char *b) { return strcmp(a, b) == 0 ? 1 : 0; }

/* Lexicographic compare for `<` `<=` `>` `>=` and the default `.toSorted()`.
 * Returns <0 / 0 / >0. node compares UTF-16 code units; strcmp on our UTF-8 bytes
 * is code-POINT order, which agrees everywhere except astral (>= U+10000) chars
 * vs U+E000..U+FFFF — a documented divergence (docs/divergences.md). */
int32_t js_str_cmp(const char *a, const char *b) {
  int r = strcmp(a, b);
  return r < 0 ? -1 : (r > 0 ? 1 : 0);
}

const char *nt_insp_num(double v); /* util.inspect's formatNumber (see the inspect block) */

/* number -> string, allocated (for template literals / string coercion) */
const char *js_num_to_str(double v) {
  char buf[64];
  js_number_to_string(v, buf, sizeof(buf));
  size_t n = strlen(buf);
  char *out = (char *)nativets_alloc(n + 1);
  memcpy(out, buf, n + 1);
  nt_str_register(out);
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

/* All string-method results flow through here; register each as a heap string so
 * it is rc-tracked (slice/substring/upper/lower/trim/repeat/padStart/charAt, and
 * the pieces produced by nt_str_split). */
static char *alloc_str(size_t n) { char *p = (char *)nativets_alloc(n + 1); nt_str_register(p); return p; }

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
/* `s[i]` as WRITTEN — out of range PANICS. `.charAt(i)` above keeps node's semantics
 * (it is DEFINED to return "" out of range, so it is not a defect) and `.at(i)` returns
 * `string | undefined`; only the bracket index, whose node value is `undefined`, panics. */
const char *nt_str_index(const char *s, double id, const char *loc) {
  long n = (long)strlen(s); long i = (long)id;
  if (!(id == id) || i < 0 || i >= n) nt_panic_bounds("string index", (double)n, id, loc);
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

/* ---- B2 step 2: the persistent-vector (32-way trie) backend --------------------
 *
 * An array has TWO representations behind ONE handle (docs/research/B2-vector-trie.md
 * §4): the pre-existing FLAT block (`pv == NULL`) — the builder/"transient" form used
 * by literals, .map/.filter/.slice/split/JSON — and, past NT_PV_THRESHOLD elements, a
 * REFCOUNTED PERSISTENT TRIE (`pv != NULL`, `data == NULL`) whose copy-producing ops
 * share structure instead of copying O(n) slots. `len` always mirrors the element
 * count, so `.length` stays a plain load and codegen is untouched.
 *
 * nt_pvec.c is linked (and NT_PVEC defined) only when the program uses arrays. In a
 * flat-only build the stubs below keep this file compiling and every hybrid branch is
 * dominated by a constant-false NT_PV_ON, leaving exactly the old flat behaviour — so
 * a missed link is a lost optimisation, never a correctness or link failure.
 * ------------------------------------------------------------------------------- */
#ifdef NT_PVEC
#include "nt_pvec.h"
#define NT_PV_ON 1
#else
#define NT_PV_ON 0
#define NT_PV_THRESHOLD 32
typedef struct nt_pv nt_pv;
static nt_pv *nt_pv_from_slots(const int64_t *s, uint32_t n) { (void)s; (void)n; return 0; }
static int64_t nt_pv_get(nt_pv *v, uint32_t i) { (void)v; (void)i; return 0; }
static nt_pv *nt_pv_update(nt_pv *v, uint32_t i, int64_t x) { (void)v; (void)i; (void)x; return 0; }
static nt_pv *nt_pv_push(nt_pv *v, int64_t x) { (void)v; (void)x; return 0; }
static nt_pv *nt_pv_push_own(nt_pv *v, int64_t x) { (void)v; (void)x; return 0; }
static nt_pv *nt_pv_pop(nt_pv *v) { (void)v; return 0; }
static void nt_pv_retain(nt_pv *v) { (void)v; }
static void nt_pv_release(nt_pv *v) { (void)v; }
static double nt_pv_node_live(void) { return 0.0; }
static long nt_pv_node_allocs(void) { return 0; }
static long nt_pv_transient_hits(void) { return 0; }
#endif

typedef struct { int64_t len; int64_t cap; int64_t *data; nt_pv *pv; } NtArray;

static double slot_to_num(int64_t s) { double d; memcpy(&d, &s, 8); return d; }

/* Live-array accounting so compiler-inserted drops are observable in tests. */
/* Live-value counters (the __arrLive/__objLive test hooks). RELAXED atomics: they are
 * pure statistics — no other state is ordered by them — but under M:N (B3 v6) two
 * scheduler threads allocate concurrently, so a plain `++` would be a genuine data race
 * (and would lose counts, breaking the leak assertions). Relaxed is one `ldadd` on arm64
 * and imposes no ordering, so the single-threaded cost is negligible. */
static _Atomic long g_arr_allocs = 0;
static _Atomic long g_arr_frees = 0;
#define NT_STAT_INC(c) atomic_fetch_add_explicit(&(c), 1, memory_order_relaxed)
#define NT_STAT_GET(c) atomic_load_explicit(&(c), memory_order_relaxed)

/* A counted, empty header (no backing store yet). */
static NtArray *arr_header(void) {
  NtArray *a = (NtArray *)nativets_alloc(sizeof(NtArray));
  a->len = 0; a->cap = 0; a->data = NULL; a->pv = NULL;
  NT_STAT_INC(g_arr_allocs);
  return a;
}

/* FREEZE: flat -> persistent trie, once, and only past the threshold. Below it a
 * full flat copy is ≤ 256 bytes and beats the trie, and the trie form of ≤ 32
 * elements is a flat 32-slot tail anyway — so small arrays keep byte-identical
 * behaviour AND representation. */
static void arr_freeze(NtArray *a) {
  if (!NT_PV_ON || a->pv || a->len <= NT_PV_THRESHOLD) return;
  a->pv = nt_pv_from_slots(a->data, (uint32_t)a->len);
  free(a->data);
  a->data = NULL; a->cap = 0;
}

/* THAW: persistent trie -> a PRIVATE flat block. Needed by the one in-place
 * mutator we keep for node compatibility (.reverse): a shared trie node has other
 * owners, so it must never be written through. O(n), which .reverse is anyway. */
static void arr_thaw(NtArray *a) {
  if (!a->pv) return;
  int64_t n = a->len;
  int64_t *d = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)(n > 0 ? n : 1));
  for (int64_t i = 0; i < n; i++) d[i] = nt_pv_get(a->pv, (uint32_t)i);
  nt_pv_release(a->pv);
  a->pv = NULL; a->data = d; a->cap = n > 0 ? n : 1;
}

/* The one element read every other runtime array routine goes through. */
static int64_t arr_at(NtArray *a, int64_t i) {
  return a->pv ? nt_pv_get(a->pv, (uint32_t)i) : a->data[i];
}

NtArray *nt_arr_new(double capd) {
  int64_t cap = (int64_t)capd; if (cap < 1) cap = 1;
  NtArray *a = arr_header();
  a->cap = cap;
  a->data = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)cap);
  return a;
}

/* Copy-on-write primitive (B2 step 1/2). Flat: a FULL independent copy of the block.
 * Trie: share the whole persistent vector (O(1)) — safe because nothing is ever
 * mutated in place through it. Either way the result is single-owner at the handle
 * level and drops exactly once (keeps __arrLive balanced). */
NtArray *nt_arr_copy(NtArray *a) {
  NtArray *c = arr_header();
  c->len = a->len;
  if (a->pv) { nt_pv_retain(a->pv); c->pv = a->pv; return c; }
  int64_t cap = a->cap < 1 ? 1 : a->cap;
  c->cap = cap;
  c->data = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)cap);
  memcpy(c->data, a->data, sizeof(int64_t) * (size_t)a->len);
  return c;
}

/* Array.prototype.with(i, v) — pure: returns a NEW array with slot i replaced; the
 * receiver is unchanged. Past the threshold this is PATH COPYING: only the root->leaf
 * ancestors of i are allocated (O(log32 n)), every other subtree is shared by pointer.
 * Out-of-range i PANICS: it used to leave the copy untouched, so the caller went on
 * holding an array it believed it had updated (node throws a RangeError here — both
 * stop the program; ours is an uncatchable panic, see docs/divergences.md). */
NtArray *nt_arr_with(NtArray *a, double idxd, int64_t slot, const char *loc) {
  int64_t i = (int64_t)idxd;
  if (!(idxd == idxd) || i < 0 || i >= a->len)
    nt_panic_bounds("`.with` index", (double)a->len, idxd, loc);
  arr_freeze(a);
  if (a->pv) {
    NtArray *c = arr_header();
    c->len = a->len;
    if (i >= 0 && i < a->len) {
      c->pv = nt_pv_update(a->pv, (uint32_t)i, slot);
    } else {
      nt_pv_retain(a->pv); c->pv = a->pv;
    }
    return c;
  }
  NtArray *c = nt_arr_copy(a);
  if (i >= 0 && i < c->len) c->data[i] = slot;
  return c;
}

/* Deterministic drop, inserted by the compiler at scope exit (RAII). This is the
 * ONLY place arrays are reclaimed — the ownership checker guarantees single-owner
 * so this frees exactly once and never a moved-out value. Element strings are
 * shared (not owned by the array) and are intentionally not freed here. Trie nodes
 * are refcounted: releasing the header frees this version's private path nodes and
 * leaves every node another version still references alive. */
void nt_arr_free(NtArray *a) {
  if (!a) return;
  if (a->pv) nt_pv_release(a->pv);
  free(a->data);
  free(a);
  NT_STAT_INC(g_arr_frees);
}
double nt_arr_live(void) { return (double)(NT_STAT_GET(g_arr_allocs) - NT_STAT_GET(g_arr_frees)); }
/* Structural-sharing witnesses (the array analogue of __arrLive): live trie nodes
 * and cumulative node allocations. See test/sharing.test.ts. */
double nt_arr_nodes(void) { return NT_PV_ON ? nt_pv_node_live() : 0.0; }
double nt_arr_node_allocs(void) { return NT_PV_ON ? (double)nt_pv_node_allocs() : 0.0; }
/* # appends that mutated a uniquely-owned tail in place instead of cloning it. */
double nt_arr_transients(void) { return NT_PV_ON ? (double)nt_pv_transient_hits() : 0.0; }

double nt_arr_push(NtArray *a, int64_t slot) {
  if (a->pv) {
    /* TRANSIENT append (B2 step 4): `a` is a handle the caller is building or has
     * just taken sole ownership of, so if its vector's refcount is 1 the tail can be
     * written in place instead of cloned. nt_pv_push_own falls back to the persistent
     * push (and releases the old ref) whenever ANOTHER version shares the storage —
     * so "old version unchanged" holds by construction, decided by the refcount. */
    a->pv = nt_pv_push_own(a->pv, slot);
    return (double)(++a->len);
  }
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
  return arr_at(a, i);
}

/* `arr[i]` as WRITTEN IN THE SOURCE — out of range PANICS (see nt_panic_bounds).
 * nt_arr_get above keeps the return-0 policy because it is the internal accessor
 * every other runtime routine (and every compiler-generated in-bounds loop) reads
 * through; only indices the programmer wrote reach this one. */
int64_t nt_arr_index(NtArray *a, double idxd, const char *loc) {
  int64_t i = (int64_t)idxd;
  if (!(idxd == idxd) || i < 0 || i >= a->len)
    nt_panic_bounds("array index", (double)a->len, idxd, loc);
  return arr_at(a, i);
}
int64_t nt_arr_pop(NtArray *a) {
  if (a->len == 0) return 0;
  if (a->pv) {
    int64_t v = nt_pv_get(a->pv, (uint32_t)(a->len - 1));
    nt_pv *nv = nt_pv_pop(a->pv);
    nt_pv_release(a->pv);
    a->pv = nv; a->len--;
    return v;
  }
  return a->data[--a->len];
}
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
    char num[64]; js_number_to_string(slot_to_num(arr_at(a, i)), num, sizeof(num));
    sb_append(&sb, num, strlen(num));
  }
  const char *r = sb_finish(&sb); nt_str_register((void *)r); return r;
}
const char *nt_arr_join_str(NtArray *a, const char *sep) {
  SB sb; sb_init(&sb); size_t sl = strlen(sep);
  for (int64_t i = 0; i < a->len; i++) {
    if (i > 0) sb_append(&sb, sep, sl);
    const char *s = (const char *)(intptr_t) arr_at(a, i);
    sb_append(&sb, s, strlen(s));
  }
  const char *r = sb_finish(&sb); nt_str_register((void *)r); return r;
}
int32_t nt_arr_includes_num(NtArray *a, double x) {
  for (int64_t i = 0; i < a->len; i++) if (slot_to_num(arr_at(a, i)) == x) return 1;
  return 0;
}
int32_t nt_arr_includes_str(NtArray *a, const char *x) {
  for (int64_t i = 0; i < a->len; i++) if (strcmp((const char *)(intptr_t) arr_at(a, i), x) == 0) return 1;
  return 0;
}
double nt_arr_indexof_num(NtArray *a, double x) {
  for (int64_t i = 0; i < a->len; i++) if (slot_to_num(arr_at(a, i)) == x) return (double)i;
  return -1.0;
}
double nt_arr_indexof_str(NtArray *a, const char *x) {
  for (int64_t i = 0; i < a->len; i++) if (strcmp((const char *)(intptr_t) arr_at(a, i), x) == 0) return (double)i;
  return -1.0;
}

/* ============================================================
 * Objects — a fixed block of 8-byte slots (one per field). Field
 * names/types are static, so access is a compile-time slot index
 * (no hashmap). Codegen bitcasts field values into/out of slots.
 * ============================================================ */

/* Live-object accounting (mirrors nt_arr_live) so compiler-inserted object drops
 * are observable in tests. Every heap object block (object literals — and closure
 * env blocks, which reuse nt_obj_new) is counted; owned objects are freed at scope
 * exit via nt_obj_free (RAII), exactly once, never a moved-out value. */
static _Atomic long g_obj_allocs = 0;   /* see NT_STAT_INC above (relaxed statistics) */
static _Atomic long g_obj_frees = 0;

void *nt_obj_new(double nfields) {
  size_t n = (size_t)nfields;
  int64_t *slots = (int64_t *)nativets_alloc((n ? n : 1) * sizeof(int64_t));
  for (size_t i = 0; i < n; i++) slots[i] = 0;
  NT_STAT_INC(g_obj_allocs);
  return slots;
}
void nt_obj_free(void *o) {
  if (!o) return;
  free(o);
  NT_STAT_INC(g_obj_frees);
}
double nt_obj_live(void) { return (double)(NT_STAT_GET(g_obj_allocs) - NT_STAT_GET(g_obj_frees)); }

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
  arr_thaw(a);   /* node's .reverse mutates in place; never write through shared nodes */
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
  for (long i = start; i < end; i++) nt_arr_push(out, arr_at(a, i));
  return out;
}

/* Append all of src's elements to dst (array spread).
 *
 * LEADING-SPREAD FAST PATH: `[...a, x]` lowers to nt_arr_new + nt_arr_extend +
 * nt_arr_push, i.e. the destination is always FRESH AND EMPTY when the spread is
 * first. Past the threshold, dst then ADOPTS src's persistent vector wholesale —
 * O(1) with full structural sharing — and the trailing pushes take the persistent
 * path, turning an O(n) append into O(1) amortized with no codegen change. A
 * non-leading spread (`[0, ...a, 4]`) falls back to the element copy; a prepend is
 * O(n) in any representation. */
void nt_arr_extend(NtArray *dst, NtArray *src) {
  if (NT_PV_ON && dst->len == 0 && !dst->pv && src->len > NT_PV_THRESHOLD) {
    arr_freeze(src);
    if (src->pv) {
      free(dst->data);
      dst->data = NULL; dst->cap = 0;
      nt_pv_retain(src->pv);
      dst->pv = src->pv; dst->len = src->len;
      return;
    }
  }
  for (int64_t i = 0; i < src->len; i++) nt_arr_push(dst, arr_at(src, i));
}

/* CONSUMING extend (B2 step 4). Emitted for `x = [...x, e]`, where the ownership pass
 * has proved the spread source is the assignment's own dying value: nothing can observe
 * it after this statement. So instead of copying/retaining, `dst` STEALS src's storage
 * and src's header is freed here (it is the reassignment's drop, moved earlier).
 *
 * Two payoffs, both invisible: the flat builder block is moved rather than copied
 * (O(n) -> O(1) per append), and a trie-backed vector arrives at the following
 * nt_arr_push with refcount 1, which is exactly the transient condition — so the
 * append writes the tail in place. If ANOTHER version shares that vector its refcount
 * is > 1 and the push silently falls back to path copying. */
void nt_arr_extend_own(NtArray *dst, NtArray *src) {
  if (dst->len == 0 && !dst->pv) {          /* the leading-spread shape: dst is fresh */
    free(dst->data);
    dst->data = src->data; dst->cap = src->cap; dst->pv = src->pv; dst->len = src->len;
    src->data = NULL; src->pv = NULL; src->len = 0; src->cap = 0;
    nt_arr_free(src);                       /* header only: its storage moved to dst */
    return;
  }
  nt_arr_extend(dst, src);
  nt_arr_free(src);
}

/* ---- ordering primitives: Array#toSorted / #toReversed (ES2023) ------------
 * Both are NON-MUTATING in node too, which is what lets node stay the oracle for
 * an immutable-array language (`.sort`/`.reverse` sort in place and are refused).
 * The sort is a STABLE bottom-up merge sort — node's sort is required to be
 * stable, so equal elements must keep their input order.
 * The comparator variant takes a closure env + a codegen-emitted shim so the
 * callback can be any TS function value (see ModuleGen.cmpShim). ---- */

typedef int32_t (*NtCmpFn)(void *env, int64_t a, int64_t b);

/* node's DEFAULT comparator: compare the elements' STRING forms ("10" < "9"). */
static int32_t nt_cmp_default_num(void *env, int64_t a, int64_t b) {
  char ba[64], bb[64];
  double da, db;
  (void)env;
  memcpy(&da, &a, sizeof da);
  memcpy(&db, &b, sizeof db);
  js_number_to_string(da, ba, sizeof ba);
  js_number_to_string(db, bb, sizeof bb);
  int r = strcmp(ba, bb);
  return r < 0 ? -1 : (r > 0 ? 1 : 0);
}
static int32_t nt_cmp_default_str(void *env, int64_t a, int64_t b) {
  (void)env;
  int r = strcmp((const char *)(intptr_t)a, (const char *)(intptr_t)b);
  return r < 0 ? -1 : (r > 0 ? 1 : 0);
}

static void nt_merge_run(const int64_t *src, int64_t *dst, int64_t lo, int64_t mid,
                         int64_t hi, void *env, NtCmpFn cmp) {
  int64_t i = lo, j = mid, k = lo;
  while (i < mid && j < hi) {
    /* take the RIGHT element only when it compares strictly less -> stable */
    if (cmp(env, src[j], src[i]) < 0) dst[k++] = src[j++];
    else dst[k++] = src[i++];
  }
  while (i < mid) dst[k++] = src[i++];
  while (j < hi) dst[k++] = src[j++];
}

static NtArray *nt_arr_sorted_with(NtArray *a, void *env, NtCmpFn cmp) {
  int64_t n = a->len;
  NtArray *out = nt_arr_new(n > 0 ? (double)n : 1);
  /* arr_at, NOT a->data: past the threshold the source is trie-backed and `data` is
   * NULL (see arr_freeze). `out` is built by push, which never freezes, so the
   * merge-sort below may keep writing through out->data. */
  for (int64_t i = 0; i < n; i++) nt_arr_push(out, arr_at(a, i));
  if (n < 2) return out;
  int64_t *buf = (int64_t *)nativets_alloc(sizeof(int64_t) * (size_t)n);
  int64_t *from = out->data, *to = buf;
  for (int64_t width = 1; width < n; width *= 2) {
    for (int64_t lo = 0; lo < n; lo += 2 * width) {
      int64_t mid = lo + width < n ? lo + width : n;
      int64_t hi = lo + 2 * width < n ? lo + 2 * width : n;
      nt_merge_run(from, to, lo, mid, hi, env, cmp);
    }
    int64_t *t = from; from = to; to = t;
  }
  if (from != out->data) memcpy(out->data, from, sizeof(int64_t) * (size_t)n);
  return out;
}

void *nt_arr_to_sorted(NtArray *a, int32_t is_str) {
  return nt_arr_sorted_with(a, NULL, is_str ? nt_cmp_default_str : nt_cmp_default_num);
}

void *nt_arr_to_sorted_by(NtArray *a, void *env, void *cmp) {
  return nt_arr_sorted_with(a, env, (NtCmpFn)cmp);
}

void *nt_arr_to_reversed(NtArray *a) {
  NtArray *out = nt_arr_new(a->len > 0 ? (double)a->len : 1);
  for (int64_t i = a->len - 1; i >= 0; i--) nt_arr_push(out, arr_at(a, i)); /* trie-safe read */
  return out;
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
  const char *r = sb_finish(&sb); nt_str_register((void *)r); return r;
}

/* ---- JSON.parse -> tagged dynamic value (Dyn) ----
 *
 * A Dyn is a heap-boxed tagged value. `nt_json_parse` is a recursive-descent
 * parser over RFC 8259 JSON; on any syntax error it exits non-zero with empty
 * stdout (node throws SyntaxError uncaught → exit 1; the stderr message text is a
 * documented divergence — we match exit code + empty stdout). A `dyn as T`
 * narrowing calls one of the nt_dyn_as_* validators, which throw (exit 1) on a
 * tag mismatch. Grown red-green in JSONTestSuite order: scalars first.
 */
enum { DYN_NULL = 0, DYN_BOOL = 1, DYN_NUM = 2, DYN_STR = 3, DYN_ARR = 4, DYN_OBJ = 5 };
typedef struct NtDyn {
  int32_t tag;
  double num;      /* DYN_NUM */
  int32_t boolean; /* DYN_BOOL */
  char *str;       /* DYN_STR */
  void *arr;       /* DYN_ARR (NtArray* of NtDyn*) */
  void *obj;       /* DYN_OBJ */
} NtDyn;

typedef struct { const char *p; } JP;

/* ---- pending-exception protocol ----
 * Runtime failures (JSON syntax errors, `as T` typecheck mismatches) do NOT exit;
 * they RAISE (set a pending flag + message) and unwind by returning a sentinel.
 * Generated IR checks nt_exc_pending() after each fallible call and branches to the
 * nearest catch (clearing the flag) or, if uncaught, calls nt_exc_abort() → exit 1.
 * This makes throws catchable via try/catch, matching node, with the lexical
 * structured-control-flow model (no unwinder). */
static int32_t g_exc_set = 0;
static const char *g_exc_msg = NULL;

static void nt_exc_raise(const char *msg) { g_exc_set = 1; g_exc_msg = msg; }
int32_t nt_exc_pending(void) { return g_exc_set; }
const char *nt_exc_message(void) { return g_exc_msg ? g_exc_msg : ""; }
void nt_exc_clear(void) { g_exc_set = 0; g_exc_msg = NULL; }
/* Public entry point so the CONDITIONALLY-LINKED runtime pieces (nt_http.c's `fetch`)
 * can raise a catchable throw too — a network/DNS failure must reject like node's
 * fetch does, not abort. The flag/message live here, so they need a real symbol. */
void nt_exc_raise_msg(const char *msg) { nt_exc_raise(msg); }
void nt_exc_abort(void) {
  fprintf(stderr, "nativets: uncaught %s\n", g_exc_msg ? g_exc_msg : "exception");
  exit(1);
}

static void json_fail(void) { nt_exc_raise("SyntaxError: Unexpected token in JSON"); }

static void json_ws(JP *j) {
  while (*j->p == ' ' || *j->p == '\t' || *j->p == '\n' || *j->p == '\r') j->p++;
}

static NtDyn *dyn_new(int tag) {
  NtDyn *d = (NtDyn *)nativets_alloc(sizeof(NtDyn));
  d->tag = tag; d->num = 0; d->boolean = 0; d->str = NULL; d->arr = NULL; d->obj = NULL;
  return d;
}

static NtDyn *json_number(JP *j) {
  const char *start = j->p;
  if (*j->p == '-') j->p++;
  if (*j->p == '0') j->p++;                                    /* 0 — no leading-zero run */
  else if (*j->p >= '1' && *j->p <= '9') { while (*j->p >= '0' && *j->p <= '9') j->p++; }
  else { json_fail(); return NULL; }                           /* -foo, -, +1, .5 */
  if (*j->p == '.') { j->p++; if (!(*j->p >= '0' && *j->p <= '9')) { json_fail(); return NULL; } while (*j->p >= '0' && *j->p <= '9') j->p++; }
  if (*j->p == 'e' || *j->p == 'E') {
    j->p++;
    if (*j->p == '+' || *j->p == '-') j->p++;
    if (!(*j->p >= '0' && *j->p <= '9')) { json_fail(); return NULL; }
    while (*j->p >= '0' && *j->p <= '9') j->p++;
  }
  NtDyn *d = dyn_new(DYN_NUM);
  d->num = strtod(start, NULL);                                /* ±overflow → ±Inf, matches node */
  return d;
}

/* Parse a JSON string (cursor at the opening quote). Handles the eight two-char
 * escapes and \uXXXX BMP code points (UTF-8-encoded). Surrogate pairs and embedded
 * NUL are deferred danger zones (D2/D6). Rejects unescaped controls / bad escapes. */
static NtDyn *json_string(JP *j) {
  j->p++; /* opening quote */
  SB sb; sb_init(&sb);
  for (;;) {
    unsigned char c = (unsigned char)*j->p;
    if (c == '"') { j->p++; break; }
    if (c == '\0') { json_fail(); return NULL; }        /* unterminated */
    if (c < 0x20) { json_fail(); return NULL; }         /* unescaped control char */
    if (c == '\\') {
      char e = *(++j->p);
      switch (e) {
        case '"':  sb_append(&sb, "\"", 1); j->p++; break;
        case '\\': sb_append(&sb, "\\", 1); j->p++; break;
        case '/':  sb_append(&sb, "/", 1);  j->p++; break;
        case 'b':  sb_append(&sb, "\b", 1); j->p++; break;
        case 'f':  sb_append(&sb, "\f", 1); j->p++; break;
        case 'n':  sb_append(&sb, "\n", 1); j->p++; break;
        case 'r':  sb_append(&sb, "\r", 1); j->p++; break;
        case 't':  sb_append(&sb, "\t", 1); j->p++; break;
        case 'u': {
          j->p++;
          int cp = 0;
          for (int i = 0; i < 4; i++) {
            char h = *j->p, v;
            if (h >= '0' && h <= '9') v = h - '0';
            else if (h >= 'a' && h <= 'f') v = h - 'a' + 10;
            else if (h >= 'A' && h <= 'F') v = h - 'A' + 10;
            else { json_fail(); return NULL; }
            cp = cp * 16 + v; j->p++;
          }
          if (cp < 0x80) { char b = (char)cp; sb_append(&sb, &b, 1); }
          else if (cp < 0x800) { char b[2] = {(char)(0xC0 | (cp >> 6)), (char)(0x80 | (cp & 0x3F))}; sb_append(&sb, b, 2); }
          else { char b[3] = {(char)(0xE0 | (cp >> 12)), (char)(0x80 | ((cp >> 6) & 0x3F)), (char)(0x80 | (cp & 0x3F))}; sb_append(&sb, b, 3); }
          break;
        }
        default: json_fail(); return NULL;              /* unknown escape */
      }
    } else {
      sb_append(&sb, (const char *)&c, 1);
      j->p++;
    }
  }
  NtDyn *d = dyn_new(DYN_STR);
  d->str = (char *)sb_finish(&sb);
  return d;
}

/* A parsed JSON object: insertion-ordered key/value pairs (duplicate keys allowed;
 * lookup returns the last, matching node). Backs DYN_OBJ via d->obj. */
typedef struct { int32_t len; char **keys; NtDyn **vals; } NtDynObj;

static NtDyn *json_value(JP *j); /* forward decl (json_object recurses through it) */

static NtDyn *json_object(JP *j) {
  j->p++; /* { */
  json_ws(j);
  int cap = 4, len = 0;
  char **keys = (char **)nativets_alloc(cap * sizeof(char *));
  NtDyn **vals = (NtDyn **)nativets_alloc(cap * sizeof(NtDyn *));
  if (*j->p == '}') { j->p++; }
  else for (;;) {
    json_ws(j);
    if (*j->p != '"') { json_fail(); return NULL; }            /* key must be a string */
    NtDyn *k = json_string(j);
    if (g_exc_set) return NULL;
    json_ws(j);
    if (*j->p != ':') { json_fail(); return NULL; }
    j->p++;
    NtDyn *v = json_value(j);
    if (g_exc_set) return NULL;
    if (len == cap) {
      cap *= 2;
      char **nk = (char **)nativets_alloc(cap * sizeof(char *));
      NtDyn **nv = (NtDyn **)nativets_alloc(cap * sizeof(NtDyn *));
      memcpy(nk, keys, len * sizeof(char *)); memcpy(nv, vals, len * sizeof(NtDyn *));
      keys = nk; vals = nv;
    }
    keys[len] = k->str; vals[len] = v; len++;
    json_ws(j);
    if (*j->p == ',') { j->p++; continue; }
    if (*j->p == '}') { j->p++; break; }
    json_fail(); return NULL;                                   /* missing comma / bad separator */
  }
  NtDynObj *o = (NtDynObj *)nativets_alloc(sizeof(NtDynObj));
  o->len = len; o->keys = keys; o->vals = vals;
  NtDyn *d = dyn_new(DYN_OBJ);
  d->obj = o;
  return d;
}

static NtDyn *json_array(JP *j) {
  j->p++; /* [ */
  json_ws(j);
  NtArray *a = nt_arr_new(4);
  if (*j->p == ']') { j->p++; }
  else for (;;) {
    NtDyn *v = json_value(j);
    if (g_exc_set) return NULL;
    nt_arr_push(a, (int64_t)(intptr_t)v);                      /* element Dyn ptr in the slot */
    json_ws(j);
    if (*j->p == ',') { j->p++; continue; }
    if (*j->p == ']') { j->p++; break; }
    json_fail(); return NULL;                                   /* missing comma / bad separator */
  }
  NtDyn *d = dyn_new(DYN_ARR);
  d->arr = a;
  return d;
}

static NtDyn *json_value(JP *j) {
  json_ws(j);
  char c = *j->p;
  if (c == '-' || (c >= '0' && c <= '9')) return json_number(j);
  if (c == '"') return json_string(j);
  if (c == '{') return json_object(j);
  if (c == '[') return json_array(j);
  if (c == 't') { if (strncmp(j->p, "true", 4) == 0)  { j->p += 4; NtDyn *d = dyn_new(DYN_BOOL); d->boolean = 1; return d; } json_fail(); return NULL; }
  if (c == 'f') { if (strncmp(j->p, "false", 5) == 0) { j->p += 5; NtDyn *d = dyn_new(DYN_BOOL); d->boolean = 0; return d; } json_fail(); return NULL; }
  if (c == 'n') { if (strncmp(j->p, "null", 4) == 0)  { j->p += 4; return dyn_new(DYN_NULL); } json_fail(); return NULL; }
  json_fail();
  return NULL;
}

NtDyn *nt_json_parse(const char *s) {
  JP j; j.p = s;
  NtDyn *d = json_value(&j);
  if (g_exc_set) return NULL;                                  /* parse error already raised */
  json_ws(&j);
  if (*j.p != '\0') { json_fail(); return NULL; }              /* trailing garbage / second value */
  return d;
}

double nt_dyn_as_number(NtDyn *d) {
  if (!d || d->tag != DYN_NUM) { nt_exc_raise("TypeError: expected number"); return 0.0; }
  return d->num;
}

int32_t nt_dyn_as_bool(NtDyn *d) {
  if (!d || d->tag != DYN_BOOL) { nt_exc_raise("TypeError: expected boolean"); return 0; }
  return d->boolean;
}

const char *nt_dyn_as_string(NtDyn *d) {
  if (!d || d->tag != DYN_STR) { nt_exc_raise("TypeError: expected string"); return ""; }
  return d->str;
}

/* Object validators (NULL-safe: a raised pending exception makes later calls
 * return sentinels harmlessly; the generated `as T` does one exc check at the end). */
int32_t nt_dyn_require_object(NtDyn *d) {
  if (!d || d->tag != DYN_OBJ) { nt_exc_raise("TypeError: expected object"); return 0; }
  return 1;
}
NtDyn *nt_dyn_get_field(NtDyn *d, const char *key) {
  if (!d || d->tag != DYN_OBJ) return NULL;
  NtDynObj *o = (NtDynObj *)d->obj;
  NtDyn *found = NULL;
  for (int i = 0; i < o->len; i++) if (strcmp(o->keys[i], key) == 0) found = o->vals[i]; /* last wins */
  return found;
}
NtDyn *nt_dyn_require_field(NtDyn *d, const char *key) {
  NtDyn *f = nt_dyn_get_field(d, key);
  if (!f) { nt_exc_raise("TypeError: missing or wrong-typed field"); return NULL; }
  return f;
}

/* Array validators (NULL-safe, same sticky-raise contract as the object ones). */
int32_t nt_dyn_require_array(NtDyn *d) {
  if (!d || d->tag != DYN_ARR) { nt_exc_raise("TypeError: expected array"); return 0; }
  return 1;
}
double nt_dyn_len(NtDyn *d) {
  if (!d || d->tag != DYN_ARR) return 0;
  return nt_arr_len((NtArray *)d->arr);
}
NtDyn *nt_dyn_elem(NtDyn *d, double i) {
  if (!d || d->tag != DYN_ARR) return NULL;
  return (NtDyn *)(intptr_t)nt_arr_get((NtArray *)d->arr, i);
}

const char *nt_dyn_inspect(NtDyn *d, double indent); /* defined with the inspect block below */

/* console.log of an un-narrowed Dyn. A top-level SCALAR prints bare (node prints a
 * top-level string unquoted); a compound goes through util.inspect, exactly like a
 * statically-typed object/array. Before Stage 47 the compound case printed the
 * literal "[object]" — a silent wrong answer. */
void nt_dyn_print(NtDyn *d) {
  if (!d) { fputs("undefined", stdout); return; }
  switch (d->tag) {
    /* nt_insp_num is util.inspect's formatNumber; it delegates to js_num_to_str ->
     * js_number_to_string, so it picks up the spec-correct digits automatically. */
    case DYN_NUM:  fputs(nt_insp_num(d->num), stdout); break; /* -0 prints as -0 */
    case DYN_BOOL: fputs(d->boolean ? "true" : "false", stdout); break;
    case DYN_STR:  fputs(d->str, stdout); break;
    case DYN_NULL: fputs("null", stdout); break;
    default:       fputs(nt_dyn_inspect(d, 0), stdout); break;
  }
}

/* ============================================================
 * Host I/O FFI — CLI args, environment, stdin, exit. libc/POSIX only
 * (getenv/fread/exit), so it cross-links unchanged for macOS/iOS/Android.
 *
 * argv shape (node-consistent): node's `process.argv` is
 * [execPath, scriptPath, ...userArgs]. The compiled binary receives only ONE
 * leading path (C argv[0]); we synthesize node's two-slot prefix by repeating
 * argv[0], so USER ARGS BEGIN AT INDEX 2 and `argv.length` equals node's. A
 * fixture reads `process.argv.slice(2)` / `.length` (identical on both sides);
 * argv[0]/argv[1] contents (machine-specific paths) are never compared.
 * ============================================================ */

static int    g_argc = 0;
static char **g_argv = NULL;

/* Called first thing in @main to stash the real argc/argv. */
void nt_init_args(int argc, char **argv) { g_argc = argc; g_argv = argv; }

/* process.argv -> a fresh string[] in node's shape (see header above). Elements
 * are the untracked C argv pointers (treated like string literals: never freed).
 * The array block itself is a single-owner linear value, dropped at scope exit. */
NtArray *nt_argv(void) {
  NtArray *a = nt_arr_new((double)(g_argc + 1));
  const char *prog = g_argc > 0 ? g_argv[0] : "";
  nt_arr_push(a, (int64_t)(intptr_t)prog);        /* [0] execPath              */
  nt_arr_push(a, (int64_t)(intptr_t)prog);        /* [1] scriptPath (mirror)   */
  for (int i = 1; i < g_argc; i++)                /* [2..] user CLI arguments  */
    nt_arr_push(a, (int64_t)(intptr_t)g_argv[i]);
  return a;
}

/* process.env.NAME -> the value, or "" when unset (node yields `undefined`;
 * returning "" is a documented divergence — fixtures read only vars we set). The
 * returned pointer is into the C environment (untracked, like a literal). */
const char *nt_getenv(const char *name) {
  const char *v = getenv(name);
  return v ? v : "";
}

/* process.exit(code) — flushes stdio and exits (never returns). */
void nt_exit(double code) { exit((int)code); }

/* ---- stdin: lazily slurp all of fd 0, then serve from a shared cursor ----
 * Mirrors the node oracle polyfill (readFileSync(0,'utf8') + a cursor) so both
 * sides agree byte-for-byte:
 *   readStdin() -> everything from the cursor to EOF (cursor -> end)
 *   readLine()  -> the next line WITHOUT its trailing '\n' (or the remainder if
 *                  unterminated); "" once the cursor is at EOF. */
static char  *g_stdin = NULL;
static size_t g_stdin_len = 0;
static size_t g_stdin_pos = 0;
static int    g_stdin_loaded = 0;

static void stdin_load(void) {
  if (g_stdin_loaded) return;
  g_stdin_loaded = 1;
  size_t cap = 4096, len = 0;
  char *buf = (char *)nativets_alloc(cap);
  size_t n;
  while ((n = fread(buf + len, 1, cap - len, stdin)) > 0) {
    len += n;
    if (len == cap) { cap *= 2; char *nb = (char *)nativets_alloc(cap); memcpy(nb, buf, len); free(buf); buf = nb; }
  }
  if (len + 1 > cap) { char *nb = (char *)nativets_alloc(len + 1); memcpy(nb, buf, len); free(buf); buf = nb; }
  buf[len] = '\0';
  g_stdin = buf; g_stdin_len = len; g_stdin_pos = 0;
}

const char *nt_read_stdin(void) {
  stdin_load();
  size_t rem = g_stdin_len - g_stdin_pos;
  char *o = alloc_str(rem);
  memcpy(o, g_stdin + g_stdin_pos, rem); o[rem] = '\0';
  g_stdin_pos = g_stdin_len;
  return o;
}

const char *nt_read_line(void) {
  stdin_load();
  if (g_stdin_pos >= g_stdin_len) { char *o = alloc_str(0); o[0] = '\0'; return o; }
  size_t start = g_stdin_pos, i = start;
  while (i < g_stdin_len && g_stdin[i] != '\n') i++;
  size_t len = i - start;
  char *o = alloc_str(len);
  memcpy(o, g_stdin + start, len); o[len] = '\0';
  g_stdin_pos = (i < g_stdin_len) ? i + 1 : g_stdin_len; /* consume the '\n' */
  return o;
}

/* ---- raw single-key input (the TUI unlock, docs/examples.md C-c) ----
 * rawMode(on) puts the controlling terminal in non-canonical, no-echo mode via
 * termios (~(ICANON|ECHO)) so keypresses arrive un-buffered and un-echoed, and
 * restores the saved settings on off. readKey() returns the next single byte
 * ("" at EOF).
 *
 * Graceful degradation when stdin is NOT a tty (e.g. piped in tests): rawMode is
 * a no-op (tcsetattr on a non-tty would fail anyway) and readKey serves one byte
 * from the SAME lazily-slurped stdin buffer + cursor that readLine/readStdin use,
 * so a piped keystroke script is deterministic and matches the node oracle
 * byte-for-byte. libc/termios only, so it cross-compiles unchanged. */
/* Raw single-key input. POSIX uses termios; on Windows and WASI (no termios) rawMode is a
 * no-op and readKey serves bytes from the piped stdin buffer — so line/stdin/argv programs
 * build+run there, but a live single-keystroke TUI needs a POSIX terminal. */
#if !defined(_WIN32) && !defined(__wasi__)
static struct termios g_saved_termios;
static int            g_raw_active = 0;
#endif

#if !defined(_WIN32) && !defined(__wasi__)
void nt_raw_mode(int32_t on) {
  if (on) {
    if (g_raw_active) return;
    if (!isatty(STDIN_FILENO)) return;                 /* piped: no-op */
    if (tcgetattr(STDIN_FILENO, &g_saved_termios) != 0) return;
    struct termios raw = g_saved_termios;
    raw.c_lflag &= ~((tcflag_t)(ICANON | ECHO));
    raw.c_cc[VMIN] = 1;                                /* block for 1 byte */
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) g_raw_active = 1;
  } else {
    if (!g_raw_active) return;
    tcsetattr(STDIN_FILENO, TCSANOW, &g_saved_termios);
    g_raw_active = 0;
  }
}
#else
/* Windows / WASI: no termios — raw mode is a no-op. */
void nt_raw_mode(int32_t on) { (void)on; }
#endif

const char *nt_read_key(void) {
#if !defined(_WIN32) && !defined(__wasi__)
  if (isatty(STDIN_FILENO)) {
    /* Live terminal: one un-buffered byte straight from fd 0. */
    unsigned char c;
    ssize_t n = read(STDIN_FILENO, &c, 1);
    if (n <= 0) { char *o = alloc_str(0); o[0] = '\0'; return o; }
    char *o = alloc_str(1); o[0] = (char)c; o[1] = '\0'; return o;
  }
#endif
  /* Piped (not a tty) or Windows: one byte from the shared slurp buffer + cursor. */
  stdin_load();
  if (g_stdin_pos >= g_stdin_len) { char *o = alloc_str(0); o[0] = '\0'; return o; }
  char *o = alloc_str(1); o[0] = g_stdin[g_stdin_pos]; o[1] = '\0';
  g_stdin_pos++;
  return o;
}

/* ============================================================
 * stdlib (web standards) — Batch 1
 *
 * High-value web/JS globals implemented as C-runtime primitives, each
 * differential-tested against `node` (node is the oracle). Grouped here so the
 * block stays additive and merge-friendly. All string results go through
 * alloc_str (rc-tracked heap strings); all UTF-8 emission matches node's
 * byte output on a UTF-8 stdout.
 * ============================================================ */

/* Date.now(): integer ms since the Unix epoch (floored, like node). Uses POSIX
 * clock_gettime (present on macOS/iOS/Linux/Android API 21+/wasi — unlike C11
 * timespec_get, which the Android NDK lacks below API 29); Windows falls back to
 * second-granularity time(). */
double nt_date_now(void) {
#if defined(_WIN32)
  return (double)time(NULL) * 1000.0;
#else
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)(ts.tv_nsec / 1000000);
#endif
}

/* ---- base64 (btoa / atob) — pure byte ops over the string's bytes ---- */
static const char B64_ENC[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const char *nt_btoa(const char *s) {
  size_t n = strlen(s);
  size_t outlen = ((n + 2) / 3) * 4;
  char *o = alloc_str(outlen);
  size_t j = 0;
  for (size_t i = 0; i < n; i += 3) {
    unsigned b0 = (unsigned char)s[i];
    unsigned b1 = (i + 1 < n) ? (unsigned char)s[i + 1] : 0;
    unsigned b2 = (i + 2 < n) ? (unsigned char)s[i + 2] : 0;
    o[j++] = B64_ENC[b0 >> 2];
    o[j++] = B64_ENC[((b0 & 3) << 4) | (b1 >> 4)];
    o[j++] = (i + 1 < n) ? B64_ENC[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    o[j++] = (i + 2 < n) ? B64_ENC[b2 & 63] : '=';
  }
  o[outlen] = 0;
  return o;
}

static int b64_val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1; /* '=' , whitespace, or invalid — skipped */
}

const char *nt_atob(const char *s) {
  size_t n = strlen(s);
  char *o = alloc_str(n); /* decoded length is always <= encoded length */
  size_t j = 0;
  int quad[4], qi = 0;
  for (size_t i = 0; i < n; i++) {
    int v = b64_val(s[i]);
    if (v < 0) continue;
    quad[qi++] = v;
    if (qi == 4) {
      o[j++] = (char)((quad[0] << 2) | (quad[1] >> 4));
      o[j++] = (char)(((quad[1] & 15) << 4) | (quad[2] >> 2));
      o[j++] = (char)(((quad[2] & 3) << 6) | quad[3]);
      qi = 0;
    }
  }
  if (qi >= 2) {
    o[j++] = (char)((quad[0] << 2) | (quad[1] >> 4));
    if (qi >= 3) o[j++] = (char)(((quad[1] & 15) << 4) | (quad[2] >> 2));
  }
  o[j] = 0;
  return o;
}

/* ---- String.fromCharCode / fromCodePoint — UTF-8 encode one code unit/point.
 * Matches node's UTF-8 stdout bytes for non-surrogate BMP (fromCharCode) and
 * full code points up to U+10FFFF (fromCodePoint). Codegen concatenates the
 * per-argument single-char strings, so the variadic form works. ---- */
static const char *utf8_char(unsigned cp) {
  unsigned char buf[4];
  int n = 0;
  if (cp < 0x80) {
    buf[n++] = (unsigned char)cp;
  } else if (cp < 0x800) {
    buf[n++] = (unsigned char)(0xC0 | (cp >> 6));
    buf[n++] = (unsigned char)(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    buf[n++] = (unsigned char)(0xE0 | (cp >> 12));
    buf[n++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
    buf[n++] = (unsigned char)(0x80 | (cp & 0x3F));
  } else {
    buf[n++] = (unsigned char)(0xF0 | (cp >> 18));
    buf[n++] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F));
    buf[n++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
    buf[n++] = (unsigned char)(0x80 | (cp & 0x3F));
  }
  char *o = alloc_str((size_t)n);
  memcpy(o, buf, (size_t)n);
  o[n] = 0;
  return o;
}
const char *nt_from_char_code(double d) {
  long v = (long)d;                         /* ToInteger */
  unsigned cp = (unsigned)(((unsigned long)v) & 0xFFFF); /* ToUint16 */
  return utf8_char(cp);
}
const char *nt_from_code_point(double d) {
  return utf8_char((unsigned)(long)d);
}

/* ---- Number.isInteger / isFinite / isSafeInteger — no ToNumber coercion
 * (the argument is already statically a number). ---- */
int32_t nt_num_is_finite(double x)  { return isfinite(x) ? 1 : 0; }
int32_t nt_num_is_integer(double x) { return (isfinite(x) && floor(x) == x) ? 1 : 0; }
int32_t nt_num_is_safe_integer(double x) {
  return (isfinite(x) && floor(x) == x && fabs(x) <= 9007199254740991.0) ? 1 : 0;
}

/* ---- Array.from(str) → string[] of code-point characters (node iterates by
 * code point, not byte, so multi-byte UTF-8 stays one element). Builds the
 * generic slot-vector directly via nt_arr_new/nt_arr_push. ---- */
void *nt_arr_from_str(const char *s) {
  void *a = nt_arr_new(1);
  size_t i = 0, n = strlen(s);
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    size_t len = 1;
    if (c >= 0xF0) len = 4; else if (c >= 0xE0) len = 3; else if (c >= 0xC0) len = 2;
    if (i + len > n) len = 1;
    char *o = alloc_str(len);
    memcpy(o, s + i, len);
    o[len] = 0;
    nt_arr_push(a, (int64_t)(intptr_t)o);
    i += len;
  }
  return a;
}

/* ============================================================
 * stdlib: URL parsing (WHATWG URL — a SUBSET)
 *
 * These are the component accessors behind `new URL(u)` (Batch 3 — before
 * classes existed they were also exposed as `urlProtocol(u)`-style globals,
 * which the real class API replaced). A URL value IS its text, so each accessor
 * re-parses it and returns one component.
 *
 * SUPPORTED subset (each accessor matches `node`'s new URL(u).<part> and
 * searchParams.get byte-for-byte — node is the oracle):
 *   - absolute http:// and https:// URLs (scheme case-insensitive)
 *   - host + optional port (default ports 80/http, 443/https are dropped, like node)
 *   - hostname lowercased; userinfo (user:pass@) stripped; pathname defaults to "/"
 *   - search keeps the raw (still-encoded) query incl. leading '?'; "" if empty
 *   - hash keeps the raw fragment incl. leading '#'; "" if empty
 *   - searchParams.get: form-urldecodes ('+'->space, %XX->byte) key and value
 *
 * OUT OF SUBSET (rejected as "" — we do NOT throw like node, a documented
 * divergence): relative URLs, non-http(s) schemes, IPv6 bracket hosts ([::1]),
 * punycode/IDNA, and path/percent-encoding normalization (input assumed already
 * canonical — node re-normalizes those). Pure libc string scanning, no allocs
 * beyond the returned rc-string.
 * ============================================================ */

typedef struct {
  int ok;                              /* 1 iff a supported http(s) URL */
  int is_https;                        /* scheme: 1=https, 0=http */
  const char *host;  size_t host_len;  /* hostname region (pre-lowercase) */
  const char *port;  size_t port_len;  /* port digits (0 len if absent) */
  const char *path;  size_t path_len;  /* path region (0 len if absent) */
  const char *query; size_t query_len; /* query, no '?' (NULL if no '?') */
  const char *frag;  size_t frag_len;  /* fragment, no '#' (NULL if no '#') */
} NtUrl;

/* case-insensitive ASCII prefix test (scheme match; node lowercases schemes). */
static int url_ci_prefix(const char *s, const char *pfx) {
  for (; *pfx; s++, pfx++) {
    char a = *s;
    if (a >= 'A' && a <= 'Z') a += 32;
    if (a != *pfx) return 0;
  }
  return 1;
}

static NtUrl url_parse(const char *u) {
  NtUrl r;
  memset(&r, 0, sizeof r);
  const char *auth;
  if (url_ci_prefix(u, "https://")) { r.is_https = 1; auth = u + 8; }
  else if (url_ci_prefix(u, "http://")) { r.is_https = 0; auth = u + 7; }
  else return r; /* not absolute http(s): ok stays 0 */

  /* authority ends at the first of '/', '?', '#', or NUL */
  const char *ae = auth;
  while (*ae && *ae != '/' && *ae != '?' && *ae != '#') ae++;

  /* strip userinfo: host starts after the last '@' in [auth, ae) */
  const char *hstart = auth;
  for (const char *p = auth; p < ae; p++) if (*p == '@') hstart = p + 1;

  if (hstart < ae && *hstart == '[') return r; /* IPv6 bracket host: out of subset */

  /* host:port split on the first ':' in the host region */
  const char *colon = NULL;
  for (const char *p = hstart; p < ae; p++) if (*p == ':') { colon = p; break; }
  if (colon) {
    r.host = hstart; r.host_len = (size_t)(colon - hstart);
    r.port = colon + 1; r.port_len = (size_t)(ae - (colon + 1));
  } else {
    r.host = hstart; r.host_len = (size_t)(ae - hstart);
  }
  if (r.host_len == 0) return r; /* empty host: out of subset */

  /* path / query / fragment from the authority end onward */
  const char *p = ae;
  const char *pstart = p;
  while (*p && *p != '?' && *p != '#') p++;
  r.path = pstart; r.path_len = (size_t)(p - pstart);
  if (*p == '?') {
    const char *qs = p + 1, *q = qs;
    while (*q && *q != '#') q++;
    r.query = qs; r.query_len = (size_t)(q - qs);
    p = q;
  }
  if (*p == '#') {
    r.frag = p + 1; r.frag_len = strlen(p + 1);
  }
  r.ok = 1;
  return r;
}

static const char *url_empty(void) { char *o = alloc_str(0); o[0] = 0; return o; }
static const char *url_dup(const char *s) {
  size_t n = strlen(s); char *o = alloc_str(n); memcpy(o, s, n); o[n] = 0; return o;
}
static const char *url_lower(const char *s, size_t n) {
  char *o = alloc_str(n);
  for (size_t i = 0; i < n; i++) { char c = s[i]; o[i] = (c >= 'A' && c <= 'Z') ? c + 32 : c; }
  o[n] = 0; return o;
}

const char *nt_url_protocol(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok) return url_empty();
  return url_dup(r.is_https ? "https:" : "http:");
}

const char *nt_url_hostname(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok) return url_empty();
  return url_lower(r.host, r.host_len);
}

const char *nt_url_host(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok) return url_empty();
  int drop = (r.port_len == 0);
  if (!drop) { /* drop the default port (node does): 443 for https, 80 for http */
    if (r.is_https && r.port_len == 3 && strncmp(r.port, "443", 3) == 0) drop = 1;
    if (!r.is_https && r.port_len == 2 && strncmp(r.port, "80", 2) == 0) drop = 1;
  }
  if (drop) return url_lower(r.host, r.host_len);
  size_t n = r.host_len + 1 + r.port_len;
  char *o = alloc_str(n);
  for (size_t i = 0; i < r.host_len; i++) { char c = r.host[i]; o[i] = (c >= 'A' && c <= 'Z') ? c + 32 : c; }
  o[r.host_len] = ':';
  memcpy(o + r.host_len + 1, r.port, r.port_len);
  o[n] = 0;
  return o;
}

const char *nt_url_pathname(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok) return url_empty();
  if (r.path_len == 0) return url_dup("/"); /* node defaults an absent path to "/" */
  char *o = alloc_str(r.path_len);
  memcpy(o, r.path, r.path_len);
  o[r.path_len] = 0;
  return o;
}

const char *nt_url_search(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok || r.query == NULL || r.query_len == 0) return url_empty();
  size_t n = r.query_len + 1;
  char *o = alloc_str(n);
  o[0] = '?';
  memcpy(o + 1, r.query, r.query_len);
  o[n] = 0;
  return o;
}

const char *nt_url_hash(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok || r.frag == NULL || r.frag_len == 0) return url_empty();
  size_t n = r.frag_len + 1;
  char *o = alloc_str(n);
  o[0] = '#';
  memcpy(o + 1, r.frag, r.frag_len);
  o[n] = 0;
  return o;
}

static int url_hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
/* application/x-www-form-urlencoded decode: '+'->space, %XX->byte, else literal. */
static const char *url_form_decode(const char *s, size_t n) {
  char *o = alloc_str(n);
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (c == '+') {
      o[j++] = ' ';
    } else if (c == '%' && i + 2 < n && url_hexval(s[i + 1]) >= 0 && url_hexval(s[i + 2]) >= 0) {
      o[j++] = (char)(url_hexval(s[i + 1]) * 16 + url_hexval(s[i + 2]));
      i += 2;
    } else {
      o[j++] = c;
    }
  }
  o[j] = 0;
  return o;
}

/* (searchParams lookups live with `URLSearchParams` in the Batch 3 block below —
 * they operate on the query TEXT, so `new URLSearchParams(q)` shares them.) */

/* ============================================================
 * stdlib Batch 1 (part 2) — the everyday string/array/number surface.
 *
 * Every function here is differential-tested against `node`
 * (test/stdlib-batch1.test.ts). Strings stay UTF-8 BYTE-oriented, the
 * pre-existing documented divergence (docs/divergences.md §A.2): indices,
 * .charCodeAt and .at address BYTES, identical to node for ASCII.
 * ============================================================ */

/* String#charCodeAt(i) — the BYTE at index i (ASCII-identical to node's UTF-16
 * code unit); NaN when out of range, exactly like node. */
double js_str_char_code_at(const char *s, double id) {
  long n = (long)strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0 || i >= n) return NAN;
  return (double)(unsigned char)s[i];
}

/* String#codePointAt(i) — decodes the UTF-8 sequence starting at BYTE i, so an
 * ASCII string matches node's UTF-16 code point exactly. NaN is the
 * out-of-range sentinel, which codegen turns into node's `undefined`
 * (a code point is never NaN, so the sentinel is unambiguous). */
double js_str_code_point_at(const char *s, double id) {
  long n = (long)strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0 || i >= n) return NAN;
  const unsigned char *p = (const unsigned char *)s + i;
  unsigned c = p[0];
  long need = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
  if (need == 0 || i + need >= n) return (double)c; /* ASCII, or a truncated/continuation byte */
  unsigned cp = c & (unsigned)(0x7F >> (need + 1));
  for (long k = 1; k <= need; k++) cp = (cp << 6) | (p[k] & 0x3F);
  return (double)cp;
}

/* String#at(i) — one BYTE as a string, negative indices count from the end;
 * NULL is the out-of-range sentinel that codegen turns into `undefined`. */
const char *js_str_at(const char *s, double id) {
  long n = (long)strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0) i += n;
  if (i < 0 || i >= n) return NULL;
  char *o = alloc_str(1); o[0] = s[i]; o[1] = 0; return o;
}

/* String#padEnd(target, pad) — pad on the right, truncating the final pad
 * repetition, and a no-op when the string is already long enough or the pad is
 * empty (node's semantics exactly). */
const char *js_str_pad_end(const char *s, double targetd, const char *pad) {
  long target = (long)targetd; long n = (long)strlen(s); size_t pn = strlen(pad);
  if (n >= target || pn == 0) { char *o = alloc_str((size_t)n); memcpy(o, s, (size_t)n); o[n] = 0; return o; }
  char *o = alloc_str((size_t)target);
  memcpy(o, s, (size_t)n);
  for (long i = n; i < target; i++) o[i] = pad[(size_t)(i - n) % pn];
  o[target] = 0; return o;
}

/* String#startsWith(search, pos) / String#endsWith(search, endPos). `pos` is
 * NaN when omitted: startsWith defaults to 0, endsWith to the length. */
int32_t js_str_starts_with(const char *s, const char *sub, double posd) {
  long n = (long)strlen(s), m = (long)strlen(sub);
  long pos = isnan(posd) ? 0 : (long)posd;
  if (pos < 0) pos = 0;
  if (pos > n || pos + m > n) return 0;
  return memcmp(s + pos, sub, (size_t)m) == 0 ? 1 : 0;
}
int32_t js_str_ends_with(const char *s, const char *sub, double endd) {
  long n = (long)strlen(s), m = (long)strlen(sub);
  long end = isnan(endd) ? n : (long)endd;
  if (end > n) end = n;
  if (end < 0) end = 0;
  if (m > end) return 0;
  return memcmp(s + end - m, sub, (size_t)m) == 0 ? 1 : 0;
}

/* rc-tracked finish for the existing SB string builder: the fills below build
 * their result incrementally, and the final buffer must be reference-counted
 * like every other heap string producer. */
static const char *sb_finish_rc(SB *s) { s->buf[s->len] = 0; nt_str_register(s->buf); return s->buf; }

/* $-substitution in a replacement string (string pattern => no capture groups):
 * `$$` -> "$", `$&` -> the match, "$`" -> prefix, `$'` -> suffix; anything else
 * is literal, exactly like node. */
static void sb_add_replacement(SB *b, const char *rep, const char *s, size_t mstart, size_t mlen) {
  size_t n = strlen(s);
  for (size_t i = 0; rep[i];) {
    if (rep[i] == '$' && rep[i + 1]) {
      char c = rep[i + 1];
      if (c == '$')  { sb_append(b, "$", 1); i += 2; continue; }
      if (c == '&')  { sb_append(b, s + mstart, mlen); i += 2; continue; }
      if (c == '`')  { sb_append(b, s, mstart); i += 2; continue; }
      if (c == '\'') { sb_append(b, s + mstart + mlen, n - mstart - mlen); i += 2; continue; }
    }
    sb_append(b, rep + i, 1); i++;
  }
}

/* String#replace / String#replaceAll with a STRING pattern (no RegExp — regex
 * literals are rejected by the frontend). `all` = 0 replaces the first match
 * only. An empty pattern matches at every position, like node. */
const char *js_str_replace(const char *s, const char *pat, const char *rep, int32_t all) {
  size_t n = strlen(s), m = strlen(pat);
  SB b; sb_init(&b);
  size_t i = 0; int done = 0;
  while (i <= n) {
    int hit = !done && (m == 0 ? 1 : (i + m <= n && memcmp(s + i, pat, m) == 0));
    if (hit) {
      sb_add_replacement(&b, rep, s, i, m);
      if (!all) done = 1;
      if (m == 0) { if (i < n) sb_append(&b, s + i, 1); i++; }
      else i += m;
      continue;
    }
    if (i < n) sb_append(&b, s + i, 1);
    i++;
  }
  return sb_finish_rc(&b);
}

/* String#lastIndexOf(sub) — last match position, -1 when absent; an empty
 * needle matches at the end (node: "abc".lastIndexOf("") === 3). */
double js_str_last_index_of(const char *s, const char *sub) {
  size_t n = strlen(s), m = strlen(sub);
  if (m == 0) return (double)n;
  if (m > n) return -1.0;
  for (size_t i = n - m + 1; i-- > 0;) if (memcmp(s + i, sub, m) == 0) return (double)i;
  return -1.0;
}

/* String#split(sep, limit) — like nt_str_split but stops after `limit` pieces
 * (NaN = no limit). node applies the limit AFTER splitting, i.e. it simply
 * truncates: "a,b,c".split(",", 2) === ["a","b"], limit 0 === []. */
NtArray *nt_str_split_n(const char *s, const char *sep, double limitd) {
  NtArray *a = nt_str_split(s, sep);
  if (!isnan(limitd)) {
    long lim = (long)limitd; if (lim < 0) lim = 0;
    if (lim < a->len) a->len = lim;
  }
  return a;
}

/* Array#at(i) — normalize a possibly-negative index; -1 means out of range
 * (codegen turns that into node's `undefined`). */
double nt_arr_at_index(NtArray *a, double id) {
  long n = (long)a->len;
  long i = isnan(id) ? 0 : (long)id;
  if (i < 0) i += n;
  if (i < 0 || i >= n) return -1.0;
  return (double)i;
}

/* Array#lastIndexOf — last match, -1 when absent (number and string flavors,
 * mirroring the existing nt_arr_indexof_* pair). */
double nt_arr_last_indexof_num(NtArray *a, double x) {
  for (int64_t i = a->len - 1; i >= 0; i--) if (slot_to_num(a->data[i]) == x) return (double)i;
  return -1.0;
}
double nt_arr_last_indexof_str(NtArray *a, const char *x) {
  for (int64_t i = a->len - 1; i >= 0; i--)
    if (strcmp((const char *)(intptr_t)a->data[i], x) == 0) return (double)i;
  return -1.0;
}

/* Array#concat(other) — a NEW array holding both inputs' slots; both sources
 * are left untouched (node-compatible, and the immutable model's shape). */
void *nt_arr_concat(NtArray *a, NtArray *b) {
  NtArray *o = nt_arr_new((double)(a->len + b->len + 1));
  for (int64_t i = 0; i < a->len; i++) nt_arr_push(o, a->data[i]);
  for (int64_t i = 0; i < b->len; i++) nt_arr_push(o, b->data[i]);
  return o;
}

/* Array#flat() — ONE level of flattening into a NEW array. Each element slot of
 * a nested array is an NtArray*; the sub-arrays are left untouched. */
void *nt_arr_flat1(NtArray *a) {
  NtArray *o = nt_arr_new(1);
  for (int64_t i = 0; i < a->len; i++) {
    NtArray *sub = (NtArray *)(intptr_t)a->data[i];
    if (!sub) continue;
    for (int64_t j = 0; j < sub->len; j++) nt_arr_push(o, sub->data[j]);
  }
  return o;
}

/* Number#toFixed(digits) — ECMAScript §Number.prototype.toFixed, exactly.
 *
 * The spec picks the integer n minimizing |n/10^f - x|, breaking TIES toward the
 * LARGER n (i.e. half-up on the magnitude, the sign being split off first). We get
 * that by printing the EXACT decimal expansion of the double (libc's printf is
 * exact at any precision; a double needs at most 1074 fractional digits) and then
 * rounding that digit string half-up — so 1.25 -> "1.3" (a true tie) while the
 * binary-inexact 1.005 (= 1.00499999...) -> "1.00", matching node.
 * |x| >= 1e21 and the non-finite values fall back to ToString, like the spec. */
const char *js_num_to_fixed(double x, double digitsd) {
  int f = (int)digitsd;
  if (f < 0) f = 0;
  if (f > 100) f = 100;
  char out[2400];
  if (isnan(x) || !isfinite(x) || fabs(x) >= 1e21) {
    js_number_to_string(x, out, sizeof(out));
    char *o = alloc_str(strlen(out)); strcpy(o, out); return o;
  }
  int neg = x < 0;      /* false for -0, so (-0).toFixed(2) is "0.00" like node */
  double m = fabs(x);   /* fabs, not -x: printf would print "-0.000…" for -0 */
  char exact[2400];
  snprintf(exact, sizeof(exact), "%.*f", 1080, m); /* the EXACT expansion */
  char *dot = strchr(exact, '.');
  size_t ilen = (size_t)(dot - exact);
  char digits[2400];
  memcpy(digits, exact, ilen);                       /* integer digits … */
  memcpy(digits + ilen, dot + 1, strlen(dot + 1));   /* … then fraction digits */
  size_t total = ilen + strlen(dot + 1);
  digits[total] = 0;
  size_t keep = ilen + (size_t)f;                    /* digits kept before rounding */
  int roundUp = keep < total && digits[keep] >= '5'; /* first dropped digit */
  digits[keep] = 0;
  if (roundUp) {
    long i = (long)keep - 1;
    for (; i >= 0; i--) {
      if (digits[i] != '9') { digits[i]++; break; }
      digits[i] = '0';
    }
    if (i < 0) { memmove(digits + 1, digits, keep + 1); digits[0] = '1'; ilen++; keep++; }
  }
  size_t w = 0;
  /* The sign comes from x < 0, which is false for -0 — so (-0).toFixed(2) is "0.00"
   * while (-0.0001).toFixed(2) is "-0.00", exactly like node. */
  if (neg) out[w++] = '-';
  memcpy(out + w, digits, ilen); w += ilen;
  if (f > 0) { out[w++] = '.'; memcpy(out + w, digits + ilen, (size_t)f); w += (size_t)f; }
  out[w] = 0;
  char *o = alloc_str(w); memcpy(o, out, w); o[w] = 0; return o;
}

/* Number#toString(radix) — a faithful port of V8's DoubleToRadixCString, which is
 * what node runs, so the output matches digit for digit (including the fractional
 * "emit until the remaining error is below half an ULP" rule and its carry).
 * radix 10 (and the no-argument form) goes through the normal ToString path. */
const char *js_num_to_radix_string(double value, double radixd) {
  int radix = (int)radixd;
  char out[2400];
  if (radix == 10 || isnan(value) || !isfinite(value)) {
    js_number_to_string(value, out, sizeof(out));
    char *o = alloc_str(strlen(out)); strcpy(o, out); return o;
  }
  if (value == 0) { char *z = alloc_str(1); z[0] = '0'; z[1] = 0; return z; }
  static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  const int kBufferSize = 2200;
  char buffer[2200];
  int integer_cursor = kBufferSize / 2;
  int fraction_cursor = integer_cursor;
  int negative = value < 0;
  if (negative) value = -value;
  double integer = floor(value);
  double fraction = value - integer;
  double delta = 0.5 * (nextafter(value, INFINITY) - value);
  double tiny = nextafter(0.0, 1.0);
  if (delta < tiny) delta = tiny;
  if (fraction >= delta) {
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = chars[digit];
      fraction -= digit;
      if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))) {
        if (fraction + delta > 1) {
          /* Round up, carrying backwards through the fraction digits. */
          while (1) {
            fraction_cursor--;
            if (fraction_cursor == kBufferSize / 2) { integer += 1; break; }
            char c = buffer[fraction_cursor];
            digit = c > '9' ? (c - 'a' + 10) : (c - '0');
            if (digit + 1 < radix) { buffer[fraction_cursor++] = chars[digit + 1]; break; }
          }
          break;
        }
      }
    } while (fraction >= delta);
  }
  /* Integer digits; digits a double can no longer represent are filled with '0'
   * (V8's `Double(integer / radix).Exponent() > 0` test == "still at least 2^53"). */
  while (integer / radix >= 9007199254740992.0) {
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = chars[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--integer_cursor] = '-';
  size_t n = (size_t)(fraction_cursor - integer_cursor);
  char *o = alloc_str(n);
  memcpy(o, buffer + integer_cursor, n);
  o[n] = 0;
  return o;
}

/* ============================================================
 * stdlib Batch 3 — the object-shaped web APIs (`Date`, `URL`, URI encoding).
 *
 * A `Date` VALUE is just its time value: the epoch-ms `double` (NaN == node's
 * "Invalid Date"). No heap block, no allocation — `getTime()` is the identity.
 *
 * TIMEZONE: the local accessors are genuinely local. `nt_date_fields` breaks a
 * time value down with `localtime_r`, which reads the same IANA zone (`TZ`,
 * /etc/localtime) node's ICU reads, so `getHours()` etc. agree with node on the
 * same machine. `toISOString` and the date-only string form are UTC by
 * specification and go through the pure civil-calendar arithmetic below (no
 * `time_t`, so the whole ±8.64e15 ms JS range works, incl. year +275760).
 * ============================================================ */

#define NT_DATE_MAX 8.64e15 /* ES TimeClip: |t| > 8.64e15 ms is an Invalid Date */

/* ES TimeClip: NaN or out of range -> NaN, else truncate toward zero. */
static double nt_time_clip(double t) {
  if (!(t >= -NT_DATE_MAX && t <= NT_DATE_MAX)) return NAN; /* also catches NaN */
  return t < 0 ? -floor(-t) : floor(t);
}

/* Howard Hinnant's civil_from_days / days_from_civil (proleptic Gregorian),
 * exact over the whole JS date range and free of any `time_t` limit. */
static int64_t nt_days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  int64_t era = (y >= 0 ? y : y - 399) / 400;
  int64_t yoe = y - era * 400;                                    /* [0, 399] */
  int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;   /* [0, 365] */
  int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;            /* [0, 146096] */
  return era * 146097 + doe - 719468;
}
static void nt_civil_from_days(int64_t z, int64_t *y, int64_t *m, int64_t *d) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;                                       /* [0, 146096] */
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;   /* [0, 399] */
  int64_t yy = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);                 /* [0, 365] */
  int64_t mp = (5 * doy + 2) / 153;                                      /* [0, 11] */
  int64_t dd = doy - (153 * mp + 2) / 5 + 1;                             /* [1, 31] */
  int64_t mm = mp + (mp < 10 ? 3 : -9);                                  /* [1, 12] */
  *y = yy + (mm <= 2);
  *m = mm;
  *d = dd;
}

/* Floor-division helpers (JS date math floors; C division truncates). */
static int64_t nt_fdiv(int64_t a, int64_t b) { int64_t q = a / b; if ((a % b) && ((a < 0) != (b < 0))) q--; return q; }
static int64_t nt_fmod_i(int64_t a, int64_t b) { int64_t r = a % b; if (r && ((r < 0) != (b < 0))) r += b; return r; }

/*
 * One component of a time value. `which`: 0 fullYear, 1 month (0-based), 2 date,
 * 3 hours, 4 minutes, 5 seconds, 6 milliseconds, 7 day-of-week (0=Sunday).
 * `utc` selects UTC (civil arithmetic) vs LOCAL (localtime_r). NaN in, NaN out —
 * node's Invalid Date getters all return NaN.
 */
double nt_date_field(double t, double which, double utc) {
  if (isnan(t)) return NAN;
  int w = (int)which;
  int64_t ms = (int64_t)t;
  if (utc == 0.0) {
    /* LOCAL: ask libc for the zone offset at this instant, then reuse the civil
     * arithmetic so out-of-time_t-range instants still work (the offset is only
     * meaningful inside the tz database's range anyway). */
    time_t secs = (time_t)nt_fdiv(ms, 1000);
    struct tm lt;
    if (localtime_r(&secs, &lt) != NULL) {
      /* offset = local wall clock - UTC, in seconds */
      int64_t loc = nt_days_from_civil(lt.tm_year + 1900, lt.tm_mon + 1, lt.tm_mday) * 86400
                  + lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec;
      ms += (loc - (int64_t)secs) * 1000;
    }
  }
  int64_t days = nt_fdiv(ms, 86400000);
  int64_t tod = nt_fmod_i(ms, 86400000);
  if (w == 7) return (double)nt_fmod_i(days + 4, 7); /* 1970-01-01 was a Thursday */
  if (w == 3) return (double)(tod / 3600000);
  if (w == 4) return (double)((tod / 60000) % 60);
  if (w == 5) return (double)((tod / 1000) % 60);
  if (w == 6) return (double)(tod % 1000);
  int64_t y, m, d;
  nt_civil_from_days(days, &y, &m, &d);
  if (w == 0) return (double)y;
  if (w == 1) return (double)(m - 1);
  return (double)d;
}

/* Date#toISOString(): always UTC, `YYYY-MM-DDTHH:mm:ss.sssZ` (extended
 * `±YYYYYY` outside 0..9999). An Invalid Date THROWS, like node's RangeError —
 * catchable through the pending-exception protocol. */
const char *nt_date_to_iso(double t) {
  if (isnan(t)) { nt_exc_raise_msg("RangeError: Invalid time value"); return ""; }
  int64_t ms = (int64_t)t;
  int64_t days = nt_fdiv(ms, 86400000), tod = nt_fmod_i(ms, 86400000);
  int64_t y, m, d;
  nt_civil_from_days(days, &y, &m, &d);
  char buf[64];
  int n;
  if (y >= 0 && y <= 9999)
    n = snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                 (int)y, (int)m, (int)d, (int)(tod / 3600000), (int)((tod / 60000) % 60),
                 (int)((tod / 1000) % 60), (int)(tod % 1000));
  else
    n = snprintf(buf, sizeof buf, "%c%06d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                 y < 0 ? '-' : '+', (int)(y < 0 ? -y : y), (int)m, (int)d,
                 (int)(tod / 3600000), (int)((tod / 60000) % 60),
                 (int)((tod / 1000) % 60), (int)(tod % 1000));
  char *o = alloc_str((size_t)n);
  memcpy(o, buf, (size_t)n);
  o[n] = 0;
  return o;
}

/* `new Date(ms)` — TimeClip only. */
double nt_date_from_ms(double ms) { return nt_time_clip(ms); }

/* console.log(date): node's util.inspect of a Date IS its ISO string, and the
 * literal "Invalid Date" when the time value is NaN. Never throws (unlike
 * toISOString), so the print path needs no exception check. */
const char *nt_date_inspect(double t) {
  if (isnan(t)) return url_dup("Invalid Date");
  return nt_date_to_iso(t);
}

/* JSON.stringify(date): node goes through Date.prototype.toJSON, which yields the
 * QUOTED ISO string — and the JSON literal `null` for a non-finite time value
 * (toJSON tests the time value BEFORE calling toISOString, so it never throws). */
const char *nt_date_to_json(double t) {
  if (isnan(t)) return url_dup("null");
  const char *iso = nt_date_to_iso(t);
  size_t n = strlen(iso);
  char *o = alloc_str(n + 2);
  o[0] = '"';
  memcpy(o + 1, iso, n);
  o[n + 1] = '"';
  o[n + 2] = 0;
  return o;
}

/* Local wall-clock fields -> epoch ms, via mktime (the tz database's inverse). */
static double nt_local_to_ms(int64_t y, int64_t mo, int64_t d, int64_t h, int64_t mi, int64_t s, int64_t msec) {
  struct tm lt;
  memset(&lt, 0, sizeof lt);
  lt.tm_year = (int)(y - 1900); lt.tm_mon = (int)(mo - 1); lt.tm_mday = (int)d;
  lt.tm_hour = (int)h; lt.tm_min = (int)mi; lt.tm_sec = (int)s;
  lt.tm_isdst = -1; /* let libc decide; matches node for the ambiguous DST hour */
  time_t tt = mktime(&lt);
  if (tt == (time_t)-1) return NAN;
  return (double)tt * 1000.0 + (double)msec;
}

/*
 * `new Date(str)` — the ECMAScript Date Time String Format ONLY (§21.4.1.15):
 *   YYYY-MM-DD | YYYY-MM | YYYY  (date-only -> UTC)
 *   <date>T HH:mm[:ss[.sss]] [Z | ±HH:MM]  (no offset -> LOCAL, per ES6+)
 * Anything else (RFC 2822, "March 15 2020", node's implementation-defined
 * fallbacks) is an Invalid Date -> NaN, which is exactly what node returns for a
 * string IT cannot parse — see docs/divergences.md §D for the ones it can.
 */
double nt_date_parse(const char *s) {
  const char *p = s;
  int64_t y = 0, mo = 1, d = 1, h = 0, mi = 0, sec = 0, ms = 0;
  int neg_year = 0, have_time = 0, have_zone = 0;
  int64_t zone_min = 0;
  size_t i = 0;
  /* year: ±YYYYYY or YYYY */
  if (p[i] == '+' || p[i] == '-') {
    neg_year = p[i] == '-';
    i++;
    for (int k = 0; k < 6; k++) { if (p[i + k] < '0' || p[i + k] > '9') return NAN; y = y * 10 + (p[i + k] - '0'); }
    i += 6;
    if (neg_year && y == 0) return NAN; /* -000000 is invalid per spec */
    if (neg_year) y = -y;
  } else {
    for (int k = 0; k < 4; k++) { if (p[i + k] < '0' || p[i + k] > '9') return NAN; y = y * 10 + (p[i + k] - '0'); }
    i += 4;
  }
  if (p[i] == '-') {
    i++;
    if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
    mo = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
    if (p[i] == '-') {
      i++;
      if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
      d = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
    }
  }
  if (p[i] == 'T' || p[i] == 't' || p[i] == ' ') {
    have_time = 1;
    i++;
    if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
    h = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
    if (p[i] != ':') return NAN;
    i++;
    if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
    mi = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
    if (p[i] == ':') {
      i++;
      if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
      sec = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
      if (p[i] == '.') {
        i++;
        if (p[i] < '0' || p[i] > '9') return NAN;
        int k = 0;
        for (; k < 3 && p[i] >= '0' && p[i] <= '9'; k++, i++) ms = ms * 10 + (p[i] - '0');
        for (int f = k; f < 3; f++) ms *= 10;              /* ".4" == 400ms */
        while (p[i] >= '0' && p[i] <= '9') i++;            /* extra digits truncated */
      }
    }
    if (p[i] == 'Z' || p[i] == 'z') { have_zone = 1; i++; }
    else if (p[i] == '+' || p[i] == '-') {
      int zneg = p[i] == '-';
      i++;
      if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
      int64_t zh = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
      if (p[i] == ':') i++;
      if (p[i] < '0' || p[i] > '9' || p[i + 1] < '0' || p[i + 1] > '9') return NAN;
      int64_t zm = (p[i] - '0') * 10 + (p[i + 1] - '0'); i += 2;
      if (zh > 23 || zm > 59) return NAN;
      zone_min = zh * 60 + zm;
      if (zneg) zone_min = -zone_min;
      have_zone = 1;
    }
  }
  if (p[i] != 0) return NAN;                                /* trailing garbage */
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NAN;
  if (h > 24 || mi > 59 || sec > 59) return NAN;
  if (h == 24 && (mi || sec || ms)) return NAN;
  if (!have_time || have_zone) {
    double t = (double)nt_days_from_civil(y, mo, d) * 86400000.0
             + (double)(h * 3600000 + mi * 60000 + sec * 1000 + ms)
             - (double)zone_min * 60000.0;
    return nt_time_clip(t);
  }
  return nt_time_clip(nt_local_to_ms(y, mo, d, h, mi, sec, ms));
}

/* ---- `new URL(u)` as a real class (Batch 3) -------------------------------
 *
 * A URL value IS its text: every accessor re-parses with the same `url_parse`
 * the Batch-1 functional builtins used, so the supported subset (absolute
 * http(s), no IPv6/IDNA/normalization) is unchanged — see the block above.
 * The one new obligation a CLASS has is validation: node's `new URL(bad)`
 * throws a TypeError, so a URL outside the subset raises a CATCHABLE exception
 * here instead of quietly yielding "" the way the functional accessors did.
 */
const char *nt_url_validate(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok) {
    size_t n = strlen(u);
    char *m = (char *)nativets_alloc(n + 32);
    memcpy(m, "TypeError: Invalid URL: ", 24);
    memcpy(m + 24, u, n);
    m[24 + n] = 0;
    nt_exc_raise_msg(m);
    return url_empty();
  }
  return url_dup(u);
}

/* `.port` — the explicit port, "" when absent OR when it is the scheme default
 * (node drops 80/http and 443/https). `.origin` — `protocol//host`. */
const char *nt_url_port(const char *u) {
  NtUrl r = url_parse(u);
  if (!r.ok || r.port_len == 0) return url_empty();
  if (r.is_https && r.port_len == 3 && strncmp(r.port, "443", 3) == 0) return url_empty();
  if (!r.is_https && r.port_len == 2 && strncmp(r.port, "80", 2) == 0) return url_empty();
  char *o = alloc_str(r.port_len);
  memcpy(o, r.port, r.port_len);
  o[r.port_len] = 0;
  return o;
}

const char *nt_url_origin(const char *u) {
  const char *proto = nt_url_protocol(u), *host = nt_url_host(u);
  if (host[0] == 0) return url_empty();
  size_t pn = strlen(proto), hn = strlen(host);
  char *o = alloc_str(pn + 2 + hn);
  memcpy(o, proto, pn);
  o[pn] = '/'; o[pn + 1] = '/';
  memcpy(o + pn + 2, host, hn);
  o[pn + 2 + hn] = 0;
  return o;
}

/* ---- URLSearchParams -------------------------------------------------------
 *
 * The handle is the RAW query text with no leading '?' — `nt_qs_init` strips one
 * if present (node accepts both `new URLSearchParams("?a=1")` and `"a=1"`), and
 * `url.searchParams` passes `.search` straight through. Lookups form-urldecode
 * ('+'->space, %XX->byte) both sides of each pair, like `searchParams.get`.
 */
const char *nt_qs_init(const char *q) {
  if (q[0] == '?') q++;
  return url_dup(q);
}

/* Walk the pairs of `q`; for each, call back with the decoded key/value.
 * Returns the first matching value (rc-string), or NULL if the key is absent.
 * `all` (optional) collects EVERY match into an existing NtArray. */
static const char *qs_scan(const char *q, const char *key, void *all) {
  size_t n = strlen(q), i = 0;
  const char *first = NULL;
  while (i < n) {
    size_t start = i;
    while (i < n && q[i] != '&') i++;
    size_t plen = i - start;
    const char *pair = q + start;
    size_t eq = plen;
    for (size_t k = 0; k < plen; k++) if (pair[k] == '=') { eq = k; break; }
    if (plen > 0) {
      const char *dkey = url_form_decode(pair, eq);
      if (strcmp(dkey, key) == 0) {
        const char *val = (eq == plen) ? url_empty() : url_form_decode(pair + eq + 1, plen - eq - 1);
        if (all) nt_arr_push((NtArray *)all, (int64_t)(intptr_t)val);
        else if (!first) return val;
      }
    }
    if (i < n) i++;
  }
  return first;
}

/* `.get(k)` — first value, or NULL for a miss (codegen boxes NULL as node's `null`). */
const char *nt_qs_get(const char *q, const char *key) { return qs_scan(q, key, NULL); }
/* `.getAll(k)` — every value, in order (empty array for a miss). */
NtArray *nt_qs_get_all(const char *q, const char *key) {
  NtArray *a = nt_arr_new(0);
  qs_scan(q, key, a);
  return a;
}

/* `.toString()` — node re-SERIALIZES (decode each pair, then
 * application/x-www-form-urlencoded encode it), so `?a=b+c` round-trips to
 * `a=b%2Bc`… no: '+' decodes to a space and re-encodes as '+'. Empty pairs are
 * dropped and a valueless key gains an '='. */
static int qs_unreserved(unsigned char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
      || c == '*' || c == '-' || c == '.' || c == '_';
}
const char *nt_qs_to_string(const char *q) {
  size_t n = strlen(q);
  /* worst case: every byte becomes %XX, plus the '=' and '&' separators */
  char *buf = (char *)nativets_alloc(n * 3 + 2);
  size_t j = 0, i = 0;
  int first = 1;
  while (i < n) {
    size_t start = i;
    while (i < n && q[i] != '&') i++;
    size_t plen = i - start;
    const char *pair = q + start;
    if (plen > 0) {
      size_t eq = plen;
      for (size_t k = 0; k < plen; k++) if (pair[k] == '=') { eq = k; break; }
      const char *dk = url_form_decode(pair, eq);
      const char *dv = (eq == plen) ? url_empty() : url_form_decode(pair + eq + 1, plen - eq - 1);
      if (!first) buf[j++] = '&';
      first = 0;
      for (const char *s = dk; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (qs_unreserved(c)) buf[j++] = (char)c;
        else if (c == ' ') buf[j++] = '+';
        else { static const char H[] = "0123456789ABCDEF"; buf[j++] = '%'; buf[j++] = H[c >> 4]; buf[j++] = H[c & 15]; }
      }
      buf[j++] = '=';
      for (const char *s = dv; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (qs_unreserved(c)) buf[j++] = (char)c;
        else if (c == ' ') buf[j++] = '+';
        else { static const char H[] = "0123456789ABCDEF"; buf[j++] = '%'; buf[j++] = H[c >> 4]; buf[j++] = H[c & 15]; }
      }
    }
    if (i < n) i++;
  }
  buf[j] = 0;
  char *o = alloc_str(j);
  memcpy(o, buf, j);
  o[j] = 0;
  return o;
}

/* ---- encodeURIComponent / decodeURIComponent / encodeURI / decodeURI -------
 *
 * Byte-exact per ECMAScript §19.2.6: percent-encode every byte outside the
 * per-function "unescaped" set, uppercase hex. nativets strings are already
 * UTF-8, so the UTF-16→UTF-8 step the spec describes is the identity here (and
 * the lone-surrogate URIError node throws is unreachable by construction).
 * Decoding a malformed `%` sequence THROWS catchably, like node's URIError.
 */
static int uri_unescaped(unsigned char c) { /* uriUnescaped = alphanum + uriMark */
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
      || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')';
}
static int uri_reserved(unsigned char c) { /* uriReserved + '#', kept literal by encodeURI */
  return c == ';' || c == '/' || c == '?' || c == ':' || c == '@' || c == '&' || c == '='
      || c == '+' || c == '$' || c == ',' || c == '#';
}
static const char *uri_encode(const char *s, int keep_reserved) {
  static const char H[] = "0123456789ABCDEF";
  size_t n = strlen(s);
  char *buf = (char *)nativets_alloc(n * 3 + 1);
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (uri_unescaped(c) || (keep_reserved && uri_reserved(c))) buf[j++] = (char)c;
    else { buf[j++] = '%'; buf[j++] = H[c >> 4]; buf[j++] = H[c & 15]; }
  }
  buf[j] = 0;
  char *o = alloc_str(j);
  memcpy(o, buf, j);
  o[j] = 0;
  return o;
}
const char *nt_encode_uri_component(const char *s) { return uri_encode(s, 0); }
const char *nt_encode_uri(const char *s) { return uri_encode(s, 1); }

static const char *uri_decode(const char *s, int keep_reserved) {
  size_t n = strlen(s);
  char *buf = (char *)nativets_alloc(n + 1);
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] != '%') { buf[j++] = s[i]; continue; }
    if (i + 2 >= n || url_hexval(s[i + 1]) < 0 || url_hexval(s[i + 2]) < 0) {
      nt_exc_raise_msg("URIError: URI malformed");
      return url_empty();
    }
    unsigned char b = (unsigned char)(url_hexval(s[i + 1]) * 16 + url_hexval(s[i + 2]));
    /* decodeURI preserves the escapes of the reserved set (it must round-trip
     * with encodeURI, which never produced them). */
    if (keep_reserved && uri_reserved(b)) { buf[j++] = s[i]; buf[j++] = s[i + 1]; buf[j++] = s[i + 2]; }
    else buf[j++] = (char)b;
    i += 2;
  }
  buf[j] = 0;
  char *o = alloc_str(j);
  memcpy(o, buf, j);
  o[j] = 0;
  return o;
}
const char *nt_decode_uri_component(const char *s) { return uri_decode(s, 0); }
const char *nt_decode_uri(const char *s) { return uri_decode(s, 1); }

/* ============================================================
 * util.inspect — node's `console.log` rendering of COMPOUND values.
 *
 * Before this existed, `console.log(obj)` printed the object POINTER through
 * `fputs`, i.e. usually a bare newline: a silent wrong answer, the failure mode
 * this project exists to avoid. What follows is a faithful port of node's
 * `lib/internal/util/inspect.js` (`reduceToSingleString` / `isBelowBreakLength` /
 * `groupArrayElements` / `strEscape` / `formatNumber`) at console.log's defaults —
 * breakLength 80, compact 3, depth 2, maxArrayLength 100 — so the output is
 * byte-identical to node's.
 *
 * Split of work: CODEGEN walks the STATIC type and produces one already-rendered
 * string per entry (the JSON.stringify walk is the precedent); this builder owns
 * only the width / line-breaking decision, which depends on the rendered widths
 * and so can only be made at runtime. `open` carries node's `braces[0]` INCLUDING
 * any prefix (`Map(2) {`, `Point {`) — node measures that prefix as part of the
 * brace, and the empty rendering is exactly `open + close`.
 *
 * NOTE: widths are counted in BYTES, matching String#length's documented UTF-8
 * byte-orientation everywhere else in nativets (docs/divergences.md §A.2); node
 * counts UTF-16 units. Identical for ASCII.
 * ============================================================ */

#define NT_INSP_BREAK 80
#define NT_INSP_COMPACT 3
#define NT_INSP_MAXARR 100

typedef struct {
  const char **items;
  int64_t n, cap;
  const char *open, *close;
  int64_t indent;     /* node's ctx.indentationLvl at this value */
  int32_t isArray;    /* kArrayExtrasType => eligible for column grouping */
  int32_t numericPad; /* every element is a number => padStart (node's `order`) */
} NtInsp;

NtInsp *nt_insp_new(const char *open, const char *close, double indent, double isArray, double numericPad) {
  NtInsp *b = (NtInsp *)nativets_alloc(sizeof(NtInsp));
  b->cap = 8; b->n = 0;
  b->items = (const char **)nativets_alloc((size_t)b->cap * sizeof(char *));
  b->open = open; b->close = close;
  b->indent = (int64_t)indent;
  b->isArray = (int32_t)isArray;
  b->numericPad = (int32_t)numericPad;
  return b;
}

void nt_insp_add(NtInsp *b, const char *entry) {
  if (b->n == b->cap) {
    int64_t nc = b->cap * 2;
    const char **ni = (const char **)nativets_alloc((size_t)nc * sizeof(char *));
    memcpy(ni, b->items, (size_t)b->n * sizeof(char *));
    b->items = ni; b->cap = nc;
  }
  b->items[b->n++] = entry ? entry : "";
}

/* node: isBelowBreakLength(ctx, output, start, base) with base === ''. */
static int insp_below_break(NtInsp *b, size_t start) {
  size_t total = (size_t)b->n + start;
  if (total + (size_t)b->n > NT_INSP_BREAK) return 0;
  for (int64_t i = 0; i < b->n; i++) {
    total += strlen(b->items[i]);
    if (total > NT_INSP_BREAK) return 0;
  }
  return 1;
}

static void sb_pad(SB *s, size_t n) { for (size_t i = 0; i < n; i++) sb_append(s, " ", 1); }

/* node: groupArrayElements — lay short array entries out in aligned columns.
 * Returns 1 when the entries were regrouped into `*out` (`*outN` lines), 0 when
 * node leaves the output untouched (which also re-enables the single-line path). */
static int insp_group(NtInsp *b, const char ***out, int64_t *outN) {
  int64_t outputLength = b->n;
  if (NT_INSP_MAXARR < b->n) outputLength--;              /* exclude "... n more items" */
  const size_t sep = 2;
  size_t totalLength = 0, maxLength = 0;
  size_t *dataLen = (size_t *)nativets_alloc((size_t)(outputLength > 0 ? outputLength : 1) * sizeof(size_t));
  for (int64_t i = 0; i < outputLength; i++) {
    size_t len = strlen(b->items[i]);
    dataLen[i] = len;
    totalLength += len + sep;
    if (maxLength < len) maxLength = len;
  }
  double actualMax = (double)(maxLength + sep);
  if (!(actualMax * 3 + (double)b->indent < NT_INSP_BREAK &&
        ((double)totalLength / actualMax > 5.0 || maxLength <= 6))) return 0;

  const double approxCharHeights = 2.5;
  double averageBias = sqrt(actualMax - (double)totalLength / (double)b->n);
  double biasedMax = actualMax - 3 - averageBias;
  if (biasedMax < 1) biasedMax = 1;
  /* Math.round is floor(x + 0.5) in JS (js_math_round), NOT C's round(). */
  double c0 = floor(sqrt(approxCharHeights * biasedMax * (double)outputLength) / biasedMax + 0.5);
  double c1 = floor(((double)NT_INSP_BREAK - (double)b->indent) / actualMax);
  double cd = c0 < c1 ? c0 : c1;
  if (cd > NT_INSP_COMPACT * 4) cd = NT_INSP_COMPACT * 4;
  if (cd > 15) cd = 15;
  int64_t columns = (int64_t)cd;
  if (columns <= 1) return 0;

  size_t *maxLineLength = (size_t *)nativets_alloc((size_t)columns * sizeof(size_t));
  for (int64_t i = 0; i < columns; i++) {
    size_t lineLength = 0;
    /* node walks j over the FULL output but reads dataLen[j], which is `undefined`
     * past outputLength (the "... n more items" entry) and so never widens a column. */
    for (int64_t j = i; j < outputLength; j += columns)
      if (dataLen[j] > lineLength) lineLength = dataLen[j];
    maxLineLength[i] = lineLength + sep;
  }
  int padStart = b->numericPad != 0;

  int64_t lines = 0;
  int64_t capLines = (outputLength + columns - 1) / columns + 2;
  const char **tmp = (const char **)nativets_alloc((size_t)(capLines > 0 ? capLines : 1) * sizeof(char *));
  for (int64_t i = 0; i < outputLength; i += columns) {
    int64_t max = i + columns < outputLength ? i + columns : outputLength;
    SB line; sb_init(&line);
    int64_t j = i;
    for (; j < max - 1; j++) {
      size_t padding = maxLineLength[j - i];              /* no colors => output[j].length == dataLen[j] */
      size_t cell = dataLen[j] + sep;                     /* the padded unit is `${output[j]}, ` */
      if (padStart && cell < padding) sb_pad(&line, padding - cell);
      sb_append(&line, b->items[j], dataLen[j]);
      sb_append(&line, ", ", 2);
      if (!padStart && cell < padding) sb_pad(&line, padding - cell);
    }
    if (padStart) {
      size_t padding = maxLineLength[j - i] - sep;
      if (dataLen[j] < padding) sb_pad(&line, padding - dataLen[j]);
    }
    sb_append(&line, b->items[j], dataLen[j]);
    tmp[lines++] = sb_finish(&line);
  }
  if (NT_INSP_MAXARR < b->n) tmp[lines++] = b->items[outputLength];
  *out = tmp; *outN = lines;
  return 1;
}

/* node: reduceToSingleString with base === '' and ctx.compact === 3. The
 * `ctx.currentDepth - recurseTimes < ctx.compact` guard is always satisfied at
 * ctx.depth 2 (nothing deeper than 2 levels is ever formatted), so it is omitted. */
const char *nt_insp_done(NtInsp *b) {
  SB s;
  if (b->n == 0) {
    sb_init(&s);
    sb_append(&s, b->open, strlen(b->open));
    sb_append(&s, b->close, strlen(b->close));
    return sb_finish_rc(&s);
  }
  const char **items = b->items;
  int64_t n = b->n;
  int grouped = 0;
  if (b->isArray && b->n > 6) {
    const char **g; int64_t gn;
    if (insp_group(b, &g, &gn)) { items = g; n = gn; grouped = 1; }
  }
  if (!grouped) {
    size_t start = (size_t)b->n + (size_t)b->indent + strlen(b->open) + 10;
    if (insp_below_break(b, start)) {
      int nl = 0;
      for (int64_t i = 0; i < n && !nl; i++) if (strchr(items[i], '\n')) nl = 1;
      if (!nl) {
        sb_init(&s);
        sb_append(&s, b->open, strlen(b->open));
        sb_append(&s, " ", 1);
        for (int64_t i = 0; i < n; i++) {
          if (i) sb_append(&s, ", ", 2);
          sb_append(&s, items[i], strlen(items[i]));
        }
        sb_append(&s, " ", 1);
        sb_append(&s, b->close, strlen(b->close));
        return sb_finish_rc(&s);
      }
    }
  }
  sb_init(&s);
  sb_append(&s, b->open, strlen(b->open));
  for (int64_t i = 0; i < n; i++) {
    if (i) sb_append(&s, ",", 1);
    sb_append(&s, "\n", 1);
    sb_pad(&s, (size_t)b->indent + 2);
    sb_append(&s, items[i], strlen(items[i]));
  }
  sb_append(&s, "\n", 1);
  sb_pad(&s, (size_t)b->indent);
  sb_append(&s, b->close, strlen(b->close));
  return sb_finish_rc(&s);
}

/* node's formatNumber: inspect renders -0 as "-0" (String(-0) is "0"). */
const char *nt_insp_num(double v) {
  if (v == 0.0 && signbit(v)) { char *o = alloc_str(2); memcpy(o, "-0", 3); return o; }
  return js_num_to_str(v);
}

/* node's strEscape: prefer ', fall back to " then ` to avoid escaping the quote,
 * and escape control chars / DEL / the chosen quote / backslash. */
static const char *const insp_meta[32] = {
  "\\x00", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\x07",
  "\\b",   "\\t",   "\\n",   "\\x0B", "\\f",   "\\r",   "\\x0E", "\\x0F",
  "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
  "\\x18", "\\x19", "\\x1A", "\\x1B", "\\x1C", "\\x1D", "\\x1E", "\\x1F",
};

const char *nt_insp_str(const char *s) {
  char quote = '\'';
  if (strchr(s, '\'')) {
    if (!strchr(s, '"')) quote = '"';
    else if (!strchr(s, '`') && !strstr(s, "${")) quote = '`';
  }
  SB b; sb_init(&b);
  sb_append(&b, &quote, 1);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    unsigned char c = *p;
    char ch = (char)c;
    if (c < 0x20) sb_append(&b, insp_meta[c], strlen(insp_meta[c]));
    else if (c == 0x7f) sb_append(&b, "\\x7F", 4);
    else if (ch == quote) { sb_append(&b, "\\", 1); sb_append(&b, &ch, 1); }
    else if (ch == '\\') sb_append(&b, "\\\\", 2);
    else sb_append(&b, &ch, 1);
  }
  sb_append(&b, &quote, 1);
  return sb_finish_rc(&b);
}

/* An object key: bare when it matches node's keyStrRegExp
 * (/^[a-zA-Z_][a-zA-Z_0-9]*$/ — note `$` is NOT allowed there), else quoted like
 * a string. Codegen calls this on the compile-time-known key so the rule has one
 * implementation shared with the Dyn walk below. */
const char *nt_insp_key(const char *k) {
  int bare = (k[0] >= 'a' && k[0] <= 'z') || (k[0] >= 'A' && k[0] <= 'Z') || k[0] == '_';
  for (const char *p = k; bare && *p; p++) {
    char c = *p;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) bare = 0;
  }
  return bare ? k : nt_insp_str(k);
}

/* `Map(3) {` / `Set(0) {` — the size is a runtime value, so the prefix is too. */
const char *nt_insp_coll_open(const char *name, double size) {
  SB b; sb_init(&b);
  sb_append(&b, name, strlen(name));
  sb_append(&b, "(", 1);
  char num[64]; js_number_to_string(size, num, sizeof(num));
  sb_append(&b, num, strlen(num));
  sb_append(&b, ") {", 3);
  return sb_finish_rc(&b);
}

/* `... 3 more items` when an array exceeds maxArrayLength (100). */
const char *nt_insp_more(double remaining) {
  SB b; sb_init(&b);
  char num[64]; js_number_to_string(remaining, num, sizeof(num));
  sb_append(&b, "... ", 4);
  sb_append(&b, num, strlen(num));
  if (remaining > 1) sb_append(&b, " more items", 11); else sb_append(&b, " more item", 10);
  return sb_finish_rc(&b);
}

/* `key: value` — one object entry. */
const char *nt_insp_entry(const char *key, const char *val) {
  const char *k = nt_insp_key(key);
  SB b; sb_init(&b);
  sb_append(&b, k, strlen(k));
  sb_append(&b, ": ", 2);
  sb_append(&b, val, strlen(val));
  return sb_finish_rc(&b);
}

/* `key => value` — one Map entry. */
const char *nt_insp_pair(const char *key, const char *val) {
  SB b; sb_init(&b);
  sb_append(&b, key, strlen(key));
  sb_append(&b, " => ", 4);
  sb_append(&b, val, strlen(val));
  return sb_finish_rc(&b);
}

/* ---- Dyn (a JSON.parse result): the same algorithm, but the shape is known only
 * at runtime, so the whole walk lives here rather than in codegen. ---- */
static const char *nt_dyn_inspect_at(NtDyn *d, int64_t depth, int64_t indent) {
  if (!d) return "undefined";
  switch (d->tag) {
    case DYN_NULL: return "null";
    case DYN_BOOL: return d->boolean ? "true" : "false";
    case DYN_NUM:  return nt_insp_num(d->num);
    case DYN_STR:  return nt_insp_str(d->str);
    case DYN_ARR: {
      NtArray *a = (NtArray *)d->arr;
      int64_t len = (int64_t)nt_arr_len(a);
      if (len == 0) return "[]";
      if (depth > 2) return "[Array]";
      int64_t n = len < NT_INSP_MAXARR ? len : NT_INSP_MAXARR;
      int allNum = 1;
      for (int64_t i = 0; i < n; i++) {
        NtDyn *e = (NtDyn *)(intptr_t)nt_arr_get(a, (double)i);
        if (!e || e->tag != DYN_NUM) { allNum = 0; break; }
      }
      NtInsp *b = nt_insp_new("[", "]", (double)indent, 1, allNum ? 1 : 0);
      for (int64_t i = 0; i < n; i++)
        nt_insp_add(b, nt_dyn_inspect_at((NtDyn *)(intptr_t)nt_arr_get(a, (double)i), depth + 1, indent + 2));
      if (len > n) nt_insp_add(b, nt_insp_more((double)(len - n)));
      return nt_insp_done(b);
    }
    case DYN_OBJ: {
      NtDynObj *o = (NtDynObj *)d->obj;
      if (o->len == 0) return "{}";
      if (depth > 2) return "[Object]";
      NtInsp *b = nt_insp_new("{", "}", (double)indent, 0, 0);
      for (int32_t i = 0; i < o->len; i++)
        nt_insp_add(b, nt_insp_entry(o->keys[i], nt_dyn_inspect_at(o->vals[i], depth + 1, indent + 2)));
      return nt_insp_done(b);
    }
  }
  return "undefined";
}

/* The rendered form of a Dyn at a given indentation level (0 at the top level). */
const char *nt_dyn_inspect(NtDyn *d, double indent) {
  return nt_dyn_inspect_at(d, (int64_t)indent / 2, (int64_t)indent);
}

