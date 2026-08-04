/*
 * actor_test.c — standalone behavioral test harness for the v0 actor runtime.
 *
 * Build & run (from repo root):
 *   clang -O0 -g test/runtime/actor_test.c -o /tmp/actor_test && /tmp/actor_test
 *
 * These are NOT differential-vs-node tests (node has no BEAM scheduler). They are
 * native behavioral tests: under the single cooperative scheduler the interleaving
 * is a pure function of spawn/send order, so output is deterministic and asserted
 * exactly. Each case reinitializes the scheduler for independence.
 *
 * We include the module source directly so the single-file build command works.
 */
#include "../../runtime/nt_actor.c"

#include <stdio.h>
#include <string.h>

/* ---- tiny assert harness ---- */
static int g_checks = 0, g_fails = 0;

static void check_i(const char *what, long got, long want) {
  g_checks++;
  if (got != want) {
    g_fails++;
    fprintf(stderr, "  FAIL %s: got %ld want %ld\n", what, got, want);
  }
}
static void check_s(const char *what, const char *got, const char *want) {
  g_checks++;
  if (strcmp(got, want) != 0) {
    g_fails++;
    fprintf(stderr, "  FAIL %s: got \"%s\" want \"%s\"\n", what, got, want);
  }
}

/* ============================================================
 * Behavior 1: spawn_runs — spawn(body) where body prints "hi"; drain.
 * ============================================================ */
static void body_hi(NtMsg arg) { (void)arg; printf("hi\n"); }

static void test_spawn_runs(void) {
  nt_sched_init();
  nt_spawn(body_hi, nt_int(0));
  nt_drain();               /* run the spawned actor to completion */
  printf("[spawn_runs] ok\n");
}

/* ============================================================
 * Behavior 2: self() — spawn 3 actors, each records self(); assert the three
 * are distinct and all differ from main's self() (== 0).
 * ============================================================ */
static NtPid g_seen[3];
static int   g_seen_n;

static void body_record_self(NtMsg arg) {
  int slot = (int)nt_msg_int(arg);
  g_seen[slot] = nt_self();
  g_seen_n++;
}

static void test_self_distinct(void) {
  nt_sched_init();
  g_seen_n = 0;
  NtPid mainpid = nt_self();
  nt_spawn(body_record_self, nt_int(0));
  nt_spawn(body_record_self, nt_int(1));
  nt_spawn(body_record_self, nt_int(2));
  nt_drain();

  check_i("self: main is pid 0", mainpid, 0);
  check_i("self: 3 actors ran", g_seen_n, 3);
  check_i("self: p0 != main", g_seen[0] != mainpid, 1);
  check_i("self: distinct 0,1", g_seen[0] != g_seen[1], 1);
  check_i("self: distinct 1,2", g_seen[1] != g_seen[2], 1);
  check_i("self: distinct 0,2", g_seen[0] != g_seen[2], 1);
  printf("[self_distinct] ok (pids %lld %lld %lld)\n",
         (long long)g_seen[0], (long long)g_seen[1], (long long)g_seen[2]);
}

/* ============================================================
 * Behavior 3: echo — the canonical v0 round-trip. main sends
 * {reply: self(), body: "ping"} to an echo actor; echo receives and sends the
 * message back to reply; main receives and reads body. Message is modeled as
 * LIST[ INT reply_pid, STR body ] (a tuple/record; field 0 = reply, 1 = body).
 * ============================================================ */
static void body_echo(NtMsg arg) {
  (void)arg;
  NtMsg m = nt_receive();
  NtPid reply = (NtPid)nt_msg_int(nt_msg_list_get(m, 0));
  nt_send(reply, m);            /* bounce the whole message back */
}

static void test_echo(void) {
  nt_sched_init();
  NtPid echo = nt_spawn(body_echo, nt_int(0));

  NtMsg fields[2] = { nt_int(nt_self()), nt_str("ping") };
  nt_send(echo, nt_list(fields, 2));

  NtMsg reply = nt_receive();  /* blocks until echo replies */
  const char *body = nt_msg_str(nt_msg_list_get(reply, 1));
  check_s("echo: body round-trips", body, "ping");
  printf("[echo] ok (%s)\n", body);
}

/* ============================================================
 * Behavior 4: blocking_receive_wakes — the actor calls receive() BEFORE any
 * message exists, so it blocks. main then drains (letting it block), sends, and
 * drains again; the actor wakes and records the value. Proves BLOCKED->RUNNABLE.
 * ============================================================ */
static int64_t g_woke_value;
static int     g_woke;

static void body_waiter(NtMsg arg) {
  (void)arg;
  NtMsg m = nt_receive();       /* blocks: mailbox is empty at first */
  g_woke_value = nt_msg_int(m);
  g_woke = 1;
}

static void test_blocking_receive_wakes(void) {
  nt_sched_init();
  g_woke = 0; g_woke_value = -1;
  NtPid w = nt_spawn(body_waiter, nt_int(0));

  nt_drain();                   /* waiter runs, finds no message, blocks */
  check_i("wake: still blocked (not woken yet)", g_woke, 0);

  nt_send(w, nt_int(42));       /* the wakeup edge */
  nt_drain();                   /* waiter resumes inside receive() */
  check_i("wake: woke after send", g_woke, 1);
  check_i("wake: got the value", (long)g_woke_value, 42);
  printf("[blocking_receive_wakes] ok\n");
}

/* ============================================================
 * Behavior 5: ping-pong — two actors bounce a decrementing counter until it
 * hits 0. Message = LIST[ INT from_pid, INT count ]. Each actor loops on
 * receive(), logs a token, and (while count > 0) replies count-1 to the sender.
 * Under the single scheduler the volley order is deterministic.
 * ============================================================ */
static char g_pp_log[256];

static void pp_log(const char *tok) { strncat(g_pp_log, tok, sizeof(g_pp_log) - strlen(g_pp_log) - 1); }

static void body_ponger(NtMsg arg) {   /* pure responder: never initiates */
  (void)arg;
  for (;;) {
    NtMsg m = nt_receive();
    pp_log("pong ");
    NtPid from  = (NtPid)nt_msg_int(nt_msg_list_get(m, 0));
    int64_t cnt = nt_msg_int(nt_msg_list_get(m, 1));
    if (cnt > 0) {
      NtMsg reply[2] = { nt_int(nt_self()), nt_int(cnt - 1) };
      nt_send(from, nt_list(reply, 2));
    }
  }
}

static void body_pinger(NtMsg arg) {   /* initiates, then responds */
  NtPid peer = (NtPid)nt_msg_int(arg);
  NtMsg first[2] = { nt_int(nt_self()), nt_int(3) };
  nt_send(peer, nt_list(first, 2));    /* open the volley */
  for (;;) {
    NtMsg m = nt_receive();
    pp_log("ping ");
    NtPid from  = (NtPid)nt_msg_int(nt_msg_list_get(m, 0));
    int64_t cnt = nt_msg_int(nt_msg_list_get(m, 1));
    if (cnt > 0) {
      NtMsg reply[2] = { nt_int(nt_self()), nt_int(cnt - 1) };
      nt_send(from, nt_list(reply, 2));
    }
  }
}

static void test_ping_pong(void) {
  nt_sched_init();
  g_pp_log[0] = '\0';
  NtPid pong = nt_spawn(body_ponger, nt_int(0));
  nt_spawn(body_pinger, nt_int(pong));
  nt_drain();                          /* both end blocked in receive */
  check_s("ping_pong: deterministic volley", g_pp_log, "pong ping pong ping ");
  printf("[ping_pong] ok (%s)\n", g_pp_log);
}

/* ============================================================
 * Behavior 6: per-sender FIFO — two senders each send seq 1,2,3 to one
 * collector. The v0 guarantee is PAIRWISE ordering: for each fixed sender its
 * messages arrive in increasing seq. We assert only that (per §6 of the note),
 * NOT any cross-sender interleaving. Message = LIST[ INT sender_id, INT seq ].
 * ============================================================ */
#define PP_N 3
static int64_t g_arr_id[2 * PP_N];
static int64_t g_arr_seq[2 * PP_N];
static int     g_arr_count;

static void body_sender(NtMsg arg) {
  /* arg = LIST[ collector_pid, sender_id ] */
  NtPid collector = (NtPid)nt_msg_int(nt_msg_list_get(arg, 0));
  int64_t id      = nt_msg_int(nt_msg_list_get(arg, 1));
  for (int64_t seq = 1; seq <= PP_N; seq++) {
    NtMsg m[2] = { nt_int(id), nt_int(seq) };
    nt_send(collector, nt_list(m, 2));
  }
}

static void body_collector(NtMsg arg) {
  int64_t total = nt_msg_int(arg);       /* how many to gather */
  for (int64_t k = 0; k < total; k++) {
    NtMsg m = nt_receive();
    g_arr_id[g_arr_count]  = nt_msg_int(nt_msg_list_get(m, 0));
    g_arr_seq[g_arr_count] = nt_msg_int(nt_msg_list_get(m, 1));
    g_arr_count++;
  }
}

static void test_per_sender_fifo(void) {
  nt_sched_init();
  g_arr_count = 0;
  NtPid col = nt_spawn(body_collector, nt_int(2 * PP_N));

  NtMsg aArg[2] = { nt_int(col), nt_int(0) };
  NtMsg bArg[2] = { nt_int(col), nt_int(1) };
  nt_spawn(body_sender, nt_list(aArg, 2));
  nt_spawn(body_sender, nt_list(bArg, 2));
  nt_drain();

  check_i("fifo: collected all", g_arr_count, 2 * PP_N);
  /* pairwise: last-seen seq per sender must strictly increase */
  int64_t last[2] = { 0, 0 };
  int ok = 1;
  for (int i = 0; i < g_arr_count; i++) {
    int64_t id = g_arr_id[i], seq = g_arr_seq[i];
    if (seq != last[id] + 1) ok = 0;    /* per-sender must be 1,2,3 in order */
    last[id] = seq;
  }
  check_i("fifo: per-sender order preserved", ok, 1);
  check_i("fifo: sender 0 reached seq 3", (long)last[0], 3);
  check_i("fifo: sender 1 reached seq 3", (long)last[1], 3);
  printf("[per_sender_fifo] ok\n");
}

/* ============================================================
 * Behavior 7: deep_copy_isolation (canonical) — the sender builds a list
 * [1,2,3], sends it, THEN mutates its own local copy. The receiver must still
 * observe the snapshot at send time (len 3, first element 1), proving send()
 * gave it a private deep copy. If a future shared-send optimization broke
 * isolation, this test fails.
 * ============================================================ */
static int64_t g_iso_len;
static int64_t g_iso_first;

static void body_isolation_rcv(NtMsg arg) {
  (void)arg;
  NtMsg m = nt_receive();
  g_iso_len   = nt_msg_list_len(m);
  g_iso_first = nt_msg_int(nt_msg_list_get(m, 0));
}

static void test_deep_copy_isolation(void) {
  nt_sched_init();
  g_iso_len = -1; g_iso_first = -1;
  NtPid r = nt_spawn(body_isolation_rcv, nt_int(0));

  NtMsg items[3] = { nt_int(1), nt_int(2), nt_int(3) };
  NtMsg local = nt_list(items, 3);
  nt_send(r, local);                     /* deep-copied here */

  /* mutate the sender's local copy AFTER sending */
  local.u.list.items[0] = nt_int(99);
  local.u.list.len = 1;

  nt_drain();
  check_i("isolation: receiver saw original length", (long)g_iso_len, 3);
  check_i("isolation: receiver saw original first elem", (long)g_iso_first, 1);
  printf("[deep_copy_isolation] ok\n");
}

/* ============================================================
 * Behavior 8: registry — a stateful counter registered as "c". main resolves it
 * via whereis("c"), sends inc, inc, then get(reply=self), and receives the state.
 * Also: whereis of an absent name returns 0. Message = LIST[ INT tag, INT reply ]
 * where tag 0 = inc, tag 1 = get.
 * ============================================================ */
static void body_counter(NtMsg arg) {
  (void)arg;
  int64_t state = 0;
  for (;;) {
    NtMsg m = nt_receive();
    int64_t tag = nt_msg_int(nt_msg_list_get(m, 0));
    if (tag == 0) {                       /* inc */
      state++;
    } else {                              /* get: reply with current state */
      NtPid reply = (NtPid)nt_msg_int(nt_msg_list_get(m, 1));
      nt_send(reply, nt_int(state));
    }
  }
}

static void test_request_reply_registry(void) {
  nt_sched_init();
  check_i("registry: absent name -> 0", (long)nt_whereis("nope"), 0);

  NtPid c = nt_spawn(body_counter, nt_int(0));
  nt_register("c", c);
  check_i("registry: whereis resolves", (long)nt_whereis("c"), (long)c);

  NtPid found = nt_whereis("c");
  NtMsg inc[2] = { nt_int(0), nt_int(0) };
  nt_send(found, nt_list(inc, 2));
  nt_send(found, nt_list(inc, 2));
  NtMsg get[2] = { nt_int(1), nt_int(nt_self()) };
  nt_send(found, nt_list(get, 2));

  NtMsg reply = nt_receive();
  check_i("registry: counter state == 2", (long)nt_msg_int(reply), 2);
  printf("[request_reply_registry] ok\n");
}

int main(void) {
  test_spawn_runs();
  test_self_distinct();
  test_echo();
  test_blocking_receive_wakes();
  test_ping_pong();
  test_per_sender_fifo();
  test_deep_copy_isolation();
  test_request_reply_registry();

  if (g_fails) { fprintf(stderr, "\n%d/%d checks FAILED\n", g_fails, g_checks); return 1; }
  printf("\nall v0 actor behaviors passed (%d checks)\n", g_checks);
  return 0;
}
