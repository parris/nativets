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
source.ts
  │  src/lexer.ts      hand-written tokenizer (no `typescript` dependency)
  ▼
tokens
  │  src/parser.ts     recursive-descent + Pratt expression precedence
  ▼
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
  **Still to do:** drops for nested/temporary values, general borrows beyond for-of, and
  move-out-of-borrow/array (E0507/E0508). Owned strings/objects are still on the never-free
  placeholder.

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
- **Cross-compile ✅** real linked binaries running on the **Android emulator** and **iOS
  simulator** (verified through Stage 7, arrays included), plus an iOS-device arm64 Mach-O.

Coverage: base corpus **37/39**; **gap corpus 55/55** (A1 closed `json-roundtrip`, A2 closed
`optional-chaining`) — the whole gap corpus now compiles + matches node.
Everything else is rejected with an `NT1xxx` diagnostic — see `docs/divergences.md`.
**Phase 2 (immutable data, `|>`, BEAM actors, runtime typecheck) design is in `docs/phase2-design.md`.**

**M1 complete; M2 (closures) essentially done** — array HOF + first-class functions with
capture, mutable/returned closures, and independent per-closure state. Only **nested function
types** (`compose` — a function returning a function) remain of the closure cases. Remaining gap
clusters: spread, destructuring, `try/catch`, `?.`/`??`, JSON, nested objects, and making
objects/strings linear. The gap corpus has node-verified cases waiting in `KNOWN_UNSUPPORTED`.

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
