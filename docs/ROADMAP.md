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
- **v4:** selective `receive` + save queue + timeouts. **v5:** work-stealing, dirty pool,
  epoll/kqueue **async IO poller** (park actors as WAITING, wake on readiness).
- **Good tracebacks (the JS-async fix):** on crash emit ONE record — pid+name, reason +
  synchronous stacktrace, **the triggering message**, state snapshot, supervisor + restart
  decision. Tag every message with origin pid for a causal chain.
- Tests: OTP-style **kill-and-assert-restart** (fault injection built in) + property-based random
  command sequences (only pairwise send-order guaranteed).

---

## Phase C — Finish the memory model

- **Make objects and strings linear** (currently never-free placeholders like the old array
  path): move-check + deterministic drop, as arrays already have.
- **Drops for nested-scope and temporary values** (block-scoped drop points / drop flags for
  conditional moves) — arrays currently only drop top-level owned locals.
- **Move-out-of-borrow / array-element** (`E0507`/`E0508` analogues).
- Reconcile with B2/B4: reference counting + transients supersede parts of this; decide the final
  model (linear ownership for uniquely-owned, rc for shared-immutable).

---

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
  term goal is to compile the compiler with itself once the language subset is rich enough.

---

## Suggested order

1. **A1** (dynamic value + runtime typecheck → `json-roundtrip` + #4).
2. **A2** (nullable/optional → `optional-chaining` → gap **55/55**).
3. **B1** (pipeline `|>`, quick win).
4. **B2** (immutable data — the headline sharp-turn feature; biggest effort).
5. **B3** (actors — build v0→v3 first; huge, multi-stage).
6. **Phase C** memory-model completion, interleaved as B2's rc/transients land.
