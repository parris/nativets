/*
 * arrset_test.c — the in-place element store behind `xs[i] = v` on a `@@mutable` binding.
 *
 * Build + run (from repo root):
 *   clang -O0 -g test/runtime/arrset_test.c runtime/nt_pvec.c -o /tmp/arrset_test && /tmp/arrset_test
 *
 * `nt_arr_with` is the PERSISTENT writer (it returns a new array and leaves its receiver
 * alone), which is why a discarded `xs[i] = v` is refused. `nt_arr_set_inplace` is its
 * in-place twin, and it is safe by the argument `nt_arr_reverse` already ships on: thaw a
 * shared persistent trie into a PRIVATE flat block first, so the write never goes through
 * a node another owner can see.
 *
 * Both sides of the trie threshold are exercised, because they are different code paths:
 * below it the array is a flat block and the thaw is a no-op; above it the array has been
 * frozen into a trie and the thaw is the whole point.
 */
#include "../../runtime/runtime.c"

#include <stdio.h>

static int g_checks = 0;
static int g_fails  = 0;
#define CHECK(cond) do { \
    g_checks++; \
    if (!(cond)) { g_fails++; \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

static NtArray *mk(int64_t n) {
  NtArray *a = (NtArray *)nt_arr_new((double)n);
  for (int64_t i = 0; i < n; i++) nt_arr_push(a, i);
  return a;
}

int main(void) {
  /* 1. SMALL (flat): the store lands, and `.with` still leaves its receiver alone. */
  NtArray *a = mk(4);
  NtArray *w = (NtArray *)nt_arr_with(a, 1, 99, NULL);
  CHECK(nt_arr_get(a, 1) == 1);    /* persistent: receiver untouched */
  CHECK(nt_arr_get(w, 1) == 99);
  nt_arr_set_inplace(a, 1, 42, NULL);
  CHECK(nt_arr_get(a, 1) == 42);   /* in place: receiver updated */
  CHECK(nt_arr_get(a, 0) == 0);
  CHECK(nt_arr_get(a, 3) == 3);
  CHECK((int64_t)nt_arr_len(a) == 4);
  CHECK(nt_arr_get(w, 1) == 99);   /* the earlier version is unaffected */

  /* 2. LARGE (past the trie threshold): the write must NOT go through a shared node. */
  NtArray *big = mk(100);
  NtArray *shared = (NtArray *)nt_arr_with(big, 50, 777, NULL); /* freezes `big`, shares nodes */
  CHECK(nt_arr_get(shared, 50) == 777);
  CHECK(nt_arr_get(big, 50) == 50);
  nt_arr_set_inplace(big, 50, 555, NULL);
  CHECK(nt_arr_get(big, 50) == 555);
  CHECK(nt_arr_get(shared, 50) == 777);  /* THE SHARING TEST: still 777, not 555 */
  CHECK(nt_arr_get(big, 0) == 0);
  CHECK(nt_arr_get(big, 99) == 99);
  CHECK((int64_t)nt_arr_len(big) == 100);

  /* 3. Every element of a large array is individually settable after the thaw. */
  for (int64_t i = 0; i < 100; i++) nt_arr_set_inplace(big, (double)i, i * 2, NULL);
  int ok = 1;
  for (int64_t i = 0; i < 100; i++) if (nt_arr_get(big, (double)i) != i * 2) ok = 0;
  CHECK(ok);
  CHECK(nt_arr_get(shared, 50) == 777);  /* and the shared version STILL untouched */

  printf("arrset_test: %d checks, %d failures\n", g_checks, g_fails);
  return g_fails ? 1 : 0;
}
