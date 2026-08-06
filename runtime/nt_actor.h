/*
 * nt_actor.h — BEAM-style actor runtime for nativets, v0 (standalone).
 *
 * v0 scope (see docs/research/B3-actors.md §2, increments v0.0→v0.4):
 *   - one cooperative scheduler + FIFO run queue (single-threaded, deterministic)
 *   - spawn(fn, arg) -> pid ; the actor runs body(arg) on its own coroutine stack
 *   - send(pid, msg) : async, MANDATORY deep-copy, per-sender FIFO
 *   - receive() : blocks the current actor until a message arrives (FIFO dequeue)
 *   - self() ; a name registry (register / whereis)
 *   - __drain() : run the scheduler to quiescence (run queue empty) then return
 *
 * NOT in v0 (follow-ups): reduction preemption (v1), M:N threads + lock-free
 * mailbox (v1), links/monitors/trap_exit (v2), supervision + crash records (v3).
 * This module is deliberately standalone and NOT yet wired into codegen/driver.
 *
 * Coroutine substrate: ucontext (makecontext/swapcontext) — the "single most
 * load-bearing piece of v0" per the research note. `main` is modeled as actor 0
 * so the top level can spawn / send / receive / self like any actor; a dedicated
 * scheduler context drives the run queue and idle-returns to main.
 *
 * Message value (NtMsg): a small recursive tagged value (INT | STR | LIST) — a
 * v0 PLACEHOLDER standing in for the compiler's future `Dyn` tagged value. The
 * deep-copy walk here is hand-rolled over this shape; when codegen lands, NtMsg
 * should be replaced by Dyn and the copy made type-driven (reuse the recursive
 * walk we already generate for JSON.stringify). See the report / FLAG in the .c.
 */
#ifndef NT_ACTOR_H
#define NT_ACTOR_H

#include <stdint.h>

typedef int64_t NtPid;

/* ---- v0 message value: recursive tagged union (Dyn placeholder) ---- */
typedef enum { NT_INT, NT_STR, NT_LIST } NtTag;

typedef struct NtMsg {
  NtTag tag;
  union {
    int64_t i;                 /* NT_INT  */
    char   *s;                 /* NT_STR  (owned, NUL-terminated) */
    struct { struct NtMsg *items; int64_t len; } list; /* NT_LIST (tuple/record) */
  } u;
} NtMsg;

/* message constructors (helpers for tests / eventual codegen) */
NtMsg nt_int(int64_t v);
NtMsg nt_str(const char *s);
NtMsg nt_list(const NtMsg *items, int64_t len); /* copies the items array */

/* message accessors */
int64_t     nt_msg_int(NtMsg m);
const char *nt_msg_str(NtMsg m);
int64_t     nt_msg_list_len(NtMsg m);
NtMsg       nt_msg_list_get(NtMsg m, int64_t i);

/* actor body: run as body(arg). Plain C fn ptr; codegen supplies real ones later. */
typedef void (*NtActorFn)(NtMsg arg);

/* ---- core v0 API ---- */
void   nt_sched_init(void);                 /* (re)initialize the scheduler + actor 0 (main) */
NtPid  nt_spawn(NtActorFn body, NtMsg arg); /* start body(arg); returns the new pid */
void   nt_send(NtPid to, NtMsg msg);        /* async, deep-copy, enqueue; wakes a blocked actor */
NtMsg  nt_receive(void);                    /* block current actor until a message; FIFO dequeue */
NtPid  nt_self(void);                       /* pid of the currently running actor */
void   nt_drain(void);                      /* run scheduler until the run queue is empty */

/* ---- name registry ---- */
void  nt_register(const char *name, NtPid pid);
NtPid nt_whereis(const char *name);         /* 0 if absent (pid 0 == main is never registered) */

/* ============================================================================
 * Compiler-facing ABI (added by the language-wiring lane, B3 v0).
 *
 * The nativets compiler lambda-lifts arrows to `@arrow_N(ptr env, params)` and
 * represents a message as its universal 8-byte slot (an i64: a `double` bit-cast
 * for numbers, a pointer-as-int for heap values / the future `Dyn`). These entry
 * points expose the SAME v0 scheduler above to codegen without disturbing the
 * NtMsg struct API (which the C-level test harness still exercises):
 *
 *   - a spawned body is a closure `void body(void *env, int64_t arg)` — codegen
 *     passes a small generic trampoline plus the closure block as `env`;
 *   - send/receive move raw i64 slots (deep-copy is a no-op for v0 number
 *     messages; for `Dyn` the compiler copies before send — see the .c FLAG).
 * ========================================================================== */
typedef void (*NtClosureFn)(void *env, int64_t arg);

NtPid   nt_spawn_closure(NtClosureFn body, void *env, int64_t arg); /* returns new pid */
void    nt_send_slot(NtPid to, int64_t slot);                        /* enqueue a raw slot */
int64_t nt_receive_slot(void);                                        /* block; FIFO dequeue slot */

/* v1 reduction-counted preemption: the compiler-emitted SAFEPOINT. Codegen calls
 * this at every function-call site and loop back-edge; it decrements the running
 * actor's budget and yields (re-enqueued at the run-queue tail) when it hits 0, so
 * a long loop / deep recursion can't monopolize the scheduler. No-op off-scheduler. */
void    nt_reduction_tick(void);

/* ============================================================================
 * v2 — links / monitors / trap_exit + fault injection (B3-actors §2 v2.0–2.2).
 *
 * Exit signals propagate along links: when an actor dies, each linked peer that
 * is NOT trapping dies too on an ABNORMAL exit (normal exits don't kill a linked
 * peer); a peer that IS trapping receives the exit as a MESSAGE instead. Monitors
 * are unidirectional and always deliver a DOWN message carrying the reason. An
 * exit/down delivered to a plain TS actor surfaces via nt_receive_slot as the
 * dead peer's pid (a number) — v0 messages are numbers, so the notification is a
 * number too (the richer {tag,pid,reason} shape waits on Dyn). reason==0 is a
 * NORMAL exit; any nonzero reason is abnormal and emits a crash record (stderr).
 * ========================================================================== */
#define NT_REASON_NORMAL 0
#define NT_REASON_KILL   0x6b696c6c /* 'kill' — brutal __kill(pid) */

void    nt_link(NtPid other);      /* bidirectional link between current actor and `other` */
int64_t nt_monitor(NtPid target);  /* current actor monitors `target`; returns a monitor ref */
void    nt_trap_exit(int on);      /* current actor traps exits (they arrive as messages) */
void    nt_actor_exit(NtPid target, int64_t reason); /* send an exit signal to `target` */
void    nt_crash(int64_t reason);  /* current actor dies abnormally; DOES NOT RETURN */
void    nt_kill(NtPid target);     /* brutal external kill of `target` (abnormal) */

/* ============================================================================
 * v3 — one_for_one supervision (B3-actors §2 v3.0–3.2).
 *
 * A supervisor is a trapping actor that links its children and, on a child's
 * abnormal exit, restarts it to known-good initial state by re-invoking the
 * child's `start` closure (a TS `() => Pid`, called through slot 0). Children are
 * auto-registered under their `id` so whereis(id) tracks the current pid across
 * restarts. Restart intensity: more than maxRestarts restarts within maxSeconds
 * makes the supervisor itself exit :shutdown (killing remaining children).
 * Codegen builds a spec via nt_sup_new + nt_sup_add_child, then nt_sup_start.
 * ========================================================================== */
#define NT_RESTART_PERMANENT 0  /* always restart */
#define NT_RESTART_TRANSIENT 1  /* restart only on abnormal exit */
#define NT_RESTART_TEMPORARY 2  /* never restart */

int64_t nt_sup_new(int64_t max_restarts, int64_t max_seconds, int64_t strategy);
void    nt_sup_add_child(int64_t handle, const char *id, void *start_closure,
                         const char *restart); /* restart string -> kind */
NtPid   nt_sup_start(int64_t handle); /* spawn the supervisor actor; returns its pid */

/* ============================================================================
 * v4 — selective receive + save queue, receive timeouts, richer messages.
 *
 * MESSAGE KINDS. Every compiler-sent message carries a kind so a receive compiled
 * for one type never reinterprets another's bits (a mismatch is a hard runtime
 * error, not a miscompile). Strings are DEEP-COPIED on send (and on spawn), so a
 * receiver never aliases the sender's buffer; the copy joins runtime.c's string
 * refcount table at rc=1 and the receiving local releases it at scope exit.
 *
 * TIMEOUTS run on a VIRTUAL clock that only advances when the run queue is empty:
 * a timeout fires exactly when nothing runnable could still send, which preserves
 * `after`-semantics while keeping the schedule deterministic (no wall-clock sleep).
 *
 * SELECTIVE RECEIVE is driven from codegen: it scans the mailbox (peek kind/slot,
 * call the TS predicate through the ordinary closure ABI, take the first match).
 * Non-matching messages simply stay in place, in order — the OTP save queue,
 * restored for the next receive by construction. Messages arriving mid-scan land
 * at the tail and are picked up by the next pass.
 * ========================================================================== */
#define NT_MSG_NUM    0
#define NT_MSG_STR    1
#define NT_MSG_STRUCT 2   /* v5: a record/array, deep-copied by codegen, carries a shape */

/* ============================================================================
 * v5 — STRUCTURED messages (records / arrays).
 *
 * A message rides in ONE 8-byte slot plus a coarse kind tag. Sender and receiver
 * are typed INDEPENDENTLY, so a slot + a coarse tag cannot distinguish two different
 * record types across actors — shipping objects on that basis would be a soundness
 * hole. v5 closes it with two additions, both supplied by codegen:
 *
 *   1. DEEP COPY ON SEND. The compiler emits its type-driven deep-copy walk (the
 *      Stage-40 structuredClone walk, with strings copied into fresh RC-registered
 *      allocations) BEFORE nt_send_struct, so the receiver's value shares nothing
 *      with the sender's heap. Isolation is the actor model's whole point, and our
 *      immutability makes the copy semantically invisible.
 *   2. A SHAPE TAG ON THE WIRE. Every structured message carries `shape` — the
 *      compiler's canonical type encoding for the value (e.g. `{kind:string,n:number}`)
 *      as a static string. A receive is compiled for exactly one shape and compares
 *      it; a mismatch is a hard runtime reject naming both shapes (exit 70), never a
 *      reinterpreted pointer. A SELECTIVE receive treats a foreign shape like a
 *      foreign kind — it is skipped and left in the mailbox, not misread.
 *
 * `render` is an optional codegen-emitted `char *(int64_t slot)` that renders the
 * value (JSON) for the CRASH RECORD, so "which message killed this actor" stays
 * readable for structured messages. It is called only while printing a crash record.
 * ========================================================================== */
typedef char *(*NtMsgRender)(int64_t slot);

NtPid   nt_spawn_typed(NtClosureFn body, void *env, int64_t slot, int64_t kind);
void    nt_send_typed(NtPid to, int64_t slot, int64_t kind);
void    nt_send_struct(NtPid to, int64_t slot, const char *shape, void *render);
int64_t nt_recv_struct(const char *shape, double ms, int32_t has_timeout); /* 0 + flag on timeout */
int32_t nt_mbox_shape_ok(int64_t i, const char *shape); /* i-th message is this shape? */
char   *nt_msg_str_copy(const char *s);   /* string leaf of the structured deep copy */
int64_t nt_recv_timed(int64_t kind, double ms, int32_t has_timeout); /* 0 + flag on timeout */
int32_t nt_recv_timed_out(void);          /* did the last receive/wait time out? */
int64_t nt_mbox_count(void);              /* messages currently queued for self() */
int64_t nt_mbox_peek_slot(int64_t i);     /* i-th message payload (no dequeue) */
int64_t nt_mbox_peek_kind(int64_t i);     /* i-th message kind (-1 if out of range) */
void    nt_mbox_take(int64_t i);          /* remove the i-th message (the match) */
int32_t nt_mbox_wait_from(int64_t n, double ms, int32_t has_timeout); /* block for msg > n */

/* ============================================================================
 * v6 — M:N scheduler threads, lock-free MPSC mailboxes, work stealing.
 *
 * NATIVETS_SCHED_THREADS selects the mode AT RUN TIME:
 *   unset / "1"  -> ONE cooperative scheduler (the default). Byte-identical to v0..v5:
 *                   a single FIFO run queue, direct mailbox appends, the virtual clock —
 *                   so every behavioral test that asserts an exact interleaving still holds.
 *   "N" / "auto" -> N OS threads, each with its own scheduler + run queue, work stealing
 *                   between them, and per-actor LOCK-FREE MPSC mailbox intake. Actors
 *                   migrate freely; PIDS ARE STABLE (they index one global actor table).
 *
 * Only what the actor model actually guarantees survives the switch: per-sender FIFO,
 * message counts, supervision outcomes, eventual completion. A specific interleaving
 * does not, which is exactly why the multi-threaded mode is opt-in.
 *
 * SOUNDNESS OF THE REST OF THE RUNTIME. runtime.c's string refcount side-table and
 * nt_pvec.c's node refcounts are single-threaded structures (Stages 30/38/44). Under M:N
 * they are reached from several scheduler threads, so both call through the `nt_rt_lock`
 * hook, which nt_sched_init installs ONLY when more than one scheduler thread is running.
 * NULL (the default) means a plain, predictable branch and zero behavioural change.
 * ========================================================================== */
double nt_schedulers(void);    /* resolved scheduler-thread count (1 = deterministic mode) */
double nt_sched_used(void);    /* how many schedulers actually ran an actor (test hook) */
double nt_sched_steals(void);  /* work-stealing hits (test hook) */

#endif /* NT_ACTOR_H */
