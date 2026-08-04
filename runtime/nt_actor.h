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

#endif /* NT_ACTOR_H */
