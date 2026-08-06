/*
 * poll_test.c — B3 v6.4: the async-IO poller (kqueue/epoll), driven at the C level.
 *
 * WHY C. The poller parks an actor on a FILE DESCRIPTOR, and nativets has no TS surface
 * that hands a program an fd — the two blocking IO paths today are `readLine`, which
 * slurps all of stdin up front, and `fetch`, which is blocking libcurl. Retrofitting
 * either onto the poller is its own lane (see docs/ROADMAP.md B3 v6). So the mechanism is
 * gated here, over a real pipe(), which is exactly what those retrofits will use.
 *
 * The property that matters is NOT "the read eventually returned" — a plain blocking read
 * does that too. It is that the parked actor costs NOTHING while it waits: the scheduler
 * keeps running other actors, and the parked one is resumed by kernel readiness. Both are
 * asserted: a compute actor completes its work WHILE the reader is parked (ordering), and
 * the reader still gets its byte afterwards.
 *
 * Build & run (from repo root):
 *   clang -O0 -g test/runtime/poll_test.c -o /tmp/poll_test && /tmp/poll_test
 */
/* Stand-ins for the runtime.c symbols nt_actor.c references, so the single-file build
 * command above links without dragging in the whole runtime (no strings are sent here).
 *
 * THIS LIST MUST TRACK nt_actor.c. It is the price of the single-file build, and it goes
 * stale silently: `nt_num_to_buf` was added to runtime.c by the Number::toString fix and
 * used by nt_actor.c's crash record, which broke this link with an undefined symbol —
 * a failure neither lane could see alone, only their merge. */
#include <stdio.h>
void (*nt_rt_lock)(int acquire) = 0;
void nt_str_register(void *p) { (void)p; }
/* Faithful enough for a test that never renders a crash record; the real one is
 * ECMAScript Number::toString (runtime.c). */
void nt_num_to_buf(double v, char *out, unsigned long out_len) {
  snprintf(out, out_len, "%g", v);
}

#include "../../runtime/nt_actor.c"

#include <stdio.h>
#include <string.h>

static int g_checks = 0, g_fails = 0;
static void check_i(const char *what, long got, long want) {
  g_checks++;
  if (got != want) { g_fails++; fprintf(stderr, "  FAIL %s: got %ld want %ld\n", what, got, want); }
}
static void check_s(const char *what, const char *got, const char *want) {
  g_checks++;
  if (strcmp(got, want) != 0) { g_fails++; fprintf(stderr, "  FAIL %s: got \"%s\" want \"%s\"\n", what, got, want); }
}

/* A trace of the order things happened in, so "the scheduler kept working while the
 * reader was parked" is an assertion rather than a hope. */
static char g_trace[64];
static void trace(char c) { size_t n = strlen(g_trace); if (n < sizeof(g_trace) - 1) { g_trace[n] = c; g_trace[n + 1] = 0; } }

static int g_pipe[2];
static int g_read_rc = -99;
static char g_read_byte = '?';

/* The READER: parks on the pipe's read end until the kernel says it is readable. */
static void reader_body(void *env, int64_t arg) {
  (void)env; (void)arg;
  trace('r');                                   /* about to park */
  g_read_rc = (int)nt_io_wait((int32_t)g_pipe[0], -1);
  trace('R');                                   /* woken by readiness */
  char c = 0;
  if (read(g_pipe[0], &c, 1) == 1) g_read_byte = c;
}

/* The WORKER: ordinary compute. It must get to run — and finish — while the reader is
 * parked, which is the whole claim. It writes the byte last, so if parking did NOT yield
 * the scheduler, this actor could never run and the test would hang instead of pass. */
static void worker_body(void *env, int64_t arg) {
  (void)env; (void)arg;
  trace('w');
  for (int i = 0; i < 3; i++) trace('.');
  trace('W');
  ssize_t n = write(g_pipe[1], "x", 1);         /* now let the reader through */
  (void)n;
}

static void test_park_and_wake(void) {
  nt_sched_init();
  g_trace[0] = 0;
  if (pipe(g_pipe) != 0) { fprintf(stderr, "  FAIL pipe()\n"); g_fails++; return; }

  nt_spawn_closure(reader_body, NULL, 0);       /* spawned FIRST: it parks first */
  nt_spawn_closure(worker_body, NULL, 0);
  nt_drain();

  /* The reader parked ('r'), the worker then ran to completion ('w...W') — i.e. the park
   * released the scheduler — and only then did readiness wake the reader ('R'). Only the
   * single-threaded scheduler makes that an exact string; with M:N the two actors run in
   * parallel, so all that is guaranteed is the causal edge park-before-wake. */
  if (g_nsched == 1) check_s("park yields the scheduler to other actors", g_trace, "rw...WR");
  else {
    const char *r = strchr(g_trace, 'r'), *R = strchr(g_trace, 'R');
    check_i("M:N — parked, then woken by readiness", (r && R && R > r) ? 1 : 0, 1);
  }
  check_i("nt_io_wait reported readiness", g_read_rc, 1);
  check_i("the byte was actually readable", (long)g_read_byte, (long)'x');
  check_i("no actor left parked on a fd", (long)nt_io_waiters(), 0);
  close(g_pipe[0]); close(g_pipe[1]);
}

/* nt_io_wait must REFUSE to park `main` (actor 0 runs on the process's own stack and is
 * the drain driver). -1 tells the caller to keep its ordinary blocking read, which is what
 * keeps every existing non-actor program byte-identical. */
static void test_main_is_never_parked(void) {
  nt_sched_init();
  if (pipe(g_pipe) != 0) { fprintf(stderr, "  FAIL pipe()\n"); g_fails++; return; }
  check_i("main gets the fall-back-to-blocking answer", (long)nt_io_wait((int32_t)g_pipe[0], -1), -1);
  close(g_pipe[0]); close(g_pipe[1]);
}

int main(void) {
  test_park_and_wake();
  test_main_is_never_parked();
  printf("%s (%d checks, %d failures)\n", g_fails ? "FAIL" : "PASS", g_checks, g_fails);
  return g_fails ? 1 : 0;
}
