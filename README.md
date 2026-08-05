# nativets

**Write ordinary-looking TypeScript. Get a small, fast, memory-safe *native* binary — no Node, no V8, no JS engine in the output.**

nativets is a **language and an environment**. You write in a TypeScript-like language; a from-scratch, hand-written compiler (no `typescript` dependency) lowers it to **LLVM IR** and links it with a tiny libc-only C runtime into a single native executable for **macOS, Linux, Windows, iOS, Android, and WebAssembly**.

It keeps the good parts of TS/JS — familiar syntax, numbers, strings, arrays, objects, closures, destructuring, JSON — and then it takes a point of view. It **adds runtime types** (validation at the boundary, not just erased annotations). It borrows its two big ideas from the languages that got them right: **ownership, borrows, and deterministic drop from Rust** (memory safety with no garbage collector), and **immutable data plus supervised message-passing concurrency from Elixir/BEAM**. And it **deletes the broken parts of TS/JS** — in-place mutation, the value-returning `&&`/`||` footgun, silent miscompiles.

The prime directive holds the whole thing honest: **`node` is the specification.** Every accepted program is compiled to a native binary, run, and checked to print exactly what `node` prints — byte-for-byte — except for a small set of *deliberate, documented* divergences. Anything nativets can't yet compile *safely* is **refused with a diagnostic**, never guessed at.

---

## A taste

The pipe operator threads a value through a chain of calls (Elixir semantics — the left value becomes the first argument):

```ts
function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }

const r = 2 |> add(3) |> mul(4);   // mul(add(2, 3), 4)
console.log(r);                    // 20
```

Data is immutable, so every "update" returns a new value and the original stays valid — there is no `.push`:

```ts
const v0 = [1, 2, 3];
const v1 = v0.with(0, 100);        // ES2023 .with — returns a NEW array
console.log(v0.join(","));         // 1,2,3     (original untouched)
console.log(v1.join(","));         // 100,2,3

const o = { x: 1, y: 2 };
const p = { ...o, y: 9 };          // struct update via spread
console.log(o.y, p.y);             // 2 9
```

Runtime types validate dynamic data at the boundary — a narrowing `as T` is a real check, not an erasure:

```ts
const point = JSON.parse('{"x":1,"y":2}') as { x: number; y: number };
console.log(point.x + point.y);    // 3 — throws a TypeError at runtime if the shape doesn't match
```

Concurrency is actors: a `spawn`ed, isolated, supervised process you talk to with `send`/`receive`. A supervisor restarts a crashed child to known-good state:

```ts
const counter = (state: number): void => {
  let s = state;
  while (true) {
    const m = receive();
    if (m === 0) { s = s + 1; } else { console.log(s); }
  }
};

const sup = supervise(
  [{ id: "c", start: (): number => spawn(counter, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 },
);
send(whereis("c"), 0);             // increment the supervised counter
```

---

## The pillars

### Familiar, but native

You write TypeScript syntax and it means what you'd expect. The supported language covers `number` (IEEE-754 `double` throughout), `boolean`, `string`, arrays, structural objects (flat and nested), first-class functions and closures (capture, mutable/returned, `compose`), `Map`/`Set`, and a dynamic value from `JSON.parse`. On top of that: all the operators (arithmetic, comparison, bitwise, logical); `if`/`while`/`for`/`for-of`/`for-in`/`switch`; ternary and `typeof`; array HOFs (`.map`/`.filter`/`.reduce` with inline arrows); destructuring, spread, and rest params; `try`/`catch`/`finally`/`throw` with `new Error`; `JSON.stringify`/`JSON.parse`; `??` and `?.`; the `|>` pipe; and a broad builtin surface (`Math.*`, `parseInt`/`parseFloat`/`Number`, string methods, and a growing standard library).

There is no interpreter and no runtime engine in the output. The checker infers a type for every expression and codegen is type-directed; the result is one native executable that links only against the platform's libc. And `node` is the oracle for all of it — every feature above ships with fixtures whose native output is diffed against `node`.

### Runtime types

TypeScript's types vanish at runtime, so dynamic data (a parsed request, a config file) enters your program unchecked. nativets keeps the static types **and** validates at the boundary. `JSON.parse(s)` returns a dynamic value; narrowing it with `x as T` emits a validator — generated from `T`'s static shape, io-ts/zod in spirit — that walks the value, checks every scalar tag, requires every object field, and recurses into arrays. On a shape mismatch it **throws a `TypeError`**; on success it hands back a statically-typed `T`.

This is a deliberate divergence: `tsc`/`node` erase `as` to nothing. Success paths match `node` byte-for-byte; failure paths throw where `node` would silently produce `undefined`/`NaN`/garbage. That is the point — bad shapes fail loudly at the edge instead of corrupting logic deep inside.

### Immutable by default

Arrays and objects are **values**, not mutable cells. In-place mutation is not "discouraged" — it is **rejected at compile time** with `NT1606`, pointing you at the immutable replacement:

- `arr.push(x)` / `arr.pop()` → `[...arr, x]`
- `arr[i] = v` (and `arr[i] += v`) → `arr.with(i, v)`
- `o.f = v` → `{ ...o, f: v }`

`Map`/`Set` are persistent the same way: `.set`/`.add`/`.delete` return a **new** collection and leave the source unchanged. This is a chosen divergence from JS, and it is what makes the rest of the design cheap: if nothing can be mutated behind your back, aliasing is safe and messages between actors can be shared or copied without data races. The immutable API itself is node-matched (`.with` is real ES2023; spread runs identically on `node`), so the oracle still applies.

### Memory without a GC

nativets is memory-safe by construction, with **no garbage collector and no manual `free`** — it splits the problem the way the value model suggests:

- **Uniquely-owned values (arrays, objects)** use **Rust-style linear ownership**. A dataflow pass modeled on rustc's borrowck (`src/ownership.ts`) tracks a single owner: binding, returning, and `move(x)` consume; indexing, `.length`, and `for-of` borrow. It reports use-after-move (`NT1601` ≈ E0382), borrow-while-moved (`NT1602` ≈ E0505), iterator invalidation (`NT1603` ≈ E0502), and move-out-of-borrow / array-element (`NT1604`/`NT1605` ≈ E0507/E0508) — control-flow-merge- and loop-fixpoint-aware — and **blocks compilation**. Owned values are then **freed deterministically at scope exit** (RAII drop), exactly once, by their final owner, never a moved-out value.
- **Shared-immutable values (strings)** keep JS value semantics (copy/alias freely) and are reclaimed by **reference counting**. Because they're immutable, sharing is always safe; they are never move-checked.

The guarantee is checked, not asserted: live-object counters (`__arrLive()`, `__objLive()`, `nt_str_live()`) balance to zero, on the host and on-device. Anything the analysis can't prove single-owner is refused, never leaked and never silently refcounted around.

### Concurrency: one primitive, the runtime picks the substrate

nativets has exactly **one** concurrency primitive: the **actor**. You `spawn` a supervised, isolated process; you talk to it with `send`/`receive`; you learn your own identity with `self`. You never choose between a thread, an async task, a worker, or a subprocess — that choice does not exist in the language.

Two invariants define what an actor *is*, and they never change:

- **Isolation.** Each actor has its own private state. Messages are deep-copied on send, so no two actors ever share a mutable cell. This is safe and cheap *precisely because data is immutable* — there is no shared mutable state, and therefore no data races, by construction.
- **Supervision.** A crash is contained to the one actor that crashed. Its `one_for_one` supervisor observes the exit and restarts the child to a **known-good initial state** under a fresh pid — the canonical BEAM kill-and-restart — with restart-intensity limits that escalate if a child crash-loops.

What those invariants run *on* is the runtime's job, and it is meant to evolve. **Today** the substrate is lightweight cooperative green-threads — `ucontext` coroutines on a single scheduler — made fair by **compiler-emitted, reduction-counted preemption**: codegen plants yield-safepoints at call sites and loop back-edges, and an actor that burns its reduction budget is preempted and re-enqueued. **On the roadmap** the substrate becomes M:N scheduling (millions of cheap actors across N OS threads), and potentially OS-process isolation — all behind the *same* `spawn`/`send`/`receive`/`supervise` API. It doesn't matter which execution option sits underneath: the actor model is the interface, and the runtime provides whatever substrate fits the target and the workload.

The payoff over JS async is concrete. In JS, a failure is an unhandled rejection floating unowned, with an async stack stitched from fragments. Here, every asynchronous unit *is* a supervised, isolated process, so a failure is a localized, owned event: a crash yields a real **synchronous** stack, the **triggering message** that caused it (the field JS traces lack), and a **restart decision** made by a designated owner. Immutability and ownership aren't a separate feature list — they are *why* isolation is cheap and message passing is safe.

### Retargetable

The compiler emits LLVM IR with **no target triple or datalayout**, and the C runtime is **libc-only**. So the same source and the same IR retarget by swapping a flag — `clang` fills in the host or the requested target:

```bash
nativets build app.ts --target ios         # iOS arm64 (device)
nativets build app.ts --target ios-sim     # iOS simulator arm64
nativets build app.ts --target android     # Android arm64 (NDK)
nativets build app.ts --target wasm        # WebAssembly (WASI)
nativets build app.ts --target windows     # Windows x86-64 (MSVC/UCRT)
nativets build app.ts --target android --static   # fully static, no dynamic libc
```

macOS/Linux/iOS/Android are verified by **actually running** — the cross-execution harness runs a multi-feature program on the Android emulator (`adb`) and the iOS simulator (`simctl`) and diffs it against `node` when a device is booted. Some **host-facing** features degrade honestly by target: actors need `ucontext`, so they are host-verified and **excluded on wasm** (a clear build error, not a cryptic link failure); the libcurl-backed HTTP client links on **host/Linux only**; and `--static` produces a fully static binary on **Linux/Android** while macOS/iOS/Windows/wasm fall back to (or simply are) dynamically linked. Non-networking, non-actor programs cross-build everywhere.

### Reject, don't miscompile

The one thing a compiler must never do is silently produce a wrong program. nativets refuses instead. Unsupported-but-valid TS, and unsafe code, are rejected with a **banded `NT####` diagnostic** — `NT0xxx` parse, `NT1xxx` not-yet-implemented, `NT16xx` ownership/immutability, `NT2xxx` type, `NT9xxx` ICE — each carrying a milestone and a fix hint, with rustc-style multi-span pointers (a use-after-move points at both the use and the earlier move). `nativets coverage <file>` turns the frontier into a **gradient, not a wall**: it reports whether a file compiles and a histogram of what blocks it, grouped by code and frequency.

See [`docs/divergences.md`](docs/divergences.md) for the full, honest list of deliberate divergences versus refused features.

---

## Current state

**Conformance:** base corpus **37/39**, gap corpus **53/55**. Both remaining gap cases are **deliberate**, not gaps in disguise: `array-push-pop` is *refused by design* now that arrays are immutable (mutation is `NT1606`), and `higher-order-compose` is a nested-function-type edge. The two originally-hard gap cases — `JSON.parse` round-trip and optional chaining — are both **closed**.

**Where the stages landed** (full ledger in [`CLAUDE.md`](CLAUDE.md)):

- **Core language:** numbers/booleans/strings, all operators, control flow, functions & closures, array HOFs, structural (nested) objects, destructuring, spread, rest params, `try`/`catch`/`finally`, `JSON.stringify`, builtins.
- **Runtime types:** dynamic `JSON.parse` value; `x as T` generates an io-ts/zod-style validator that throws on mismatch; nullable/optional types with `?.` and `??`.
- **The sharp turn:** the `|>` pipe; immutable-by-default arrays/objects (`.with`/spread); persistent `Map`/`Set` (HAMT) and an array vector-trie in the runtime.
- **Memory model:** linear move-check + borrows + deterministic drop for arrays **and** objects; reference-counted strings.
- **Actors:** `spawn`/`send`/`receive`/`self`, deep-copy message passing, `link`/`monitor` + exit propagation, `one_for_one` supervision with restart-intensity limits, and reduction-counted preemption.
- **Tooling & distribution:** `nativets build|run|emit|coverage`; `--static`; multi-span diagnostics; a GitHub Actions release workflow that builds self-contained macOS/Linux binaries on a version bump.

**Example apps** (in [`examples/`](examples/), staged in [`docs/examples.md`](docs/examples.md)):

- `calculator.ts` — a precedence-climbing expression engine, in the supported subset.
- `calc-cli.ts` — the calculator as a real **cross-platform CLI** reading its expression from `process.argv`; cross-compiles to macOS/Linux/iOS/Android unchanged.
- `calc-tui.ts` — a raw-mode **terminal UI** calculator (the achievable, genuinely cross-platform "UI").
- `chat.ts` — a CLI **LLM chat** client: argv + stdin loop + `JSON.stringify`/`JSON.parse` over a libcurl HTTP+TLS `POST` (host/Linux).

**Honestly not yet:**

- **Structural-sharing performance.** The HAMT and array-trie runtime exists, but the common `.with`/spread path is still a full copy; wiring persistent structures + transients under the size threshold is future work.
- **M:N scheduling.** Actors run on one cooperative scheduler today; M:N OS threads and lock-free mailboxes are designed but deferred.
- **Cross-platform networking and native GUI.** HTTP works on host/Linux via libcurl; mobile stacks (NSURLSession/OkHttp) are a follow-on. A raylib-backed native GUI is **in progress**; the TUI is today's cross-platform UI story.
- **Self-hosting.** A far-horizon goal with a grounded, staged plan in [`docs/self-hosting.md`](docs/self-hosting.md) — the compiler is written in a modular, class-heavy dialect it can't yet parse, and SH0 turns that gap into a measured gradient.

---

## Getting started

Requirements: [`bun`](https://bun.sh) (runs the compiler and drives the `node` oracle) and a system `clang` (v21 — it consumes `.ll` directly, so no `llc`/`opt` needed).

```bash
bun install
bun test                       # the full differential + conformance + ownership suite

bun run compile                # build the self-contained ./nativets binary
                               # (bundles the compiler + embedded C runtime; needs only a system clang)
```

Then drive it:

```bash
./nativets run   examples/calc-cli.ts -- 2 + 3 '*' 4   # compile to a throwaway binary and run it
./nativets build examples/calc-cli.ts -o calc          # emit a single native executable
./nativets emit  examples/calculator.ts                # print the generated LLVM IR
./nativets coverage src/parser.ts                      # does it compile? what blocks it, by NT code?
```

Cross-compile the same source with `--target host|ios|ios-sim|android|wasm|windows` and, on Linux/Android, `--static`. Point at [`examples/`](examples/) for real programs.

---

## Architecture

```
source.ts
  └─ src/lexer.ts      hand-written tokenizer (no `typescript` dep)
  └─ src/parser.ts     recursive-descent + Pratt precedence
  └─ src/checker.ts    scope resolution + static type inference
  └─ src/ownership.ts  linear move/borrow analysis + drop points (rustc-modeled)
  └─ src/codegen.ts    lower to LLVM IR text (.ll), type-directed
  └─ src/driver.ts     clang out.ll + runtime/*.c  →  native binary
                       (swap --target for iOS / Android / wasm / Windows)
```

Deliberate choices: emit LLVM IR **as text** (compiled by `clang`, no `llc`/`opt`); **opaque pointers only** (LLVM 21); all numbers are `double`, with float literals emitted as exact hex; and **no target triple/datalayout** in the `.ll` so retargeting is a flag away. The rationale behind every decision lives in [`CLAUDE.md`](CLAUDE.md); design deep-dives are in [`docs/`](docs/) — [`ownership.md`](docs/ownership.md) (memory model), [`phase2-design.md`](docs/phase2-design.md) (immutability + actors), [`stdlib.md`](docs/stdlib.md), and [`self-hosting.md`](docs/self-hosting.md).

---

## Roadmap

The full plan is in [`docs/ROADMAP.md`](docs/ROADMAP.md): finish the gap and runtime typechecking, the sharp turn (immutable data, `|>`, BEAM actors), and completing the memory model — with the example apps (calculator → TUI → native GUI; the LLM chat) as the north-star drivers that force each capability into existence.
