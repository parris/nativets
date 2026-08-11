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
- ✅ **…and unbound CLASS-INSTANCE temporaries** — the half Stage 41 never wired, and a
  correction to the "still open" line below, which read as if chain temporaries were done.
  They were done for ARRAYS only: a class call takes a different dispatch branch
  (`C.m(inst, …)` through `genUserCall`), so it never reached `freeReceiverTemp`. Measured on
  main, same position, same loop: `[1,2,3].indexOf(2)` × 200 → `__arrLive() === 0`;
  `new P(7).get()` × 200 → `__objLive() === 200`. Now 0. What proves the drop safe is not the
  array rule's pointer check (`out.v === recv.v` is blind across a lowered call, which returns
  a fresh SSA name) but the STATIC return type: `this` is parameter 0, i.e. a BORROW, so
  storing it is already NT1604, and the one sanctioned way it leaves the body is `return this`
  — which forces the method's return type to be the receiver's class. Still open by the same
  rule, and named in `test/drops-obj.test.ts`: a method that returns its receiver (every
  `@@mutable` field-assigning method, *including one declared `: void`*), a union/`Dyn` return,
  and a receiver that is not syntactically `new C(…)`.
- ✅ **Move-out-of-borrow / array-element** (`E0507`/`E0508` → NT1604/NT1605, Stage 28).
- Reconciled with B2/B4: **linear ownership for uniquely-owned handles, refcounting for
  shared-immutable storage** (trie nodes, strings) — and `rc == 1` is what licenses transients.
- ✅ **CLOSURE ENVIRONMENTS, for the non-escaping case** — and this one was the largest of the
  leaks in a compiler written with closures, which is why it is called out rather than folded
  into the line below. Every arrow bound to a value allocates an env (`nt_obj_new(1 + caps)`) and
  NOTHING freed one, so a bound arrow inside a 100-iteration loop leaked 100 envs: unbounded, and
  invisible to `test/hof-drops.test.ts`, which measured `__arrLive()` only (an env is an object;
  `__arrLive()` reads 0 for every shape of this bug). It is the standing cost of the `isArrayTy`
  wild-free fix — see docs/divergences.md — which removed function types from the drop set
  entirely because freeing an env as an ARRAY frees two words past a headerless block.
  `test/closure-env-drops.test.ts` puts them back on both halves of what that requires: freed as
  the OBJECT it is (`nt_obj_free`, shallow — capture slots alias values the enclosing scope still
  owns and drops), and only where a purely SYNTACTIC rule proves unique ownership — a
  `const f = <arrow literal>` whose name is used only as the callee of a direct call.
  **Still leaked, by that rule:** a closure that is returned, aliased (`const g = f`), passed as
  an ARGUMENT (the callee's escape behavior is not summarized anywhere — the widening that would
  buy the most), stored in an array/object/field, or mentioned inside another arrow's body; a
  binding whose initializer is a CALL rather than a literal; and a bound arrow inside an inlined
  HOF callback, which the ownership pass marks droppable but whose drop marker sits after the
  callback's `return` (the same codegen gap `test/hof-drops.test.ts` already pins for arrays).
  Re-adding function types to `isLinearTy` is NOT the way to widen this: measured, the naive
  version frees the escaping-counter idiom's env and exits 255.
- **Closed:** `break`/`continue` out of a block. Both jumped straight to the loop label, past the
  trailing `BlockDrops` marker, so every linear local of every block they left leaked — and since
  `break` is the mandatory terminator of a `switch` case, that was the ordinary shape, not an edge
  case. `codegen.ts` now keeps a `blockScopes` stack mirroring the ownership pass's, and a jump
  unwinds every scope between itself and its target (`test/break-drops.test.ts`, measured at two
  scales: switch-break 100→1000 and continue 100→1000 became 0/0). Loop entries carry SEPARATE
  break and continue depths, because a `switch` inherits the enclosing loop's `continue` target.
- **Closed:** a `break`/`continue`/`return` that CROSSES a `finally` now runs it. Two silent wrong
  answers, both exiting 0 with output short by a line. `break`/`continue` branched straight to the
  loop label past the finalizer entirely (`for (…) { try { break } finally { log("fin") } }` — node
  prints `fin`, we printed nothing); `return` went through the finalizer's mode dispatch and was
  believed correct, but with TWO nested finalizers the inner dispatch did the `ret` itself, from a
  block sitting inside the outer `try`, so the outer finalizer was skipped. The finalizer dispatch
  now carries one id per crossing exit and CHAINS: the resume block after finalizer N finishes the
  unwinding N was blocking, then hands the exit to N-1, innermost first, and the drops interleave
  with the finalizers rather than all running first. A finalizer that completes abruptly itself
  emits no dispatch at all, which is ECMAScript's `UpdateEmpty` (the inner completion overrides the
  pending one) falling out for free — checked against node, both directions. `test/finally-jump.test.ts`.
- **Still open, and MEASURED:** a `return` inside a `try` that has a `finally` frees **nothing**.
  The ordinary return path is `coerce` → `emitDrops(s.drops)` → `ret`; the finally path stashes
  the value, stores mode 1 and branches, and neither it nor the dispatch that finally does the
  `ret` emits a drop. Every owned local of the frame leaks, once per call: **200 calls → 200,
  2000 → 2000**, with the same function minus the `finally` at 0 and the same function with a
  `catch` and no `finally` at 0 (`test/finally-jump.test.ts`, which ASSERTS the leaking numbers
  so the day it is fixed the pin goes red). The drops cannot simply move to the return site — the
  finalizer may read those locals, so that trades a leak for a use-after-free. They belong in the
  block that does the `ret`, which is shared by every `return` in the `try` while each carries its
  own `s.drops` and its own string-transfer decision, and which now also has to survive the
  forwarding chain through nested finalizers. That is a stage, not a line.
- **Still open:** values escaping through a `throw` out of a block, temporaries
  in non-chain positions (call arguments), chain temporaries whose method hands the receiver
  back, array/object ELEMENTS (an array does not recursively
  free what its slots point at), module-level bindings a function may have aliased, and the
  escaping closure envs above. All are
  leaks by construction, never a double free or a dangling pointer.

### PERFORMANCE FOLLOW-UP — the immutable-first answer to `.push` (owed)

**What was legalized.** `.push` on an array binding declared `@@mutable`
(`//@@mutable let xs: T[] = []`) is a real in-place append. Everything else stays `NT1606`
(`docs/decorators.md`, `docs/divergences.md`, `test/push-accumulator.test.ts`).

**Why — and it is NOT because the immutable idiom is slow here.** `xs = [...xs, v]` is already
O(1) amortized in nativets via the transient path. It is O(n) per append **under bun**, and bun is
**stage 0**: it runs `src/*.ts` and the whole test suite today, and `src/*.ts` has to satisfy both
toolchains at once. 30,000 appends, measured on this tree:

| idiom | bun | nativets |
|---|---|---|
| `xs = [...xs, v]` | 760 ms | 4 ms |
| `xs.push(v)` | 2 ms | 0 ms |
| builder object + `.build()` | 632 ms | 20 ms |

`lex`'s `tokens` reaches ~35,000 elements on `src/checker.ts` alone (1.1 ms vs 1150.9 ms
end-to-end, the 1036x figure in `docs/self-hosting.md`). Converting the 13 sites in `lex` would
have cost ~6 s per full-tree lex.

**What the eventual immutable-first answer is.** A **transient BUILDER** — `immutable.js`'s
`withMutations` / Clojure's `transient`/`persistent!`: a linear, single-owner handle that appends
in place and is *frozen* into an immutable value by `.build()`, with the type system making the
builder unusable afterwards. That is the shape that ends this trade, because it expresses
"uniquely owned right now, shared forever after" **in the type**, rather than in an attribute on a
binding. It was measured here and lost on today's constraints, not on its merits:

- it is a **185-site source rewrite**, against zero for the opt-in;
- it is **still 632 ms under bun**, because a builder written in the subset has to spread
  internally — it only wins once bun is no longer stage 0, or once the builder is a *runtime*
  primitive with a bun-fast implementation.

So the follow-up is not "make `.push` faster". It is: **once nativets compiles itself, re-evaluate
whether the `@@mutable` accumulator should be replaced by a builder type**, and if so do the
rewrite then, when only one toolchain has to be satisfied. Until that day the opt-in is the
deliberate, documented trade — an opt-in beside the immutability rule, not a relaxation of it.

#### THE OPT-IN IS NOW APPLIED TO `src/` — and that was the whole "array mutation" blocker

The opt-in shipped but nothing in `src/*.ts` carried it except `lex`'s `tokens`. A later probe
then reported "NT1606 array mutation, 60 functions" as the single largest self-hosting blocker
bucket and asked for `.push` to be **legalized**. The premise was wrong twice over: the sanctioned
answer already existed, it was simply **unapplied**, and applying it needs no compiler change at
all — `//@@mutable` is a comment, so `bun` is unaffected and there is no second toolchain to
satisfy.

**43 accumulator declarations are now marked** across `parser.ts` (30), `checker.ts` (4),
`driver.ts` (5), `codegen.ts` (4), `modules.ts` (1) and `coverage.ts` (1), plus one comma
declaration split in two (`@@mutable` names ONE binding, so `const folded = [], inline = []` was
`NT1023`). `planFormatString`'s `pieces` is deliberately left UNMARKED — see the captured
accumulator item below.

**Measured with `bun run test/blocker-metric.ts`** — the canonical per-function count over the
LINKED stage-1 program (`src/cli.ts` + its whole import graph), which is the metric that matters
rather than the per-module rung table. Both rows on the same merge base, the "before" side taken
with `git checkout main -- src/` (NOT `git stash`, which silently no-ops once the work is
committed and so cannot fail):

| | functions | failing their own body check | NT1606 |
|---|---|---|---|
| before | 647 | **300** (46.4%) | 116 |
| after | 649 | **279** (43.0%) | 86 |

**30 of the 116 NT1606s are gone and 21 functions closed outright.** The two numbers differ
because a first-blocker instrument always overstates what one bucket is worth: clearing the
NT1606 in a function often just exposes the next code down. The two added functions are
`fieldRootName` / `borrowedFieldRoot`, both inside the subset.

**Read that "after" NT1606 count carefully.** It is 86, not 116 − 30 = 80: the same change also
fixed `isLinearTy`'s `import("./ast.ts").Ty` annotation (unresolvable, so the parameter typed as
`number` and every call was `NT2001`), which unblocked functions whose NEXT blocker is an NT1606
nobody had ever reached. Bucket totals move under each other; the failing-FUNCTION count is the
number to track — and it cannot see leaks, call-site fitting or codegen defects at all, so it is
a progress report and never the test of whether a fix is worth landing.

**The remaining NT1606 debt, by sub-bucket** — none of it is "`.push` is refused", and each needs
a different answer:

- **`Map`/`Set` mutator result discarded — 51, the largest.** Not an array problem at all:
  `Map`/`Set` here are PERSISTENT (§A), so `m.set(k, v)` as a statement is a no-op and is refused.

  > **RE-MEASURED, and the paragraph that used to be here was wrong in both directions.** It
  > said "23 local receivers, 23 `this.<field>`, 3 `.delete`" and that the rewrite
  > `m = m.set(k, v)` is "correct under both". Classifying all 51 by their enclosing signature
  > gives **26 `this.<field>`, 12 an out-PARAMETER, 12 true locals, 1 a field of a local, and 1
  > (`(inArrow ? closure : direct).add(…)`, checker.ts) that names no binding at all**.
  >
  > **The `this.<field>` half needs nothing built** — `//@@mutable class` + `this.f = this.f.set(k, v)`
  > compiles today and matches node. Same story as the array bucket one section up: the
  > mechanism existed and was unapplied. Do not design a "mutable class field" feature for it.
  >
  > **The out-PARAMETER group is the real blocker, and the recommended rewrite is a silent
  > wrong answer there.** A parameter is a borrow, so `out = out.add(n)` cannot reach the
  > caller: node prints 3, we printed 0, exit 0 both sides. That is now refused (§A), and the
  > `NT1606` hint — which recommended it verbatim for every receiver — is receiver-aware. The
  > sanctioned spelling is a local seeded from the parameter, returned, rebound at the call site.
  >
  > `.delete` is a **third**, independent problem in the opposite direction: it breaks under
  > **bun** (boolean), where the out-parameter rebind breaks under **nativets**. No single rule
  > covers both.
- **`.push` on `this.<field>` — 14, plus 1 on `b.lines` (a field of a local)** (was 38 sites
  tree-wide). Unchanged: a field
  names no binding. `this.f = [...this.f, v]` compiles on a `@@mutable` class and is O(1)
  amortized here, but it is O(n) per append **under bun**, which is exactly the trade this whole
  section exists to avoid — `codegen`'s `this.blocks[this.cur].lines.push` runs once per IR line.
  Still needs the class-field analogue of the binding attribute.
- **object/element field mutation (`e.ty = v`, `fields[i] = v`) — 12.** The `@@mutable` RECORD
  lane already measured this one: 81% of field writes expressible, and NO new module compiles.
- **`.pop` / `.shift` / `.unshift` / a fresh `.sort()` — 4.** The opt-in legalizes `.push` ONLY.
  (`readdirSync(…).sort()` is in here: a HOST call's result is not `freshArray`, since a plain
  callee may still own what it returns.)
- **an accumulator PARAMETER — 3** (`Checker.addFact(…, out: NarrowFact[])`,
  `directBound(…, out: string[])`, `declaredLinear(…, out)`). The per-parameter `@@mutable` covers
  the shape; the marker has to travel to every call site, and `addFact`'s `out` is passed from
  inside an arrow (`const go = (x) => this.assertFacts(x, scope, out)`).
- **a CAPTURED accumulator — 1 here, and the reason `planFormatString` is left unmarked.**
  `const push = (text) => { pieces.push(…) }` is `NT1607`, not `NT1606`: an arrow copies the array
  pointer into an env this scope cannot null. Marking it would trade one refusal for another while
  making this checker-only instrument report the function as CLEAN — the instrument does not run
  the ownership pass, so a mark that only moves the blocker downstream is a mark that lies. The
  same shape is all of `src/modules.ts`'s. Needs closure ESCAPE analysis, not a wider attribute.

### Why ELEMENTS is not a one-line fix (measured, `test/drops-obj.test.ts`)

Shapes that leak today, all by the same mechanism — `nt_obj_free` is `free(o)` and never walks
the slots: object-in-object (`__objLive() === 1`), object-in-array (`objLive 1`, and **`__arrLive`
reports 0** — it counts headers, so it cannot see this class at all), array-in-object (`arrLive 1`),
a discriminated-union member's object field, and a `@@mutable` record's object field. Nesting
depth 3 leaks 2. Refcounted string slots do *not* leak this way — **but see the correction
below: they leak a DIFFERENT way, and this sentence was read as covering that.**

**CORRECTION 2026-08-11 — a loop-local heap STRING is never freed, one per iteration.**
Measured on pristine `main`, `for(;;)`, `for-of` and `while` alike:

    +10 iterations -> +9 live      +400 -> +399      +50000 -> +49999

An **array** in the identical position is freed correctly (`+0` at both scales), so this is
specific to the refcounted-string path and not to block drops. The sentence above is true
about the shallow-free class it describes and **false as a general statement about strings**,
which is how the leak survived — `isLinearTy` deliberately excludes `string` on the grounds
that RC handles it, and RC does handle it *at frame scope*, releasing once at function exit
rather than once per iteration (hence n-1, not n). Silent on macOS: LeakSanitizer is
Linux-only. The fix belongs in codegen's `emitStrDrops`, not in `isLinearTy`.

**A NULLABLE box is a stronger case than any of these, and it is not on the list above because
it never reaches a drop at all.** `isLinearTy` (src/ownership.ts) is
`isArrayTy || isObjectTy || isUnionTy || isTypeRefTy` — a nullable is none of them, so a
`[tag, value]` box is in NO scope's drop set anywhere: 100 loose `string | null` locals in a
loop measure `__objLive() === 100`, with no nesting and no array involved. That makes an array
of nullables (`(string|null)[]`, landed with the paren element encoding — see
docs/self-hosting.md) leak its boxes for TWO independent reasons, and it is why the array case
is a leak and provably not a double free: the box is never freed once, so it cannot be freed
twice. Both measurements are pinned in `test/nullable-element.test.ts`, the loose baseline
included, so the day nullables become linear the array case is already watched.

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

> **THE BLOCKER LIST IS ELEVEN, NOT TWO, AND THE OTHER NINE ARE ARRAY METHODS.** The two above
> are the OBJECT-shaped ones. Measured by splicing a depth-1 element destructor into `emitDrops`
> and running the result under ASan: `.map(x => x)`, `.filter`, `.slice`, `[...xs]`, `.concat`,
> `.toSorted`, `.toReversed` and `.with` each produce an `attempting double-free`, and so does an
> array built from a field read inside a LOOP (`for (…) { const xs = [o.inner]; }`). All eight
> methods build a new array by copying slots, so one set of element pointers ends up in two
> headers that are both dropped; none of them involves a callback, so an ownership rule about
> arrow results — the guard docs/divergences.md proposes for `.map` — closes exactly one of
> them. Each needs to deep-copy, consume its receiver, or be refused on a linear element type.
> Pinned as allocation counts in `test/drops-obj.test.ts`, "array methods that ALIAS elements".
>
> The escape-BY-NAME shapes are already refused and need nothing (`NT1605` for `const e = xs[0]`
> and `return xs[0]`, `NT1604` for a borrowed parameter stored into a local array, `NT1601` for
> one object named by two arrays) — which is the good news, and the reason the list is methods.
>
> **The measurement also found a shape that is WORSE than a double free, and it is the one the
> gate could not see.** A block-scoped array holding a field read (`{ const xs: B[] = [o.inner]; }`
> then `o.inner.v`) freed the field and read it back: node `10`, nativets `5`, **exit 0 on both
> sides**, and ASan reported the run CLEAN. See "the sanitizer never watched the generated code"
> below — anyone building the destructor must fix the gate first, or they are working blind on
> precisely the fault they are most likely to introduce.

### The sanitizer never watched the generated code (fixed: `NATIVETS_ASAN=1`)

`clang -fsanitize=address` instruments `runtime/*.c` and **nothing else**. ASan is an LLVM pass
that only rewrites functions carrying the `sanitize_address` attribute; clang stamps it on code
it compiles FROM SOURCE, and the `.ll` nativets emits arrives already in IR form with no
attribute on any `define`. So every load and store the compiler generates was left bare, and the
gate was asymmetric in the worst possible direction:

| fault | caught before? | why |
|---|---|---|
| double free | **yes** | detected inside `free()`, an allocator interceptor — it never asks who called |
| heap-use-after-free | **no** | needs a poison check on the READ, and the read is in uninstrumented code |

That is why every ASan finding in this repo's history has been a double free or a crash and never
a stale read: a use-after-free READ, which returns garbage at exit 0, was invisible to the one
instrument meant to catch it. It is also the fault an ownership lane is most likely to ship —
every rule in `ownership.ts` exists to stop one name reading what another name freed.

`NATIVETS_ASAN=1` now emits `sanitize_address` on every generated function (`asanOn`,
src/codegen.ts). It is inert without `-fsanitize=address`, and opt-in only so IR snapshots do not
move. **Set it in any lane that builds with ASan.** Pinned in `test/asan-instrumentation.test.ts`,
including the negative control (a double free is caught either way) and the same UAF being missed
without the attribute and reported with it.

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
