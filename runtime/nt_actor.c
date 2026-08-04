/*
 * nt_actor.c — v0 BEAM-style actor runtime (standalone; see nt_actor.h).
 *
 * Memory model matches the rest of the runtime: allocate-and-never-free (safe,
 * leaks for the process lifetime). Per-actor arenas / drop-on-exit are a
 * follow-up; v0 just mallocs.
 *
 * Scheduling model (deterministic, single-threaded):
 *   - Every actor (including `main`, which is actor 0) has its own ucontext.
 *   - A dedicated scheduler context runs scheduler_loop(): it pops a RUNNABLE
 *     pid off the FIFO run queue, swaps into it, and regains control when that
 *     actor yields (blocks in receive) or dies (body returns). When the run
 *     queue is empty it idle-returns to `main` (the drain / receive caller).
 *   - Blocking receive() sets the actor BLOCKED and yields to the scheduler;
 *     send() to a BLOCKED actor flips it RUNNABLE and enqueues it — that is the
 *     BLOCKED->RUNNABLE wakeup edge.
 *
 * FLAG for later Dyn integration: NtMsg is a v0 placeholder. When codegen wires
 * this up, the message value should become the compiler's `Dyn` tagged value and
 * msg_deepcopy() should be replaced by (or generated as) a type-driven recursive
 * walk — the same shape we already emit for JSON.stringify. The deep-copy-on-send
 * contract (isolation) MUST be preserved regardless of representation.
 */

#ifdef __APPLE__
#  ifndef _XOPEN_SOURCE
#    define _XOPEN_SOURCE 700   /* expose ucontext on macOS */
#  endif
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ucontext.h>

#include "nt_actor.h"

/* macOS marks the ucontext family deprecated; it still works and is the cleanest
 * portable coroutine substrate for v0. Silence just those warnings. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

#define NT_MAX_ACTORS 1024
#define NT_MAX_REG     256
#define NT_STACK_SIZE  (256 * 1024)
#define NT_SUP_CHILD_ID_MAX 64

typedef enum { NT_RUNNABLE, NT_RUNNING, NT_BLOCKED, NT_DEAD } NtStatus;

typedef struct NtMboxNode { NtMsg msg; NtPid from; struct NtMboxNode *next; } NtMboxNode;

#define NT_MAX_LINKS   64
#define NT_MAX_MONS    64

typedef struct { NtPid watcher; int64_t ref; } NtMon;

typedef struct NtActor {
  NtPid       pid;
  NtStatus    status;
  NtActorFn   entry;
  NtMsg       entry_arg;
  /* compiler-facing closure entry (see nt_spawn_closure); is_closure selects it */
  int         is_closure;
  NtClosureFn centry;
  void       *cenv;
  int64_t     carg;
  ucontext_t  ctx;
  char       *stack;
  NtMboxNode *mbox_head, *mbox_tail;   /* FIFO mailbox */

  /* ---- v2: links / monitors / trap_exit / crash record ---- */
  const char *name;                    /* registered name (for the crash record) or NULL */
  int         trap_exit;               /* exits arrive as messages instead of killing */
  int         is_supervisor;           /* the supervisor decodes EXIT/DOWN itself */
  int         supervised;              /* a supervisor owns this child (it emits the record) */
  NtPid       links[NT_MAX_LINKS]; int nlinks;
  NtMon       monitors[NT_MAX_MONS]; int nmons;   /* who is monitoring THIS actor */
  /* triggering-message causal tag: the last message this actor dequeued */
  int         last_valid; NtPid last_from; int64_t last_val;
} NtActor;

typedef struct NtRqNode { NtPid pid; struct NtRqNode *next; } NtRqNode;

/* ---- scheduler globals ---- */
static NtActor  *g_actors[NT_MAX_ACTORS];
static int64_t   g_nactors;
static NtActor  *g_current;         /* the running (or parked) actor */
static NtActor  *g_main;            /* actor 0 */
static ucontext_t g_sched_ctx;      /* the scheduler's own context */
static char      *g_sched_stack;
static NtRqNode  *g_rq_head, *g_rq_tail;

static struct { char *name; NtPid pid; } g_reg[NT_MAX_REG];
static int g_nreg;

/* ======================= message value ======================= */

NtMsg nt_int(int64_t v) { NtMsg m; m.tag = NT_INT; m.u.i = v; return m; }

NtMsg nt_str(const char *s) {
  NtMsg m; m.tag = NT_STR;
  size_t n = strlen(s);
  m.u.s = (char *)malloc(n + 1);
  memcpy(m.u.s, s, n + 1);
  return m;
}

NtMsg nt_list(const NtMsg *items, int64_t len) {
  NtMsg m; m.tag = NT_LIST; m.u.list.len = len;
  m.u.list.items = (NtMsg *)malloc(sizeof(NtMsg) * (len > 0 ? (size_t)len : 1));
  for (int64_t i = 0; i < len; i++) m.u.list.items[i] = items[i];
  return m;
}

int64_t     nt_msg_int(NtMsg m)      { return m.u.i; }
const char *nt_msg_str(NtMsg m)      { return m.u.s; }
int64_t     nt_msg_list_len(NtMsg m) { return m.u.list.len; }
NtMsg       nt_msg_list_get(NtMsg m, int64_t i) { return m.u.list.items[i]; }

/* MANDATORY deep copy on send: a recursive walk producing a fully private copy,
 * so the receiver can never observe the sender's later mutations. */
static NtMsg msg_deepcopy(NtMsg m) {
  switch (m.tag) {
    case NT_INT: return nt_int(m.u.i);
    case NT_STR: return nt_str(m.u.s);
    case NT_LIST: {
      NtMsg out; out.tag = NT_LIST; out.u.list.len = m.u.list.len;
      out.u.list.items = (NtMsg *)malloc(sizeof(NtMsg) * (m.u.list.len > 0 ? (size_t)m.u.list.len : 1));
      for (int64_t i = 0; i < m.u.list.len; i++)
        out.u.list.items[i] = msg_deepcopy(m.u.list.items[i]);
      return out;
    }
  }
  return nt_int(0); /* unreachable */
}

/* ======================= run queue (FIFO) ======================= */

static void rq_push(NtPid pid) {
  NtRqNode *n = (NtRqNode *)malloc(sizeof(NtRqNode));
  n->pid = pid; n->next = NULL;
  if (g_rq_tail) g_rq_tail->next = n; else g_rq_head = n;
  g_rq_tail = n;
}

static int rq_pop(NtPid *out) {
  if (!g_rq_head) return 0;
  NtRqNode *n = g_rq_head;
  g_rq_head = n->next;
  if (!g_rq_head) g_rq_tail = NULL;
  *out = n->pid;
  free(n);
  return 1;
}

/* ======================= mailbox (FIFO) ======================= */

static void mbox_push_from(NtActor *a, NtMsg m, NtPid from) {
  NtMboxNode *n = (NtMboxNode *)malloc(sizeof(NtMboxNode));
  n->msg = m; n->from = from; n->next = NULL;
  if (a->mbox_tail) a->mbox_tail->next = n; else a->mbox_head = n;
  a->mbox_tail = n;
}

static int mbox_empty(NtActor *a) { return a->mbox_head == NULL; }

static NtMsg mbox_pop(NtActor *a) {
  NtMboxNode *n = a->mbox_head;
  a->mbox_head = n->next;
  if (!a->mbox_head) a->mbox_tail = NULL;
  NtMsg m = n->msg;
  free(n);
  return m;
}

/* ======================= actors / scheduler ======================= */

static NtActor *actor_alloc(int with_stack) {
  NtActor *a = (NtActor *)calloc(1, sizeof(NtActor));
  a->pid = g_nactors;
  a->status = NT_RUNNING;
  a->stack = with_stack ? (char *)malloc(NT_STACK_SIZE) : NULL;
  g_actors[g_nactors++] = a;
  return a;
}

/* v2: a normal body return is a NORMAL exit — it must still notify monitors and
 * (for a trapping peer) linked actors. Forward-declared; defined in the v2 block. */
static void actor_die(NtActor *a, int64_t reason, int abnormal);

/* actor entry trampoline: runs the body, marks the actor dead, returns to sched */
static void actor_trampoline(void) {
  NtActor *self = g_current;
  if (self->is_closure) self->centry(self->cenv, self->carg);  /* compiler ABI */
  else                  self->entry(self->entry_arg);          /* NtMsg ABI */
  actor_die(self, NT_REASON_NORMAL, 0);   /* normal exit: notify monitors/links */
  /* hand control back to the scheduler; we never resume */
  swapcontext(&self->ctx, &g_sched_ctx);
}

/* The scheduler: pick RUNNABLE actors FIFO; idle-return to main when empty. */
static void scheduler_loop(void) {
  for (;;) {
    NtPid pid;
    if (rq_pop(&pid)) {
      NtActor *a = g_actors[pid];
      if (a->status != NT_RUNNABLE) continue;   /* stale queue entry */
      a->status = NT_RUNNING;
      g_current = a;
      swapcontext(&g_sched_ctx, &a->ctx);        /* run until it yields/dies */
    } else {
      /* run queue empty: resume whoever entered the scheduler (main). */
      g_current = g_main;
      g_main->status = NT_RUNNING;
      swapcontext(&g_sched_ctx, &g_main->ctx);
    }
  }
}

/* yield the current actor back to the scheduler context */
static void yield_to_sched(void) {
  swapcontext(&g_current->ctx, &g_sched_ctx);
}

void nt_sched_init(void) {
  /* Fresh state each init so test cases are independent (never-free: we leak
   * the previous run's actors/queues, which is fine for v0). */
  g_nactors = 0;
  g_rq_head = g_rq_tail = NULL;
  g_nreg = 0;

  g_main = actor_alloc(/*with_stack=*/0);  /* actor 0 uses the native/main stack */
  g_current = g_main;

  g_sched_stack = (char *)malloc(NT_STACK_SIZE);
  getcontext(&g_sched_ctx);
  g_sched_ctx.uc_stack.ss_sp = g_sched_stack;
  g_sched_ctx.uc_stack.ss_size = NT_STACK_SIZE;
  g_sched_ctx.uc_link = NULL;               /* scheduler_loop never returns */
  makecontext(&g_sched_ctx, scheduler_loop, 0);
}

NtPid nt_spawn(NtActorFn body, NtMsg arg) {
  NtActor *a = actor_alloc(/*with_stack=*/1);
  a->entry = body;
  a->entry_arg = msg_deepcopy(arg);          /* isolate the spawn arg too */
  a->status = NT_RUNNABLE;

  getcontext(&a->ctx);
  a->ctx.uc_stack.ss_sp = a->stack;
  a->ctx.uc_stack.ss_size = NT_STACK_SIZE;
  a->ctx.uc_link = &g_sched_ctx;             /* safety: fall back to scheduler */
  makecontext(&a->ctx, actor_trampoline, 0);

  rq_push(a->pid);
  return a->pid;
}

void nt_send(NtPid to, NtMsg msg) {
  if (to < 0 || to >= g_nactors) return;      /* unknown pid: drop (BEAM-ish) */
  NtActor *a = g_actors[to];
  if (a->status == NT_DEAD) return;
  mbox_push_from(a, msg_deepcopy(msg), g_current ? g_current->pid : -1); /* deep-copy on send */
  if (a->status == NT_BLOCKED) {              /* wake a blocked receiver */
    a->status = NT_RUNNABLE;
    rq_push(a->pid);
  }
}

NtMsg nt_receive(void) {
  NtActor *a = g_current;
  while (mbox_empty(a)) {
    a->status = NT_BLOCKED;
    yield_to_sched();                         /* scheduler runs others; wakes us */
    a = g_current;                            /* same actor, resumed */
  }
  /* record the causal tag (triggering message + origin) for the crash record */
  a->last_valid = 1;
  a->last_from = a->mbox_head->from;
  a->last_val = (a->mbox_head->msg.tag == NT_INT) ? a->mbox_head->msg.u.i : 0;
  return mbox_pop(a);
}

NtPid nt_self(void) { return g_current->pid; }

void nt_drain(void) {
  /* Park main, run the scheduler until the run queue drains, then resume here. */
  yield_to_sched();
}

/* ======================= registry ======================= */

void nt_register(const char *name, NtPid pid) {
  for (int i = 0; i < g_nreg; i++) {
    if (strcmp(g_reg[i].name, name) == 0) {
      g_reg[i].pid = pid;
      if (pid >= 0 && pid < g_nactors) g_actors[pid]->name = g_reg[i].name;
      return;
    }
  }
  if (g_nreg >= NT_MAX_REG) return;
  size_t n = strlen(name);
  g_reg[g_nreg].name = (char *)malloc(n + 1);
  memcpy(g_reg[g_nreg].name, name, n + 1);
  g_reg[g_nreg].pid = pid;
  if (pid >= 0 && pid < g_nactors) g_actors[pid]->name = g_reg[g_nreg].name;
  g_nreg++;
}

NtPid nt_whereis(const char *name) {
  for (int i = 0; i < g_nreg; i++)
    if (strcmp(g_reg[i].name, name) == 0) return g_reg[i].pid;
  return 0;   /* absent */
}

/* ======================= compiler-facing ABI ======================= */
/* Same scheduler as above; a spawned body is a closure `body(env, arg)` and
 * messages are raw i64 slots. For v0 (number messages) the slot carries a bit-
 * cast double and needs no deep copy; when `Dyn` messages land the compiler
 * deep-copies the value before nt_send_slot (reusing the JSON.stringify-style
 * walk / nt_dyn_deepcopy), preserving the isolation contract. */

NtPid nt_spawn_closure(NtClosureFn body, void *env, int64_t arg) {
  NtActor *a = actor_alloc(/*with_stack=*/1);
  a->is_closure = 1;
  a->centry = body;
  a->cenv = env;
  a->carg = arg;                    /* v0: raw slot, no copy needed */
  a->status = NT_RUNNABLE;

  getcontext(&a->ctx);
  a->ctx.uc_stack.ss_sp = a->stack;
  a->ctx.uc_stack.ss_size = NT_STACK_SIZE;
  a->ctx.uc_link = &g_sched_ctx;
  makecontext(&a->ctx, actor_trampoline, 0);

  rq_push(a->pid);
  return a->pid;
}

void nt_send_slot(NtPid to, int64_t slot) {
  /* route through nt_send so the wake / FIFO logic stays in one place; the slot
   * rides in an NT_INT whose deep-copy is identity. */
  nt_send(to, nt_int(slot));
}

int64_t nt_receive_slot(void) {
  NtMsg m = nt_receive();
  /* v2: a trapped EXIT / a monitor DOWN arrives as an NT_LIST [from_pid, reason];
   * a plain TS actor observes it as the dead peer's pid (v0 messages are numbers).
   * v0 slots carry a number as its double bit-pattern (codegen bit-casts the slot
   * back to double), so encode the pid the same way. Normal number messages are
   * NT_INT slots and pass through unchanged. */
  if (m.tag == NT_LIST && m.u.list.len >= 1) {
    double d = (double)m.u.list.items[0].u.i;
    int64_t bits; memcpy(&bits, &d, sizeof(bits));
    return bits;
  }
  return m.u.i;
}

/* ============================================================================
 * v2 — links / monitors / trap_exit / fault injection / crash record
 * ========================================================================== */

static int64_t g_mon_ref = 1;                 /* monotonic monitor-ref allocator */
static void actor_die(NtActor *a, int64_t reason, int abnormal);

/* Build an exit/down notification message NT_LIST [from_pid, reason]. */
static NtMsg exit_msg(NtPid from, int64_t reason) {
  NtMsg items[2] = { nt_int((int64_t)from), nt_int(reason) };
  return nt_list(items, 2);
}

static void deliver_to(NtActor *peer, NtPid from, int64_t reason) {
  if (peer->status == NT_DEAD) return;
  mbox_push_from(peer, exit_msg(from, reason), from);
  if (peer->status == NT_BLOCKED) { peer->status = NT_RUNNABLE; rq_push(peer->pid); }
}

/* Reduced crash record (v2): who / why / triggering message. The supervisor
 * augments this with supervisor + restart decision at v3 (emit_sup_record). */
static void emit_crash_record(NtActor *a, int64_t reason) {
  const char *seed = getenv("NATIVETS_SCHED_SEED");
  fprintf(stderr,
    "=== nativets actor crash ===============================================\n");
  fprintf(stderr, "actor:        pid=%lld name=\"%s\"\n",
          (long long)a->pid, a->name ? a->name : "");
  if (reason == NT_REASON_KILL)
    fprintf(stderr, "reason:       killed (brutal __kill)\n");
  else
    fprintf(stderr, "reason:       abnormal exit (code=%lld)\n", (long long)reason);
  fprintf(stderr, "stacktrace:   <synchronous; single-actor call stack>\n");
  if (a->last_valid) {
    double mv; memcpy(&mv, &a->last_val, sizeof(mv)); /* v0 msg = number (double bits) */
    fprintf(stderr, "triggering-message:\n    from pid=%lld\n    %g\n",
            (long long)a->last_from, mv);
  } else
    fprintf(stderr, "triggering-message:  (none — external signal)\n");
  fprintf(stderr, "seed:         NATIVETS_SCHED_SEED=%s\n", seed ? seed : "(unset)");
  fprintf(stderr,
    "========================================================================\n");
}

/* An actor dies: notify monitors (always, with reason) and propagate along links
 * (abnormal kills a non-trapping peer; a trapping peer gets a message instead;
 * a normal exit does not kill a linked non-trapping peer). Idempotent on DEAD. */
static void actor_die(NtActor *a, int64_t reason, int abnormal) {
  if (a->status == NT_DEAD) return;
  a->status = NT_DEAD;

  /* Emit the crash record here unless a supervisor owns this child — in that case
   * the supervisor prints the full record (with its restart decision). */
  if (abnormal && !a->is_supervisor && !a->supervised)
    emit_crash_record(a, reason);        /* supervised children: the supervisor emits it */

  /* monitors: unidirectional DOWN, always delivered with the reason. */
  for (int i = 0; i < a->nmons; i++) {
    NtActor *w = g_actors[a->monitors[i].watcher];
    if (w) deliver_to(w, a->pid, reason);
  }

  /* links: bidirectional exit-signal propagation. */
  for (int i = 0; i < a->nlinks; i++) {
    NtPid pp = a->links[i];
    if (pp < 0 || pp >= g_nactors) continue;
    NtActor *peer = g_actors[pp];
    if (peer->status == NT_DEAD) continue;
    if (peer->trap_exit)      deliver_to(peer, a->pid, reason); /* survives; gets msg */
    else if (abnormal)        actor_die(peer, reason, 1);       /* cascade the exit */
    /* normal exit to a non-trapping linked peer: ignored (peer keeps running). */
  }
}

void nt_link(NtPid other) {
  if (other < 0 || other >= g_nactors) return;
  NtActor *a = g_current, *b = g_actors[other];
  if (a->nlinks < NT_MAX_LINKS) a->links[a->nlinks++] = other;
  if (b->nlinks < NT_MAX_LINKS) b->links[b->nlinks++] = a->pid;
}

int64_t nt_monitor(NtPid target) {
  int64_t ref = g_mon_ref++;
  if (target < 0 || target >= g_nactors) return ref;
  NtActor *t = g_actors[target];
  if (t->status == NT_DEAD) {                 /* monitoring a dead pid fires at once */
    deliver_to(g_current, target, NT_REASON_NORMAL);
    return ref;
  }
  if (t->nmons < NT_MAX_MONS) { t->monitors[t->nmons].watcher = g_current->pid;
                                t->monitors[t->nmons].ref = ref; t->nmons++; }
  return ref;
}

void nt_trap_exit(int on) { g_current->trap_exit = on ? 1 : 0; }

void nt_actor_exit(NtPid target, int64_t reason) {
  if (target < 0 || target >= g_nactors) return;
  NtActor *t = g_actors[target];
  if (t->status == NT_DEAD) return;
  int abnormal = (reason != NT_REASON_NORMAL);
  if (t->trap_exit)   deliver_to(t, g_current ? g_current->pid : -1, reason);
  else if (abnormal)  actor_die(t, reason, 1);
  /* normal exit to a non-trapping actor: ignored. */
}

void nt_crash(int64_t reason) {
  NtActor *self = g_current;
  actor_die(self, reason ? reason : 1, 1);    /* reason 0 would be "normal"; force abnormal */
  yield_to_sched();                            /* never resumes — coroutine abandoned */
}

void nt_kill(NtPid target) {
  if (target < 0 || target >= g_nactors) return;
  NtActor *t = g_actors[target];
  if (t == g_current) { nt_crash(NT_REASON_KILL); return; }
  actor_die(t, NT_REASON_KILL, 1);            /* brutal external kill; coroutine abandoned */
}

/* ============================================================================
 * v3 — one_for_one supervision
 * ========================================================================== */

#define NT_MAX_SUPS      64
#define NT_SUP_MAX_CHILD 32
#define NT_SUP_WINDOW    256

typedef double (*NtStartFn)(void *env);       /* a TS `() => Pid` closure entry */

typedef struct {
  int      used;
  char     id[NT_SUP_CHILD_ID_MAX];
  void    *start;                             /* closure block [fn_ptr, caps...] */
  int      restart_kind;
  NtPid    pid;                               /* current child pid (-1 if down) */
} NtChild;

typedef struct {
  int      used;
  int64_t  max_restarts, max_seconds;
  int64_t  strategy;
  NtChild  children[NT_SUP_MAX_CHILD]; int nchildren;
  int64_t  stamps[NT_SUP_WINDOW]; int nstamps; /* restart timestamps (sliding window) */
  NtPid    pid;                                /* the supervisor actor's pid */
} NtSup;

static NtSup g_sups[NT_MAX_SUPS];
static int   g_nsups;

int64_t nt_sup_new(int64_t max_restarts, int64_t max_seconds, int64_t strategy) {
  int h = g_nsups++;
  NtSup *s = &g_sups[h];
  memset(s, 0, sizeof(*s));
  s->used = 1;
  s->max_restarts = max_restarts;
  s->max_seconds = max_seconds;
  s->strategy = strategy;                     /* only one_for_one today */
  return h;
}

static int restart_kind_of(const char *r) {
  if (r && strcmp(r, "transient") == 0) return NT_RESTART_TRANSIENT;
  if (r && strcmp(r, "temporary") == 0) return NT_RESTART_TEMPORARY;
  return NT_RESTART_PERMANENT;
}

void nt_sup_add_child(int64_t handle, const char *id, void *start_closure, const char *restart) {
  NtSup *s = &g_sups[handle];
  if (s->nchildren >= NT_SUP_MAX_CHILD) return;
  NtChild *c = &s->children[s->nchildren++];
  c->used = 1;
  strncpy(c->id, id ? id : "", NT_SUP_CHILD_ID_MAX - 1);
  c->start = start_closure;
  c->restart_kind = restart_kind_of(restart);
  c->pid = -1;
}

/* Call a child's TS `() => Pid` start closure and register it under its id. */
static NtPid sup_start_child(NtChild *c) {
  NtStartFn fn = (NtStartFn)(((void **)c->start)[0]);   /* slot 0 = fn ptr */
  NtPid pid = (NtPid)fn(c->start);
  c->pid = pid;
  if (pid >= 0 && pid < g_nactors) g_actors[pid]->supervised = 1;
  nt_link(pid);                               /* supervisor links each child */
  nt_register(c->id, pid);                    /* whereis(id) tracks the current pid */
  return pid;
}

static void emit_sup_record(NtSup *s, NtChild *c, int64_t reason, const char *decision) {
  const char *seed = getenv("NATIVETS_SCHED_SEED");
  fprintf(stderr,
    "=== nativets actor crash ===============================================\n");
  fprintf(stderr, "actor:        pid=%lld name=\"%s\"\n", (long long)c->pid, c->id);
  if (reason == NT_REASON_KILL) fprintf(stderr, "reason:       killed (brutal __kill)\n");
  else fprintf(stderr, "reason:       abnormal exit (code=%lld)\n", (long long)reason);
  fprintf(stderr, "supervisor:   pid=%lld strategy=one_for_one\n", (long long)s->pid);
  fprintf(stderr, "decision:     %s\n", decision);
  fprintf(stderr, "seed:         NATIVETS_SCHED_SEED=%s\n", seed ? seed : "(unset)");
  fprintf(stderr,
    "========================================================================\n");
}

/* Would recording one more restart now exceed the intensity limit? */
static int intensity_exceeded(NtSup *s) {
  int64_t now = (int64_t)time(NULL);
  int kept = 0;
  for (int i = 0; i < s->nstamps; i++)
    if (s->stamps[i] > now - s->max_seconds) s->stamps[kept++] = s->stamps[i];
  s->nstamps = kept;                          /* prune stamps outside the window */
  return s->nstamps >= s->max_restarts;        /* another restart would exceed */
}

static void record_restart(NtSup *s) {
  int64_t now = (int64_t)time(NULL);
  if (s->nstamps < NT_SUP_WINDOW) s->stamps[s->nstamps++] = now;
}

/* The supervisor actor body: trap exits, start children, then react to deaths. */
static void sup_body(void *env, int64_t arg) {
  (void)arg;
  NtSup *s = (NtSup *)env;
  NtActor *me = g_current;
  me->is_supervisor = 1;
  s->pid = me->pid;
  nt_trap_exit(1);
  for (int i = 0; i < s->nchildren; i++) sup_start_child(&s->children[i]);

  for (;;) {
    NtMsg m = nt_receive();                   /* an EXIT signal: NT_LIST [pid, reason] */
    if (m.tag != NT_LIST || m.u.list.len < 2) continue;
    NtPid dead = (NtPid)m.u.list.items[0].u.i;
    int64_t reason = m.u.list.items[1].u.i;

    NtChild *c = NULL;
    for (int i = 0; i < s->nchildren; i++)
      if (s->children[i].pid == dead) { c = &s->children[i]; break; }
    if (!c) continue;
    c->pid = -1;

    int abnormal = (reason != NT_REASON_NORMAL);
    int want_restart =
        c->restart_kind == NT_RESTART_PERMANENT ? 1 :
        c->restart_kind == NT_RESTART_TRANSIENT ? abnormal : 0;

    if (!want_restart) {
      emit_sup_record(s, c, reason, "NO RESTART (normal/temporary child)");
      continue;
    }
    if (intensity_exceeded(s)) {
      emit_sup_record(s, c, reason,
        "INTENSITY EXCEEDED — supervisor exiting :shutdown");
      /* terminate remaining children, then the supervisor exits :shutdown. */
      for (int i = 0; i < s->nchildren; i++)
        if (s->children[i].pid >= 0) actor_die(g_actors[s->children[i].pid], NT_REASON_KILL, 1);
      actor_die(me, NT_REASON_NORMAL /*:shutdown, not a crash*/, 0);
      yield_to_sched();                        /* supervisor is done */
      return;
    }
    record_restart(s);
    NtPid np = sup_start_child(c);
    emit_sup_record(s, c, reason, "RESTART (one_for_one)");
    (void)np;
  }
}

NtPid nt_sup_start(int64_t handle) {
  NtSup *s = &g_sups[handle];
  return nt_spawn_closure((NtClosureFn)sup_body, (void *)s, 0);
}
