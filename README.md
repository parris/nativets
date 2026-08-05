# nativets

**Write TypeScript-like code. Get a small, fast, memory-safe native binary — no Node, no V8, no JS engine in the output.**

nativets is a from-scratch compiler with a hand-written frontend (no `typescript` dependency) that lowers a TypeScript-*like* language to **LLVM IR text**, then links it with a tiny libc-only C runtime via `clang` into a single native executable for **macOS, Linux, iOS, and Android** (arm64 cross-compilation is the whole point of targeting LLVM).

It is **not** literally "native TypeScript" anymore. It is a language with a point of view: it **keeps the good parts of TS/JS**, **adds runtime types**, **borrows the parts of Elixir and Rust we love**, and **deletes the broken parts of TS/JS**. Every accepted program is differential-tested to match what `node` prints — byte-for-byte — except for a short list of deliberate, documented divergences. Anything it can't yet compile *safely* is **rejected with a diagnostic**, never miscompiled.

---

## What it looks like

Immutable data + the pipe operator (Elixir-style: the left value is threaded as the first argument):

```ts
function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }

const r = 2 |> add(3) |> mul(4);   // mul(add(2, 3), 4)
console.log(r);                    // 20
```

Immutable updates — no in-place mutation; every "change" returns a new value and the old one stays valid:

```ts
const v0: number[] = [1, 2, 3];
const v1 = v0.with(0, 100);        // ES2023 .with — returns a NEW array
const v2 = v1.with(2, 300);
console.log(v0.join(","));         // 1,2,3   (original untouched)
console.log(v2.join(","));         // 100,2,300

const o = { x: 1, y: 2 };
const p = { ...o, y: 9 };          // struct update via spread
console.log(o.y, p.y, o === p);    // 2 9 false
```

Runtime types — parse dynamic JSON and validate it against a static shape at the boundary (io-ts / zod semantics, generated from the type):

```ts
const p = JSON.parse('{"x":1,"y":2}') as { x: number; y: number };
console.log(p.x + p.y);            // 3  — throws a TypeError at runtime if the shape doesn't match
```

BEAM-style actors with supervision — a supervised worker is killed and automatically restarted to known-good state under a fresh pid:

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
```

---

## Why — the point of view

| Kept from TS/JS | Added | Borrowed from Elixir | Borrowed from Rust | Deleted from TS/JS |
|---|---|---|---|---|
| Familiar syntax; numbers, strings, booleans | **Runtime types** — `JSON.parse(s) as T` generates a validator that throws on shape mismatch | **Immutable-by-default** data | **Linear ownership** — move-checking, borrows, deterministic drop (RAII) | **In-place mutation** — `.push` / `arr[i]=` / `o.f=` are rejected |
| Arrays, objects, closures, HOFs | Static types **plus** boundary validation of dynamic data | **Pipe operator** `\|>` | **No GC, no manual free** | The value-returning `&&` / `\|\|` footgun (constrained to same-type operands) |
| Destructuring, spread, template literals | | **BEAM actors** — `spawn`/`send`/`receive`/`self`, links/monitors, `one_for_one` supervision, reduction-counted preemption | **Reference counting** for shared-immutable values (strings) | Silent miscompiles — unsupported code is **refused with a code**, not guessed |
| `try`/`catch`, `JSON`, `Map`/`Set`, `??` / `?.` | | **Persistent** `Map`/`Set` (HAMT) & array trie | **Reject-don't-miscompile** discipline (`NT####` diagnostics with fix hints) | |

The prime directive is unchanged: **`node` is the specification.** Every correctness test compiles a `.ts` file to a native binary, runs it, and asserts its stdout + exit code equal `node <file>`. If we disagree with node, we are wrong — until we deliberately document a divergence.

---

## Language & semantics

- **Types.** `number` (IEEE-754 `double` throughout), `boolean`, `string` (NUL-terminated UTF-8), arrays, structural objects (flat and nested), function types & closures, `Map`/`Set`, and a dynamic `Dyn` boxed value from `JSON.parse`. The checker infers a type for every expression; codegen is type-directed. Function signatures come from TS annotations (node strips them, so the oracle still runs).
- **Features.** Arithmetic/comparison/bitwise/logical operators; `if`/`while`/`for`/`for-of`/`for-in`/`switch`; ternary; `typeof`; recursion; arrays with `.map`/`.filter`/`.reduce` (inline arrows) and `.with`/`.slice`/`.join`/…; objects, `Object.keys`, spread & destructuring; first-class functions and closures (capture, mutable/returned, `compose`); rest & default params; `try`/`catch`/`finally`/`throw` + `new Error`; `JSON.stringify`/`JSON.parse`; `??` and `?.`; the `|>` pipe; `Math.*`, `parseInt`/`parseFloat`/`Number`, and a broad set of string methods.
- **Immutability.** Arrays and objects are immutable. In-place mutation (`arr.push`, `arr[i] = v`, `o.f = v`) is **refused** (`NT1606`), pointing at the immutable replacement (`[...arr, x]`, `arr.with(i, v)`, `{ ...o, f: v }`). `Map`/`Set` are persistent: `.set`/`.add`/`.delete` return a **new** collection, leaving the source unchanged.
- **Memory model — no GC, no manual free.** A Rust-modeled **linear ownership** pass (`src/ownership.ts`) move-checks arrays and objects: binding/returning/`move(x)` consume; indexing/`.length`/`for-of` borrow. It reports use-after-move (`NT1601` ≈ E0382), borrow-while-moved (`NT1602`), and iterator invalidation (`NT1603`), control-flow-merge- and loop-fixpoint-aware, and **blocks compilation**. Owned values are freed **deterministically at scope exit** (RAII drop, verified by live-object counters). Strings keep JS value semantics and are reclaimed by **reference counting** (no leak — `nt_str_live()` → 0). Anything the analysis can't prove single-owner is rejected, never leaked or silently refcounted.
- **Actors.** A cooperative BEAM-style runtime in C (`runtime/nt_actor.c`, driven from codegen): `spawn`/`send`/`receive`/`self`, deep-copy message passing (safe because data is immutable), `link`/`monitor` + exit-signal propagation (`trap_exit`), `one_for_one` supervision with restart-intensity limits, and reduction-counted preemption safepoints.
- **Diagnostics.** Unsupported-but-valid TS is rejected with a banded code — `NT0xxx` parse, `NT1xxx` not-yet-implemented, `NT16xx` ownership/immutability, `NT2xxx` type, `NT9xxx` ICE — each with a milestone and a fix hint. `nativets coverage <file>` reports whether a file compiles plus a histogram of blocking features, so the frontier is a gradient, not a wall.

See **[`docs/divergences.md`](docs/divergences.md)** for the full, honest list of where and why we differ from node (deliberate divergences vs. refused features).

---

## Current state

**Conformance:** base corpus **37/39**, gap corpus **53/55**. The two remaining base cases are mixed-type value-returning `&&`/`||` (a deliberate static-typing divergence). The two remaining gap cases are `array-push-pop` (deliberately refused — in-place mutation) and `higher-order-compose` (a nested-function-type edge). Both original blocked gap cases — `JSON.parse` round-trip and optional chaining — are now **closed**.

**Roughly where the stages landed** (full ledger in [`CLAUDE.md`](CLAUDE.md)):

- **Core language (Stages 1–19):** numbers/booleans/strings, all operators, control flow, functions & closures, arrays + array HOF, structural objects (nested), destructuring, spread, rest params, `try`/`catch`/`finally`, `JSON.stringify`, `switch`, builtins.
- **Memory model:** move-checker + borrows + deterministic drop for arrays **and** objects; reference-counted strings.
- **Phase A (runtime types):** `Dyn` value + `JSON.parse`; `x as T` emits an io-ts/zod-style validator that throws on mismatch; nullable/optional types + `?.` / `??`.
- **Phase B (the sharp turn):** the `|>` pipe; immutable-by-default with copy-on-write `.with`/spread; persistent `Map`/`Set` (HAMT) + array trie runtime; BEAM actors through **supervision + preemption**.
- **Phase C (finish the memory model):** deterministic drop extended to objects; move-out-of-borrow and nested/temporary drops in progress.

**Example apps** (in [`examples/`](examples/), staged in [`docs/examples.md`](docs/examples.md)):

- `calculator.ts` — a precedence-climbing expression engine (the compiler's own Pratt parser, in the supported subset).
- `calc-cli.ts` — the calculator as a real **cross-platform CLI** reading the expression from `process.argv` (the Host I/O FFI). Cross-compiles to macOS / Linux / iOS / Android unchanged.
- `calc-tui.ts` — a raw-mode **terminal UI** calculator (the achievable, genuinely cross-platform "UI").

**Release CI** (`.github/workflows/release.yml`): on a `package.json` version bump, runs the full differential suite, then builds self-contained `nativets` binaries for macOS-arm64 and Linux-x64 and publishes a GitHub Release. (Version is the `0.0.0` placeholder today, so releases are gated until the first bump.)

### Honestly not yet

- **Structural-sharing performance.** The HAMT/array-trie runtime exists, but the common `.with`/spread path is still copy-on-write (full copy); wiring persistent structures under the size threshold + transients is future work.
- **Cross-platform networking.** No sockets/TLS yet — so the north-star **LLM chat** app is a roadmap target, not a shipped example. Host I/O today is argv/stdin/env/exit.
- **Native GUI.** The retargetable backend exists; per-platform UI bindings (UIKit/Jetpack/AppKit) do not. The TUI is the current "cross-platform UI" story.
- **Actors on device.** The actor runtime uses `ucontext`, absent from the Android NDK — so it links only when a program uses actors and is host-verified; non-actor programs still cross-build to Android/iOS.
- **Self-hosting.** Far horizon, with a grounded, staged plan in [`docs/self-hosting.md`](docs/self-hosting.md) (the compiler is written in a modular, class-heavy dialect it can't yet parse; SH0 turns that into a measured gradient).

---

## Getting started

Requirements: [`bun`](https://bun.sh) (runs the compiler + drives the node oracle) and a system `clang` (v21; consumes `.ll` directly — no `llc`/`opt` needed).

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

Cross-compile the same source to another platform (LLVM retargeting; the runtime is libc-only):

```bash
./nativets build app.ts --target ios         # iOS arm64 device
./nativets build app.ts --target ios-sim     # iOS simulator arm64
./nativets build app.ts --target android     # Android arm64 (NDK)
./nativets build app.ts --target android --static   # fully static (no dynamic libc) on Linux/Android
```

Point at [`examples/`](examples/) for real programs; the cross-execution harness (`test/cross.test.ts`) actually runs a multi-feature program on the Android emulator and iOS simulator when one is booted, and skips gracefully otherwise.

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
       (swap -target / -isysroot for iOS / Android)
```

Deliberate choices: emit LLVM IR **as text** (compiled by `clang`, no `llc`/`opt`); **opaque pointers only** (LLVM 21); all numbers are `double`, float literals emitted as exact hex; **no target triple/datalayout** in the `.ll` so clang fills in host or the requested `-target` for painless retargeting. Depth on every decision lives in **[`CLAUDE.md`](CLAUDE.md)**.

---

## Testing philosophy

- **Differential vs node is the oracle.** `node case.ts` == `./compiled`. The primary correctness gate, run over every fixture. Two conformance corpora (base + gap) each gate a minimum-supported count against regressions.
- **Reject, don't miscompile.** Unsupported or unsafe constructs must produce an `NT####` diagnostic — checked by rustc-`compiletest`-style ownership/immutability/typecheck suites (`//~ ERROR NT1601` on the exact line).
- **Six test types** (see `CLAUDE.md`): differential, curated `.expected` files, IR snapshots (a debugging aid, not a correctness gate), toolchain/cross-arch smoke, conformance corpora, and cross-device execution. Where node can't be the oracle (actors, immutable-Map old-version-unchanged, `as T` failure paths), behavior is asserted by running the native binary directly.

---

## Roadmap

The full plan is in **[`docs/ROADMAP.md`](docs/ROADMAP.md)**: finish the gap + runtime typecheck (Phase A), the sharp turn — immutable data, `|>`, BEAM actors (Phase B), and finishing the memory model (Phase C), with the example apps (calculator → TUI → native GUI; LLM chat once networking lands) as north-star drivers. Design details: [`docs/phase2-design.md`](docs/phase2-design.md) (immutability + actors), [`docs/ownership.md`](docs/ownership.md) (linear memory model), [`docs/self-hosting.md`](docs/self-hosting.md) (the far-horizon bootstrap).
