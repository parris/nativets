# nativets

A **memory-safe TypeScript → LLVM → native** compiler, built from scratch, grown
**red-green-refactor** against real behavioral tests with `node` as the oracle.

> Write ordinary TypeScript. Get a small, fast, memory-safe native binary — for
> macOS, Linux, **iOS, and Android** — with no Node, no V8, no JS engine in the output.

This is the sibling-in-spirit of `vercel-labs/scriptc`, but it (a) targets **LLVM IR**
directly instead of C, (b) is **memory-safe by construction** via a tracing GC, and
(c) treats **iOS/Android arm64** as first-class build targets (LLVM's whole point is
retargeting).

---

## The prime directive: match `node`, byte-for-byte

The specification for what a program *means* is **what `node` prints when it runs it.**
Every correctness test compiles a `.ts` file to a native binary, runs it, and asserts
its stdout + exit code equal `node <file>`. If we disagree with node, **we are wrong**
(until we deliberately document a divergence).

This makes the TypeScript conformance suite an (eventually) drop-in corpus: any `.ts`
case that node can run is a case we can differential-test.

---

## Architecture (the pipeline)

```
source.ts (entry)
  │  src/lexer.ts      hand-written tokenizer (no `typescript` dependency)
  ▼
tokens
  │  src/parser.ts     recursive-descent + Pratt expression precedence
  ▼
AST (src/ast.ts)
  │  src/modules.ts    resolve `import`/`export` → merge the graph into ONE Program
  ▼                    (whole-program link; no-op for a module-less file)
AST (src/ast.ts)
  │  src/checker.ts    scope resolution + static type inference (number|boolean|string|void)
  ▼
checked AST
  │  src/codegen.ts    lower to LLVM IR *text* (.ll)
  ▼
module.ll
  │  src/driver.ts     clang out.ll runtime/runtime.c  → native binary
  ▼                    (swap -target / -isysroot for iOS / Android)
./a.out
```

Key deliberate choices:

- **Hand-written frontend, no `typescript` npm dep.** We own the lexer, parser, and
  checker. Slower to first green, but self-hostable and fully under our control.
- **Emit LLVM IR as text**, compiled with `clang` (v21, already installed). We do **not**
  need `llc`/`opt`/`llvm-config` — clang consumes `.ll` directly.
- **All JS numbers are IEEE-754 `double`.** IR uses `double` throughout. Float literals
  are emitted as exact **hex** (`0x…`, 16 digits) so LLVM never rejects an
  unrepresentable decimal. Number→string uses shortest-round-trip to match node.
- **Opaque pointers only** (`ptr`, never `double*`) — required by LLVM 21.
- **Static typing.** The checker infers a type for every expression (`number` → `double`,
  `boolean` → `i1`, `string` → `ptr` to NUL-terminated UTF-8, `void`). Codegen is
  type-directed. Function signatures come from TS annotations (`n: number`); node strips
  them so the oracle still runs. Unannotated params/returns default to `number`.
- **Memory model — see the dedicated section below.** Today: allocate-and-never-free
  (safe, but leaks). Chosen direction: **linear / explicit-move ownership** (no GC, no
  manual free). Not yet enforced.
- **Banded diagnostics (`src/diagnostics.ts`), borrowed from scriptc.** Unsupported-but-valid
  TS is rejected with an `NT1xxx` code + milestone + hint (`NYI` catalog) — **never
  miscompiled**. `NT0xxx` parse, `NT2xxx` type errors, `NT9xxx` ICE.
- **`nativets coverage <file>` (`src/coverage.ts`), also from scriptc.** Reports whether a file
  compiles statically plus a histogram of blocking features by code/milestone/frequency — a
  gradient, not a wall.

---

## Build targets

All targets **fully link** `runtime/runtime.c` (libc-only, so it builds everywhere) and
are verified by **actually running** where a device is reachable:

| Target  | Toolchain | Verified by |
|---------|-----------|-------------|
| macOS arm64 (host) | `clang` | ✅ RUN — the differential/conformance oracle |
| iOS-sim arm64 | `clang -target arm64-apple-ios-simulator -isysroot $(xcrun --sdk iphonesimulator …)` | ✅ RUN via `xcrun simctl spawn <booted>` |
| iOS arm64 (device) | `clang -target arm64-apple-ios -isysroot $(xcrun --sdk iphoneos …)` | ✅ links; arch-checked (`file` → arm64 Mach-O). Needs a device+signing to run |
| Android arm64 | NDK `aarch64-linux-android<API>-clang` | ✅ RUN via `adb push` + `adb shell` on an `arm64-v8a` emulator |

The cross-execution tests (`test/cross.test.ts`) skip gracefully when no emulator/
simulator is up, so the suite stays green headless; when one is up they are hard gates.

---

## Memory model

Constraint (owner's decision): **no tracing/refcount GC, and no manual free.**

- **Today (placeholder): allocate-and-never-free.** `nativets_alloc` → `malloc`, nothing is
  freed. Memory-*safe* (no use-after-free / double-free / dangling) and zero-dependency so
  the runtime cross-links unchanged — but it **leaks** for the process lifetime. Fine for
  short runs; wrong for long-lived apps. This is a placeholder, not the destination.
- **Chosen destination: linear / explicit-move ownership (Rust-in-spirit, compile-time).**
  Heap values (arrays, objects, and eventually strings) have a **single owner**; `move(x)`
  transfers ownership; **use-after-move is a compile error**; borrows give scoped read
  access; and an owned value is **freed deterministically at scope exit** (RAII/drop) — no
  runtime GC, no manual free. Anything the analysis can't prove single-owner (arbitrary
  aliasing, cycles, shared mutation) is **rejected with an `NT16xx` diagnostic**, never
  leaked or refcounted — the same reject-don't-miscompile discipline as everything else,
  surfaced by `coverage`.
- **Why not a borrow checker over idiomatic TS?** TS has no ownership/borrow annotations and
  shares/aliases freely; a borrow checker needs information the programs don't carry. So the
  linear model **restricts the accepted subset** to what's provably single-owner and refuses
  the rest (documented via `coverage`), rather than silently falling back to GC.
- **Status (in progress).** The **move checker** (`src/ownership.ts`) is a separate dataflow
  pass over the checked AST (modeled on rustc's borrowck): arrays are the linear type;
  scalars/strings are `Copy`/shared; binding/returning/`move(x)` consume, while method calls /
  indexing / `.length` / `for-of` borrow. It reports **`NT1601` use-of-moved** (≈ E0382) with
  move/use line spans, handling control-flow merges and loop fixpoints, and **blocks
  compilation**. **Deterministic drop is implemented**: the ownership pass computes the owned
  linear locals at each `return` and at fall-through exit (`ReturnStmt.drops`, `endDrops`), and
  codegen emits `nt_arr_free` there — move-aware, so a value is freed **exactly once** by its
  final owner and never a moved-out value. This **removes the leak for owned arrays** with no
  GC and no manual free (verified via the `__arrLive()` counter and by running on Android/iOS).
  Drop is conservative: only linear locals declared at a scope's top level are dropped
  (conditionally-created / temporary arrays are not yet freed — safe, may leak). **Borrows are
  implemented for `for-of`:** the loop borrows its array for the body, so mutating it
  (`NT1603` ≈ E0502, iterator invalidation) or moving it (`NT1602` ≈ E0505) inside is rejected.
  Drops now also cover **nested blocks, reassignment, temporaries and conditionally-moved values**
  (Stage 41 — see the ledger and `docs/ownership.md` for the drop-point table and the four
  remaining, deliberate, leak-not-dangle boundaries). **Still to do:** general borrows beyond
  for-of, and recursive drops for container *elements*.

## The red-green-refactor loop

1. **RED** — Add `.ts` fixture(s) for the next capability under `test/fixtures/<stage>/`.
   They fail (compiler can't handle them yet). Every fixture is authored to run under
   plain `node` too, so the oracle is always defined.
2. **GREEN** — Grow the *minimum* lexer/parser/checker/codegen to make them pass.
3. **REFACTOR** — Clean up with the suite green. Never expand scope during refactor.

**Never widen a stage's scope without asking** which tests to write for it first — the
test list *is* the spec for the stage.

### One test at a time — don't batch the RED

Do **not** author all of a stage's fixtures up front and then start coding. Work the loop
**one behavior at a time**: write a single failing test → run it → make it green → run the
suite → refactor → only then write the next test. Each green test is a checkpoint you never
regress past; a large batch of pre-written reds hides which change broke what and tempts
over-building ahead of the evidence. The *ordered list* of behaviors is the spec (agree it
first); the *tests themselves* are added and closed one by one against a running oracle.

### Steal the test corpus from a reference implementation

Whenever a feature already has a canonical, well-tested implementation, **mine its test
suite for our ordered behavior list and expected values** rather than inventing cases from
scratch — the reference has already found the edge cases we'd miss. Map each borrowed case
to a node-runnable `.ts` fixture (node stays the oracle). Known references per area:

- **Immutable data / structural sharing** → `immer`, `immutable.js`, Clojure
  `PersistentVector` (hypirion articles), Bagwell **HAMT**.
- **Ownership / borrow / move-out** → **rustc** `compiletest` UI tests (the `E0xxx` corpus
  we already mirror as `NT16xx`).
- **Actors / supervision** → **Elixir/Erlang OTP** (GenServer/Supervisor kill-and-restart
  patterns, PropEr `statem`).
- **Runtime typechecking / validation** → `zod`, `io-ts`; **JSON** parsing →
  `nst/JSONTestSuite`.
- **Optional chaining / nullable / pipeline** → the **TypeScript** conformance suite and the
  **TC39 / Elixir** pipeline semantics.

Bias the borrowed generators to the reference's known danger zones (e.g. the flat→trie
size boundary ~32 and hash collisions for HAMT).

### Parallel integration — merge hygiene (SMOKE-TEST before you commit a merge)

When integrating parallel worktree agents, **a green branch is not a green merge** — a merge (esp.
after resolving conflicts) can introduce breakage that neither side had. The classic one: two lanes
each append the *same* `declare` line / `case` to a shared list, and the 3-way merge keeps **both**,
producing a duplicate — e.g. `invalid redefinition of function` from LLVM, which breaks **every**
build even though both branches were green. So, after every merge:

1. **Before committing the merge**, run a **smoke build** — `bun run src/cli.ts run <trivial.ts>`
   (`console.log("hi")`). If a merge duplicated a `declare`/`case`/symbol it fails here instantly,
   before it's in history. (Also grep the merged `DECLARES` / `genGlobal` for duplicates:
   `grep 'declare ' src/codegen.ts | sort | uniq -d`.)
2. Then run the **feature tests** for the merged lane, then the **full suite** (`bun test`), checking
   REAL (non-snapshot) failures only.
3. Regenerate IR snapshots **once** after all codegen-touching lanes for a round have landed (not
   per-merge) — `bun test --update-snapshots` after behavior is re-verified.
4. **Shared hot spots** to merge carefully: codegen `DECLARES` + `genGlobal`, `driver.ts`
   `toolchainFor`/`linkArgv` (targets + conditional links), `checker.ts` `GLOBAL_FUNCS`, `ast.ts`
   type predicates. Prefer resolving host-io/shared duplication to **one** canonical copy (main's),
   keeping only each lane's genuinely-new additions.
5. Tell each worktree agent to `git merge main` **first** (worktrees can branch from a stale base),
   and to keep additions grouped/additive so these merges stay trivial.

---

## Test taxonomy

Located in `test/`, run with `bun test` (73 tests today).

1. **Differential vs node** (`test/fixtures.test.ts`) — `node case.ts` == `./compiled`.
   The primary correctness gate. Runs over every `.ts` under `test/fixtures/**`.
2. **Curated expected files** — each fixture ships `case.ts.expected`; asserts stdout
   without needing node at test time.
3. **IR snapshots** — `test/__snapshots__/`. A debugging aid that catches codegen
   reshuffles early. **Not** a correctness gate — a snapshot change is a prompt to
   re-verify behavior, never a failure on its own.
4. **Toolchain smoke** (`test/toolchain.test.ts`) — clang builds & runs a trivial `.ll`;
   iOS/Android cross-compiles produce the correct arch. Guards the environment.
5. **Conformance corpora** — `test/conformance.test.ts` (base, `cases.json`) and
   `test/gap.test.ts` (`gap_cases.json`, 55 node-verified cases spanning the gap features).
   Every case that compiles must match node; unsupported constructs are an explicit
   `KNOWN_UNSUPPORTED` allow-list; a minimum-supported count gates against regressions.
6. **Cross-platform execution** (`test/cross.test.ts`) — actually RUN a multi-feature
   program on the Android emulator (`adb`) and iOS simulator (`simctl`), matching node.
7. **Ownership / move checker** (`test/ownership.test.ts`, `test/ownership/*.ts`) — rustc
   `compiletest`-style: `//@ check-pass` must be accepted; `//~ ERROR NT1601` must be
   reported on that exact line, with no unexpected diagnostics.
8. **Modules** (`test/modules.test.ts`, `test/modules/<case>/main.ts` + its imports) — a
   multi-module program cannot be a single source string, so each case is a DIRECTORY with an
   entry `main.ts`. node is still the oracle (it resolves the same `./x.ts` specifiers). The
   file also pins the rejection table: NT1017 module syntax, NT1701/1702/1703 graph defects.

If a divergence from node is intentional, document it in `docs/divergences.md`.

---

## Stage ledger

- **Stage 1 ✅** number literals, arithmetic (`+ - * / % **`), `console.log`, `let`/`const`,
  functions.
- **Stage 2 ✅** `boolean`; comparisons (`< <= > >= === !== == !=`) with correct NaN
  semantics; `&&` `||` `!` (short-circuit, boolean operands); `if`/`else`; `while`;
  numeric/string truthiness; recursion.
- **Stage 3 ✅** `string`: literals, template literals, `+` concat (with number/boolean
  coercion), `.length`, string equality, `console.log(string)`.
- **Stage 4 ✅** C-style `for`; ternary `?:`; `typeof` (compile-time, on typed values);
  `++`/`--` (pre/post); compound assignment (`+= -= *= /= %=`); multi-arg `console.log`.
- **Stage 5 ✅** `break` / `continue` (loop-target stack; nested-loop correct), with an
  unreachable-code guard so IR after a terminator isn't emitted.
- **Stage 6 ✅ (gap features)** `undefined`/`null` (+ `typeof`, printing, coercion); bitwise
  `& | ^ ~ << >> >>>` (correct ToInt32/ToUint32) + their compound assigns; unary `void`/`+`;
  `do`/`while`; `switch` (fallthrough + default); `for-of` over strings; comma operator +
  multiple declarators; default parameters; string `+=`; **builtins** — `Math.*`
  (floor/ceil/round/abs/sqrt/trunc/pow/max/min), `parseInt`/`parseFloat`/`Number`/`isNaN`,
  and string methods (slice/substring/charAt/toUpper/toLower/trim/repeat/padStart/includes/indexOf).
- **Stage 7 ✅ (arrays — M1, part 1)** `number[]`/`string[]`: literals, indexing, `.length`,
  `for-of`, and `.push`/`.pop`/`.join`/`.includes`/`.indexOf`. Backed by a generic 8-byte-slot
  heap vector (`nt_arr_*` in the runtime); codegen bitcasts `number`↔i64 and `ptr`↔i64 through
  the slots. HOF methods (`.map`/`.filter`/`.reduce`) reject `NT1003` (need closures).
- **Stage 8 ✅ (ownership — move checker)** Linear/explicit-move checking for arrays
  (`src/ownership.ts`), modeled on rustc's borrowck + UI tests. `move(x)` / binding / return
  consume; method calls / index / `for-of` borrow. Reports `NT1601` use-of-moved (≈ E0382)
  with line spans; control-flow-merge- and loop-fixpoint-aware; blocks compilation. Corpus in
  `test/ownership/` uses `//@ check-pass` + `//~ ERROR NT1601` like rustc.
- **Stage 9 ✅ (deterministic drop)** Move-aware RAII free: owned linear locals are freed at
  scope exit (`nt_arr_free`), exactly once, never a moved-out value — no GC, no manual free.
  Verified via `__arrLive()` and on Android/iOS.
- **Stage 10 ✅ (borrows / iterator invalidation)** `for-of` holds a borrow of its array for
  the loop body: mutating it inside (`.push`/`.pop`) is `NT1603` (≈ E0502), moving it is
  `NT1602` (≈ E0505); reads are fine. rustc-style cases in `test/ownership/`.
- **Stage 11 ✅ (objects — M1, part 2 → M1 complete)** Structural records: object literals,
  field access (`.f` and `o["f"]`), `Object.keys`, and `for-in`. Object types are encoded
  `{k:t,...}` (insertion order); backed by a fixed heap block of 8-byte slots — field access
  is a **static slot index** (`getelementptr`, no hashmap). `Object.keys`/`for-in` use the
  compile-time keys. Flat objects only (nested objects, spread, destructuring rejected with a
  code). Objects are **not yet linear** (never-free placeholder, like strings) — making them
  linear/dropped is a follow-up.
- **Stage 12 ✅ (array HOF — M2 start)** `.map`/`.filter`/`.reduce` with **inline arrow
  callbacks**. The arrow body is **inlined into the generated loop**, so capturing enclosing
  variables works for free. Callback param types come from the element type (contextual
  typing); `.reduce`'s accumulator type from the initial value.
- **Stage 13 ✅ (first-class functions + closures)** Arrows as **values** — stored in vars,
  passed as args, and function-typed params called generically. Each arrow is **lambda-lifted**
  to `@arrow_N(ptr env, params)`; a closure is a heap block `[fn_ptr, cap0, …]`; captured vars
  live in the env (read/written via `%__clo` slots); calling a function value is an **indirect
  call**. Function types encoded `(t1,t2)=>tr`; arrow param types come from annotations or
  contextual typing at the call/param site. Handles `applyTwice` (higher-order),
  `closure-capture` (variable capture), and **`makeCounter`** — block-body arrows, **mutable
  captures** (persist in the closure slot), **returned closures**, and **closure return-type
  inference** (an unannotated function returning `()=>number`); each closure has independent
  state. **Not yet:** nested function types (`compose` — a function returning a function).
- **Stage 14 ✅ (more builtins + `??`)** `String#split` → `string[]`, `Array#reverse`, and
  **nullish coalescing `??`** (statically resolved: a value is either definitely-nullish —
  `null`/`undefined` type — or definitely not, so no unions needed).
- **Stage 15 ✅ (destructuring)** object (`const {name, age: alias} = o`), array with rest
  (`const [a, b, ...rest] = arr`), and swap (`[a, b] = [b, a]`). Implemented as a **parser
  desugaring**: decls become a multi-declarator `VarDecl` reading a fresh temp (`__d.name`,
  `__d[i]`, `__d.slice(i)` for rest); swap becomes a transparent `MultiStmt`. Added
  `Array#slice`. `MultiStmt` is a scope-less group flattened by every pass.
- **Stage 16 ✅ (spread)** in arrays (`[0, ...a, 4]` → `nt_arr_extend`), calls (`f(...arr)`
  expands to `arr[0..arity-1]`; `f(...[literal])` inlines elements — arity from the callee),
  and objects (`{...base, c, b}` → merged field type + copy base fields then override, storing
  by merged slot index). Tuple type annotations `[T,U]` parse as `T[]`.
- **Stage 17 ✅ (nested objects, rest params, JSON.stringify)** Object types are now
  **nesting-aware** (`splitTopLevel` depth-aware type splitter → `data.user.tags[1]`). **Rest
  params** `function f(...xs: number[])` pack trailing call args into an array (`sig.rest`).
  **`JSON.stringify`** generated recursively from the static type (`js_json_quote` for strings,
  unrolled objects, looped arrays).
- **Stage 18 ✅ (exceptions)** `try`/`catch`/`finally`/`throw` via **structured control flow**
  (no setjmp — throws are lexical, so a `throw` branches to the nearest catch; `finally` runs on
  normal/caught/return paths via a mode flag; `return` inside a try runs finally first). Plus
  `new Error(msg)` (≡ `{message:string}`) and `expr as Type` (identity retype). Catch-var type is
  inferred from the throws in the block.
- **Stage 19 ✅ (nested closures / general function-value calls)** Calling a closure that is
  itself the result of a call (`compose(f,g)(x)`) or a captured function value — generalized
  `genCallValueFrom`. Nested function types work via the depth-aware splitter.
- **Stage 20 ✅ (A1: dynamic value + runtime typechecking → closes `json-roundtrip`)**
  `JSON.parse(s): Dyn` — a runtime recursive-descent parser (scalars, strings incl. escapes +
  `\uXXXX` BMP, objects, arrays; JSONTestSuite-ordered) producing a **tagged heap box** (`NtDyn`).
  Narrowing `dyn as T` emits a **validator generated from the static type** (io-ts/zod semantics):
  scalars unbox with a tag check; objects `require_object` + per-field `require_field` + recurse
  (extra keys stripped); arrays loop-validate each element — building the value in the normal
  repr (nt_obj slot block / NtArray). On a shape mismatch it **throws** (deliberate node
  divergence, `test/typecheck.test.ts`). **Catchable throws**: JSON syntax errors + validator
  failures use a **pending-exception protocol** (raise a flag + message, unwind via sentinel;
  codegen checks `nt_exc_pending()` after fallible calls → branch to the nearest catch or abort),
  so `try/catch` works like node under the lexical CFG model. Un-narrowed `Dyn` field/index
  access (`back.arr[1]`) via runtime tag checks; `console.log(dyn)` prints scalars (compound =
  `util.inspect`, deferred). Also **`|>`** (Stage B1) landed in parallel.
- **Stage 21 ✅ (A2: nullable/optional + optional chaining → closes `optional-chaining`, gap 55/55)**
  Runtime-nullable values (`T | undefined`, `T | null`, optional fields `{a?:T}`) use the
  **tagged-pair encoding** — a 2-slot heap block `[tag, value]` (tag 0=undefined, 1=null,
  2=present), `is_nullish = tag < 2` (tag-based, NEVER truthiness, so `0`/`""`/`false` pass
  through). Ty encoded `?U<base>`/`?N<base>`, kept distinct from object/array/func (predicates
  guard). `?.` short-circuits the **whole rest of the chain** to a shared `undefined` join;
  runtime `??` on nullable operands. Restricted to the two nullable shapes; general/>2-arm unions,
  `?.()`, `?.[]` → `NT1009`. (Also extended `||`/`&&` to value-returning for matching number/string
  operands, per the `??`-vs-`||` test vectors.)
- **Stage 22 ✅ (B3 v0: actors wired into the language)** `spawn(body, msg)`/`send`/`receive`/
  `self` compiled natively on the merged `nt_actor` runtime. A spawned closure becomes an actor
  via a **trampoline** `@nt_actor_entry_N(ptr env, i64 slot)` (reuses the lambda-lift/closure
  machinery; decouples the actor ABI `void(ptr,i64)` from the arrow ABI). `nt_sched_init` prologue
  + `nt_actor.c` linking are **emitted only when a program uses actors** (keeps the Android
  non-actor cross-build working — `ucontext` is absent in NDK API 24). Number messages (v0); the
  `Dyn` deep-copy-on-send path is designed but deferred. Behavioral tests in `test/actors/`
  (native run + exact stdout — not node-differential; the single cooperative scheduler is
  deterministic). v1 preemption / v2 links / v3 supervision still to come.
- **Stage 23 ✅ (Phase C part 1: objects are linear)** Objects join arrays as a linear type:
  `NT1601` use-after-move (control-flow-merge + loop-fixpoint aware) and **deterministic drop**
  (`nt_obj_free` at scope exit, move-aware — freed exactly once by the final owner). Verified via
  `__objLive()` (`test/drops-obj.test.ts`). Strings-linear + move-out-of-borrow (`E0507`/`E0508`,
  NT1604/1605) still deferred — the latter needs `object[]` support first.
- **Stage 24 ✅ (arrays of objects, first-class)** Object array literals + `T[]` where `T` is an
  object type work like any other array (node-compatible; codegen already routed object elements
  through the generic 8-byte slot path — only two `number|string|boolean`-only checker guards
  needed lifting). Object arrays are linear (drop-once via `nt_arr_free`; `NT1601` move-check).
  Note: array element *objects* aren't recursively dropped yet (safe leak, like heap values in
  arrays generally).
- **Stage 25 ✅ (B2 step 3: immutable `Map`/`Set`)** `new Map<K,V>()`/`new Set<T>()` +
  `set`/`get`/`has`/`delete`/`add`/`size`, **immutable/persistent** (ops return a new handle via
  the merged HAMT with structural sharing; the source is unchanged). `nt_mapset.c` wraps `nt_hamt`
  with a **flat scalar ABI** (hand-written IR can't emit the by-value `NtKey` struct); string
  (`NT_K_STR`) + number (`NT_K_NUM`) keys, SameValueZero normalization in the HAMT. `Map<..>`/
  `Set<..>` Ty encodings kept distinct from object/array/func/nullable. Linked only when used.
  Divergences (by design, Phase B): old-version-unchanged is behavioral-tested not node; `.delete`
  returns a new collection (node: boolean); `.get` of an absent key returns `0` (node: `undefined`)
  until Map values gain the A2 nullable machinery.
- **Stage 26 ✅ (B2 step 1: copy-on-write `.with`)** `arr.with(i, v)` → a NEW array (full
  independent copy, original unchanged; `Array.prototype.with` is real ES2023 so node is the
  oracle). Object spread `{...o, k:v}` already gave non-mutating copy semantics — the ownership
  pass now **borrows** (not moves) a spread source, fixing a use-after-move + a leak. `.push`/`.pop`
  stay node-compatible (mutating) — the full immutable-by-default switch + structural sharing +
  refcounting (B2 step 2/4) are deferred. Fixed a latent heap `===`/`!==` miscompile (arrays/objects
  were compared via `strcmp` on pointers → now pointer comparison).
- **Stage 27 ✅ (B3 v2+v3: links/monitors + supervision)** `link`/`monitor`/`trapExit` + exit-signal
  propagation + fault injection (`__kill`/`__crash`), and a `one_for_one` **supervisor** — the
  canonical OTP **kill-and-assert-restart**: a supervised child crashes, the supervisor restarts it
  to known-good state (new pid, state reset), and **restart intensity** escalation (too many
  restarts in the window → supervisor exits). Modeled on the v0 cooperative scheduler (the
  supervisor is itself a trapping actor); one FIFO run queue keeps pids + stdout byte-stable, so
  the OTP tests assert exact output. Crash records (pid, reason, restart decision) to stderr.
  Messages stay numbers (reason tracked in C, drives supervision but not surfaced to TS without
  Dyn/tuples). Behavioral tests in `test/actors/` + `test/supervise.test.ts`.
- **Stage 28 ✅ (Phase C: move-out checks E0507/E0508)** `NT1604` move-out-of-borrow (`move()` of a
  `for-of` element or a borrowed param) and `NT1605` move-out-of-array-element (`const x = objArr[i]`
  consuming a linear element). Analysis-only in `src/ownership.ts` (a `borrowBindings` set + an
  `IndexExpr`-in-consuming-position check for linear element types); reading a Copy element
  (`number[]`/`string[]`) or a field (`arr[i].x`) is fine. **Params are borrows** (the caller owns
  them). rustc-compiletest cases in `test/ownership/`. (String-element variant is moot now that
  strings are RC, not linear — see Stage 30.)
- **Stage 29 ✅ (B2: immutable-by-default — the "sharp turn")** Arrays and objects are immutable:
  in-place mutation `arr.push(x)`/`arr.pop()`, `arr[i] = v` (+ compound), and `o.f = v` are
  **rejected with `NT1606`** (reject-don't-miscompile) pointing at the immutable replacement
  (`.with` / `[...a, x]` / `{...o, f: v}`). Chosen over silent non-mutating returns (node's `.push`
  returns length, `.pop` an element — rejecting keeps everything else node-differential). A
  deliberate **node divergence** (Phase B). Consequence: `NT1603` iterator-invalidation is now
  unreachable (can't mutate during iteration if you can't mutate). `.reverse` still mutates
  (matches node — flagged for later). Full-copy semantics (structural sharing still a follow-on).
- **Stage 30 ✅ (Phase C / B2 step 4: RC strings — string leak fixed)** Heap strings are reclaimed
  by **reference counting**, keeping JS value-semantics (free copy/alias — strings are RC, **not**
  linear/move-checked, which supersedes the old strings-linear plan). A runtime pointer→refcount
  **side-table** (no header on strings): producers register at rc=1; codegen emits **retain** at
  aliasing binds / heap-slot stores and **release** at scope exit; a pointer not in the table (a
  `@.str` **literal**) makes retain/release no-ops, so literals are never freed. `nt_str_live()`
  balances to 0 (`test/str-rc.test.ts`); conservative over-retention where ownership is unclear
  (safe residual leak, never a double-free/UAF). Not thread-safe (fine for the cooperative
  scheduler; a B3 M:N runtime would need a lock).
- **Stage 31 ✅ (B3 v1: reduction-counted preemption)** Actors get a reduction budget
  (`CONTEXT_REDS=2000`); codegen emits `nt_reduction_tick()` **safepoints** at loop back-edges +
  call sites, yielding to the scheduler when exhausted (re-enqueue at run-queue tail via ucontext).
  Gated on actor-usage → **non-actor programs are byte-identical**. Fairness/interleave tests prove
  preemption. M:N OS threads + lock-free MPSC mailboxes deferred (v1.1).
- **Stage 32 ✅ (distribution + diagnostics)** **`--static`** flag: fully-static ELF for
  Android/Linux; macOS/iOS warn + fall back to dynamic (full static libc unsupported there);
  toolchain refactored into a unit-tested `linkArgv()`. **Multi-span rustc-style diagnostics**:
  `NT1601` use-after-move now points at both the use (primary) and the earlier move (secondary).
  Plus a **GitHub Actions release workflow** (build self-contained macOS/Linux binaries + publish a
  Release on a version bump) and `test/assets/smoke.ll` now tracked (fixes a CI/worktree flake).
- **Stage 33 ✅ (empty array literals — contextual element type; closes the NT1001 friction)**
  A bare `[]` has no element to infer from, so its element type now comes from **context**, via
  a `hint: Ty` threaded through `Checker.type`/`infer`. Contexts wired up: binding annotation
  (`const xs: number[] = []`), assignment target (`m = []`), **return type** (`function f():
  number[] { return []; }`), **parameter type** at the call site (`g([])`, incl. class methods,
  function values, and rest params — one choke point, `typeArg`), **class field initializer**
  (`items: number[] = []` → the desugared `FieldAssign` takes the declared field type),
  **annotated object-literal field** (`const o: {xs: number[]} = { xs: [] }`), **`?? []`** (the
  left operand's base type is the context — optional fields, `let x: T[] | undefined`, `Map#get`),
  and **`?:`** (an empty arm takes the other arm's type; the outer context still wins). Nested /
  object-element contexts (`{a:number}[]`, `number[][]`) fall out of the same path. A truly
  context-free `[]` is still **rejected** (`emptyArrayError`, NT1001) — but the diagnostic now
  names the element type as the missing piece and lists the three fixes. Empty arrays are ordinary
  linear values: move-checked and dropped exactly once (`__arrLive()` balances); `JSON.stringify([])`
  matches node. Verified by `test/empty-array.test.ts` (node-differential where node can run it).
  Deferred: inferring from a *later* assignment (`let xs = []; xs = [1,2,3];`) — annotate instead.
- **Stage 34 ✅ (`fetch` + the async fork, resolved)** The web-standard client on the existing
  libcurl primitive: `fetch(url)` / `fetch(url, {method, headers, body})` → a `Response`
  (`.status`, `.ok`, `.headers`, `await res.text()`, `await res.json()` → `Dyn` so `as T` runs the
  Stage-20 validator) plus `Headers#get/has` (case-insensitive, `string | null`). **The async fork
  is decided: no event loop, no promises** — `async` is **erased** and `await` is an **identity
  pass-through** over an already-resolved value, with every request **blocking**. That is what
  keeps node as the oracle: the SAME `.ts` (`const res = await fetch(u); const body = await
  res.text();`) runs under node and as a native binary, differential-tested against a local
  `http.createServer` mock (`test/fetch.test.ts` — never the real internet, async `spawn` for both
  sides so the in-process mock can serve). The cost is **no concurrency**, so promise plumbing is
  **rejected with `NT1020`** (`Promise.*`, `new Promise`, `.then`/`.catch`/`.finally`, an
  un-awaited `async` result — except the canonical trailing `main();`), pointing at the **actor**
  model as the concurrency primitive. Transport failure → catchable throw (pending-exception
  protocol); non-2xx → a normal Response with `ok === false`. `Response`/`Headers` are reserved
  ref types (like the bytes handles); `Promise<T>` in type position erases to `T`; a user function
  named `main` is symbol-renamed so the idiomatic entrypoint compiles. **Host (macOS/Linux) only**
  — `nt_http.c` + `-lcurl` stay conditionally linked, so cross-builds are unaffected; iOS/Android
  need a native HTTP stack. Example: `examples/fetch-json.ts`.
- **Stage 35 ✅ (B3 v4: selective receive + timeouts + string messages)** Actors got the three
  things that made them unusable for real programs. **`receive(ms)`** is Erlang's `after`: it
  returns `T | undefined` (the A2 tagged pair), so a timeout is observably distinct from every
  legal message — never an in-band sentinel. Timeouts run on a **virtual clock** that advances
  only at quiescence (nothing runnable could still send), so they are deterministic and cost no
  wall-clock time; `ms <= 0` is `after 0` (poll, never block). **`receiveMatch(pred[, ms])`** is
  selective receive: it scans the mailbox, takes the first message satisfying the predicate, and
  leaves the rest in place *in order* — OTP's **save queue**, restored for the next receive by
  construction; when the scan is exhausted it blocks for messages it has not examined and resumes
  scanning there, so a message arriving while blocked is never skipped. The scan is emitted by
  codegen (`nt_mbox_count`/`peek_kind`/`peek_slot`/`take`/`wait_from`) so the predicate is an
  ordinary TS closure. **String messages** (`send(pid, "text")`, `spawn(body, "text")`) are
  **deep-copied on send** into a fresh RC-registered allocation, so a receiver never aliases the
  sender's buffer (proved by freeing the sender's local before the receiver runs). The message type
  comes from the declared type of the binding (`const m: string = receive()`) or the predicate's
  parameter type; every message also carries a runtime **kind tag**, so a receive compiled for
  `number` that meets a string aborts with a diagnostic instead of reinterpreting the pointer
  (reject-don't-miscompile, at runtime). Crash records now name the **triggering message** in its
  own kind, and the supervisor record reports the dead pid. Also: `x === undefined` / `x === null`
  on a nullable is a **tag comparison** (the idiomatic narrowing test). New v4 declares + all v4
  runtime calls are gated on actor usage, so **non-actor IR is byte-identical**. Tests:
  `test/actors-v4.test.ts` + `test/actors/{timeout,selective,selective_timeout,selective_late,
  strings,string_copy,kind_mismatch,crash_message}.ts`, and the first actor example app,
  **`examples/router.ts`** (a supervised request router: priority dispatch via selective receive,
  reply timeouts, crash + restart under a stable registered name). Deferred: **structured/`Dyn`
  messages** (needs the type-driven deep-copy walk + a shape tag — a slot alone can't distinguish
  two object types across actors) → **delivered in Stage 41**; M:N OS threads and the async-IO
  poller remain open.
- **Stage 36 ✅ (M3: generic functions by monomorphization — NT1013 cleared)** `function f<T>(x: T): T`
  is compiled, not erased. The parser RECORDS the type-parameter list (`FuncDecl.typeParams`) and
  resolves an in-scope `T` to the marker type `#T` (un-representable by construction, so it can
  never be silently lowered); call-site type args are recorded on `CallExpr.typeArgs`. The checker
  treats a generic decl as a **template**: at each call it resolves the type-argument tuple —
  explicit `f<string>(…)`, or **inferred** by structural unification of the parameter patterns
  against the argument types (through `T[]`, `(t: T) => U`, `{k: T}`, `Map`/`Set`, nullable) — then
  emits ONE **specialization** per distinct tuple: a `structuredClone` of the template with `#T`
  substituted through every type-bearing AST field, registered under a mangled name (`id$number`,
  `id$string`), with the call's callee rewritten to it. Instantiations are memoized on
  (function, type-tuple), so **self-recursion terminates** (bodies are checked in a drain loop
  after registration). Templates are spliced OUT of the program, so **a generic nobody calls emits
  nothing**; specializations are ordinary `FuncDecl`s, so the ownership pass, deterministic drop
  and codegen treat them exactly like hand-written concrete functions (verified: `NT1605` reported
  per-specialization, `__arrLive()` → 0). Rejected, never miscompiled: uninferrable type args,
  **polymorphic recursion** (self-call at a bigger type — capped at 200 instantiations), a generic
  used as a **value**, and a surviving `#T` (all `NT1013`); generic **classes** stay `NT1015`.
  Generic **arrows** are values with no call site to specialize, so they take their CONTEXTUAL
  parameter type where they have one and otherwise keep the pre-M3 erasure to `number`.
- **Stage 37 ✅ (collections: Map/Set iteration + ordering primitives — the dogfooding gaps)**
  **Insertion-ordered iteration**, node's guarantee, over a hash-ordered HAMT: the TS-level
  handle is now `nt_mapset.c`'s **`NtColl` = the HAMT handle + a persistent insertion-order
  key log** (`{ NtMap *m; NtOrd *buf; int64_t n; }`). The log is kept *clean* (put of a new
  key appends, re-`set` keeps the original position, `delete` removes the entry so a
  re-insert lands at the end — exactly node's rules) and *persistent* via copy-on-branch
  appends (a version writes in place only when it is the buffer's tip), so older handles keep
  their own order. `nt_hamt.c` is untouched. Surface: `for (const k of m.keys())`,
  `.values()`, `for (const [k, v] of m.entries())`, `for (const [k, v] of m)` (parser binds
  two names; codegen walks the key array and looks each value up — no tuple type needed),
  `for (const v of set)`/`set.values()`, `Array.from(it)`, `[...it]`. Iterators are **real
  arrays** (so they compose with the array HOFs) and are therefore only typed in those three
  iteration positions — anywhere else, plus single-binding `for-of`/spread over a Map,
  `.entries()` outside the `[k,v]` loop, and `.forEach`, is **`NT1014`** with the working
  spelling in the hint. **Ordering:** `.toSorted()` / `.toSorted(cmp)` / `.toReversed()` —
  the ES2023 *copying* methods (non-mutating in node too, so node stays the oracle);
  `.sort()` is refused with `NT1606` pointing at them. The sort is a **stable** merge sort and
  the default comparator compares elements' **string** forms, both matching node; a comparator
  may be any function value via a codegen-emitted `i32 (ptr env, i64, i64)` shim over the
  closure ABI. **String `< <= > >=`** now compile (`js_str_cmp`): byte order == code-point
  order, matching node's UTF-16 order outside the astral/U+E000 corner (documented). Also
  fixed a pre-existing crash: a `return` inside a **block-bodied lifted arrow** carried the
  enclosing scope's drop list and emitted a load of an undefined `%local.addr`. Tests in
  `test/collections.test.ts`; `examples/wordfreq.ts` lost its hand-rolled `strLess`, parallel
  distinct-word array and selection scan.
- **Stage 38 ✅ (B2 step 2: real structural sharing for arrays)** Past **32 elements** an array's
  storage switches from the flat block to the **32-way persistent vector trie** (`runtime/nt_pvec.c`,
  Clojure `PersistentVector` — previously dead code), behind the SAME `NtArray` handle, so codegen /
  checker / ownership are untouched. `arr.with(i,v)` becomes **path copying** — only the root→leaf
  ancestors are allocated (measured: **2** nodes at n=1000, **3** at n=2000, **4** at n=40000 =
  `shift/5+1`), and the leading-spread append `[...a, x]` becomes **O(1)** (measured: **1** node) by
  having `nt_arr_extend` **adopt** the source's vector into the fresh destination — no codegen change.
  Flat stays the *builder/transient* form (literals, `.map`/`.filter`/`.slice`/`split`/JSON), so small
  arrays are byte-identical in behaviour *and* representation; `.reverse` **thaws** to a private block
  rather than writing through shared nodes. **Memory:** a shared node has many owners, so the linear
  drop can't free it — the trie nodes are **reference counted** (owned-return / consuming-header
  convention); `nt_arr_free` releases the header and a node dies with its last owner. Freed exactly
  once, never dangling (`__pvNodes()` → 0; ASan/UBSan clean). `nt_pvec.c` + `-DNT_PVEC` are linked
  only when the program uses arrays; without them runtime.c compiles the old flat-only path, so a
  missed gate costs performance, never correctness. Node-differential across the danger zones
  (31/32/33, 1023/1024/1025, deep 2000) in `test/sharing.test.ts`; verified running on the iOS
  simulator + Android arm64 link. **Deferred:** pvec-backed `Map`/`Set` (still HAMT), transients /
  rc==1-mutate-in-place, and dropping non-top-level temporaries (pre-existing safe leak).
- **Stage 39 ✅ (SH1: a real module system — `import` / `export` across files)** nativets now
  compiles a **program**, not a file. `src/modules.ts` is a **whole-program linker**: from the entry
  file it resolves every `./relative.ts` specifier, loads each module **exactly once** (a diamond's
  shared module runs once), orders them post-order DFS (= ESM evaluation order), **alpha-renames**
  each non-entry module's top-level bindings with a per-module prefix (so two files may declare the
  same `helper`/`class Box`/`TAG`), and merges everything into **ONE `Program`** — checker,
  ownership and codegen are untouched and the IR is still one triple-free `.ll`. Supported surface:
  `import { a, b as c } from "./m.ts"`, `import type`/inline `type` specs (erased, but the type
  still resolves in the importer), side-effect `import "./m.ts"`, `export` of
  function/const/let/class/type/interface, `export { a as b }`, and the re-export
  `export { x } from "./y.ts"`. **Module scope is real**: a module's functions see its module-level
  bindings — the bindings a function body actually reads are promoted to LLVM globals
  (`@nt.g.<name>`, written by `main` in module order), everything else stays a `main` local, so
  **single-file IR is byte-identical to before**. Refused (never miscompiled): `export default`,
  `import * as ns`, `export * from`, dynamic `import()`, bare/`node_modules` specifiers → **NT1017**;
  plus a new **NT17xx** link band — **NT1701** unreadable module, **NT1702** import cycle (named, in
  order; never hangs), **NT1703** no such export. `build`/`run`/`emit`/`coverage` all take a
  multi-module entry. Tests: `test/modules.test.ts` + `test/modules/`; dogfood apps
  `examples/roman-modular/` (examples/roman.ts as three modules, byte-identical output) and
  `examples/inventory/`.
- **Stage 40 ✅ (stdlib Batch 1 complete — the everyday standard library)** The web-standard
  surface node gave us for free, built natively and node-differential end to end
  (`test/stdlib-batch1.test.ts`, `docs/stdlib.md`). **Strings:** `charCodeAt`, `codePointAt`
  (`number | undefined`), `at` (`string | undefined`, negative indices), `padEnd`,
  `startsWith`/`endsWith` (+ position arg), `replace`/`replaceAll` (**string patterns only** —
  no RegExp — with `$$`/`$&`/`` $` ``/`$'` substitution), variadic `concat`, `lastIndexOf`,
  `split(sep, limit)`. **Arrays:** `at`, `lastIndexOf`, variadic `concat`, `flat()`, `Array.of`,
  `Array.from(arr)`, and the predicate HOFs `some`/`every`/`find`/`findIndex`/`findLast`/
  `findLastIndex`/`flatMap` — inline arrows inlined into the generated loop like Stage 12, with
  `findLast*` iterating **backwards** so even a side-effecting callback sees node's call order.
  **Objects:** `Object.entries` (string-valued objects) + `Object.fromEntries` (literal entries).
  **Numbers:** the `Number.*` constants (`MAX_SAFE_INTEGER`, `EPSILON`, …), `Number.isNaN`/
  `parseInt`/`parseFloat`, **`toFixed`** (ECMAScript-exact: the double's exact decimal expansion
  rounded half-up on the magnitude — `1.25 → "1.3"`, `1.005 → "1.00"`) and **`toString(radix)`**
  (a faithful port of V8's `DoubleToRadixCString`, so `(0.1).toString(2)` / `(1/3).toString(3)`
  match digit for digit). **`structuredClone`** — a type-directed deep copy reusing the
  `JSON.stringify` walk shape (nested objects/arrays become new references, like node).
  **Refused, not approximated:** the remaining in-place mutators `.fill`/`.sort`/`.splice`/
  `.shift`/`.unshift`/`.copyWithin` are `NT1606` with the immutable replacement in the hint
  (arrays are immutable, Stage 29 — `.sort` points at the ordering lane's `.toSorted()`); `toFixed`/`toString` require literal in-range arguments so
  node's `RangeError` is unreachable rather than emulated. Non-ASCII stays on the documented
  UTF-8-byte index space (§A.2), now pinned by a behavioral test.
- **Stage 41 ✅ (out-of-bounds is a controlled PANIC — a defect fix)** Every indexed accessor in
  the runtime was already bounds-checked (no UB, no OOB memory access ever), but the **policy** on
  a failed check was to return a benign value — `nt_arr_get` → `0`, `js_str_char_at` → `""`,
  `nt_bytes_get` → `0`, an OOB `Uint8Array` write → a silent no-op, `nt_pv_update` out of range → an
  unchanged copy. That matched **neither node** (`undefined`) **nor a trap**: the program carried on
  computing from a value that was never there — a silent wrong answer. It now **panics**, rustc-style:
  `panic: index out of bounds: the length is 3 but the index is 5`, then `at <file>:<line>:<col>` and
  a `help:` line naming `.at(i)`, all on **stderr** with stdout flushed first (so stdout stays
  byte-comparable), via `abort()` → **exit 134**, the same path as the existing OOM abort. A panic is
  **not an exception**: it deliberately bypasses the Stage-20 pending-exception protocol, so
  `try { a[5] } catch {}` still aborts and `finally` does not run. Covered: `a[i]`, `s[i]`, `u[i]`,
  `u[i] = v` (incl. compound), and `arr.with(i, v)` (flat + persistent-trie), **negative indices
  everywhere**. `.at(i)` (node-exact `T | undefined`) and `.charAt(i)` (node *defines* it as `""`) are
  untouched — `.at` is the documented escape hatch the panic points at. **Compile-time beats runtime:**
  a literal index into a statically-known length (a literal array/string, or a `const` bound to one) is
  **rejected with `NT2002`** — a real user error, so the NT2xxx type band, surfaced by `coverage`.
  Mechanics: the parser stamps a written `[` with `file:line:col` (`IndexExpr.loc`, threaded from
  `ParseOpts.file` through the module linker), codegen routes only those through the new panicking
  accessors (`nt_arr_index` / `nt_str_index` / `nt_bytes_index` / `nt_bytes_index_set`), so synthesized
  indices (destructuring, spread-call expansion) and every compiler-generated in-bounds loop keep the
  cheap internal read and in-bounds IR is otherwise unchanged. Deliberate, documented node divergence
  (`docs/divergences.md`, headline entry). Tests: `test/panic.test.ts`.
- **Stage 42 ✅ (B3 v5: STRUCTURED messages — the last blocker on actors being usable)** `send`/
  `spawn`/`receive` now carry **records and arrays**, not just `number`/`string`. v4 refused
  objects for a real reason: a message rides in ONE 8-byte slot plus a coarse kind tag, and sender
  and receiver are typed **independently**, so a slot + a coarse tag cannot tell two record types
  apart — shipping objects on that basis would be a soundness hole. v5 closes it with the two
  pieces v4 named. **(1) Deep copy on send.** Codegen emits the type-driven walk at the send/spawn
  site — literally the Stage-40 `structuredClone` walk (`genDeepClone`), extended with a
  `copyStrings` mode so **string leaves** are copied into fresh RC-registered allocations too
  (otherwise a receiver's record would point into the sender's releasable buffer). The receiver
  shares nothing with the sender's heap; proved by dropping the sender's record before the
  receiver runs (`__objLive()` delta = 1, `test/actors/struct_copy.ts`). **(2) A shape tag on the
  wire.** Every structured message carries `shape` — the compiler's canonical type encoding
  (`{kind:string,n:number}`), which IS structural identity here — plus a per-shape **renderer**.
  `nt_recv_struct` compares shapes and, on a mismatch, aborts with a diagnostic naming BOTH
  shapes (exit 70, the Stage-35 precedent), never a reinterpreted pointer; a **selective** receive
  uses `nt_mbox_shape_ok`, so a foreign shape is *skipped and left queued in order* (the save
  queue) rather than handed to a predicate compiled for other slots. **Tagged unions**
  (`{kind:"work", …}` + `msg.kind === …` dispatch) work end to end — one record type per protocol
  with a discriminator, which is how every real actor program dispatches. **Arrays** fell out of
  the same machinery (`number[]`, `string[]`, `{…}[]`). **Crash records** name the structured
  triggering message: the runtime has no types, so codegen emits `ptr @nt_msg_render_N(i64)` per
  shape (the `JSON.stringify` walk, safepoint-free so it can never yield mid-record) and the
  record prints `{"op":"boom","id":42}` + its shape. **Refused, never shared:** a message type with
  no sound copy — a function value (it captures the SENDER's environment), a `Map`/`Set`/
  `Uint8Array`/`Response` handle — is **`NT1021`** (recursive: a record with a function leaf too).
  That check also closed a **pre-existing hole**: `send(pid, x)` where `x: T | undefined` used to
  strip the nullable and put the two-slot tagged BOX pointer on the wire for a receiver expecting
  a `T` (it compiled and printed garbage). A sent value is never nullable (`actorSendTy`) — a
  message is always present; unwrap first. A receive *annotation* keeps its A2 "or a timeout"
  meaning.
  All v5 declares + calls stay behind the actor-usage gate, so **non-actor IR is byte-identical**
  (diffed) and a v4 actor program differs only by the four new `declare`s. Verified running on the
  **iOS simulator** (arm64); Android actor cross-builds remain blocked by NDK API 24's missing
  `ucontext`, exactly as before. Tests: `test/actors-msg.test.ts` + `test/actors/struct_*.ts`,
  and the example **`examples/jobs.ts`** — a supervised job router over a tagged-union record
  protocol with the reply-to pid inside the message (GenServer-shaped), priority dispatch on a
  record *field*, reply timeouts, and crash + restart under a stable name. **Deferred:** M:N OS
  threads / work-stealing, lock-free MPSC mailboxes, and the async-IO poller (v6).
- **Stage 43 ✅ (self-host parse tail — `NT0001` cleared, 11 → 0)** After Stage 36 removed the
  `NT1013` wall, the measured frontier over `src/*.ts` was `NT0001` "unparsed statement" ×11 — not
  one feature but six small ones, all now closed: **`(expr as T)` in a ternary arm** (the
  `looksLikeArrow` lookahead committed on any `) :`, so it read the parens as a parameter list);
  **postfix/prefix `++`/`--` on a member or index target** (`UpdateExpr` gained `targetExpr`;
  mutability mirrors plain assignment exactly); **`instanceof`**, resolved at COMPILE time from the
  static type (a value's static type *is* its class here) for user classes + `Array`/`Map`/`Set`/
  `Uint8Array`, with `NT1022` refusing what a static type cannot decide — notably `instanceof Error`,
  since Stage 18 models `Error` as `{message:string}` and a plain record with a `message` is the
  same type; **binding patterns in parameters** (`([k, v]) => …`, the Stage-15 desugaring extended
  to parameter position); **nested template literals** (the lexer ended the outer template at the
  inner backtick); and **radix/separator numeric literals** (`0x22`, `0b1010`, `0o17`, `1_000`).
  Two of the six items were MISDIAGNOSES the lane corrected by measuring rather than trusting the
  list — "array-of-object-type annotations" and "string escapes" both already worked; the real
  blockers hiding behind them were the template and numeric-literal gaps above. Also named, rather
  than left as "unparsed": parenthesized types (`(() => Scope) | null`) and `delete o.k`.
- **Stage 44 ✅ (B2 step 4 / Phase C: refcounting + transients — the last big leaks closed)**
  Stage 38 left two knowingly-accepted holes; both are gone. **(a) The drop pass reached only
  top-level locals**, so loop reassignment and unbound temporaries leaked (and, past 32 elements,
  leaked trie nodes with them). Drops now happen at **four** points, all computed by the ownership
  pass so they stay move-aware: scope exit (as before), a `return` (now every **active** scope,
  not just the top level), a **nested block's** fall-through exit (`Stmt[].blockDrops` — a
  loop-body local is freed each iteration), and **reassignment** (`AssignExpr.dropOld` — the
  superseded value is freed after the RHS is evaluated). Unbound **temporaries** are freed where a
  chain consumes them (`s.split(",").length`, `xs.map(f).filter(g)` — only syntactically fresh
  producers, and never `.reverse`, which returns its receiver). **Conditional moves get a drop
  flag** (rustc's E0382 machinery): the lattice now tracks MAY-move (join OR, what the
  use-after-move check reads) *and* MUST-move (join AND), and a value moved on only some paths is
  still dropped — under a flag that costs nothing, since the move **nulls the slot**
  (`Identifier.nullOnMove`) and `free(NULL)` is a no-op, so the pointer IS the flag.
  **(b) No transients**: `nt_pv_push_own` now mutates the tail **in place** when the vector header's
  rc is 1 **and** its tail leaf's rc is 1 — uniquely owned ⇒ unobservable — and otherwise falls
  back to the persistent push, so *old-version-unchanged holds by construction, decided by the
  refcount*. Linear ownership is what makes the fast path the common one: `x = [...x, e]` compiles
  to a **consuming append** (`nt_arr_extend_own`) because the ownership pass proves the old value
  is dead, so the storage is MOVED and the trailing push finds rc = 1. Measured on 200k
  loop-appends: **87.9 MB → 5.3 MB** peak RSS, **200001 → 0** abandoned handles, **217660 → 0**
  trie-node allocations, ~5× faster; on an already-frozen array, 320 appends allocate **30** nodes
  instead of ~320 (309 written in place). Also fixed a pre-existing **use-after-free**: array-literal
  elements were borrows, so `return [o1, o2]` freed both objects while the escaping array still
  pointed at them — elements now MOVE, like object-literal fields. Nothing observable changed
  (every case is node-differential); gated by `test/transients.test.ts`, including an
  **ASan+UBSan** run of a program exercising every new drop path and C-level vector 23 in
  `test/runtime/pvec_test.c`. Deliberately still conservative (leak, never a double free or a
  dangling pointer): values escaping a block via `break`/`continue`/`throw`, names mentioned inside
  any arrow body (a closure env holds a second pointer), module-level bindings promoted to globals
  (a function may have returned the pointer), temporaries in non-chain positions, and array/object
  **elements** (a container frees its handle, not what its slots point at).
- **Stage 45 ✅ (decorators: `@@` compile-time attributes + `@` runtime wrappers, and mutable
  classes)** Two sigils, two mechanisms (`docs/decorators.md`). **`@@name`** is a **compile-time
  ATTRIBUTE** the compiler reads — Rust's `#[derive]`, zero runtime footprint; an **unknown one is
  `NT1023`**, never a comment, because an attribute changes how a class compiles. **`@name`** is a
  real **runtime WRAPPER** — Python's `m = w(m)` — on a class or a method. The one attribute is
  **`@@mutable`**: TRUE in-place mutation, where every handle observes the change. Consequently a
  class **method may now assign `this.f`** (it was `NT1606`), in two flavors: an `@@mutable` class
  mutates the receiver, an **ordinary class COPY-ON-WRITEs** — codegen rebinds `this` to a fresh
  shallow copy on entry (`FuncDecl.copyThis`), so the caller's instance is unchanged and the method
  hands back the NEW one; a setter that would throw that copy away is `NT1023`. A setter with no
  `return` gets an **implicit `return this`** (both flavors), so it chains. Also fixed: a method
  may now name its own class in a signature (`bump(): Counter`) — it used to erase to `number`
  — via a self-type marker substituted once the instance shape exists.
  **The safety story (the crux):** `@@mutable` puts mutation back into a linear model, so
  `src/ownership.ts` keeps it single-owner with **only the owner may mutate**. `const b = a` (and
  a method RESULT, which is the receiver) is an **ALIAS/borrow, not a move** — ownership never
  leaves the original binding, so the value is dropped exactly once (`__objLive()` → 0) and
  aliasing cannot double-free; an alias is a borrow binding, so letting it escape is the existing
  **NT1604**. Calling a **setter** through anything whose ownership the pass cannot establish — an
  alias, a by-borrow **parameter**, a `for-of` element, a container element, a callback parameter,
  a capture — is the new **NT1607** (≈ rustc E0596); reassigning an aliased owner is **NT1602**
  (≈ E0506). Receivers resolve through method chains, so `a.bump().bump()` is still `a`. What this
  does **not** prove: it is not full `&mut` exclusivity (the owner may mutate while an alias is
  live — that IS the feature), the container/callback check is name-based so it can over-refuse,
  and aliases borrow for the whole scope (no NLL). **`@` wrappers** lower a decorated method to
  `C.m$inner` + a module-level `const __dec_C_m = w((self, …p) => C.m$inner(self, …p))` applied
  **once** + a forwarding `C.m`, so the wrapper is an ordinary `(fn) => fn` user function over the
  method's own signature with the **receiver as its first parameter**, and wrapper state persists
  across calls. A **class** decorator wraps the **CONSTRUCTOR** (`(instance, …args) => instance`;
  `new C(…)` now uses the returned instance). **Stacked decorators apply BOTTOM-UP, like Python**:
  `@a @b m` ≡ `a(b(m))`. Refused: a decorated method with no return annotation or a rest/default
  param, `@@` on a member, `@` on a field. `@@mutable` survives the module linker (renamed with
  its class). Two small enabling fixes elsewhere: calling a function-typed **module-level global**
  from inside a function (was an ICE), and `new C(…)` honoring a constructor that returns the
  instance. Tests: `test/decorators.test.ts` (25) — node-differential wherever a mechanical
  desugaring exists (attribute-stripped source; hand-written explicit wrapper application),
  behavioral with exact stdout where it does not.
- **Stage 46 ✅ (stdlib Batch 3 — the object-shaped web APIs, now that classes exist)**
  `docs/stdlib.md` deferred these while nativets had no classes; SH3–SH3.6 removed that blocker,
  so the functional workarounds became the real API and **node is the oracle DIRECTLY, with no
  polyfill** (`test/stdlib-batch3.test.ts`, 56 cases). **`Date`:** `new Date()` / `new Date(ms)`
  (ES `TimeClip`) / `new Date(isoString)`, `getTime`/`valueOf`, the eight component getters
  (`getFullYear`…`getDay`) **plus their zone-independent `getUTC*` aliases**, `toISOString`/
  `toJSON`, and `console.log(date)` (node's `util.inspect` of a Date IS the ISO string;
  `Invalid Date` for NaN). A `Date` VALUE **is** the epoch-ms `double` — no allocation, no drop,
  so `Date[]` is a `number[]` in every way that matters, and `Date` works as a parameter/return/
  object-field type; `JSON.stringify` goes through `toJSON` (quoted ISO, `null` when invalid) and
  `structuredClone` copies it. **The timezone decision: local time is REALLY local.** The runtime
  breaks a time value down with `localtime_r` and inverts a zoneless date-time string with
  `mktime`, both reading the same IANA zone node's ICU reads, so `getHours()` matches node on the
  same machine — DST transitions and half-hour zones included. Secretly-UTC accessors were
  rejected as a silent disagreement with node; instead the local-time tests **pin `TZ` on both
  sides** (`differentialTZ` over `UTC`, `America/New_York`, `Asia/Kolkata`). `toISOString`/
  `getUTC*` are UTC by specification via pure civil-calendar arithmetic (no `time_t`), so the full
  ±8.64e15 ms range works incl. `+275760-09-13T00:00:00.000Z`; an Invalid Date `toISOString()`
  **throws catchably** (node's `RangeError`). `new Date()` is a clock read, so — like `Date.now()`
  — it is behavioral, never node-differential. **`URL` is a real class:** `.protocol`/`.host`/
  `.hostname`/`.port`/`.pathname`/`.search`/`.hash`/`.origin`/`.searchParams` over the same
  absolute-http(s) subset, and a URL outside it now **throws** like node's `TypeError` (the
  obligation a class has that loose functions did not). **The old functional entry points
  (`urlProtocol(u)`, …) were REMOVED** together with the `URL_POLYFILL` oracle in
  `test/harness.ts`; `test/stdlib-url/*.ts` were migrated to `new URL(…)` and now run against
  plain `runWithNode`. **`URLSearchParams`** (`url.searchParams` or standalone): `.get`
  (`string | null`, node's exact shape), `.has`, `.getAll`, `.toString`. **`Object.freeze`** is
  the identity and honestly so — objects are already immutable (Stage 29) — with `isFrozen`
  constant-`true` and `getOwnPropertyNames` == `keys`; **`Object.assign`/`defineProperty`/
  `setPrototypeOf` mutate → `NT1606`** pointing at spread. **`encodeURIComponent`/`decodeURIComponent`/
  `encodeURI`/`decodeURI`** byte-exact per ECMAScript §19.2 (malformed `%` → a catchable
  `URIError`). **Refused, never approximated — the new `NT1024`:** `String#normalize` (needs the
  Unicode database), `localeCompare`/`toLocale*` (needs ICU), `Date#setX` (a Date is an immutable
  time value), `Date#toString`/`toLocaleDateString` and `"" + date` (locale + zone-name tables),
  `new Date(y,m,d)`, `new URL(rel, base)`, `URL#href`, `console.log(url)`, and the mutating
  `URLSearchParams` methods. Three latent defects fell out and are fixed: string concatenation
  with a `T | null` emitted **invalid IR** (now `NT1009`), `DATE_GETTERS` as a plain Record let
  `d.toString()` resolve to `Object.prototype.toString` (now a `Map`), and `JSON.stringify` of a
  Date field silently produced `null`.
- **Stage 47 ✅ (B3 v6: M:N scheduler threads, lock-free MPSC mailboxes, work stealing, async-IO
  poller)** The last major deferred piece of the actor runtime. **The determinism problem came
  first**, because every actor test asserts EXACT stdout and that is only a specification while one
  cooperative scheduler makes the interleaving a pure function of the program. So the mode is chosen
  at RUN TIME by **`NATIVETS_SCHED_THREADS`**: unset or `1` is the **default** and collapses to the
  v0..v5 scheduler *byte for byte* (one FIFO queue, direct mailbox appends, virtual clock — all 39
  existing actor/supervision tests pass unchanged); `N`/`auto` starts N OS threads. **(1) M:N
  threads.** Each thread drives its own `NtSched` (own run queue + own ucontext); `g_current` and
  the scheduler pointer are thread-local, so an actor may be resumed on a different thread than it
  suspended on — **actors migrate, pids do not** (one global actor table). The hazard real threads
  introduce is a sender enqueueing an actor whose registers are still being written to its
  ucontext; it is closed by a **`NT_SWITCHING`** state that only the scheduler regaining control may
  leave, paired with a block-predicate re-check (`mbox_ready`) at slice end — the two halves make a
  lost wakeup impossible from either side. Quiescence is a single counter incremented *before* a pid
  becomes visible to a thief and decremented only when its slice ends unqueued, so `__drain()`
  cannot return early. **(2) Lock-free MPSC mailboxes.** Many senders, one receiver ⇒ a Treiber-stack
  **intake** (one CAS per send) that the owner drains with an atomic exchange + batch reverse
  (restoring FIFO) into its **private list** — which is the same list v4/v5 scan by index for
  SELECTIVE receive, something an MPSC queue cannot support. That is exactly BEAM's outer/inner
  mailbox split, so the save-queue machinery is untouched. **(3) Work stealing** — an idle scheduler
  takes from the HEAD of a victim's queue, probing victims round-robin from itself. **(4) The
  async-IO poller** (kqueue/epoll): `nt_io_wait(fd)` parks an actor on a file descriptor — out of
  the run queue entirely, no slice, no spin — and kernel readiness wakes it; only scheduler 0 polls
  (no thundering herd) and it blocks in the poller when the system is otherwise idle, so a parked
  actor keeps `__drain` alive. **Refcount soundness — the real risk.** Stage 30's string RC
  side-table (one global open-addressed hash that *rehashes*) and Stage 38/44's pvec node refcounts
  (plus the transient's `rc == 1 ⇒ write in place` check-then-act) are single-threaded structures.
  They now call through **`nt_rt_lock`**, a hook `nt_sched_init` installs *only* when it starts more
  than one scheduler thread — `NULL` for everything else, so it is a predictable branch, needs no
  pthread dependency in `runtime.c` (which must keep cross-compiling), and leaves the default path
  behaviourally identical. The *values* need no protection: every message is **deep-copied on send**
  (Stage 42) and arrays/objects are **immutable** (Stage 29), so what crosses a thread boundary is
  read-only storage plus its count. The live-value stat counters became relaxed atomics (TSan found
  that one). **TSan.** A compiled actor program cannot be TSan-gated: the coroutines are ucontext
  **fibers that migrate**, and TSan's fiber support CHECK-fails (`tsan_rtl_proc.cpp:46`) exactly
  then — without annotations it instead calls every actor stack slot a race. (The annotations are
  in `nt_actor.c`, compiled in under `-fsanitize=thread`; they make 2-thread runs clean but do not
  survive 4.) So the gate drives what genuinely becomes shared — the RC table and the pvec
  refcounts — from plain pthreads through the same hook, and ships a **negative control**: with the
  hook removed the identical workload reports 57 races, with it 0. **Invariants verified, not
  assumed:** non-actor IR is byte-identical to main (diffed); the actor runtime is still linked only
  when used; non-actor iOS/iOS-sim/Android cross-builds still link, and Android actor builds still
  fail on NDK-24's missing `ucontext`, exactly as before; the M:N fan-in property runs on the **iOS
  simulator** with 4 scheduler threads. **Deferred:** wiring the poller to a TS-visible IO builtin
  (`readLine` slurps stdin up front and `fetch` is blocking libcurl — that retrofit is what would
  make Stage 34's `await` more than an identity), a dirty-scheduler pool, `nt_io_wait` timeouts, and
  per-actor heap arenas that would remove the RC lock entirely. Tests: `test/actors-mn.test.ts`
  (mode gate, determinism regression, M:N properties — per-pair FIFO, exactly-once, migration,
  supervision outcome, a repeated stress run — plus the TSan and poller gates),
  `test/actors/mn_{fanin,parallel,stress}.ts`, `test/runtime/{mn_rc_race_test,poll_test}.c`.
- **Stage 48 ✅ (`console.log` of a COMPOUND value — node's `util.inspect`; a silent-miscompile fix)**
  `console.log({ a: 1, b: "x" })` printed a **bare newline** and exited 0: `emitPrint` fell through
  to `js_print_str` on the object's heap POINTER, whose first byte is usually 0. A silent wrong
  answer — the same class of defect as the out-of-bounds `0` fixed in Stage 41, and *worse* than
  the honest refusals beside it (`console.log(arr)` was `NT1001`, a `Uint8Array` `NT1016`). It is
  now a faithful port of node's `lib/internal/util/inspect.js` at console.log's defaults —
  **breakLength 80, compact 3, depth 2, maxArrayLength 100**. **Split of work:** codegen walks the
  STATIC type and renders one entry string per field/element (the `JSON.stringify` walk's shape —
  `genInspect`/`genInspectObject`/`genInspectArray`/`genInspectColl`), while the runtime's
  `nt_insp_*` builder owns the one decision that needs runtime information — the **width /
  line-breaking** rule (`reduceToSingleString` + `isBelowBreakLength` + `groupArrayElements`),
  because it depends on the *rendered* widths. Node-identical for: objects, **class instances**
  (`Point { x: 1 }` — node folds the name into `braces[0]` and MEASURES it there, which is why a
  longer class name wraps the same fields sooner), arrays (`[ 1, 2, 3 ]`, `[]`, node's
  column-grouped layout past six entries with right-alignment only when every element is a number,
  `... n more items` past 100), **Map/Set** (`Map(1) { 'a' => 1 }` / `Set(2) { 1, 2 }`, size in the
  brace, Stage-37 insertion order), arbitrary nesting incl. node's `[Object]`/`[Array]` **depth
  cut** (where an EMPTY compound still prints, because node checks emptiness *first*), node's
  **string quoting** (`'` → `"` → `` ` `` to minimise escaping; a nested string quoted, a
  top-level one bare), and `-0`, which util.inspect prints as `-0` where `String(-0)` is `"0"`.
  Also closes the Stage-20 deferral: a compound **`Dyn`** (`console.log(JSON.parse(s))`) used to
  print the literal `[object]` and now runs the same algorithm in C, where the shape is only known
  at runtime. **Method:** node's own `lib/internal/util/inspect.js` was extracted from the running
  binary (`process.binding("natives")`), re-implemented in JS and **fuzzed to zero mismatches over
  60 000 random values** against `util.inspect`, then ported to C and **re-fuzzed to zero over
  20 000 random entry lists** against that verified reference — before any of it reached codegen.
  End to end, ~140 generated programs (≈3 400 compound values) are byte-identical to node.
  **Refused, never a raw pointer (`NT1025`):** a **function value** anywhere in a printed value
  (node names a function after its binding, `[Function: f]`, which our lambda-lifted arrows do not
  carry) and a `Uint8Array`/`TextEncoder`/`TextDecoder`/`Response`/`Headers`/`URL`/
  `URLSearchParams` handle **nested inside** one; at the ROOT each keeps its existing code
  (`NT1016`/`NT1002`/`NT1024`). A `checkInspectable` walk stops where node's renderer stops, so a
  refused type *below* the depth cut does not block, and an `isPrintableTy` net guarantees the
  invariant the stage exists for: **no input prints nothing.** Tests: `test/inspect.test.ts`
  (88 cases, all node-differential except the refusal table). Residual, documented: an **absent
  optional field still prints** (`{ a?: T }` IS `{ a: T | undefined }` here, so the slot exists —
  the pre-existing divergence already visible through `Object.keys`/`JSON.stringify`, and inspect
  stays consistent with them), and widths count UTF-8 **bytes** not UTF-16 units (§A.2).
  **Found, not fixed (own lane):** `js_number_to_string` diverges from node for `1e-7` (`1e-07`),
  `1e-5` (`1e-05` vs `0.00001`) and very large integers (exact rather than shortest-round-trip
  digits) — identical through `String(x)`, so unrelated to inspect.
- **Stage 49 ✅ (the rest of the `console` surface — format specifiers + the stderr methods)**
  Two live defects, both the "prints the wrong thing" class Stage 48 exists to remove.
  **(1) Format specifiers were IGNORED:** `console.log("a %s b", "x")` printed `a %s b x` where
  node prints `a x b`, because we appended every argument instead of letting the leading string
  consume them. node's `formatWithOptionsInternal` (read out of the running binary via
  `process.binding("natives")`, like Stage 48) is now transcribed as `planConsoleFormat` in
  `src/checker.ts` — the same function the checker and codegen both derive from, so an argument
  is validated for **the role it plays**. The scan runs at **COMPILE time**, which is the whole
  design: arguments are statically typed and the format string is virtually always a literal, so
  a call becomes a fixed sequence of literal chunks and per-argument conversions lowered from
  static types — no runtime format interpreter, no per-call cost. Supported and node-differential:
  **`%s`** (String, except a compound inspects at `depth: 0` so nested becomes `[Object]`, and a
  number keeps util.inspect's `-0`), **`%d`** (ToNumber — `true` is 1, `null` is 0, `""` is 0, a
  Date is its time value), **`%i`** (parseInt of `String(x)` — so `true` is NaN where `%d` is 1,
  and `"0x1f"` is 31), **`%f`** (parseFloat), **`%j`** (JSON.stringify, with node's literal
  `undefined` for a value it drops), **`%O`** (inspect at the default depth), **`%o`** (identical
  for a scalar), **`%c`** (consumed, discarded — but still evaluated), **`%%`**, plus every rule
  of the scan itself: a trailing `%` is never a specifier, an unknown one stays literal, a
  specifier with no remaining argument stays literal, `%%` only collapses once arguments follow
  (`console.log("100%% done")` alone is verbatim), and unconsumed arguments are appended
  space-separated after a leading space. **A NON-literal format string** keeps the plain path plus
  a runtime guard (`nt_fmt_guard`) applying node's exact rule to the actual string: it panics
  (stderr, stdout flushed, exit 134 — the Stage-41 path) **only if a specifier would really be
  consumed**, so the common `console.log(label, x)` is untouched and the wrong line is never
  printed. `typeof args[0] === 'string'` is a runtime fact for a nullable and a `Dyn`, so both
  feed the guard a pointer that is null exactly when node would not have scanned. Refused
  (**`NT1026`**, never approximated): `%o` of a compound (node's `showHidden`), `%j` of a
  Map/Set/Dyn, `%d`/`%i`/`%f` of an array (node's `ToPrimitive`/join), and `%s` of a `Uint8Array`
  (node prints `String(u8)`, `1,2,3`, because a typed array has its own `toString` — the one place
  node does NOT inspect).
  **(2) `console.error` did not exist** (it failed `NT2001: 'console' is not defined`).
  `log`/`info`/`debug` → **stdout**, `error`/`warn` → **stderr**, all sharing the entire path
  (inspect, specifiers, nullable unboxing, Dyn). Separate `js_eprint_*` entry points rather than a
  mode flag on the printer — a preempted actor must never be able to redirect another actor's
  half-written line — and `js_eprint_begin` flushes stdout first so a merged `2>&1` stays ordered.
  Every other `console.*` method is `NT1026` rather than the misleading undefined-identifier error.
  **Closed as a cheap win: NT1016 is retired.** node's typed-array layout IS the array layout with
  the length folded into the opening brace (`Uint8Array(3) [ 1, 2, 3 ]`), which the Stage-47
  `nt_insp_*` builder already owned, so `console.log(u8)` now matches node exactly — including the
  column-grouped right-aligned layout past six entries, `... n more items` past 100, the empty
  `Uint8Array(0) []`, and the `[Uint8Array]` depth cut. `NT1024`/`Response` were measured and
  **left**: node's `URL` inspect is a 13-field multi-line record including `href`, `username`,
  `password` and a nested `URLSearchParams { 'd' => '1' }` — `href` alone is separately refused —
  and `Headers`/`Response` need header iteration; neither falls out of the same machinery.
  Stage 48's guarantee holds unchanged: the `isPrintableTy` net still means **no input prints
  nothing**. Tests: `test/console.test.ts` (118, node-differential on BOTH streams except the
  refusal table and the deliberate non-literal panic).
- **Cross-compile ✅** real linked binaries running on the **Android emulator** and **iOS
  simulator** (verified through Stage 7, arrays included), plus an iOS-device arm64 Mach-O.

Coverage: base corpus **37/39**; **gap corpus 53/55** (A1 closed `json-roundtrip`, A2 closed
`optional-chaining`; the 2 remaining are **deliberate**: `array-push-pop` — refused now that
Stage 29 made arrays immutable, `.push`/`.pop` mutation is gone by design — and
`higher-order-compose` — nested function types). Every compiled case matches node.
Everything else is rejected with an `NT1xxx` diagnostic — see `docs/divergences.md`.
**Phase 2 (immutable data, `|>`, BEAM actors, runtime typecheck) design is in `docs/phase2-design.md`.**

**M1 complete; M2 (closures) essentially done** — array HOF + first-class functions with
capture, mutable/returned closures, and independent per-closure state. Only **nested function
types** (`compose` — a function returning a function) remain of the closure cases. Remaining gap
clusters: spread, destructuring, `try/catch`, `?.`/`??`, JSON, nested objects, and making
objects/strings linear. The gap corpus has node-verified cases waiting in `KNOWN_UNSUPPORTED`.

### Self-hosting frontier (re-measured after the `NT0001` burn-down)

`nativets coverage` over `src/*.ts` — **`NT0001` is now 0**, as is `NT1013` (Stage 36
monomorphization). **Every statement in the compiler's own source parses.** The frontier is no
longer syntax at all:

| Blocker | × | What it actually is |
|---|---|---|
| `NT1606` | 8 | field mutation `o.f = v` / `o.f++` on a plain record in `Parser`/`Checker`/`FnGen`/`Analyzer`/`coverage` — a *source* refactor, not a missing feature. (Stage 45 made `this.f = v` legal inside a class METHOD, so what remains is genuinely non-`this` mutation.) |
| `NT1009` | 3 | general unions (`Record<string, number \| "var">`, an intersection type) |
| `NT1015` | 2 | a `static` member in `ModuleGen`; a class field needing a type annotation in `modules.ts` |
| `NT0001` | 1 | **unmasked by Stage 45**: `class Checker` now parses past its field assignment and reaches `t.replace(/[^A-Za-z0-9_]/g, "_")` — a **regex literal**, which nativets does not have (no RegExp, Tier C). Not a parser regression; a previously-hidden blocker becoming visible. |

The `NT0001` bucket was ×11 and was never one feature — six concrete gaps, each extracted from a
real statement and closed one at a time (fixtures in `test/selfhost-parse/`, gate in
`test/selfhost-parse.test.ts`):

1. **`(expr as T)` / `(x)` in a ternary arm** misread as an arrow parameter list — `looksLikeArrow`
   accepted any `) :`; it now also needs a real parameter list *and* a top-level `=>`.
2. **nested template literals** — a `` ` `` inside a `${…}` substitution ended the outer literal.
   (This, not "array-of-object-type annotations", was the real `ast.ts` failure; `{k: string}[]`
   already parsed. It was also the `\`-in-`codegen.ts` failure.)
3. **radix + separator numeric literals** `0x22` / `0b1010` / `0o17` / `1_000` — the `codegen.ts`
   blocker was hex *number* literals, not the `\xHH` *string* escape (which already worked).
4. **`++`/`--` on a member/index target** (`this.pos++`, `u[i]++`) — mutability mirrors plain
   assignment exactly: a `Uint8Array` element and `this.f` in a constructor are writable,
   everything else is `NT1606`.
5. **`instanceof`** — decided at compile time from the static type (a value's static type IS its
   exact class here). Undecidable right operands, notably `Error` (modelled structurally as
   `{message:string}`), are refused with the new **`NT1022`**.
6. **binding patterns in parameters** (`([k, v]) => …`) — the Stage-15 declaration desugaring
   extended to parameter position.

Plus two more the measurement turned up: **parenthesized types** (`(() => Scope) | null`) and
**`delete o.k`**, which is now named as the mutation it is (`NT1606`) rather than "unparsed".

---

## Conventions

- **The full plan of what's next is in `docs/ROADMAP.md`** (finish the gap → runtime typecheck →
  the "sharp turn": immutable data, `|>`, BEAM actors → finish the memory model).
- **Single executable:** `bun run compile` → `./nativets`, a self-contained binary (bundles the
  compiler + the C runtime, embedded via `import ... with { type: "text" }` in `driver.ts`; needs
  only a system `clang`). It runs/builds/cross-compiles `.ts` with no `bun` or `runtime/` on disk.
- Runtime toolchain: **bun** (fast TS execution + process spawning for the oracle).
- The compiler emits IR with **no target triple/datalayout** in the `.ll`, so clang fills
  in host or the requested `-target`. Keep it that way for painless retargeting.
- Keep the four test types green before moving stages. IR snapshots may be updated
  intentionally with `bun test --update-snapshots` **after** behavior is re-verified.
- Prefer growing existing modules over adding new ones; match surrounding style.
