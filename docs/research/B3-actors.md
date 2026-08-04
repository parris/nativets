# B3 — BEAM-style actors + supervision: build-order note & red-green test-vector spec

Research distillation for Roadmap **B3** (`docs/ROADMAP.md` §B3, `docs/phase2-design.md` §3).
Mines Elixir/Erlang OTP test patterns and turns them into a concrete v0→v3 build order,
an ordered per-version behavior/test list, a property-test recipe, and the crash-record
format. **No source is modified by this note** — it is the spec the stages implement.

---

## 0. Testing strategy — node is *not* the oracle here

Every prior nativets stage is differential-vs-`node`: compile `.ts` → run native → assert
stdout == `node file.ts`. **Actors break that contract on purpose.** Node has no BEAM
scheduler, no reduction preemption, no supervision tree, and no deterministic run queue, so
`node` cannot define what a supervised, preempted actor program *means*. B3 tests are therefore
a **new test family**: native-runtime **behavioral** tests, not differential.

Rules that keep them deterministic and green headless:

1. **Compile-run-assert-stdout, self-contained.** Each case is a `.ts` using the actor API;
   we compile it, run the binary, and assert its **stdout + exit code** against a curated
   `.expected` (same mechanism as fixtures, minus the `node` oracle). Put them under
   `test/fixtures/actors/**` with `.ts.expected` files; add an `actors.test.ts` runner that
   skips the `node` comparison for this dir (document the divergence in `docs/divergences.md`:
   "actor fixtures are behavioral, not node-differential").
2. **v0 is single-threaded and deterministic by construction.** One cooperative scheduler,
   one run queue, FIFO. Given a fixed spawn/send order the interleaving is a pure function of
   the program ⇒ stdout is byte-stable ⇒ an ordinary `.expected` works. **Do all example-based
   assertions on exact output at v0/v3 where the schedule is deterministic.**
3. **v1+ is concurrent ⇒ assert *invariants*, never a fixed transcript.** Once M:N threads and
   preemption land, global output order is nondeterministic. Tests must (a) drive to
   **quiescence** then print a **canonicalized** view (sorted lines, or per-actor counters),
   and (b) assert only guarantees that actually hold — chiefly **pairwise send order** (§6).
   Provide a `NATIVETS_SCHED_SEED` env read by the runtime RNG so any concurrent failure is
   **reproducible** from the seed printed in the crash record.
4. **Fault injection is a first-class API, present from day one.** A builtin
   `__crash(reason)` (and `__kill(pid)` at v2) lets a test deterministically fault an actor.
   This is the nativets analogue of `Process.exit(pid, :kill)` — the OTP kill-and-assert-restart
   test is *the* canonical supervision test and we must be able to write it in stage v3.
5. **A `__drain()` / run-to-quiescence primitive** (block main until the run queue is empty and
   all actors are blocked in `receive`) gives tests a deterministic join point before asserting.
   Plus `__schedTick`/`__reductions(pid)` introspection for preemption tests (v1).

### Minimal surface syntax (proposed)

Actors are ordinary functions that loop on `receive()`; messages are any **copyable** value
(scalars, strings, immutable records/arrays — B2 makes the mandatory deep-copy cheap and safe).
Builtins recognized by the checker/codegen (like `Math.*`, `console.log` today):

```ts
// --- core (v0) ---
type Pid = number;                       // opaque handle; distinct `pid` type in the checker
function spawn(body: (arg) => void, arg?): Pid   // start actor running body(arg); returns pid
function send(to: Pid, msg): void                // async, deep-copy, pairwise-ordered
function receive(): Msg                           // block until a message; FIFO dequeue
function self(): Pid
function register(name: string, p: Pid): void     // named registry
function whereis(name: string): Pid               // 0 if absent

// --- links / monitors (v2) ---
function link(p: Pid): void
function monitor(p: Pid): Ref                      // delivers {tag:"DOWN", ref, pid, reason}
function trapExit(on: boolean): void               // exits arrive as {tag:"EXIT", pid, reason} msgs
function exit(p: Pid, reason): void

// --- supervision (v3) ---
type ChildSpec = { id: string; start: () => Pid; restart: "permanent"|"transient"|"temporary" };
function supervise(children: ChildSpec[],
                   opts: { strategy: "one_for_one"; maxRestarts: number; maxSeconds: number }): Pid

// --- test/fault hooks (all versions) ---
function __crash(reason): void   // this actor exits abnormally (raises)
function __kill(p: Pid): void    // brutal, untrappable kill of p (test-only; ≈ Process.exit(pid,:kill))
function __drain(): void         // block until run queue empty & all actors blocked in receive
```

A typical stateful ("GenServer-shaped") worker is just a tail-recursive loop carrying state:

```ts
function counter(state: number): void {
  const msg = receive();                 // {tag:"inc"} | {tag:"get", reply: Pid}
  if (msg.tag === "inc") counter(state + 1);
  else { send(msg.reply, { value: state }); counter(state); }
}
```

---

## 1. Runtime data structures (C, driven from codegen)

All in `runtime/runtime.c`, libc-only so cross-links stay unchanged (macOS/iOS/Android).

```
Actor {
  pid_t         pid;              // dense small int; index into actor table
  char*         name;            // registered name or NULL (for the crash record)
  enum          status;         // RUNNABLE | RUNNING | BLOCKED(receive) | WAITING(io,v5) | EXITING | DEAD
  Mailbox       mailbox;        // v0: singly-linked FIFO queue; v1: lock-free MPSC (Vyukov)
  MsgQueue      save_queue;     // v4 selective receive; empty until then
  Arena         heap;           // per-actor bump arena (isolation; freed whole on exit)
  Context       ctx;            // saved stack/registers OR a resumable coroutine/ucontext
  fn_ptr        entry; void*    entry_arg;   // MFA-equivalent for restart (deep-copied)
  int64_t       reductions;     // v1 budget, refilled to CONTEXT_REDS (2000) per slice
  PidList       links;          // bidirectional; v2
  MonitorList   monitors;       // ref -> watcher pid; v2
  bool          trap_exit;      // v2: exits become messages instead of killing
  Pid           origin_of_msg;  // tag on the currently-processing message (causal chain)
}

Scheduler {                     // v0: one; v1: N OS threads, one per core (M:N)
  RunQueue      run_queue;      // FIFO of RUNNABLE pids; v5 work-stealing deque
  Actor*        current;
  RegTable      registry;       // name -> pid
  ActorTable    actors;         // pid -> Actor*
  uint64_t      rng_state;      // seeded from NATIVETS_SCHED_SEED for reproducible interleavings
  PollSet       poll_set;       // v5 epoll/kqueue; empty until then
}
```

**Deep-copy on send (mandatory, v0):** `send` copies `msg` from the sender arena into the
receiver arena (a recursive walk over the static message type — we already generate type-driven
recursive walks for `JSON.stringify`, reuse that shape). With B2 immutability the copy can later
degrade to a ref-count bump + structural share, but **v0 ships a real deep copy** so the isolation
invariant is testable and unconditional.

**Blocking `receive` on a cooperative scheduler** needs stack switching: implement actors as
resumable contexts (`ucontext`/`makecontext`, or a small hand-rolled `setjmp`+separate-stack
coroutine). `receive` on an empty mailbox sets `status=BLOCKED`, yields to the scheduler; `send`
to a BLOCKED actor flips it RUNNABLE and enqueues it. This is the single most load-bearing piece
of v0 — get it right first (v0.0 below).

---

## 2. Build order refined into testable increments

Each increment is small enough to land red-green with its own fixtures before the next.

- **v0.0 — coroutine substrate.** Two hand-written actors, no API sugar: prove a context can
  yield and resume and that a blocked actor wakes. *(one fixture)*
- **v0.1 — spawn + run queue + `self`.** `spawn(body)`, cooperative FIFO scheduler, `self()`,
  main runs to `__drain()`. No messaging yet — body just prints its pid.
- **v0.2 — mailbox + `send` + blocking `receive` (FIFO, deep-copy).** The echo actor.
- **v0.3 — pid registry** (`register`/`whereis`) + request/reply pattern (`reply: self()`).
- **v0.4 — pairwise-order guarantee + deep-copy isolation**, made explicit as tests (§6, v0).
- **v1.0 — reduction counting + cooperative preemption.** Codegen emits a **safepoint**
  (`reductions--; if (reductions<=0) yield();`) at every **call site and loop back-edge**
  (co-design with codegen — same insertion points as a future GC safepoint). Refill to
  `CONTEXT_REDS = 2000` per slice. Testable *before* threads via a long-running actor that
  must not starve a second one.
- **v1.1 — M:N scheduler threads** (one per core) + **lock-free MPSC mailbox** (Vyukov
  intrusive queue). From here tests assert invariants only (§0 rule 3).
- **v2.0 — `link`** + exit-signal propagation (linked actor dies ⇒ peer gets an exit signal;
  default = die too).
- **v2.1 — `trap_exit`** (exit signal becomes an `{tag:"EXIT"}` message instead of killing).
- **v2.2 — `monitor`/`demonitor`** (unidirectional; delivers `{tag:"DOWN", ...}`; monitoring a
  dead pid fires immediately).
- **v3.0 — `one_for_one` supervisor**: start children, monitor them, restart a child on abnormal
  exit to a fresh known-good state (re-run its `start`). Normal/`shutdown` exits are **not**
  restarted (for `permanent`; `transient` restarts only on abnormal; `temporary` never).
- **v3.1 — restart intensity**: sliding window of restart timestamps; if `> maxRestarts` within
  `maxSeconds` (**default 1 / 5 s** per the roadmap; Elixir's own default is 3 / 5 s — expose
  both via `opts`), the supervisor **exits `:shutdown`**, killing remaining children and
  escalating to *its* supervisor.
- **v3.2 — the crash record** (§7): every abnormal exit emits exactly ONE structured record.

(v4 selective-receive/timeouts and v5 work-stealing/async-IO poller are out of scope for this
note but the data structures above reserve `save_queue`/`poll_set` for them.)

---

## 3. Ordered behavior / test list

Format mirrors OTP tests: each is `id — setup → action → assertion`. **v0 & v3 assert exact
stdout** (deterministic schedule). **v1/v2 assert invariants** on canonicalized output.

### v0 — spawn / send / receive / self / registry  *(deterministic; exact `.expected`)*

1. **`spawn_runs`** — `spawn(body)` where `body` prints `"hi"`; `__drain()`. → stdout `hi`.
2. **`self_distinct`** — spawn 3 actors each printing `self()`; drain. → three **distinct**
   pids, and `self()` in main differs from all children.
3. **`echo`** *(canonical v0 test)* — spawn an echo actor `{const m=receive(); send(m.reply,m)}`;
   main sends `{reply:self(), body:"ping"}`, then `receive()`s and prints `body`. → `ping`.
4. **`fifo_single_sender`** — main sends `1,2,3` to one actor which prints each on receive. →
   `1\n2\n3` (single sender ⇒ full FIFO).
5. **`request_reply_registry`** — register a `counter` as `"c"`; `whereis("c")` from another
   actor; do `inc,inc,get`. → `2`.
6. **`deep_copy_isolation`** *(canonical)* — sender builds `msg = {items:[1,2,3]}`, `send`s it,
   **then mutates its local copy** (`items.push(4)` / rebinds), then signals the receiver to
   print `msg.items.length`. → `3`, proving the receiver saw a private copy. *(With B2
   immutability this is inherent, but the test pins it so a future shared-send optimization can't
   silently break isolation.)*
7. **`blocking_receive_wakes`** — actor `receive()`s **before** any message exists (blocks);
   main sends after a `__drain`-style yield; actor prints. → proves BLOCKED→RUNNABLE wakeup.
8. **`whereis_absent`** — `whereis("nope")` → `0` (no crash).

### v1 — preemption + M:N  *(assert invariants, not transcript)*

9. **`no_starvation`** — spawn a "hog" doing a huge bounded loop that periodically prints, and a
   "tick" actor that prints once; drain. → the tick line **appears before the hog finishes**
   (proves the hog was preempted at a safepoint, not run to completion). Assert *presence &
   relative order of the two specific lines*, not the full interleaving.
10. **`reduction_budget`** — `__reductions(self())` decreases across call sites/back-edges and
    refills after a yield. Assert monotone-down-then-refill, not exact counts.
11. **`mpsc_no_loss`** — K senders each send N messages to one collector; collector counts to
    `K*N` then prints the total. → `K*N` (no lost/duplicated messages under concurrency).
12. **`seed_reproducible`** — same program + same `NATIVETS_SCHED_SEED` ⇒ identical canonicalized
    output twice; two different seeds are *allowed* to differ.

### v2 — links / monitors / trap_exit

13. **`link_propagates`** — A links B; B `__crash`es; A (not trapping) dies too. Assert A is DEAD
    (`whereis` gone / a sentinel line absent).
14. **`trap_exit_survives`** — A `trapExit(true)`, links B; B crashes; A receives
    `{tag:"EXIT", pid:B, reason:...}` and prints `"trapped"`. → `trapped`, A still alive.
15. **`monitor_down`** — A monitors B; B exits normally; A receives `{tag:"DOWN",...,reason:"normal"}`.
16. **`monitor_dead_immediate`** — monitor an already-dead pid ⇒ `DOWN` fires at once.

### v3 — supervisor  *(deterministic again → exact `.expected`)*

17. **`sup_starts_children`** — `supervise([w1,w2], one_for_one)`; both workers register & reply
    to a ping. → both alive.
18. **`kill_and_restart`** *(THE canonical OTP test)* — supervised `counter` registered as `"c"`,
    do `inc,inc` (state=2); `__kill(whereis("c"))`; after restart, `whereis("c")` returns a
    **new, different pid**; `get` → **`0`** (fresh known-good state, *not* the pre-crash 2). Assert
    both the pid-changed and the state-reset facts.
19. **`normal_exit_not_restarted`** — a `permanent`… actually a `transient` child that exits
    `:normal` is **not** restarted; a `permanent` one **is**. Two sub-cases pinning the restart
    matrix (permanent/transient/temporary × normal/abnormal).
20. **`restart_intensity_escalates`** *(canonical)* — `maxRestarts:1, maxSeconds:5`; kill the child
    **twice within the window**. First kill → restart (new pid). Second kill exceeds intensity →
    **the supervisor itself exits `:shutdown`**, remaining children are terminated, and a crash
    record for the supervisor is emitted. Assert the supervisor is gone and the escalation record
    printed.
21. **`intensity_window_slides`** — kills spaced **beyond** `maxSeconds` do **not** accumulate;
    the child keeps restarting indefinitely without escalating. *(Use a `__advanceClock(ms)` test
    hook so the window is deterministic rather than wall-clock-flaky.)*
22. **`crash_record_shape`** — force one crash and assert the emitted record contains all §7
    fields (pid+name, reason, stacktrace, **triggering message**, state snapshot, supervisor +
    restart decision).

---

## 4. Property-based test recipe (PropEr `statem`, pairwise-order-only)

PropEr/QuickCheck `proper_statem` drives a *model* and the *real* system with the **same** random
command sequence and checks postconditions after each step, shrinking any failing sequence to a
minimal one. We reproduce the shape as a **self-contained nativets program** (the reference model
is computed in-process in TS; there is no external node oracle):

**Harness (`test/fixtures/actors/prop_counter.ts`, seed from argv/env):**

1. **System under test** — a supervised registry of stateful `counter` actors.
2. **Model** — a plain `Map<name, number>` (the "assoc-list" reference), updated by the same
   commands. This is the sequential specification.
3. **Command generator** (seeded PRNG) — random sequence over:
   `{spawn name} | {inc name} | {get name} | {kill name}` (kill = fault injection, built in).
4. **Preconditions** — e.g. `inc/get` only on a live name.
5. **Execute** each command against both model and SUT; **postcondition**: `get name` from the
   SUT equals the model's value — **except** a `get` immediately after a `kill` must equal the
   **restart value (0)**, because supervision resets state (the model encodes this: `kill` sets
   the model entry to 0, matching known-good restart).
6. **The ordering property (the important one).** Because only **pairwise** order is guaranteed
   (Erlang: "if A sends S1 then S2 to B, S1 arrives before S2; multiple senders may interleave
   arbitrarily"), the model must **not** assert a global message order. Encode it as: tag every
   message with `(sender, seq)`; the receiver logs arrivals; the property asserts that for **each
   fixed sender**, that sender's messages arrive in increasing `seq` — and asserts **nothing**
   about cross-sender interleaving. A test that asserts a total order is itself the bug.
7. **Determinism & shrinking** — the whole run is a pure function of `(seed)`. On failure the
   harness prints `SEED=<n>` and the **minimal failing command sequence** (shrink by: drop
   commands, then reduce arguments, re-run, keep if still failing — a hand-rolled ddmin is enough
   since we own the generator). Re-running with the printed seed reproduces it exactly (§0 rule 3).
8. **Concurrency knob** — run the property under several `NATIVETS_SCHED_SEED` values so the
   pairwise property is exercised across many interleavings.

Assertion at the top level is still "compile → run → stdout": the harness prints `OK <n> cases`
or `FAIL seed=<s> seq=[...]`, and the `.expected` is `OK`. A regression makes the binary print a
reproducible failing seed.

---

## 5. Crash record format ("good tracebacks" — the JS-async fix)

Modeled on OTP/SASL's gen_server crash report (`Last message in was` + `When Server state ==`),
extended with the fields JS promise rejections structurally lack. **Exactly one** record per
abnormal exit, written to **stderr** (stdout stays assertable), machine-parseable, human-readable:

```
=== nativets actor crash ===============================================
actor:        pid=<7> name="counter"            # who (registry name if any)
reason:       Error: divide by zero             # why (the exit term)
stacktrace:                                      # SYNCHRONOUS — a crash is contained in
    at counter (counter.ts:12)                   #   one actor, so this is a real call stack,
    at handle_inc (counter.ts:19)                #   not an async patchwork
    at receive-loop (counter.ts:6)
triggering-message:                              # THE field JS traces lack:
    from pid=3  seq=4                             #   causal origin (sender + per-sender seq)
    { tag: "inc", n: 0 }                          #   the exact message being processed
state-snapshot:                                  # the actor's state at the moment of crash
    { count: 41 }
supervisor:   pid=2 name="root_sup" strategy=one_for_one
decision:     RESTART (2/1 within 5s → INTENSITY EXCEEDED, supervisor exiting :shutdown)
seed:         NATIVETS_SCHED_SEED=90111          # reproduce the exact interleaving
========================================================================
```

**Field rationale (why this beats an unhandled JS rejection):**
- **triggering-message + origin pid/seq** — every message is tagged with its sender and
  per-sender sequence (`Actor.origin_of_msg`), giving a **causal chain**; a JS stack trace tells
  you *where* it blew up but never *which input* or *who sent it*.
- **synchronous stacktrace** — failure is localized to one isolated process, so there is one real
  stack, versus a promise chain stitched across turns of the event loop.
- **state-snapshot** — the crashing actor's state (the equivalent of `format_status`), so the
  restart-to-known-good decision is auditable.
- **supervisor + decision** — names the owner and the restart outcome (restart / escalate /
  give-up), so failures are *owned events delivered to a designated supervisor*, not unowned
  floating rejections.

The record is emitted at v3.2; at v0–v2 a reduced form (actor/reason/stacktrace/message) prints on
any abnormal `__crash`, so fault-injection tests have output to assert from day one.

---

## Sources

- [Erlang — A few notes on message passing (signal ordering: pairwise only)](https://www.erlang.org/blog/message-passing/)
- [Erlang — Processes (System Documentation): signal ordering guarantee](https://www.erlang.org/doc/system/ref_man_processes.html)
- [Message order and delivery guarantees in Elixir/Erlang (Chilingarov)](https://medium.com/learn-elixir/message-order-and-delivery-guarantees-in-elixir-erlang-9350a3ea7541)
- [Elixir — Supervisor docs (max_restarts / max_seconds / strategies / shutdown)](https://hexdocs.pm/elixir/Supervisor.html)
- [Elixir — Dynamic supervisors / start_supervised testing](https://elixir-lang.org/getting-started/mix-otp/dynamic-supervisor.html)
- [GenServer supervision tree & state recovery after crash (Bounga)](https://www.bounga.org/elixir/2020/02/29/genserver-supervision-tree-and-state-recovery-after-crash/)
- [Elixir Processes: Testing — GenServer.stop vs Process.exit (Samuel Mullen)](https://samuelmullen.com/articles/elixir-processes-testing)
- [theBeamBook — scheduling & reduction counting (CONTEXT_REDS = 2000)](https://github.com/happi/theBeamBook/blob/master/chapters/scheduling.asciidoc)
- [Erlang Scheduler Details and Why It Matters (Soleimani)](https://hamidreza-s.github.io/erlang/scheduling/real-time/preemptive/migration/2016/02/09/erlang-scheduler-details.html)
- [PropEr testing of generic servers (proper_statem tutorial)](https://proper-testing.github.io/tutorials/PropEr_testing_of_generic_servers.html)
- [proper_statem source — proper-testing/proper](https://github.com/proper-testing/proper/blob/master/src/proper_statem.erl)
- [Erlang — SASL Error Logging (crash report format: "Last message in was" / server state)](https://www.erlang.org/doc/apps/sasl/error_logging.html)
- [erlang/otp #4673 — crashing gen_server last-message formatting](https://github.com/erlang/otp/issues/4673)
