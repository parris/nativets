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
#include <ucontext.h>

#include "nt_actor.h"

/* macOS marks the ucontext family deprecated; it still works and is the cleanest
 * portable coroutine substrate for v0. Silence just those warnings. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

#define NT_MAX_ACTORS 1024
#define NT_MAX_REG     256
#define NT_STACK_SIZE  (256 * 1024)

typedef enum { NT_RUNNABLE, NT_RUNNING, NT_BLOCKED, NT_DEAD } NtStatus;

typedef struct NtMboxNode { NtMsg msg; struct NtMboxNode *next; } NtMboxNode;

typedef struct NtActor {
  NtPid       pid;
  NtStatus    status;
  NtActorFn   entry;
  NtMsg       entry_arg;
  ucontext_t  ctx;
  char       *stack;
  NtMboxNode *mbox_head, *mbox_tail;   /* FIFO mailbox */
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

static void mbox_push(NtActor *a, NtMsg m) {
  NtMboxNode *n = (NtMboxNode *)malloc(sizeof(NtMboxNode));
  n->msg = m; n->next = NULL;
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

/* actor entry trampoline: runs the body, marks the actor dead, returns to sched */
static void actor_trampoline(void) {
  NtActor *self = g_current;
  self->entry(self->entry_arg);
  self->status = NT_DEAD;
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
  mbox_push(a, msg_deepcopy(msg));            /* MANDATORY deep-copy on send */
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
    if (strcmp(g_reg[i].name, name) == 0) { g_reg[i].pid = pid; return; }
  }
  if (g_nreg >= NT_MAX_REG) return;
  size_t n = strlen(name);
  g_reg[g_nreg].name = (char *)malloc(n + 1);
  memcpy(g_reg[g_nreg].name, name, n + 1);
  g_reg[g_nreg].pid = pid;
  g_nreg++;
}

NtPid nt_whereis(const char *name) {
  for (int i = 0; i < g_nreg; i++)
    if (strcmp(g_reg[i].name, name) == 0) return g_reg[i].pid;
  return 0;   /* absent */
}
