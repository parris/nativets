# Self-hosting roadmap

The far-horizon goal: **nativets compiles its own compiler** to a native binary, so
`nativets` no longer needs `bun`/Node to build — the frontend is already hand-written with
no `typescript` dependency precisely to make this possible.

This roadmap is **grounded in real data**: we ran the compiler's own `coverage` tool over
`src/*.ts`. It is honest about scale — self-hosting is comparable in size to everything built
so far, and the first milestone (SH0) turns it from a wall into a measurable gradient, the same
discipline as the conformance corpus.

---

## Definition of done — the 3-stage bootstrap fixed point

1. **stage-1**: `bun` runs the TS compiler, which compiles `src/` → `nativets-1` (native binary).
2. **stage-2**: `nativets-1` compiles `src/` → `nativets-2`.
3. **stage-3**: `nativets-2` compiles `src/` → `nativets-3`.

Self-hosting is achieved when **`nativets-2` and `nativets-3` are byte-identical** (the compiler
reproduces itself — the classic fixed point) **and** the full differential test suite passes when
every fixture is compiled by the self-hosted `nativets-2`. At that point `bun`/Node are build-time
conveniences, not requirements.

---

## Where we are (measured, not guessed)

`nativets coverage src/*.ts` today fails at **parse time on ~line 10 of every file** — before any
type or codegen analysis can even run:

| File | First blocker |
|------|---------------|
| `lexer.ts`, `ast.ts`, `checker.ts`, `codegen.ts`, `coverage.ts` | `type` alias / `import type` |
| `parser.ts` | `import { ... }` |
| `ownership.ts` | `import type` |
| `driver.ts` | template-literal escape (`\`) |
| `cli.ts` | `#!` shebang |

**Reading:** the gap is not "a handful of features." The compiler is written in *modular,
class-based, discriminated-union-heavy* TypeScript; nativets accepts a *single-file, module-less,
class-less, expression-oriented* subset. Whole subsystems are missing. That's fine — the plan
below sequences them.

---

## The strategic fork

- **Path A — grow nativets to accept the compiler's dialect** (modules, classes, ADTs, generics,
  host IO). Keeps the compiler source as-is; grows the language surface a lot.
- **Path B — rewrite the compiler in today's nativets subset** (functional, closures-instead-of-
  classes, tagged records-instead-of-union-types, single file). Keeps the language small; large
  rewrite plus ongoing discipline to stay inside the subset.
- **Recommended — HYBRID.** Grow the few high-leverage features that are painful to avoid
  (a single-file *bundling* step instead of a full module system; discriminated unions with
  exhaustive `switch (x.kind)`; a small host FFI), and **refactor the compiler toward the supported
  subset where it's cheap** — most importantly, replace classes with closures+records, which
  nativets *already does well* (mutable captured state à la `makeCounter`; a "class" becomes a
  factory returning a record of closures). This meets in the middle and keeps both the language and
  the rewrite bounded.

---

## Gap tiers (what blocks parse → types → semantics → runtime)

- **Tier 0 — parse/surface.** `#!` shebang; `import`/`export`; `import type`; `type` aliases;
  `interface`; `enum`; `as const`/`satisfies`; some template-literal escapes. *(Every file dies
  here today.)*
- **Tier 1 — type system.** **Discriminated unions** (`type Expr = NumberLiteral | ...` + exhaustive
  `switch (e.kind)`) — the AST is the forcing function and the crux of the whole effort; **generics**
  (`<T>` functions, and `class Map<K,V>`-style — value `Map`/`Set` already land in Stage 25);
  interface types (erased); literal-union types (`"a" | "b"`); `readonly`; index signatures.
  Hope to avoid mapped/conditional types (audit shows the compiler mostly doesn't need them).
- **Tier 2 — semantics.** **Classes** — the compiler uses plain classes (`Checker`, `Scope`,
  `ModuleGen`, `FnGen`) with fields, methods, `this`, and constructors, but **no inheritance** — so
  either add minimal class support or de-class into closures+records (recommended). Plus `new` on
  user classes, private fields, getters if used.
- **Tier 3 — runtime / host.** A small **host FFI**: read/write files (`readFileSync`/
  `writeFileSync`), **spawn a subprocess** (`spawnSync` to invoke `clang`), argv, `process.exit`,
  path join/basename, `TextEncoder`. `Map`/`Set`, `JSON`, strings, arrays, closures, `try/catch`
  are already supported. **Audit for regex** in the lexer — if present, either add regex or rewrite
  the scanner char-by-char (likely already char-by-char).

---

## Milestones

- **SH0 — Gradient first (highest-value, do first).** Teach `coverage` (and a throwaway
  parse-recovery mode) to *skip past* Tier-0 module syntax so it produces a real **blocker
  histogram** over `src/` grouped by NT code + frequency — converting "self-hosting" into a
  gradient we can burn down, exactly like the gap corpus. Also stand up the 3-stage bootstrap
  test harness (initially expected-to-fail).
- **SH1 — One module in, one module out.** Rather than a full native module system first, add a
  **bundling step**: pre-concatenate/tree-shake `src/` into a single self-contained `.ts`
  (a bundler already does this — `bun build` produces exactly this today), so nativets only ever
  sees one module. Defer a native `import`/`export`/linker to later. Handle the `#!` shebang +
  template escapes here.
- **SH2 — Discriminated unions + `type`/`interface` (the crux).** Tagged-union types with exhaustive
  `switch (node.kind)`, literal-union types, and erased `type`/`interface` aliases. This unlocks
  representing the AST natively and is the single biggest type-system lift.
- **SH3 — De-class (or minimal classes).** Refactor `Checker`/`ModuleGen`/`FnGen`/`Scope` from
  classes into closures + records (nativets closures already carry mutable state), or add minimal
  no-inheritance class support if the refactor proves too invasive. Decide with a spike on `Scope`
  (the smallest class).
- **SH4 — Host FFI.** A tiny `Host` interface in the runtime backed by libc/posix:
  `nt_read_file`, `nt_write_file`, `nt_spawn` (run `clang`, capture status/stderr), `nt_argv`,
  `nt_exit`. Wire the driver/cli through it. This is what lets a self-hosted `nativets` actually
  read a `.ts`, emit `.ll`, and invoke `clang`.
- **SH5 — Close the tail.** Run the SH0 gradient again; burn down remaining Tier-1 features the
  source actually uses (generics beyond `Map`/`Set`, specific string/array methods, spread/
  destructuring — mostly already supported). Keep going until `coverage src/<bundle>.ts` is clean.
- **SH6 — Module-by-module self-compile.** Compile `lexer` → `parser` → `checker` → `codegen` → …
  each under nativets and **differential-test its output against the `bun`-run version** (same
  discipline as everything else: the existing compiler is the oracle for the self-hosted one).
- **SH7 — Full bootstrap + fixed point.** Run the 3-stage bootstrap; assert `nativets-2` output ==
  `nativets-3` output, and the full fixture suite passes through the self-hosted binary.

---

## Keeping the gap from growing

Once SH2/SH3 define a **"self-hostable subset,"** add a lightweight check (a `coverage`-style lint
over `src/`) to CI so new compiler code that steps outside the subset is caught early. Otherwise the
target keeps moving as the compiler grows.

## Honest sizing

This is deliberately the last item on `ROADMAP.md` ("far horizon"). SH2 (discriminated unions) and
SH3 (classes) are each substantial type-system/semantics features; SH4 (host FFI) is a new runtime
surface. But SH0 is cheap and immediately turns the effort into a measured gradient — the right
first move, and the one that tells us the *true* remaining cost instead of guessing.
