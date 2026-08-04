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
- **Cross-compile ✅** real linked binaries running on the **Android emulator** and **iOS
  simulator** (verified through Stage 7, arrays included), plus an iOS-device arm64 Mach-O.

Coverage: base corpus **37/39**; gap corpus **53/55**. Only 2 left, both needing type-system
extensions that dovetail with Phase 2: **`JSON.parse`** (dynamic/`any` value → pairs with the
requested **runtime typechecking**) and **optional chaining `?.`** (nullable/optional unions).
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
