/*
 * nt_actor.c — v0 BEAM-style actor runtime (standalone; see nt_actor.h).
 *
 * Memory model matches the rest of the runtime: allocate-and-never-free (safe,
 * leaks for the process lifetime). Per-actor arenas / drop-on-exit are a
 * follow-up; v0 just mallocs.
 *
 * Scheduling model:
 *   - Every actor (including `main`, which is actor 0) has its own ucontext.
 *   - A scheduler context runs scheduler_loop(): it pops a RUNNABLE pid off a FIFO
 *     run queue, swaps into it, and regains control when that actor yields (blocks
 *     in receive), is preempted, or dies. When nothing is runnable anywhere,
 *     scheduler 0 idle-returns to `main` (the drain / receive caller).
 *   - Blocking receive() switches out asking to be BLOCKED; send() to a BLOCKED
 *     actor CASes it RUNNABLE and enqueues it — the BLOCKED->RUNNABLE wakeup edge.
 *   - v6: `NATIVETS_SCHED_THREADS` chooses ONE scheduler (the default; the schedule
 *     is then a pure function of the program, which is what the behavioral tests
 *     assert) or N OS threads with per-scheduler queues, work stealing and lock-free
 *     MPSC mailbox intake. See nt_actor.h's v6 block for what survives the switch.
 *
 * MESSAGE VALUES (resolved in v5): NtMsg stays the internal carrier for the C-level
 * API and for exit/DOWN signals, but a COMPILER-sent message is a raw 8-byte slot plus
 * a kind tag and — for a record/array — a SHAPE tag. The deep copy the original FLAG
 * asked for is type-driven and emitted by CODEGEN (the same walk as structuredClone /
 * JSON.stringify), because only the compiler knows the type of a slot. The
 * deep-copy-on-send contract (isolation) is preserved for every message kind:
 * numbers are values, strings are copied here (copy_str_slot), records/arrays are
 * copied by codegen before nt_send_struct.
 */

#ifdef __APPLE__
#  ifndef _XOPEN_SOURCE
#    define _XOPEN_SOURCE 700   /* expose ucontext on macOS */
#  endif
   /* _XOPEN_SOURCE hides the BSD extensions on macOS; v6 needs _SC_NPROCESSORS_ONLN. */
#  ifndef _DARWIN_C_SOURCE
#    define _DARWIN_C_SOURCE 1
#  endif
#endif

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

/* v6 async-IO poller: kqueue on macOS/BSD, epoll on Linux. Absent elsewhere, in which
 * case nt_io_wait reports "unsupported" and the caller keeps its blocking read. */
#if defined(__linux__)
#  include <sys/epoll.h>
#  define NT_POLL_EPOLL 1
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#  include <sys/event.h>
#  define NT_POLL_KQUEUE 1
#endif

#include "nt_actor.h"

/* runtime.c: JS `Number::toString` (ECMAScript 6.1.6.1.20). A crash record shows
 * a number message exactly as the program would have printed it, so it must not
 * use printf's %g (which pads exponents and switches notation at the wrong
 * magnitudes). */
extern void nt_num_to_buf(double v, char *out, size_t out_len);

/* macOS marks the ucontext family deprecated; it still works and is the cleanest
 * portable coroutine substrate for v0. Silence just those warnings. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

/* ============================================================================
 * ThreadSanitizer FIBER annotations.
 *
 * TSan models one shadow stack per OS thread. ucontext coroutines break that: an actor's
 * stack is written on one scheduler thread and read on another after migration, and TSan
 * — which never saw the swapcontext — reports every such access as a race. Those are
 * FALSE POSITIVES that drown the real ones, so an unannotated TSan run over this runtime
 * is worthless. TSan ships an API for exactly this; we drive it so a report from
 * `-fsanitize=thread` means something.
 *
 * Compiled away entirely unless -fsanitize=thread is on, so the shipped runtime is
 * unchanged. Each ucontext (every actor, every scheduler) owns one TSan fiber; each
 * swapcontext is preceded by the matching __tsan_switch_to_fiber.
 * ========================================================================== */
#if defined(__has_feature)
#  if __has_feature(thread_sanitizer)
#    define NT_TSAN_FIBERS 1
#  endif
#endif

#ifdef NT_TSAN_FIBERS
void *__tsan_get_current_fiber(void);
void *__tsan_create_fiber(unsigned flags);
void  __tsan_destroy_fiber(void *fiber);
void  __tsan_switch_to_fiber(void *fiber, unsigned flags);
#  define NT_FIBER_FIELD          void *tsan_fiber;
#  define NT_FIBER_NEW(o)         ((o)->tsan_fiber = __tsan_create_fiber(0))
#  define NT_FIBER_HERE(o)        ((o)->tsan_fiber = __tsan_get_current_fiber())
#  define NT_FIBER_SWITCH(o)      __tsan_switch_to_fiber((o)->tsan_fiber, 0)
#else
#  define NT_FIBER_FIELD
#  define NT_FIBER_NEW(o)         ((void)0)
#  define NT_FIBER_HERE(o)        ((void)0)
#  define NT_FIBER_SWITCH(o)      ((void)0)
#endif

#define NT_MAX_ACTORS 1024
#define NT_MAX_REG     256
#define NT_STACK_SIZE  (256 * 1024)
#define NT_SUP_CHILD_ID_MAX 64

/* v1 reduction-counted preemption: an actor may run this many reductions (safepoints
 * — call sites + loop back-edges, emitted by codegen) before it is forced to yield.
 * Matches BEAM's CONTEXT_REDS. One fixed budget + one cooperative scheduler ⇒ the
 * interleaving is a pure function of the program, so fairness tests stay deterministic. */
#define NT_CONTEXT_REDS 2000

/* v6: NT_SWITCHING is the state an actor occupies WHILE it is saving its context on the
 * way out to a scheduler. It exists purely for M:N safety: a sender must never enqueue an
 * actor whose registers are still being written to its ucontext, or a second scheduler
 * thread could swapcontext INTO a half-saved context. Only the scheduler that regained
 * control may leave SWITCHING (see finish_slice), so the transition is race-free. */
typedef enum { NT_RUNNABLE, NT_RUNNING, NT_BLOCKED, NT_DEAD, NT_SWITCHING } NtStatus;

/* v4: a mailbox node carries the message KIND (number / string) alongside the
 * slot, so a receive can (a) reject a kind it was not compiled for instead of
 * reinterpreting the bits, and (b) skip non-matching kinds during a selective scan. */
/* v5: a STRUCTURED message additionally carries its SHAPE (the compiler's canonical
 * type encoding, a static string) and an optional renderer for the crash record. */
typedef struct NtMboxNode {
  NtMsg msg; NtPid from; int kind;
  const char *shape; NtMsgRender render;
  struct NtMboxNode *next;
} NtMboxNode;

/* v6 LOCK-FREE MPSC MAILBOX. Many senders, exactly ONE receiver per actor — so the right
 * structure is a multi-producer/single-consumer queue, and the cheapest correct one is a
 * Treiber stack for the intake plus a batch REVERSE on the consumer side:
 *
 *   push (any thread): one CAS loop on `in_head`  — O(1), lock free, wait free in practice
 *   drain (owner only): atomic_exchange(in_head, NULL), reverse the batch, append to the
 *                       owner's PRIVATE list.
 *
 * Reversing the LIFO intake restores push order, so overall FIFO — and therefore per-sender
 * FIFO, the only ordering the actor model promises — is preserved. The private list is the
 * same singly-linked list v4/v5 already scan for SELECTIVE receive (peek/take by index),
 * which an MPSC queue cannot support: this is exactly BEAM's outer(shared)/inner(private)
 * mailbox split, and it means the save-queue machinery is untouched. */

#define NT_MAX_LINKS   64
#define NT_MAX_MONS    64

typedef struct { NtPid watcher; int64_t ref; } NtMon;

typedef struct NtActor {
  NtPid       pid;
  _Atomic int status;                  /* NtStatus; atomic — senders CAS BLOCKED->RUNNABLE */
  int         next_status;             /* what the actor wants to be after this slice */
  int64_t     wait_n;                  /* v6: block until mbox holds MORE than this many */
  _Atomic long kill_req;               /* v6: async kill of an actor RUNNING on another thread */
  _Atomic int io_ready;                /* v6: the poller saw our fd become readable */
  _Atomic(NtMboxNode *) in_head;       /* v6: lock-free MPSC intake (Treiber stack) */
  NtActorFn   entry;
  NtMsg       entry_arg;
  /* compiler-facing closure entry (see nt_spawn_closure); is_closure selects it */
  int         is_closure;
  NtClosureFn centry;
  void       *cenv;
  int64_t     carg;
  ucontext_t  ctx;
  char       *stack;
  NT_FIBER_FIELD
  NtMboxNode *mbox_head, *mbox_tail;   /* FIFO mailbox */

  /* ---- v2: links / monitors / trap_exit / crash record ---- */
  const char *name;                    /* registered name (for the crash record) or NULL */
  int         trap_exit;               /* exits arrive as messages instead of killing */
  int         is_supervisor;           /* the supervisor decodes EXIT/DOWN itself */
  int         supervised;              /* a supervisor owns this child (it emits the record) */
  NtPid       links[NT_MAX_LINKS]; int nlinks;
  NtMon       monitors[NT_MAX_MONS]; int nmons;   /* who is monitoring THIS actor */
  /* triggering-message causal tag: the last message this actor dequeued. `last_val` is a
   * VALUE for a number message and a BORROWED pointer for a string/structured one — see
   * note_last / tag_forget for the ownership rule, and `last_released` for the moment
   * that borrow ends. */
  int         last_valid; NtPid last_from; int64_t last_val;
  int         last_released;           /* the owning frame has freed it: render no payload */
  /* ---- v1: reduction-counted preemption ---- */
  int64_t     reductions;              /* budget remaining this slice; refills to NT_CONTEXT_REDS */
  /* ---- v4: message kind + virtual-clock receive timeouts ---- */
  int         last_kind;               /* kind of the last dequeued message (crash record) */
  const char *last_shape;              /* v5: its shape, and how to render it, for the record */
  NtMsgRender last_render;
  int64_t     deadline;                /* virtual-ms deadline while BLOCKED (if has_deadline) */
  int         has_deadline;
  int         timed_out;               /* the scheduler fired this actor's deadline */
} NtActor;

typedef struct NtRqNode { NtPid pid; struct NtRqNode *next; } NtRqNode;

/* ---- v6: one scheduler per OS thread, each with its OWN run queue ---- */
#define NT_MAX_SCHED 64

typedef struct NtSched {
  int              index;
  pthread_mutex_t  lock;             /* guards this queue only (steals take it too) */
  NtRqNode        *head, *tail;
  ucontext_t       ctx;              /* this scheduler's own context */
  char            *stack;
  NT_FIBER_FIELD
  pthread_t        thread;
  _Atomic int      ran;              /* did this scheduler ever run an actor? (test hook) */
} NtSched;

/* ---- scheduler globals ---- */
static NtActor  *g_actors[NT_MAX_ACTORS];
static _Atomic int64_t g_nactors;
static NtActor  *g_main;            /* actor 0 (the program's main thread) */
static NtSched   g_scheds[NT_MAX_SCHED];
static int       g_nsched = 1;      /* resolved from NATIVETS_SCHED_THREADS; 1 = deterministic */
static int       g_mt;              /* g_nsched > 1: the M:N path is live */
/* OUTSTANDING WORK. Incremented BEFORE a pid is inserted into any run queue and
 * decremented only when that pid's slice ENDS without being re-queued — so it is never
 * transiently 0 while an actor is queued, being stolen, or executing. That invariant is
 * what lets `main` safely conclude, from another thread, that __drain() is complete. */
static _Atomic int64_t g_inflight;
static _Atomic int64_t g_steals;    /* work-stealing hits (test hook) */
static int             g_poll_fd = -1;   /* kqueue/epoll instance (lazily created) */
static _Atomic int64_t g_io_waiters;     /* actors parked WAITING on a file descriptor */

/* Per-OS-thread: which scheduler this thread drives, and which actor is on its stack.
 * `g_current` keeps its old name (every call site reads it fresh after a yield, which is
 * what makes actor MIGRATION across threads safe). */
static _Thread_local NtActor *g_current;
static _Thread_local NtSched *t_sched;

/* Quiescence: schedulers park here when they have nothing to run and nothing to steal. */
static pthread_mutex_t g_idle_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_idle_cv   = PTHREAD_COND_INITIALIZER;

/* The actor table + name registry are shared; spawn/register take this. */
static pthread_mutex_t g_tab_lock = PTHREAD_MUTEX_INITIALIZER;

/* ============================================================================
 * v6 — MAKING THE REST OF THE RUNTIME SOUND UNDER THREADS.
 *
 * runtime.c's string refcount side-table and nt_pvec.c's node refcounts are NOT
 * thread safe (Stage 30 and Stage 38 both say so). Under M:N they become genuinely
 * shared: an actor's values are private by construction (every message is DEEP-COPIED
 * on send, Stage 42) and immutable (Stage 29), but the *bookkeeping* — one global open-
 * addressed hash table that rehashes, and a node's `refcount` word — is common to all
 * scheduler threads, and Stage 44's transient (`rc == 1 ⇒ mutate in place`) is a
 * check-then-act that must not interleave with another thread's retain.
 *
 * So: those modules call through a HOOK, `nt_rt_lock`, which is NULL for every program
 * that is not running M:N — a predictable NULL test, no pthread dependency in runtime.c
 * (which must still cross-compile to wasm/Android), and byte-identical behaviour in the
 * default single-threaded mode. nt_sched_init installs it only when g_mt is set.
 * ========================================================================== */
extern void (*nt_rt_lock)(int);      /* defined in runtime.c; NULL unless M:N */
/* The other direction of the same arrangement: runtime.c announces every object/string
 * free through this, so a crash record's BORROWED causal tag can learn that its borrow
 * ended. Installed unconditionally at nt_sched_init (not just under M:N) — the tag is
 * borrowed in single-threaded programs too. See tag_forget. */
extern void (*nt_rt_drop_notify)(const void *);
static void tag_forget(const void *p);   /* defined with note_last, the borrow it ends */
static pthread_mutex_t g_rc_lock;    /* RECURSIVE: pvec's public entry points nest */
static void rc_lock_hook(int acquire) {
  if (acquire) pthread_mutex_lock(&g_rc_lock);
  else         pthread_mutex_unlock(&g_rc_lock);
}
static void rc_lock_init(void) {
  pthread_mutexattr_t at;
  pthread_mutexattr_init(&at);
  pthread_mutexattr_settype(&at, PTHREAD_MUTEX_RECURSIVE);
  pthread_mutex_init(&g_rc_lock, &at);
  pthread_mutexattr_destroy(&at);
}

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

/* ======================= run queues (FIFO, one per scheduler) ======================= */

/* Push onto scheduler `s`'s queue. With g_nsched == 1 this is exactly the old single
 * global FIFO — the deterministic schedule every v0..v5 test asserts is unchanged. */
static void rq_push_on(NtSched *s, NtPid pid) {
  NtRqNode *n = (NtRqNode *)malloc(sizeof(NtRqNode));
  n->pid = pid; n->next = NULL;
  atomic_fetch_add(&g_inflight, 1);        /* count it BEFORE it is visible to a thief */
  if (g_mt) pthread_mutex_lock(&s->lock);
  if (s->tail) s->tail->next = n; else s->head = n;
  s->tail = n;
  if (g_mt) pthread_mutex_unlock(&s->lock);
  if (g_mt) {                              /* a parked scheduler may now have work */
    pthread_mutex_lock(&g_idle_lock);
    pthread_cond_broadcast(&g_idle_cv);
    pthread_mutex_unlock(&g_idle_lock);
  }
}

/* Where does a wake land? On the queue of the scheduler that is doing the waking, so a
 * reply stays hot on the thread that produced it; off-scheduler callers (main before the
 * first drain) target scheduler 0. Single-threaded: always scheduler 0. */
static void rq_push(NtPid pid) { rq_push_on(t_sched ? t_sched : &g_scheds[0], pid); }

static int rq_pop_from(NtSched *s, NtPid *out) {
  int got = 0;
  if (g_mt) pthread_mutex_lock(&s->lock);
  NtRqNode *n = s->head;
  if (n) {
    s->head = n->next;
    if (!s->head) s->tail = NULL;
    *out = n->pid;
    got = 1;
  }
  if (g_mt) pthread_mutex_unlock(&s->lock);
  if (got) free(n);      /* g_inflight stays up: the pid is now RUNNING, still outstanding */
  return got;
}

/* WORK STEALING. An idle scheduler takes from the HEAD of a victim's queue — FIFO steal,
 * so the oldest (most likely to be cache-cold anyway) work migrates and the victim keeps
 * its recently-pushed, hot work. Victims are probed round-robin starting after self, so
 * N idle schedulers don't all hammer scheduler 0. */
static int rq_steal(NtSched *self, NtPid *out) {
  for (int k = 1; k < g_nsched; k++) {
    NtSched *v = &g_scheds[(self->index + k) % g_nsched];
    if (rq_pop_from(v, out)) { atomic_fetch_add(&g_steals, 1); return 1; }
  }
  return 0;
}

/* Take the next runnable pid for this scheduler: own queue first, then steal. */
static int rq_take(NtSched *s, NtPid *out) {
  if (rq_pop_from(s, out)) return 1;
  if (g_mt) return rq_steal(s, out);
  return 0;
}

/* ======================= mailbox (MPSC intake + private FIFO list) ======================= */

/* Reclaim the intake stack of an actor that is DEAD — defined with the other message
 * ownership code below (see mbox_discard), declared here for the producer's re-check. */
static void intake_discard(NtActor *a);

/* Producer side. Single-threaded: append straight to the owner's private list (the v0
 * path, bit-for-bit). M:N: CAS onto the lock-free intake stack; the owner drains it. */
static void mbox_push_kind(NtActor *a, NtMsg m, NtPid from,
                           int kind, const char *shape, NtMsgRender render) {
  NtMboxNode *n = (NtMboxNode *)malloc(sizeof(NtMboxNode));
  n->msg = m; n->from = from; n->kind = kind; n->next = NULL;
  n->shape = shape; n->render = render;
  if (!g_mt) {
    if (a->mbox_tail) a->mbox_tail->next = n; else a->mbox_head = n;
    a->mbox_tail = n;
    return;
  }
  NtMboxNode *h = atomic_load_explicit(&a->in_head, memory_order_relaxed);
  do { n->next = h; }
  while (!atomic_compare_exchange_weak_explicit(&a->in_head, &h, n,
                                                memory_order_release, memory_order_relaxed));
  /* PUBLISH, THEN RE-CHECK — the send half of the send-vs-die handoff, and the same
   * two-halves shape wake_actor/finish_slice use for the lost wakeup.
   *
   * Every send site checks "is the target DEAD?" BEFORE pushing, which under M:N is a
   * check-then-act: the target can die in the window, discard its mailbox, and never see
   * what lands afterwards. So the dier sets DEAD before it discards, and the sender
   * re-reads the status after its push. One of the two must observe the other (the
   * seq_cst fence pairs with the seq_cst store in actor_die), so a message pushed to a
   * dying actor is freed by whichever side saw it — never twice, since `intake_discard`
   * hands the whole batch to exactly one exchange winner.
   *
   * Measured before this half existed: 42 objects per 100 messages at 4 scheduler
   * threads and 497 per 1000, against a flat 0 single-threaded. */
  atomic_thread_fence(memory_order_seq_cst);
  if (atomic_load(&a->status) == NT_DEAD) intake_discard(a);
}

static void mbox_push_from(NtActor *a, NtMsg m, NtPid from) {
  mbox_push_kind(a, m, from, NT_MSG_NUM, NULL, NULL);
}

/* Consumer side, OWNER ONLY: move the intake batch onto the private list, restoring push
 * order (the intake is LIFO, so reverse it). Every mailbox reader calls this first. */
static void mbox_drain(NtActor *a) {
  if (!g_mt) return;
  NtMboxNode *batch = atomic_exchange_explicit(&a->in_head, NULL, memory_order_acquire);
  if (!batch) return;
  NtMboxNode *fifo = NULL;                     /* reverse: LIFO intake -> push order */
  while (batch) { NtMboxNode *nx = batch->next; batch->next = fifo; fifo = batch; batch = nx; }
  if (a->mbox_tail) a->mbox_tail->next = fifo; else a->mbox_head = fifo;
  while (fifo->next) fifo = fifo->next;
  a->mbox_tail = fifo;
}

/* Is there anything for `a` at all? Safe from the SCHEDULER while `a` is switched out
 * (no consumer is running), which is where the lost-wakeup re-check needs it. */
static int64_t mbox_count_of(NtActor *a);

/* The predicate an actor blocks on: "my mailbox holds MORE than the `wait_n` messages I
 * have already examined". Zero for a plain receive; the scanned count for a SELECTIVE
 * receive, whose save queue leaves earlier messages in place — which is precisely why
 * "mailbox non-empty" is the WRONG wake condition and would spin forever. Safe to call
 * from the scheduler while `a` is switched out: no consumer is running. */
static int mbox_ready(NtActor *a) {
  /* v6: a fd that became readable while we were SWITCHING wakes us just like a message
   * would — same lost-wakeup argument, different event source. */
  if (atomic_load(&a->io_ready)) return 1;
  return mbox_count_of(a) > a->wait_n;
}

static int mbox_empty(NtActor *a) { mbox_drain(a); return a->mbox_head == NULL; }

static NtMsg mbox_pop(NtActor *a) {
  NtMboxNode *n = a->mbox_head;
  a->mbox_head = n->next;
  if (!a->mbox_head) a->mbox_tail = NULL;
  NtMsg m = n->msg;
  free(n);
  return m;
}

/* ---- MESSAGE OWNERSHIP, and the one place it has no other answer ----
 *
 * A message has exactly one owner at every instant. `send` deep-copies it (strings here,
 * records/arrays in codegen) and HANDS THE COPY OVER: the sender's own local keeps the
 * ownership it had, and the copy's owner becomes the mailbox node. A `receive` /
 * `receiveMatch` that dequeues transfers that ownership on again, to the receiving frame,
 * whose ordinary scope-exit drop frees it — so the pop paths deliberately free the NODE
 * and never the payload. A message left in the SAVE QUEUE was never dequeued and is still
 * the mailbox's, which is exactly right.
 *
 * That leaves one path with no next owner: the actor DIES with messages still queued.
 * Nothing else can ever reach them (the pid is dead, so every later send is dropped at the
 * status check), and until now nothing freed them — a leak proportional to the traffic an
 * actor never got to, which is precisely the shape a supervised restart produces.
 *
 * Shallow by the same convention as everywhere else in this runtime: `nt_obj_free` frees
 * the record's own slot block and not what its slots point at (a documented, separate
 * issue), and a string payload is refcounted, so it is RELEASED rather than freed. */
static void msg_free(NtMsg m) {
  if (m.tag == NT_STR) { free(m.u.s); return; }
  if (m.tag == NT_LIST) {
    for (int64_t i = 0; i < m.u.list.len; i++) msg_free(m.u.list.items[i]);
    free(m.u.list.items);
  }
}

/* runtime.c: the object allocator's free, and the string refcount's release. Both are
 * NULL-safe, and both are what the OWNING FRAME would have called had the message been
 * delivered — this is the same free, at the only other place ownership can end. */
extern void nt_obj_free(void *o);
extern void nt_str_release(void *p);

static void mbox_node_free(NtMboxNode *n) {
  /* A non-INT tag is the C-level NtMsg carrier (nt_send / exit + DOWN signals), which owns
   * its own storage. An INT tag is a COMPILER message: the slot is the payload, and `kind`
   * says what it means. */
  if (n->msg.tag != NT_INT)               msg_free(n->msg);
  else if (n->kind == NT_MSG_STR)         nt_str_release((void *)(intptr_t)n->msg.u.i);
  else if (n->kind == NT_MSG_STRUCT)      nt_obj_free((void *)(intptr_t)n->msg.u.i);
  free(n);
}

/* Reclaim the LOCK-FREE INTAKE stack. Whoever wins the exchange owns that whole batch, so
 * two threads racing here can never free the same node — which is what lets both halves of
 * the publish-then-recheck below call it. NULL and free single-threaded (nothing is ever
 * pushed to the intake there). */
static void intake_discard(NtActor *a) {
  NtMboxNode *p = atomic_exchange(&a->in_head, NULL);
  while (p) { NtMboxNode *nx = p->next; mbox_node_free(p); p = nx; }
}

/* Reclaim everything still queued for an actor that will never read it again. Called ONLY
 * from actor_die, and only AFTER the status is DEAD — so no scheduler will swap into this
 * actor (scheduler_loop CASes RUNNABLE->RUNNING and skips it), and the private list below
 * has no other reader. */
static void mbox_discard(NtActor *a) {
  intake_discard(a);
  NtMboxNode *p = a->mbox_head;
  a->mbox_head = NULL;
  a->mbox_tail = NULL;
  while (p) { NtMboxNode *nx = p->next; mbox_node_free(p); p = nx; }
}

/* ======================= actors / scheduler ======================= */

static NtActor *actor_alloc(int with_stack) {
  NtActor *a = (NtActor *)calloc(1, sizeof(NtActor));
  a->reductions = NT_CONTEXT_REDS;    /* full budget for the first slice */
  a->stack = with_stack ? (char *)malloc(NT_STACK_SIZE) : NULL;
  atomic_store(&a->status, NT_RUNNING);
  /* Publish the actor BEFORE its pid becomes visible: a reader that sees the count sees a
   * fully-initialised actor (the release store on g_nactors is the publication edge). */
  if (g_mt) pthread_mutex_lock(&g_tab_lock);
  int64_t n = atomic_load_explicit(&g_nactors, memory_order_relaxed);
  a->pid = n;
  g_actors[n] = a;
  atomic_store_explicit(&g_nactors, n + 1, memory_order_release);
  if (g_mt) pthread_mutex_unlock(&g_tab_lock);
  return a;
}

/* Bounds-checked actor lookup (the table grows only at the tail, entries never move). */
static NtActor *actor_at(NtPid pid) {
  if (pid < 0 || pid >= atomic_load_explicit(&g_nactors, memory_order_acquire)) return NULL;
  return g_actors[pid];
}

/* v2: a normal body return is a NORMAL exit — it must still notify monitors and
 * (for a trapping peer) linked actors. Forward-declared; defined in the v2 block. */
static void actor_die(NtActor *a, int64_t reason, int abnormal);

/* Hand control back to the scheduler, declaring what we want to be next. The SWITCHING
 * state closes the M:N lost-wakeup / double-schedule race: while it is set no sender may
 * enqueue us (they CAS on BLOCKED only), and only the scheduler that regains control may
 * leave it — so nobody can swapcontext into a context we are still writing. */
static void switch_out(int next_status) {
  NtActor *a = g_current;
  a->next_status = next_status;
  atomic_store(&a->status, NT_SWITCHING);
  NT_FIBER_SWITCH(t_sched);
  swapcontext(&a->ctx, &t_sched->ctx);
}

/* actor entry trampoline: runs the body, marks the actor dead, returns to sched */
static void actor_trampoline(void) {
  NtActor *self = g_current;
  if (self->is_closure) self->centry(self->cenv, self->carg);  /* compiler ABI */
  else                  self->entry(self->entry_arg);          /* NtMsg ABI */
  actor_die(self, NT_REASON_NORMAL, 0);   /* normal exit: notify monitors/links */
  /* hand control back to the scheduler; we never resume */
  self = g_current;
  self->next_status = NT_DEAD;
  NT_FIBER_SWITCH(t_sched);
  swapcontext(&self->ctx, &t_sched->ctx);
}

/* v4: fire the earliest pending receive-timeout, if any. Called ONLY when the run
 * queue is empty — i.e. nothing runnable could still send us a message — so the
 * VIRTUAL clock advances only at quiescence. That makes timeouts deterministic (no
 * wall-clock sleeping, no flaky schedules) while preserving the semantics that
 * matter: a timeout fires exactly when no message can still arrive in time.
 * Ties break on the lowest pid, keeping the wake order a pure function of the program. */
static int64_t g_now_ms;                 /* virtual clock (ms since nt_sched_init) */
static int fire_earliest_timeout(void) {
  NtActor *best = NULL;
  int64_t n = atomic_load_explicit(&g_nactors, memory_order_acquire);
  for (int64_t i = 0; i < n; i++) {
    NtActor *a = g_actors[i];
    if (!a || atomic_load(&a->status) != NT_BLOCKED || !a->has_deadline) continue;
    if (!best || a->deadline < best->deadline) best = a;   /* `<` ⇒ lowest pid wins ties */
  }
  if (!best) return 0;
  if (best->deadline > g_now_ms) g_now_ms = best->deadline; /* jump the virtual clock */
  best->timed_out = 1;
  int exp = NT_BLOCKED;
  if (!atomic_compare_exchange_strong(&best->status, &exp, NT_RUNNABLE)) return 0;
  rq_push_on(&g_scheds[0], best->pid);
  return 1;
}

/* The whole system is idle: no pid queued anywhere and nobody executing. Under M:N this
 * is also the only safe moment to advance the VIRTUAL clock — a timeout may fire exactly
 * when nothing runnable could still send, which is the same rule v4 chose, so receive
 * timeouts keep their deterministic semantics in both modes. */
static int quiescent(void) { return atomic_load(&g_inflight) == 0; }

/* An actor just switched out. Publish the state it asked for. Leaving SWITCHING is OUR
 * exclusive right, so a sender that raced us either already flipped BLOCKED->RUNNABLE
 * (and enqueued) or it could not, in which case re-evaluating the block predicate here
 * catches it. Exactly one of the two enqueues wins: both go through the same CAS. */
static void finish_slice(NtSched *s, NtActor *a) {
  int ns = a->next_status;
  if (ns == NT_DEAD || atomic_load(&a->status) == NT_DEAD) {
    atomic_store(&a->status, NT_DEAD);
    return;
  }
  if (ns == NT_RUNNABLE) {                    /* preempted: back on the tail (round robin) */
    atomic_store(&a->status, NT_RUNNABLE);
    rq_push_on(s, a->pid);
    return;
  }
  atomic_store(&a->status, NT_BLOCKED);
  /* A send that landed while we were SWITCHING could not enqueue us (wake_actor CASes on
   * BLOCKED only), so re-evaluate the block predicate here — this half plus wake_actor's
   * half is what makes a lost wakeup impossible. Single-threaded nothing can arrive during
   * a switch, so this never fires and the v0..v5 schedule is untouched. */
  if (mbox_ready(a)) {
    int exp = NT_BLOCKED;
    if (atomic_compare_exchange_strong(&a->status, &exp, NT_RUNNABLE)) rq_push_on(s, a->pid);
  }
}

/* Park until somebody enqueues work (or a short timeout, so quiescence is always noticed
 * even if a broadcast was missed). M:N only — the single-threaded scheduler never waits. */
static void sched_park(void) {
  struct timespec ts;
#if defined(CLOCK_REALTIME)
  clock_gettime(CLOCK_REALTIME, &ts);
#else
  ts.tv_sec = time(NULL); ts.tv_nsec = 0;
#endif
  ts.tv_nsec += 200 * 1000;                    /* 200µs */
  if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
  pthread_mutex_lock(&g_idle_lock);
  pthread_cond_timedwait(&g_idle_cv, &g_idle_lock, &ts);
  pthread_mutex_unlock(&g_idle_lock);
}

/* ======================= v6: the async-IO poller ======================= */

static void wake_actor(NtActor *a);   /* defined with the other wake paths, below */

/* Park an actor on a FILE DESCRIPTOR instead of on its mailbox, and wake it when the
 * kernel says the fd is readable. This is the piece that stops one blocking read from
 * costing a whole scheduler thread: the actor leaves the run queue entirely (it is not
 * spinning, not holding a slice), the scheduler runs everyone else, and readiness — not a
 * timer — puts it back. Registrations are ONESHOT: one wait, one wake, re-armed by the
 * next nt_io_wait, which matches the "park until this specific read can proceed" shape.
 *
 * Only scheduler 0 polls, so there is exactly one kevent/epoll_wait caller and no
 * thundering herd; the other schedulers keep executing actors while it waits. */
static int poll_init(void) {
  if (g_poll_fd >= 0) return 1;
#if defined(NT_POLL_KQUEUE)
  g_poll_fd = kqueue();
#elif defined(NT_POLL_EPOLL)
  g_poll_fd = epoll_create1(0);
#endif
  return g_poll_fd >= 0;
}

static int poll_arm(int fd, NtActor *a) {
#if defined(NT_POLL_KQUEUE)
  struct kevent ev;
  EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, a);
  return kevent(g_poll_fd, &ev, 1, NULL, 0, NULL) >= 0;
#elif defined(NT_POLL_EPOLL)
  struct epoll_event ev;
  ev.events = EPOLLIN | EPOLLONESHOT;
  ev.data.ptr = a;
  if (epoll_ctl(g_poll_fd, EPOLL_CTL_ADD, fd, &ev) == 0) return 1;
  return epoll_ctl(g_poll_fd, EPOLL_CTL_MOD, fd, &ev) == 0;  /* already registered: re-arm */
#else
  (void)fd; (void)a; return 0;
#endif
}

/* Collect ready fds and make their actors runnable. `timeout_ms < 0` blocks until an event
 * (used only when the system is otherwise idle, so nothing is starved by waiting). */
static int poll_reap(int timeout_ms) {
  if (g_poll_fd < 0) return 0;
  int woke = 0;
#if defined(NT_POLL_KQUEUE)
  struct kevent evs[16];
  struct timespec ts, *tsp = NULL;
  if (timeout_ms >= 0) { ts.tv_sec = timeout_ms / 1000;
                         ts.tv_nsec = (long)(timeout_ms % 1000) * 1000000L; tsp = &ts; }
  int n = kevent(g_poll_fd, NULL, 0, evs, 16, tsp);
  for (int i = 0; i < n; i++) {
    NtActor *a = (NtActor *)evs[i].udata;
#elif defined(NT_POLL_EPOLL)
  struct epoll_event evs[16];
  int n = epoll_wait(g_poll_fd, evs, 16, timeout_ms);
  for (int i = 0; i < n; i++) {
    NtActor *a = (NtActor *)evs[i].data.ptr;
#else
  { int n = 0; (void)timeout_ms; NtActor *a = NULL;
#endif
    if (!a) continue;
    atomic_fetch_sub(&g_io_waiters, 1);
    a->wait_n = 0;
    atomic_store(&a->io_ready, 1);
    wake_actor(a);                 /* BLOCKED->RUNNABLE, or caught by finish_slice */
    woke++;
  }
  return woke;
}

/* Compiler/runtime entry point. Returns 1 when the fd is readable, 0 on EOF-ish wakeups,
 * and -1 when parking is not possible — no poller on this platform, or the caller is
 * `main` / off-scheduler, in which case the CALLER must keep its ordinary blocking read.
 * That -1 default is what keeps every existing non-actor program byte-identical. */
int32_t nt_io_wait(int32_t fd, double ms) {
  (void)ms;                        /* v6.4: readiness only; timeouts are a follow-up */
  NtActor *a = g_current;
  if (!a || a == g_main) return -1;
  if (!poll_init()) return -1;
  atomic_store(&a->io_ready, 0);
  if (!poll_arm((int)fd, a)) return -1;
  atomic_fetch_add(&g_io_waiters, 1);
  a->wait_n = INT64_MAX;           /* messages must NOT wake us: we are waiting on IO */
  switch_out(NT_BLOCKED);
  a = g_current;                   /* resumed, possibly on another scheduler thread */
  a->wait_n = 0;
  return atomic_exchange(&a->io_ready, 0) ? 1 : 0;
}

double nt_io_waiters(void) { return (double)atomic_load(&g_io_waiters); }

/* The scheduler: run RUNNABLE actors FIFO from our own queue, then steal. Scheduler 0
 * additionally owns the virtual clock and the idle-return to `main`. */
static void scheduler_loop(void) {
  NtSched *s = t_sched;
  for (;;) {
    NtPid pid;
    if (rq_take(s, &pid)) {
      NtActor *a = actor_at(pid);
      int exp = NT_RUNNABLE;
      if (!a || !atomic_compare_exchange_strong(&a->status, &exp, NT_RUNNING)) {
        atomic_fetch_sub(&g_inflight, 1);      /* stale entry (dead / already taken) */
        continue;
      }
      atomic_store(&s->ran, 1);
      g_current = a;
      NT_FIBER_SWITCH(a);
      swapcontext(&s->ctx, &a->ctx);           /* run until it yields/dies */
      a = g_current;                           /* (unchanged; re-read for clarity) */
      finish_slice(s, a);                      /* may re-queue it (another +1) */
      g_current = NULL;
      atomic_fetch_sub(&g_inflight, 1);        /* this slice is done */
      continue;
    }
    if (s->index != 0) { sched_park(); continue; }   /* workers only ever run actors */
    /* Scheduler 0: nothing local. Wait for true system-wide quiescence before deciding. */
    if (g_mt && !quiescent()) {
      if (atomic_load(&g_io_waiters) > 0) poll_reap(0);   /* never block while others run */
      sched_park();
      continue;
    }
    /* Idle but an actor is parked on a fd: the program is NOT finished, so block in the
     * poller until the kernel reports readiness. This is the whole point of the poller —
     * the wait costs no scheduler slice and no busy loop. */
    if (atomic_load(&g_io_waiters) > 0) { poll_reap(-1); continue; }
    if (fire_earliest_timeout()) continue;     /* v4: quiescent ⇒ a timeout is now due */
    /* Fully idle: resume whoever entered the scheduler (main). */
    g_current = g_main;
    atomic_store(&g_main->status, NT_RUNNING);
    NT_FIBER_SWITCH(g_main);
    swapcontext(&s->ctx, &g_main->ctx);
  }
}

/* yield the current actor back to its scheduler context, staying RUNNABLE-after. */
static void yield_to_sched(void) { switch_out(NT_BLOCKED); }

/* Post-send wakeup. The message is already in the mailbox, so the ONLY thing left is the
 * BLOCKED->RUNNABLE edge — a CAS, because under M:N the receiver may be concurrently
 * deciding to block. If it is mid-switch we cannot enqueue it (its context is still being
 * saved) — finish_slice re-checks the block predicate and does it instead. Those two halves
 * are why a lost wakeup is impossible from either side. */
static void wake_actor(NtActor *a) {
  int exp = NT_BLOCKED;
  if (atomic_compare_exchange_strong(&a->status, &exp, NT_RUNNABLE)) rq_push(a->pid);
  /* Not BLOCKED: either it is still RUNNING (it will see the message when it checks its
   * mailbox before blocking) or SWITCHING (finish_slice re-checks). Either way the message
   * is already queued, so the block predicate covers us — nothing more to do here. */
}

/* ======================= v1: reduction-counted preemption ======================= */

/* The compiler-emitted safepoint. Codegen calls this at every function-call site and
 * loop back-edge, so a long compute loop or deep recursion decrements a budget and,
 * when exhausted, cooperatively yields — the running actor is re-enqueued at the run-
 * queue TAIL and the scheduler runs the next actor (fairness / no starvation).
 *
 * Cheap by design: for the common case it is a load + decrement + branch + store.
 * A no-op unless a spawned actor is currently running: main (actor 0) is the driver
 * and is never preempted, and off-scheduler code (g_current == NULL, i.e. before
 * nt_sched_init) returns immediately — so non-actor execution is behaviorally
 * unchanged. On exhaustion the budget refills to NT_CONTEXT_REDS for the next slice. */
void nt_reduction_tick(void) {
  NtActor *a = g_current;
  if (!a || a == g_main) return;        /* not a preemptible actor: no-op */
  /* v6: a kill aimed at us while we were RUNNING on this thread is reaped here — the one
   * place where stopping is safe, because it is our own stack. No-op single-threaded. */
  if (g_mt && atomic_load_explicit(&a->kill_req, memory_order_relaxed)) {
    long r = atomic_exchange(&a->kill_req, 0);
    if (r) nt_crash((int64_t)r);          /* does not return */
  }
  if (--a->reductions > 0) return;       /* budget remains: keep running */
  a->reductions = NT_CONTEXT_REDS;       /* refill for our next slice */
  switch_out(NT_RUNNABLE);               /* re-enqueued at the tail by our scheduler */
}

/* ======================= v6: scheduler threads ======================= */

/* A worker thread: bind it to its scheduler and run scheduler_loop on that scheduler's
 * own context. Workers never idle-return to main (only scheduler 0 owns that edge), so
 * this call does not return until the process exits. */
static void *sched_thread_main(void *arg) {
  NtSched *s = (NtSched *)arg;
  t_sched = s;
  g_current = NULL;
  getcontext(&s->ctx);
  s->ctx.uc_stack.ss_sp = s->stack;
  s->ctx.uc_stack.ss_size = NT_STACK_SIZE;
  s->ctx.uc_link = NULL;
  makecontext(&s->ctx, scheduler_loop, 0);
  NT_FIBER_NEW(s);
  ucontext_t here;                        /* park this thread's native context; never resumed */
  NT_FIBER_SWITCH(s);
  swapcontext(&here, &s->ctx);
  return NULL;
}

/* How many scheduler threads? NATIVETS_SCHED_THREADS: unset or 1 -> the DETERMINISTIC
 * single-threaded scheduler (the default, and what every v0..v5 behavioral test asserts);
 * "auto" -> one per core; N -> exactly N. Opting in is the whole determinism contract:
 * true parallelism destroys byte-stable interleavings, so it is never the default. */
static int resolve_nsched(void) {
  const char *e = getenv("NATIVETS_SCHED_THREADS");
  if (!e || !*e) return 1;
  if (strcmp(e, "auto") == 0) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return (int)(n < 1 ? 1 : (n > NT_MAX_SCHED ? NT_MAX_SCHED : n));
  }
  long n = strtol(e, NULL, 10);
  if (n < 1) n = 1;
  if (n > NT_MAX_SCHED) n = NT_MAX_SCHED;
  return (int)n;
}

double nt_schedulers(void)   { return (double)g_nsched; }
double nt_sched_steals(void) { return (double)atomic_load(&g_steals); }
double nt_sched_used(void) {                 /* how many schedulers actually ran an actor */
  int used = 0;
  for (int i = 0; i < g_nsched; i++) if (atomic_load(&g_scheds[i].ran)) used++;
  return (double)used;
}

/* Scheduler THREADS are created exactly once per process (see nt_sched_init). */
static int g_threads_started;

void nt_sched_init(void) {
  /* Fresh actor state each init so test cases are independent (never-free: we leak the
   * previous run's actors/queues, which is fine for v0).
   *
   * RE-INIT IS DELICATE ONCE THREADS EXIST. The v0..v5 version rebuilt the scheduler
   * wholesale on every call, which was harmless with no threads. Under M:N it is a
   * use-after-free: the worker threads from the previous init are still alive and running
   * scheduler_loop on these very NtSched structs, so memsetting them wipes the `index` a
   * live worker is using (making it believe it is scheduler 0 and resume `main`'s ucontext
   * from the WRONG OS THREAD — an instant SIGBUS/SIGSEGV), reinitializes a mutex it may
   * hold, and swaps out the stack it is executing on. Measured: ~2/60 crashes with two
   * inits, 0/60 with one. So the threads and their structs are built ONCE and only the
   * per-run state is reset below.
   *
   * PRECONDITION for a repeat call: the previous run reached quiescence (i.e. nt_drain
   * returned). That holds for the C test harnesses, which are the only repeat callers —
   * a COMPILED program calls this exactly once, from @main's prologue. */
  if (!g_threads_started) {
    g_nsched = resolve_nsched();
    g_mt = g_nsched > 1;
    if (g_mt) { rc_lock_init(); nt_rt_lock = rc_lock_hook; } /* RC safety under M:N */
    /* UNCONDITIONAL, unlike the lock hook above: a crash record's causal tag borrows the
     * consumed message at one scheduler thread just as much as at eight. */
    nt_rt_drop_notify = tag_forget;
    for (int i = 0; i < g_nsched; i++) {
      NtSched *s = &g_scheds[i];
      memset(s, 0, sizeof(*s));
      s->index = i;
      pthread_mutex_init(&s->lock, NULL);
      s->stack = (char *)malloc(NT_STACK_SIZE);
    }
  } else {
    /* Repeat init: leave every NtSched (and every live worker) alone; just drop whatever
     * is left in the run queues. Taking each lock keeps this safe against a worker that is
     * concurrently probing for work to steal. */
    for (int i = 0; i < g_nsched; i++) {
      NtSched *s = &g_scheds[i];
      pthread_mutex_lock(&s->lock);
      NtRqNode *n = s->head;
      while (n) { NtRqNode *nx = n->next; free(n); n = nx; }
      s->head = s->tail = NULL;
      pthread_mutex_unlock(&s->lock);
    }
  }

  atomic_store(&g_nactors, 0);
  g_nreg = 0;
  g_now_ms = 0;                            /* v4: virtual clock starts at 0 */
  atomic_store(&g_inflight, 0);
  atomic_store(&g_steals, 0);
  atomic_store(&g_io_waiters, 0);

  t_sched = &g_scheds[0];                   /* the program's own thread drives scheduler 0 */

  g_main = actor_alloc(/*with_stack=*/0);   /* actor 0 uses the native/main stack */
  g_current = g_main;
  NT_FIBER_HERE(g_main);                    /* main runs on the process's own fiber */

  /* Scheduler 0's context is only ever run by THIS thread, and this thread is here rather
   * than inside scheduler_loop, so rebuilding it is safe even on a repeat init. */
  getcontext(&g_scheds[0].ctx);
  g_scheds[0].ctx.uc_stack.ss_sp = g_scheds[0].stack;
  g_scheds[0].ctx.uc_stack.ss_size = NT_STACK_SIZE;
  g_scheds[0].ctx.uc_link = NULL;           /* scheduler_loop never returns */
  makecontext(&g_scheds[0].ctx, scheduler_loop, 0);
  NT_FIBER_NEW(&g_scheds[0]);

  if (!g_threads_started) {
    for (int i = 1; i < g_nsched; i++)      /* the M:N workers (none when g_nsched == 1) */
      pthread_create(&g_scheds[i].thread, NULL, sched_thread_main, &g_scheds[i]);
    g_threads_started = 1;
  }
}

NtPid nt_spawn(NtActorFn body, NtMsg arg) {
  NtActor *a = actor_alloc(/*with_stack=*/1);
  a->entry = body;
  a->entry_arg = msg_deepcopy(arg);          /* isolate the spawn arg too */
  atomic_store(&a->status, NT_RUNNABLE);

  getcontext(&a->ctx);
  a->ctx.uc_stack.ss_sp = a->stack;
  a->ctx.uc_stack.ss_size = NT_STACK_SIZE;
  a->ctx.uc_link = NULL;                     /* the trampoline always swaps out explicitly */
  makecontext(&a->ctx, actor_trampoline, 0);
  NT_FIBER_NEW(a);

  rq_push(a->pid);
  return a->pid;
}

void nt_send(NtPid to, NtMsg msg) {
  NtActor *a = actor_at(to);
  if (!a || atomic_load(&a->status) == NT_DEAD) return;  /* unknown/dead pid: drop (BEAM-ish) */
  mbox_push_from(a, msg_deepcopy(msg), g_current ? g_current->pid : -1); /* deep-copy on send */
  wake_actor(a);
}

NtMsg nt_receive(void) {
  NtActor *a = g_current;
  while (mbox_empty(a)) {
    a->wait_n = 0;                            /* block until ANY message is queued */
    yield_to_sched();                         /* scheduler runs others; wakes us */
    a = g_current;                            /* same actor, possibly on another thread */
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
  /* v6: shared across scheduler threads (a supervisor re-registers a restarted child from
   * whichever thread ran it, while other actors look names up). Same lock as the table. */
  if (g_mt) pthread_mutex_lock(&g_tab_lock);
  for (int i = 0; i < g_nreg; i++) {
    if (strcmp(g_reg[i].name, name) == 0) {
      g_reg[i].pid = pid;
      { NtActor *t = actor_at(pid); if (t) t->name = g_reg[i].name; }
      if (g_mt) pthread_mutex_unlock(&g_tab_lock);
      return;
    }
  }
  if (g_nreg >= NT_MAX_REG) { if (g_mt) pthread_mutex_unlock(&g_tab_lock); return; }
  size_t n = strlen(name);
  g_reg[g_nreg].name = (char *)malloc(n + 1);
  memcpy(g_reg[g_nreg].name, name, n + 1);
  g_reg[g_nreg].pid = pid;
  { NtActor *t = actor_at(pid); if (t) t->name = g_reg[g_nreg].name; }
  g_nreg++;
  if (g_mt) pthread_mutex_unlock(&g_tab_lock);
}

NtPid nt_whereis(const char *name) {
  NtPid found = 0;                            /* 0 == absent (pid 0 is never registered) */
  if (g_mt) pthread_mutex_lock(&g_tab_lock);
  for (int i = 0; i < g_nreg; i++)
    if (strcmp(g_reg[i].name, name) == 0) { found = g_reg[i].pid; break; }
  if (g_mt) pthread_mutex_unlock(&g_tab_lock);
  return found;
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
  atomic_store(&a->status, NT_RUNNABLE);

  getcontext(&a->ctx);
  a->ctx.uc_stack.ss_sp = a->stack;
  a->ctx.uc_stack.ss_size = NT_STACK_SIZE;
  a->ctx.uc_link = NULL;
  makecontext(&a->ctx, actor_trampoline, 0);
  NT_FIBER_NEW(a);

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

static _Atomic int64_t g_mon_ref = 1;         /* monotonic monitor-ref allocator */
static void actor_die(NtActor *a, int64_t reason, int abnormal);

/* Build an exit/down notification message NT_LIST [from_pid, reason]. */
static NtMsg exit_msg(NtPid from, int64_t reason) {
  NtMsg items[2] = { nt_int((int64_t)from), nt_int(reason) };
  return nt_list(items, 2);
}

static void deliver_to(NtActor *peer, NtPid from, int64_t reason) {
  if (atomic_load(&peer->status) == NT_DEAD) return;
  mbox_push_from(peer, exit_msg(from, reason), from);
  wake_actor(peer);
}

/* The triggering message — the last message this actor dequeued, printed in the
 * message's own KIND (v4: numbers and strings). This is the causal tag that makes a
 * crash record actionable: "which message killed it". */
static void print_triggering_message(NtActor *a) {
  if (!a || !a->last_valid) {
    fprintf(stderr, "triggering-message:  (none — external signal)\n");
    return;
  }
  fprintf(stderr, "triggering-message:\n    from pid=%lld\n", (long long)a->last_from);
  if (a->last_released) {
    /* The tag borrowed the payload and the borrow has ended (tag_forget): the receiving
     * frame dropped this message before the actor died, so it did not trigger anything —
     * the actor was between messages and something external killed it. Everything still
     * printed here is a value (the origin pid) or a static string (the shape); the
     * payload is neither, so it is NAMED as gone rather than rendered from freed memory.
     * Printing less, and all of it true, is the whole job of this record. */
    fprintf(stderr, "    <consumed and released — the actor was between messages>\n");
    if (a->last_kind == NT_MSG_STRUCT)
      fprintf(stderr, "    (shape %s)\n", a->last_shape ? a->last_shape : "?");
    return;
  }
  if (a->last_kind == NT_MSG_STRUCT) {
    /* v5: a structured message is rendered by a codegen-emitted JSON walk for THIS
     * shape (the runtime cannot walk a slot block on its own), so the record still
     * answers "which message killed it" for records and arrays. */
    char *r = a->last_render ? a->last_render(a->last_val) : NULL;
    fprintf(stderr, "    %s\n", r ? r : "<structured>");
    fprintf(stderr, "    (shape %s)\n", a->last_shape ? a->last_shape : "?");
  } else if (a->last_kind == NT_MSG_STR) {
    const char *s = (const char *)(intptr_t)a->last_val;
    fprintf(stderr, "    \"%s\"\n", s ? s : "");
  } else {
    double mv; memcpy(&mv, &a->last_val, sizeof(mv)); /* number msg = double bits */
    char nb[64];
    nt_num_to_buf(mv, nb, sizeof(nb)); /* JS Number::toString, not printf's %g */
    fprintf(stderr, "    %s\n", nb);
  }
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
  print_triggering_message(a);
  fprintf(stderr, "seed:         NATIVETS_SCHED_SEED=%s\n", seed ? seed : "(unset)");
  fprintf(stderr,
    "========================================================================\n");
}

/* An actor dies: notify monitors (always, with reason) and propagate along links
 * (abnormal kills a non-trapping peer; a trapping peer gets a message instead;
 * a normal exit does not kill a linked non-trapping peer). Idempotent on DEAD. */
static void actor_die(NtActor *a, int64_t reason, int abnormal) {
  if (atomic_load(&a->status) == NT_DEAD) return;
  /* v6: an actor RUNNING on ANOTHER scheduler thread cannot be torn down from here — its
   * registers are live on that thread's CPU. Record the kill and let it reap itself at its
   * next compiler-emitted safepoint (nt_reduction_tick), which is BEAM's discipline too.
   * Single-threaded, or for the actor's own stack, the old immediate path is unchanged. */
  if (g_mt && a != g_current && atomic_load(&a->status) == NT_RUNNING) {
    atomic_store(&a->kill_req, (long)(reason ? reason : 1));
    return;
  }
  atomic_store(&a->status, NT_DEAD);

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
    NtActor *peer = actor_at(pp);
    if (!peer || atomic_load(&peer->status) == NT_DEAD) continue;
    if (peer->trap_exit)      deliver_to(peer, a->pid, reason); /* survives; gets msg */
    else if (abnormal)        actor_die(peer, reason, 1);       /* cascade the exit */
    /* normal exit to a non-trapping linked peer: ignored (peer keeps running). */
  }

  /* Everything still queued has no next owner — see mbox_discard. Last, so the crash
   * record and every signal above have already been emitted from a fully intact actor. */
  mbox_discard(a);
}

void nt_link(NtPid other) {
  NtActor *b = actor_at(other);
  if (!b) return;
  NtActor *a = g_current;
  if (a->nlinks < NT_MAX_LINKS) a->links[a->nlinks++] = other;
  if (b->nlinks < NT_MAX_LINKS) b->links[b->nlinks++] = a->pid;
}

int64_t nt_monitor(NtPid target) {
  int64_t ref = atomic_fetch_add(&g_mon_ref, 1);
  NtActor *t = actor_at(target);
  if (!t) return ref;
  if (atomic_load(&t->status) == NT_DEAD) {   /* monitoring a dead pid fires at once */
    deliver_to(g_current, target, NT_REASON_NORMAL);
    return ref;
  }
  if (t->nmons < NT_MAX_MONS) { t->monitors[t->nmons].watcher = g_current->pid;
                                t->monitors[t->nmons].ref = ref; t->nmons++; }
  return ref;
}

void nt_trap_exit(int on) { g_current->trap_exit = on ? 1 : 0; }

void nt_actor_exit(NtPid target, int64_t reason) {
  NtActor *t = actor_at(target);
  if (!t || atomic_load(&t->status) == NT_DEAD) return;
  int abnormal = (reason != NT_REASON_NORMAL);
  if (t->trap_exit)   deliver_to(t, g_current ? g_current->pid : -1, reason);
  else if (abnormal)  actor_die(t, reason, 1);
  /* normal exit to a non-trapping actor: ignored. */
}

void nt_crash(int64_t reason) {
  NtActor *self = g_current;
  actor_die(self, reason ? reason : 1, 1);    /* reason 0 would be "normal"; force abnormal */
  switch_out(NT_DEAD);                         /* never resumes — coroutine abandoned */
}

void nt_kill(NtPid target) {
  NtActor *t = actor_at(target);
  if (!t) return;
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
  if (g_mt) pthread_mutex_lock(&g_tab_lock);
  int h = g_nsups++;
  if (g_mt) pthread_mutex_unlock(&g_tab_lock);
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
  { NtActor *ch = actor_at(pid); if (ch) ch->supervised = 1; }
  nt_link(pid);                               /* supervisor links each child */
  nt_register(c->id, pid);                    /* whereis(id) tracks the current pid */
  return pid;
}

/* ONE structured record per supervised crash: who died (the DEAD pid + its id), why,
 * the message that triggered it (v4), the supervisor, and the restart decision. */
static void emit_sup_record(NtSup *s, NtChild *c, NtPid dead, int64_t reason, const char *decision) {
  const char *seed = getenv("NATIVETS_SCHED_SEED");
  fprintf(stderr,
    "=== nativets actor crash ===============================================\n");
  fprintf(stderr, "actor:        pid=%lld name=\"%s\"\n", (long long)dead, c->id);
  if (reason == NT_REASON_KILL) fprintf(stderr, "reason:       killed (brutal __kill)\n");
  else fprintf(stderr, "reason:       abnormal exit (code=%lld)\n", (long long)reason);
  print_triggering_message(actor_at(dead));
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
      emit_sup_record(s, c, dead, reason, "NO RESTART (normal/temporary child)");
      continue;
    }
    if (intensity_exceeded(s)) {
      emit_sup_record(s, c, dead, reason,
        "INTENSITY EXCEEDED — supervisor exiting :shutdown");
      /* terminate remaining children, then the supervisor exits :shutdown. */
      for (int i = 0; i < s->nchildren; i++) {
        NtActor *ch = actor_at(s->children[i].pid);
        if (ch) actor_die(ch, NT_REASON_KILL, 1);
      }
      actor_die(me, NT_REASON_NORMAL /*:shutdown, not a crash*/, 0);
      switch_out(NT_DEAD);                     /* supervisor is done */
      return;
    }
    record_restart(s);
    NtPid np = sup_start_child(c);
    emit_sup_record(s, c, dead, reason, "RESTART (one_for_one)");
    (void)np;
  }
}

NtPid nt_sup_start(int64_t handle) {
  NtSup *s = &g_sups[handle];
  return nt_spawn_closure((NtClosureFn)sup_body, (void *)s, 0);
}

/* ============================================================================
 * v4 — selective receive + save queue, receive timeouts, string messages.
 *
 * Three additions, all driven from codegen (see src/codegen.ts):
 *
 *  1. TYPED slots. Every compiler-sent message carries a KIND (number / string).
 *     A receive is compiled for one kind; a mismatch is a hard runtime error
 *     (reject-don't-miscompile) rather than reinterpreting a pointer as a double.
 *  2. DEEP COPY on send for strings. The receiver must never alias the sender's
 *     string, so nt_send_typed copies it into a fresh allocation registered in
 *     runtime.c's refcount side-table at rc=1 — the receiving local then owns it
 *     and releases it at scope exit, exactly like any other produced string.
 *  3. SELECTIVE receive. The mailbox is a list, not just a queue: codegen scans it
 *     (peek kind/slot, apply the TS predicate, take the first match) and everything
 *     that did not match simply STAYS in place, in order — the OTP save queue,
 *     restored for the next receive by construction. Messages that arrive during a
 *     scan land at the tail and are picked up by the next pass (the scan resumes at
 *     the first not-yet-examined index, exactly like BEAM's save-queue restart).
 * ========================================================================== */

extern void nt_str_register(void *p);    /* runtime.c: join the string RC table at rc=1 */

static _Thread_local int g_timed_out;    /* did the last receive / mailbox wait time out? */

/* Both of these are OWNER-side views of the mailbox, so they drain the lock-free intake
 * first: under M:N a message posted by another scheduler thread lives there until its
 * owner (or, while the owner is switched out, its scheduler) pulls the batch across.
 * No-op single-threaded, where senders append to the private list directly. */
static int64_t mbox_count_of(NtActor *a) {
  mbox_drain(a);
  int64_t n = 0;
  for (NtMboxNode *p = a->mbox_head; p; p = p->next) n++;
  return n;
}

static NtMboxNode *mbox_at(NtActor *a, int64_t i) {
  mbox_drain(a);
  NtMboxNode *p = a->mbox_head;
  while (p && i-- > 0) p = p->next;
  return p;
}

/* The raw 8-byte slot a TS receive should see for this node. An exit/DOWN signal is
 * an NT_LIST [pid, reason]; v0-compatibly it surfaces as the dead peer's pid encoded
 * as double bits (see nt_receive_slot). Ordinary messages carry their slot verbatim. */
static int64_t node_slot(NtMboxNode *n) {
  if (n->msg.tag == NT_LIST && n->msg.u.list.len >= 1) {
    double d = (double)n->msg.u.list.items[0].u.i;
    int64_t bits; memcpy(&bits, &d, sizeof(bits));
    return bits;
  }
  return n->msg.u.i;
}
static int node_kind(NtMboxNode *n) {
  return (n->msg.tag == NT_LIST) ? NT_MSG_NUM : n->kind;   /* signals are numbers */
}

static const char *kind_name(int k) {
  return k == NT_MSG_STR ? "string" : k == NT_MSG_STRUCT ? "structured" : "number";
}

/* A receive compiled for kind X met a message of kind Y. There is no sound way to
 * continue (the bits mean different things), so fail loudly instead of miscompiling. */
static void kind_mismatch(int got, int want) {
  fprintf(stderr,
    "nativets: actor pid=%lld received a %s message but this receive expects %s\n"
    "  (actor messages are statically typed: annotate the receive, e.g. "
    "`const m: string = receive()`)\n",
    (long long)(g_current ? g_current->pid : -1), kind_name(got), kind_name(want));
  exit(70);
}

/* v5: same discipline one level finer. Both sides are structured, but a slot alone
 * cannot tell two record types apart — so the SHAPE travels with the message and a
 * receive compiled for another shape stops here instead of reading the wrong slots. */
static void shape_mismatch(const char *got, const char *want) {
  fprintf(stderr,
    "nativets: actor pid=%lld received a structured message of shape\n"
    "    %s\n"
    "  but this receive expects\n"
    "    %s\n"
    "  (actor messages are statically typed: annotate the receive with the shape the\n"
    "   sender sends, e.g. `const m: { kind: string, n: number } = receive()`)\n",
    (long long)(g_current ? g_current->pid : -1), got ? got : "?", want ? want : "?");
  exit(70);
}

/* Deep-copy a string message so the receiver cannot alias the sender's buffer. */
static int64_t copy_str_slot(int64_t slot) {
  const char *s = (const char *)(intptr_t)slot;
  if (!s) return 0;
  size_t n = strlen(s);
  char *d = (char *)malloc(n + 1);
  memcpy(d, s, n + 1);
  nt_str_register(d);        /* rc=1: the receiving local becomes the owner */
  return (int64_t)(intptr_t)d;
}

/* v5: the STRING leaf of codegen's structured deep-copy walk. A record's strings must
 * be copied too, or the receiver's private object would still point into the sender's
 * (refcounted, releasable) buffer — the copy joins the RC table at rc=1. */
char *nt_msg_str_copy(const char *s) {
  return (char *)(intptr_t)copy_str_slot((int64_t)(intptr_t)s);
}

/* Record the causal tag (triggering message) used by the crash record.
 *
 * THE OWNERSHIP RULE, and it is a BORROW — deliberately, because the alternatives are
 * worse. Consuming a message is exactly what transfers it to the receiving frame (the
 * pop frees the mailbox NODE and never the payload), so this tag cannot own it: the
 * frame does, and its scope-exit drop is what frees it. The tag therefore borrows, and
 * `tag_forget` below ends the borrow at the drop.
 *
 * WHY NOT OWN A COPY. Three cheaper-looking answers were weighed and rejected:
 *   - RETAIN it — strings are refcounted so `nt_str_retain` would work, but objects have
 *     no refcount at all, so this cannot cover the structured case that matters most.
 *   - SHALLOW-COPY the slot block — sound ONLY because `nt_obj_free` never walks slots,
 *     i.e. only because the shallow-free leak leaves the string slots alive. That makes
 *     this diagnostic's soundness depend on an open bug staying unfixed, and turns the
 *     day someone fixes it into a silent use-after-free. Not a trade worth making.
 *   - RENDER to a string at consume time — sound, but it runs the codegen JSON walk and
 *     allocates on EVERY receive, taxing the hot path of every actor system for a record
 *     that most runs never print.
 *
 * And the borrow is not merely the cheapest option, it is the most TRUTHFUL one. The tag
 * answers "which message killed it". While the receiving frame still holds the message —
 * the actor throwing or `__crash`ing mid-iteration — that question has an answer, the
 * pointer is live, and the record prints it in full. Once the frame has dropped it the
 * actor was BETWEEN messages, so anything that kills it now (an external `__kill`, a
 * link) was not triggered by that message at all: rendering it would be both a
 * use-after-free and a false causal claim. Ending the borrow makes the record say so. */
static void note_last(NtActor *a, NtMboxNode *n) {
  a->last_valid = 1;
  a->last_released = 0;          /* a fresh borrow: the receiving frame owns it now */
  a->last_from = n->from;
  a->last_val = node_slot(n);
  a->last_kind = node_kind(n);
  a->last_shape = n->shape;      /* v5: NULL for number/string messages */
  a->last_render = n->render;
}

/* THE END OF THE BORROW. runtime.c calls this from nt_obj_free / nt_str_release just
 * before it frees, so a tag pointing at that payload stops rendering it.
 *
 * Only a STRING or STRUCTURED tag is a pointer; a number message's `last_val` is the
 * double's bits — a value, never freed — and is excluded here so that a heap address
 * that happens to equal some number's bit pattern can never blank a valid tag.
 *
 * No ABA: the tag is cleared at the free itself, so the address is already disowned
 * before the allocator can hand it out again. Cheap enough for the free path — a
 * thread-local read and two compares, and it is not reached at all in a program that
 * never calls nt_sched_init.
 *
 * It consults the RUNNING actor, which is the one whose frame owns the message: the
 * receive transferred it to that frame and `send` deep-copies, so no other actor holds a
 * pointer to it. An object smuggled between actors through a shared global would fall
 * outside this check — but it would also already be outside the actor isolation
 * guarantee that makes messages deep-copied in the first place. */
static void tag_forget(const void *p) {
  NtActor *a = g_current;
  if (!a || !a->last_valid || a->last_released) return;
  if (a->last_kind != NT_MSG_STRUCT && a->last_kind != NT_MSG_STR) return;
  if ((const void *)(intptr_t)a->last_val != p) return;
  a->last_released = 1;
}

/* Block the current actor until its mailbox holds MORE than `n` messages, or the
 * (virtual) deadline expires. Returns 1 if messages are available, 0 on timeout.
 * `after 0` (ms <= 0) polls without ever blocking, matching Erlang. */
static int wait_for_more(int64_t n, double ms, int has_timeout) {
  NtActor *a = g_current;
  if (mbox_count_of(a) > n) return 1;
  if (has_timeout && ms <= 0) return 0;
  if (has_timeout) { a->has_deadline = 1; a->deadline = g_now_ms + (int64_t)ms; }
  for (;;) {
    a->timed_out = 0;
    a->wait_n = n;                          /* v6: the predicate our scheduler re-checks */
    yield_to_sched();                       /* scheduler runs others / fires timeouts */
    a = g_current;                          /* same actor, possibly on another thread */
    if (mbox_count_of(a) > n) { a->has_deadline = 0; return 1; }
    if (a->timed_out) { a->has_deadline = 0; a->timed_out = 0; return 0; }
  }
}

/* ---- compiler entry points ---- */

/* spawn with a typed argument (a string arg is deep-copied like a sent message). */
NtPid nt_spawn_typed(NtClosureFn body, void *env, int64_t slot, int64_t kind) {
  return nt_spawn_closure(body, env, kind == NT_MSG_STR ? copy_str_slot(slot) : slot);
}

void nt_send_typed(NtPid to, int64_t slot, int64_t kind) {
  NtActor *a = actor_at(to);
  if (!a || atomic_load(&a->status) == NT_DEAD) return;  /* unknown/dead pid: drop */
  int64_t payload = (kind == NT_MSG_STR) ? copy_str_slot(slot) : slot;
  mbox_push_kind(a, nt_int(payload), g_current ? g_current->pid : -1, (int)kind, NULL, NULL);
  wake_actor(a);
}

/* Blocking / timed FIFO receive of a message of kind `kind`. On timeout returns 0
 * and sets the timed-out flag (codegen reads it via nt_recv_timed_out). */
int64_t nt_recv_timed(int64_t kind, double ms, int32_t has_timeout) {
  g_timed_out = 0;
  if (!wait_for_more(0, ms, has_timeout)) { g_timed_out = 1; return 0; }
  NtActor *a = g_current;
  NtMboxNode *h = a->mbox_head;
  if (node_kind(h) != (int)kind) kind_mismatch(node_kind(h), (int)kind);
  note_last(a, h);
  int64_t slot = node_slot(h);
  mbox_pop(a);
  return slot;
}

int32_t nt_recv_timed_out(void) { return g_timed_out; }

/* ---- v5: structured messages ---- */

/* Enqueue a structured message. The payload was ALREADY deep-copied by the caller
 * (codegen emits the type-driven clone before this call — the runtime has no type
 * information to walk a slot block), so this just carries the private copy plus its
 * shape and renderer. Wake logic is shared with every other send. */
void nt_send_struct(NtPid to, int64_t slot, const char *shape, void *render) {
  NtActor *a = actor_at(to);
  if (!a || atomic_load(&a->status) == NT_DEAD) {
    /* Unknown/dead pid: the message is dropped (BEAM-ish) — but DROPPING IT IS NOT FREE
     * HERE. Unlike every other send, the deep copy for a structured message is made by
     * CODEGEN before the call (only the compiler knows the type to walk), so by the time
     * we refuse it the copy already exists and this is its last reference: the sender gave
     * it away at the call and its own local kept the ownership it had. Returning without
     * freeing leaked one object per message sent to a dead actor — invisible
     * single-threaded, where `__drain` means the receiver cannot die before the sends, and
     * ~0.5 per message at 4 scheduler threads, where it can. */
    nt_obj_free((void *)(intptr_t)slot);
    return;
  }
  mbox_push_kind(a, nt_int(slot), g_current ? g_current->pid : -1,
                 NT_MSG_STRUCT, shape, (NtMsgRender)render);
  wake_actor(a);
}

/* Blocking / timed FIFO receive of a STRUCTURED message of shape `shape`. A wrong
 * kind or a wrong shape is a hard reject (see kind_mismatch / shape_mismatch) — the
 * bits mean different things, so there is no sound way to continue. */
int64_t nt_recv_struct(const char *shape, double ms, int32_t has_timeout) {
  g_timed_out = 0;
  if (!wait_for_more(0, ms, has_timeout)) { g_timed_out = 1; return 0; }
  NtActor *a = g_current;
  NtMboxNode *h = a->mbox_head;
  if (node_kind(h) != NT_MSG_STRUCT) kind_mismatch(node_kind(h), NT_MSG_STRUCT);
  if (!h->shape || strcmp(h->shape, shape) != 0) shape_mismatch(h->shape, shape);
  note_last(a, h);
  int64_t slot = node_slot(h);
  mbox_pop(a);
  return slot;
}

/* Selective-receive predicate over the wire tag: is the i-th queued message a
 * structured message of exactly this shape? A foreign shape answers 0 and is simply
 * SKIPPED (left in the mailbox, in order) — the save queue, not a misread. */
int32_t nt_mbox_shape_ok(int64_t i, const char *shape) {
  NtMboxNode *n = mbox_at(g_current, i);
  if (!n || node_kind(n) != NT_MSG_STRUCT || !n->shape) return 0;
  return strcmp(n->shape, shape) == 0;
}

/* ---- selective-receive primitives (the scan loop itself is emitted by codegen,
 *      so the TS predicate is called through the ordinary closure ABI) ---- */

int64_t nt_mbox_count(void)             { return mbox_count_of(g_current); }
int64_t nt_mbox_peek_slot(int64_t i)    { NtMboxNode *n = mbox_at(g_current, i); return n ? node_slot(n) : 0; }
int64_t nt_mbox_peek_kind(int64_t i)    { NtMboxNode *n = mbox_at(g_current, i); return n ? (int64_t)node_kind(n) : -1; }

/* Remove the i-th message (the selective match). Everything before it stays put and
 * in order — that IS the save queue, restored for the next receive for free. */
void nt_mbox_take(int64_t i) {
  NtActor *a = g_current;
  NtMboxNode *prev = NULL, *n = a->mbox_head;
  while (n && i-- > 0) { prev = n; n = n->next; }
  if (!n) return;
  note_last(a, n);
  if (prev) prev->next = n->next; else a->mbox_head = n->next;
  if (a->mbox_tail == n) a->mbox_tail = prev;
  free(n);
}

/* Block until the mailbox holds more than `n` messages (i.e. something we have not
 * scanned yet arrived), or the timeout fires. Returns 1 / 0 respectively. */
int32_t nt_mbox_wait_from(int64_t n, double ms, int32_t has_timeout) {
  g_timed_out = 0;
  if (wait_for_more(n, ms, has_timeout)) return 1;
  g_timed_out = 1;
  return 0;
}
