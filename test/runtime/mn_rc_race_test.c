/*
 * mn_rc_race_test — the ThreadSanitizer gate for B3 v6 (M:N scheduler threads).
 *
 * WHY THIS EXISTS AS A C TEST RATHER THAN A COMPILED .ts PROGRAM.
 * The obvious gate would be "compile an actor stress program with -fsanitize=thread and
 * run it". It does not work, and the reason is worth writing down: the scheduler's
 * coroutines are ucontext FIBERS that MIGRATE between OS threads, and TSan's fiber
 * support (__tsan_switch_to_fiber) CHECK-fails on macOS the moment a fiber is resumed on
 * a thread other than the one that suspended it (`tsan_rtl_proc.cpp:46`). Without the
 * annotations TSan instead reports every actor stack slot as a race, because it never saw
 * the swapcontext. Either way the run says nothing about our code. (Both are annotated in
 * nt_actor.c; the annotations are compiled in under -fsanitize=thread.)
 *
 * So this gate isolates what actually becomes SHARED under M:N and drives it with plain
 * pthreads — no fibers, nothing for TSan to misunderstand:
 *
 *   1. runtime.c's STRING refcount side-table (Stage 30) — one global open-addressed hash
 *      that REHASHES. Every deep-copied string message registers in it, from whichever
 *      scheduler thread ran the sender, and is released by whichever thread ran the
 *      receiver.
 *   2. nt_pvec.c's node REFCOUNTS and the Stage-44 TRANSIENT (`rc == 1 ⇒ write the tail in
 *      place`), a check-then-act that must not interleave with another thread's retain.
 *
 * Both are made sound by the `nt_rt_lock` hook, which the actor runtime installs at
 * nt_sched_init when — and only when — it starts more than one scheduler thread. This test
 * installs the SAME hook (a recursive mutex, as nt_actor.c does) and then hammers both
 * structures from N threads. It asserts the counters balance to zero, and under TSan it
 * asserts the far stronger property: no data race at all.
 *
 * Build & run:
 *   clang -O1 -g -fsanitize=thread -DNT_PVEC test/runtime/mn_rc_race_test.c \
 *     runtime/runtime.c runtime/nt_pvec.c -lm -o /tmp/mn_rc_race_test && /tmp/mn_rc_race_test
 * main() returns nonzero if any check fails.
 */

#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../../runtime/nt_pvec.h"

/* runtime.c's string RC surface + the hook it calls through. */
extern void  *nativets_alloc(size_t n);
extern void   nt_str_register(void *p);
extern void  *nt_str_retain(void *p);
extern void   nt_str_release(void *p);
extern double nt_str_live(void);
extern void (*nt_rt_lock)(int acquire);

#define NTHREADS 6
#define ITERS    4000

static int g_fail = 0;
#define CHECK(cond, what) do {                                              \
    if (!(cond)) { printf("FAIL %s (%s:%d)\n", what, __FILE__, __LINE__); g_fail = 1; } \
  } while (0)

/* ---- exactly the hook nt_sched_init installs in M:N mode ---- */
static pthread_mutex_t g_rc_lock;
static void rc_lock_hook(int acquire) {
  if (acquire) pthread_mutex_lock(&g_rc_lock);
  else         pthread_mutex_unlock(&g_rc_lock);
}
static void install_hook(void) {
  pthread_mutexattr_t at;
  pthread_mutexattr_init(&at);
  pthread_mutexattr_settype(&at, PTHREAD_MUTEX_RECURSIVE);  /* pvec's entry points nest */
  pthread_mutex_init(&g_rc_lock, &at);
  pthread_mutexattr_destroy(&at);
  nt_rt_lock = rc_lock_hook;
}

/* ---- 1. the string RC side-table: register / retain / release from N threads ---- */
static void *str_worker(void *arg) {
  long id = (long)(intptr_t)arg;
  for (int i = 0; i < ITERS; i++) {
    char *s = (char *)malloc(32);
    snprintf(s, 32, "msg-%ld-%d", id, i);
    nt_str_register(s);           /* rc = 1, like a deep-copied string message */
    nt_str_retain(s);             /* an alias (a receiving local binding) */
    nt_str_retain(s);
    nt_str_release(s);
    nt_str_release(s);
    nt_str_release(s);            /* rc = 0: freed + removed under the hook */
  }
  return NULL;
}

/* ---- 2. pvec: private builds (transients) + a SHARED vector's refcounts ---- */
static nt_pv *g_shared;           /* one vector every thread retains/releases/updates */

static void *pv_worker(void *arg) {
  (void)arg;
  for (int i = 0; i < ITERS / 8; i++) {
    /* (a) a private vector past the 32-element boundary: exercises the transient fast
     *     path (rc == 1 on header AND tail leaf) concurrently with other threads. */
    nt_pv *v = nt_pv_empty();
    for (int k = 0; k < 40; k++) v = nt_pv_push_own(v, k);
    CHECK(nt_pv_get(v, 39) == 39, "private push_own tail");
    nt_pv_release(v);

    /* (b) the SHARED vector: retain/release its nodes, and path-copy an update off it —
     *     several threads touching the same node refcounts at once. */
    nt_pv_retain(g_shared);
    nt_pv *u = nt_pv_update(g_shared, (uint32_t)(i % 100), 777);
    CHECK(nt_pv_get(u, (uint32_t)(i % 100)) == 777, "shared update value");
    CHECK(nt_pv_get(g_shared, (uint32_t)(i % 100)) ==
          (int64_t)(i % 100), "shared vector unchanged");   /* immutability holds */
    nt_pv_release(u);
    nt_pv_release(g_shared);
  }
  return NULL;
}

static void run(void *(*fn)(void *)) {
  pthread_t th[NTHREADS];
  for (long i = 0; i < NTHREADS; i++) pthread_create(&th[i], NULL, fn, (void *)(intptr_t)i);
  for (int i = 0; i < NTHREADS; i++) pthread_join(th[i], NULL);
}

int main(void) {
  /* NT_RACE_TEST_NOHOOK=1 runs the SAME workload with the hook left uninstalled — i.e.
   * the pre-v6 single-threaded RC. It must report races; that is what proves this gate is
   * sensitive rather than vacuously green. Not the default: it is an EXPECTED FAILURE, and
   * it may not terminate — a corrupted side-table can send str_tab_slot's linear probe
   * (which relies on an empty slot always existing) into an infinite loop.
   *
   * So it bounds ITSELF with alarm(): a harness timeout is a safety net, not a guarantee
   * (an early-returning spawn wrapper once left one of these spinning for 47 minutes on a
   * shared machine). SIGALRM's default action terminates the process, and by then TSan has
   * already streamed its reports, which is all the negative control needs to prove. */
  if (!getenv("NT_RACE_TEST_NOHOOK")) install_hook();
  else alarm(20);

  double str_before = nt_str_live();
  run(str_worker);
  CHECK(nt_str_live() == str_before, "string RC table balances after concurrent churn");

  g_shared = nt_pv_empty();
  for (int i = 0; i < 100; i++) g_shared = nt_pv_push_own(g_shared, i);
  double nodes_with_shared = nt_pv_node_live();
  run(pv_worker);
  CHECK(nt_pv_node_live() == nodes_with_shared, "pvec nodes balance after concurrent churn");
  nt_pv_release(g_shared);
  CHECK(nt_pv_node_live() == 0, "no leaked trie nodes");

  printf(g_fail ? "FAIL\n" : "PASS (%d threads x %d iters)\n", NTHREADS, ITERS);
  return g_fail;
}
