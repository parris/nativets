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

*(Historical snapshot — `import`/`export`/`type`/`interface`/`class` have since landed; see the
milestones below.)*

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

### Re-measured after M3 (generic functions — Stage 33)

`coverage` over `src/*.ts` now reports, whole-tree:

| Code | × | What it actually is |
|------|---|---------------------|
| `NT0001` | 15 | statements outside the accepted subset — see the named causes below |
| `NT1606` | 4 | `this.f = v` / `o.f = v` field mutation inside `Checker`/`ModuleGen`/`FnGen`/`Analyzer` |
| `NT1009` | 1 | a general union type (`Record<string, number \| "var">` in `checker.ts`) |
| `NT1013` | **0** | **cleared** — generic type args erase (SH2) and generic functions monomorphize (M3) |

**The `NT1013` count was never real.** `coverage.classifyParseFailure` used to re-label any
unparsed statement whose *text* matched `Name<…>` as "generic type arguments". Every one of the
hits it produced over `src/` was a misattribution of an unrelated failure — `class Parser { …
this.pos++ }`, `async function guard<T>` (blocked on `await`), a `\` escape in `codegen.ts`. That
heuristic is removed; a histogram that names the wrong feature aims the burn-down at the wrong
thing. `NT0001` is now reported honestly, and the *named* residual causes, in frequency order, are:

1. **`await` / `async`** (`cli.ts` ×4) — the largest single bucket, and the whole of `cli.ts`.
2. **postfix `++`/`--` on a member or index target** (`this.pos++`, `b.count++`) — `UpdateExpr`
   only models an identifier target. `parser.ts` ×1, `coverage.ts` ×1.
3. **binding patterns in parameters / `for-of`** (`([k, v]) => …`, `for (const [k, v] of m)`) —
   destructuring is a *declaration* desugaring only. `ownership.ts` ×2.
4. **a parenthesized expression misread as an arrow parameter list** (`(t.slice(2) as Ty)` in a
   ternary arm) — a `looksLikeArrow` lookahead gap. `ast.ts` ×2.
5. **template-literal / string escapes** — a nested template in `ast.ts`, `\\22` in `codegen.ts`.
6. **`delete o.k`** and a couple of class-body shapes in `checker.ts`.

Four modules — `lexer.ts`, `diagnostics.ts`, `driver.ts`, `coverage-preprocess.ts` — now report
**no blockers at all** at statement granularity.

### Re-measured after the `NT0001` burn-down — the parse tail is GONE

`coverage` over all twelve `src/*.ts` modules now reports, whole-tree:

| Code | × | What it actually is |
|------|---|---------------------|
| `NT0001` | **0** | **cleared** — every statement in the compiler's own source parses |
| `NT1606` | 8 | `this.f = v` / `this.f++` field mutation in `Parser`/`Checker`/`FnGen`/`Analyzer`/`coverage` |
| `NT1015` | 2 | a `static` member in `ModuleGen`; a class field needing a type annotation in `modules.ts` |
| `NT1009` | 1 | a general union type (`Record<string, number \| "var">` in `checker.ts`) |
| `NT1013` | 0 | still cleared (SH2 erasure + M3 monomorphization) |

The ×11 `NT0001` bucket was six small, concrete gaps, closed one at a time against a node oracle
(fixtures in `test/selfhost-parse/`, gate in `test/selfhost-parse.test.ts`, whole-tree assertion in
`test/self-host-coverage.test.ts`):

1. **`(expr as T)` / `(x)` in a ternary arm** misread as an arrow parameter list. `looksLikeArrow`
   committed to the arrow grammar on any `) :`; it now also requires the parens to hold a real
   parameter list *and* a top-level `=>` after the return-type annotation. (`ast.ts` ×2)
2. **Nested template literals** — the lexer ended the outer template at the first backtick inside a
   `${…}` substitution. It now tracks substitutions (with nested templates, quoted strings and
   braces), and the parser's splitter skips quoted runs to match. (`ast.ts` ×1, `codegen.ts` ×1)
3. **Radix + separator numeric literals** `0x22` / `0b1010` / `0o17` / `1_000`. (`codegen.ts` ×1)
4. **`++`/`--` on a member or index target** (`this.pos++`, `u[i]++`). Mutability mirrors plain
   assignment exactly (Stage 29): a `Uint8Array` element and `this.f` inside a constructor are
   writable; every other field/element is `NT1606`. (`parser.ts` ×1, `coverage.ts` ×1)
5. **`instanceof`**, decided at COMPILE TIME from the static type — exact, because a value's static
   type IS its class in this subset. Right operands a static type cannot decide are refused with the
   new **`NT1022`**, notably `instanceof Error` (nativets models `Error` structurally as
   `{message:string}`, so an Error and a plain record with a `message` are the same type). (`cli.ts` ×1)
6. **Binding patterns in parameter position** (`([k, v]) => …`) — the Stage-15 declaration
   desugaring extended to parameters, arrows/functions/methods/constructors alike. (`ownership.ts` ×1)

Two of the six as originally named were **misdiagnoses the measurement corrected**: the `ast.ts`
failure was the nested template on that line, not the `{ key: string; ty: Ty }[]` annotation (which
already parsed); and the `codegen.ts` failure was hex *number* literals, not the `\xHH` *string*
escape (which already worked — `test/hex-escape.test.ts`). Two extra gaps the same pass turned up
were closed with them: **parenthesized types** (`(() => Scope) | null`) and **`delete o.k`**, which
is now named as the mutation it is (`NT1606`) instead of "unparsed".

**Reading:** self-hosting is no longer blocked on *syntax*. The dominant blocker is now `NT1606` —
the compiler is written with mutable class fields (`this.pos++`, `this.mode = …`), which the
immutable-by-default model (Stage 29) only permits inside a constructor. That is a decision about
the *source* (refactor those classes into fold/return-new shapes) or about the *language* (make
class instance fields mutable), not a missing feature. The remaining `NT1015`/`NT1009` are a
`static` member, one un-annotated class field, and one general union.

### Re-measured again — `NT1606` is down to ONE, and it is deliberate

The `NT1606` bucket above resolved into two different things, and both are now closed by the
`@@mutable` attribute rather than by rewriting the compiler:

- **three CLASS-field mutations** (`Parser`, `FnGen`, `Analyzer`) — Stage 45's `@@mutable class`
  already covered these;
- **five plain-RECORD mutations** (`s.returnTy = ret`, `sig.ret = inferred`, `b.count++`) — the
  compiler mutates AST nodes in place, and those are structural records, not class instances.
  `@@mutable` was **extended to a `type`/`interface` declaration** for them (docs/decorators.md).

**Both had to be spelled as a comment.** `@@mutable` is not valid TypeScript, and `src/*.ts` has to
satisfy **two toolchains at once** — bun runs it today, nativets must compile it tomorrow. So the
attribute has a **pragma spelling**: a line comment whose entire content is `@@name` lexes to
exactly the same two tokens as the bare sigil (`src/lexer.ts`). It is a comment to TypeScript and
load-bearing to nativets, and the two spellings emit byte-identical IR (pinned in
`test/mutable-records.test.ts`). This is the general answer for every future attribute, not a
one-off for `@@mutable`.

| Code | × | What it actually is |
|------|---|---------------------|
| `NT1014` | 4 | `new Map(iterable)` / `new Set(iterable)` — **newly visible**: `coverage` now counts a FEATURE blocker the CHECKER reports, not only parse-stage ones |
| `NT1009` | 3 | general unions / an intersection type |
| `NT1015` | 3 | a `static` member (`ModuleGen`), a `get` accessor (`FnGen`, unmasked), a class field needing a type annotation (`modules.ts`) |
| `NT0001` | 2 | a **regex literal** (`checker.ts`) and **`satisfies`** (`parser.ts`) — both *unmasked*, i.e. reached only because an earlier blocker on the same class was cleared |
| `NT1606` | **1** | `delete o.k` in `specializeDecl` — **deliberate**: a record's SHAPE is its type (fields are static slots), so removing a key is a different feature from assigning one |
| `NT1003` | 1 | `driver.ts` calls an *imported* function, which single-file coverage sees as an unknown callee — an artifact of the measurement, not a gap |

Two measurement changes came with this, both in the direction of honesty:

1. **`coverage` now counts checker-stage NT1xxx blockers**, not only parse-stage ones. Without that,
   moving the `o.f = v` rejection from the parser to the checker (which is what deferring the
   mutability decision to a type required) would have looked like eight blockers *vanishing*. Only
   the NT1xxx band is counted — an NT2xxx type error is a real user error, and under this tool's
   statement-at-a-time recovery it is usually an artifact of the recovery itself.
2. **A DECORATED `type`/`interface` is no longer pre-stripped** by the coverage preprocess, and
   `ParseOpts.collectTypes` threads the alias table across the statement loop — otherwise a
   `@@mutable type Cell = …` in one statement would be invisible to the `c.n = 1` in the next and
   `coverage` would report an NT1606 the real compiler does not. Undecorated type declarations are
   still stripped, so every other number in the table is comparable with the previous measurement.

**What still stands between here and SH6** (module-by-module self-compile) is no longer mutation:
it is **discriminated unions** (`NT1009` — the AST *is* a union type, and that is Tier 1's crux),
the last three **class features** (`static`, `get`), and two small syntax gaps (**regex literals**,
**`satisfies`**).

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

- **Tier 0 — parse/surface.** `#!` shebang; ~~`import`/`export`; `import type`~~ (**done, SH1**);
  `type` aliases;
  `interface`; `enum`; `as const`/`satisfies`; some template-literal escapes. *(Every file dies
  here today.)*
- **Tier 1 — type system.** **Discriminated unions** (`type Expr = NumberLiteral | ...` + exhaustive
  `switch (e.kind)`) — the AST is the forcing function and the crux of the whole effort;
  ~~**generics** (`<T>` functions…)~~ **DONE** — type arguments erase (SH2) and `<T>` *functions*
  monomorphize (M3 / Stage 33); value `Map`/`Set` landed in Stage 25; generic *classes* remain
  deferred (`NT1015`).
  Interface types (erased); literal-union types (`"a" | "b"`); `readonly`; index signatures.
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

## MEASURED: the real stage-1 frontier (`test/bootstrap.test.ts`)

The coverage histogram above is **not** the bootstrap frontier, and reads far more
optimistic than the truth. `coverage` runs a coverage-ONLY preprocess
(`src/coverage-preprocess.ts`) that strips the module preamble **and regex literals**
so it can reach a feature histogram at all. Running the compiler's own *unpreprocessed*
pipeline over `src/*.ts` gives a different answer:

| Phase reached | Modules |
|---|---|
| **`lex`** — does not even tokenize | `ast`, `lexer`, `diagnostics`, `ownership`, `driver`, `cli`, `modules`, `coverage-preprocess` (**8 of 12**) |
| **`parse`** | `parser` (`NT0001` at a `!` non-null assertion), `checker` (`NT1009` general union), `codegen` (`NT1015` `static` member) |
| **IR** | `coverage` only |

**Blocker #1 is REGEX LITERALS, by a wide margin.** All 8 lex failures are the same
construct: the lexer does not tokenize `/.../` at all, so the first `\` inside one is
an `Unexpected character`. `cli.ts` is the sharpest illustration — coverage reports it
`parsed: true` with **zero** blockers, while it does not survive the lexer.

### The wall is DOWN — regex literals now lex (`NT1027`)

Rather than guess what was behind it, the lexer now **tokenizes** `/pattern/flags` and the
parser refuses it with **`NT1027`**. No engine is added: nativets still deliberately has
**no `RegExp`** (Tier C). What changes is that a regex is a *located, named* refusal
instead of a character-level crash that killed the whole file — the SH0 move, a wall
becoming a gradient.

The risk was misreading a **division** as a regex, which would silently swallow code to
the next `/`. Two guards prevent it: the standard previous-token rule (a `/` after
anything that can END an expression — identifier, literal, `)`, `]`, postfix `++`/`--` —
is division; only after an operator or one of `return`/`typeof`/`case`/… can a regex
start), and a required closing `/` on the **same line**, since a regex literal cannot
span lines. Pinned by a division corpus in `test/bootstrap.test.ts`, plus the whole
fixture suite.

**Result — every module now reaches at least `parse`, and the tier behind the wall is
visible for the first time:**

| Blocker | Modules | What it is |
|---|---|---|
| `NT0001` | `ast`, `lexer`, `parser`, `ownership`, `coverage` | the postfix **`!` non-null assertion** (TS-only, erased at runtime — should be cheap) and one `satisfies` |
| `NT1017` | `driver`, `cli`, `modules` | **`node:fs` and friends** — the host FFI, i.e. milestone **SH4** |
| `NT1027` | `diagnostics`, `coverage-preprocess` | genuine regex uses (2 modules, not 8) |
| `NT1009` | `checker` | a general union — still the crux (the AST *is* a discriminated union) |
| `NT1015` | `codegen` | a `static` member |

### Re-measured after SH4 — the host FFI is no longer a blocker

`NT1017`'s three modules are past it. Clearing a blocker UNMASKS what sat behind it, so the
regex bucket grew from 4 modules to 6 — the gradient working, not a regression:

| Blocker | Modules | What it is |
|---|---|---|
| `NT1027` | `lexer`, `diagnostics`, `ownership`, `coverage-preprocess`, **`cli`**, **`modules`** | regex literals — now the **dominant** blocker, at half the tree |
| `NT0001` | `ast`, `coverage`, `parser` | a template-literal TYPE (`` `${string}[]` ``) and `satisfies` |
| `NT1009` | `checker` | a general union — **still the crux** |
| `NT1015` | `codegen` | a `static` member |
| `NT1017` | `driver` | **not** a `node:` module: the bun text-asset import `import runtimeSource from "../runtime/runtime.c" with { type: "text" }` |
| `NT1028` | — | the host FFI surface is complete for what `src/*.ts` imports |

That reorders the plan. **`!` is now the cheapest win** and unblocks five modules;
**`node:fs` (SH4)** is the real structural work, not regex. Only two modules genuinely
need regex removed, so the "~28 sites, Path B" rewrite is far smaller than the wall
suggested — measuring first was the right call.

`test/bootstrap.test.ts` pins all of this as a **ratchet** — each module's furthest
phase is recorded and may improve but never regress, so new compiler code cannot
silently grow the gap (the lint this document asks for under "Keeping the gap from
growing"). The `#!` shebang blocker listed under SH1's tail is **closed**.

### Re-measured after SH2 — the union blocker did NOT move, and that is the finding

Running the unpreprocessed pipeline again after discriminated unions landed, `checker.ts`
still stops at `NT1009`, on the *same* construct: `Record<string, number | "var">`, i.e.
`number | string` — a **scalar** union, which SH2 deliberately does not represent. Nothing
else in the table changed (`ast` `NT0001` at a template-literal TYPE on line 14, `parser`
`satisfies`, `codegen` `static`, three modules `node:fs`, two genuine regexes).

The reading is not "SH2 achieved nothing" — it is that the frontier is a *conjunction*, and
the union arm of it has two remaining pieces rather than one:

1. **Scalar unions** (`number | string`) — the literal `checker.ts` blocker. Unlike an object
   union there is no in-value tag to dispatch on, so this genuinely needs the boxed
   representation (a `[tag, value]` block, the nullable encoding generalized).
2. **Recursive types** — `src/ast.ts`'s `Expr` is not merely a union, it is a union whose
   members refer back to it. That is a `Ty`-encoding problem, not a union problem
   (`interface N { next: N }` has always erased to `number`), and it is what would still
   stop the AST from being expressible even with unions in hand.

`coverage src/checker.ts` reports the same one `NT1009` before and after; what it does show is
**347 → 355 statements analyzed**, and `coverage src/ast.ts` **182 → 257** — the union
declarations and everything downstream of them now get as far as being analyzed at all.

---

## Milestones

- **SH0 — Gradient first (highest-value, do first).** Teach `coverage` (and a throwaway
  parse-recovery mode) to *skip past* Tier-0 module syntax so it produces a real **blocker
  histogram** over `src/` grouped by NT code + frequency — converting "self-hosting" into a
  gradient we can burn down, exactly like the gap corpus. Also stand up the 3-stage bootstrap
  test harness (initially expected-to-fail).
- **SH1 ✅ — A real module system (`import` / `export`).** Superseded the "bundle it first" plan:
  nativets now resolves the import graph itself. `src/modules.ts` is a **whole-program linker** —
  from the entry file it resolves every `./relative.ts` specifier, loads each module **exactly
  once**, orders them by dependency (post-order DFS, matching ESM evaluation order), alpha-renames
  each non-entry module's top-level bindings with a per-module prefix, and merges everything into
  **ONE `Program`**. The checker, ownership pass and codegen are unchanged — they still see a
  single program and still emit a single triple-free `.ll`.

  - **Supported surface.** `import { a, b as c } from "./m.ts"`; `import type { T } from …` and
    inline `import { type T, x }` (erased, but the type still resolves in the importer);
    `import "./m.ts"` (side-effect only); `export` of `function` / `const` / `let` / `class` /
    `type` / `interface`; `export { a as b }`; and the re-export `export { x } from "./y.ts"`.
  - **Module scope is real.** A module's functions see its module-level bindings — an
    `export const` read from inside an exported function was the forcing case. Bindings a function
    body actually reads are promoted to LLVM globals (`@nt.g.<name>`), written by `main` in module
    order; everything else stays a `main` local, so single-file IR is byte-identical to before.
  - **Refused, never miscompiled.** `export default`, `import * as ns`, `export * from`, dynamic
    `import()`, and bare/`node_modules` specifiers → **NT1017** with a hint naming the supported
    form. Graph defects get the new **NT17xx** band: **NT1701** unreadable module, **NT1702**
    import cycle (named, in order — it never hangs), **NT1703** no such export (listing what IS
    exported).
  - Tests: `test/modules.test.ts` + `test/modules/` (node is still the oracle — it resolves the
    same `./x.ts` specifiers). Multi-module dogfood apps: `examples/roman-modular/` (the single-file
    `examples/roman.ts` rebuilt as three modules, asserted byte-identical) and `examples/inventory/`.

  Still open from the original SH1 scope: the `#!` shebang and the remaining template-literal
  escapes.
- **SH2 ✅ (discriminated unions) — the crux, landed.** `type Shape = Square | Rectangle | Circle`
  where every member is an object type carrying a common literal-typed tag field. Declared,
  constructed, passed, stored in arrays; narrowed by `if (x.kind === "…")` (both arms — the else
  gets the remaining members as a sub-union), by `switch (x.kind)` (including `default:` and
  fallthrough), and by ELIMINATION after a guard clause (`if (…) return;` narrows the rest of the
  block). Exhaustiveness is diagnosed for the one shape that goes wrong. Tests: `test/unions.test.ts`
  + `test/unions/`, cases borrowed from `microsoft/TypeScript`
  `tests/cases/conformance/types/union/discriminatedUnionTypes{1,2}.ts`.

  - **Representation: there is NO box.** A union value simply IS the member's object block. The
    tag already lives in the value as the discriminant field, so the union is accepted only when
    that field sits at the SAME slot index in every member — and then `u.kind` is an ordinary slot
    load, narrowing is a pure retype costing nothing at runtime, and object literals, slots,
    equality, linearity and drop are all the existing object machinery unchanged. The Ty encoding
    is `U<{k:"a",…}|{k:"b",…}>`, distinct from every other encoding (it ends in `>`, not `}`/`[]`).
  - **String-literal types** (`"square"`) exist only to carry those tags. The parser keeps them
    (`parseTypeInner`) and `parseType` widens them back to `string` for every type that is not a
    union, so `type Dir = "n" | "s"` still collapses and nothing past the checker sees one.
  - **Linear, like the record it is** — move-checked (`NT1601`) and dropped once (`nt_obj_free`,
    `__objLive()` → 0). Consequently `const n = nodes[i]` on a union array is `NT1605`, exactly as
    for an object element (Stage 28); pass it by value instead.
  - **Refused, never guessed at (`NT1009`):** a union of object types with no usable discriminant
    (no shared field / not literal-typed / duplicated tag value / tag at a different position in
    different members — each with its own message), and any union that is not all object types,
    which notably still includes **scalar unions** (`number | string`) and intersections.
  - **Still open, and it is what blocks the AST itself: RECURSIVE types.** `interface Negate {
    operand: Expr }` cannot be written in nativets at all — `Ty` is a flat string, so a
    self-reference has no finite encoding and resolves to `number`. This is pre-existing and
    union-independent (`interface N { next: N }` has always erased), but it means `src/ast.ts`'s
    own `Expr` needs either arena indices or a named-reference in the type encoding.
  - **NT1009 in `checker.ts` did NOT move**: its blocker is `Record<string, number | "var">`, a
    SCALAR union — the next piece of this milestone.
- **SH3 — De-class (or minimal classes).** Refactor `Checker`/`ModuleGen`/`FnGen`/`Scope` from
  classes into closures + records (nativets closures already carry mutable state), or add minimal
  no-inheritance class support if the refactor proves too invasive. Decide with a spike on `Scope`
  (the smallest class).
- **SH4 ✅ — Host FFI.** `node:` specifiers now resolve to **compiler builtins** rather than files:
  the parser binds the named members of a `node:` module (`HOST_MODULES` in `ast.ts`), erases the
  import, and publishes the canonical names on `Program.hostImports`; the checker types them from
  `HOST_FUNCS` and codegen lowers each to a runtime call. A host builtin is deliberately **not
  ambient** — it is in scope only where it was imported, exactly like node — so a program that
  defines its own `join`/`readFileSync` is unaffected.

  - **Implemented, and exactly what `src/*.ts` imports** (the grep drove the list):
    `node:fs` — `readFileSync` / `writeFileSync` / `existsSync` / `mkdtempSync` / `readdirSync` /
    `rmSync`; `node:path` — `join` / `dirname` / `basename` / `resolve` / `relative` (a faithful C
    port of node's own `lib/path.js` posix functions); `node:os` — `tmpdir` / `homedir`;
    `node:url` — `fileURLToPath`; `node:child_process` — `spawnSync`.
  - **All libc/POSIX** (stdio, `stat`, `dirent`, `mkdtemp`, `fork`+`execvp`+`poll`), so
    `runtime/runtime.c` cross-links unchanged: iOS-sim, iOS-device and Android arm64 all link a
    program using the FFI, and it **RUNS on the iOS simulator** (fs + a real `spawnSync`).
  - **Errors are node's, byte-for-byte** (`ENOENT: no such file or directory, open '/x'`) through
    the pending-exception protocol, and a try block containing a host call binds `catch (e)` to
    `{message:string}`, so `e.message` matches node.
  - **Refused, never half-implemented — `NT1028`:** an unimplemented `node:` module or member, and
    the argument *values* that decide what node returns (`readFileSync` with no/computed encoding,
    `spawnSync` without `{ encoding: "utf8" }` or with any other option, `rmSync` with a `false`
    flag). One documented divergence: `spawnSync().status` is `-1` where node reports `null` — see
    `docs/divergences.md`.
  - Tests: `test/hostfs.test.ts` (39, node-differential except the refusal table and the
    documented `status` divergence).

  **Measured effect:** the three modules NT1017 used to stop — `driver.ts`, `cli.ts`, `modules.ts`
  — are all past the host FFI. `cli.ts` and `modules.ts` now stop on a **regex literal** (NT1027,
  the deliberate Tier-C refusal) and `driver.ts` on a *different* NT1017: the bun text-asset import
  `import runtimeSource from "../runtime/runtime.c" with { type: "text" }`, a bundler feature rather
  than a `node:` module. `NT1028` does not appear in the frontier at all.
- **SH5 — Close the tail.** Run the SH0 gradient again; burn down remaining Tier-1 features the
  source actually uses (generics beyond `Map`/`Set`, specific string/array methods, spread/
  destructuring — mostly already supported). Keep going until `coverage src/<bundle>.ts` is clean.
  **Generics are DONE (M3 / Stage 33):** generic function definitions monomorphize (one
  specialization per instantiated type tuple), so `NT1013` is cleared — see the re-measured
  histogram below.
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
