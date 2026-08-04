# Phase 2 design notes (the "sharp turn" away from TS)

Distilled from research into Elixir/Erlang (immutability, BEAM). Drives three features:
immutable-by-default data, a pipeline operator, and BEAM-style actors.

## 1. Immutable-by-default data + structural sharing

**The key answer:** updating a nested immutable structure does **NOT** copy the whole tree. Only
the nodes on the **path from root to the changed leaf** are copied (path copying); every untouched
sibling subtree is shared by pointer. Safe precisely because nothing is ever mutated in place.
Cost = O(depth), not O(size). (`user.roles === user2.roles` still holds after a deep update.)

**Don't use one universal structure — split by size** (BEAM's biggest lesson):
- **Records/objects, small tuples** → flat contiguous slot arrays, shallow-copy-on-update (O(1)
  access). Struct-update `{...s, f: v}` shares the field-layout descriptor, copies only values.
- **Small maps/sets (≤ ~32)** → sorted flat key array + parallel value array; a value-only update
  **shares the key array**.
- **Large maps/sets (> 32)** → **HAMT** (hash array mapped trie): bitmap + popcount sparse nodes,
  16- or 32-way (4/5-bit hash slices). get/put O(log32 n) ≈ O(1). Emit `llvm.ctpop`. Handle
  full-hash collision nodes. Sets = HAMT with keys only.
- **Arrays/vectors** → **32-way bit-partitioned vector trie + tail buffer** (Clojure
  PersistentVector). Index = pure shifts/masks `(i >> shift) & 31`; get/update O(log32 n) ≈ O(1);
  append O(1) amortized (tail absorbs 31/32). RRB-trees only if O(log n) concat/slice is needed.
- **Lists** → cons cells; O(1) shared-tail prepend.

**Memory:** immutable DAGs are acyclic → **atomic reference counting is complete** (no cycle
collector). Exploit **rc==1 ⇒ mutate in place** (Clojure transients / Perceus / Swift CoW) for
fast bulk builds (literals, comprehensions). This fits our existing linear-ownership direction.

**Testing:** model-based property tests — run random op sequences against a trivial reference
model (assoc-list / plain array), assert agreement + structural invariants
(`popcount(bitmap)==len(children)`, uniform leaf depth). **Bias generators to the danger zones**:
the flat→trie boundary (~32) and hash collisions — where real HAMT bugs live.

**For nativets specifically:** we already have flat arrays (`nt_arr_*`) and flat objects
(fixed slot block). Step 1: make their update operations return NEW values (copy-on-write) instead
of mutating — `.push` etc. become non-mutating (return a new array). Step 2: swap the flat backing
for HAMT / vector-trie past a size threshold, with structural sharing. Step 3: rc-based sharing +
transients.

## 2. Pipeline operator `|>`

`x |> f(a)` ≡ `f(x, a)` (Elixir threads the LHS as the **first** argument). Lowest precedence,
left-associative. Pure desugaring in the parser: `a |> f(b) |> g(c)` → `g(f(a, b), c)`.
Cheap, high-value, no runtime.

## 3. BEAM-style actors + supervision

**Four reinforcing decisions:** millions of cheap isolated processes (per-actor heap) · message
passing by **deep copy** (no shared mutable state ⇒ no data races) · **preemption by reduction
counting** (compiler emits a budget decrement + check at call sites / loop back-edges) ·
links/monitors + **supervision trees** (crash → discard corrupt state → restart to known-good).

**Minimal native runtime (build order):**
- v0: `spawn(fn,args)->pid`, `send(pid,msg)` (MANDATORY deep-copy), blocking `receive`; single
  cooperative scheduler + run queue; `self()`, pid registry.
- v1: reduction-counted preemption (LLVM-emitted safepoints) + N scheduler threads (M:N), lock-free
  MPSC mailboxes.
- v2: `link`/`monitor` + exit-signal propagation (`trap_exit`).
- v3: `one_for_one` supervisor + restart intensity (default 1 restart / 5 s → escalate by self-exit).
- v4: selective receive + save queue + timeouts. v5: work-stealing, dirty pool, epoll/kqueue IO poller.

**Data structures:** Actor = {pid, state, MPSC mailbox, save_queue, private heap/arena, reductions,
links, monitors, trap_exit, entry-MFA-for-restart}. Scheduler = {run_queue, current, poll_set}.

**"Good tracebacks" (better than JS promises):** on crash, emit ONE record: actor pid+name ·
reason + **synchronous** stacktrace (a crash is contained in one actor → a real call stack, not an
async patchwork) · **the triggering message** (the field JS traces lack) · state snapshot ·
supervisor context + restart decision. Tag every message with origin pid for a causal chain.

**Why cleaner than JS async:** every async unit IS a supervised, isolated process; failures are
localized events delivered to a designated owner, not unhandled rejections floating unowned.

**Testing (OTP-style):** example-based *kill-and-assert-restart* (fault injection built in from day
one) + property-based *random command sequences with shrinking* (PropEr statem). Only **pairwise**
send-order is guaranteed — encode that in tests.

Sources: theBeamBook, erlang.org (maps/message-passing/supervisor), Bagwell (HAMT/RRB),
hypirion (PersistentVector), immer, jlouis "Breaking Erlang Maps".
