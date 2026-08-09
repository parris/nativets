# nativets roadmap

The plan for what's next. Companion design details live in `docs/phase2-design.md`
(immutability + actors research) and `docs/ownership.md` (linear memory model).

## Where we are

A memory-safe **TypeScript → LLVM → native** compiler, ~3,700 lines, hand-written frontend,
differential-tested against `node`. Runs on macOS and **cross-compiles + runs on Android
(emulator) and iOS (simulator)**.

**Two single-executable stories (both live):**
1. **The compiler ships as one self-contained binary** — `bun run compile` → `./nativets`
   (~61 MB, bundles the compiler + embedded C runtime; needs only a system `clang`).
2. **Running `nativets` compiles your program into a single native executable.**
   `nativets build prog.ts -o prog` links the generated LLVM IR + the C runtime into **one
   native binary** (`prog`) you can ship and run with no `nativets`, `bun`, `node`, or runtime
   files — just the OS's libc. `nativets run prog.ts` does the same compile then executes the
   binary (throwaway). Cross-target: `--target ios|ios-sim|android` produces the single binary
   for that platform. (Enhancement below: `--static` for a *fully* static binary with no dynamic
   libc dependency.)

- **Language:** numbers/booleans/strings; arrays + objects (nested); closures (higher-order,
  capture, mutable/returned, `compose`); array HOF (`map`/`filter`/`reduce`); destructuring;
  spread; rest params; `try`/`catch`/`finally`/`throw`; `JSON.stringify`; `??`; `switch`; all
  operators incl. bitwise; string methods; `Math`/`parseInt`/etc.
- **Memory:** Rust-modeled **linear ownership** checker (move / use-after-move `NT1601`,
  borrow/iterator-invalidation `NT1602`/`NT1603`) + **deterministic drop** for arrays. No GC, no
  manual free.
- **Tooling:** `nativets build|run|emit|coverage`; banded `NT####` diagnostics; 6-type test
  suite (differential, curated, IR snapshots, toolchain, 2 conformance corpora, cross-device);
  **53/55** gap corpus, **37/39** base corpus, 133 tests green.

---

## Phase A — Close the gap (2 cases) + runtime typechecking

These two remaining gap cases each need a type-system extension, and one of them delivers the
requested **runtime typechecking (#4)** for free.

### A1. Dynamic value + runtime typechecking → closes `json-roundtrip` and delivers #4
`JSON.parse` inherently returns a *dynamic* value. Implement:
- A **`Dyn` (tagged/`any`) value**: a heap box `{ tag, payload }` (tag ∈ number/bool/string/array/
  object/null). `JSON.parse(s): Dyn` builds it by parsing JSON at runtime (a small recursive
  descent in the C runtime producing tagged nodes).
- **Runtime typechecking** = the checked narrowing from `Dyn` to a static type. Two surfaces:
  1. `x as T` on a `Dyn` (or a `parseAs<T>(s)` form) → emit a runtime validator that walks the
     Dyn against `T`'s shape and throws a typed error on mismatch, then hands back a statically-`T`
     value. This is exactly io-ts/zod semantics, generated from our static types.
  2. A standalone `check<T>(value)` / assertion builtin.
- Dyn field/element access (`back.arr[1]`) → runtime tag checks (or require a prior `as T`).
- Tests: `json-roundtrip`, plus new `test/fixtures` for parse + validation success/failure, and a
  rustc-style set of "must-throw on bad shape" cases.

### A2. Nullable / optional types → closes `optional-chaining`
- Parse optional object fields `{ a?: T }` (a is `T | undefined`) and a **nullable type** `T | U`
  restricted to `T | undefined` / `T | null` first.
- `o.a?.b` → runtime null check: if `o.a` is null/undefined → `undefined`, else `o.a.b`; result is
  `(field) | undefined`. Composes with `??` (already static — extend to nullable operands).
- `{}` empty object literal assignable to `{ a?: T }` (structural, optional-aware).
- Tests: `optional-chaining` → **gap fully closed at 55/55**.

---

## Phase B — The sharp turn (diverge from TS proper)

Design + sources in `docs/phase2-design.md`. Order chosen so each piece is independently testable.

### B1. Pipeline operator `|>` (small, do first)
`x |> f(a)` ≡ `f(x, a)` (LHS threaded as first arg), lowest precedence, left-assoc. Pure parser
desugar: `a |> f(b) |> g(c)` → `g(f(a, b), c)`. Add `|>` token; desugar in `parseBinary`/a new
level. Tests: chained pipelines match the equivalent nested calls.

### B2. Immutable-by-default data + structural sharing
The big one. Objects, arrays, maps, sets immutable; "mutations" return new values sharing
structure (**path copying** — only root→leaf ancestors copied). Staged:
1. **Copy-on-write over current flat structures.** Make `.push`/`.pop`/field-set/`arr[i]=` and a
   new `.with(i, v)` / `set(k, v)` return **new** values (copy the flat block, apply the change).
   Immediately delivers immutable semantics; pairs with our linear ownership (`rc==1 ⇒ mutate in
   place` = transients).
2. **Persistent structures past a size threshold** (small-vs-large split, per Elixir): **HAMT**
   for maps/sets (bitmap + `llvm.ctpop` sparse nodes, 32-way), **32-way vector trie + tail** for
   arrays. O(log32 n) ≈ O(1) get/update, O(1) amortized append; structural sharing.
3. **`Map` / `Set` types** and literals; `put_in`/`update_in`-style nested update sugar.
4. Memory: atomic **reference counting** (immutable DAGs are acyclic → complete, no cycle
   collector) + transients for bulk builds.
- Tests: **model-based property tests** vs a reference model (assoc-list / plain array), biased to
  the flat→trie boundary (~32) and hash collisions; assert old versions unchanged + sibling
  pointer-identity (structural sharing).

### B3. BEAM-style actors + supervision + async IO
A minimal actor runtime in C, driven from codegen. Build order (from research):
- **v0:** `spawn(fn, args) -> pid`, `send(pid, msg)` with **mandatory deep-copy** (immutability
  makes this safe — no shared mutable state), blocking `receive`; single cooperative scheduler +
  run queue; `self()`, pid registry.
- **v1:** reduction-counted **preemption** (compiler-emitted safepoint = budget decrement + check
  at call sites and loop back-edges — co-design with codegen) + M:N scheduler threads; lock-free
  MPSC mailboxes.
- **v2:** `link`/`monitor` + exit-signal propagation (`trap_exit`).
- **v3:** `one_for_one` **supervisor** + restart intensity (default 1/5 s → escalate by self-exit).
- **v4 ✅ (Stage 33):** selective `receive` (`receiveMatch(pred[, ms])`) + save queue + timeouts
  (`receive(ms) -> T | undefined`, on a virtual clock that advances only at quiescence), plus
  **string messages** deep-copied on send.
- **v5 ✅ (Stage 41) — STRUCTURED messages.** Records and arrays are sendable, which is what makes
  actors usable for real programs (`{kind:"work", payload}` dispatch). The two things v4 named as
  missing are both there: (a) the **type-driven deep copy** at the send/spawn site — the Stage-40
  `structuredClone` walk, extended to copy string leaves, so the receiver shares nothing with the
  sender's heap; and (b) a **shape tag on the wire** — the canonical type encoding travels with
  the message, a receive compiled for another shape is a hard runtime reject naming both shapes
  (exit 70), and a *selective* receive skips a foreign shape and leaves it queued in order.
  Crash records render the structured triggering message (a codegen-emitted per-shape JSON
  renderer, called only while printing a record). Un-copyable message types (a closure, a
  Map/Set/bytes/Response handle) are **`NT1021`** at compile time.
- **v6 ✅ (Stage 45) — M:N scheduler threads, lock-free MPSC mailboxes, work stealing, and the
  async-IO poller.** `NATIVETS_SCHED_THREADS` picks the scheduler at RUN TIME: unset/`1` keeps the
  deterministic single cooperative scheduler (the default — every `test/actors/` case still asserts
  exact stdout, byte for byte), `N`/`auto` starts N OS threads, each with its own run queue plus
  FIFO **work stealing**, and a per-actor **lock-free MPSC** mailbox intake (Treiber stack +
  consumer-side batch reverse) drained into the private list the selective-receive save queue
  already scans — BEAM's outer/inner mailbox split, so v4/v5 machinery is untouched. Actors migrate;
  **pids are stable**. The M:N-only hazard — a sender enqueueing an actor whose ucontext is still
  being saved — is closed by a `SWITCHING` state only the regaining scheduler may leave. **Refcount
  soundness:** the string RC side-table and the pvec node refcounts + Stage-44 transient run under a
  recursive lock installed *only* in M:N mode (`nt_rt_lock`, `NULL` otherwise → one branch); values
  need no protection because every message is deep-copied and arrays/objects are immutable. Gated by
  **ThreadSanitizer with a negative control**. The **poller** (kqueue/epoll) parks an actor on a fd
  and wakes it on readiness, costing no scheduler slice — mechanism done and gated, but **not yet
  wired to a TS-visible IO builtin** (`readLine` slurps stdin up front; `fetch` is blocking libcurl),
  which is the remaining piece and what would finally make Stage 34's `await` more than an identity.
- **v6 follow-ons (deferred):** a DIRTY scheduler pool (long native calls off the main pool);
  retrofitting `fetch` (curl multi) and an incremental `readLine` onto the poller; per-actor
  heap arenas so the RC lock can go away entirely; timeouts on `nt_io_wait`.
- **Good tracebacks (the JS-async fix):** on crash emit ONE record — pid+name, reason +
  synchronous stacktrace, **the triggering message**, state snapshot, supervisor + restart
  decision. Tag every message with origin pid for a causal chain.
- Tests: OTP-style **kill-and-assert-restart** (fault injection built in) + property-based random
  command sequences (only pairwise send-order guaranteed).

---

## Phase C — Finish the memory model

- ✅ **Objects are linear** (Stage 23); **strings are refcounted**, not linear (Stage 30 — JS
  value semantics beat move-checking for a `Copy`-ish type).
- ✅ **Drops for nested-scope and temporary values** (B2 step 4, Stage 41): block-scoped drop
  points (`Stmt[].blockDrops`), RAII on reassignment (`AssignExpr.dropOld`), drop flags for
  conditional moves (the move nulls the slot; `free(NULL)` is the flag), and unbound array
  temporaries freed where the chain consumes them.
- ✅ **Move-out-of-borrow / array-element** (`E0507`/`E0508` → NT1604/NT1605, Stage 28).
- Reconciled with B2/B4: **linear ownership for uniquely-owned handles, refcounting for
  shared-immutable storage** (trie nodes, strings) — and `rc == 1` is what licenses transients.
- **Still open:** values escaping through a `break`/`continue`/`throw` out of a block, temporaries
  in non-chain positions (call arguments), array/object ELEMENTS (an array does not recursively
  free what its slots point at), and module-level bindings a function may have aliased. All are
  leaks by construction, never a double free or a dangling pointer.

### Why ELEMENTS is not a one-line fix (measured, `test/drops-obj.test.ts`)

Shapes that leak today, all by the same mechanism — `nt_obj_free` is `free(o)` and never walks
the slots: object-in-object (`__objLive() === 1`), object-in-array (`objLive 1`, and **`__arrLive`
reports 0** — it counts headers, so it cannot see this class at all), array-in-object (`arrLive 1`),
a discriminated-union member's object field, and a `@@mutable` record's object field. Nesting
depth 3 leaks 2. Refcounted string slots do *not* leak this way.

A **generic** recursive free is impossible, not merely unsafe: `nt_obj_new` returns a bare
`int64_t*` of n slots with **no header**, so at the free site the runtime knows neither the slot
count nor whether a given 64-bit word is a bit-punned double, a refcounted `char*`, a linear
object, or an `NtArray*`. Nothing in the value can tell them apart, and `nt_obj_new` also backs
**closures** (`1 + caps.length`), whose captures deliberately alias outer values. So the fix is a
codegen-emitted **per-type destructor** keyed off the `dropTy` already in hand at `emitDrops`,
walking `objectFields()` and recursing only into `isObjectTy`/`isArrayTy`/`isUnionTy` slots
(strings must `release`, not `free`). It terminates by construction: recursive types have no
finite `Ty` encoding yet (see self-hosting SH2), so the field tree is finite.

> **THAT TERMINATION ARGUMENT NO LONGER HOLDS, and whoever builds this must not inherit it.**
> Recursive types now DO have a finite encoding — the nominal `@Name` back-edge — so the field
> tree is a GRAPH, not a tree: `interface N { next?: N }` walks `N → @N → N` forever. A
> per-type destructor now needs an explicit cycle guard (a visited set of `@Name`s already on
> the walk, emitting a call to that type's destructor rather than inlining it) — which is the
> ordinary shape for this, but it is work the paragraph above assumed away. Two adjacent facts
> for the same lane: `isGeneralUnionTy` is missing from `isLinearTy` (`ownership.ts:36`) and
> from the `free` selection in `emitDrops`, so a `G<…>` box leaks both itself and its payload
> (measured: `__arrLive() === 200` and `__objLive() === 200` for a `number | string[]` local in
> a 200-iteration loop, against `0` for the identical plain-array local); and a boxed value is
> the one shape where the destructor must free the payload BEFORE the box.

Two blockers must be cleared **before** that lands, or the leak becomes a double free — silent on
stdout, visible only as a nonzero exit, the exact signature of the shipped `nt_arr_reverse` bug:
1. **Spread shallow-copies slots.** `{ ...o1 }` loads o1's slot and stores the *same* pointer into
   o2, then both are dropped — one `inner`, two owners.
2. **A field can be moved out** (`const taken = outer.a`, or `return outer.a`) while the parent's
   slot still points at it. Unlike an array element (`NT1605`), this is currently allowed.

Each needs to be consumed-and-invalidated or refused first. Both are pinned as passing tests so
the hazard cannot be rediscovered by accident.

---

## Example apps (north-star targets — drive the roadmap)

Two target apps in [`docs/examples.md`](examples.md), each staged from achievable-now to the full
vision, forcing capabilities that make nativets real:
- **Calculator (cross-platform UI app):** expression engine → CLI calculator (once input exists) →
  TUI (the achievable cross-platform "UI") → native GUI (per-platform UI FFI, north-star).
- **LLM chat (CLI, key via arg):** argv + stdin loop + JSON (✅) → HTTP/TLS networking → chat.

**Both depend on a Host I/O FFI** (argv/stdin/env — which is also self-hosting SH4): today nativets
has no input at all. Build that first; it's the highest-leverage unlock.

## Ongoing / infrastructure

- **Distribution:**
  - The compiler ships as one binary (`bun run compile`), and **`nativets build` already emits a
    single native executable per program** (see "Where we are"). ✅
  - **`--static` flag** (enhancement): pass `-static`/musl (Linux) or the relevant clang flags to
    produce a *fully* static binary with **zero dynamic libc dependency** — a truly standalone
    single file. On macOS full static libc isn't supported, so keep the current
    single-file-dynamic-libc default there and offer `--static` for Linux/Android targets.
  - Next: cross-compile the *compiler itself* for Linux/Windows; a real iOS app-bundle + device
    signing path; Android APK packaging (today we run raw ELF via `adb`).
- **Testing:** keep the differential-vs-node discipline; add property-based tests (esp. for B2
  structures and B3 supervision); an ASan/leak lane over the corpus (scriptc-style) once drops are
  complete.
- **Diagnostics:** richer multi-span errors; more `NT####` coverage; a `coverage` gradient that
  also reports the % of statements that are static.
- **Self-hosting (far horizon):** the frontend is hand-written with no `typescript` dep — a long-
  term goal is to compile the compiler with itself once the language subset is rich enough. A
  **grounded, staged plan is in [`docs/self-hosting.md`](self-hosting.md)** (SH0–SH7 + the 3-stage
  bootstrap fixed point), based on running `nativets coverage` over `src/*.ts`: today the compiler
  can't yet parse its own module syntax (`import`/`type`/classes/discriminated unions), so SH0 is
  to turn that gap into a measurable gradient.

---

## Suggested order

1. **A1** (dynamic value + runtime typecheck → `json-roundtrip` + #4).
2. **A2** (nullable/optional → `optional-chaining` → gap **55/55**).
3. **B1** (pipeline `|>`, quick win).
4. **B2** (immutable data — the headline sharp-turn feature; biggest effort).
5. **B3** (actors — build v0→v3 first; huge, multi-stage).
6. **Phase C** memory-model completion, interleaved as B2's rc/transients land.
