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
#include <errno.h>    /* host FFI (SH4): node-identical fs error codes/messages */
#include <sys/stat.h> /* host FFI (SH4): existsSync — POSIX stat, cross-links */
#include <dirent.h>  /* host FFI (SH4): readdirSync / recursive rmSync */
#if !defined(_WIN32) && !defined(__wasi__)
#include <sys/wait.h> /* host FFI (SH4): spawnSync — fork/execvp/waitpid + poll */
#include <poll.h>
#include <fcntl.h>    /* FD_CLOEXEC — the inherited spawn's exec-failed channel */
#endif
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

/* `len` is the string's BYTE length, memoized: -1 until something asks. Lazy, not
 * eager, because `alloc_str` REGISTERS the buffer before the producer fills it —
 * measuring at registration would read uninitialized bytes — and because a string is
 * immutable once built, so the first answer is the only answer. Re-registering an
 * address (malloc reuse) resets it to -1. See nt_strlen below. */
typedef struct { void *key; long rc; long len; } NtStrEnt;
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
  for (size_t i = 0; i < g_str_cap; i++) { g_str_tab[i].key = NULL; g_str_tab[i].rc = 0; g_str_tab[i].len = -1; }
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
    g_str_tab[i].key = NULL; g_str_tab[i].rc = 0; g_str_tab[i].len = -1;
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
  g_str_tab[i].len = -1; /* ...and so does its memoized length */
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
 * nt_strlen — the ONE place a string's byte length comes from.
 *
 * WHY THIS EXISTS. A nativets string is a bare NUL-terminated `char *`, so every
 * `.length`, every `s[i]`, every `slice`/`startsWith`/`indexOf` used to call
 * `strlen` and walk the whole string. The idiom every scanner in this compiler is
 * written in —
 *
 *     while (i < s.length) { const c = s[i]!; … }
 *
 * — is therefore TWO full walks per character, i.e. O(n^2) in the input. Measured on
 * the compiled `src/lexer.ts`: 348 KB of source took 10.2 s (bun: 0.03 s), fitted
 * exponent 1.98, and `sample` put 100% of the profile in `_platform_strlen`.
 *
 * WHY NOT A LENGTH HEADER. The obvious fix — store the length in a header before the
 * bytes — cannot be applied uniformly, because a string LITERAL is an `@.str` global
 * in rodata with no header and no way to grow one. The runtime cannot tell a literal
 * from a heap string without consulting the RC side table... at which point the table
 * can just hold the length itself. So: no header, no representation change, no new
 * cost at the FFI boundary (a nativets string is still exactly a `const char *` that
 * `printf`/`open`/`strcmp` accept), no codegen change. +8 bytes per live heap string.
 *
 * Literals still pay one `strlen` per query — they are compile-time constants, short,
 * and never the 348 KB scannee (a file read from disk is a heap string, registered).
 *
 * `.length` STILL COUNTS UTF-8 BYTES. This is a pure caching change: the number
 * returned is the same number `strlen` returned, so docs/divergences.md §A.2 (we
 * count bytes; node counts UTF-16 code units) is untouched.
 * ============================================================ */

/* Bytes actually walked by `strlen` while answering a length query — the
 * deterministic instrument for this whole change, exposed as `__strScanned()`.
 * A program that scans an n-byte string once reads ~n^2 when every query walks and
 * ~n when the length is remembered. Debug-only, like g_str_allocs. */
static double g_str_scanned = 0;
double nt_str_scanned(void) { return g_str_scanned; }

size_t nt_strlen(const char *s) {
  if (!s) return 0;
  NT_RC_LOCK();
  if (g_str_cap != 0) {
    size_t i = str_tab_slot((void *)s);
    if (g_str_tab[i].key == s) {                 /* a tracked heap string */
      if (g_str_tab[i].len < 0) {
        size_t n = strlen(s);
        g_str_scanned += (double)n;
        g_str_tab[i].len = (long)n;
      }
      size_t r = (size_t)g_str_tab[i].len;
      NT_RC_UNLOCK();
      return r;
    }
  }
  /* Literal / untracked: walk it. Outside the lock deliberately — a long literal
   * would otherwise serialize every scheduler thread — so `g_str_scanned` can lose an
   * addend under M:N. It is a debug counter; the LENGTH is exact either way. */
  NT_RC_UNLOCK();
  { size_t n = strlen(s); g_str_scanned += (double)n; return n; }
}

/* ------------------------------------------------------------
 * Interned one-byte strings.
 *
 * `s[i]` used to `alloc_str(1)` — a fresh malloc + a fresh RC-table entry PER
 * CHARACTER. Measured at ~204 bytes retained per loop-local string temp and
 * 226-263 bytes of RSS per source character; invisible to `__objLive`, `__arrLive`,
 * `leaks` and LeakSanitizer alike, because those temps are REACHABLE from the RC
 * table until released.
 *
 * There are only 256 possible one-byte strings, so they are statics. Being
 * untracked they behave EXACTLY like string literals — `nt_str_retain` and
 * `nt_str_release` are already no-ops for any pointer not in the table, which is the
 * path literals have always taken — and they are never freed and never allocated.
 *
 * Laid out as one flat 512-byte constant (byte b at offset 2*b, its NUL at 2*b+1) so
 * it needs no initializer function: still libc-only, still valid on wasm/Windows/
 * Android, still zero startup cost. Index 0 is the interned EMPTY string.
 * ------------------------------------------------------------ */
#define NT_C1(i)  (char)(i), 0,
#define NT_C4(i)  NT_C1(i) NT_C1((i) + 1) NT_C1((i) + 2) NT_C1((i) + 3)
#define NT_C16(i) NT_C4(i) NT_C4((i) + 4) NT_C4((i) + 8) NT_C4((i) + 12)
#define NT_C64(i) NT_C16(i) NT_C16((i) + 16) NT_C16((i) + 32) NT_C16((i) + 48)
static const char g_ch1[512] = { NT_C64(0) NT_C64(64) NT_C64(128) NT_C64(192) };
#undef NT_C64
#undef NT_C16
#undef NT_C4
#undef NT_C1

/* The interned string for one byte. `b == 0` is the empty string, which is what the
 * out-of-range / empty-result producers want anyway. */
static const char *nt_ch1(unsigned char b) { return &g_ch1[(size_t)b * 2]; }
/* The interned empty string — replaces every `alloc_str(0)`. */
static const char *nt_empty_str(void) { return &g_ch1[0]; }

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

/* Is `d` usable as a bracket index at all? NaN and ±Inf are not, and neither is a
 * FRACTION: JS `a[1.5]` is a property lookup on the string "1.5", which no array, string
 * or typed array has, so node reads `undefined` — it does NOT truncate to `a[1]`. The
 * runtime used to truncate (`(int64_t)1.5` is 1) and hand back the neighbouring element:
 * `[1,2,3][1.5]` was `2`, `"abc"[1.5]` was `"b"`, and `u[1.5] = 7` overwrote byte 1. Exit
 * 0, no diagnostic — the silent wrong answer this whole panic path exists to stop, and
 * the checker's compile-time half had always agreed (`checkStaticBounds` requires
 * `Number.isInteger`, so the literal `a[1.5]` is NT2002). A non-integer is now out of
 * bounds here too.
 *
 * NOT applied to `nt_arr_with`: node's `.with` runs its index through
 * ToIntegerOrInfinity, so `[1,2,3].with(1.7, 9)` really is `[1,9,3]` and truncating there
 * MATCHES node. Bracket indexing has no such coercion. (nt_bytes.c carries a guarded copy
 * of this macro — it is a separate translation unit with no shared runtime header; this
 * is the definition of record.)
 *
 * `floor(d) == d` rather than a cast round-trip: `(int64_t)1e300` is undefined behaviour
 * and the index is an arbitrary double straight from the program. It is false for NaN
 * (every comparison is) and true for ±Inf, which `isinf` then rejects. */
#define NT_IS_INDEX(d) (floor(d) == (d) && !isinf(d))

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
/* The `help:` line, keyed on the ACCESSOR that faulted and on the INDEX.
 *
 * There is no single true suggestion, and there used to be one anyway: every caller got
 * "use `.at(i)` to get `undefined` instead of panicking". Measured against node, that
 * holds ONLY for a read at or past the end. Following it anywhere else does not avoid a
 * panic, it silently returns a DIFFERENT value —
 *
 *     [1,2,3][-1]  -> undefined   but  [1,2,3].at(-1)  -> 3    (counts from the END)
 *     "abc"[-1]    -> undefined   but  "abc".at(-1)    -> "c"
 *     [1,2,3][1.5] -> undefined   but  [1,2,3].at(1.5) -> 2    (truncates)
 *     [1,2,3][NaN] -> undefined   but  [1,2,3].at(NaN) -> 1    (element 0)
 *
 * — and a `.with` or a typed-array WRITE cannot be expressed by `.at` at ALL, since
 * `.at` is a read. Both were told to use it.
 *
 * `what` already told us which accessor this is; it now also distinguishes the typed-
 * array WRITE from the read, which is the one caller `.at` can never serve. Each branch
 * is executed against node in test/panic.test.ts ("the advice compiles and matches
 * node") — a hint whose advice is never run is a hint nobody checked. */
static void bounds_help(const char *what, double len, double idx, const char *i) {
  const char *w = (what && *what) ? what : "the index";

  /* `.with(i, v)` — a pure update. node's `.with` takes a RELATIVE index, so a negative
   * one is legal there and names an element from the end; ours requires 0..len-1, so
   * name the absolute form that is the same element. Out of range on BOTH sides, node
   * throws `RangeError: Invalid index : i` — a real difference of kind (it is catchable
   * there, a panic here), but the index is wrong either way, so point at the append. */
  if (strcmp(w, "`.with` index") == 0) {
    /* `floor(idx) == idx` rather than a cast round-trip: `(long long)1e300` is undefined
     * behaviour, and the index is an arbitrary double straight from the program. */
    double rel = len + idx;
    if (idx < 0 && rel >= 0 && floor(idx) == idx) {
      char n[64];
      js_number_to_string(-idx, n, sizeof(n));
      fprintf(stderr,
              "  help: node's `.with` counts a negative index from the END; nativets requires an "
              "index in 0..%lld — write `.with(a.length - %s, v)` for the same element\n",
              (long long)len - 1, n);
      return;
    }
    /* node's `.with` runs its index through ToIntegerOrInfinity, so NaN becomes 0 —
     * `[1,2,3].with(NaN, 9)` is `[9,2,3]`, where we panic. (A FRACTION needs no branch:
     * ToIntegerOrInfinity truncates it and so does `nt_arr_with`, so `.with(1.7, 9)`
     * already agrees with node and never reaches here.) */
    if (idx != idx) {
      fprintf(stderr, "  help: node's `.with` treats a NaN index as 0 (`[1,2,3].with(NaN, 9)` is "
                      "`[9,2,3]`); nativets requires a real index — write `.with(0, v)` if that is what you meant\n");
      return;
    }
    if (len <= 0) {
      fprintf(stderr,
              "  help: `.with` on an EMPTY array has no valid index (node throws "
              "`RangeError: Invalid index : %s` here too); build the array with `[...a, v]` instead\n", i);
      return;
    }
    fprintf(stderr,
            "  help: `.with` needs an index inside 0..%lld (node throws `RangeError: Invalid index : %s` "
            "here too); to APPEND, spread instead: `[...a, v]`\n", (long long)len - 1, i);
    return;
  }

  /* A typed-array WRITE. node DISCARDS an out-of-range one: nothing is stored, the array
   * does not grow, and the program reads back what was already there — the silent wrong
   * answer this panic exists to stop. There is no expression that performs the write, so
   * the only honest advice is to test the index; `.at` is named only to rule it out. */
  if (strcmp(w, "Uint8Array write index") == 0) {
    fprintf(stderr,
            "  help: node silently DISCARDS an out-of-range typed-array write — nothing is stored and "
            "the array does not grow — so no accessor replaces this: test `i >= 0 && i < u.length` "
            "before writing (`.at(%s)` is a READ and cannot express a write)\n", i);
    return;
  }

  /* A READ (`a[i]`, `s[i]`, `u[i]`). node's answer is `undefined` for every failing
   * index; `.at` reproduces it only for an integer at or past the end. */
  if (idx != idx) {
    fprintf(stderr,
            "  help: %s is NaN; node reads `undefined` there. `.at(NaN)` reads element 0, not "
            "`undefined`, so it is not the same value — test the index instead\n", w);
    return;
  }
  /* An INFINITE index is the one non-finite case `.at` gets right: node reads `undefined`
   * for `a[Infinity]` and `.at(Infinity)`/`.at(-Infinity)` are `undefined` too. Say so —
   * but an infinite index is really a bug in the arithmetic that produced it. */
  if (isinf(idx)) {
    fprintf(stderr,
            "  help: %s is infinite; node reads `undefined` there and `.at(%s)` does too — but an "
            "infinite index means the arithmetic that produced it is wrong; check that first\n", w, i);
    return;
  }
  if (floor(idx) != idx) {
    fprintf(stderr,
            "  help: %s is not an integer; node reads `undefined` there. `.at(%s)` truncates towards zero "
            "(and `.at(NaN)` reads element 0), so it is not the same value — use an integer index\n", w, i);
    return;
  }
  if (idx < 0) {
    fprintf(stderr,
            "  help: %s is out of range; node reads `undefined` for a negative index. `.at(%s)` is NOT "
            "that: it counts from the END (`.at(-1)` is the LAST element). Test the index first, or use "
            "`.at()` deliberately if the element from the end is what you meant\n", w, i);
    return;
  }
  fprintf(stderr, "  help: %s is out of range; use `.at(%s)` to get `undefined` instead of panicking\n", w, i);
}

void nt_panic_bounds(const char *what, double len, double idx, const char *loc) {
  char l[64], i[64];
  js_number_to_string(len, l, sizeof(l));
  js_number_to_string(idx, i, sizeof(i));
  fflush(stdout);
  fprintf(stderr, "panic: index out of bounds: the length is %s but the index is %s\n", l, i);
  if (loc && *loc) fprintf(stderr, "  at %s\n", loc);
  bounds_help(what, len, idx, i);
  fflush(stderr);
  abort();
}

/* ============================================================
 * PANIC — a string the host cannot represent (see docs/divergences.md).
 *
 * node's (V8's) maximum string length on 64-bit is 2^29-24; `"x".repeat(536870889)` is
 * the first `RangeError: Invalid string length` (measured against node v24). We count
 * UTF-8 BYTES where node counts UTF-16 code units — the pre-existing string-index
 * divergence (A.2) — so the two boundaries coincide for ASCII and ours is the stricter
 * one for anything wider.
 *
 * WHY A PANIC AND NOT A RAISE. node throws a CATCHABLE RangeError here, and the pending-
 * exception protocol below could carry one. It deliberately does not: making these
 * builders fallible would route every `.repeat` / `.padStart` / `.padEnd` call site
 * through `emitExcCheck`, which REFUSES to compile a fallible call inside a `try` with no
 * `catch`, and inside a `try` whose `catch` binds an object type. Those are ordinary
 * formatting calls, so that trades a rare stop for a common REJECTION of programs that
 * compile and run correctly today. This is the same policy the compiler already applies
 * to every other unrecoverable size failure — `nativets: out of memory` and
 * `nt_panic_bounds` — so there is one stop discipline, not two. stdout is flushed first,
 * so everything printed before the fault stays byte-comparable with node; the exit code
 * is 134 (SIGABRT) where node's is 1, documented in docs/divergences.md.
 * ============================================================ */
#define NT_MAX_STR_LEN 536870888.0

static void nt_panic_str_len(const char *what, double want) {
  char w[64];
  js_number_to_string(want, w, sizeof(w));
  fflush(stdout);
  fprintf(stderr, "panic: invalid string length: %s would be %s bytes, past the %.0f-byte maximum\n",
          what, w, NT_MAX_STR_LEN);
  fprintf(stderr, "  help: node throws `RangeError: Invalid string length` at exactly this "
                  "boundary; build the text in pieces, or write it out incrementally, instead "
                  "of materialising one string this large\n");
  fflush(stderr);
  abort();
}

/* `.repeat(count)` rejects its COUNT before it ever looks at the length — ES 22.1.3.18
 * step 3 — which is why `"".repeat(Infinity)` throws while `"".repeat(1e100)` is "". */
static void nt_panic_repeat_count(double count) {
  char c[64];
  js_number_to_string(count, c, sizeof(c));
  fflush(stdout);
  fprintf(stderr, "panic: invalid count value: %s\n", c);
  fprintf(stderr, "  help: `.repeat(n)` needs `n` to be finite and >= 0; node throws "
                  "`RangeError: Invalid count value: %s` here\n", c);
  fflush(stderr);
  abort();
}

/* ES 7.1.5 ToIntegerOrInfinity, kept as a DOUBLE so ±Infinity SURVIVES the conversion.
 * `(long)d` for a non-finite or out-of-range `d` is undefined in C, and the two hosts
 * disagree in the worst possible way: arm64 saturates to LONG_MAX while x86-64 yields
 * LONG_MIN. That one line made `"abc".padStart(Infinity, "xy")` abort on one target and
 * silently answer `"abc"` on the other — a WRONG ANSWER at exit 0, from the same source,
 * decided by the host. Every length argument below goes through here first. */
static double nt_to_integer_or_infinity(double d) {
  if (isnan(d)) return 0.0;
  if (isinf(d)) return d;
  return trunc(d);
}

/* `expr!` — TypeScript's non-null assertion, on an A2 tagged pair [tag, value]
 * (tag 0 = undefined, 1 = null, >=2 = present). Unwraps to the value slot.
 *
 * A FALSE assertion panics, deliberately, on the Stage-41 reasoning: tsc/node ERASE `!`,
 * so node hands back `undefined` and the program computes on from a value that was never
 * there. Unwrapping the box regardless would be worse still — a phantom `0` or a dangling
 * pointer rather than an honest `undefined`. `!` is the programmer ASSERTING the value is
 * present; this is what it costs when that is wrong. Use `?? fallback` or an
 * `x === undefined` test to handle absence instead. */
int64_t nt_nonnull(const int64_t *box, const char *loc) {
  if (box && box[0] >= 2) return box[1];
  fflush(stdout);
  fprintf(stderr, "panic: non-null assertion failed: the value is %s\n",
          (box && box[0] == 1) ? "null" : "undefined");
  if (loc && *loc) fprintf(stderr, "  at %s\n", loc);
  fprintf(stderr, "  help: `!` asserts a value is present; use `?? fallback`, or test "
                  "`x === undefined` / `x === null`, to handle absence instead\n");
  fflush(stderr);
  abort();
}

/* Unpack a GENERAL union box [tag, value] whose arm the checker proved. `want` is the
 * arm's index in the union's canonical member order; `what` names it for the message.
 *
 * The proof is a compile-time one, so this check should never fire — it is here for the
 * same reason nt_nonnull's is. If the flow analysis is ever wrong, the alternative is
 * reinterpreting a `double` bit pattern as a `char *`: a phantom value or a segfault
 * with no explanation. Panicking names the bug instead. */
int64_t nt_union_arm(const int64_t *box, double want, const char *what, const char *loc) {
  if (box && box[0] == (int64_t)want) return box[1];
  fflush(stdout);
  fprintf(stderr, "panic: union narrowing was wrong: expected the %s arm\n", what ? what : "?");
  if (loc && *loc) fprintf(stderr, "  at %s\n", loc);
  fprintf(stderr, "  help: this is a compiler bug — the checker proved an arm the value "
                  "does not hold; please report it with the program that triggered it\n");
  fflush(stderr);
  abort();
}

/* ---- `expr as T` — the CHECKED type assertion ----
 *
 * These two exist because `as` is NOT a compile-time proof the way flow narrowing is.
 * `tsc` ACCEPTS a union-to-member downcast, so the checker has nothing to reject and
 * nothing to prove; the assertion is the programmer's claim, and it can be wrong. That
 * is why the messages below blame the ASSERTION rather than the compiler, unlike
 * nt_union_arm / nt_nonnull directly above, whose checks really should never fire.
 *
 * A failed assertion PANICS, which is a deliberate divergence from node — node erases
 * `as` and hands back `undefined`, letting the program compute on from a value that was
 * never there. Same reasoning, and the same stderr + exit-134 shape, as `!` and as
 * Stage 41's out-of-range index. Recorded in docs/divergences.md. */

static void nt_as_fail(const char *what, const char *detail, const char *loc) {
  fflush(stdout);
  fprintf(stderr, "panic: type assertion failed: the value is not %s\n", what ? what : "?");
  if (detail && *detail) fprintf(stderr, "  %s\n", detail);
  if (loc && *loc) fprintf(stderr, "  at %s\n", loc);
  fprintf(stderr, "  help: `as` does not convert a value — it reinterprets the bytes at "
                  "the asserted type's layout, so nativets checks the assertion rather "
                  "than trusting it. Narrow with a `switch` on the discriminant, an "
                  "`x.kind === \"...\"` test, or `typeof`, instead of asserting\n");
  fflush(stderr);
  abort();
}

/* `expr as T` where T is a member of a DISCRIMINATED union. A `U<…>` value IS the member
 * pointer, the tag living inside it as the discriminant field at slot `index` — so the
 * assertion is checkable, and must be checked: retyping one member to another
 * reinterprets the same bytes at a different member's field layout and hands back a
 * NEIGHBOURING SLOT, typically a `char *` loaded as a `double`, rather than anything
 * that looks wrong.
 *
 * `allowed` is a COMMA-SEPARATED list of tag values the assertion accepts. It holds more
 * than one when several members widen to the same shape — which makes them
 * layout-identical, and so equally safe to read. A comma cannot occur inside a tag value
 * (TAG_FORBIDDEN, ast.ts), so the list never needs escaping. */
void nt_as_tag(const int64_t *obj, double index, const char *allowed,
               const char *what, const char *loc) {
  const char *tag = obj ? (const char *)(intptr_t)obj[(int64_t)index] : NULL;
  if (tag) {
    size_t n = strlen(tag);
    for (const char *p = allowed; p && *p;) {
      const char *c = strchr(p, ',');
      size_t len = c ? (size_t)(c - p) : strlen(p);
      if (len == n && memcmp(p, tag, n) == 0) return;
      if (!c) break;
      p = c + 1;
    }
  }
  char detail[256];
  snprintf(detail, sizeof(detail), "its tag is \"%s\"; the assertion requires one of: %s",
           tag ? tag : "(none)", allowed ? allowed : "");
  nt_as_fail(what, detail, loc);
}

/* `expr as T` across a BOX boundary. A general union `G<…>` and a nullable `?U…` are both
 * 2-slot [tag, value] blocks, so the assertion is a tag test and the result is the
 * unboxed slot. `want >= 0` is a general union's member index; `want < 0` means "any
 * value that is PRESENT", the nullable case, where tags 0 and 1 are undefined and null.
 *
 * Without this an `as` across the boundary was not merely unchecked, it did not COMPILE:
 * the identity retype handed a `ptr` to an instruction expecting a `double`, and the user
 * saw clang's verifier error with no NT code and no location in their own program. */
int64_t nt_as_unbox(const int64_t *box, double want, const char *what, const char *loc) {
  int64_t w = (int64_t)want;
  if (box && (w < 0 ? box[0] >= 2 : box[0] == w)) return box[1];
  const char *detail = !box ? "it is empty"
                     : w >= 0 ? "it holds a different arm of the union"
                     : box[0] == 1 ? "it is null" : "it is undefined";
  nt_as_fail(what, detail, loc);
  return 0; /* unreachable — nt_as_fail aborts */
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

/* console.error / console.warn — the same renderers, on STDERR (Stage 49).
 * `begin` flushes stdout first: stdout is fully buffered when piped and stderr is
 * not, so without it a merged `2>&1` capture would show the two streams reordered. */
void js_eprint_begin(void) { fflush(stdout); }

void js_eprint_num(double v) {
  if (v == 0.0 && signbit(v)) { fputs("-0", stderr); return; }
  char buf[64];
  js_number_to_string(v, buf, sizeof(buf));
  fputs(buf, stderr);
}

void js_eprint_bool(int32_t b) { fputs(b ? "true" : "false", stderr); }
void js_eprint_str(const char *s) { fputs(s, stderr); }
void js_eprint_sep(void) { fputc(' ', stderr); }
void js_eprint_newline(void) { fputc('\n', stderr); }

/* The guard behind a NON-LITERAL format string (Stage 49). nativets expands format
 * specifiers at COMPILE time from the literal, which is what makes them free and
 * type-directed; when the format string is a runtime value we cannot know whether it
 * contains one. Printing the arguments space-separated would be node-correct only if
 * it does NOT — so we check node's exact rule here and, if a specifier WOULD be
 * consumed, refuse loudly rather than print a line node would have formatted.
 * `argc` counts the arguments AFTER the format string. */
void nt_fmt_guard(const char *fmt, double argcd) {
  if (!fmt) return;
  int64_t argc = (int64_t)argcd; /* excluding the format string itself */
  int64_t a = 0;
  size_t len = strlen(fmt);
  for (size_t i = 0; i + 1 < len; i++) {
    if (fmt[i] != '%') continue;
    char next = fmt[++i];
    if (a != argc) {
      if (next == '%' || strchr("sdifjoOc", next)) goto refuse;
      continue; /* not a placeholder — left literal, consumes nothing */
    }
    if (next == '%') goto refuse;
  }
  return;
refuse:
  fflush(stdout);
  fprintf(stderr, "panic: console format specifier in a non-literal format string: \"%s\"\n", fmt);
  fputs("  help: nativets expands `%s`/`%d`/… at compile time, so the format string must be a\n"
        "        literal — build the line with a template literal (`${x}`) or pass a literal format\n", stderr);
  fflush(stderr);
  abort();
}

/* ---- string operations ---- */

const char *js_str_concat(const char *a, const char *b) {
  size_t la = nt_strlen(a), lb = nt_strlen(b);
  /* `+` shares the cap but NOT the overflow: both operands are strings already in memory,
   * so `la + lb` cannot wrap. It can still step past what node can represent, and node
   * raises `Invalid string length` there — so a concatenation that outgrows the maximum
   * must stop rather than answer a string node would refuse to build. One compare. */
  if ((double)la + (double)lb > NT_MAX_STR_LEN) nt_panic_str_len("the concatenation", (double)la + (double)lb);
  char *out = (char *)nativets_alloc(la + lb + 1);
  memcpy(out, a, la);
  memcpy(out + la, b, lb);
  out[la + lb] = '\0';
  nt_str_register(out);
  return out;
}

double js_str_len(const char *s) { return (double)nt_strlen(s); }

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

/* StrWhiteSpace is the SAME set the trims use (ECMAScript WhiteSpace + LineTerminator),
 * so `Number(x)` and `x.trim()` cannot disagree about what a blank string is. Defined
 * further down next to js_str_trim; forward-declared here rather than moved, so the one
 * canonical table stays where its comment explains it. */
static const char *nt_ws_skip_fwd(const char *s, const char *end);
static const char *nt_ws_skip_back(const char *start, const char *end);

/* ---- StrDecimalLiteral — ECMA-262 7.1.4.1, the grammar `Number(string)` and
 * `parseFloat` are both defined on. ------------------------------------------------
 *
 *     StrDecimalLiteral ::: [+-]opt StrUnsignedDecimalLiteral
 *     StrUnsignedDecimalLiteral ::: Infinity
 *                                 | DecimalDigits . DecimalDigits_opt ExponentPart_opt
 *                                 | . DecimalDigits ExponentPart_opt
 *                                 | DecimalDigits ExponentPart_opt
 *
 * `strtod` is NOT this grammar, and every place it is wider was a silent wrong answer:
 * it accepts `inf` / `infinity` / `INFINITY` in ANY case where JS spells it exactly
 * `Infinity` (so `Number("infinity")` handed back a finite-looking Infinity and the
 * program kept running), and it accepts C99 hex floats, so `Number("0x1p3")` was 8
 * where node says NaN. There is no hex form in StrDecimalLiteral at all, which is why
 * `parseFloat("0x1f")` is 0 — it stops at the `x`.
 *
 * So the SHAPE is matched here and strtod is asked only for the VALUE, which is the
 * part it is good at: correctly rounded, unlike any hand-rolled digit loop. The two
 * ends then agree on where the literal stops in every case but one — a `0x`/`0X`
 * prefix, which this grammar reads as the single digit `0` — and that one is answered
 * without calling strtod at all.
 *
 * Returns the end of the match, or NULL when there is no StrDecimalLiteral at `s`. */
static const char *nt_scan_decimal(const char *s, const char *limit, double *out) {
  const char *p = s;
  int neg = 0;
  if (p < limit && (*p == '+' || *p == '-')) { neg = (*p == '-'); p++; }
  if (limit - p >= 8 && memcmp(p, "Infinity", 8) == 0) {   /* exact case, no `inf` */
    *out = neg ? -INFINITY : INFINITY;
    return p + 8;
  }
  const char *ints = p;
  while (p < limit && *p >= '0' && *p <= '9') p++;
  int has_int = p > ints, has_frac = 0;
  if (p < limit && *p == '.') {
    const char *frac = ++p;
    while (p < limit && *p >= '0' && *p <= '9') p++;
    has_frac = p > frac;
  }
  if (!has_int && !has_frac) return NULL;   /* "", ".", "+", "e5" — no mantissa */
  if (p < limit && (*p == 'e' || *p == 'E')) {
    const char *q = p + 1;
    if (q < limit && (*q == '+' || *q == '-')) q++;
    const char *dig = q;
    while (q < limit && *q >= '0' && *q <= '9') q++;
    if (q > dig) p = q;                     /* a digitless `e` is simply not part of it */
  }
  /* The only place strtod would run PAST us: the match is exactly `0` and a hex float
   * starts here. In this grammar that is the digit zero and the `x` is where it ends. */
  if (p == ints + 1 && *ints == '0' && p < limit && (*p == 'x' || *p == 'X')) {
    *out = neg ? -0.0 : 0.0;
    return p;
  }
  *out = strtod(s, NULL);
  return p;
}

/* NonDecimalIntegerLiteral — the `0b` / `0o` / `0x` prefixes. ES2015 added the first
 * two to StringNumericLiteral; this runtime knew only `0x`, so `Number("0b101")` was
 * NaN. A SIGN is not part of this production, which the old code also got wrong in the
 * loud-to-silent direction: `Number("-0x10")` answered -16 where node says NaN.
 *
 * The digits fold into a 64-bit significand with a sticky low bit, scaled once by
 * ldexp. Every radix here is a power of two, so that is a single rounding and a
 * 300-digit hex string is as correctly rounded as a short one; `v = v * radix + d` in
 * double would round at every step. Returns the end of the match, or NULL. */
static const char *nt_scan_nondecimal(const char *s, const char *limit, double *out) {
  int bits;
  if (limit - s < 3 || s[0] != '0') return NULL;
  switch (s[1]) {
    case 'b': case 'B': bits = 1; break;
    case 'o': case 'O': bits = 3; break;
    case 'x': case 'X': bits = 4; break;
    default: return NULL;
  }
  const char *p = s + 2, *first = p;
  uint64_t mant = 0;
  int shift = 0;                            /* bit places dropped below `mant` */
  for (; p < limit; p++) {
    unsigned c = (unsigned char)*p, v;
    if (c >= '0' && c <= '9') v = c - '0';
    else if (bits == 4 && c >= 'a' && c <= 'f') v = c - 'a' + 10;
    else if (bits == 4 && c >= 'A' && c <= 'F') v = c - 'A' + 10;
    else break;
    if (v >= (1u << bits)) break;           /* `8` in an octal literal, `2` in a binary one */
    /* `mant` full: the digit is entirely below the significand, so it can only set the
     * sticky bit. `shift` STOPS at 65536 — anything at all is already Infinity by then,
     * and letting a long enough literal overflow a signed int would be UB. */
    if (mant >> (64 - bits)) { if (shift < 65536) shift += bits; if (v) mant |= 1; }
    else mant = (mant << bits) | v;
  }
  if (p == first) return NULL;              /* `0x` with no digits after it */
  *out = ldexp((double)mant, shift);
  return p;
}

/* Number(string) / unary + on string — ToNumber applied to StringNumericLiteral:
 * StrWhiteSpace on both sides, empty (or blank) is 0, and ANY trailing garbage is NaN. */
double js_str_to_num(const char *s) {
  const char *end = s + nt_strlen(s);
  const char *p = nt_ws_skip_fwd(s, end);
  end = nt_ws_skip_back(p, end);
  if (p == end) return 0.0;                 /* StrWhiteSpace only */
  double v;
  const char *q = nt_scan_nondecimal(p, end, &v);
  if (q == NULL) q = nt_scan_decimal(p, end, &v);
  return q == end ? v : NAN;
}

/* Math.round — ECMA-262 21.3.2.28, which is NOT `floor(x + 0.5)`.
 *
 * This WAS `floor(x + 0.5)`, and that formulation is wrong in two ways, both silent:
 *
 *  - `x + 0.5` is a DOUBLE add, so it ROUNDS. For x = 0.49999999999999994 (the largest
 *    double below 0.5) the sum is exactly 1.0 and the floor returns 1; the spec says 0.
 *    Past 2^52 the same rounding walks whole integers: round(9007199254740991) returned
 *    9007199254740992, i.e. `Math.round(Number.MAX_SAFE_INTEGER) !== Number.MAX_SAFE_INTEGER`.
 *  - `floor` returns +0 for the whole of [-0.5, -0]; the spec returns -0 there (steps 1
 *    and 4), which `1 / Math.round(-0.5)` observes as -Infinity vs Infinity.
 *
 * The spec, in order: an integral (or non-finite) x is returned AS IS — which covers ±0,
 * ±Infinity, NaN and every large value, and is what makes the 2^52 problem impossible.
 * Then the two zero-sign rules, then the ordinary half-up-toward-+Infinity round, done on
 * the FRACTIONAL part (`x - floor(x)`, exact for every double) so nothing rounds early. */
double js_math_round(double x) {
  if (isnan(x) || isinf(x) || x == floor(x)) return x;  /* incl. ±0 and every |x| >= 2^52 */
  if (x > 0 && x < 0.5) return 0.0;                     /* step 3 */
  if (x < 0 && x >= -0.5) return -0.0;                  /* step 4 — the sign matters */
  double f = floor(x);                                  /* |x| < 2^52 here, so f and f+1 are exact */
  return x - f >= 0.5 ? f + 1.0 : f;                    /* ties go toward +Infinity */
}

/* Math.max / Math.min, folded PAIRWISE. C's fmax/fmin are the wrong identity twice
 * over: fmax(NaN, 1) is 1 (JS propagates the NaN), and IEEE-754 maxNum leaves the
 * +0/-0 case unspecified (JS orders them, ECMA-262: "+0 is considered larger than
 * -0"). Both are silent-wrong-answer shaped, so spell the semantics out. */
double js_math_max(double a, double b) {
  if (isnan(a) || isnan(b)) return NAN;
  if (a > b) return a;
  if (b > a) return b;
  /* equal, or both zero: prefer +0 over -0 */
  if (a == 0.0 && signbit(a)) return b;
  return a;
}

double js_math_min(double a, double b) {
  if (isnan(a) || isnan(b)) return NAN;
  if (a < b) return a;
  if (b < a) return b;
  /* equal, or both zero: prefer -0 over +0 */
  if (a == 0.0 && !signbit(a)) return b;
  return a;
}

/* `**` and Math.pow — ECMA-262 Number::exponentiate, NOT C `pow`.
 *
 * The two agree on every input but one FAMILY, and C is deliberately wrong there:
 * C99 F.10.4.4 specifies pow(+1, y) = 1 for ANY y "even a NaN", and pow(±1, ±inf) = 1,
 * because C wanted pow to be continuous in the exponent when the base is exactly 1.
 * ECMA-262 declines both: step 1 returns NaN whenever the exponent is NaN (the base is
 * never consulted), and step 8 returns NaN when the base is finite with magnitude 1 and
 * the exponent is ±Infinity. So `1 ** NaN`, `(±1) ** ±Infinity` are all NaN in JS and
 * all 1 in C — five of the eight (base, exponent) edge pairs, every one of them a
 * silent wrong answer at exit 0.
 *
 * One guard covers the whole family: a unit-magnitude base with a non-finite exponent.
 * `!isfinite(b)` is true for both NaN and ±Infinity, which is exactly the two clauses.
 * Everything else — ±0, ±Infinity bases, the odd-integral sign rules, and the
 * negative-base/fractional-exponent NaN — C already matches the spec on, so it stays
 * with libm rather than being re-derived here. */
double js_pow(double a, double b) {
  if (fabs(a) == 1.0 && !isfinite(b)) return NAN;
  return pow(a, b);
}

/* ---- parseInt (ECMA-262 §19.2.5) ------------------------------------------------
 *
 * This used to be `strtol` with a hand-rolled prologue, which was wrong three ways, all
 * of them silent:
 *
 *   1. `strtol` reads its OWN sign, after we had already read one. `parseInt("--1")`
 *      came back 1 and `parseInt("+-1")` came back -1 — the second, inner sign WON, so
 *      the answer was not merely wrong, it was inverted. Both are NaN in node.
 *   2. `(double)(sign * v)` cannot produce -0, so `parseInt("-0")` was 0. Invisible
 *      through `String()` (both "0"), visible through `console.log`.
 *   3. `long` SATURATES at INT64_MAX, so every input above 2^63 returned the one
 *      constant 9223372036854775807. The value has to be built as a double.
 *
 * The grammar below is V8's `StringToIntHelper::DetectRadixInternal`, and the three
 * accumulators are V8's three. Matching V8's ARITHMETIC — not just its grammar — is
 * deliberate: for a radix that is not 2, 4, 8, 10, 16 or 32 the spec explicitly permits
 * "an implementation-dependent approximation to the mathematical integer value", and
 * node takes it. `parseInt("9007199254740993", 36)` is 1.9896986116031812e+24 in node
 * where the correctly-rounded answer is 1.989698611603181e+24, so a bignum here would
 * be *more* accurate and would fail the prime directive. Verified against node over 436
 * random (digits, radix) pairs spanning every non-special radix: 436/436.
 *
 * `nt_pi_generic` writes its accumulation as ONE expression on purpose. clang contracts
 * `result * multiplier + part` to a fused multiply-add wherever the target has one, and
 * V8 is built by the same compiler under the same default (`-ffp-contract=on`) — so the
 * fused form on arm64 and the unfused form on baseline x86-64 are BOTH what the local
 * node does. Forcing either one (an explicit `fma()`, or `-ffp-contract=off`) would make
 * us disagree with node on the other half of our targets. Do not "fix" it.
 */

/* parseInt's leading trim is `nt_ws_skip_fwd` — the SAME WhiteSpace + LineTerminator set
 * the trims and `Number(x)` use, not the four ASCII spaces this used to skip. It is
 * forward-declared once, above, with the rest of the string-to-number grammar. */

/* V8 `isDigit`, folded into a value: the digit's value in `radix`, or -1. */
static int nt_pi_digit(int c, int radix) {
  if (c >= '0' && c <= '9' && c < '0' + radix) return c - '0';
  if (radix > 10 && c >= 'a' && c < 'a' + radix - 10) return c - 'a' + 10;
  if (radix > 10 && c >= 'A' && c < 'A' + radix - 10) return c - 'A' + 10;
  return -1;
}

/* Radix 2/4/8/16/32 — V8 `InternalStringToIntDouble`. Exact: accumulate into the low 53
 * bits, then round the dropped bits to nearest-even with a sticky tail. Returns the
 * MAGNITUDE; the caller applies the sign, as V8's `GetResult` does. */
static double nt_pi_pow2(const char *cur, const char *end, int radix, int log2r) {
  int64_t number = 0;
  int exponent = 0;
  for (;;) {
    int digit = nt_pi_digit((unsigned char)*cur, radix);
    if (digit < 0) break; /* trailing junk is allowed and ignored */
    number = number * radix + digit;
    int overflow = (int)(number >> 53);
    if (overflow != 0) {
      int overflow_bits = 1;
      while (overflow > 1) { overflow_bits++; overflow >>= 1; }
      int dropped = (int)number & ((1 << overflow_bits) - 1);
      number >>= overflow_bits;
      exponent = overflow_bits;
      int zero_tail = 1;
      for (;;) {
        ++cur;
        if (cur == end || nt_pi_digit((unsigned char)*cur, radix) < 0) break;
        if (*cur != '0') zero_tail = 0;
        /* Clamped: past ~1100 the result is already Infinity, and an unclamped `int`
         * would overflow (UB) on a multi-gigadigit string. */
        if (exponent < 100000) exponent += log2r;
      }
      int middle = 1 << (overflow_bits - 1);
      if (dropped > middle) number++;
      else if (dropped == middle && ((number & 1) != 0 || !zero_tail)) number++;
      if ((number & ((int64_t)1 << 53)) != 0) { exponent++; number >>= 1; }
      break;
    }
    ++cur;
    if (cur == end) break;
  }
  return exponent == 0 ? (double)number : ldexp((double)number, exponent);
}

/* Radix 10 — V8 `HandleBaseTenCase`: hand the digit run to libc's correctly-rounded
 * strtod. Digits past the 310th are dropped exactly as V8 drops them, and that is not
 * an approximation: any value with more than 309 digits is already past DBL_MAX, so the
 * truncated prefix and the true value both round to Infinity. */
static double nt_pi_base10(const char *cur, const char *end) {
  char buf[312];
  size_t n = 0;
  while (cur != end && *cur >= '0' && *cur <= '9') {
    if (n <= 309) buf[n++] = *cur;
    ++cur;
  }
  buf[n] = '\0';
  return strtod(buf, NULL);
}

/* Every other radix — V8 `NumberParseIntHelper::HandleGenericCase`. Digits go into a
 * uint32 `part` for as long as the multiplier stays under kMaxUInt32/36, then one
 * multiply-add folds the chunk into the double. See the note above about contraction. */
static double nt_pi_generic(const char *cur, const char *end, int radix) {
  double result = 0.0;
  int done = 0;
  do {
    uint32_t part = 0, multiplier = 1;
    for (;;) {
      if (cur == end) { done = 1; break; }
      int d = nt_pi_digit((unsigned char)*cur, radix);
      if (d < 0) { done = 1; break; } /* trailing junk is allowed and ignored */
      uint32_t m = multiplier * (uint32_t)radix;
      if (m > 0xFFFFFFFFu / 36u) break; /* chunk full; this digit starts the next one */
      part = part * (uint32_t)radix + (uint32_t)d;
      multiplier = m;
      ++cur;
    }
    result = result * multiplier + part;
  } while (!done);
  return result;
}

double js_parse_int(const char *s, double radixd) {
  const char *end = s + nt_strlen(s);
  const char *cur = nt_ws_skip_fwd(s, end);
  if (cur == end) return NAN; /* empty, or whitespace only */

  /* Exactly ONE optional sign. Anything after it that is not a digit is junk. */
  int negative = 0;
  if (*cur == '+' || *cur == '-') {
    negative = (*cur == '-');
    if (++cur == end) return NAN; /* a bare "+" / "-" */
  }

  /* ToInt32 first, so `parseInt("11", 2 ** 32 + 16)` is a radix-16 parse, not junk. */
  int radix = (int)to_int32(radixd);
  if (radix != 0 && (radix < 2 || radix > 36)) return NAN;

  int leading_zero = 0;
  if (radix == 0 || radix == 16) {
    if (radix == 0) radix = 10; /* the default, unless a `0x` prefix says otherwise */
    if (*cur == '0') {
      if (++cur == end) return negative ? -0.0 : 0.0;
      if (*cur == 'x' || *cur == 'X') {
        radix = 16;
        if (++cur == end) return NAN; /* "0x" with nothing after it */
      } else {
        leading_zero = 1;
      }
    }
  }
  while (*cur == '0') {
    leading_zero = 1;
    if (++cur == end) return negative ? -0.0 : 0.0; /* all zeros: SIGNED zero */
  }
  if (nt_pi_digit((unsigned char)*cur, radix) < 0) {
    /* Leading zeros then junk is zero ("-0.9" is -0); junk with no leading zero is NaN. */
    return leading_zero ? (negative ? -0.0 : 0.0) : NAN;
  }

  double v;
  switch (radix) {
    case 10: v = nt_pi_base10(cur, end); break;
    case 2:  v = nt_pi_pow2(cur, end, 2, 1); break;
    case 4:  v = nt_pi_pow2(cur, end, 4, 2); break;
    case 8:  v = nt_pi_pow2(cur, end, 8, 3); break;
    case 16: v = nt_pi_pow2(cur, end, 16, 4); break;
    case 32: v = nt_pi_pow2(cur, end, 32, 5); break;
    default: v = nt_pi_generic(cur, end, radix); break;
  }
  return negative ? -v : v;
}
/* parseFloat is the LONGEST-PREFIX read of the same StrDecimalLiteral: trailing garbage
 * is ignored rather than fatal, and the `0b`/`0o`/`0x` prefixes are NOT in this grammar
 * (that is Number's extra production alone), so `parseFloat("0x1f")` is 0, not 31. */
double js_parse_float(const char *s) {
  const char *end = s + nt_strlen(s);
  const char *p = nt_ws_skip_fwd(s, end);
  double v;
  return nt_scan_decimal(p, end, &v) ? v : NAN;
}

/* ---- string methods (byte-oriented; ASCII-correct) ---- */

/* All string-method results flow through here; register each as a heap string so
 * it is rc-tracked (slice/substring/upper/lower/trim/repeat/padStart/charAt, and
 * the pieces produced by nt_str_split). */
static char *alloc_str(size_t n) { char *p = (char *)nativets_alloc(n + 1); nt_str_register(p); return p; }

/* ---- toUpperCase / toLowerCase over U+0000..U+017F ------------------------------
 *
 * These two used to be a byte-wise ASCII shift, so every non-ASCII letter came back
 * UNMAPPED: `"é".toUpperCase()` returned `"é"` where node gives `"É"`. The bytes were
 * well-formed UTF-8 either way — just the unmapped input — so nothing signalled the miss.
 * A silent wrong answer, and docs/divergences.md §A.2 does not cover it: §A.2 is about
 * the UNIT a string is MEASURED and SLICED in (our UTF-8 bytes vs node's UTF-16 code
 * units), while this is about WHICH CHARACTER a character maps to. `é` -> `É` is two
 * bytes to two bytes in either encoding.
 *
 * WHERE THE BOUNDARY IS, AND WHY (docs/divergences.md §A.4). `runtime/` is libc-only so
 * it cross-links to macOS/Linux/iOS/Android/Windows/wasm. That rules out `towupper`,
 * whose answer depends on the process LOCALE — the same program would print different
 * bytes on two machines, which is worse than a documented gap. It also rules out the
 * full Unicode case tables: 2981 code points are cased, plus the CONTEXT-sensitive rules
 * (final sigma) and the LOCALE-sensitive ones (Turkish dotted/dotless i), none of which a
 * `const char *` with no locale argument can even express.
 *
 * U+0000..U+017F — ASCII, Latin-1 Supplement, Latin Extended-A — is 360 of those code
 * points and collapses to six arithmetic rules per direction plus eight exceptions, so it
 * is EXACT at negligible size. From U+0180 up (Latin Extended-B, Greek, Cyrillic, …) the
 * mapping is the IDENTITY here and differs from node.
 *
 * NO UTF-8 DECODER IS NEEDED, and that is the safety argument, not an optimization: the
 * covered range is SELF-IDENTIFYING in UTF-8. U+0000..U+007F is one byte below 0x80;
 * U+0080..U+017F is two bytes with a lead in 0xC2..0xC5. No continuation byte (0x80..0xBF)
 * and no other lead byte can be mistaken for either, so any byte that does not begin a
 * covered scalar is copied through ONE AT A TIME and a longer sequence reassembles itself
 * untouched. Ill-formed input therefore passes through verbatim instead of being
 * "corrected" into different bytes — the failure mode of a decoder that guesses. */

/* Encode a BMP code point as UTF-8. Every mapping target below is < U+0800, but the
 * three-byte arm is kept so this stays correct if the table ever grows. */
static int nt_case_enc(unsigned cp, unsigned char *o) {
  if (cp < 0x80) { o[0] = (unsigned char)cp; return 1; }
  if (cp < 0x800) { o[0] = (unsigned char)(0xC0 | (cp >> 6)); o[1] = (unsigned char)(0x80 | (cp & 0x3F)); return 2; }
  o[0] = (unsigned char)(0xE0 | (cp >> 12));
  o[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
  o[2] = (unsigned char)(0x80 | (cp & 0x3F));
  return 3;
}

/* The case mapping of ONE code point, UTF-8-encoded into `o` (at most 3 bytes).
 * Returns the byte count, or 0 for "maps to itself" — which lets the caller copy the
 * ORIGINAL bytes and so never re-encodes anything it did not deliberately change.
 * `up` selects toUpperCase (1) or toLowerCase (0).
 *
 * The exceptions are tested FIRST because two of them sit inside an arithmetic range and
 * would otherwise be swallowed by it: U+0131 `ı` is odd in U+0100..U+0137 (the pair rule
 * would say U+0130, node says `I`), and U+0130 `İ` is even in the same run (the pair rule
 * would say U+0131, node says `i` + COMBINING DOT ABOVE).
 *
 * Three of them are LENGTH-CHANGING, which is why neither of these functions can work in
 * place or size its output from its input: `ß` -> `SS`, `ŉ` -> `ʼN`, `İ` -> `i` + U+0307
 * all produce more characters than they consume, while `ı` -> `I` and `ſ` -> `S` produce
 * fewer bytes. All five are the UNCONDITIONAL entries of SpecialCasing.txt; the
 * conditional ones (final sigma, Lithuanian, Turkish) are out of scope by the paragraph
 * above, and none of them has a source in this range. */
static int nt_case_map(unsigned cp, int up, unsigned char *o) {
  if (up) {
    switch (cp) {
      case 0x00B5: return nt_case_enc(0x039C, o);                 /* µ -> Μ (leaves the block) */
      case 0x00DF: o[0] = 'S'; o[1] = 'S'; return 2;              /* ß -> SS */
      case 0x00FF: return nt_case_enc(0x0178, o);                 /* ÿ -> Ÿ */
      case 0x0131: o[0] = 'I'; return 1;                          /* ı -> I */
      case 0x0149: { int k = nt_case_enc(0x02BC, o); o[k] = 'N'; return k + 1; } /* ŉ -> ʼN */
      case 0x017F: o[0] = 'S'; return 1;                          /* ſ -> S */
      default: break;
    }
    if (cp >= 0x61 && cp <= 0x7A) return nt_case_enc(cp - 0x20, o);              /* a-z */
    if (cp >= 0xE0 && cp <= 0xFE && cp != 0xF7) return nt_case_enc(cp - 0x20, o); /* à-þ, not ÷ */
    /* Latin Extended-A pairs. Three runs are (even = capital, odd = small) and one,
     * U+0139..U+0148, is offset by one so the parity flips. U+0138 `ĸ` and U+0149 `ŉ`
     * fall between runs and are caseless / handled above. */
    if (cp >= 0x100 && cp <= 0x137 && (cp & 1)) return nt_case_enc(cp - 1, o);
    if (cp >= 0x139 && cp <= 0x148 && !(cp & 1)) return nt_case_enc(cp - 1, o);
    if (cp >= 0x14A && cp <= 0x177 && (cp & 1)) return nt_case_enc(cp - 1, o);
    if (cp >= 0x179 && cp <= 0x17E && !(cp & 1)) return nt_case_enc(cp - 1, o);
    return 0;
  }
  switch (cp) {
    case 0x0130: { o[0] = 'i'; int k = nt_case_enc(0x0307, o + 1); return k + 1; } /* İ -> i̇ */
    case 0x0178: return nt_case_enc(0x00FF, o);                                    /* Ÿ -> ÿ */
    default: break;
  }
  if (cp >= 0x41 && cp <= 0x5A) return nt_case_enc(cp + 0x20, o);               /* A-Z */
  if (cp >= 0xC0 && cp <= 0xDE && cp != 0xD7) return nt_case_enc(cp + 0x20, o); /* À-Þ, not × */
  if (cp >= 0x100 && cp <= 0x137 && !(cp & 1)) return nt_case_enc(cp + 1, o);
  if (cp >= 0x139 && cp <= 0x148 && (cp & 1)) return nt_case_enc(cp + 1, o);
  if (cp >= 0x14A && cp <= 0x177 && !(cp & 1)) return nt_case_enc(cp + 1, o);
  if (cp >= 0x179 && cp <= 0x17E && (cp & 1)) return nt_case_enc(cp + 1, o);
  return 0;
}

/* Decode the covered scalar starting at `s[i]`, or report "not one of ours".
 * Returns its byte length (1 or 2) and stores the code point; returns 0 for every other
 * byte, which the caller then copies through singly. See the self-identifying argument
 * in the block comment above. */
static int nt_case_scalar(const unsigned char *s, size_t n, size_t i, unsigned *cp) {
  if (s[i] < 0x80) { *cp = s[i]; return 1; }
  if (s[i] >= 0xC2 && s[i] <= 0xC5 && i + 1 < n && (s[i + 1] & 0xC0) == 0x80) {
    *cp = ((unsigned)(s[i] & 0x1F) << 6) | (unsigned)(s[i + 1] & 0x3F);
    return 2;
  }
  return 0;
}

/* Two passes over the input, both driving the SAME mapper: the first sizes the output
 * exactly, the second fills it. Sizing from the mapper rather than from a growth bound
 * is deliberate — a mapping added to `nt_case_map` later cannot overrun a buffer that was
 * measured by `nt_case_map` itself, whereas any "output is at most 1.5x the input" rule
 * written here would silently stop being true. */
static const char *nt_case_impl(const char *s, int up) {
  const unsigned char *b = (const unsigned char *)s;
  size_t n = nt_strlen(s);
  unsigned char buf[4];
  size_t out_n = 0;
  for (size_t i = 0; i < n;) {
    unsigned cp; int len = nt_case_scalar(b, n, i, &cp);
    if (len == 0) { out_n += 1; i += 1; continue; }
    int m = nt_case_map(cp, up, buf);
    out_n += m ? (size_t)m : (size_t)len;
    i += (size_t)len;
  }
  char *o = alloc_str(out_n);
  size_t w = 0;
  for (size_t i = 0; i < n;) {
    unsigned cp; int len = nt_case_scalar(b, n, i, &cp);
    if (len == 0) { o[w++] = (char)b[i]; i += 1; continue; }
    int m = nt_case_map(cp, up, buf);
    if (m) { memcpy(o + w, buf, (size_t)m); w += (size_t)m; }
    else { memcpy(o + w, b + i, (size_t)len); w += (size_t)len; }
    i += (size_t)len;
  }
  o[w] = 0; return o;
}

const char *js_str_upper(const char *s) { return nt_case_impl(s, 1); }
const char *js_str_lower(const char *s) { return nt_case_impl(s, 0); }
const char *js_str_char_at(const char *s, double id) {
  long n = (long)nt_strlen(s); long i = (long)id;
  if (i < 0 || i >= n) return nt_empty_str();
  return nt_ch1((unsigned char)s[i]);
}
/* `s[i]` as WRITTEN — out of range PANICS. `.charAt(i)` above keeps node's semantics
 * (it is DEFINED to return "" out of range, so it is not a defect) and `.at(i)` returns
 * `string | undefined`; only the bracket index, whose node value is `undefined`, panics. */
const char *nt_str_index(const char *s, double id, const char *loc) {
  long n = (long)nt_strlen(s); long i = (long)id;
  if (!NT_IS_INDEX(id) || i < 0 || i >= n) nt_panic_bounds("string index", (double)n, id, loc);
  return nt_ch1((unsigned char)s[i]);
}
static const char *slice_impl(const char *s, double startd, double endd, int clampNeg) {
  long n = (long)nt_strlen(s);
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
/* ---- The trims: trim / trimEnd / trimStart, over ONE whitespace set. -------------
 *
 * ECMAScript `TrimString` strips WhiteSpace + LineTerminator, which is far more than
 * the ` \t\n\r` this used to match: 21 of the 25 code points went through untouched,
 * silently, at exit 0 (`" x ".trim()` returned its input). One predicate
 * now, shared by all three, so the set cannot be right in one and wrong in another.
 *
 * This is the SECOND copy of the set — `isSpace` in `src/lexer.ts` is the first, and
 * it cannot be reused directly: that one is TypeScript running in the frontend over
 * UTF-16 code units, this one is C running in the runtime over UTF-8 bytes. They are
 * pinned to each other by a test (`test/trim.test.ts`) that drives both over the same
 * table, which is the only coupling available across the language boundary.
 *
 * U+180E is deliberately ABSENT: it stopped being Zs in Unicode 6.3, and test262
 * (trim/u180e.js) asserts it survives a trim. */
static int nt_ws_cp(unsigned cp) {
  if (cp == 0x09 || cp == 0x0A || cp == 0x0B || cp == 0x0C || cp == 0x0D || cp == 0x20) return 1;
  return cp == 0xA0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
         cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F ||
         cp == 0x3000 || cp == 0xFEFF;
}
/* ---- The ONE UTF-8 decoder every string scanner shares. --------------------------
 *
 * `nt_utf8_len` decodes the sequence at `p` ONLY IF IT IS WELL FORMED, returning its byte
 * length (1..4); it returns 0 for anything else and touches `*cp` not at all. Every caller
 * answers a 0 the same way — TAKE THE ONE RAW BYTE AND ADVANCE ONE — which is what makes
 * ill-formed input pass through byte-identical instead of being re-framed or "corrected".
 *
 * WHY THIS IS A CORRECTNESS FIX AND NOT ROBUSTNESS POLISH. This used to size a sequence
 * from its LEAD BYTE ALONE and never check that the bytes after it were continuations. That
 * is safe only if strings are always well-formed UTF-8, and §A.2 guarantees the opposite:
 * `.length` and `.slice` are BYTE-oriented, so `" ".slice(0, 2)` is an ordinary
 * expression yielding the truncated lead pair `E2 80`. Append `"Axx"` and the old decoder
 * read `E2 80 41` as U+2001 EM QUAD — which `nt_ws_cp` calls whitespace — so `.trim()`
 * consumed all three bytes and DELETED THE `A`: `"xx"` where node prints `"Axx"`, exit 0,
 * well-formed output. `readFileSync(p, "utf8")` hands over file bytes verbatim, which
 * reaches the same class from outside the process, and reaches the OVERLONG forms too:
 * `C0 A0` decoded to U+0020 and was trimmed as a space.
 *
 * SURROGATES ARE DELIBERATELY ACCEPTED (this is WTF-8, not strict UTF-8). Our lexer and
 * `String.fromCharCode` emit `ED A0 80` for `\ud800`, and node's `codePointAt` answers
 * 55296; rejecting the sequence would answer 237 and BREAK agreement with node. So
 * "ill-formed" here means truncated, a missing continuation byte, an overlong form, a
 * continuation or `0xF8..0xFF` byte in lead position, or a value above U+10FFFF.
 *
 * `utf8_next` in the base64 section is the other decoder in this file. It is already strict
 * for the same reasons; it stays separate only because `btoa` needs a MALFORMED/-1 signal
 * rather than a fall-back-to-byte, which is the one place the raw-byte policy is wrong. */
static int nt_utf8_len(const unsigned char *p, const unsigned char *end, unsigned *cp) {
  unsigned c = p[0];
  if (c < 0x80) { *cp = c; return 1; }
  int need; unsigned v, min;
  if      ((c & 0xE0) == 0xC0) { need = 1; v = c & 0x1Fu; min = 0x80; }
  else if ((c & 0xF0) == 0xE0) { need = 2; v = c & 0x0Fu; min = 0x800; }
  else if ((c & 0xF8) == 0xF0) { need = 3; v = c & 0x07u; min = 0x10000; }
  else return 0;                                /* a continuation byte, or 0xF8..0xFF */
  if (end - p <= (long)need) return 0;          /* truncated — the bytes are not there */
  for (int k = 1; k <= need; k++) {
    if ((p[k] & 0xC0) != 0x80) return 0;        /* NOT a continuation — load-bearing */
    v = (v << 6) | (unsigned)(p[k] & 0x3F);
  }
  if (v < min || v > 0x10FFFF) return 0;        /* overlong, or beyond Unicode */
  *cp = v; return need + 1;
}
/* AN ILL-FORMED BYTE IS NEVER WHITESPACE, and the two scanners below say so by testing
 * `nt_ws_cp` ONLY on a code point `nt_utf8_len` actually decoded.
 *
 * The tempting shape — fall back to the raw byte and ask `nt_ws_cp` about that — is wrong
 * for the same reason the lead-byte-only decoder was: a RAW BYTE IS NOT A CODE POINT.
 * `nt_ws_cp` holds U+00A0 NBSP, so the byte 0xA0 tests TRUE, and `" ".slice(1, 2)` is
 * exactly how ordinary source produces a lone 0xA0 (§A.2 cuts bytes; NBSP encodes `C2 A0`).
 * That made `(tail + "x").trimStart()` eat the byte while `("x" + tail).trimEnd()` kept it
 * — the two ends of one `trim` disagreeing about one byte, which is proof on its own that
 * one of them was wrong. Found by MUTATION: swapping the fall-back value to U+FFFD changed
 * nothing any test could see, which is what pointed at the fall-back being consulted at all. */

/* Scan FORWARD past whitespace from `s`. */
static const char *nt_ws_skip_fwd(const char *s, const char *end) {
  const unsigned char *p = (const unsigned char *)s, *e = (const unsigned char *)end;
  while (p < e) {
    unsigned cp; int len = nt_utf8_len(p, e, &cp);
    if (len == 0 || !nt_ws_cp(cp)) break;
    p += len;
  }
  return (const char *)p;
}
/* Scan BACKWARD past whitespace from `end`, never below `start`. UTF-8 is
 * self-synchronizing: step back over continuation bytes (0b10xxxxxx) to find the
 * lead byte, then decode forward from there. */
static const char *nt_ws_skip_back(const char *start, const char *end) {
  const unsigned char *s = (const unsigned char *)start, *p = (const unsigned char *)end;
  while (p > s) {
    const unsigned char *q = p - 1;
    while (q > s && (*q & 0xC0) == 0x80) q--;
    unsigned cp; int len = nt_utf8_len(q, p, &cp);
    /* Only treat it as one character if it decoded AND spans exactly back to `p`; a
     * stray continuation byte is not whitespace and stops the scan. */
    if (len == 0 || q + len != p || !nt_ws_cp(cp)) break;
    p = q;
  }
  return (const char *)p;
}
static const char *nt_trim_impl(const char *s, int front, int back) {
  const char *end = s + nt_strlen(s);
  const char *start = front ? nt_ws_skip_fwd(s, end) : s;
  if (back) end = nt_ws_skip_back(start, end);
  long len = end - start; char *o = alloc_str((size_t)len); memcpy(o, start, (size_t)len); o[len] = 0; return o;
}
const char *js_str_trim(const char *s)       { return nt_trim_impl(s, 1, 1); }
const char *js_str_trim_end(const char *s)   { return nt_trim_impl(s, 0, 1); }
const char *js_str_trim_start(const char *s) { return nt_trim_impl(s, 1, 0); }
/* String#repeat(count) — ES 22.1.3.18. The COUNT is validated first (step 3: a negative
 * or +Infinity count is a RangeError whatever the receiver is), then the RESULT LENGTH.
 *
 * The size arithmetic is done in DOUBLE, not size_t, on purpose. `n * (size_t)count`
 * wrapped: `"abcd".repeat(2**62)` is 2^64 bytes, which truncates to 0, so this allocated
 * ONE byte and then memcpy'd 2^62 times into it — an out-of-bounds heap write in a
 * memory-safe compiler, observed as SIGBUS with empty stdout AND empty stderr (the
 * overflow had already smashed stdio's own buffer). A double holds every product up to
 * the 2^29 cap exactly, so the comparison below is exact and cannot itself wrap. */
const char *js_str_repeat(const char *s, double countd) {
  double count = nt_to_integer_or_infinity(countd);
  if (count < 0.0 || isinf(count)) nt_panic_repeat_count(count);
  size_t n = nt_strlen(s);
  double total = (double)n * count;   /* exact for every value that survives the cap */
  if (total > NT_MAX_STR_LEN) nt_panic_str_len("the repeated string", total);
  size_t need = (size_t)total;        /* <= 2^29, so the narrowing is lossless */
  char *o = alloc_str(need);
  for (size_t i = 0; i < need; i += n) memcpy(o + i, s, n);
  o[need] = 0; return o;
}
/* String#padStart(target, pad) — ES 22.1.3.17. Order matters and is node's: a target at
 * or below the current length returns the receiver, THEN an empty filler returns the
 * receiver (so `"abc".padStart(Infinity, "")` is `"abc"`, not a RangeError), and only
 * then is the result length checked. */
const char *js_str_pad_start(const char *s, double targetd, const char *pad) {
  double t = nt_to_integer_or_infinity(targetd);
  long n = (long)nt_strlen(s); size_t pn = nt_strlen(pad);
  if (t <= (double)n || pn == 0) { char *o = alloc_str((size_t)n); memcpy(o, s, n); o[n] = 0; return o; }
  if (t > NT_MAX_STR_LEN) nt_panic_str_len("the padded string", t);
  long target = (long)t; /* <= 2^29 after the cap, so this conversion is defined */
  long padlen = target - n; char *o = alloc_str((size_t)target);
  for (long i = 0; i < padlen; i++) o[i] = pad[i % pn];
  memcpy(o + padlen, s, (size_t)n); o[target] = 0; return o;
}
int32_t js_str_includes(const char *s, const char *sub) { return strstr(s, sub) != NULL ? 1 : 0; }
double js_str_index_of(const char *s, const char *sub) {
  const char *p = strstr(s, sub); return p ? (double)(p - s) : -1.0;
}
/* String#indexOf(search, fromIndex) — ECMA-262 22.1.3.9 step 4-5. `fromIndex` is
 * ToIntegerOrInfinity'd (NaN -> 0) and CLAMPED to [0, len]; the search then starts
 * there, and the answer is still an index into the WHOLE string. An empty needle
 * therefore answers the clamped position itself, including at len ("abc".indexOf("",9)
 * is 3). A separate entry point from the 1-arg form on purpose: the existing
 * declaration and every `.ll` it appears in stay byte-identical.
 * Byte indices, like every other string index here (docs/divergences.md A.2). */
double js_str_index_of_from(const char *s, const char *sub, double fromd) {
  size_t n = nt_strlen(s);
  size_t start;
  if (isnan(fromd) || fromd <= 0.0) start = 0;
  else if (fromd >= (double)n) start = n;
  else start = (size_t)fromd;
  const char *p = strstr(s + start, sub);
  return p ? (double)(p - s) : -1.0;
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

/* `fromIndex` for Array#indexOf / #lastIndexOf.
 *
 * NEITHER of these treats NaN as "absent": `ToIntegerOrInfinity(NaN)` is 0, so
 * `[1,2,1].lastIndexOf(1, NaN)` is 0, not 4. The ABSENT case is supplied by codegen
 * instead (0 forward, +Infinity backward) precisely so the two cannot be conflated —
 * and note String#lastIndexOf is the OTHER way round (ES 22.1.3.11 turns a NaN position
 * into +Infinity), which is why it keeps a NaN sentinel and these do not.
 *
 * The argument is TRUNCATED TOWARD ZERO BEFORE the underflow test, so on a 5-element
 * array `-5.5` is `-5`, i.e. index 0 — not an underflow. Comparing the raw double
 * against `-len` gets that wrong. */

/* ES 23.1.3.17 steps 4-7 — first index to scan FORWARD from; `len` means scan nothing.
 * A negative index counts from the end and UNDERFLOWS TO 0. */
static int64_t arr_from_start(int64_t len, double fromd) {
  if (fromd >= (double)len) return len;             /* incl. +Infinity: scan nothing */
  if (fromd == -INFINITY) return 0;                 /* NaN falls through: both are false */
  int64_t n = isnan(fromd) ? 0 : (int64_t)fromd;    /* ToIntegerOrInfinity(NaN) is 0 */
  if (n >= 0) return n;                             /* n < len here, and the loop bounds it */
  n += len;
  return n < 0 ? 0 : n;                             /* underflow clamps to 0 */
}
/* ES 23.1.3.20 steps 4-6 — first index to scan BACKWARD from, or -1 to scan nothing.
 * Same argument, deliberately different clamps: an index past the end becomes len-1
 * rather than "nothing", and a negative index that underflows gives up rather than
 * restarting at 0. */
static int64_t arr_from_end(int64_t len, double fromd) {
  if (fromd >= (double)len) return len - 1;         /* incl. +Infinity: min(n, len-1) */
  if (fromd == -INFINITY) return -1;                /* NaN falls through: both are false */
  int64_t n = isnan(fromd) ? 0 : (int64_t)fromd;    /* ToIntegerOrInfinity(NaN) is 0 */
  /* `min(n, len - 1)` — the min is LOAD-BEARING, not decoration, and EVERY non-negative
   * n has to go through it including the NaN-becomes-0 one. On an EMPTY array both `-0.5`
   * (which truncates toward zero to 0) and NaN would otherwise start the backward scan at
   * index 0 of zero elements: one past the end. The guard above does not catch either
   * (`-0.5 >= 0` is false, and every NaN comparison is false). Every INTEGER fromIndex
   * escapes this window, which is why it survived the first round of cases. */
  if (n >= 0) return n < len ? n : len - 1;
  return len + n;                                   /* may stay < 0: scan nothing */
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
    /* The superseded block is owned SOLELY by this header, so it must be released
     * here or every doubling abandons one: growing to n leaked the whole chain
     * (cap 4 -> 400 elements leaked 4064 bytes in 7 blocks). `a->data` never
     * escapes — `arr_freeze` already frees it after copying into the trie, and
     * every other holder (`nt_arr_copy`, `nt_arr_extend_own`) copies or MOVES it
     * with the source nulled — so nothing can still be reading the old block.
     * free(NULL) is a no-op, which covers a header that has no block yet. */
    free(a->data);
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
  if (!NT_IS_INDEX(idxd) || i < 0 || i >= a->len)
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
/* A boolean array joins as node spells booleans — `true`/`false`, not `1`/`0`, and not
 * a pointer. It needs its own join because neither sibling can serve: the slot holds
 * `zext i1` (the integers 0 and 1), so `nt_arr_join_str` ran `strlen((char *)1)` and
 * killed the process, and `nt_arr_join_num` would print the digits. See
 * test/boolean-array-join.test.ts. */
const char *nt_arr_join_bool(NtArray *a, const char *sep) {
  SB sb; sb_init(&sb); size_t sl = strlen(sep);
  for (int64_t i = 0; i < a->len; i++) {
    if (i > 0) sb_append(&sb, sep, sl);
    if (arr_at(a, i)) sb_append(&sb, "true", 4); else sb_append(&sb, "false", 5);
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
/* `.includes` is SameValueZero (ES 23.1.3.16 -> 7.2.11), NOT the strict equality the two
 * `indexOf` routines below use. SameValueZero differs from `===` at exactly ONE pair of
 * values: NaN equals NaN. C `==` is IEEE-754 equality, which is false whenever either
 * operand is NaN, so the plain scan answered `[NaN].includes(NaN)` with `false` where node
 * says `true` — at exit 0, so a silent wrong answer.
 *
 * The needle is tested for NaN ONCE, outside the loop, and picks the predicate: a NaN
 * needle matches a NaN element and nothing else, and a non-NaN needle keeps `==` exactly
 * (so a NaN ELEMENT never answers a non-NaN needle — NaN must not become a wildcard).
 *
 * It is SameValueZero and not SameValue: `+0` and `-0` are the SAME value here, which
 * `==` already gets right and which SameValue would get wrong. Do not "tighten" this into
 * a bit compare — `[-0].includes(0)` is `true` in node. `indexOf`/`lastIndexOf` stay on
 * `==` deliberately; `[NaN].indexOf(NaN)` is -1. See test/array-includes.test.ts. */
int32_t nt_arr_includes_num(NtArray *a, double x) {
  if (isnan(x)) {
    for (int64_t i = 0; i < a->len; i++) if (isnan(slot_to_num(arr_at(a, i)))) return 1;
    return 0;
  }
  for (int64_t i = 0; i < a->len; i++) if (slot_to_num(arr_at(a, i)) == x) return 1;
  return 0;
}
int32_t nt_arr_includes_str(NtArray *a, const char *x) {
  for (int64_t i = 0; i < a->len; i++) if (strcmp((const char *)(intptr_t) arr_at(a, i), x) == 0) return 1;
  return 0;
}
double nt_arr_indexof_num(NtArray *a, double x, double fromd) {
  for (int64_t i = arr_from_start(a->len, fromd); i < a->len; i++)
    if (slot_to_num(arr_at(a, i)) == x) return (double)i;
  return -1.0;
}
/* Math.max/Math.min over a SPREAD array: fold `acc` over every element with the JS
 * step above. An EMPTY array returns `acc` untouched, which is how the caller's
 * -Infinity / +Infinity identity survives `Math.max(...[])`. */
double js_math_fold_arr(NtArray *a, double acc, int32_t is_max) {
  for (int64_t i = 0; i < a->len; i++) {
    double x = slot_to_num(arr_at(a, i));
    acc = is_max ? js_math_max(acc, x) : js_math_min(acc, x);
  }
  return acc;
}
double nt_arr_indexof_str(NtArray *a, const char *x, double fromd) {
  for (int64_t i = arr_from_start(a->len, fromd); i < a->len; i++)
    if (strcmp((const char *)(intptr_t) arr_at(a, i), x) == 0) return (double)i;
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
  size_t seplen = nt_strlen(sep);
  if (seplen == 0) { /* split into characters — the interned one-byte strings */
    for (size_t i = 0; s[i]; i++) nt_arr_push(a, (int64_t)(intptr_t)nt_ch1((unsigned char)s[i]));
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

/* JSON-quote a string: wrap in quotes, escape " \ and control chars.
 *
 * RFC 8259 §7 forbids a LITERAL character below U+0020 inside a string, so every
 * one of them has to be escaped — the five with a short form as that form, the
 * rest as `\u00XX`. This used to escape only `" \ \n \t \r` and pass the other 27
 * through raw, which emitted output that was not JSON and did not survive its own
 * `JSON.parse`. node's QuoteJSONString (ECMA-262 25.5.2.3) is the oracle: it takes
 * the short form for \b \t \n \f \r, and `\u00XX` for anything else under 0x20.
 * U+007F is NOT a JSON control character and stays literal, as in node.
 * (`c` is read through `unsigned char` so a high byte of a UTF-8 sequence is not a
 * negative `char` and does not fall into the escape range.) */
const char *js_json_quote(const char *s) {
  static const char *HEX = "0123456789abcdef";
  SB sb; sb_init(&sb);
  sb_append(&sb, "\"", 1);
  for (const char *p = s; *p; p++) {
    unsigned char c = (unsigned char)*p;
    switch (c) {
      case '"':  sb_append(&sb, "\\\"", 2); break;
      case '\\': sb_append(&sb, "\\\\", 2); break;
      case '\b': sb_append(&sb, "\\b", 2); break;
      case '\f': sb_append(&sb, "\\f", 2); break;
      case '\n': sb_append(&sb, "\\n", 2); break;
      case '\r': sb_append(&sb, "\\r", 2); break;
      case '\t': sb_append(&sb, "\\t", 2); break;
      default:
        if (c < 0x20) {
          char esc[6] = { '\\', 'u', '0', '0', HEX[(c >> 4) & 0xf], HEX[c & 0xf] };
          sb_append(&sb, esc, 6);
        } else {
          sb_append(&sb, (const char *)&c, 1);
        }
    }
  }
  sb_append(&sb, "\"", 1);
  const char *r = sb_finish(&sb); nt_str_register((void *)r); return r;
}

/* number -> JSON, allocated. NOT `js_num_to_str`: JSON has no non-finite number
 * (RFC 8259 §6), and node's SerializeJSONNumber (ECMA-262 25.5.2.2) writes `null`
 * for one. Sharing `String(x)` here emitted a bare `NaN`/`Infinity` token. */
const char *nt_json_num(double v) {
  if (!isfinite(v)) return "null";
  return js_num_to_str(v);
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
/* THE OBJECT PAYLOAD, OWNED BY THE SLOT. A user `throw` of a record crossing a frame puts
 * the object BLOCK POINTER here and transfers its single owner to the slot (see
 * `nt_exc_raise_obj`); a `catch` takes it back out with `nt_exc_take_object`, which NULLs
 * this, so exactly one of the slot and the binding ever owns it. NULL for every raise the
 * runtime itself makes: `JSON.parse`, `fs` and `fetch` have a message and no typed object
 * to build, which is why the `const char *` fast path below stays exactly as it was. */
static void *g_exc_obj = NULL;

/* Clear WITHOUT freeing the object — the shared tail of `nt_exc_clear` and of a
 * raise-while-pending. Returns what the object slot held, so each caller decides its fate. */
static void *nt_exc_reset(void) {
  void *o = g_exc_obj;
  const char *m = g_exc_msg;
  g_exc_set = 0;
  g_exc_msg = NULL;
  g_exc_obj = NULL;
  nt_str_release((void *)m);
  return o;
}
/* A RAISE WHILE ONE IS PENDING DROPS THE OLD ONE. Reachable today: a `catch { }` with no
 * binding clears, but a raise from inside a `finally`, or one arriving before an earlier
 * pending flag was consumed, finds the slot already set. That silently leaked one retained
 * message per occurrence; with an object payload it would leak the object as well. */
static void nt_exc_raise(const char *msg) {
  if (g_exc_set) nt_obj_free(nt_exc_reset());
  g_exc_set = 1;
  g_exc_msg = (const char *)nt_str_retain((void *)msg);
}
int32_t nt_exc_pending(void) { return g_exc_set; }
const char *nt_exc_message(void) { return g_exc_msg ? g_exc_msg : ""; }
/* THE PENDING MESSAGE IS AN OWNER. A raise from a user `throw` that crosses a frame
 * (`genPropagate`) runs that frame's drop set on its way out, and the message may be a
 * heap string that very frame owns — so the raise RETAINS it and the clear releases it.
 * The catch binding takes its own reference (`emitExcCheck`), which is what makes the
 * handler's own scope-exit release balance. A literal, and every static message the
 * runtime itself raises, is untracked: `nt_str_retain`/`nt_str_release` are no-ops for
 * any pointer not in the refcount table, so no existing path changes at all.
 *
 * THE OBJECT IS FREED HERE ONLY IF NOBODY TOOK IT. `emitExcCheck` emits
 * `nt_exc_take_object` before this call whenever the handler has a binding, so this frees
 * exactly the `catch { }`-with-no-binding case — the one place an owner would otherwise be
 * dropped on the floor. `nt_obj_free(NULL)` is a no-op, so every string-payload path
 * reaches a function that behaves as it always did. It is SHALLOW (a pre-existing,
 * universal property of the object model): heap strings in the object's slots are not
 * released by it, exactly as for an object freed at scope exit. */
void nt_exc_clear(void) { nt_obj_free(nt_exc_reset()); }
/* Public entry point so the CONDITIONALLY-LINKED runtime pieces (nt_http.c's `fetch`)
 * can raise a catchable throw too — a network/DNS failure must reject like node's
 * fetch does, not abort. The flag/message live here, so they need a real symbol. */
void nt_exc_raise_msg(const char *msg) { nt_exc_raise(msg); }
/* THE MOVE. `obj` is the object block and this call TAKES it: the raising frame has
 * already subtracted it from its own drop set (ownership.ts, `ThrowStmt`), so the slot is
 * now its only owner. `msg` is a BORROWED view of the object's `message` field, or NULL,
 * kept only so an UNCAUGHT raise can name itself on stderr; it is retained and released on
 * the message path exactly like any other message, independently of the object, so reading
 * it never walks the object and the two lifetimes never interact. */
void nt_exc_raise_obj(void *obj, const char *msg) {
  nt_exc_raise(msg);
  g_exc_obj = obj;
}
/* Hand the object to the catch binding AND NULL THE SLOT — the transfer that makes the
 * binding the single owner and stops the `nt_exc_clear` that follows from freeing
 * underneath it. NULL when the pending raise carries no object (every runtime-raised
 * message), which is not a case codegen ever asks about: it emits this only at a call site
 * whose callee was PROVED to raise the handler's own object type (`scanEscaping` rule 3). */
void *nt_exc_take_object(void) {
  void *o = g_exc_obj;
  g_exc_obj = NULL;
  return o;
}
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

/* JS ToBoolean over a Dyn's tag — `if (JSON.parse(s))`. Unlike nt_dyn_as_bool this
 * COERCES rather than requiring a boolean: every JSON value has a truthiness in node,
 * and only these are falsy — null, false, 0 (and -0), NaN, and "". An array or object
 * is always truthy, INCLUDING an empty one. */
int32_t nt_dyn_truthy(NtDyn *d) {
  if (!d) return 0;
  switch (d->tag) {
    case DYN_NULL: return 0;
    case DYN_BOOL: return d->boolean != 0;
    case DYN_NUM:  return d->num != 0.0 && d->num == d->num; /* 0/-0 and NaN are falsy */
    case DYN_STR:  return d->str && d->str[0] != '\0';
    default:       return 1; /* DYN_ARR / DYN_OBJ — an object is always truthy */
  }
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

/* process.platform -> node's spelling for the platform this binary RUNS on.
 *
 * RESOLVED HERE, BY THE C PREPROCESSOR, AND THAT IS THE WHOLE POINT. For an AOT
 * binary "the platform I am running on" IS the platform I was built for, and the
 * emitted .ll deliberately carries no target triple so clang can retarget it
 * (see the driver's `targetFlags`, which puts `-target` on the ONE clang command
 * that compiles both the .ll and this file). Folding a constant in at codegen
 * time would therefore bake the COMPILING host's platform into a
 * cross-compiled binary — `nativets build --target linux` on a Mac would emit a
 * Linux ELF that reports "darwin". Asking the preprocessor makes the answer
 * follow `-target` for free, and keeps the IR triple-free.
 *
 * Returned as an untracked literal (never freed), like nt_getenv's result.
 *
 * ORDER MATTERS: Android defines __linux__ too, so it must be tested first, and
 * node does report "android" there rather than "linux". */
const char *nt_platform(void) {
#if defined(__ANDROID__)
  return "android";
#elif defined(__APPLE__)
  return "darwin";        /* macOS and iOS alike — node's spelling for both */
#elif defined(_WIN32)
  return "win32";         /* node says win32 on 64-bit Windows too */
#elif defined(__linux__)
  return "linux";
#elif defined(__wasi__) || defined(__wasm__)
  /* No node build targets wasi, so there is no oracle to match here. "wasi" is
   * a deliberate divergence rather than a guess at one of node's spellings —
   * see docs/divergences.md. */
  return "wasi";
#elif defined(__FreeBSD__)
  return "freebsd";
#elif defined(__OpenBSD__)
  return "openbsd";
#elif defined(_AIX)
  return "aix";
#elif defined(__sun)
  return "sunos";
#else
  /* Deliberately not "unknown"-with-a-guess: an unrecognized platform is a
   * porting task, and a wrong string here is a silent wrong answer. */
  return "unknown";
#endif
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
  if (g_stdin_pos >= g_stdin_len) return nt_empty_str();
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
    if (n <= 0) return nt_empty_str();
    return nt_ch1(c);
  }
#endif
  /* Piped (not a tty) or Windows: one byte from the shared slurp buffer + cursor. */
  stdin_load();
  if (g_stdin_pos >= g_stdin_len) return nt_empty_str();
  { const char *r = nt_ch1((unsigned char)g_stdin[g_stdin_pos]); g_stdin_pos++; return r; }
}

/* ============================================================
 * Host FFI (SH4) — the filesystem, backed by stdio only (fopen/fread/fwrite/
 * fclose), so this block cross-links unchanged for macOS/iOS/Android exactly
 * like the argv/env/stdin block above.
 *
 * Errors are node's, byte-for-byte: node's `err.message` for a failed fs call is
 * `<CODE>: <description>, <syscall> '<path>'` (the "Error: " prefix belongs to
 * toString, not to the message). We raise that string through the pending-
 * exception protocol, so `try { readFileSync(p, "utf8") } catch (e) { e.message }`
 * prints the same text under node and under the compiled binary.
 * ============================================================ */

/* The node/libuv description for the errno values an fs call actually produces.
 * An errno we do not name falls back to strerror(3) — never a wrong code. */
static const char *host_errno_code(int e) {
  switch (e) {
    case ENOENT:  return "ENOENT";
    case EACCES:  return "EACCES";
    case EISDIR:  return "EISDIR";
    case ENOTDIR: return "ENOTDIR";
    case EEXIST:  return "EEXIST";
    case EPERM:   return "EPERM";
    case ENOTEMPTY: return "ENOTEMPTY";
    default:      return "";
  }
}
static const char *host_errno_desc(int e) {
  switch (e) {
    case ENOENT:  return "no such file or directory";
    case EACCES:  return "permission denied";
    case EISDIR:  return "illegal operation on a directory";
    case ENOTDIR: return "not a directory";
    case EEXIST:  return "file already exists";
    case EPERM:   return "operation not permitted";
    case ENOTEMPTY: return "directory not empty";
    default:      return strerror(e);
  }
}

/* Build node's fs error message: "ENOENT: no such file or directory, open '/x'".
 * The buffer is untracked (like a string literal), so the message a catch block
 * holds is never freed and never double-freed. */
static const char *host_fs_error(int e, const char *syscall, const char *path) {
  const char *code = host_errno_code(e);
  const char *desc = host_errno_desc(e);
  size_t n = strlen(code) + strlen(desc) + strlen(syscall) + strlen(path) + 16;
  char *m = (char *)nativets_alloc(n);
  if (code[0]) snprintf(m, n, "%s: %s, %s '%s'", code, desc, syscall, path);
  else         snprintf(m, n, "%s, %s '%s'", desc, syscall, path);
  return m;
}

/* readFileSync(path, "utf8") -> the whole file as a string. Throws (catchably) on
 * a missing/unreadable path, like node. Read with fread in a growing buffer rather
 * than fseek+ftell so it also works for a non-seekable path. */
const char *nt_read_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) { nt_exc_raise_msg(host_fs_error(errno, "open", path)); return ""; }
  size_t cap = 4096, len = 0;
  char *buf = (char *)nativets_alloc(cap);
  for (;;) {
    if (len == cap) { size_t nc = cap * 2; char *nb = (char *)nativets_alloc(nc); memcpy(nb, buf, len); buf = nb; cap = nc; }
    size_t n = fread(buf + len, 1, cap - len, f);
    len += n;
    if (n == 0) break;
  }
  int bad = ferror(f) ? errno : 0;
  fclose(f);
  /* node reports reading a DIRECTORY as EISDIR with the `read` syscall — fopen on a
   * directory succeeds on macOS/Linux, so the failure surfaces here, not at open. */
  if (bad) { nt_exc_raise_msg(host_fs_error(bad, "read", path)); return ""; }
  char *o = alloc_str(len);
  memcpy(o, buf, len); o[len] = '\0';
  return o;
}

/* writeFileSync(path, contents) -> the bytes are written, truncating an existing
 * file (node's default flag "w"). Throws (catchably) with node's message when the
 * path cannot be opened or the write fails. */
void nt_write_file(const char *path, const char *data) {
  FILE *f = fopen(path, "wb");
  if (!f) { nt_exc_raise_msg(host_fs_error(errno, "open", path)); return; }
  size_t n = strlen(data);
  size_t w = n ? fwrite(data, 1, n, f) : 0;
  int bad = (w != n || ferror(f)) ? (errno ? errno : EIO) : 0;
  if (fclose(f) != 0 && !bad) bad = errno ? errno : EIO;
  if (bad) nt_exc_raise_msg(host_fs_error(bad, "write", path));
}

/* existsSync(path) -> 1 when the path exists (a file, a directory, anything
 * stat can see), else 0. node NEVER throws here — every stat failure is `false` —
 * so this raises nothing and codegen emits no exception check. */
int32_t nt_path_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 ? 1 : 0;
}

/* mkdtempSync(prefix) -> a fresh directory named `<prefix>XXXXXX` (six random
 * characters, node's shape), created with mode 0700. Throws like node on failure. */
const char *nt_mkdtemp(const char *prefix) {
  size_t n = strlen(prefix);
  char *tmpl = (char *)nativets_alloc(n + 7);
  memcpy(tmpl, prefix, n);
  memcpy(tmpl + n, "XXXXXX", 7);
  if (!mkdtemp(tmpl)) { nt_exc_raise_msg(host_fs_error(errno, "mkdtemp", prefix)); return ""; }
  size_t ln = strlen(tmpl);
  char *o = alloc_str(ln);
  memcpy(o, tmpl, ln); o[ln] = '\0';
  return o;
}

/* readdirSync(path) -> the entry names, WITHOUT "." and "..", in directory order
 * (node does not sort either). Throws like node when the path is not a directory. */
NtArray *nt_readdir(const char *path) {
  DIR *d = opendir(path);
  if (!d) { nt_exc_raise_msg(host_fs_error(errno, "scandir", path)); return nt_arr_new(0); }
  NtArray *a = nt_arr_new(8);
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    size_t ln = strlen(e->d_name);
    char *o = alloc_str(ln);
    memcpy(o, e->d_name, ln); o[ln] = '\0';
    nt_arr_push(a, (int64_t)(intptr_t)o);
  }
  closedir(d);
  return a;
}

/* Depth-first removal of `path` (a file, or a whole tree). Returns 0 or errno. */
static int rm_tree(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0) return errno;
  if (!S_ISDIR(st.st_mode)) return unlink(path) == 0 ? 0 : errno;
  DIR *d = opendir(path);
  if (!d) return errno;
  struct dirent *e;
  int err = 0;
  size_t pl = strlen(path);
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    size_t nl = strlen(e->d_name);
    char *child = (char *)nativets_alloc(pl + nl + 2);
    memcpy(child, path, pl); child[pl] = '/';
    memcpy(child + pl + 1, e->d_name, nl); child[pl + 1 + nl] = '\0';
    int r = rm_tree(child);
    if (r && !err) err = r;
  }
  closedir(d);
  if (err) return err;
  return rmdir(path) == 0 ? 0 : errno;
}

/* rmSync(path[, { recursive: true, force: true }]). `recursive` removes a tree,
 * `force` swallows a missing path (both exactly node's meaning). Anything else
 * throws with node's message. */
void nt_rm(const char *path, int32_t recursive, int32_t force) {
  struct stat st;
  if (lstat(path, &st) != 0) {
    if (force && errno == ENOENT) return;   /* node: force ignores a missing path */
    nt_exc_raise_msg(host_fs_error(errno, "lstat", path));
    return;
  }
  int err;
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) { nt_exc_raise_msg(host_fs_error(EISDIR, "rm", path)); return; }
    err = rm_tree(path);
  } else {
    err = unlink(path) == 0 ? 0 : errno;
  }
  if (err && !(force && err == ENOENT)) nt_exc_raise_msg(host_fs_error(err, "unlink", path));
}

/* ============================================================
 * Host FFI (SH4) — node:path (POSIX).
 *
 * A faithful port of node's own `lib/path.js` posix implementation, function for
 * function (`normalizeString`, `join`, `dirname`, `basename`, `resolve`,
 * `relative`), because the edge cases are the whole point: `..` above the root,
 * empty and trailing segments, and a common prefix that is not a whole segment.
 * Pure string work plus getcwd(3) for `resolve` — no allocation beyond the result,
 * and nothing platform-specific, so it cross-links with the rest.
 *
 * Windows paths are deliberately NOT modelled: `path` here is `path.posix`.
 * ============================================================ */

/* node's normalizeString(path, allowAboveRoot, '/', isPosixPathSeparator).
 * Writes into `res` (caller-allocated, >= strlen(path)+1) and returns its length. */
static size_t path_normalize_string(const char *path, int allowAboveRoot, char *res) {
  size_t n = strlen(path), rl = 0;
  size_t lastSegmentLength = 0;
  long lastSlash = -1;
  int dots = 0;
  char code = 0;
  res[0] = '\0';
  for (size_t i = 0; i <= n; ++i) {
    if (i < n) code = path[i];
    else if (code == '/') break;
    else code = '/';

    if (code == '/') {
      if (lastSlash == (long)i - 1 || dots == 1) {
        /* NOOP: an empty segment or "." */
      } else if (dots == 2) {
        int trailing_dotdot = rl >= 2 && lastSegmentLength == 2 && res[rl - 1] == '.' && res[rl - 2] == '.';
        if (!trailing_dotdot) {
          if (rl > 2) {
            /* drop the last segment */
            long lastSlashIndex = -1;
            for (long k = (long)rl - 1; k >= 0; k--) if (res[k] == '/') { lastSlashIndex = k; break; }
            if (lastSlashIndex == -1) { rl = 0; res[0] = '\0'; lastSegmentLength = 0; }
            else {
              rl = (size_t)lastSlashIndex; res[rl] = '\0';
              long prev = -1;
              for (long k = (long)rl - 1; k >= 0; k--) if (res[k] == '/') { prev = k; break; }
              lastSegmentLength = (size_t)((long)rl - 1 - prev);
            }
            lastSlash = (long)i; dots = 0; continue;
          } else if (rl != 0) {
            rl = 0; res[0] = '\0'; lastSegmentLength = 0;
            lastSlash = (long)i; dots = 0; continue;
          }
        }
        if (allowAboveRoot) {
          if (rl > 0) { res[rl++] = '/'; }
          res[rl++] = '.'; res[rl++] = '.'; res[rl] = '\0';
          lastSegmentLength = 2;
        }
      } else {
        size_t seglen = i - (size_t)(lastSlash + 1);
        if (rl > 0) res[rl++] = '/';
        memcpy(res + rl, path + lastSlash + 1, seglen);
        rl += seglen; res[rl] = '\0';
        lastSegmentLength = seglen;
      }
      lastSlash = (long)i;
      dots = 0;
    } else if (code == '.' && dots != -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return rl;
}

/* node's path.posix.normalize, into a fresh rc-tracked string. */
static const char *path_normalize(const char *path) {
  size_t n = strlen(path);
  if (n == 0) { char *o = alloc_str(1); o[0] = '.'; o[1] = '\0'; return o; }
  int isAbsolute = path[0] == '/';
  int trailing = path[n - 1] == '/';
  char *buf = (char *)nativets_alloc(n + 4);
  size_t rl = path_normalize_string(path, !isAbsolute, buf);
  if (rl == 0) {
    if (isAbsolute) { char *o = alloc_str(1); o[0] = '/'; o[1] = '\0'; return o; }
    if (trailing) { char *o = alloc_str(2); o[0] = '.'; o[1] = '/'; o[2] = '\0'; return o; }
    char *o = alloc_str(1); o[0] = '.'; o[1] = '\0'; return o;
  }
  size_t extra = (isAbsolute ? 1 : 0) + (trailing ? 1 : 0);
  char *o = alloc_str(rl + extra);
  size_t w = 0;
  if (isAbsolute) o[w++] = '/';
  memcpy(o + w, buf, rl); w += rl;
  if (trailing) o[w++] = '/';
  o[w] = '\0';
  return o;
}

/* path.join(a, b). Variadic join is a LEFT FOLD of this in codegen: normalize is
 * idempotent and `..` resolves left to right, so folding gives node's answer for
 * the whole list (pinned by the differential corpus in test/hostfs.test.ts). */
const char *nt_path_join(const char *a, const char *b) {
  size_t la = strlen(a), lb = strlen(b);
  if (la == 0 && lb == 0) { char *o = alloc_str(1); o[0] = '.'; o[1] = '\0'; return o; }
  if (la == 0) return path_normalize(b);
  if (lb == 0) return path_normalize(a);
  char *j = (char *)nativets_alloc(la + lb + 2);
  memcpy(j, a, la); j[la] = '/'; memcpy(j + la + 1, b, lb); j[la + 1 + lb] = '\0';
  return path_normalize(j);
}

const char *nt_path_dirname(const char *path) {
  size_t n = strlen(path);
  if (n == 0) { char *o = alloc_str(1); o[0] = '.'; o[1] = '\0'; return o; }
  int hasRoot = path[0] == '/';
  long end = -1;
  int matchedSlash = 1;
  for (long i = (long)n - 1; i >= 1; --i) {
    if (path[i] == '/') { if (!matchedSlash) { end = i; break; } }
    else matchedSlash = 0;
  }
  if (end == -1) {
    char *o = alloc_str(1);
    o[0] = hasRoot ? '/' : '.'; o[1] = '\0'; return o;
  }
  if (hasRoot && end == 1) { char *o = alloc_str(2); o[0] = '/'; o[1] = '/'; o[2] = '\0'; return o; }
  char *o = alloc_str((size_t)end);
  memcpy(o, path, (size_t)end); o[end] = '\0';
  return o;
}

/* path.basename(path) — the one-argument form (the `ext` argument is refused by
 * the checker rather than silently ignored). */
const char *nt_path_basename(const char *path) {
  size_t n = strlen(path);
  long start = 0, end = -1;
  int matchedSlash = 1;
  for (long i = (long)n - 1; i >= 0; --i) {
    if (path[i] == '/') { if (!matchedSlash) { start = i + 1; break; } }
    else if (end == -1) { matchedSlash = 0; end = i + 1; }
  }
  if (end == -1) return nt_empty_str();
  size_t len = (size_t)(end - start);
  char *o = alloc_str(len);
  memcpy(o, path + start, len); o[len] = '\0';
  return o;
}

/* path.resolve(a) / path.resolve(a, b) — b may be NULL. Absolute by construction:
 * scans right to left and prepends the working directory when nothing is absolute. */
const char *nt_path_resolve(const char *a, const char *b) {
  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) { cwd[0] = '/'; cwd[1] = '\0'; }
  const char *parts[3];
  int np = 0;
  parts[np++] = a;
  if (b) parts[np++] = b;

  size_t cap = strlen(cwd) + 2;
  for (int i = 0; i < np; i++) cap += strlen(parts[i]) + 1;
  char *acc = (char *)nativets_alloc(cap + 1);
  acc[0] = '\0';
  size_t al = 0;
  int absolute = 0;
  for (int i = np - 1; i >= -1 && !absolute; i--) {
    const char *p = i >= 0 ? parts[i] : cwd;
    size_t lp = strlen(p);
    if (lp == 0) continue;
    /* acc = p + "/" + acc */
    memmove(acc + lp + 1, acc, al + 1);
    memcpy(acc, p, lp);
    acc[lp] = '/';
    al += lp + 1;
    absolute = p[0] == '/';
  }
  char *buf = (char *)nativets_alloc(al + 4);
  size_t rl = path_normalize_string(acc, !absolute, buf);
  if (absolute) {
    char *o = alloc_str(rl + 1);
    o[0] = '/'; memcpy(o + 1, buf, rl); o[rl + 1] = '\0';
    return o;
  }
  if (rl == 0) { char *o = alloc_str(1); o[0] = '.'; o[1] = '\0'; return o; }
  char *o = alloc_str(rl);
  memcpy(o, buf, rl); o[rl] = '\0';
  return o;
}

/* path.relative(from, to) — both resolved to absolute first, then the longest
 * common SEGMENT prefix decides how many `..` steps precede the remainder. */
const char *nt_path_relative(const char *from_in, const char *to_in) {
  if (strcmp(from_in, to_in) == 0) return nt_empty_str();
  const char *from = nt_path_resolve(from_in, NULL);
  const char *to = nt_path_resolve(to_in, NULL);
  if (strcmp(from, to) == 0) return nt_empty_str();

  size_t fromStart = 1, fromEnd = strlen(from);
  size_t fromLen = fromEnd - fromStart;
  size_t toStart = 1, toLen = strlen(to) - toStart;
  size_t length = fromLen < toLen ? fromLen : toLen;
  long lastCommonSep = -1;
  size_t i = 0;
  for (; i < length; i++) {
    char fc = from[fromStart + i];
    if (fc != to[toStart + i]) break;
    else if (fc == '/') lastCommonSep = (long)i;
  }
  if (i == length) {
    if (toLen > length) {
      if (to[toStart + i] == '/') {
        const char *tail = to + toStart + i + 1;
        size_t tl = strlen(tail);
        char *o = alloc_str(tl); memcpy(o, tail, tl); o[tl] = '\0'; return o;
      }
      if (i == 0) {
        const char *tail = to + toStart + i;
        size_t tl = strlen(tail);
        char *o = alloc_str(tl); memcpy(o, tail, tl); o[tl] = '\0'; return o;
      }
    } else if (fromLen > length) {
      if (from[fromStart + i] == '/') lastCommonSep = (long)i;
      else if (i == 0) lastCommonSep = 0;
    }
  }
  /* One ".." per remaining segment of `from`, then the rest of `to`. */
  size_t ups = 0;
  for (size_t k = fromStart + (size_t)(lastCommonSep + 1); k <= fromEnd; ++k)
    if (k == fromEnd || from[k] == '/') ups++;
  const char *tail = to + toStart + (size_t)lastCommonSep;
  size_t tl = strlen(tail);
  size_t need = ups * 3 + tl + 1;
  char *o = alloc_str(need);
  size_t w = 0;
  for (size_t u = 0; u < ups; u++) {
    if (w > 0) o[w++] = '/';
    o[w++] = '.'; o[w++] = '.';
  }
  memcpy(o + w, tail, tl); w += tl;
  o[w] = '\0';
  return o;
}

/* ============================================================
 * Host FFI (SH4) — node:os and node:url.
 * ============================================================ */

/* os.tmpdir() — node's rule: $TMPDIR / $TMP / $TEMP, else "/tmp", with a trailing
 * slash stripped (unless the path IS "/"). */
const char *nt_os_tmpdir(void) {
  const char *t = getenv("TMPDIR");
  if (!t || !*t) t = getenv("TMP");
  if (!t || !*t) t = getenv("TEMP");
  if (!t || !*t) t = "/tmp";
  size_t n = strlen(t);
  if (n > 1 && t[n - 1] == '/') n--;
  char *o = alloc_str(n);
  memcpy(o, t, n); o[n] = '\0';
  return o;
}

/* os.homedir() — $HOME, falling back to the passwd entry (node does the same). */
const char *nt_os_homedir(void) {
  const char *h = getenv("HOME");
  if (!h) h = "";
  size_t n = strlen(h);
  char *o = alloc_str(n);
  memcpy(o, h, n); o[n] = '\0';
  return o;
}

/* url.fileURLToPath(u) — the POSIX case of node's implementation: require the
 * `file:` protocol (node throws ERR_INVALID_URL_SCHEME otherwise), then
 * percent-DECODE the path. A `%2F` is rejected by node as ERR_INVALID_FILE_URL_PATH;
 * that check is here too, so a decoded separator can never appear silently. */
static int host_hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
const char *nt_file_url_to_path(const char *u) {
  if (strncmp(u, "file://", 7) != 0) {
    nt_exc_raise_msg("TypeError [ERR_INVALID_URL_SCHEME]: The URL must be of scheme file");
    return "";
  }
  const char *p = u + 7;
  /* Skip a host: node only accepts an empty host or "localhost" on POSIX. */
  if (strncmp(p, "localhost/", 10) == 0) p += 9;
  else if (*p != '/') {
    nt_exc_raise_msg("TypeError [ERR_INVALID_FILE_URL_HOST]: File URL host must be \"localhost\" or empty");
    return "";
  }
  size_t n = strlen(p);
  char *o = alloc_str(n);
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == '%' && i + 2 < n) {
      int hi = host_hexval(p[i + 1]), lo = host_hexval(p[i + 2]);
      if (hi >= 0 && lo >= 0) {
        int c = hi * 16 + lo;
        if (c == '/') {
          nt_exc_raise_msg("TypeError [ERR_INVALID_FILE_URL_PATH]: File URL path must not include encoded / characters");
          return "";
        }
        o[w++] = (char)c;
        i += 2;
        continue;
      }
    }
    o[w++] = p[i];
  }
  o[w] = '\0';
  return o;
}

/* ============================================================
 * Host FFI (SH4) — subprocess. This is what lets a self-hosted nativets invoke
 * `clang`: run a program to completion and capture its status + stdout + stderr.
 *
 * fork + execvp + two pipes + waitpid, all POSIX — no posix_spawn (absent below
 * Android API 28) and no libc extensions, so the block cross-links like the rest.
 * Both pipes are drained with poll(2) rather than one-then-the-other: a child that
 * fills the pipe it is NOT being read from would otherwise block forever.
 *
 * No shell is involved: the argument vector is passed through verbatim, so a
 * filename with a space, a `*` or a `$` is a single literal argument (node's
 * `spawnSync(cmd, args)` without `shell: true` behaves the same way).
 *
 * `nt_host_spawn`, NOT `nt_spawn`: `nt_actor.c` already exports `nt_spawn` for the
 * ACTOR spawn, and an actor program links both translation units — the collision is
 * a duplicate-symbol link failure in every actor program, not a compile error here.
 * ============================================================ */

/* Append `n` bytes to a growing buffer (the stdout/stderr collectors). */
typedef struct { char *p; size_t len, cap; } SpawnBuf;
static void spawn_buf_add(SpawnBuf *b, const char *src, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t nc = b->cap ? b->cap : 4096;
    while (b->len + n + 1 > nc) nc *= 2;
    char *np = (char *)nativets_alloc(nc);
    if (b->p) memcpy(np, b->p, b->len);
    b->p = np; b->cap = nc;
  }
  memcpy(b->p + b->len, src, n);
  b->len += n;
  b->p[b->len] = '\0';
}
/* Hand a collector's bytes to TS as an rc-tracked heap string ("" when empty). */
static const char *spawn_buf_str(SpawnBuf *b) {
  char *o = alloc_str(b->len);
  if (b->len) memcpy(o, b->p, b->len);
  o[b->len] = '\0';
  return o;
}

#if !defined(_WIN32) && !defined(__wasi__)
const char *nt_host_spawn(const char *cmd, NtArray *args, double *status_out, const char **stderr_out) {
  SpawnBuf out = { NULL, 0, 0 }, err = { NULL, 0, 0 };
  *status_out = -1.0;                 /* the spawn-failed value; see docs/divergences.md */
  *stderr_out = "";

  int64_t n = (int64_t)nt_arr_len(args);
  char **argv = (char **)nativets_alloc(sizeof(char *) * (size_t)(n + 2));
  argv[0] = (char *)cmd;
  for (int64_t i = 0; i < n; i++) argv[i + 1] = (char *)(intptr_t)nt_arr_get(args, (double)i);
  argv[n + 1] = NULL;

  int po[2], pe[2];
  if (pipe(po) != 0) return spawn_buf_str(&out);
  if (pipe(pe) != 0) { close(po[0]); close(po[1]); return spawn_buf_str(&out); }

  fflush(stdout); fflush(stderr);     /* the child inherits our buffers otherwise */
  pid_t pid = fork();
  if (pid < 0) { close(po[0]); close(po[1]); close(pe[0]); close(pe[1]); return spawn_buf_str(&out); }
  if (pid == 0) {
    /* Child: wire the write ends onto fd 1/2 and exec. A failed execvp exits 127,
     * which is what a shell reports for "command not found"; the parent turns that
     * into the spawn-failure status below (node reports `null` + `.error`). */
    dup2(po[1], STDOUT_FILENO);
    dup2(pe[1], STDERR_FILENO);
    close(po[0]); close(po[1]); close(pe[0]); close(pe[1]);
    execvp(cmd, argv);
    _exit(127);
  }

  close(po[1]); close(pe[1]);
  struct pollfd fds[2];
  fds[0].fd = po[0]; fds[1].fd = pe[0];
  int open_fds = 2;
  while (open_fds > 0) {
    fds[0].events = fds[0].fd >= 0 ? POLLIN : 0;
    fds[1].events = fds[1].fd >= 0 ? POLLIN : 0;
    if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; break; }
    for (int i = 0; i < 2; i++) {
      if (fds[i].fd < 0 || !fds[i].revents) continue;
      char buf[4096];
      ssize_t r = read(fds[i].fd, buf, sizeof buf);
      if (r > 0) { spawn_buf_add(i == 0 ? &out : &err, buf, (size_t)r); continue; }
      if (r < 0 && errno == EINTR) continue;
      close(fds[i].fd); fds[i].fd = -1; open_fds--;
    }
  }
  if (fds[0].fd >= 0) close(fds[0].fd);
  if (fds[1].fd >= 0) close(fds[1].fd);

  int st = 0;
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) { /* retry */ }
  if (WIFEXITED(st)) {
    int code = WEXITSTATUS(st);
    /* execvp never ran the program: report the spawn failure, not a real exit 127. */
    *status_out = (code == 127 && out.len == 0 && err.len == 0) ? -1.0 : (double)code;
  } else {
    /* Killed by a signal. node reports `status: null` + `.signal`; a number type
     * cannot hold null, so this is -1 too (documented divergence). */
    *status_out = -1.0;
  }
  *stderr_out = spawn_buf_str(&err);
  return spawn_buf_str(&out);
}

/* `spawnSync(cmd, args, { stdio: "inherit" })` — the child gets OUR fds, so there are
 * no pipes to create and nothing to drain: fork, exec, wait. This is what
 * `nativets run` needs, where the compiled program must reach the user's terminal
 * (and its stdin) directly rather than through a captured buffer. Only the status
 * comes back; node's result carries `stdout: null` / `stderr: null` for this mode. */
void nt_host_spawn_inherit(const char *cmd, NtArray *args, double *status_out) {
  *status_out = -1.0;                 /* the spawn-failed value; see docs/divergences.md */

  int64_t n = (int64_t)nt_arr_len(args);
  char **argv = (char **)nativets_alloc(sizeof(char *) * (size_t)(n + 2));
  argv[0] = (char *)cmd;
  for (int64_t i = 0; i < n; i++) argv[i + 1] = (char *)(intptr_t)nt_arr_get(args, (double)i);
  argv[n + 1] = NULL;

  /* The captured form separates "execvp never ran" from a real exit 127 by noticing
   * that the child produced no output. An inherited child's output went straight to
   * our fds, so there is nothing to look at — hence the classic close-on-exec pipe:
   * the child writes its errno into it only if `execvp` RETURNS, and a successful exec
   * closes the write end for us. Bytes in the parent therefore mean, exactly, "the
   * program never started" — which is node's `status: null` / our -1. */
  int fail[2];
  int have_fail = pipe(fail) == 0;
  if (have_fail) { fcntl(fail[1], F_SETFD, FD_CLOEXEC); }

  fflush(stdout); fflush(stderr);     /* our buffered output must precede the child's */
  pid_t pid = fork();
  if (pid < 0) { if (have_fail) { close(fail[0]); close(fail[1]); } return; }
  if (pid == 0) {
    if (have_fail) close(fail[0]);
    execvp(cmd, argv);
    if (have_fail) { int e = errno; ssize_t w = write(fail[1], &e, sizeof e); (void)w; }
    _exit(127);
  }

  int started = 1;
  if (have_fail) {
    close(fail[1]);
    int e = 0;
    ssize_t r;
    while ((r = read(fail[0], &e, sizeof e)) < 0 && errno == EINTR) { /* retry */ }
    if (r > 0) started = 0;
    close(fail[0]);
  }

  int st = 0;
  while (waitpid(pid, &st, 0) < 0 && errno == EINTR) { /* retry */ }
  /* Killed by a signal is -1 too — node reports `status: null` + `.signal`, and a
   * `number` cannot hold null (docs/divergences.md, same as the captured form). */
  *status_out = (started && WIFEXITED(st)) ? (double)WEXITSTATUS(st) : -1.0;
}
#else
/* Windows / WASI: no fork/exec. Report the spawn failure rather than pretend. */
const char *nt_host_spawn(const char *cmd, NtArray *args, double *status_out, const char **stderr_out) {
  (void)cmd; (void)args;
  *status_out = -1.0;
  *stderr_out = "spawnSync is not available on this platform";
  return nt_empty_str();
}
void nt_host_spawn_inherit(const char *cmd, NtArray *args, double *status_out) {
  (void)cmd; (void)args;
  *status_out = -1.0;
}
#endif

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

/* ---- base64 (btoa / atob) — the BINARY-STRING contract, not the byte buffer ----
 *
 * These used to be "pure byte ops over the string's bytes", and that is the one
 * reading of them that is never right. `btoa`/`atob` are defined on a BINARY
 * STRING: one CODE POINT per byte. A code point above U+00FF has no byte and is
 * an `InvalidCharacterError`; it is not three UTF-8 bytes to encode. Ours encoded
 * the UTF-8 (`btoa("é")` → `w6k=`, node `6Q==`) and, worse, answered `5L2g` at
 * exit 0 for `btoa("你")`, which node REFUSES — a silent wrong answer on exactly
 * the input whose whole point is which bytes come out.
 *
 * Our strings are UTF-8 (§A.2), so the code-point <-> byte mapping is the decode
 * /encode pair below rather than a `memcpy`: `btoa` DECODES to code points and
 * takes each one's single byte, and `atob` ENCODES each decoded byte back as the
 * code point of that value. Both directions therefore agree with node's stdout
 * BYTES, and `atob(btoa(s)) === s` holds for every `s` that `btoa` accepts.
 *
 * Both raise on the pending-exception slot (`nt_exc_raise_msg`), the same way
 * `JSON.parse` and `decodeURIComponent` do, so codegen's `emitExcCheck` makes the
 * throw catchable in a `try` in the same frame and exit 1 when it is not. */
static const char B64_ENC[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* node names both failures `InvalidCharacterError`; the MESSAGE distinguishes a
 * character outside the alphabet from a length that cannot be a base64 quantum. */
static const char B64_ERR_CHAR[] = "InvalidCharacterError: Invalid character";
static const char B64_ERR_LEN[] =
  "InvalidCharacterError: The string to be decoded is not correctly encoded.";

/* Decode ONE scalar of strict UTF-8 at s[*i..n); advance *i and return the code
 * point, or return -1 for a truncated, overlong or otherwise malformed sequence.
 * A lone surrogate (WTF-8, what the lexer and `String.fromCharCode` emit for
 * `\ud800`) decodes as ITSELF — above U+00FF either way, so `btoa` refuses it
 * exactly as node does. A malformed sequence is U+FFFD in node's string, also
 * above U+00FF, so mapping it to -1 here reaches node's answer for its reason. */
static long utf8_next(const unsigned char *s, size_t n, size_t *i) {
  unsigned char c = s[*i];
  if (c < 0x80) { (*i)++; return (long)c; }
  size_t need;
  long cp, min;
  if ((c & 0xE0) == 0xC0) { need = 1; cp = c & 0x1F; min = 0x80; }
  else if ((c & 0xF0) == 0xE0) { need = 2; cp = c & 0x0F; min = 0x800; }
  else if ((c & 0xF8) == 0xF0) { need = 3; cp = c & 0x07; min = 0x10000; }
  else return -1; /* a continuation byte or 0xF8..0xFF as a lead */
  if (*i + need >= n) return -1; /* truncated */
  for (size_t k = 1; k <= need; k++) {
    unsigned char cc = s[*i + k];
    if ((cc & 0xC0) != 0x80) return -1;
    cp = (cp << 6) | (long)(cc & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF) return -1; /* overlong, or out of range */
  *i += need + 1;
  return cp;
}

const char *nt_btoa(const char *s) {
  size_t n = nt_strlen(s);
  const unsigned char *u = (const unsigned char *)s;
  /* One code point is at least one input byte, so n bytes is always enough. */
  unsigned char *bin = (unsigned char *)nativets_alloc(n + 1);
  size_t m = 0, i = 0;
  while (i < n) {
    long cp = utf8_next(u, n, &i);
    if (cp < 0 || cp > 0xFF) {
      free(bin); /* unregistered scratch — `nt_str_register` never saw it */
      nt_exc_raise_msg(B64_ERR_CHAR);
      return nt_empty_str();
    }
    bin[m++] = (unsigned char)cp;
  }
  size_t outlen = ((m + 2) / 3) * 4;
  char *o = alloc_str(outlen);
  size_t j = 0;
  for (size_t k = 0; k < m; k += 3) {
    unsigned b0 = bin[k];
    unsigned b1 = (k + 1 < m) ? bin[k + 1] : 0;
    unsigned b2 = (k + 2 < m) ? bin[k + 2] : 0;
    o[j++] = B64_ENC[b0 >> 2];
    o[j++] = B64_ENC[((b0 & 3) << 4) | (b1 >> 4)];
    o[j++] = (k + 1 < m) ? B64_ENC[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    o[j++] = (k + 2 < m) ? B64_ENC[b2 & 63] : '=';
  }
  o[outlen] = 0;
  free(bin);
  return o;
}

static int b64_val(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1; /* NOT skipped any more — this is what makes the input invalid */
}

/* The five ASCII whitespace code points the WHATWG infra spec strips, and only
 * those. VT (0x0B) is NOT one of them — node throws on `atob("YQ==")`. */
static int b64_space(unsigned char c) {
  return c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20;
}

/* WHATWG "forgiving-base64 decode". Ours used to skip every non-alphabet byte,
 * so `atob("YQ===")` returned "a" and `atob("!!!!")` returned "" where node
 * throws — untrusted input decoding to a plausible answer at exit 0.
 *
 * The order of the two failures is node's, not the spec's literal step order:
 * the spec returns one undifferentiated failure, and node reports a stray `=`
 * (`"YQ==="`, `"A==="`) as "Invalid character" even though its length ALSO
 * leaves a remainder of 1 — so the alphabet check runs first and only an
 * all-alphabet string of length %4 == 1 (`"Y"`, `"AAAAA"`) gets the length
 * message. Verified against node 24 for both. */
const char *nt_atob(const char *s) {
  size_t n = nt_strlen(s);
  const unsigned char *u = (const unsigned char *)s;
  unsigned char *in = (unsigned char *)nativets_alloc(n + 1);
  size_t m = 0;
  for (size_t i = 0; i < n; i++) if (!b64_space(u[i])) in[m++] = u[i];
  /* Trailing padding is removed only from a well-sized string; that is why
   * `"AA=="` decodes and `"A==="` (which strips to `"A="`) does not. */
  if (m % 4 == 0) for (int p = 0; p < 2 && m > 0 && in[m - 1] == '='; p++) m--;
  for (size_t i = 0; i < m; i++) {
    if (b64_val(in[i]) < 0) {
      free(in);
      nt_exc_raise_msg(B64_ERR_CHAR);
      return nt_empty_str();
    }
  }
  if (m % 4 == 1) {
    free(in);
    nt_exc_raise_msg(B64_ERR_LEN);
    return nt_empty_str();
  }
  /* Each decoded byte is a code point, so it costs up to TWO UTF-8 bytes out —
   * `atob("/w==")` is U+00FF, which node prints as C3 BF and we used to print as
   * the bare FF, i.e. as stdout that is not valid UTF-8 at all. */
  char *o = alloc_str(2 * m + 2);
  size_t j = 0;
  for (size_t i = 0; i + 1 < m; i += 4) {
    unsigned v0 = (unsigned)b64_val(in[i]), v1 = (unsigned)b64_val(in[i + 1]);
    unsigned v2 = (i + 2 < m) ? (unsigned)b64_val(in[i + 2]) : 0;
    unsigned v3 = (i + 3 < m) ? (unsigned)b64_val(in[i + 3]) : 0;
    unsigned bytes[3];
    bytes[0] = ((v0 << 2) | (v1 >> 4)) & 0xFF;
    bytes[1] = (((v1 & 15) << 4) | (v2 >> 2)) & 0xFF;
    bytes[2] = (((v2 & 3) << 6) | v3) & 0xFF;
    /* A remainder of 2 carries one byte and a remainder of 3 carries two; the
     * leftover low bits of the last symbol are DISCARDED, not required to be
     * zero (node decodes "YR==" to "a" exactly as it decodes "YQ=="). */
    size_t take = (i + 3 < m) ? 3 : (i + 2 < m ? 2 : 1);
    for (size_t k = 0; k < take; k++) {
      unsigned b = bytes[k];
      if (b < 0x80) { o[j++] = (char)b; }
      else { o[j++] = (char)(0xC0 | (b >> 6)); o[j++] = (char)(0x80 | (b & 0x3F)); }
    }
  }
  o[j] = 0;
  free(in);
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
 * generic slot-vector directly via nt_arr_new/nt_arr_push.
 *
 * The framing comes from `nt_utf8_len`, not from the lead byte alone. Sizing a piece from
 * the lead byte and only guarding the END of the buffer let a lead byte SWALLOW whatever
 * followed it: for `E2 80 41 78 78` (`" ".slice(0, 2) + "Axx"`, ordinary source under
 * §A.2) this returned THREE elements, the first of them the bogus 3-byte glob `E2 80 41`,
 * so `Array.from(s).indexOf("A")` was -1 with the byte still sitting in the string. An
 * ill-formed byte is now its own one-byte element, which keeps the split LOSSLESS —
 * `Array.from(s).join("") === s` for every byte string, well formed or not. ---- */
void *nt_arr_from_str(const char *s) {
  void *a = nt_arr_new(1);
  size_t i = 0, n = nt_strlen(s);
  const unsigned char *b = (const unsigned char *)s;
  while (i < n) {
    unsigned cp;
    int k = nt_utf8_len(b + i, b + n, &cp);
    size_t len = k ? (size_t)k : 1;
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

static const char *url_empty(void) { return nt_empty_str(); }
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
  long n = (long)nt_strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0 || i >= n) return NAN;
  return (double)(unsigned char)s[i];
}

/* String#codePointAt(i) — decodes the UTF-8 sequence starting at BYTE i, so an
 * ASCII string matches node's UTF-16 code point exactly. NaN is the
 * out-of-range sentinel, which codegen turns into node's `undefined`
 * (a code point is never NaN, so the sentinel is unambiguous).
 *
 * This once carried its OWN copy of the decoder, lead-byte-sized and unvalidated, and
 * `nt_utf8_cp` was written from its shape — so one defect, copied, was two. Both now go
 * through `nt_utf8_len`: an ill-formed sequence reports the RAW BYTE at `i`, which is the
 * only answer that agrees with `.charCodeAt(i)` and `.at(i)` about the same position. */
double js_str_code_point_at(const char *s, double id) {
  long n = (long)nt_strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0 || i >= n) return NAN;
  const unsigned char *p = (const unsigned char *)s + i;
  unsigned cp;
  if (nt_utf8_len(p, (const unsigned char *)s + n, &cp) == 0) return (double)p[0];
  return (double)cp;
}

/* String#at(i) — one BYTE as a string, negative indices count from the end;
 * NULL is the out-of-range sentinel that codegen turns into `undefined`. */
const char *js_str_at(const char *s, double id) {
  long n = (long)nt_strlen(s);
  if (isnan(id)) id = 0;
  long i = (long)id;
  if (i < 0) i += n;
  if (i < 0 || i >= n) return NULL;
  return nt_ch1((unsigned char)s[i]);
}

/* String#padEnd(target, pad) — pad on the right, truncating the final pad
 * repetition, and a no-op when the string is already long enough or the pad is
 * empty (node's semantics exactly). */
const char *js_str_pad_end(const char *s, double targetd, const char *pad) {
  double t = nt_to_integer_or_infinity(targetd);
  long n = (long)nt_strlen(s); size_t pn = nt_strlen(pad);
  if (t <= (double)n || pn == 0) { char *o = alloc_str((size_t)n); memcpy(o, s, (size_t)n); o[n] = 0; return o; }
  if (t > NT_MAX_STR_LEN) nt_panic_str_len("the padded string", t);
  long target = (long)t; /* <= 2^29 after the cap, so this conversion is defined */
  char *o = alloc_str((size_t)target);
  memcpy(o, s, (size_t)n);
  for (long i = n; i < target; i++) o[i] = pad[(size_t)(i - n) % pn];
  o[target] = 0; return o;
}

/* String#startsWith(search, pos) / String#endsWith(search, endPos). `pos` is
 * NaN when omitted: startsWith defaults to 0, endsWith to the length. */
int32_t js_str_starts_with(const char *s, const char *sub, double posd) {
  long n = (long)nt_strlen(s), m = (long)nt_strlen(sub);
  long pos = isnan(posd) ? 0 : (long)posd;
  /* ES 22.1.3.23 step 5: CLAMP pos into [0, n] — it is not an out-of-range failure.
   * This read `if (pos > n || ...) return 0;`, which answered false for an EMPTY needle
   * past the end where the spec (and `.endsWith` two lines down) answer true. */
  if (pos < 0) pos = 0;
  if (pos > n) pos = n;
  if (pos + m > n) return 0;
  return memcmp(s + pos, sub, (size_t)m) == 0 ? 1 : 0;
}
int32_t js_str_ends_with(const char *s, const char *sub, double endd) {
  long n = (long)nt_strlen(s), m = (long)nt_strlen(sub);
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
  size_t n = nt_strlen(s);
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
  size_t n = nt_strlen(s), m = nt_strlen(pat);
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

/* String#lastIndexOf(search, position) — ES 22.1.3.11. Last match position, -1 when
 * absent; an EMPTY needle matches at `position` itself, so with no position it is the
 * length (node: `"abc".lastIndexOf("")` === 3, `"abc".lastIndexOf("", 1)` === 1).
 *
 * `position` is where a match may START (not end), CLAMPED to [0, len]; omitted or NaN
 * means +Infinity, i.e. search the whole string. That asymmetry with `.indexOf` is the
 * spec's, not ours: `lastIndexOf(x)` scans everything, `lastIndexOf(x, 0)` scans only
 * position 0. `posd` is NaN when the argument is absent, which is the same value the
 * spec's NaN case produces — so one code path serves both. */
double js_str_last_index_of(const char *s, const char *sub, double posd) {
  size_t n = nt_strlen(s), m = nt_strlen(sub);
  /* start = clamp(pos, 0, n); NaN (absent, or a NaN argument) => +Infinity => n. */
  size_t start = n;
  if (!isnan(posd)) {
    if (posd < 0) start = 0;
    else if (posd < (double)n) start = (size_t)posd;
  }
  if (m > n) return -1.0;
  if (start > n - m) start = n - m;   /* the last index a match of length m can begin at */
  for (size_t i = start + 1; i-- > 0;) if (memcmp(s + i, sub, m) == 0) return (double)i;
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

/* Array#lastIndexOf(x, fromIndex) — last match at or before fromIndex, -1 when absent
 * (number and string flavors, mirroring the nt_arr_indexof_* pair).
 *
 * `arr_at`, NOT `a->data`: past NT_PV_THRESHOLD the receiver may have been frozen into
 * the trie, which FREES the flat block and NULLs `data`. These two read it directly and
 * segfaulted on any frozen array — see test/sharing.test.ts. */
double nt_arr_last_indexof_num(NtArray *a, double x, double fromd) {
  for (int64_t i = arr_from_end(a->len, fromd); i >= 0; i--)
    if (slot_to_num(arr_at(a, i)) == x) return (double)i;
  return -1.0;
}
double nt_arr_last_indexof_str(NtArray *a, const char *x, double fromd) {
  for (int64_t i = arr_from_end(a->len, fromd); i >= 0; i--)
    if (strcmp((const char *)(intptr_t) arr_at(a, i), x) == 0) return (double)i;
  return -1.0;
}

/* Array#concat(other) — a NEW array holding both inputs' slots; both sources
 * are left untouched (node-compatible, and the immutable model's shape). */
void *nt_arr_concat(NtArray *a, NtArray *b) {
  NtArray *o = nt_arr_new((double)(a->len + b->len + 1));
  /* arr_at on BOTH operands: either may be trie-backed, in which case `data` is NULL. */
  for (int64_t i = 0; i < a->len; i++) nt_arr_push(o, arr_at(a, i));
  for (int64_t i = 0; i < b->len; i++) nt_arr_push(o, arr_at(b, i));
  return o;
}

/* Array#flat() — ONE level of flattening into a NEW array. Each element slot of
 * a nested array is an NtArray*; the sub-arrays are left untouched. */
void *nt_arr_flat1(NtArray *a) {
  NtArray *o = nt_arr_new(1);
  for (int64_t i = 0; i < a->len; i++) {
    /* arr_at twice over: the OUTER array and each SUB-array may independently be
     * trie-backed, and a trie-backed one has a NULL `data`. */
    NtArray *sub = (NtArray *)(intptr_t) arr_at(a, i);
    if (!sub) continue;
    for (int64_t j = 0; j < sub->len; j++) nt_arr_push(o, arr_at(sub, j));
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

/* ES TimeClip: NaN or out of range -> NaN, else truncate toward zero.
 *
 * The `+ 0.0` is NOT redundant. TimeClip is ToIntegerOrInfinity(t) clamped
 * (21.4.1.15), and ToIntegerOrInfinity ends with "If integer is -0, return +0"
 * (7.1.5) — so node's time value for anything in (-1, 0] is POSITIVE zero.
 * Truncation alone keeps the sign (`-0.5` truncates to `-0.0`, and `-0.0 < 0`
 * is false so `-0` itself falls into the `floor(t)` arm unchanged), which stored
 * a NEGATIVE zero. That is a real value difference — `1 / new Date(-0).getTime()`
 * was `-Infinity` where node says `Infinity` — and both `String()` and
 * `toISOString()` erase the sign, so it survived every string-shaped test.
 * IEEE-754 round-to-nearest makes `-0.0 + 0.0` exactly `+0.0` and leaves every
 * other double (NaN included) untouched, so this is the whole normalisation. */
static double nt_time_clip(double t) {
  if (!(t >= -NT_DATE_MAX && t <= NT_DATE_MAX)) return NAN; /* also catches NaN */
  return (t < 0 ? -floor(-t) : floor(t)) + 0.0;
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

/* The same, with node's ARRAY brace — `Uint8Array(3) [`. A typed array is laid out
 * exactly like an array (node's `formatTypedArray` folds the length into braces[0],
 * as it does for a Map/Set), so only the opening brace differs. */
const char *nt_insp_len_open(const char *name, double size) {
  SB b; sb_init(&b);
  sb_append(&b, name, strlen(name));
  sb_append(&b, "(", 1);
  char num[64]; js_number_to_string(size, num, sizeof(num));
  sb_append(&b, num, strlen(num));
  sb_append(&b, ") [", 3);
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

/* A Dyn's string, or NULL if it holds anything else — node scans format specifiers
 * only when `typeof args[0] === 'string'`, which for a Dyn is a runtime fact. */
const char *nt_dyn_str_or_null(NtDyn *d) {
  return d && d->tag == DYN_STR ? d->str : NULL;
}

/* What `nt_dyn_print` writes, as a STRING (Stage 49) — a scalar bare, a compound
 * inspected. `depth` is where the walk starts, so `%s` (node inspects it at
 * `depth: 0`) passes 2 and a nested compound is cut to `[Object]` right away. */
const char *nt_dyn_display(NtDyn *d, double depth) {
  if (!d) return "undefined";
  switch (d->tag) {
    case DYN_NUM:  return nt_insp_num(d->num);
    case DYN_BOOL: return d->boolean ? "true" : "false";
    case DYN_STR:  return d->str;
    case DYN_NULL: return "null";
    default:       return nt_dyn_inspect_at(d, (int64_t)depth, 0);
  }
}

