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

> **Read this first.** The sections below are a chronological series of re-measurements,
> each one true when written. For the CURRENT frontier jump to
> [Re-measured at SH6](#re-measured-at-sh6--the-frontier-per-module-standalone). The
> headline there: **no module reaches IR**, and the per-module blocker table is the list
> of things to fix. Two earlier sections overstated progress and now carry inline
> corrections — a "reaches `ir`" claim that was a harness bug, and a regex count that
> measured first-blockers instead of the construct.

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
| `NT1003` | 1 | `driver.ts` calls an *imported* function, which single-file coverage sees as an unknown callee — an artifact of the measurement, not a gap. Same for `coverage.ts`'s call to `parse`. The diagnostic now SAYS this (`src/diagnostics.ts` `unlinkedImportError`) instead of blaming closures; linked, both calls check and run |

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
  are already supported. ~~**Audit for regex** in the lexer — if present, either add regex or rewrite
  the scanner char-by-char (likely already char-by-char).~~ **DONE:** the audit found 29 regex
  literals across 8 of the 12 modules (the lexer's scanner was *not* already char-by-char), and all
  29 are now explicit character scanning. `test/no-regex.test.ts` keeps them out.

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
| `NT1027` | `diagnostics`, `coverage-preprocess` | genuine regex uses (2 modules, not 8) — **since removed; see the regex-removal re-measurement below** |
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

> **WRONG, and instructive.** "Only two modules genuinely need regex removed" counted the
> modules whose *first* blocker was `NT1027`. That is not the same question. The actual
> rewrite touched **29 regex literals across 8 of the 12 modules** — the other six were
> masked behind a nearer blocker, exactly the unmasking this document keeps observing
> everywhere else. A first-blocker histogram measures what to fix NEXT; it never measures
> how much of a construct is in the tree. For that, count the construct.

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

### Re-measured after the REGEX REMOVAL — `NT1027` is gone from the frontier entirely

nativets has no `RegExp` and never will (a permanent Tier-C refusal, `docs/divergences.md`),
so a compiler written with regexes cannot compile itself. All **29** regex literals in
`src/` — spread over **8** of the 12 modules — are now explicit character scanning.
`test/no-regex.test.ts` is the lint that keeps them out, with an empty table.

| Module | Before | After |
|---|---|---|
| `diagnostics.ts` | `lexed` — `NT1027` `/^\s*/` | **`parsed`** — `NT2001`, `diag.spans.length` after `!diag.spans \|\|` (nullable narrowing does not flow across `\|\|`) |
| `ownership.ts` | `lexed` — `NT1027` `/\$inner$/` | **`parsed`** — `NT1009`, the scalar union in `checker.ts` via the link |
| `lexer.ts` | `lexed` — `NT1027` the `@@name` pragma | **`parsed`** — `NT1014`, `new Set([…])` for `REGEX_AFTER_KEYWORD` |
| `coverage-preprocess.ts` | `lexed` — `NT1027` `/[A-Za-z_$]/` | **`parsed`** — `NT0001`, the same template-literal TYPE as `ast.ts` |
| `ast.ts` (6), `driver.ts` (7), `modules.ts`, `cli.ts` | regex-free now, but their FIRST blocker was already something else | unchanged (`NT0001` line 14; `NT1017` ×2 — see the correction below) |

Four modules moved `lexed` → `parsed`; four had a nearer blocker and did not move. Nothing
regressed. The blocker count *rose*, which is the ratchet working: clearing a blocker
unmasks what was behind it.

> **CORRECTED at SH6.** This table originally read **`ir`** in the "After" column and
> `parse` in "Before", and the summary claimed four modules reached IR. **They did not.**
> `test/bootstrap.test.ts`'s `phaseOf` returned `phase: "ir"` from *both* branches of its
> last `try`/`catch`, so its top rung could not distinguish "produced LLVM IR" from
> "entered the IR pipeline and threw" — every module that merely lexed and parsed scored
> `ir`. The scale is now COMPLETED phases (`none`/`lexed`/`parsed`/`ir`) and `ir` means
> `sourceToIR` returned. The rows above are re-stated on the corrected scale; the *errors*
> they record were always right, and an error is precisely the proof that IR was never
> produced. The `node:fs ×3` note is also corrected: SH4 cleared `node:fs`, and the two
> remaining `NT1017`s are the bun text-asset import, not a `node:` module.

**What this measurement does NOT establish.** A byte-identical-IR diff over every fixture
is the natural way to prove a compiler source rewrite is observationally null, and it is
**far too weak on its own**. Mutating each rewritten predicate in turn — drop `$` from the
identifier class, drop `\r` from `\s`, drop `_` from the hex class, accept a one-digit `\x`
escape, accept `A-Z` in regex flags, drop the pragma's trailing `\s*$` — changes the IR of
**zero** of the 121 fixtures and the tokens of **zero** compiler modules. Five of the six
are invisible to the entire existing corpus; the sixth is caught only by **tc39/test262**
(`early-err-bad-flag.js`, whose flag is uppercase). So the evidence that actually carries
weight is (a) old-vs-new token streams over 1,105 files including 702 borrowed test262
cases, (b) exhaustive BMP sweeps of every rewritten class, and (c) compiling each new
helper **with nativets itself** — which is what caught the two blockers this lane nearly
planted (a nullable-returning callback type, and an `arr.push`).

### Re-measured at SH6 — the frontier, per module, standalone

`test/sh6.test.ts` is the first instrument that asks the question that matters: does
nativets compile the compiler's own source into something that BEHAVES like the bun-run
compiler? Its answer, at `main` with SH4, the regex removal, `!` and the NT0001 tail all
landed:

**All twelve `src/*.ts` modules, and `cli.ts` (stage-1), sit at rung 0. Nothing reaches
IR.** Every earlier "reaches `ir`" in this document was the `phaseOf` artifact corrected
above.

SH6 also exposed a measurement confound that had been quietly inflating the picture.
`sourceToIR(source, entryPath)` runs the **whole-program link**, so a module's recorded
blocker may belong to a module it *imports*, not to itself. `ownership.ts` was credited
with `NT1009` — but that union lives in `checker.ts`, which `ownership.ts` imports.
Measuring each module standalone (`parse` + `check`, no link) separates the two, and the
standalone column is the one that tells you what to fix:

| Module | First blocker, standalone | The construct |
|---|---|---|
| `ast.ts` | `NT0001` 14:29 | template-literal **type** — `` `${string}[]` `` |
| `parser.ts` | `NT1009` 1030:66 | optional element access — **`?.[]`** (was `NT0001` 225:95, `satisfies`, until the satisfies lane) |
| `checker.ts` | `NT1009` | `Record<string, number \| "var">` — a general union |
| `codegen.ts` | `NT1015` 475:3 | **`static`** class member |
| `modules.ts` | `NT1015` | ~~**generic class method** — `private t<T extends Ty \| undefined>`~~ — also stale: by the time it was next measured this was `(p)` at 41, contextual typing. See below |
| `driver.ts` | `NT1017` 27:1 | the **text-asset import** (12 of them, 305 KB of C) |
| `lexer.ts` | `NT2001` | ~~`ESCAPES` declared `Map<string, string>` but initialized with an **object literal**~~ — **WRONG, corrected below**: it was `(n = 1)` at 146, a parameter default. Re-measure before you believe a row here |
| `coverage-preprocess.ts` | `NT1606` | array **`.push`** (arrays are immutable) |
| `diagnostics.ts` | `NT2001` | narrowing does not flow across `\|\|` |
| `cli.ts` | `NT2001` | `process.stdout is not supported` (was `'source' declared string but initialized with undefined` until the definite-assignment lane: `let source: string;` assigned inside a `try` is now compiled, not refused — see docs/divergences.md) |
| `ownership.ts` | `NT1014` | `new Set(iterable)` — was `NT2001 'NO_MUTABLE' is not defined`, a checker BUG (parameter defaults were typed in a builtins-only scope), now fixed |
| `coverage.ts` | — | **not a blocker**: its `NT1003` on `parse` is the unlinked-import artifact above, not a gap. Its first real blocker is whatever a LINKED check reports |

These are **first** blockers. Each one cleared unmasks the next, so this is a ratchet
grind, not an eleven-item list — the same shape every earlier re-measurement had.

**The gap is being widened by ordinary feature work.** Two of the blockers above were
planted by recent, unrelated stages: `new Set([...])` arrived with the regex-lexing table,
and the text import arrived with the single-binary embed. Neither author was doing
self-hosting work. What catches this today is `test/bootstrap.test.ts`, which runs in CI
(`.github/workflows/ci.yml` runs the full `bun test`) and holds two ratchets — a per-module
phase floor, and the set of NT codes present across the tree, so a *new* code appearing is
a hard failure. The remaining hole: a module regressing to a code **already** in the set is
invisible to both. Closing that means ratcheting per-module blocker codes, not just the
tree-wide set.

### `test/selfhost-ratchet.test.ts` — the hole, closed and demonstrated

The hole was **wider than the paragraph above says**, and the reason is the confound in the
table above: every existing instrument measures the whole-program **link**, where most
modules report a *dependency's* blocker rather than their own. With six modules inheriting
`parser.ts`'s `?.[]`, a refused construct planted in any one of them changes nothing that
is measured. Reproduced, not argued — `new Map([[k, v], …])` (the entries form, still
refused) planted at the top of `src/modules.ts` in a scratch tree:

| Instrument | What it saw |
|---|---|
| `bootstrap.test.ts` phase floor | nothing — still `parsed` |
| `bootstrap.test.ts` tree-wide code set | nothing — `NT1014` was already in it |
| `sh6.test.ts` rung floor + per-module `code` map | nothing — the LINKED code is still the dependency's |
| `self-host-coverage.test.ts` histogram | nothing — its checker contributes at most ONE blocker per file |
| **`selfhost-ratchet.test.ts`** | **red, naming the module, both blockers, and the fix** |

What it records, per `src/*.ts` module (the list is **discovered**, so a thirteenth module
cannot arrive unmeasured), in `test/selfhost-ratchet.baseline.json`:

- a **standalone** column — the module compiled as its own program, no link. This is the
  column that says whose gap it is, and the only one in which a planted blocker is visible;
- a **linked** column — the same pipeline through `linkProgram`, i.e. what stage-1 is;
- for each: the pipeline **stage** that threw, the NT code, and the **message** with
  positions normalized out. Identity is the message, not the code: `NT1009` alone spans
  general unions, intersections and `?.[]`, so a code comparison cannot tell a module
  regressing to a different `NT1009` from one holding still.

**How it tells progress from regression** — the part a phase floor cannot do, since both
movements sit inside `parsed`. A blocker is a function of exactly two inputs, so the
baseline records the module's **source hash** next to the blocker and the causes separate:

| | blocker changed |
|---|---|
| source hash **unchanged** | only the compiler can have done it → the frontier moved → **passes** |
| source hash **changed** | the module's own source changed what stops it first → **fails**, with both blockers named |

So the everyday case — a lane clears a blocker in `checker.ts` and nine modules move — stays
green, which is the difference between a ratchet people read and one they rubber-stamp.
Two rules are unconditional: a module that reached IR may never stop reaching IR (this is
the only ratchet in the tree that protects a module that *already* self-compiles), and a
blocker may never move to an **earlier** pipeline stage.

**"Moved shallower" is NOT automatically a regression.** The rule of thumb this ratchet was
being read with — *re-record only when each moved blocker moved DEEPER* — is too crude, and
following it would have held a correct fix. A blocker moving to an earlier line is a
regression when the module genuinely got worse; it is a **correction** when a blocker that
was always there stops being MASKED by a miscompile further in. The question that separates
them is not the direction of the move, it is:

> was the newly-reported construct previously **silently mis-handled**, or was it previously
> handled **correctly** and passed?

Only the second is a regression. The first means the instrument was crediting the module
with progress it never had — the same failure mode as `coverage` once scoring a compiler
crash as "no blockers", and as `phaseOf` returning `ir` from both branches of its `try`.

The worked example is the one that forced the amendment; see the re-measurement below.
Holding a correct refusal to keep a gate green is the rubber-stamp dynamic with the sign
flipped, and it is the one this ratchet exists to prevent.

`git` is deliberately not an input to any verdict — `actions/checkout` fetches depth 1, so a
git-informed verdict would differ between a laptop and CI. It is used only to *enrich* a
failure message with a before/after taken against the recorded revision.

Re-record deliberately, in one command — nine parallel lanes move these numbers:

```sh
NT_RECORD=1 bun test test/selfhost-ratchet.test.ts   # rewrites the baseline, prints the diff
```

**What it still cannot see**, stated because an instrument that overstates is worse than
none: it is a **first**-blocker measurement, so a construct planted *behind* a module's
existing blocker is invisible until that one clears (the same plant placed one line *below*
`modules.ts`'s arrow-parameter blocker is not caught). And the standalone column is blind
for a module whose first standalone error is the unlinked-import artifact — `driver.ts` and
`coverage.ts` — whose rows are marked `artifact` for that reason.

### Re-measured after SHORT-CIRCUIT NARROWING — the `NT2001` bucket is empty

The one `NT2001` on the frontier was a **false positive**: `src/diagnostics.ts:74`

```ts
if (!diag.spans || diag.spans.length === 0 || !source) {
```

is correct TypeScript and correct at runtime — the right operand of `||` only runs when
`!diag.spans` was false — but the checker did not carry a guard's fact into the terms to
its right, and could not narrow a **dotted name** at all. Both are fixed:

- a bare truthiness test is a guard like `!== undefined` (TypeScript's
  `controlFlowTruthiness.ts`), so `!x` on the left of `||` proves `x` for what follows;
- a narrowing fact is about an access **path** (root binding + dotted suffix), not just a
  name (`discriminantPropertyCheck.ts`). Sound because nativets objects are immutable
  unless `@@mutable`: outside that tag the only way `d.spans` can change is a new value
  bound to `d`. `@@mutable` receivers and `this` get no path facts.

| Module | Before | After |
|---|---|---|
| `diagnostics.ts` | `parsed` — `NT2001`, `diag.spans.length` after `!diag.spans \|\|` | `parsed` — **`NT1606`**, `[...diag.spans].sort(…)` — arrays are immutable |

Still `parsed`, not `ir`: clearing the narrowing false positive moved the blocker, not the
rung. Nothing else moved either — `cli.ts` still dies on `'source' declared string but
initialized with undefined` and `ownership.ts` on `'NO_MUTABLE' is not defined`, both
unrelated to narrowing. Two adjacent gaps this measurement exposed, neither taken:

- the **value-returning** `a && a.b` (node: `undefined` or a number) is still refused —
  `&&`/`||` require matching `boolean`/`number`/`string` operands, so the narrowing
  reaches `a.b` but the result has no type yet. Pinned as a refusal in
  `test/narrowing.test.ts`;
- a **string literal is not assignable to a `?Ustring` parameter** (`f("abc")` where the
  parameter is `string | undefined`), which forces every fixture here to bind through an
  annotated local. **FIXED** — see "nullable assignability at a parameter" below; it was
  worse than recorded here (an *inferred* `const` failed too, so only an explicitly
  annotated local ever passed).

The same lane fixed a real soundness hole it found on the way: the region scanned for
invalidating assignments covered only the code a fact *covers*, not the guard itself, so
`!x || (x = y) !== undefined || x.length === 0` proved `x` present and then reassigned it
before the use. node throws a `TypeError` there; nativets panicked at the unwrap rather
than inventing a value, but a false proof is a false proof. The guard is now scanned too.

### Re-measured after COMPILE-TIME TEXT IMPORTS — `driver.ts` clears its last `NT1017`

`import runtimeSource from "../runtime/runtime.c" with { type: "text" }` was the one blocker
this document (and `test/sh6.test.ts`) called *structural*: not TypeScript we had refused, but
a construct with no node semantics at all, which the compiler nevertheless depends on to embed
its own C runtime. It is now compiled. The parser accepts the import-attributes clause, and the
linker reads the file at compile time — relative to the importing module — and materializes
`const <name> = "<bytes>";`, so everything downstream sees an ordinary `const string` and the
bytes reach the `.ll` as an interned constant. `src/driver.ts` needed **no source change**.

| Module | Before | After |
|---|---|---|
| `driver.ts` | `lexed` — `NT1017`, the text import at **27:1** | `lexed` — `NT1017`, `export async function` at **502:1** |
| `cli.ts` | the same, inherited through the link | the same, inherited — 475 lines deeper |
| every other module | — | **unchanged**, byte for byte |

Same code, a very different place, and the rung did not move: `NT1017` is recorded for the
gradient, never as a floor. All twelve embedded files (~305KB, `runtime/runtime.c` alone at
147KB) round-trip byte for byte through the AST and the `.ll` — pinned by
`test/textimport.test.ts`, which dumps and checksums the real files rather than a stand-in.

**Next for `driver.ts`: `export async function`** (`buildBinary`/`buildObject` are `async`).
`async` is already erased inside a function body; what is missing is `export` of one. Not
chased here.

Because node has no `type: "text"` attribute, this construct cannot be differential-tested the
usual way — see `docs/divergences.md`, which records the divergence and how the oracle is split
(a `main.ts`/`oracle.ts` twin per fixture, identical below the binding).

### Re-measured after PARAMETER-TYPE INFERENCE — and two recorded blockers were WRONG

Two rows of the SH6 table above named the wrong construct. Both were re-measured, not re-read.

- **`lexer.ts` `NT2001` was not "`ESCAPES` declared `Map<string,string>`, initialized with an
  object literal."** It was `cannot infer type of arrow parameter 'n'` at **src/lexer.ts:146**,
  `const advance = (n = 1) => { … }` — a parameter with a default and no annotation.
- **`modules.ts` was not blocked on a parameter default at all**, which a handoff note claimed.
  Standalone it was `cannot infer type of arrow parameter 'p'` at **src/modules.ts:41**,
  `const defaultRead: ReadModule = (p) => readFileSync(p, "utf8")` — an arrow whose parameter
  type comes from the *annotation on the binding*, with no default anywhere in sight. (Its
  *linked* blocker was, and still is, `parser.ts`'s `?.[]`; the standalone column is the one
  that says whose blocker it is.)

Two independent gaps, both now closed:

1. **A parameter takes its type from its DEFAULT**, TypeScript's widening rule
   (`tests/cases/conformance/es6/defaultParameters/`): `(n = 1)` is `number`, `(s = "a")` is
   `string`, `(b = true)` is `boolean`. Applied in every parameter position at once — arrows,
   named functions, methods, constructors — the way the Stage-15 binding-pattern desugaring was.
   A default whose type we cannot pin down (`undefined`, `null`, `[]`) is refused with a hint;
   TypeScript's answers there are `any` and `any[]`, and guessing is the silent wrong answer.
2. **An arrow takes its parameter types from the annotation it is assigned to.** The dispatch in
   `Checker.infer` passed `undefined` where every other call site passed the contextual type, so
   a contextually typed *callback* compiled and a contextually typed *binding* never did.

| Module | Before | After |
|---|---|---|
| `lexer.ts` | `NT2001` — `(n = 1)` at 146 | **`NT1031`** — `line++` inside that same arrow's body, a write to a captured binding |
| `modules.ts` | `NT2001` — `(p)` at 41 | **`NT2001`** — `Stmt[]` erases to `number[]` at 229, so `s.kind` fails: the general-union alias, not a new gap |
| `diagnostics.ts` | (unchanged code) | unblocked at `label = "here"`, src/diagnostics.ts:332 — the same default rule |
| every other module | — | **unchanged** |

Two checker ESCAPES fell out with it, both programs node runs and clang then rejected — the
diagnostic contract failing outright, which is worse than a refusal:

- `function f(s = "abc") { return s + 1 }` → `'%t0' defined with type 'ptr' but expected 'double'`.
  The signature table typed the parameter from its default; the *body* scope declared it `number`.
- `function f(n: string = 1)` → `floating point constant invalid for type`. An annotated default
  was reshaped when assignable and **silently ignored** when not. tsc rejects it (TS2322); so do we now.

**Still open, and pinned rather than fixed** (`test/param-defaults.test.ts`): a default does not
make a *value arrow's* parameter optional at the CALL site. A nativets function type is a flat
`(number)=>number` with no notion of optionality, so `const f = (n = 1) => …; f()` is refused on
arity while the `function` spelling honours it — a real asymmetry between the two spellings.
Relatedly, an explicit `undefined` argument is refused rather than triggering the default.
### CONSTRUCT CENSUS — counting the construct, not the first blocker

Every table above this one is a **first-blocker** table, and this document already carries a
standing correction about what those can and cannot tell you: *"A first-blocker histogram
measures what to fix NEXT; it never measures how much of a construct is in the tree. For that,
count the construct."* That correction was written after "only two modules genuinely need regex
removed" turned into a rewrite of **29 literals across 8 modules**.

The census was never actually run. It is run here, over all twelve `src/*.ts`:

| Construct | Sites | Modules | Reading |
|---|---|---|---|
| **`.push`** | **185** | **11 of 12** | the elephant, and it is invisible to every table above |
| `new X` | 285 | 12 | mostly `Map`/`Set`/node types, not user classes |
| `?.` (all forms) | 97 | 9 | |
| `class` | 12 | 8 | no inheritance anywhere — SH3's premise holds |
| **`?.[]`** | **10** | **2** | checker ×5, parser ×5 |

**The two headline numbers invert the apparent priority.**

`?.[]` is the first blocker for **six** of the twelve modules — parser, checker, ownership,
driver, cli, modules — which reads like the highest-leverage item on the board. It is **ten
source sites in two files**. It is cheap, and it is worth doing precisely because it unmasks
six modules at once, but it is not big work and it was never the thing standing in the way.

`.push` is the first blocker for **one** module (`diagnostics.ts`) and appears **185 times in
eleven**. Receiver shapes: 145 a plain local, 38 `this.<field>`, 1 dotted. Nothing in the
first-blocker tables suggests this, because a module only reports `.push` once every blocker
NEARER to it has been cleared — so `.push` will surface as the next blocker for module after
module as the current round's lanes land, and each will look like a fresh discovery.

**`.push` is refused by DECISION, not by omission** — commit `1ea7fa2`. A lane sent to legalize
it on a syntactically-fresh receiver came back with evidence the premise was wrong, and that was
accepted: a fresh receiver is a temporary nothing can name, so mutating it is unobservable *by
construction*, which is the same as saying no real program writes that shape. It would have
cleared none of the 185. The sanctioned idiom is `xs = [...xs, v]`, claimed O(1) amortized via
the transient path with a 200-append measurement pinned.

So the honest sizing of the remaining self-hosting work is **not** a list of missing features. It
is a ~185-site mechanical rewrite of the compiler's own accumulator idiom, which is Path B /
the recommended HYBRID ("refactor the compiler toward the supported subset where it's cheap")
applied at a scale nobody had measured. Two things make it less alarming than the raw number:

- the 145 plain-local sites are the mechanical ones (`let xs = []` … `xs = [...xs, v]`), and
  the idiom is valid TypeScript, so **bun keeps running `src/` unchanged** — the two-toolchain
  constraint is satisfied for free;
- the 38 `this.<field>` sites are not mechanical and interact with `@@mutable class` (Stage 45),
  so they need a decision rather than a rewrite.

**What this means for the rung-3 goal.** `diagnostics.ts` — the shallowest module and the
standing rung-3 candidate — holds **4** of the 185, all one local `lines` accumulator in a
single function (`src/diagnostics.ts` lines 119–121 and 123). Its blocker is four mechanical rewrites,
not a design problem. That is the argument for walking it first.

Reproduce the two headline counts with:

```sh
cat src/*.ts | grep -o '\.push(' | wc -l          # 185
cat src/*.ts | grep -o '?\.\[' | wc -l            # 10
# receiver shapes of the .push sites
grep -ohE '[A-Za-z_$][A-Za-z0-9_$.]*\.push\(' src/*.ts | sed 's/\.push(//' \
  | awk '{ print ($0 ~ /^this\./) ? "this.FIELD" : ($0 ~ /\./ ? "DOTTED" : "PLAIN") }' \
  | sort | uniq -c
```

Note that `grep` here is the real one; project memory records that a shimmed `grep` on some
setups silently misses matches, which would make every number above too small.

**Method note, since this document is partly a record of measurement mistakes:** a census is a
`grep` and inherits a grep's blind spots — it counts `.push(` textually, so it cannot tell an
array `.push` from a same-named method on a user object, and it cannot see a call reached
through an alias. The numbers are an upper bound on sites and a *lower* bound on effort. They
are still the right order of magnitude, and an order of magnitude was exactly what was missing.

### Re-measured after the RECURSIVE-CLASS-FIELD refusal — the gap GREW, and that is the finding

`interface N { next: N }` has been refused (`NT1030`) since the forward-type lane. The CLASS
spelling of the identical recursion was not: `parseClass` resolves a class name inside its own
body to a self MARKER (so `bump(): Counter` works before the instance shape exists), and a
FIELD carrying that marker was rewritten to `number` — unconditionally, with no diagnostic, on
a line whose own comment called it "the pre-existing erasure".

**That erasure was hiding a miscompile in the compiler's own symbol table.** `src/checker.ts:93`
is `class Scope { constructor(private parent: Scope | null = null) {} … }`. Minimized and run
against the parser as it stood, the compiler describes its own scope chain in its own words:

```
BEFORE: error[NT2001]: new Scope arg 0 expects ?NScope{parent:?Nnumber}, got null
AFTER:  error[NT1030]: recursive type 'Scope' — its field 'parent' refers to itself
```

`parent: ?Nnumber`. **The scope chain has been a number in every self-host measurement ever
taken.** checker.ts was recorded as blocked at line 676 (`Checker.inArrow`); it had in fact
never got past line 93 with its symbol table intact.

| Module | Before | After |
|---|---|---|
| `checker.ts` | `NT1023` — `Checker.inArrow` assigns a field, line 676 | **`NT1030`** — `Scope.parent`, line **93** |
| `ownership.ts` | `NT1023` — the same, inherited through the link | **`NT1030`** — the same, inherited |
| every other module | — | **unchanged** |

So the measured gap **widened**: recursive types now gate **9 of 12** modules in the linked
column, not 7. Four instruments reddened on a strict improvement — `selfhost-ratchet`, `sh6`,
`bootstrap` and `self-host-coverage` — and all four were re-recorded deliberately, under the
"moved shallower is not automatically a regression" rule the same lane added above. Attribution
was a controlled experiment, not an inference: reverting the *other* commit in the lane (the
optional-class-field fix) leaves the ratchet still red, so the move belongs to this refusal
alone and the optional-field fix is ratchet-neutral.

**What this changes about the plan.** `Scope` is **self**-recursive, and not a member of
`src/ast.ts`'s 44-declaration mutually-recursive SCC. So the earlier sizing — *"self-recursion
alone moves zero modules, there is no partial credit before the SCC resolves"* — needs one
amendment: self-recursion alone still moves nothing *forward*, but it is now what `checker.ts`
and `ownership.ts` need to get back to where the measurement wrongly thought they already were.
The recursive-type work is no longer pure foundation.

A second, independent silent wrong answer fell out of the same file and is fixed with it: the
`?` on a class field was parsed and **discarded**, so `s?: string` was typed `string` rather
than `?Ustring` as the identical interface field already was. An unassigned optional field read
back as the zero slot — a NULL `char*` for a string, `0` for a number, `typeof` reporting
`"string"` — and `this.s = undefined` was *rejected* on code tsc accepts. Fixed rather than
refused (it mirrors `parseObjectType`), with the non-obvious half being that "absent" has to be
WRITTEN: an instance is a heap block and every field is a real slot, so an optional field with
no initializer now gets `undefined` in the constructor prelude. Fixture:
`test/fixtures/classes/optional-field.ts`, which exited **255 with no output at all** before.

Two adjacent gaps this exposed, neither taken: narrowing still does not reach `this.<field>`
(`this.s === undefined ? "none" : this.s` is `NT2001`), which optional class fields make far
easier to hit now that they produce real nullables; and `null` is still not accepted for a
`?N` **parameter** (`new Scope(null)`), adjacent to the recorded `?Ustring` argument gap.
Both were taken by the next lane — see immediately below.

### NULLABLE ASSIGNABILITY AT A PARAMETER — `new Scope(null)`'s argument stops blocking

Three refusals were reported together; they were **not** one gap, and the split matters.

**Two were gaps, and are fixed.** `fitsParam` was type IDENTITY (plus a union arm), so
TypeScript's most ordinary assignability rule did not hold at a parameter: `null` into
`T | null`, `undefined` into `T | undefined`, a `T` into either. `pick(null)` against
`pick(n: Node | null)` was an error on code node runs. Its comment gave a reason —
the nullable arm "would accept values codegen does not box here" — which was true when
written and had quietly stopped being true: `genUserCall`, the `new` path and `return`
all coerce. The new arm is deliberately narrower than `assignable`, admitting exactly
the matching nullish literal and a value of the base type, because those are exactly the
two sources codegen's `coerce` can build a `[tag,value]` box from. A structurally
compatible OBJECT has a different slot layout and stays with `fitsArg`, which takes it
only as a literal it can reshape — widening that far is the dereference-a-double bug.

**One is a refusal, and stays.** Narrowing still does not reach `this.<field>`. It is
sound: no fact is rooted at `this` because a field of `this` can be reassigned by the
very method that proved the guard, while the invalidation scan is by NAME — it sees a
rebinding of `d`, never a write to `this.s`. What it lacked was a *reason*; the
diagnostic now gives one and hands back a fix (bind a local), and that fix is pinned as
a node-differential test, because advice a diagnostic gives has to compile.

The measured frontier did **not** move: every blocker message, code, stage and line in
`test/selfhost-ratchet.baseline.json` is byte-identical after the change, and
`diagnostics.ts` holds rung 3. `new Scope(null)` is nonetheless unblocked *as an
argument* — the sole remaining complaint on

```ts
class Scope { constructor(private parent: Scope | null = null) {} }
const s = new Scope(null);
```

was `NT1030` for the self-recursive field, which belonged to the recursive-type encoding
lane. That lane has since landed its nominal encoding, and with both halves in the gate
**compiles with nothing left over** — asserted in `test/nullable-assign.test.ts`, together
with a longhand spelling node can actually run (node refuses a parameter property outright:
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). What remains on the recursive type is `NT1002`, a
method call on `@Scope`, which is that lane's next step and not this one's.

**A real miscompile fell out of the same file, pre-existing and unrelated to the
feature.** `coerce` is what turns a raw value into its declared type's representation,
and three value-passing boundaries never called it: a `return` inside a `try`/`finally`
(which stashes into the return slot), a CLOSURE call (which merely relabelled the
argument with the parameter's type), and the FIXED parameters of a rest function.

```ts
function g(): string | boolean {
  try { return "hi"; } finally { console.log("fin"); }
}
console.log(g());
```

node prints `fin` then `hi`; nativets exited **255 with empty stdout** — the caller read
a tag out of a string pointer. The double-armed spelling did not even survive `llvm-as`.
Fixed first, because widening assignability is what makes an unboxed value reach those
boundaries in the first place.

Two adjacent gaps this one exposed, neither taken: a ternary does not **join** a present
arm with `undefined` (`b ? "yes" : undefined` against a `string | undefined` return is
still `NT2001` — a gap in the join, which `fitsParam` never sees), pinned as a refusal in
`test/nullable-assign.test.ts`; and the `expectRejected` idiom copied across test files
passes the `NTError` to `formatDiagnostic`, which takes a `Diagnostic` — it renders
`error[undefined]` and silently drops the HINT, so no test asserting on a hint could ever
have passed. Only this lane's file was corrected.
### THE FIRST MODULE SELF-COMPILES — `diagnostics.ts` at rung 3 (consuming parameters)

Every re-measurement above this one records a frontier that moved *within* rung 0. This one
does not. **`src/diagnostics.ts` reaches rung 3**: nativets compiles it to 95,851 bytes of LLVM
IR, clang links that IR into a native binary, and the binary's stdout and exit code match the
`bun`-run module. It is the first of the twelve to leave the floor since `test/sh6.test.ts` was
written, and the headline assertion in that file changed from `[]` to `["diagnostics.ts"]`.

The last of its six blockers was `constructor(readonly diag: Diagnostic)` — **NT1604**, and the
previous lane was right that it was neither a false positive nor a nudge away. A linear
parameter is a BORROW: the caller owns the value and drops it, so storing one in a field left
the caller freeing a pointer the object still held (suppressing the rule and running
`function make(): E { const v = {…}; return new E(v); }` gave **exit 255**). The source-side
shallow-copy workaround leaked instead. What it needed was the feature that note named:

**A constructor PARAMETER PROPERTY is a CONSUMING parameter.** The callee takes ownership, and
the move propagates to every `new C(v)` site, so the caller stops dropping the value and using
it afterwards is NT1601 (≈ rustc E0382). This is `fn new(d: D) -> Self` against `fn new(d: &D)`.
The surface question — how does a parameter get marked consuming? — is answered **syntactically**
rather than by inference or by an attribute, because a parameter property is the one parameter
whose store is guaranteed: the desugaring emits `this.d = d`, so there is nothing to infer and
no spelling to add, and `src/*.ts` keeps running unchanged under bun. Inference over general
parameters was rejected for the opposite reason: it would make a function's calling convention a
property of its *body*, invisible at the call site, and would flip pinned NT1604 refusals across
`test/ownership/` — an invisible ABI is the wrong default for a compiler whose second rule is
"reject, never miscompile". Full detail in `docs/ownership.md`.

| Module | Before | After |
|---|---|---|
| `diagnostics.ts` | rung 0 — `NT1604`, `constructor(readonly diag: Diagnostic)` | **rung 3** — IR, links, runs; output matches bun |
| every other module | — | **unchanged**, rung 0, same blocker |

**The rung-3 row for a library module is WEAK** (caveat 3 of `test/sh6.test.ts`: it prints
nothing, so the comparison is empty == empty). The non-weak evidence is a **driver
differential** added with it — a program that imports the module, builds three diagnostics
through three constructors, reads `.diag` back off the class whose parameter property was the
blocker, and renders one through the multi-span formatter over real source. 466 bytes of stdout,
byte-identical to `bun run` over the same file, exit 0 == 0. That is the "per-module EXERCISE
entry" `sh6.test.ts` has been asking for since it was written.

**Leak / double-free accounting, since this project has shipped both.** Zero double frees: the
value has exactly one owner (`__objLive()` → 0 for the constructed object across a 200-iteration
loop, and the escaping `return new E(v)` shape now exits 0 rather than 255). There IS a leak, and
it is **pre-existing, known, and unrelated**: `nt_obj_free` is SHALLOW, so an aggregate reached
through a field is never freed — the shallow-drop characterization above and `docs/ROADMAP.md`
Phase C. Measured identically on the unmodified tree before this change landed: `const o = {
inner: {a:1}, b:2 }` leaves `__objLive()` at 1, as does `class Box { inner: {x:number};
constructor() { this.inner = {x:41}; } }`. Consuming parameters reach the same accounting the
already-legal spelling had; they do not add a leak class, and a moved-in field is exactly the
"an object field can be MOVED OUT while the parent's slot still points at it" shape that
characterization pins as a precondition for any future recursive free.

**Two costs, stated because the next module will pay them.** The compiler's dominant class idiom
IS the parameter property — `Scope(private parent)`, `ModuleGen(readonly functions, readonly
globals)`, `FnGen(private mod)`, `Renamer(private names, private tags)`, `Parser(private toks)`,
`Analyzer(private linear, private topLevel, …)` — so this construct is not a `diagnostics.ts`
one-off. But the call-site half bites: `src/ownership.ts` constructs **two** `Analyzer`s from the
same `linear`/`topLevel`/`paramBorrows` locals, which is now a use-after-move. `diagnostics.ts`
paid nothing (all fourteen of its `new NTError(…)` sites pass a fresh object literal, and moving
a temporary is free); `ownership.ts` will need a source rewrite. That is the honest shape of the
remaining work, and it is the same Path-B grind the `.push` census found.

### `NT1023` IS GONE — two pragma comments, and the census says there is no third class

`NT1023` ("method `C.m` assigns a field, so it produces a NEW `C`, but it does not return one")
was the first blocker for **three of the twelve** modules — `checker.ts` and `codegen.ts` on
their own account, `ownership.ts` inheriting `checker.ts`'s through the link.

**It was a SOURCE gap, not a compiler gap, and the measurement says so unambiguously.**
`src/parser.ts` reads the diagnostic out of `lowerSetter`, which throws *only* under
`if (!isMutable)` — so a class carrying `@@mutable` cannot reach it, for a method exactly as
much as for a constructor. `class Parser`, `FnGen` and `Analyzer` have carried the pragma since
Stage 45/49; `class Checker` and `class ModuleGen` simply never got one. They are accumulators
in exactly the same sense (`Checker` counts loop/switch depth up and down and pushes/pops
`fnStack`; `ModuleGen` grows `strings`/`strDefs` and counts `arrowCounter` up), so the pragma is
the *honest* spelling — copy-on-write would be a different program from the one bun runs today.

**The census, not the first-blocker table.** This document's standing correction ("a
first-blocker histogram measures what to fix NEXT; it never measures how much of a construct is
in the tree") applies here, so the construct was counted before the fix, with the NT1023 throw
turned into a collector: **six setter methods, in exactly two classes** — `Checker.inArrow`,
`Checker.declareGeneric`, `Checker.checkStmt`, `Checker.checkMapEntriesLoop`, and
`ModuleGen.liftArrow`, `ModuleGen.build`. No third class holds any. `test/self-host-coverage.ts`'s
whole-tree histogram — the one instrument that recovers statement-by-statement rather than
stopping at the first blocker — now reports **zero** NT1023 sites tree-wide. This bucket did not
shrink; it emptied.

**What was unmasked** (all three modules move within the `parse` stage — no column moved
shallower, and `diagnostics.ts` still reaches IR at rung 3, byte-identical output):

| Module | Was | Now |
|---|---|---|
| `checker.ts` | `NT1023` — `Checker.inArrow` | **`NT1009`** — `FmtPiece` (line 4385), `{text:string; spec?:undefined} \| {text?:undefined; spec:FmtSpec; arg:number}`, an optional-field union with no string-literal discriminant |
| `ownership.ts` | `NT1023` — the same, through the link | **`NT1009`** — the same, still never its own |
| `codegen.ts` | `NT1023` — `ModuleGen.build` | **`NT1015`** — a `get` accessor in `FnGen` (~165 lines deeper than the static member this bucket used to hold) |

**The cost, stated because it is a real one and it is deferred, not avoided.** `@@mutable`
switches on the ownership pass's exclusive-access rule, and `codegen.ts` has two receivers that
rule cannot establish ownership of — `this.mod.liftArrow(e)` (line 1822: the receiver is a FIELD
of `FnGen`) and `new ModuleGen(…).build(…)` (line 5303: the receiver is a fresh temporary).
Both are `NT1607`, verified on minimized programs, and both sit far behind the `NT1015` above so
neither is reachable today. The second of the two is an over-refusal in the pass rather than a
problem with the source — a `new C(…)` receiver is *more* uniquely owned than the "local bound
to `new C(…)`" its own hint asks for, since nothing can name it. That is a separate lane.

The `Analyzer` hazard recorded just above is untouched: `Analyzer` was already `@@mutable`, so
the two-instance use-after-move is a parameter-property/move question, not a mutability one, and
this change neither worsens nor fixes it.

### `NT1009` AND `NT1031` ARE BOTH GONE — two more SOURCE gaps, and one measured surprise

Three modules moved, none of it by changing the compiler. Both blockers were the compiler's
own source stepping outside the subset it compiles, which is now the third time in a row
(`@@mutable` for NT1023, the pragma spelling before it) that the answer was the source.

**`FmtPiece` was not a union nativets can represent, and the refusal is correct as designed.**

```ts
type FmtPiece = { text: string; spec?: undefined } | { text?: undefined; spec: FmtSpec; arg: number };
```

is discriminated by field **presence**. SH2's representation has **no box** — a union value IS
the member's object block and the tag IS a field of it — so a union is accepted only when a
literal-typed discriminant sits at the same slot index in every member. Presence has no such
field to read: the two members do not even share a slot layout (`text, spec` vs `text, spec,
arg`), so supporting it would mean unifying layouts across members and dispatching on whether a
nullable slot's tag says "absent" — a box by another name, and the property that makes SH2 cheap
is precisely that there is none. The diagnostic already named the fix (*"a discriminant needs
`kind: "a"`"*); `FmtPiece` now carries `kind: "text" | "arg"`, which is five lines across the
declaration, two construction sites and two `switch`-ish sites, and is ordinary TypeScript.

Behaviour-neutrality was **measured, not argued**: `planFormatString` renders an identical plan
over 47 format strings × 7 argument counts (329 cases — `%%`, unknown specifiers, a trailing
`%`, exhausted arguments), and `test/console.test.ts`'s 120 node-differential tests hold.

**`lexer.ts` lost its capture write and then lost the recursion behind it.** `advance` and the
three `scan*` closures moved `i`/`line`/`col`, which are `let`s of the enclosing `lex` — NT1031.
They become one `//@@mutable interface LexState`: mutating a field of an **owned local** is not
a capture write, since the binding never changes. Behind it sat `NT1003`, and that one is worth
recording because it says something general about the subset:

> **nativets supports no nested recursion at all.** A nested `function` declaration, a
> self-recursive arrow (`const f = (n) => … f(n-1)`) and a forward-referenced one are all
> `NT1003`. Hoisting to top level does not rescue a stateful one either: a `@@mutable` record
> and a `@@mutable class` instance are both `NT1607` the moment they arrive as a **parameter**,
> because a parameter is a borrow. So mutable scanner state can live only in the function that
> owns it, and any recursion over it has to be made explicit.

`scanTemplateBody`/`scanSubstitution` were mutually recursive; they are now one loop over an
explicit frame stack (`-1` = template body, `n >= 1` = substitution at brace depth `n`), which
is faithful because both frames appended to the **same string in source order**.

**Verified by token identity over the real corpus**, which is far stronger than any test that
could have been written for it: old and new lexer produce byte-identical token streams — type,
value, line and column of every token — over **480 files** (all twelve `src/*.ts`, 465 files
under `test/` and `examples/`, and both versions of `lexer.ts` itself, each lexed by both).

| Module | Before | After |
|---|---|---|
| `checker.ts` | `NT1009` — `FmtPiece`, line 4385 | **`NT1030`** — ast.ts's `Expr` SCC, *inherited*; standalone it is `NT2001`, `NUMBER_CONSTS` as a `Record` |
| `ownership.ts` | `NT1009` — the same, through the link | **`NT1030`** — the same, now blaming ast.ts directly |
| `lexer.ts` | `NT1031` — `line++` in `advance` | **`NT1606`** — `tokens.push` |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**checker.ts now has NO blocker of its own**, for the first time in this document's history —
the `blame` column in `test/sh6.test.ts` flips `self` → `ast.ts`. Ten of twelve modules parse
their own source cleanly and **nine of twelve** stop on ast.ts's 44-declaration mutually
recursive `Expr`. The tree has never been this concentrated on one thing.

**The surprise, and it revises the `.push` census above.** That census concluded the 145
plain-local `.push` sites were "the mechanical ones" because `xs = [...xs, v]` is valid
TypeScript, so *"bun keeps running `src/` unchanged — the two-toolchain constraint is satisfied
for free"*. **It is not free.** The idiom is O(1) amortized in **nativets** (the transient path)
and O(n) per append in **bun**, and bun is stage-0. `lex`'s `tokens` is not a small accumulator
— 34,987 elements on `src/checker.ts` alone:

```
.push                1.1 ms
xs = [...xs, v]   1150.9 ms      # 1036x, and quadratic: worse as the array grows
```

Converting `lex`'s 13 sites would cost ~6 s per full-tree lex and make the test suite, which
lexes constantly, unusable. `diagnostics.ts` paid nothing for its 4 sites because its
accumulator is a handful of lines. So the deciding factor is **the size the accumulator
reaches**, not the shape of the receiver, and the 185-site census needs that second column
before it is a plan. Not taken here; `lexer.ts` stops at rung 0 on `NT1606`.

### Re-measured after the `get` ACCESSOR — a SOURCE change, and the NT1607 over-refusal cleared

Two items, one lane, and they are the two halves of "the compiler must stay inside the
subset it compiles."

**`get` stays REFUSED, and `src/codegen.ts` was rewritten instead.** The construct census
— counting the construct, not the first blocker, per this document's standing correction —
finds **one** `get` accessor and **zero** `set` accessors across all twelve `src/*.ts`:

```sh
grep -nE '^[[:space:]]*(private |public |protected |static |readonly )*get [A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)' src/*.ts   # 1
```

That one site is `src/codegen.ts:747`, `private get terminated(): boolean`, read at 17 use
sites, all `this.terminated`, all inside `FnGen`. It is a zero-argument method with the
parens dropped and nothing else, so it is now `private isTerminated()`.

The refusal is the right side of the trade, and the reason is soundness rather than cost. A
getter makes `o.x` *sometimes* a slot load and *sometimes* a call, and three things
downstream assume it is always a slot: the checker's **dotted-path narrowing** (a fact about
`d.spans` is sound only because an undecorated object's field cannot change — a getter body
can read anything), **linearity** (a field read of an object is `NT1605`; a call result is
an owned or borrowed value with a drop obligation), and codegen's member lowering. Four
stages of work with a real silent-wrong-answer surface, against one site of payoff. What
changed in the compiler is the **hint**: `NT1015` on `get`/`set` now names the mechanical
rewrite, and `test/classes.test.ts` compiles and runs the rewrite it prescribes, because
advice a diagnostic gives has to compile.

**The `NT1607` over-refusal on a fresh receiver is fixed.** `new M().bump()` was refused
with a hint asking for "a local bound to `new C(…)` in this scope" — while
`const m = new M(); m.bump()` was accepted. The hint refuted itself: a `new C(…)` temporary
is not a binding, so nothing in this scope or any other can name it, which makes it strictly
**more** uniquely owned than the local the hint asks for. This is commit `1ea7fa2`'s fact
with the sign flipped — there "a syntactically-fresh receiver is a temporary nothing can
name" made `.push` VACUOUS, here it makes the call SAFE. Three lines in `src/ownership.ts`.

Scoped to exactly the safe shapes, measured rather than argued:

| Chain shape | Verdict |
|---|---|
| `new C().bump();` (statement), `new C().bump().bump().get()`, `const x = new C().bump()`, `g(new C().bump())` | **accepted** — the temporary never escapes the expression |
| `return new C().bump()` / `[new C().bump()]` / `move(new C().bump())` | **still `NT1604`** — a `@@mutable` method hands back a BORROW of its receiver, and for a temporary there is no owning binding to return instead |

Memory: **no double free** (exit 0 with correct stdout over 200 iterations — a double free
here is a *nonzero* exit with *correct* stdout, which is why both are asserted). There **is**
a leak, and it is **pre-existing and not `@@mutable`-specific**: a `new C(…)` used as a
receiver and never bound is never dropped. An ordinary `class P` measures the identical
`__objLive()` 200 for `new P(7).get()` on unmodified `main`, while the bound spelling
measures 0. Pinned in `test/decorators.test.ts` so it is recorded rather than hidden.

> **A pre-existing bug this lane found, not fixed.** `ROADMAP.md` Phase C records "unbound
> **array** temporaries freed where the chain consumes them" as ✅ and lists only "temporaries
> in non-chain positions (call arguments)" as still open. The OBJECT half of that chain rule
> was never wired, and the asymmetry is exact — same position, same 200-iteration loop, on
> unmodified `main`:
>
> ```ts
> // arrays: freed.   __arrLive() === 0
> for (let i = 0; i < 200; i++) { t = t + [1, 2, 3].indexOf(2); }
> // class instances: LEAKED. __objLive() === 200  (the bound spelling measures 0)
> for (let i = 0; i < 200; i++) { t = t + new P(7).get(); }
> ```
>
> A leak, never a double free or a dangling pointer — the same class Phase C already accepts.
> It matters more now that a fresh receiver can be *mutated* in a chain, since that is a shape
> people will write; the fix belongs with the object-temporary drop, not here.

This one sits directly on the self-hosting path: `src/codegen.ts`'s last line is
`new ModuleGen(…).build(…)`, and `ModuleGen` has carried `//@@mutable` since the NT1023
clearance, so `build` is a setter on a fresh receiver. It clears **one** of the two `NT1607`s
the section above predicted; the other — `this.mod.liftArrow(e)` at codegen.ts:1822, whose
receiver is a FIELD of `FnGen` — is untouched and correctly refused, since a field is
reachable through the object and is not unique. That one needs a source change or a real
field-borrow rule, and both sit behind the `NT1002` below.

| Module | Was | Now |
|---|---|---|
| `codegen.ts` | `NT1015` — `get terminated` in `FnGen`, 747:11 | **`NT1002`** — `` `in` (the key-presence operator) `` at 2078:16, `op in FCMP`, ~1300 lines deeper |
| `diagnostics.ts` | rung 3, 95,851 bytes of IR | **unchanged, byte for byte** |
| every other module | — | **unchanged** |

`NT1015` is now empty tree-wide in `test/self-host-coverage.ts`'s statement-recovery
histogram, the same way `NT1023` emptied: not by adding a feature, but because the census
said there was no second site behind the first.

**Next for `codegen.ts`: the `in` operator.** `op in FCMP` is a key-presence test on a
`Record`-typed table; the supported spelling of that today is a `Map` plus `.has`, which is a
source change of the same shape as this one. Not chased here.

### MUTUAL RECURSION LANDED — 41 of ast.ts's 45-member SCC encode, and the last 4 are NOT recursion

Self-recursion (`class Scope { parent: Scope | null }`) needs one back-edge, which the parser can
mint while parsing the declaration itself. `src/ast.ts` needs a whole **strongly-connected
component**: 45 of its 64 top-level type declarations are one cycle, closed by
`TemplateLiteral.exprs: Expr[]` running back through `type Expr`. That is now encoded — when the
hoisting fixpoint stalls it has *proved* the component, and every member is re-parsed with every
member's name resolving to `@Name`.

**The union-member rule, which was an argument and is now a measurement.** A union MEMBER may not
be a bare `@Name`: there is no box (SH2), so a union value IS the member's object block and
`unionDiscriminant` needs each member's SHAPE to prove the tag sits at the same slot index in
every one. The encoding expands ONE LEVEL at the member boundary and folds only below it. Both
halves were measured on the merged tree rather than trusted:

```
type Expr = Num | Negate;  interface Negate { kind: "Negate"; operand: Expr }
  ->  U<{kind:"Num",value:number}|{kind:"Negate",operand:@Expr}>
     unionDiscriminant -> { key: "kind", index: 0 }      # slot 0 in BOTH members
```

and the failure mode of getting the rule wrong is a **refusal, not a miscompile**:
`objectFields("@N")` returns `[]`, so `unionDiscriminant("U<@A|@B>")` is `undefined` and the union
is rejected (`NT1009`) rather than built with a phantom tag.

**`src/ast.ts` did NOT reach IR, and the reason is precise.** A component is encoded all-or-nothing
— a back-edge is minted only where it resolves — so the four members that do not encode take the
other 41 with them. The four, and none of them is recursion:

| declaration | what stops it |
|---|---|
| `ArrowFunction.body: Expr \| Stmt[]` | a general union of a discriminated union and an ARRAY: an array has no tag slot, so nothing inside the value tells the arms apart |
| `ForStmt.init: VarDecl \| Expr \| null` | needs union FLATTENING — a nested `U<…>` arm spliced into the outer union's members, which TypeScript does and this does not |
| `type Expr` | selects over `ArrowFunction` |
| `type Stmt` | selects over `ForStmt` |

So the next lane on this path is a **union** lane, not a recursion lane. The blocker MESSAGE for
`ast.ts` is deliberately unchanged (it is what `selfhost-ratchet.baseline.json` records as blocker
identity, and no blocker moved — all four instruments stay green with no re-record); the NT1030
**hint** now names these residual members and their own diagnostics, so the real gap is not masked
by the refusal in front of it.

**Two silent wrong answers fell out of the same work, both pre-existing and both in the recursive
path that had just landed.**

1. A HEAP OUT-OF-BOUNDS. `const a: N = { v: 1, next: { v: 2 } }` against
   `interface N { v: number; next?: N }` exited **255 with empty stdout**. `retypeLiteral`
   rewrites a literal into its target's SLOT LAYOUT and matched on `isObjectTy(baseTy(target))`
   — false for the back-edge `@N` — so the inner literal kept its own one-field shape while every
   reader typed the block as two slots. `assignable` DOES unfold, which is exactly why the program
   was accepted and then miscompiled. Fixed (unfold in `reshapable` and `retypeLiteral` too).
   Binding the same value to a local first was always fine, which is why nothing caught it.
2. `structuredClone` of a recursive value **aliased** it: `a.next === b.next` was `true` against
   node's `false`. Refused, along with the actor-message and `JSON.stringify` walks and
   `@@mutable` + recursive — see docs/divergences.md for all four and for the measurement that
   corrected `@@mutable`'s stated reason (the predicted leak is the pre-existing shallow-drop one;
   the real cost is `console.log` printing nesting where node prints `[Circular *1]`).

**Adjacent, not taken:** `a.next!.v` on a recursive field is `NT2001` ("Property 'v' does not
exist on @N") — the non-null assertion does not unfold the back-edge, where an ordinary field read
does. And nativets WRITES `undefined` into an optional field with no initializer, so `console.log`
shows the key (`{ v: 2, next: undefined }`) where node, which never created it, omits it
(`{ v: 2 }`). That one is not recursion-specific — `interface M { v: number; s?: string }` with
`const m: M = { v: 1 }` reproduces it — and it is a consequence of the optional-class-field fix.

### `NT1030` IS GONE — the SCC encodes, nine modules move, and NOT ONE reaches IR

The four residuals above were a **union** problem, and they took one compiler change and one
source change. `src/ast.ts` parses clean; `NT1030` is empty tree-wide for the first time.

**1. UNION FLATTENING (compiler, 17 lines in `src/parser.ts`).** TypeScript flattens
`A | (B | C)` to `A | B | C`; nativets refused it. A nested arm reached
`arms.every(isObjectTy)` as a `U<…>` — not an object type — so the whole union was
misreported as "general". `discriminatedUnion` now splices a nested union's MEMBERS into the
outer member list. The second half: with **three or more** arms a `null`/`undefined` arm is
still not a union member, it is the `?U`/`?N` encoding's tag, so it is hoisted out and the
rest built as an ordinary union. `ForStmt.init: VarDecl | Expr | null` needs both.

This **widens what is accepted without weakening the invariant**. The flattened result is an
ordinary union: `unionDiscriminant` still has to prove the tag sits at the same slot index
across every *spliced* member, which a nested union guarantees only among its own. Pinned:
an outer arm that duplicates a nested tag, one that moves the tag to slot 1, and one that
smuggles in a non-object member are all still `NT1009`; `A | B | null | undefined` is still
refused, since `?U`/`?N` spells one nullish arm. The two-arm fast path is untouched.

**2. `ArrowFunction.body` becomes TWO FOLDED FIELDS (source, 23 sites across 7 files).**
`body: Expr | Stmt[]` is a union of a discriminated union and an ARRAY — an array has no tag
slot. Three shapes were measured; **two of them are wrong in ways that are not obvious**, and
both are recorded because the second cost a design round:

| shape | verdict |
|---|---|
| `body: Expr \| Stmt[]` | no representation. `typeof` cannot separate an object union from an array. |
| **boxed `G<@Expr\|@Stmt[]>`** | **rejected on MEMORY SAFETY, not expressiveness.** `isGeneralUnionTy` is missing from `isLinearTy` (`ownership.ts:36`) and from the drop selection, so a general union holding an array leaks **both the box and the array** — `__arrLive() === 200` and `__objLive() === 200` against `0` for the identical plain-array local, on unmodified `main`. A box would also not have avoided the source change: all 18 cast sites are guarded by a *separate boolean field*, which no representation can narrow on. |
| `body: Expr \| Block` | **looks right, DEADLOCKS.** `Expr` selects over `ArrowFunction`, so while the component is being encoded `Expr` is still a bare `@Expr` with no shape — and a union member may not be a bare `@Name`. Flattening cannot help: there is nothing to flatten. Measured on a minimal repro *and* on real `ast.ts` (42 of 46 encoded, still stalled) before it was abandoned. |
| **`body?: Expr` + `stmts?: Stmt[]`** | **this.** Two folded back-edges, `?U@Expr` and `?U@Stmt[]`, neither needing any shape. No union, no deadlock. `exprBody` stays the discriminator. |

> **The general lesson, since this is the second time the SCC has punished it:** a union's
> encodability is not a property of its written SHAPE, it is a property of the ORDER the
> encoder reaches it in. `Expr | Block` and `Expr | Stmt[]` are equally impossible here for
> completely different reasons, and no amount of staring at the type says which.

**One of the 23 sites was SEMANTIC, and it would have shipped silently.**
`checkDefiniteAssignment` walks the tree shape-blind and identifies a nested function body by
asking whether the node's statement-list field is an array. After the rename it finds nothing
inside a block arrow, runs no analysis, and **accepts** `const f = (): string => { let out:
string; return out; }`, which must be `NT1600`. Seen RED before it was fixed. The guard is a
lint (`test/contextual-arrow.test.ts`): no `.body as Stmt[]` may exist in `src/` at all —
because `arrow.body as Expr` is unchanged *verbatim* by the rename and keeps typechecking, so
a missed reader compiles fine and merely reads `undefined`. Verified by reverting one site and
watching it red. (Scanned with `readFileSync`, never shell `grep` — the `grep` on this machine
is shimmed and silently misses matches, which would make the lint pass by finding nothing.)

**NECESSARY, NOT SUFFICIENT — the queue behind the SCC.** All nine modules moved; none reaches
IR. `diagnostics.ts` holds rung 3, byte for byte.

| module | was (linked) | now |
|---|---|---|
| `ast.ts` | `NT1030` SCC | **`NT1014`** — `new Map([[k, v], …])`, `DATE_GETTERS` (its own; behind it `NT2001` `Record`-literal, then `NT1606` `.push`) |
| `checker.ts`, `ownership.ts`, `parser.ts`, `modules.ts` | `NT1030` | `NT1014` — ast.ts's, through the link |
| `cli.ts`, `driver.ts` | `NT1030` | `NT1002` — `` `in` ``, codegen.ts's |
| `coverage.ts` | `NT1030` | ~~`NT1702` import cycle~~ → **`NT1014`** — ast.ts's, through the link (see below) |
| `coverage-preprocess.ts` | `NT1030` | ~~`NT1702` import cycle~~ → **`NT1031`** — `line++`, a captured-binding write, its OWN |
| `codegen.ts`, `lexer.ts`, `diagnostics.ts` | — | unchanged (`NT1002`, `NT1606`, rung 3) |

**The `NT1702` is the one to read twice, because it is a different KIND of blocker** — not a
missing feature but a defect in the module graph, and it has never been visible before because
ast.ts's refusal fired before the linker got far enough to trip over it. The cycle is
`coverage.ts → coverage-preprocess.ts → coverage.ts`, and the edge that closes it is
**type-only**: `coverage-preprocess.ts:34` is `import type { Blocker } from "./coverage.ts"`.
node and bun erase that import entirely, so there is no cycle at runtime — but `visit` in
`modules.ts` walks every import including type-only ones. Whether that is an over-refusal or a
real constraint depends on whether the type-export seeding can be ordered without the edge;
`spec.typeOnly` already exists at `modules.ts:495`, so the question is answerable.

**ANSWERED, by measurement — it is a REAL CONSTRAINT, not an over-refusal.** The edge is
genuinely type-only in one direction (`coverage.ts` imports the *value* `preprocessForCoverage`;
`coverage-preprocess.ts` imports only the *type* `Blocker`), so the runtime graph really is
acyclic — but dropping the edge from the DFS does not make `Blocker` resolve. It makes it
**unseeded**: the linker seeds each module's types from the modules linked BEFORE it, and
post-order puts `coverage-preprocess.ts` first either way, so the type provider is still behind
it. An unresolved type name then falls through `parser.ts`'s last resort
(`SCALARS.has(id) ? id : "number"`) and **silently becomes `number`** — measured on a two-module
repro where `f(x: Sz)` with `Sz = string` became `f(x: number)`. That is the silent-wrong-answer
class, so the linker keeps the edge.

The trap in the measurement is worth recording, because it nearly bought the wrong fix: patching
`visit` to skip type-only edges *does* move both modules to `NT1014`/`NT1031`, i.e. it looks like
it works. It only looks that way because both modules stop on an unrelated blocker before anything
reads the erased `Blocker`. Motion is not soundness.

So the refusal stays (now a documented divergence — nativets differs from node, bun AND tsc here),
and the two things that changed are:

1. **The diagnostic names the type-only edge** and says why ordering still binds, so the next
   reader is pointed at the one declaration to move instead of concluding their program is
   cyclic. Pinned by `bad-type-cycle` in `test/modules.test.ts`, which also asserts a genuine
   VALUE cycle is still named in order and is *not* blamed on types.
2. **`Blocker` moved down into the leaf** (`coverage-preprocess.ts`), which produces the first
   ones and imports nothing. Both modules then moved to their real blockers, and the blame column
   is the news: `coverage.ts` is clean on its own and inherits `ast.ts`'s `NT1014`, exactly as
   this document's rung-3 note predicted, while `coverage-preprocess.ts` has its FIRST blocker of
   its own — `line++`, the same captured-binding write `lexer.ts` sat on.

A linker fix remains possible, but it is a real feature rather than a flag: seeding type exports
on a pass ordered *independently* of evaluation order (types are erased, so their dependency
graph here is acyclic even though the combined graph is not). Until that exists, the honest
answer is the refusal plus a diagnostic that names the edge.

`ast.ts` also joins the parse-clean list, taking it to **eleven of twelve** — and stays at
rung 0, which is this document's oldest lesson restated: parsing clean has never once
correlated with being closer to compiling.

**A pre-existing gap this lane found, not fixed, and the sharpest of the three.** A recursive
type with an array-of-itself field can be **declared but never constructed**:

```ts
interface N { kind: "N"; v: number; kids: N[] }
const a: N = { kind: "N", v: 1, kids: [] };   // error[NT1001]: arrays of @N
```

`checker.ts`'s array element-type allowlist (~1722/1761) admits scalars, objects, arrays and
unions but not `isTypeRefTy`, so `@N` falls through. It is a refusal rather than a miscompile,
but it means the recursive types that just landed are write-only for the shape most real trees
have — and `ast.ts` is full of `Expr[]`/`Stmt[]`. It will bite the moment anyone uses what
landed. The third finding is smaller: an object **literal** cannot be passed to a
`Shape | undefined` parameter (`NT2001`, the literal is not retyped against the nullable's
union base so its tag widens to `string`); reproduces on a plain two-arm union on `main`.

### Re-measured after `in` — and "the last thing between codegen.ts and IR" was WRONG

`in` is no longer refused. A LITERAL key over an object type with no optional field is
decided at COMPILE TIME and folded, exactly as `instanceof` is and for the same reason — an
object's key set here comes from its TYPE. What a static type cannot decide is refused: the
optional field, a non-literal key (node's `in` walks the PROTOTYPE CHAIN, so a key we cannot
see cannot be checked against it), a `Map`/`Set` right operand (node tests the Map OBJECT's
properties, never its entries — `m.set("a",1); "a" in m` is **false**), an array, a
primitive. Semantics borrowed from tc39/test262 `test/language/expressions/in/`:
`S8.12.6_A1`, `S8.12.6_A2_T1`, `S8.12.6_A3`, `S11.8.7_A3`.

**The handoff said this was the last blocker standing between `codegen.ts` and IR. It was
not, and the reason is the oldest failure mode in this document: a PARSE-stage refusal masks
everything the CHECKER would say.** `in` was refused in `parseBinary`, at line 2095. Behind
it, at line **636** — 1,450 lines EARLIER — sits

```ts
const FCMP: Record<string, string> = { "<": "olt", … };
```

which is `NT2001`, the deliberate `Record` → `Map` erasure (`test/record-dict.test.ts`). Four
more tables in the same file have the identical shape (`ARITH`, `BITFN`, `MATH_FN1`, and
`BIN` is `parser.ts`'s), and `FCMP[op]` with a VARIABLE key is refused on top of that — an
object is indexed by a string literal here, and node's `o[k]` consults the prototype chain.
So `codegen.ts` does not reach IR, and clearing `in` was never going to make it.

| Module | Before | After |
|---|---|---|
| `codegen.ts` standalone | `parse` / `NT1002` — `` `in` `` at 2095:16 | **`check` / `NT2001`** — `FCMP` at **636**, the `Record` refusal |
| `codegen.ts` linked | `parse` / `NT1002` — the same | **`check` / `NT1014`** — `ast.ts`'s `new Map([[k,v]])`: no blocker of its OWN |
| `driver.ts` linked | `link` / `NT1002` — inherited from codegen.ts | **`check` / `NT1014`** — the same, now via `ast.ts` |
| `cli.ts` linked, i.e. **stage-1** | `NT1002` | **`NT1702`** — an IMPORT CYCLE (`cli.ts` → `coverage.ts` → `coverage-preprocess.ts`) |
| `diagnostics.ts` | rung 3 | **unchanged, byte for byte** |
| every other module | — | **unchanged** |

Both moves are to a LATER stage, and the `selfhost-ratchet` verdict was settled by a
controlled experiment rather than by reading the direction of travel: handed **main's
unmodified `codegen.ts`**, today's compiler reports the identical `NT2001` at 636. The
lane's own edits to that file (the object chain-temporary drop) are blocker-neutral, so the
move belongs entirely to the `in` change — an unmasking, not a regression. Re-recorded.

`codegen.ts` also **joined the parse-clean set, which is now ALL TWELVE**, without its rung
moving at all. Every module in the tree parses its own source; ONE produces IR. There is no
stronger statement available of `test/sh6.test.ts`'s standing point — parsing clean has never
once correlated with being closer to compiling.

`NT1002` is now empty tree-wide in both whole-tree instruments — `op in FCMP` was its only
site, and it stopped being a blocker rather than moving. Its three modules did not stall,
they redistributed: `codegen.ts` and `driver.ts` onto `ast.ts`'s `NT1014`
(`new Map([[k, v], …])`, the entries form), and **`cli.ts` — i.e. stage-1 itself — onto
`NT1702`, an IMPORT CYCLE** between `coverage.ts` and `coverage-preprocess.ts`. That last one
is worth stating plainly: with `in` cleared, the compiler's own entry point is gated on the
SHAPE OF ITS MODULE GRAPH rather than on any missing construct. Three codes now gate the
whole tree (`NT1014`, `NT1606`, `NT1702`).

**Next for `codegen.ts`: `Record<K, V>` initialized with an object literal**, five tables in
one file. It is a decision, not a gap — either the source moves to `new Map().set(…)` chains
(and every `FCMP[op]` read to `.get(op)`), or `Record` stops erasing to `Map`. The refusal's
own hint names the first; the second is a design change, because an object's fields are
static slots and a `Record`'s key set is by definition not statically known.

### THE ENTRIES FORM IS CLEARED — a SOURCE change, and this time the rewrite is FREE

`new Map([[k, v], …])` was the first blocker for **five of the twelve** modules — `ast.ts`'s
own `DATE_GETTERS` (src/ast.ts:155), inherited by `parser.ts`, `checker.ts`, `ownership.ts`
and `modules.ts` through the link. Three options were sized before anything was written:

| | verdict |
|---|---|
| **(a) SOURCE change** — build the table with the `.set` chain the diagnostic already prescribes | **TAKEN** |
| (b) 2-TUPLES as a narrow special form, only in the `new Map` argument position | rejected — see below |
| (c) GENERAL tuples in `Ty` | dismissed |

**What decided it was a CENSUS, not a preference.** Counting the construct rather than the
first blocker (this document's standing correction), `src/*.ts` holds **nine** entries-form
sites, and they split in two:

- **five are literal** `[[k, v], …]` — ast.ts:155, checker.ts:4524/:4565, modules.ts:431/:574;
- **four are DYNAMIC** — `new Map(p.recTypes ?? [])` against a declared `[string, Ty][]`
  (ast.ts:1204), and three `.map`-produced pair arrays (ownership.ts:111/:884,
  codegen.ts:1052).

That is the argument against **(b)**. A special form confined to the `new Map` argument
position covers the five literal sites and **cannot** cover the other four, which need a pair
type flowing out of a `.map` callback or off a declared annotation — i.e. option (c). So (b)
does not remove the source change, it only shrinks it, while adding a construct whose
accept/reject boundary is *syntactic*: `new Map([["a", 1]])` would compile while the
`const e = [["a", 1]]` one line above it stays `NT2001`. Paying new compiler surface for a
partial answer is the worst of the three.

**(c)** is dismissed on the two landmines already recorded here: `Ty` is a flat string whose
predicates key on suffix (`isArrayTy` once matched function types that way; `objectFields("@N")`
once returned a phantom record), and a new encoding must be taught to `isLinearTy` and the drop
selection or it leaks — the boxed `G<…>` measurement above is exactly that failure, at
`__arrLive() === 200`.

**The finding that makes (a) cheap, and it is a spec fact rather than a measurement:**
`Map.prototype.set` **returns its receiver** (ES2024 24.1.3.9 step 8), and the Map constructor
builds the entries form by calling `set` once per entry in order (24.1.1.1 step 8). So the two
spellings are the same program by construction, and — unlike the `.push` -> `xs = [...xs, v]`
rewrite this document measured at **1036x** under bun — the chain costs bun nothing. The
two-toolchain constraint really is satisfied for free here, which is the thing the `.push`
census discovered was *not* true in general.

Evidence is a node differential in `test/collections.test.ts`: nativets on the `.set` chain is
compared against **node running the entries form**, so the rewrite is asserted observationally
null rather than merely runnable. The real `DATE_GETTERS` is lifted out of `src/ast.ts` with
`readFileSync` and compiled, so writing the entries form back into it goes red. Cases borrowed
from tc39/test262 `test/built-ins/Map/`: `map-iterable.js`, `empty-iterable.js`,
`prototype/set/returns-this.js`, `.../does-not-change-size-of-existing-key.js`,
`.../append-new-values-normalizes-zero.js`. The last two corrected hand-computed expectations
(a duplicate key does not grow the Map; `-0` and `0` are one key stored as `+0`).

| module | was (linked) | now |
|---|---|---|
| `ast.ts` | `NT1014` — `new Map([[k, v], …])`, `DATE_GETTERS` (its own) | **`NT2001`** — `HOST_MODULES`, a `Record` initialized with an object literal (its own) |
| `parser.ts`, `checker.ts`, `ownership.ts`, `modules.ts` | `NT1014` — ast.ts's, through the link | **`NT2001`** — ast.ts's, through the link |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**No module reached IR**, and the five moved as a group onto the same next blocker. `NT1014`
is empty in `test/self-host-coverage.ts`'s histogram — **read that narrowly.** Unlike the
`NT1023` and `NT1015` clearances, which emptied because a census proved there was no second
site, this one emptied because the entries form is no longer any file's *first* blocker. Five
sites remain, each verified reachable and still `NT1014`. The sanctioned `.set` rewrite is
verified to compile for each of the five literal ones; they are left for a lane that can also
*measure* the movement, since all of them sit behind `HOST_MODULES` or `.push`.

**Two pre-existing bugs fell out, both fixed, and the second is the one that matters.**

1. **`ReadonlyMap` / `ReadonlySet` erased to `number`.** `parseGenericType` (src/parser.ts)
   maps `ReadonlyArray<T>` to `T[]` but had no case for the other two, so they fell through
   `default: resolveNamed(id)` and an unknown named type erases to `number`. The result is a
   program node runs and we reject, blaming a type nobody wrote:
   `'m' declared number but initialized with Map<string,number>`. Found while sizing the
   rewrite of `checker.ts`'s two tables — both are annotated `ReadonlyMap`. `Readonly*` is a
   compile-time-only distinction and nativets' collections *are* immutable, so they are the
   same types; two lines.

2. **The alpha-rename prefix was minted from the CLOCK.** `choosePrefixBase` (src/modules.ts)
   prefers `_m`, escalating to `_nt_m` then `_nativets_module_`, and if all three appear in the
   sources it fell back to `` `_nts${Date.now().toString(36)}_m` ``. The one file in the tree
   guaranteed to contain all three is **`src/modules.ts` itself** — they are the candidate list,
   spelled in that very function — so the clock branch was reached by precisely the module this
   measurement cares about. Three consequences, in increasing severity:

   - `selfhost-ratchet.test.ts` records the blocker **message** as blocker identity. The moment
     this lane moved `modules.ts` onto a diagnostic that NAMES a binding, the ratchet started
     failing against *itself* — two measurements in the **same run** produced
     `_ntsmsl8somd_m2_HOST_MODULES` and `_ntsmsl8snkl_m2_HOST_MODULES`;
   - `sh6.test.ts`'s `blameOf` attributes a blocker by byte-identical message, so no
     name-carrying blocker can ever be attributed to the dependency it lives in;
   - **SH7's definition of done is "`nativets-2` and `nativets-3` are BYTE-IDENTICAL."** A
     compiler that names globals from the clock cannot reproduce itself. This one was latent
     under every measurement ever taken here and would have surfaced as an unexplainable
     fixed-point failure at the very end.

   The escalation now counts (`_nts0_m`, `_nts1_m`, …) until no source contains the candidate:
   same no-collision guarantee, pure function of the inputs, and it terminates because each
   candidate is longer than the last. Pinned in `test/modules.test.ts`.

**One instrument was fixed rather than re-recorded.** `sh6.test.ts`'s blame column flipped
`ast.ts` -> `self` for four modules, which is **false** — `HOST_MODULES` is declared in
`src/ast.ts`. `blameOf` compared raw messages and the linker renames the binding
(`HOST_MODULES` vs `_nt_m0_HOST_MODULES`), so blame fell through to `self`. It cost nothing
while the frontier sat on `NT1014`/`NT1030`, whose messages carry no identifier. Normalizing
the rename prefix before comparing restores the correct attribution — and the recorded blame
column then needed **no change at all**, which is the proof the fix was right. Recording the
flip would have aimed four burn-down lanes at files that hold nothing.

### THE `Record`-LITERAL FAMILY IS CLEARED — a SOURCE change, decided by how the tables are READ

`Record<K, V>` declared but initialized with an object literal was the first blocker for
**eight of the twelve** modules: `src/ast.ts`'s `HOST_MODULES`, inherited through the link by
parser, checker, codegen, coverage, ownership, driver and modules. Three options, sized first:

| | verdict |
|---|---|
| **(a) SOURCE change** — spell the tables as what they are | **TAKEN**, as `new Map().set(…)` + `.get`/`.has` |
| (b) accept the literal and BUILD a Map from it at the declaration | rejected — it unblocks nothing; see below |
| (c) stop erasing `Record` to `Map` | dismissed |

**The census, not the first-blocker count.** `readFileSync` over all twelve `src/*.ts` (never
shell `grep` — project memory records a shimmed `grep` that silently misses matches) found
**eleven** such declarations in **four** files, not one:

| File | Tables |
|---|---|
| `ast.ts` | `HOST_MODULES` |
| `parser.ts` | `BIN` |
| `checker.ts` | `NUMBER_CONSTS`, `MATH_METHODS`, `STRING_METHODS`, `HOST_FUNCS`, `GLOBAL_FUNCS` |
| `codegen.ts` | `FCMP`, `ARITH`, `BITFN`, `MATH_FN1` |

(Five further `x as Record<string, unknown>` sites are type ASSERTIONS over an AST node — they
never reach a `Ty` and never allocate — so they are not this construct.)

**What decided (a) is the USE, and it is unanimous.** Every one of the eleven is read with a
**variable key**: `NUMBER_CONSTS[e.property]`, `STRING_METHODS[e.callee.property]`,
`GLOBAL_FUNCS[e.callee.name]`, `FCMP[op]`, `HOST_MODULES[mod]`, `BIN[t.value]`, … plus
`op in FCMP` (×3 tables) and `Object.keys(HOST_MODULES)`. `BIN` alone also has three
LITERAL-key reads (`BIN["<"]`), and it has variable ones too.

So the diagnostic's second escape hatch — *"annotate the exact shape instead, but ONLY if
every read uses a LITERAL key"* — applies to **none of the eleven**, and this was verified
rather than assumed: an object indexed by a non-literal key is `NT2001 object must be indexed
by a string literal`, `k in o` with a non-literal key is `NT1002`, and `{ [k: string]: V }`
does not even parse (`NT0001`). All three refusals are **correct**, for the reason
`src/lexer.ts` already records above its `escapeChar` switch: node's `o[k]` consults the
PROTOTYPE CHAIN, so an own-keys-only lowering answers `undefined` where node answers a
function.

These tables therefore ARE dictionaries with runtime keys. **`Record<K, V>` was the honest
TYPE all along; the object literal was the wrong CONSTRUCTOR** — which is why (a) here is the
`.set` chain the refusal's own hint prescribes, not a re-annotation. It is free under bun for
the same spec reason the entries-form lane found: `Map.prototype.set` returns its receiver
(ES2024 24.1.3.9 step 8).

**Why (b) is not merely bigger but ineffective.** Lowering `const m: Record<K,V> = {a:1}` to a
Map at the declaration leaves every READ unchanged — and the reads are `m[k]` with a variable
key, which is refused independently of how `m` was built (`Map` indexed by a string is
`NT2001 index must be number`). To move a single module, (b) would additionally have to lower
`m[k]` to `.get(k)`, i.e. adopt an own-keys-only semantics for `o[k]` — a documented
divergence from node on exactly the prototype-chain keys that the bug below proves are live.
(c) is dismissed on the encoding landmines already recorded here: `Ty` is a flat string whose
predicates key on suffix, and a new representation must be taught `isLinearTy` or it leaks.

Two adjacent items the same rewrite required or produced:

- **`MATH_METHODS` was `Record<string, number | "var">`** — a SCALAR union, the `NT1009` this
  document has quoted since SH2, on top of the `Record` refusal. "How many arguments" and "is
  it variadic" are different questions, so they are now two tables (`MATH_ARITY` +
  `MATH_VARIADIC`) rather than a sentinel smuggled into an arity.
- **A COMPILER gap that made the sanctioned idiom unavailable**, found by walking into it:
  `.set` compared its value by IDENTITY (`argTys[1] !== v`) and typed its arguments with no
  context, so `new Map<string, Op>().set("*", { prec: 13 })` was `NT2001` on code the
  identical `const o: Op = { prec: 13 }` had always accepted — an optional field was fatal
  whether omitted (`logical` absent) or present (`right: true` is `boolean`, the slot is
  `?Uboolean`), and an empty array literal in a field (`argTys: []`) was `NT1001`. Both halves
  now route through `typeArg`/`fitsArg`, the same path every other argument site takes, which
  reshapes a LITERAL into the declared slot layout and still refuses a non-literal of a merely
  compatible type (widening past that is the dereference-a-double bug). `Set.add` deliberately
  did NOT get the branch: a Set element here is `string | number`, so there is no literal to
  rebuild — pinned as a boundary rather than left as an asymmetry.

| module | was (linked) | now |
|---|---|---|
| `ast.ts` | `NT2001` — `HOST_MODULES` (its own) | **`NT1606`** — `.push`, its own |
| `parser.ts`, `modules.ts` | `NT2001` — ast.ts's, through the link | **`NT1606`** — `.push`, lexer.ts's |
| `checker.ts` | `NT2001` — ast.ts's | **`NT2001`** — `argTys: ["string", null]`, its OWN |
| `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts` | `NT2001` — ast.ts's | **`NT2001`** — checker.ts's, through the link |
| `lexer.ts`, `cli.ts`, `coverage-preprocess.ts`, `diagnostics.ts` | — | **unchanged**; `diagnostics.ts` holds rung 3, byte for byte |

**No module reached IR**, and the reason is measured rather than guessed: replacing the
`null`s with a sentinel in a scratch experiment moves all five `NT2001` modules to `NT1014`
(the five remaining entries-form sites), and behind THOSE is `.push`. `.push` is the 185-site
census elephant and is refused by DECISION, so nothing in this lane's reach could have
produced a second self-compiling module.

**The newly unmasked blocker, stated for whoever takes it next.** `argTys: ["string", null]`
is an **array of NULLABLE elements**, and it is refused at a plain declaration too —
`const a: (string|null)[] = ["x", null]` is `NT2001 array elements must share a type (got
string, null)`, and `[null]` alone is `NT1001 arrays of null`. That is a real feature, not a
`.set` gap, and it now gates five modules. The cheap-looking source change (a `Ty` sentinel
for "unconstrained", which `checkArgs` already treats as falsy) was deliberately NOT taken: it
is the same sentinel-in-a-field this lane rejected for `MATH_METHODS` one paragraph earlier.

**PRE-EXISTING BUG, found on the way, and it is a SILENT WRONG ANSWER.**

```
console.log(Number.constructor)     node: [Function: Function]     nativets: NaN, exit 0
```

`NUMBER_CONSTS` was a plain object, so `NUMBER_CONSTS["constructor"]` is
`Object.prototype.constructor` — a FUNCTION, hence `!== undefined`. The checker's guard
(`src/checker.ts`) admitted the member as `number` and codegen's fold handed the Function to
`llvmDouble`. Reproduced for `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
`isPrototypeOf` and `__proto__` — six inherited names, six `NaN`s, **exit 0 on both sides**,
which is precisely the class CLAUDE.md calls the worst outcome available. The Map has no
prototype chain to fall through, so `.get` answers `undefined` and the existing refusal fires;
pinned in `test/record-dict.test.ts`. The same prototype fall-through also made
`hasOwnProperty("x")` crash the compiler with an internal stack trace (`sig.min` of a
`Function`) instead of producing a diagnostic, and gave `Math.constructor(1)` a message
containing `function Object() { [native code] }`. All three are gone with the rewrite — which
is the strongest available argument that (a) was the right option and not merely the smallest:
(b) would have made these programs *compile*, by diverging from node exactly where node is
observable.

`test/record-dict.test.ts` also carries the lint that keeps the construct out: no `src/*.ts`
may declare a `Record<` annotation, casts and prose excepted.

### `NT1031` IS GONE FOR THE SECOND AND LAST TIME — the same cursor shape, the other tokenizer

`coverage-preprocess.ts` was the only module in the tree still writing a **captured binding**,
and it was the same construct, in the same kind of code, as the one `src/lexer.ts` cleared two
rounds earlier: a scanner cursor moved by closures.

```ts
let line = 1;
let prev: Tok | undefined;
const nl   = (s: string) => { for (const c of s) if (c === "\n") line++; };   // NT1031
const push = (t: Tok)    => { toks.push(t); prev = t; };                      // NT1031
```

The fix is `LexState`'s, verbatim: **one `//@@mutable` record** (`TokState { line, prev }`)
declared at module scope and instantiated as an owned local. Mutating a FIELD of an owned local
is not a capture write — the binding never changes, the object does — and `//@@mutable` is a
comment to TypeScript, so bun runs the file unchanged. No compiler change; the compiler still
refuses main's version of this file, which is the controlled experiment
`test/selfhost-ratchet.test.ts` asks for and which its advisory printed unprompted.

**The evidence is not the tests, it is the corpus.** A source rewrite inside a tokenizer is
exactly the shape this document has twice recorded as under-tested by a fixture suite (the regex
removal: five of six mutations invisible to all 121 fixtures). So old and new
`preprocessForCoverage` were run over **every `.ts` in `src/`, `test/` and `examples/` — 486
files, 2.49 MB — and their full output compared byte for byte: ZERO differences.**

And, because a null diff proves nothing about code the corpus never reaches, each rewritten line
was **mutated in turn** and the diff re-run:

| mutation | files that differ |
|---|---|
| `nl`'s newline test `\n` -> `\r` | **133** |
| `regexAllowed(st.prev)` -> `regexAllowed(undefined)` | **22** |
| the loop's line counter `\n` -> `\r` | **466** |
| a template's `startLine` -> `1` | **0** — see below |

Three of four red the corpus, so the null result is known to be *reached*. The fourth is a real
blind spot and is stated rather than glossed: `startLine` only escapes `tokenize` when a template
literal is the FIRST token of a top-level statement, which no file in the corpus does. It is
covered by three hand-built inputs instead, whose statement lines come back `[1,4]` / `[1,4,7]`
and match old for new.

| Module | Before | After |
|---|---|---|
| `coverage-preprocess.ts` | `check` — `NT1031`, `line++` in a closure | **`check` — `NT1606`**, `.push` (its own) |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**`NT1031` is now empty tree-wide**, and unlike the buckets this document keeps watching refill,
this one has no second holder to unmask: both of the tree's hand-written tokenizers now carry the
same cursor record, and they were the only two closures-over-a-`let` in `src/`.

**The rung did not move, and it was never going to.** Behind the capture write is `.push` — the
185-site census elephant, refused **by decision** (commit `1ea7fa2`), whose sanctioned
`xs = [...xs, v]` idiom is measured at **1036x** under bun at real accumulator sizes. Rewriting a
per-token accumulator that way would break the two-toolchain constraint (`src/*.ts` has to keep
*running* under bun), so it is an owner decision and was deliberately not taken here.
`coverage-preprocess.ts` joins `ast.ts`, `lexer.ts`, `modules.ts` and `parser.ts` in the `NT1606`
bucket, which is now **five of twelve** and is the single largest thing between here and SH6.

### STAGE-1 GIVES BACK THE ONLY BLOCKER IT EVER OWNED — `await` at the inner call site

`cli.ts` is stage-1: the real entry point, whose import graph pulls in everything. In every
measurement in this document but one it has been gated on a *dependency*. The exception was
its own `NT1020`:

```ts
await guard(() => buildBinary(source, out, { target, static: isStatic, entryPath: file }));
//           ^ the arrow's body calls an async function without `await` — NT1020 at 76:21
```

Under node this promise is **not** dropped: `guard` is `async function guard<T>(fn: () =>
Promise<T> | T)` and its body is `return await fn()`, so the promise is awaited one frame up.
Two options were sized:

| | verdict |
|---|---|
| **(a) SOURCE change** — `async () => await buildBinary(…)`, the `await` at the inner call site | **TAKEN** |
| (b) COMPILER — narrow NT1020 for a call whose value is returned rather than discarded | rejected, and the reason is already written down |

**(b) is rejected by a decision this project has already made and recorded.**
`docs/divergences.md` names this exact shape a **deliberate over-rejection**:

> A promise that is threaded through un-awaited and only awaited further up … produces
> node's answer here, but is still refused … Knowing which of these is safe is a taint
> analysis over promise values; refusing the un-awaited call is the same rule everywhere,
> and **`await` at the inner call site is always the fix**.

A recent lane deliberately made this guard *wider*, not narrower (it now covers promise-typed
values escaping through parameters and returns). Narrowing it here for one call shape would
re-open the hole that lane closed, and would make the accept/reject boundary syntactic again.

**(a) is observationally null under bun**, and that is checked rather than argued. `guard`
awaits whatever the callback returns, so `() => f(…)` and `async () => await f(…)` hand it the
same promise; a rejection propagates through the async arrow to `guard`'s `catch` identically,
which is the path that turns an `NTError` into a clean `error[NT….]` line instead of a stack
trace. Old and new `src/cli.ts` were run side by side on `build`, `run`, `emit`, a program that
exits 7, and a program that is refused: **identical stdout and identical exit codes** (1, 1, 7,
0), including the diagnostic text.

| Module | Before | After |
|---|---|---|
| `cli.ts` **linked (= stage-1)** | `link` — `NT1020`, its OWN | **`check` — `NT2001`**, checker.ts's `argTys: ["string", null]` |
| `cli.ts` standalone | `NT2001` `process.stdout is not supported` | **unchanged** |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

The blocker moved to a LATER stage (`link` -> `check`) and back to a dependency's, so stage-1 is
once again gated on the thing that gates five other modules: an **array of nullable elements**.

**One instrument reports a blocker the compiler does not, and it is worth naming.**
`test/self-host-coverage.test.ts`'s histogram gained `NT1020` x2 for `cli.ts` — an artifact of
`coverage`'s statement-at-a-time recovery, which parses the call with no `guard` declaration in
scope, so `promiseParamsByFn` is empty and the escape check refuses an async arrow that the real
parser accepts. Measured both ways (declaration+call together parses; the call alone reports it).
It is the mirror image of the confound this document already records for `lexer.ts`: a clean row
in that histogram is not evidence a module is clean, and a dirty row is not evidence it is
blocked.

### THE ARRAY OF NULLABLE ELEMENTS IS CLEARED — and it was an ENCODING AMBIGUITY, not the element rule

`argTys: ["string", null]` in `MethodSig` (src/checker.ts) was the first blocker for **six of
the twelve** modules — checker.ts's own, inherited through the link by codegen, coverage,
ownership, driver and cli. It reproduced at a plain declaration, so it was never a `.set`
artifact:

```ts
const a: (string | null)[] = ["x", null];   // NT2001 array elements must share a type (got string, null)
```

**The array element-type allowlist was not the cause, and a lane sent to add a nullable arm to
it would have found nothing to add.** The cause is an ambiguity in the `Ty` encoding. A nullable
is a PREFIX (`?U`/`?N`) and an array is a SUFFIX (`[]`), so the two compose to one string:

```
makeNullable("null", "string")  + "[]"  === "?Nstring[]"    // (string | null)[]
makeNullable("null", "string[]")        === "?Nstring[]"    // string[] | null
```

`isNullableTy` anchors at the front and wins, so `(T|null)[]` had **always read as `T[]|null`**.
The literal error was only the visible half; the sharper symptom is a program with no `null` in
it at all:

```
const a: (string|null)[] = ["x","y"]; a.length
BEFORE: error[NT2001]: 'a' is possibly null — this read is not proved non-nullish
AFTER:  2
```

**This is the identical collision the parser already refuses one construct away.**
`parseTypeAtom` (src/parser.ts) refuses `((n: number) => number)[]` because
`makeFuncTy(["number"],"number[]")` and `makeFuncTy(["number"],"number") + "[]"` are the same
string, and its comment ends *"Whoever implements them has to fix the encoding first, which is
the point."* The nullable case was the same defect with **no refusal in front of it** — it
silently took the other reading and produced a diagnostic about a type nobody wrote.

The fix is the one that comment prescribes: **parenthesize the element**. `makeArrayTy`
(src/ast.ts) wraps a nullable element (`(?Nstring)[]`) and is the old concatenation for
everything else, and `elemTy` strips one balanced pair back off. `(?Nstring)[]` cannot be
confused with anything: it does not start with `?U`/`?N`, and `isFuncTy` needs a top-level
`=>` a bare paren group has not got. **`T[] | null` keeps its spelling byte for byte**, which
is why every existing `Ty` string in the tree is unchanged — 131 IR snapshots and 393 fixtures
pass untouched.

Four small pieces, in the order they were needed:

1. `makeArrayTy`/`elemTy` in `ast.ts`, and **every** `${el}[]` construction site routed through
   it (15 of them across checker/codegen/parser). Missing one is not cosmetic: `a.filter(...)`
   built `?Nstring[]` and the result was reported 'possibly null'.
2. The parser's `[]` suffix loop, `Array<T>`/`ReadonlyArray<T>`, and the tuple erasure.
3. `arrayElementOk` — ONE predicate where there were two hand-inlined chains (the
   empty-with-a-hint path and the inferred path), with a nullable arm that **recurses on the
   base**, so `(() => number | null)[]` stays refused for the reason its base is refused.
4. Codegen: an array literal now **coerces each element into the declared element type**, the
   same store boundary an object literal's field takes. Without it `["x", null]` pushed a raw
   `ptr` and a raw 0, and reading a slot back as a box loaded the first word as the tag.

**`[null]` alone stays NT1001, and that is the right answer rather than a residual gap.** Its
type is genuinely unknown (TypeScript infers `null[]`, for which there is no element
representation). Contextual typing from an annotation is the discriminator, and it works:
`const b: (string|null)[] = [null]` compiles. `undefined` behaves identically (`?U` for `?N`),
and the MIXED `(A | null | undefined)[]` stays refused — `Ty` has one nullish slot, so that is
the existing `A|B|null|undefined` refusal reached through an element, not a new one.

**Soundness: a leak, never a double free, and the leak is not new.** An array of nullables is an
array of POINTERS to `[tag, value]` boxes. `__arrLive() === 0` after 100 iterations — the
vectors are freed exactly once, exit 0 — and `__objLive() === 200`, i.e. the boxes leak.
That is not array-specific and not caused by this change: `isLinearTy` (src/ownership.ts) is
`isArrayTy || isObjectTy || isUnionTy || isTypeRefTy`, so a **nullable is never in any drop set
anywhere** — 100 loose `string | null` locals in a loop already measure `__objLive() === 100`
with no array in sight. Both measurements are pinned in `test/nullable-element.test.ts`, the
baseline included, so the day nullables become linear the array case is already watched.

| module | was (linked) | now |
|---|---|---|
| `checker.ts` | `NT2001` — `argTys: ["string", null]`, its OWN | **`NT1014`** — `new Map([[k,v], …])`, `CONSOLE_STREAMS`/`FMT_SPECS`, its OWN |
| `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts` | `NT2001` — checker.ts's | **`NT1014`** — checker.ts's, through the link |
| `cli.ts` (= stage-1) | `NT2001` — checker.ts's | **`NT1014`** — the same |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**No module reached IR, and what is behind this was MEASURED rather than predicted.** With
checker.ts's two remaining entries-form tables rewritten as the sanctioned `.set` chain in a
scratch tree, checker/codegen/coverage land on **`.push`** and ownership/driver on a Map spread.
`.push` is the 185-site census elephant and is refused **by decision** (commit `1ea7fa2`), so
nothing in this lane's reach could have produced a second self-compiling module. The scratch
rewrite was reverted: the five remaining entries-form sites are a decided source change belonging
to the lane that owns them, and doing two of five would move six modules' blockers for a partial
answer.

The tree-wide code set is now **two codes and eleven modules**: `NT1606` (`.push` — ast, lexer,
parser, modules, coverage-preprocess) and `NT1014` (the entries form — the six above). The
compiler's own frontier is a source idiom and five table sites.

**PRE-EXISTING BUG, found on the way, and it is a SILENT WRONG ANSWER.**

```
[[1],[2]].join(";")       node `1;2`                nativets `\x01;\x01`   exit 0 on BOTH
[{x:1},{x:2}].join(",")   node `[object Object],…`  nativets `,`           exit 0 on BOTH
```

Reproduced on `main` at `942f48b` with no nullable anywhere near it. `joinFn` (src/codegen.ts)
is a three-way dispatch (`num`/`bool`/`str`) whose **default** is `nt_arr_join_str`, i.e.
`strlen` on the slot — the exact failure its own comment records for `boolean[]` ("a two-way
choice written twice is exactly how the third case gets missed twice"). `checkStringCoercion`
(src/checker.ts) is the allow-list that keeps `${arr}` / `String(arr)` / concatenation off that
default, and it says in prose that the two lists "must stay in step" — but **`.join()` itself
never consulted it**. One list, written on one of the two paths. `.join()` consults it now, which
also covers the nullable element (whose box pointer landed in the same default arm). Pinned in
`test/nullable-element.test.ts`.

A whole-surface sweep of a nullable-element array against node — 33 operations — produced **zero
other wrong answers**; everything not node-exact is a named refusal (`.at`, `.find`,
`.indexOf`/`.includes`/`.lastIndexOf`/`.with` on the argument's type, `.concat`, `.toSorted`
without a comparator, `.map` producing a nullable).

### THE ENTRIES FORM IS GONE FROM `src/` — and the six modules did NOT stay a group

`NT1014` was the first blocker for **six of the twelve** modules. It is now absent from the
whole tree, cleared entirely by SOURCE changes, and the census that drove them was run with
`readFileSync` rather than shell `grep` (project memory: the shimmed `grep` here silently
misses matches, and several wrong conclusions today came from it).

**The census splits the construct in two, and the split is the whole finding:**

| | sites in `src/` | shape | available fix |
|---|---|---|---|
| **LITERAL** `[[k, v], …]` | 4 | the entries are written out | the `.set` chain — mechanical, **taken** |
| **DYNAMIC** | 4 | the entries come from a value | a `[K, V]` **tuple type** — not available |

Taken (literal): `checker.ts`'s `CONSOLE_STREAMS` and `FMT_SPECS`, `modules.ts`'s two `sources`
maps. Left (dynamic): `ast.ts:1287` `new Map(p.recTypes ?? [])` against a declared
`[string, Ty][]`, and `.map`-produced pair arrays at `codegen.ts:1089` and `ownership.ts:899`.
`new Map(anotherMap)` — `parser.ts:600`, `codegen.ts:4214` — was never blocked; the Map-copy
form is supported.

**One dynamic site WAS the blocker, and it did not need the tuple type after all.**
`ownership.ts:111`'s `clone` was
`new Map([...s].map(([k, v]) => [k, { ...v }]))`, and what stopped it was reported as a **Map
SPREAD** (`[...s]` yields pairs) — the same missing tuple reached from the other side. A `.set`
*chain* cannot express it, since the entries are not known at the source; a `.set` *loop* can,
and it is what the constructor does internally anyway (24.1.1.1 §8 calls `set` once per entry,
in order). So the rewrite is a loop, it drops an intermediate pair array under bun, and no
encoding was invented. This mattered: ownership.ts, driver.ts and cli.ts were all sitting on it.

| module | was (linked) | now |
|---|---|---|
| `checker.ts`, `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts` | `NT1014` | **`NT1606`** — `.push` |
| `cli.ts` (= stage-1) | `NT1014` | **`NT2001`** — `process.stdout is not supported`, its OWN |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**Five of the six landed exactly where the previous lane MEASURED they would** in a scratch
tree — `.push`, refused by decision (commit `1ea7fa2`) — which is the first time in this
document that a prediction about the next blocker has been recorded in advance and then held.

**The sixth did not, and it is the more interesting row.** `cli.ts` does not join the `.push`
group; it stops on `process.stdout`, a host surface nativets has simply never grown. That is
a *missing feature*, not a refusal-by-decision, and it means **stage-1's next step is now
independent of the 185-site `.push` rewrite** — the first time those two have been separable.
Nobody predicted it, because the six had moved together for four measurements running.

**PRE-EXISTING BUG, found on the way, and it is a SILENT WRONG ANSWER.**

```
const p: number | undefined = 1, q: number | undefined = 2;  p === q
                                   node false        nativets TRUE     exit 0 on BOTH
```

Found because the `clone` gate test compares two `Map.get` results. `===` between two nullable
BOXES fell through the comparison chain's **default arm** to `js_str_eq`, i.e. `strcmp` over the
`[tag, value]` block, which stops at the first NUL byte of the i64 tag — so every present box
equalled every other one, `?Nstring` included (`"a" === "b"` was `true`). It is the fourth member
of the family `refuseUnboxedUnion` records for the general-union box, and the only one that never
had a refusal in front of it. **Refused now** (`NT1009`, with the narrowing and `??` fixes in the
hint); a correct lowering is a tag dispatch needing a branch per base type. `x === undefined` /
`x === null` is untouched — that one really is a tag comparison. See `docs/divergences.md` and
`test/narrowing.test.ts`.

---

### RESOLVED — `.push` is legal on a `@@mutable` ACCUMULATOR, and the rewrite was never taken

The 1036x measurement above is the reason, and it survived re-measurement on a later tree
(30,000 appends: **760 ms** bun / **4 ms** nativets for `xs = [...xs, v]`, **2 ms** / **0 ms** for
`.push`). Read it precisely, because the number invites the wrong conclusion:

> **The spread idiom is NOT slow in nativets. It is slow in bun.**

It is O(1) amortized here via the transient path, and a real O(n) copy per append there. Since
`src/*.ts` must satisfy **both** toolchains — bun runs it today, nativets must compile it tomorrow
— the requirement was never "find a faster immutable idiom for nativets". It was "find one that is
fast in **bun** and compilable **here**". That narrows the problem a great deal, and it rules out
every immutable candidate at once: a builder object was measured at **632 ms** under bun for the
same 30,000 appends, because a builder written in the subset has to spread internally.

So `.push` is legal on a binding declared `@@mutable` — the comment-pragma spelling, exactly the
route `@@mutable class` (Stage 45) and `@@mutable` records (Stage 49) took for the same
two-toolchain reason. **It needs no source rewrite at all**: `src/*.ts` keeps writing `.push`,
which is native speed in bun, and nativets compiles it as real mutation. Two declarations carry the
pragma today — `lex`'s `tokens` and `splitTopLevel`'s `out`.

**What it did to the frontier.** All FOUR modules `.push` was the first blocker for moved off it:

| module | before | after |
|---|---|---|
| `ast.ts` | `NT1606` `.push`, own | **`NT1002`** — `String.prototype.trimEnd` |
| `lexer.ts` | `NT1606` `.push`, own | **`NT2001`** — "Cannot compare string with undefined", own |
| `parser.ts` | `NT1606` `.push`, lexer.ts's | **`NT2001`** — lexer.ts's, through the link |
| `modules.ts` | `NT1606` `.push`, lexer.ts's | **`NT2001`** — lexer.ts's, through the link |

As a first-blocker set `NT1606` drops from **five modules to one** — the survivor is
`coverage-preprocess.ts`, whose accumulators this lane did not annotate (`test/bootstrap.test.ts`,
the seventh turn of that bucket). None of the four reached IR, so `diagnostics.ts` is still the
only rung-3 module.

**The census's second column, now that it exists.** Re-run, the census counts **205** sites (up
from 185 — the tree grew), and only **two declarations** carry the pragma. The
ones that need more than a comment are the shapes the opt-in **deliberately refuses**:

| shape | sites | why it stays refused |
|---|---|---|
| a plain local, pushed at function level | most of the 145 | **cleared** — one `//@@mutable` line per declaration |
| a plain local, pushed from inside a **capturing arrow** | all of `modules.ts`'s | a closure env holds a second pointer this scope cannot null (`NT1607`) |
| `this.<field>` | 38 | a field names no binding whose ownership the pass can establish |
| a **parameter** (`ast.ts` `setBlockDrops(list: Stmt[], …)`) | 1 | a parameter is a BORROW; the caller owns it |

That third row is the honest sizing correction: the census's "38 `this.<field>` sites need a
decision rather than a rewrite" is still true and is now the largest remaining block, concentrated
in `src/parser.ts` (18 of them).

**And commit `1ea7fa2` was right about what it measured.** It refused `.push` on a
syntactically-FRESH receiver as vacuous — nothing can name a temporary, so mutating it is
unobservable *by construction* — and that argument is untouched: `[1,2].push(3)` is still refused.
The shape that is now legal is the opposite one, a NAMED accumulator, and what makes it safe is not
a new analysis: an array is LINEAR, so `const b = xs` MOVES and a second live handle cannot exist.
See `docs/decorators.md`.

**One real use-after-free was found doing this**, and it is the kind this document exists to
record. `.push` **consumes** its argument, exactly as `[...xs, v]` does. While the argument was
merely borrowed — which is right for every *other* call — a linear value pushed inside a function
stayed owned by its local, the local freed it at scope exit, and the array went on pointing at it:
`g.push(a)` then `g[0].length` printed `3` for a 2-element array, at exit 0.

### RE-MEASURED AT THE MERGE — and this time BOTH branches understated the movement

The entries-form table two sections above was true on its own branch and was superseded within
the hour: the `.push` lane landed at the same moment and legalized `.push` on a `@@mutable`
accumulator, so the five modules recorded arriving at `.push` walk straight through it.

| module | entries-form branch | `.push` branch | MERGED |
|---|---|---|---|
| `checker.ts`, `codegen.ts`, `coverage.ts`, `ownership.ts` | `NT1606` `.push` | `NT1014` | **`NT1002`** — ast.ts's `trimEnd` |
| `driver.ts` | `NT1606` `.push` | `NT1014` | **`NT2001`** — lexer.ts's `Cannot compare string with undefined` |
| `cli.ts` (= stage-1) | `NT2001` `process.stdout` | `NT1014` | **`NT2001`** — unchanged, its OWN |
| `diagnostics.ts` | rung 3 | rung 3 | **rung 3**, IR byte-identical |

Tree-wide the entries-form branch measured `["NT1606","NT2001"]` and the `.push` branch
`["NT1002","NT1014","NT1606","NT2001"]`. **The merged answer is `["NT1002","NT1606","NT2001"]`
and it is not a subset of either** — the fifth time this document records a merge whose blocker
list neither side had right, and the first where both sides *understated* the frontier rather
than overstating it. Two lanes each cleared a different term of the conjunction, so the modules
moved two steps in one merge and no reviewer holding the two diffs could have computed it.

The residual shape is worth stating: **five of twelve modules are now behind ONE `trimEnd`
call site in `ast.ts`**, four of twelve behind lexer.ts's one comparison, one
(`coverage-preprocess.ts`) behind an unannotated `.push`, and `diagnostics.ts` self-compiles.
Stage-1's own blocker is a missing host builtin and depends on none of them.

---
### Re-measured after `trimEnd` and the LEXER'S DEAD GUARD — and one of the three was NOT a compiler gap

Three small blockers were taken together. Two cleared; the third did not, and *why* it does
not is the more useful result.

| module | before | after |
|---|---|---|
| `ast.ts` | `NT1002` — `String.prototype.trimEnd`, own | **`NT2001`** — a `string`/`undefined` ternary at 244:22, own |
| `lexer.ts` | `NT2001` — "Cannot compare string with undefined", own | **`NT1004`** — a `throw` outside a `try` at 202:5, own |
| `parser.ts`, `modules.ts` | `NT2001` — lexer.ts's, linked | **`NT2001`** — **ast.ts's**, linked |
| `coverage-preprocess.ts` | `NT1606` — `.push`, own | **unchanged** — see below |
| every other module | — | **unchanged**; `diagnostics.ts` holds rung 3 |

**`lexer.ts`'s `NT2001` was a source defect wearing a checker gap's clothes.** The line is

```ts
const radix = source[st.i + 1];
if (c === "0" && radix !== undefined && "xXbBoO".includes(radix)) {
```

which is correct TypeScript *only* because `tsconfig.json` sets `noUncheckedIndexedAccess`,
making `source[i]` a `string | undefined`. nativets cannot agree, and the disagreement is
deliberate rather than missing: **a string index that is out of range PANICS** (the Stage 41
bounds rule), so the element type is `string` and the `!== undefined` arm is unreachable. The
guard was not merely dead — at end-of-file the panic fires *one line before* it could have
helped. `.at` is the spelling that means "may be absent" in both toolchains: identical to `[]`
under bun for every non-negative index, and a real `?Ustring` here, which `!== undefined`
narrows and `.includes` then accepts. **The checker needed no change**; tsc rejects
`string === undefined` too (TS2367).

Worth generalizing, because this shape is all over `src/`: wherever the compiler's own source
reads one character ahead, `[]` and `.at` are the same under bun and *very* different here.

**`coverage-preprocess.ts` does NOT clear, and the blocking shape is `NT1607`.** All four of
its `.push` receivers were annotated in a scratch tree and all four cleared the checker — but
`tokenize`'s `toks` is captured by

```ts
const push = (t: Tok) => { toks.push(t); st.prev = t; };   // 10 call sites
```

which is precisely the closure-capture refusal the accumulator opt-in kept (`docs/decorators.md`).
It is masked today only by **pipeline stage order**: `NT1606`/`NT1607` for `.push` are
*checker*-stage, the capture rule is *ownership*-stage, so every checker blocker in the file
surfaces first. Probed by clearing them in a scratch tree, the file is **at least four blockers
deep** — `.push` ×4, then `Set.add` ×3 (a `Set` is persistent; the result is discarded), then an
`NT2001` on `&&` operands, with `NT1607` still waiting behind those. Annotating only the three
uncaptured accumulators would move the module's recorded blocker without unblocking it, so it
was **deliberately not landed** — the same call the nullable-element lane made about rewriting
two of five table sites.

`tokenize` clears only by removing the closure (inlining it at 10 call sites, or making
`st.prev` derivable so the arrow is unnecessary), which is a tokenizer refactor and an owner
decision, not a two-line change.

> **SUPERSEDED — that refactor was taken, and the sizing above is the part that held.** Both
> options named here turned out to be the SAME option: `st.prev` is derivable (it is only ever
> asked for a predicate, so it became one boolean) and that is what makes inlining the arrow
> possible at all. `NT1607` never surfaced, because removing the capture is the precondition for
> the opt-in rather than a step behind it, and the blocker that WAS behind the chain — `NT1605`
> — is not in this list. See “THE SECOND MODULE SELF-COMPILES” below.

**No second module reached IR, and `ast.ts` was probed one deeper before that was recorded** —
behind its ternary is `NT1001`, `.find` on an object array, which is an aliasing refusal rather
than a small gap. `diagnostics.ts` remains the only rung-3 module.

The tree-wide code set stays at **four** — `NT1004`, `NT1014`, `NT1606`, `NT2001` — with
`NT1002` out and `NT1004` in. Note what that set cannot show: `NT2001` did not move, it changed
**owner** (lexer.ts → ast.ts) and its two dependents now inherit from a different module. A
per-module, message-keyed ratchet sees that; a tree-wide code set structurally cannot.

**PRE-EXISTING BUG, found on the way, and it is a SILENT WRONG ANSWER.**

```
" x ".trim()   node "x"   nativets " x "   exit 0 on BOTH
```

`js_str_trim` matched only space/tab/LF/CR, so **21 of the 25** code points in ECMAScript's
WhiteSpace + LineTerminator went through a trim untouched — no diagnostic, no crash, just the
input back. It predates this lane by the whole string batch and was invisible because every
existing fixture trims ASCII. Fixed with `trimEnd`/`trimStart` rather than after them, since
shipping the siblings with the same four-character set would have planted the identical wrong
answer twice more *and* made `trim` and `trimEnd` disagree with each other.

There is now one predicate (`nt_ws_cp`) behind all three. It is the **second** copy of the set —
`isSpace` in `src/lexer.ts` is the first — and it cannot literally reuse it: `isSpace` is
TypeScript, in the frontend, over UTF-16 code units; this is C, in the runtime, over UTF-8
bytes. They are pinned to each other by driving both over the same table in
`test/trim.test.ts`, which is the only coupling available across that boundary. Cases borrowed
from test262 `String/prototype/trim/15.5.4.20-3-*.js` (one per code point) and
`trim{,End,Start}/u180e.js` — U+180E stopped being `Zs` in Unicode 6.3 and must **survive** a
trim, which is the row a hand-written table gets wrong.

**A test-authoring trap worth recording**, because it produced 38 red rows that were not bugs:
asserting `.length` on a trimmed string measures the deliberate §A.2 divergence (nativets
strings are UTF-8 **bytes**, so `" x".length` is 3 here and 2 in node), not the trim.
test262 asserts the trimmed **value**; so does this now. The trimmed bytes were node-exact all
along.

### Re-measured after the TERNARY JOIN — NT2001 falls from nine modules to one, and the wall behind it is a DIFFERENT KIND of thing

`src/ast.ts:244` — `return isIdentifier(tag) ? tag : undefined;` in `classTag`, whose declared
return type is `string | undefined` — was the first blocker for **nine of the twelve** modules
through the whole-program link. The verdict was **compiler, not source**: TypeScript's rule is that
a conditional expression has the UNION of its branch types, nativets has represented that union
since A2 (`?Ustring`, the two-slot [tag,value] box), and what was missing was only the JOIN, which
was type IDENTITY (`if (a !== b) throw`). The source is ordinary TypeScript and stays as written.

The join is deliberately narrow: a present arm unifies with a NULLISH LITERAL arm
(`undefined`/`null`) and nothing else. `T` joined with `?U T` is a legal TypeScript union too and
stays **refused** — that pair is exactly what `thisNarrowHint` detects, and it carries the
"narrowing does not reach a field of \`this\`" diagnostic; joining it would replace a targeted,
actionable refusal with a return-type mismatch three lines later. Codegen's `ConditionalExpr` also
had to start COERCING its arms: it stored them raw, which for an `undefined` arm emitted
`store ptr 0, ptr %s1` — clang rejects that outright, the same diagnostic-contract failure family
as the try/finally return slot that never coerced.

**Then the eight dependents were walked through six more blockers behind it, one re-measurement at
a time. Only TWO of the seven were compiler gaps; five were the source.** That ratio is the finding:

| # | blocker | verdict |
|---|---|---|
| 1 | `NT2001` the `?:` join | **compiler** — the join now widens (test/ternary-nullable.test.ts) |
| 2 | `NT1001` `.find(…)?.ty` on an object array | source — an INDEX search; the aliasing refusal is by design |
| 3 | `NT1606` `values.add(f.ty)` discarded | source — `values = values.add(…)`; `Set` is persistent |
| 4 | `NT1003` `.map(widenLiteralTys)` | source — an inline arrow; point-free needs a function VALUE |
| 5 | `NT2001` `.indexOf(x, from)` | **compiler** — the 2-argument form did not exist |
| 6 | `NT1606` a `Map` OUT-PARAMETER (`unifyTypeParams`) | source — RETURN the bindings; a persistent Map cannot be an accumulator argument |
| 7 | `NT2001` a poisoned narrowing | **compiler** — see the pre-existing bug below |

| Module | Before | After |
|---|---|---|
| `ast.ts` | `NT2001` — the ternary at 244:22, own | **`NT1011`** — `for-of` over `unknown` at 669, own |
| `parser.ts`, `checker.ts`, `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts`, `modules.ts` | `NT2001` — ast.ts's, linked | **`NT1011`** — ast.ts's, linked |
| `lexer.ts`, `cli.ts`, `coverage-preprocess.ts` | — | **unchanged** |
| `diagnostics.ts` | rung 3 | **rung 3**, IR byte-identical |

Tree-wide, `NT2001` goes from **nine modules to one**: `cli.ts`, whose `process.stdout` never
depended on any of this. Stage-1 remains separable from the grind.

**The wall it stops at is not another gap, and the next lane should size it before starting.**
`src/ast.ts` holds THREE REFLECTIVE walkers over `unknown` — `mapTypesDeep`, the static-field
rewriter, and the declared-name collector — written with `Array.isArray(n)`, `n as Record<string,
unknown>`, `Object.keys(o)` and `o[k] = …` over arbitrary AST nodes. Probed one deeper than the
recorded blocker: behind the `for-of` is `Object.keys expects an object`. That is either a dynamic
`unknown`/`Dyn` object model in the language, or three exhaustive TYPED traversals of the 44 AST
node kinds in the source. It is a design decision, not a burn-down item, and it is the first entry
in this document's frontier tables that is.

**A SECOND PRE-EXISTING BUG, in the module linker, and it is why the attribution table kept
lying.** `ModuleGen.expr` (src/modules.ts) had no case for `NonNullExpr` — the `!` non-null
assertion — nor for `InExpr`, so both fell through to the LITERAL default and **nothing under a
`!` was ever alpha-renamed in a non-entry module**. Correct TypeScript that node runs:

```ts
// tags.ts
export const table: string[] = ["p", "q"];
export function fields(t: string): string[] { return [t + "!"]; }
export function firsts(xs: string[]): string[] { return xs.map((m) => fields(m)[0]!); }
// main.ts
import { firsts } from "./tags.ts";   // NT1003: call to 'fields' — unknown callee
```

`'table' is not defined` for the const, `NT1003 unknown callee` for the call. It was never
arrow-specific. Found at `src/ast.ts:404` (`unionTagValues`), and it is what made seven modules
report an `ast.ts` blocker they did not own. Fixed, with the `default:` arm replaced by an
explicit list of the childless literal kinds plus a `never` binding — so a new `Expr` kind is now
a TYPE error in the renamer instead of a silently missed rename. Regression fixture:
`test/modules/nonnull/`.

**THE PRE-EXISTING BUG THIS LANE FOUND, and it is the one with the widest blast radius.**
`Checker.closureAssigned` is the program-wide set of names assigned inside some function or arrow
body; a name in it is **never narrowed anywhere**, which is TypeScript's rule for a CAPTURED
binding (a closure may run after the proof). The set is keyed by bare NAME, and it took *every*
assignment inside *every* function body — including assignments to bindings that function
**declares itself**. Eight lines, and node runs them:

```ts
function use(s: string): number { return s.length; }
function f(xs: string[]): number {
  const a = xs.at(0);
  if (a !== undefined) return use(a);   // NT2001: 'use' arg 0 expects string, got ?Ustring
  return -1;
}
function other(): number { let a = 0; a = a + 1; return a; }
console.log(f(["hi"]), other());
```

`other`'s private `a` makes `a` unnarrowable in `f`. It is an over-REFUSAL, never a wrong answer,
which is why it survived — the failure mode is a diagnostic on correct code, and it gets rarer the
shorter your program is. On `src/` it is everywhere: `let a = 0` in **`src/lexer.ts`**'s
`pragmaName` was on its own enough to unnarrow `a` in **`src/ast.ts`**'s `unifyTypeParams`, two
modules away, and that single collision was blocker #7 above. Fixed: an inner function's
assignment counts only if it can actually reach an outer binding, i.e. the name is not one of that
function's parameters or its body's top-level declarations. Tests in `test/narrowing.test.ts`.

**Half of it is still open and is pinned as a refusal rather than left as a surprise.** The
subtraction covers parameters and TOP-LEVEL body declarations only — exact, because a name declared
there cannot be reached from outside by any assignment anywhere in that function. A `let a` in an
inner BLOCK (a `switch` case, say — which is literally `src/checker.ts:2207`) is *not* subtracted
and still poisons the name program-wide. Closing that means resolving each assignment against a
real scope chain instead of matching names, which is a bigger change than this one.

### A SECOND MODULE SELF-COMPILES — and NT1004, the long-flagged WALL, was TWO refusals wearing one code

`NT1004` has sat in this document as a potential wall for a long time, for a good reason: the
compiler's whole error architecture is throw-across-a-call-boundary (`checker.ts` **332**
`throw`s, `parser.ts` 89, `codegen.ts` 18), while the rule demands a `try` **in the same
function**. `src/lexer.ts` was the cheapest possible place to find out what that costs, because
it was the only module whose FIRST blocker was NT1004 and it has only eleven throws.

**Why the rule exists, confirmed at the source.** `codegen.ts`'s `ThrowStmt` lowers a throw as
`br label %<catch>` — a branch inside one LLVM function. There is no unwinder, no `invoke`, no
landingpad, no personality function. So "throw across a call boundary" is a **runtime/codegen
feature, not a checker relaxation**, exactly as suspected. The checker types `throw` fine; the
refusal is codegen's alone.

**What the FFI's cross-boundary error path actually is, and why it does not generalize for free.**
`nt_exc_raise_msg` sets a sticky global (`g_exc_set` / `g_exc_msg`, a `const char *`) in
`runtime/runtime.c`, and `emitExcCheck` polls it INLINE at the call site — thirteen sites, every
one a *runtime* call. It crosses the **C → compiled-frame** boundary, one level, and the check
runs in the same frame as the `catch`. When that frame has no handler it calls `nt_exc_abort()`.
It has never crossed a compiled-function → compiled-function boundary and does not today.

**The finding: the refusal was covering two different programs, and only one needs the unwinder.**
A throw NOBODY can catch needs nothing at all — it is node's uncaught exception (stdout keeps
what it printed, stderr gets the error, exit **1**), which is precisely what `nt_exc_raise_msg`
+ `nt_exc_abort` already do. Two shapes are provably in that class:

- the throw is in **module top-level** (`main`) — nothing calls top-level code;
- the program contains **no `try` at all** — no handler exists in any frame.

Both now compile (`test/uncaught-throw.test.ts`, node-differential on stdout + exit code; the
stderr text is a documented divergence). `src/lexer.ts` has eleven `throw`s and **zero** `try`s,
so all eleven are the second kind.

| module | before | after |
|---|---|---|
| `lexer.ts` | rung 0 — `NT1004`, a `throw` outside a `try` at 202:5, own | **rung 3** — IR, links, runs, and a non-weak DRIVER differential |
| `diagnostics.ts` | rung 3 | **rung 3**, IR byte-identical (the new declare is conditional) |
| every other module | — | **unchanged** — `NT1011`, ast.ts's reflective walker, ten modules |

**NT1004 was lexer.ts's LAST blocker, not its next-to-last** — probed before implementing, with
the lowering stubbed in a scratch tree, and the module went straight to IR. Rungs 1→3 then cost
nothing, the same as `diagnostics.ts`. The non-weak evidence is `test/sh6.test.ts`'s new
`lexer.ts DRIVER`: it tokenizes a small program and prints a per-token digest (type, text,
line, column) plus two decoded escapes — 292 bytes byte-identical to the bun-run module — and
then takes the ERROR path deliberately, `lex("const y = #;")`, where the uncaught `LexError`
stops stdout at the same byte and exits 1 on both sides.

Tree-wide the blocker set drops from `["NT1004","NT1011","NT1606"]` to `["NT1011","NT1606"]`,
and it is the first time a code has left that set by being **split** rather than implemented.

**THE ESTIMATE for the 332 sites, which is what this lane was really for.** Nothing here helps
`checker.ts`: its throws are `throw typeError(…)` / `throw nyi(…)` raised deep in the callee and
caught in `driver.ts`/`cli.ts`, i.e. exactly the cross-frame idiom that is still refused. The
two options both remain open, and both are owner decisions:

1. **Rewrite the 332 sites to a return-based error channel.** Every function on the path from a
   `typeError` to `driver.ts` would return `T | Err` and every call site would test it. That is
   not 332 edits, it is the transitive closure of the frontend's call graph — the checker's
   entire signature surface — and it changes the source `bun` runs. Not viable.
2. **Implement propagation** (NOT unwinding — the sticky flag already exists). A throw with no
   local handler raises and performs a "propagating return"; every user call site polls the flag
   and either branches to a local catch or propagates again. Four things make this a stage, not
   a lane: (a) the propagating return needs the set of **live owned locals at an arbitrary call
   site**, and `ownership.ts` computes drops only per `ReturnStmt` — without it, a leak or a
   double free; (b) `catch (e)`'s type is inferred by scanning the try block's *syntactic*
   throws (`Checker.inferThrowType`), so it would have to become interprocedural, or every
   cross-frame thrown value normalizes to `{message:string}` (the flag carries only a
   `const char *` today); (c) `finally` must run on the propagation path; (d) a "may throw"
   transitive closure is needed or every call site pays a poll and every IR snapshot changes.
   HOF callbacks are inlined, which interacts with all four.

The honest read: the big modules are **not** reachable by relaxing the checker, and they are not
reachable by rewriting either. They need (2).

**PRE-EXISTING BUG, found on the way, and it is a SILENT WRONG ANSWER at exit 0.**

```ts
function f(n: number): void {
  try { switch (n) { case 1: throw new Error("boom"); } } catch (e) { console.log(e); }
}
f(1);        // node: `Error: boom`      nativets: `}@`      exit 0 on BOTH
```

`catch (e)`'s type comes from `Checker.inferThrowType`, which scans the try block for the first
`throw` — and had no `SwitchStmt` case, so the binding kept its `"string"` default while
codegen's `ThrowStmt` stored the Error object pointer into it **raw**, with no coercion and no
check. `console.log(e)` then called `js_print_str` on an object block. It reproduces on `main`
untouched and predates this lane; a `switch` inside a `try` is ordinary TypeScript.

Fixed on both sides, and deliberately differently. The scan now covers `switch` (that program
compiles and matches node). The raw store is now a **refusal** when the thrown type is not the
binding's — which is the backstop that closes the class rather than one missed scan at a time,
and it caught the second shape immediately: two throws of different types in one block, where
`e.message` was reading the first eight bytes of a string as a pointer (exit 255, no output,
where node prints `boom` then `undefined`). See docs/divergences.md. A nested `try` is still
NOT descended into, which is correct — its throws belong to its own `catch`.

### STAGE-1 OWNS NOTHING — both of `cli.ts`'s host surfaces grew, and it rejoined the group

`src/cli.ts` had spent one round as the only module in the tree whose first blocker was its
**own** and was not `.push`: `process.stdout is not supported`. That separability was real —
stage-1 could be worked in parallel with everything else — and it was **two blockers deep, not
one**. Both are now implemented, and cli.ts needed **no source change**:

| # | Construct | Verdict | Why |
|---|---|---|---|
| 1 | `process.stdout.write(ir)` | **implement** | `console.log` is not a substitute: it appends a newline, and `emit`'s output IS the compiler's product |
| 2 | `spawnSync(bin, fwd, { stdio: "inherit" })` | **implement** | the second options shape; `nativets run` must give the compiled program the user's terminal, not a captured buffer |

**Why not rewrite the source, which this document usually prefers.** For (1) the rewrite is
`console.log(ir)`, and it changes the bytes: `sourceToIR` already ends in `\n`, so every `.ll`
this compiler ever emits would carry a spurious blank line. Both sides of the stage-1
differential would *agree* with each other — and both would be wrong against the `nativets emit
x.ts > x.ll` contract every other consumer has. The variant that preserves the bytes
(`ir.endsWith("\n") ? ir.slice(0, -1) : ir`) buys that by depending on an unstated codegen
invariant. For (2) the only capture-mode rewrite loses streaming, loses the child's stdin, and
merges the two streams — `nativets run` of an interactive program stops working. Growing the
host FFI by two entries was cheaper and more honest than either.

Both are small because SH4 already built the road: `js_print_str` (the runtime call
`console.log`'s string arm already makes) is `process.stdout.write`, and the inherited spawn is
the existing `fork`/`execvp`/`waitpid` with the pipes deleted. Two deliberate narrowings, both
recorded in docs/divergences.md:

- `process.stdout.write` is typed **`void`** though node returns a `boolean`. node's answer is
  a runtime fact about pipe backpressure; a constant `true` is a silent wrong answer.
- the inherited spawn returns **`{status:number}`**, a *different result type* from the same
  builtin — node's `stdout`/`stderr` are `null` there, so reading `r.stdout` is a type error
  instead of an empty string claiming the child printed nothing. `spawnMode()` is read from the
  SOURCE by both the checker and codegen, the `planConsoleFormat` discipline.

| Module | Before | After |
|---|---|---|
| `cli.ts` (standalone) | `NT2001` — `process.stdout is not supported` | **`NT1003`** — the unlinked-import artifact, i.e. **no blocker of its own left** |
| `cli.ts` (linked) / stage-1 | `NT2001` — the same | **`NT2001`** — `Ternary branches differ: string vs undefined`, `src/ast.ts:244` |
| every other module | — | **unchanged** |

**Stage-1 did NOT reach IR, and the finding is who owns the next step.** It is `ast.ts`'s
ternary, inherited through the link like the other eleven modules — the ninth construct
stage-1 has stopped on, and the seventh that was somebody else's. Probed one deeper in a
scratch tree (the ternary rewritten as an `if`), the next is `NT1001`, `.find` on
`{key:string,ty:string}[]`, which is also not cli.ts's. So the parallel-lane window this
document opened last round is **closed**: stage-1 is back to being a function of the tree.

`test/sh6.test.ts`'s `blame` column for `cli.ts` moves `self` → `ast.ts` for that reason, and
its STAGE1 row now names the ternary. The one non-weak rung-3 row in the harness still cannot
run: it needs `nativets-1` to exist, and `nativets-1` needs the whole tree.

**PRE-EXISTING BUG, found on the way, and it breaks the diagnostic contract outright.**

```ts
const x = console.log(1);
console.log(x);
```

node prints `1` then `undefined`, exit 0. nativets accepts the program in the checker and then
emits `%x.addr = alloca void`, so **clang** rejects it: `void type only allowed for function
results`. It is the same class as the `coerce` ESCAPES recorded above — a program node runs
that reaches the linker and dies there, with no `NT` code and no hint, which is worse than a
refusal. It reproduces on `main` untouched, applies to every `void`-typed call (`console.log`,
a user `function f(): void`), and is therefore *not* introduced by `process.stdout.write` —
though that builtin inherits it, which is how it was found. Not fixed here: the fix is in the
declaration path in `checker.ts`, which three lanes were live in.

### THE SECOND MODULE SELF-COMPILES — `coverage-preprocess.ts` at rung 3, by REMOVING THE CAPTURE

`src/coverage-preprocess.ts` goes **rung 0 → rung 3** in one lane. It is the second module in the
tree to reach IR after `diagnostics.ts`, and the first to do it with **no compiler change at all** —
every one of the five blockers between it and IR was cleared in the module's own source, with the
old and new `preprocessForCoverage` proved byte-identical over a 495-file corpus.

**The handed-down blocker chain was right about the first three and wrong about the shape of the
rest.** The previous probe (the "does NOT clear, and the blocking shape is `NT1607`" note above)
recorded "at least four blockers deep — `.push` ×4, then `Set.add` ×3, then an `NT2001` on `&&`,
with `NT1607` still waiting behind those". Measured on the real tree by clearing each in turn:

| # | blocker | site | fix |
|---|---|---|---|
| 1 | `NT1606` | `.push` on `toks` / `parts` / `statements` | `//@@mutable` on each binding — **once the capture was gone** |
| 2 | `NT1606` | `erasedNames.add(…)` ×3, result discarded | `erasedNames = erasedNames.add(…)`; a `Set` is persistent |
| 3 | `NT2001` | `group.length && balanced` ×2 (`number && boolean`) | `group.length > 0 && balanced` |
| 4 | `NT1605` | `const t = toks[i]!` ×7 | never bind the element — see below |
| 5 | — | — | **rung 3** |

`NT1607` **never appears**, and that is the correction worth carrying forward: removing the closure
is not a step *behind* the `.push` refusal, it is the **precondition** for the opt-in. And the
blocker that was actually behind the chain — `NT1605`, binding a linear array element to a local —
was not predicted at all. Probing "one deeper" by suppressing a rule in a scratch tree tells you
what the NEXT diagnostic is; it does not tell you what a real fix unmasks, because a real fix
changes the code.

**Removing the capture.** `tokenize`'s accumulator was captured by

```ts
const push = (t: Tok) => { toks.push(t); st.prev = t; };   // 10 call sites
```

which is the closure-capture hole the accumulator opt-in deliberately keeps (`docs/decorators.md`).
Inlining it at the ten sites is most of the work, but the `st.prev` half **cannot be inlined as
written**: a `Tok` cannot live in the array *and* the cursor, because `.push` **consumes** its
argument (`toks.push(t); st.prev = t` is `NT1601` on the second store, and the reverse order is
`NT1601` on the push), and reading it back with `st.prev = toks[toks.length - 1]` is `NT1605`.
Both were measured, not assumed.

The resolution is that `prev` was never wanted as a token. Its only consumer is
`regexAllowed(prev)`, a predicate — so the cursor now carries the **one boolean** that predicate
returns (`TokState.regexOk`), set at each append from the kind and text about to be pushed. That is
the same shape `emit`'s pre-existing `prevVal` already had, and it is what `src/lexer.ts` does when
it reads `tokens[tokens.length - 1]` rather than shadowing it in the cursor.

**`NT1605` is a structural rule, not a nuisance.** `const tk = toks[i]!` is a *move out of the
array*; `toks[i]!.kind`, `isP(toks[i], "{")` and `for (const t of xs)` are all borrows and all
fine. That killed the statement `group: Tok[]`, which was a second array built by copying tokens
out of the first — replaced by an **index window** `[gStart, i)`, which is exact because the group
only ever grew by the token at `i` before advancing `i`. `emit` takes `(toks, from, to)`.

**The correctness bar was observational nullity, and a null diff was not accepted as evidence.**
Old and new `preprocessForCoverage` were run over every `.ts` file in `src/`, `test/` and
`examples/` — **495 files, 2.67 MB** — diffing the full `Preprocessed` (statements, their lines,
`stripped`, `erasedNames`) byte for byte: **0 differences**. Then **41 deliberate mutations** of the
rewritten lines, each re-run against the same corpus:

- **the corpus cannot see 13 of them.** "Regex allowed after a keyword", "…after a
  string/template/regex", "…after a 3-char operator", "…at offset 0", the `do`/`while` split guard
  and the bracket-depth guard all leave the 495-file diff **empty**. The compiler's own tree is
  regex-free by discipline (`test/no-regex.test.ts`) and writes no top-level `do`/`while`, so a
  corpus made of it is blind to exactly the code this lane rewrote most.
- 16 hand-built inputs close all 13. They are now `test/self-host-coverage.test.ts`'s three
  regex-vs-divide tests, asserted as exact emitted text.
- **4 mutants survive both**, and all four are provably equivalent or dead: one is a control
  (`word` vs `word + ""`); `emit`'s `kind === "comment"` skip is unreachable because the caller
  filters comments out before calling it; and the two `|| isP(prev, ";")` alternatives in the split
  guards cannot fire, because a `;` that did not already end the group implies non-zero depth,
  which makes `balanced` false at the very next token. All three predate this lane.

**Rung 3 is recorded WEAK and then earned.** A library prints nothing, so the naive rung-3 match is
empty-vs-empty (caveat 3 in `test/sh6.test.ts`). The non-weak evidence is a second driver
differential alongside `diagnostics.ts`'s: a driver imports the module and preprocesses six inputs
chosen to reach a shebang, an inline `type` specifier, erased `type`/`interface`, a regex beside a
division, a `//@@` pragma, a class, a `do`/`while`, a template substitution, `export default async`,
and radix/exponent/separator numerals — **814 bytes of statement text, byte-identical to `bun run`,
exit 0**.

| Module | Before | After |
|---|---|---|
| `coverage-preprocess.ts` | rung 0 — `NT1606`, `.push`, own | **rung 3** — IR, links, runs; 814-byte driver differential matches bun |
| `diagnostics.ts` | rung 3 | **rung 3**, unchanged |
| every other module | — | **unchanged** |

**`NT1606` is now EMPTY tree-wide as a first blocker** (`test/bootstrap.test.ts`), and empty in the
`coverage` histogram too (`test/self-host-coverage.test.ts`) — the eighth turn of a bucket that has
refilled seven times. Read it narrowly, as those notes ask: the ~205 `.push` sites are still there
and every refused shape is still refused. What changed is that no module's first blocker is one of
them.

**One thing the `coverage` tool now says about ITSELF is an artifact, and it is the fifth of its
kind recorded here.** `coverage src/coverage-preprocess.ts` reports `NT2001 .push expects number,
got {kind,value,line}`. That is the strip talking about the strip: this tool ERASES `interface`
declarations and hands the names back for the erase-to-`number` fallback, so `const toks: Tok[]`
reads as `number[]` and pushing a `Tok` into it is a type error that exists nowhere else. It was
masked while `.push` was refused ahead of argument typing. The real pipeline compiles the same file
to 152,673 bytes of IR and runs it. The `NT1xxx` histogram — the instrument the ratchets read — is
**empty** for this module, because it counts feature blockers and not the type-error band, which is
exactly the confound that design decision exists for.

**PRE-EXISTING BUG — every `NT1606` is reported with NO SOURCE LOCATION.** `mutationError(message,
hint)` in `src/diagnostics.ts` takes no span and passes none, so all 18 call sites in `checker.ts`
produce a diagnostic with no line band:

```ts
function a(): number { return 1; }
function b(): number { return 2; }
function c(): number { const xs: number[] = []; xs.push(1); return xs.length; }
console.log(c());
```

```
error[NT1606]: arrays are immutable: `.push` would mutate the array in place
  = help: build a new array instead: …
```

No `|` band, no line, no caret — on a 442-line file that is a bisect. The ownership-stage refusals
in the same band (`NT1605`, `NT1601`) print a full rustc-style band with the line, and the
`Map`/`Set` variant of `NT1606` three hundred lines earlier in the same file hand-appends `at
412:97` into its message text, so the inconsistency is visible within one function. The fix is
available at the site — `checker.ts` already computes `exprLoc(a)` two lines below the `.push`
throw for its `typeError` — but it is 18 call sites in a shared hot spot, so it is reported rather
than landed here.

### THE THREE REFLECTIVE AST WALKERS ARE GONE — nine modules move, and the wall behind them is ast.ts's own dead guard

`src/ast.ts` held three passes written **reflectively** — `n: unknown`, `Array.isArray(n)`,
a cast to `Record<string, unknown>`, a walk over `Object.keys(o)`, and an `o[k] = …`
write-back. Nine reflection sites over an AST with **48** node kinds. They were the first
blocker for **nine of the twelve** modules, all through the link (`NT1011`, `for-of` over
`unknown`, at `src/ast.ts:669`, with `Object.keys expects an object` behind it), and the
`sh6` row called the choice out explicitly: *a dynamic `unknown` model, or three exhaustive
typed AST traversals*.

**The typed traversal was taken, and it is FACTORED — one walker, not three.** The argument,
because it is not obvious from the shapes: the three passes do genuinely different per-node
work (`mapTypesDeep` rewrites `Ty` fields; `resolveStaticFieldReads` replaces a `MemberExpr`
node with an `Identifier` and reports an assignment; `collectBindingNames` gathers declared
names), but their *recursion* is identical. The one thing that looked like it would force
three switches — the reflective spelling MUTATES a child SLOT (`o[k] = …`), so a shared
`childrenOf` yielding child VALUES would not serve it — dissolves once the child hook is a
**rewrite** rather than a visit: `fe: (e: Expr) => Expr`, with the parent storing what comes
back. That is how a `MemberExpr` becomes an `Identifier` with no reflection and no setters.

So it is `walkExprChildren` / `walkStmtChildren` — **48 cases**, 30 expressions and 18
statements — plus three small per-node bodies. Not 3 × 48.

**The `default:` arm of each binds `never`**, so a kind added to `Expr` or `Stmt` without a
case here does not compile. `collectBindingNames` enumerates the thirteen statement kinds
that bind nothing for the same reason, rather than defaulting: a *new* statement kind that
does bind a name is the failure the reflective spelling could not detect, and it is the same
hazard that let `ModuleGen.expr` silently fall through on `NonNullExpr` — here at 48× the
surface.

**Two things the `Ty` rewrite forced, both order questions.** The reflective walk visited a
node's type-bearing fields *interleaved* with its children, in `Object.keys` (construction)
order — `Param.annot` before `Param.default`, `FuncDecl.returnAnnot` between `params` and
`body`, `ForOfStmt.annot` before `iterable` and `elemTy` after `body`. Hoisting them before
or after the children would reorder the calls to `f`, and `f` may throw (the checker's
belt-and-braces "`#T` survived monomorphization" guard does), so the order is observable in
a diagnostic. The shared walker therefore takes the `Ty` rewrite too and applies it exactly
where the old key order did; the two passes that do not rewrite types pass the identity.
Field order was **measured, not assumed**: a census of `Object.keys` over every node in
1012 real trees says `ty` is the last key on all thirty expression kinds, and names the five
places where a type field precedes a child.

**Two asymmetries in the old `TY_FIELDS` table are preserved on purpose and now documented
in the code**: `FuncDecl.returnTy` and `ForOfStmt.valTy` hold a `Ty` and are NOT rewritten,
while their siblings `ArrowFunction.retTy` and `ForOfStmt.elemTy` are. Both are
checker-resolved types set after the only pass that substitutes type parameters, so nothing
observable depends on them today — but they are a live trap for the next `Ty` rewrite that
runs later.

#### The evidence, and what a null diff is worth

Old and new run over the **parsed**, **checked** and **ownership-analyzed** trees of every
`.ts` file in `src/`, `test/` and `examples/` — 495 files, 371 that parse, 317 that check,
**3830 comparisons** (1012 trees × 3 walkers, plus 794 direct runs of the single-node
`mapTypesDeepExpr` entry point on every real `ArrowFunction`). Compared: the resulting tree AND the exact
sequence of `Ty` callbacks (so a reordering is a difference, not just a different answer),
and for the static-field pass, the name its `onAssign` reports first. **0 differences.**

Running the walkers on parsed trees alone would have been far too weak — `ty`, `elemTy`,
`retTy`, `paramTys`, `captures[].ty`, `drops` and `BlockDrops` are all set by the checker or
the ownership pass and simply do not exist before them.

A null diff proves nothing about code the corpus never reaches, so: **84 mutants** — skip
each of the 48 node kinds in turn, drop each individual field slot, swap two visit orders,
and break each of the three per-node bodies. **81 caught.** Three are provably equivalent
(`BreakStmt`, `ContinueStmt` and `BlockDrops` have no children and no type fields, so
"skip this kind" *is* the identity). And **three survived the 495-file corpus** and needed a
hand-built input, which is the usual finding here:

| Mutant | Why the corpus missed it |
|---|---|
| skip `SequenceExpr` | the comma operator appears only in a `for` update, and never in a file that CHECKS |
| drop `ForOfStmt.annot` | nothing in 495 files writes `for (const x: T of …)` |
| swap `DoWhileStmt` body/test order | the corpus's eleven `do`/`while`s are all in files that do not check, so neither half contributed a callback to reorder |

One five-line fixture (`for (const x: number of xs)`, a `do`/`while` whose body and test both
carry types, and `for (let a = 0, b = 9; …; a++, b--)`) kills all three.

#### PRE-EXISTING BUGS this turned up

1. **`NonNullExpr` was missing its `ty` field** — and four modules were already using it.
   The checker writes it through an `(e as { ty?: Ty })` cast like every other expression's;
   `codegen.ts`, `ownership.ts` and `modules.ts` read it back the same way; it is present on
   82 nodes in this repo's own corpus. It is now declared, which is what let the typed walk
   reach it — the reflective walk always could, and that gap was this rewrite's **only**
   corpus difference before the field was added.

2. **`tsc` has never semantically checked this project, and that is why nobody saw (1).**
   `test/pipeline/*.ts` contain nativets' `|>` operator, which is a *syntax* error to `tsc`
   (`TS1109`) — and `tsc` does not compute semantic diagnostics for a program that has
   syntactic ones. So `bun run tsc --noEmit` reports 16 syntax errors and **zero** of the 87
   real type errors in `src/`. Reproduce, and see them:

   ```sh
   printf '{"extends":"./tsconfig.json","compilerOptions":{"allowImportingTsExtensions":true},"include":["src"]}' > tsconfig.srconly.json
   bunx --package typescript@5.9.2 tsc -p tsconfig.srconly.json
   ```

   Declaring `NonNullExpr.ty` takes that count from **87 to 55** on its own. Most of the
   remainder are benign (`Ty` is a template-literal type, so `t === "Uint8Array"` is
   "no overlap"), but at least two more look real and are not this lane's:
   `codegen.ts:2312` reads `this.consumedAssign`, a field `FnGen` does not have (so it is
   always `undefined`), and `checker.ts:4229` "lacks an ending return statement" on a
   signature that does not include `undefined`.

3. **`exprLoc` has never worked on a `UnaryExpr`.** `src/ast.ts` reads `e.argument` in that
   arm; the field is `operand` (`argument` belongs to `SpreadExpr`/`ReturnStmt`/`ThrowStmt`).
   So it returns `undefined` where the operand has a perfectly good location, and every
   diagnostic built from a unary expression is unlocatable — the exact failure `exprLoc`'s
   own comment says cost a lane an instrumented build. `tsc` flags it as `TS2339` the moment
   the mask in (2) is lifted. Reproduced:

   ```
   parse("const a = 1;\nconsole.log(-(a));\n")  →  exprLoc(unary) === undefined
                                                   exprLoc(unary.operand) === {line:2,col:15}
   ```

   Left unfixed on purpose: it changes diagnostic *spans*, which is a behavioural change with
   its own tests to write, and this lane's bar was observational nullity.

#### Where the nine modules landed

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT1011` — `for-of` over `unknown`, `mapTypesDeep`, 669 | **`NT2001`** — `Cannot compare U<…Stmt…> with undefined`, `src/ast.ts:1093` |
| `parser.ts`, `checker.ts`, `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts`, `modules.ts`, `cli.ts` (linked) | `NT1011` — the same, inherited | **`NT2001`** — the same, inherited |
| `lexer.ts`, `coverage-preprocess.ts`, `diagnostics.ts` | rung 3 (the first three self-compilers) | **unchanged — rung 3, and `diagnostics.ts` emits BYTE-IDENTICAL IR** |

Nine modules moved and none reached IR. Measured AT THE MERGE, so the rung-3 rows are the
three modules main landed in the same round (`lexer.ts` and `coverage-preprocess.ts` joined
`diagnostics.ts`); none of them is affected, and `diagnostics.ts` emits **byte-identical**
IR before and after this change, which is the strongest statement available that it is null.
The tree-wide code set is now **one code**, `NT2001`, held by the other nine.

**What is behind it is `src/ast.ts`'s own dead guard**, and it is the *third* time this
document has recorded that shape:

```ts
const last = list[list.length - 1];
if (last !== undefined && last.kind === "BlockDrops") { … }
```

An out-of-range index PANICS by design (Stage 41), so nativets types that read `Stmt`, and
the guard compares an 18-member general union with `undefined` — no answer exists. It is the
same defect `lexer.ts` held two rounds ago, in the same words, cleared there with `.at`. It
is worse than dead here: on an **empty** list node returns `undefined` and takes the `push`
path, while nativets would panic on the index, so it is a source defect with a **node
divergence** behind it.

Probed one deeper in a scratch tree, so the next lane knows the size: behind it is
**`NT1606`, `o.f = v` on an AST node**. That is not a coincidence and it should be read
carefully — the typed walk writes `e.ty = f(e.ty)` exactly where the reflective walk wrote
`o[k] = f(v)`. **It is the same wall in honest clothing**, and clearing it is a *decision*,
not a gap: either the AST interfaces carry `@@mutable` (which makes ~48 record types
nominally tagged, and the `Ty` encoding has a defect history that argues for caution), or
the walkers stop mutating and return new nodes (which changes node identity for every
consumer). Neither belongs in a lane whose bar was observational nullity.

### Re-measured after the DEAD GUARD — it WAS a node divergence, and `@@mutable`-the-AST is DEAD

The note above deferred two things to the next lane: verify the empty-list divergence, and
decide how the walkers mutate. Both are measured here. Nothing reached IR, and the reason
is worth more than the rung.

**1. The guard was a real node divergence, not just dead code.** Verified against the oracle
before anything was changed:

```ts
const xs: number[] = []; console.log(xs[xs.length - 1]);
node     -> "undefined", exit 0
nativets -> panic: index out of bounds: the length is 0 but the index is -1, exit 255
```

So on an empty list node takes the `push` path and nativets dies. `setBlockDrops` now tests
`list.length > 0` and never forms the index — behaviour-identical under node for every list,
divergence-free under nativets for the empty one. It is pinned under bun by an
**out-of-range-throws Proxy** in `test/block-drops.test.ts`, which is the only way to hold
the rule under the oracle: node's own answer is precisely the one the function must not
depend on, so a plain assertion would be green on the broken spelling. It was RED on
`last !== undefined` (at `src/ast.ts:1092`) and is green on the `length` guard.

Unreachable today from the one caller — `Analyzer.scoped` returns early when the block
declares nothing, and both of its name lists are derived from `list`, so an empty `list`
never gets there — but it is an exported function whose contract diverged, and the
divergence is what put `src/ast.ts` outside the subset it has to compile.

**2. `@@mutable` on the AST interfaces is DEAD, for two independent reasons.** Both measured,
neither predicted:

- **A tag destroys the union.** `@@mutable` is nominal (docs/decorators.md), and a tagged
  member is `A{kind:string,n:number}` where its siblings are `{kind:string,s:string}`. A
  two-member discriminated union is **`NT1009`** with ONE member tagged — and still `NT1009`
  with **both** tagged. `Expr` (30 members) and `Stmt` (18) are exactly such unions, so
  option (a) cannot even be attempted, let alone at 48 declarations.
- **A walker mutates a PARAMETER.** `walkExprChildren(e: Expr, …)` writes `e.ty`, and a
  parameter is a borrow: `function tick(c: Cell) { c.n = 5 }` on a `@@mutable` record is
  **`NT1607`** by design. Tagging would not have helped even if the union survived.

**3. The narrow option (c) collapses INTO (a).** "Only the interfaces whose `ty` is actually
rewritten" sounds much smaller than 48 and is not: `walkExprChildren` ends with a single
`if (e.ty !== undefined) e.ty = ft(e.ty)` that runs for **every** expression kind, leaves
included. Measured write set: all 30 `Expr` members, 13 of the 18 `Stmt` members (all but
`BlockStmt`, `MultiStmt`, `BreakStmt`, `ContinueStmt`, `BlockDrops`), plus `ObjectProperty`,
`Param`, `Declarator`, `SwitchCase` and `Capture`. That is the ~48. There is no smaller
subset to tag.

**4. The census, because a first-blocker row never sizes a construct.** The `.push` lesson
applied to the new bucket — **191 non-`this` `o.f = v` sites across 8 of the 12 modules**:

| Module | `o.f = v` | `this.f = v` |
|---|---|---|
| `checker.ts` | 56 | 1 |
| `ast.ts` | 46 | 0 |
| `parser.ts` | 29 | 37 |
| `modules.ts` | 28 | 0 |
| `codegen.ts` | 13 | 30 |
| `ownership.ts` | 9 | 3 |
| `coverage-preprocess.ts` | 9 | 0 |
| `lexer.ts` | 1 | 0 |
| `driver.ts`, `cli.ts`, `coverage.ts`, `diagnostics.ts` | 0 | 0 / 0 / 0 / 2 |

The 73 `this.f = v` are already covered by `@@mutable class` (Stage 45). Two rows are the
reading: **`coverage-preprocess.ts` holds nine of them and is at rung 3**, so `o.f = v` on an
**owned local** already compiles. What is refused is mutation through a **borrow** — and that
is what every AST pass in this compiler does. The wall is not "objects are immutable", it is
"the passes mutate trees they do not own".

**5. So the recommendation is (b), and it is not sufficient by itself.** Returning new nodes
needs a 48-arm reconstructing switch inside `ast.ts` (≈45 of ast.ts's 46 sites), and the
caller side is smaller than feared — **7 call sites**, of which `parser.ts:2508/2509`,
`parser.ts:853/858`, `parser.ts:2917`, `checker.ts:508` and `modules.ts:620` all rebind a
LOCAL, and `checker.ts:473` passes the identity function and wants to be a pure visitor
rather than a rewrite at all. `collectBindingNames` mutates only as a side effect of sharing
the walker; it should not mutate at all. But (b) clears **45 of 191** tree-wide, and ast.ts's
own chain behind the walkers — probed by neuter-and-re-measure — is at least three deep:

```
setBlockDrops `last.names = names`   NT1606  <- where the tree is now
setBlockDrops `list.push(…)`         NT1606  .push on a PARAMETER; the accumulator opt-in is
                                             on a let/const binding and cannot reach one
`new Map(p.recTypes ?? [])`          NT1014  `recTypes?: [string, Ty][]` is a TUPLE type
a field read off an un-narrowed Expr NT2001  present in every member, still refused
```

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT2001` — union vs `undefined`, `setBlockDrops` | **`NT1606`** — `o.f = v` on an AST node, same function |
| `parser.ts`, `checker.ts`, `codegen.ts`, `coverage.ts`, `ownership.ts`, `driver.ts`, `modules.ts`, `cli.ts` (linked) | `NT2001` — inherited | **`NT1606`** — inherited |
| `lexer.ts`, `coverage-preprocess.ts`, `diagnostics.ts` | rung 3 | **unchanged — rung 3, IR byte-length identical** (163991 / 152673 / 111243) |

Nine modules moved, none reached IR, and the tree-wide code set is again exactly one code.
Four instruments were re-recorded deliberately under the "moved shallower is not
automatically a regression" rule: the blocker stayed at the **same pipeline stage** (`check`),
no module lost IR, and the newly-reported construct was previously **masked**, not handled —
which is the question that rule says separates a correction from a regression.

**One self-inflicted blocker was planted and caught by re-measuring after the final edit**,
which is exactly the rule this document already carries. The first draft declared
`type ExprFn = (e: Expr) => Expr`; an alias whose shape mentions a recursive type is
`NT1030`, so `src/ast.ts` stopped **parsing** — a blocker moving to an earlier pipeline
stage, which the ratchet forbids unconditionally. The function types are spelled inline
instead. A second, subtler one: `const KEEP_TY: TyFn = (t) => t` typechecks and compiles, but
`coverage` strips undecorated type declarations, so in *that tool alone* the arrow's
parameter became uninferable and ast.ts's coverage row changed. Written `(t: Ty): Ty => t`,
it does not.

### THE WALKERS RETURN NEW NODES — 53 of ast.ts's 54 sites cleared, and NONE of the other 145

The previous re-measurement left two things open: how the walkers should stop mutating, and
what the general answer is for the rest of the tree. The first is landed here; the second is
measured and **not** implemented, because it is a language decision.

**What landed.** `walkExprChildren`/`walkStmtChildren` in `src/ast.ts` now RETURN the node the
parent should store instead of assigning into the one they were handed. Every child slot is a
rewrite, statements included, so a statement list is rebuilt (`list.map`) rather than visited.
The three passes follow: `mapTypesDeep`/`mapTypesDeepStmt`/`mapTypesDeepExpr` and
`resolveStaticFieldReads` return the new tree, and `collectBindingNames` stays `void` — it is a
pure visitor that discards the tree it builds on the way.

**Seven caller sites, exactly as sized:** `parser.ts` parseProgram (`body` becomes `let`),
`parser.ts` class lowering (`emitted`/`decorators` become `let`), `parser.ts` generic-arrow
erasure, `checker.ts:508` (`return mapTypesDeepStmt(spec, …) as FuncDecl`), `checker.ts:473`
(kept as the pure visit it always was — its `f` is the identity and only throws), and
`modules.ts:620`. The generic-arrow site needed one extra rewrite: restoring the arrow's own
parameter annotations used to be `arrow.params.forEach((p, i) => { p.annot = own[i] })`, a write
through a `forEach` parameter — i.e. the very construct this change exists to remove. It rebuilds
the parameter list instead.

**RECONSTRUCTION IS EXPRESSIBLE TODAY — measured before writing any of it.** `{ ...e, kind: "K",
f: v }` typechecks, compiles and runs under nativets, **including through a recursive union**
(a 2-member `Num | Neg` with `operand: Expr`, rewritten and printed, answer identical to bun).
Two details are load-bearing and neither is obvious:

- **the tag must be RESTATED in every arm.** A spread does not carry a string-LITERAL type, so
  `{ ...e, ty: … }` on a narrowed member is `NT2001 an object literal … must set 'kind' to one of
  the literals`. Adding `kind: "K"` back is what makes it compile. That is why the leaves and the
  shared fallthrough labels are split into one arm per kind — 30 + 18, not 25.
- **it LEAKS its input.** Drop is shallow, so the old spine is never freed: a 2-node rewrite
  measures `__objLive() === 2`. A pass now allocates a node per node. Not unsound, and not new
  (it is the Phase-C `array/object ELEMENTS` item), but it is a real cost of option (b).

**Evidence.** Old vs new over every parseable `.ts` in `src/`, `test/` and `examples/` at three
tree stages (parsed / checked / ownership-analyzed): **498 files, 375 parse, 322 check, 1019
trees, 3057 comparisons, 0 differences** — comparing the tree AND the exact sequence of `Ty`
callbacks, with a MARKING callback (`t => "#" + t`) rather than the identity, so a skipped
subtree shows up in the tree and not only in the order. Then **48 mutants** (skip each node kind
in turn): **45 caught**; the three survivors are `BreakStmt`, `ContinueStmt` and `BlockDrops`,
which have no children and no type fields, so "skip this kind" *is* the identity. Two of the 48
(`SequenceExpr`, `InExpr`) are invisible to the 498-file corpus and are killed by four
hand-built inputs, the same finding the previous walker lane recorded for `SequenceExpr`.

**A REAL DIFFERENCE the marking callback found, and it is a PRE-EXISTING DEFECT — see below.**

| Module | Before | After |
|---|---|---|
| `ast.ts` non-`this` `o.f = v` sites | 54 | **1** (`setBlockDrops`) |
| `ast.ts` (standalone + linked) | `NT1606` — `o.f = v`, `setBlockDrops` `last.names = names` | **unchanged** |
| the other eight, linked | `NT1606` — inherited | **unchanged** |
| `lexer.ts`, `coverage-preprocess.ts`, `diagnostics.ts` | rung 3 | **unchanged — rung 3, IR byte-length identical** (161959 / 152886 / 111252) |

**No module moved, and the commit says so on purpose.** ast.ts's FIRST blocker was never one of
the 45 walker sites — it is `setBlockDrops`, the one site option (b) cannot reach, because that
function does not rewrite a tree, it appends a marker to a list it was lent. This is option (b)
being *necessary and not sufficient*, exactly as sized.

### THE GENERAL ANSWER — measured, and it is NOT the parameter annotation

**The census, re-run over the AST instead of over `grep`** (`FieldAssign` nodes with
`viaThis === false`, receiver classified by what binds it):

| Receiver | Sites | |
|---|---|---|
| **PARAM** | 120 | a borrow |
| OWNED LOCAL | 53 | compiles today, if the type can be tagged |
| **FOR-OF element** | 20 | a borrow |
| `o.f.g` / `f()` / capture / `this.f` | 6 | a borrow |
| | **199** | of which **146 are through a BORROW** |

Excluding `ast.ts` (which this lane cleared) that is **145**: **93 borrow, 52 owned**. Only
**15** of the 145 write a field that could hold a recursive value — an upper bound, name-based.

**Option (a), an explicit `@@mutable` PARAMETER annotation, does not clear a single one of them,
and the reason is a gate the brief did not name.** The refusal on the AST is `NT1606` from the
**checker**, on the TYPE (`!this.isMutableTy(ot)`) — the ownership pass' `NT1607` is never
reached. Opening the borrow gate is useless while the type gate is shut, and shutting it is
what tagging an AST node would fix. Tagging is blocked twice:

1. **the union.** `parser.ts`'s `discriminatedUnion` requires `classTag(a) === undefined` of every
   arm, so a tagged member makes `Expr`/`Stmt` `NT1009` — re-verified here with one member
   tagged and with both. That clause is ONE line and, removed in a probe, a `@@mutable`
   discriminated union parses, narrows and runs. It is a conservative guard, not a
   representation limit: a tagged object block has the same slots.
2. **recursion + mutability is ALREADY refused, deliberately, and that refusal is the real
   wall.** `//@@mutable interface Neg { operand: Expr }` is `NT1030` —
   *"'@@mutable record Neg' is RECURSIVE — it contains itself, and it can be mutated in place"*.
   The reason is recorded at `recursiveMutableError` and it is not a memory bug: in-place
   mutation of a self-containing value can close a **cycle**, and every walk here assumes a
   tree — `console.log` unfolds to util.inspect's depth limit where node prints
   `[Circular *1]`, and `structuredClone` (which the checker uses to specialize generics) and
   the actor deep-copy have no seen-set. An AST walker writing `e.object = …` is exactly the
   cycle-closing operation.

**SOUNDNESS of mutation through a borrow, stated plainly, because it is better than it looks.**
The question is not "what stops a double free" — nothing had to. Probed by disabling
`checkOwnedReceiver` and running the program:

```ts
//@@mutable type Cell = { n: number; tag: string };
function tick(c: Cell): number { c.n = c.n + 1; return c.n; }
function retag(c: Cell): void { c.tag = "seen-" + c.tag; }
const a: Cell = { n: 1, tag: "a" };  tick(a); tick(a); retag(a);   //  3/seen-a  == bun,  exit 0
```

`__objLive() === 0`. And the storing case — a value the CALLEE owns written into the CALLER's
block, which is the exact use-after-free `.push` once had — is **already handled**: `b.items =
local` MOVES `local`, so a later read of it is `NT1601`. With the read removed, the program is
correct and its live counts (`__objLive() 0`, `__arrLive() 2`) are **byte-identical to the
control that does the same write through an OWNED receiver** — i.e. the pre-existing shallow-drop
leak and nothing more.

So the three obligations are:

- **a borrow never frees** — the callee does not drop a parameter, so the caller still frees
  exactly once. No double free, no use-after-free.
- **the assigned VALUE is consumed** — already true (`FieldAssign` moves its value), and it is
  the rule `.push` needed for the same reason.
- **the OVERWRITTEN value is leaked, not freed** — already true, and required: dropping it would
  free something an alias may hold.

What is lost is **exclusivity**, and it was never claimed: `docs/decorators.md` Decision 3 says
every alias observes the mutation, and "What this proves, and what it does not" already
disclaims `&mut`. The only thing lost that is not already disclaimed is *"mutation has one entry
point"* — a reasoning guarantee, not a memory one. **What is NOT sound is the cycle**, and that
is a separate rule, not a consequence of the borrow.

**RECOMMENDATION (not implemented — this is a language decision):** three pieces, in order,
none of which is the parameter annotation.

1. **Relax `discriminatedUnion`'s `classTag(a) === undefined`** so a tagged member can be a union
   member. One clause; probed green.
2. **Split `@@mutable`-on-a-recursive-record into "may assign a NON-recursive field".** Today the
   whole declaration is refused. Assigning `e.ty`, `s.returnTy`, `last.names` cannot close a
   cycle; assigning `e.object` can. Keeping the recursive slots refused preserves the tree
   invariant `console.log`/`structuredClone`/actor-copy depend on, with no runtime change. Cost:
   at most 15 of the 145 sites stay refused — and `ast.ts`'s 45 recursive-slot writes, which this
   lane already converted to reconstruction, which is the sound way to rewrite a child slot.
3. **Drop the parameter/for-of arm of `NT1607` for a `@@mutable` RECORD** — i.e. make the opt-in
   travel with the (nominal) type, which is where it already lives, rather than requiring a
   second opt-in at each of the 41 distinct (function × receiver) sites that would need one.
   The calling convention stays visible at the call site in the sense the inference objection
   demanded: it is a property of the SIGNATURE's type, not of the body.

Option (b) everywhere was costed and rejected as the general answer: it would turn 93 borrow
sites into return-and-rebind across four modules' pass signatures, and it allocates and leaks a
node per node on every pass. It is right *where the slot is recursive* — which is `ast.ts` — and
wrong as a blanket rule.

**A HIDDEN TERM CONFIRMED, and it is its own lane.** A property read through a recursive-union
FIELD is refused: with `operand: Expr`, `e.operand.kind` is
`NT2001 Property 'kind' does not exist on @Expr`. Passing `e.operand` to a function and
narrowing THERE works, and so does `{ ...e, kind: "Neg", operand: retype(e.operand) }` — so the
walkers are not blocked by it, but `staticExpr`'s `e.object.kind === "Identifier"` is, and so
is most of `checker.ts`. Nothing here works around it.

**Probed one deeper, so the next lane knows the size.** Neutering each blocker in turn in a
scratch tree, `ast.ts`'s chain behind `setBlockDrops` is: `last.names = names` (`NT1606`) →
`list.push(…)` on a PARAMETER (`NT1606`; the accumulator opt-in is on a `let`/`const` binding and
cannot reach one) → `new Map(p.recTypes ?? [])` (`NT1014`, the tuple-entries form — a genuine
feature gap, and the first link in this chain that is not about mutation at all).

### Re-measured after the THREE-PIECE MUTABLE-AST unblock — nine modules move, none reaches IR

The previous re-measurement ended with a RECOMMENDATION of three pieces and the note that it
was "a language decision, not implemented". All three are implemented here, and its own
parenthetical — *"`@@mutable` cannot tag a discriminated-union member and cannot reach a
parameter, so the tag is not the answer"* — turns out to be **wrong on both counts**.

| # | piece | what it was |
|---|---|---|
| 1 | `discriminatedUnion`'s `classTag(a) === undefined` | a guard for CLASS members, **vacuous even for those** |
| 2 | `@@mutable` + recursive, refused whole | split at the FIELD: only a **cycle-capable** one is refused |
| 3 | NT1607's parameter / `for-of` arm | dropped for a `@@mutable` **RECORD** |

**1 — what the union clause was guarding: nothing it still guards.** It dates to SH2 behavior 1
(`82f145b`), when the only carrier of a tag was a class instance. A class field annotation is
parsed with `parseType`, which **widens** a string-literal type; a record field goes through
`parseTypeInner`, which keeps it. So a class instance can never carry the literal-typed
discriminant `unionDiscriminant` demands — probed with the clause removed outright, a two-class
union still fails one step later with *"the shared field(s) kind are not string-literal typed"*.
It is relaxed only for a tag naming a `@@mutable` record, so a class arm keeps its exact message
and no baseline moves for free.

**A gap piece 1 nearly shipped broken, and only a RECURSIVE union shows it.** `hoistTypeDecls`
re-parses each declaration in a **fresh sub-Parser**, which has never seen the `//@@mutable` on
some other declaration in the file. A recursive union is resolved through that hoist, so the
tagged arm was measured against an EMPTY tag set, fell back to the general-union refusal, and
stalled the cycle — `NT1030 recursive type 'Expr' … what is left is not recursion but [NT1009]
general union type 'Num{…} | @Neg'`. A non-recursive union never goes through the hoist and
passed either way. The set is now shared by reference, as `recTypes` already was. This is the
same shape as every other finding in this document: the test that would have caught it is the one
built from the construct the compiler's own source actually contains.

**2 — the cycle rule is REAL, and it is a WRONG ANSWER rather than a hang.** Verified with the
declaration refusal neutered, not taken on faith:

```ts
const a: Node = { n: 1, next: null };
const alias = a;      // an ALIAS — it survives the move the next line performs
a.next = a;           // an OWNED receiver, so nothing refuses it
console.log(alias);
// node:     <ref *1> { n: 1, next: [Circular *1] }
// nativets: Node { n: 1, next: Node { n: 1, next: [Node] } }     exit 0 on BOTH
```

Depth-limited, so no hang. `JSON.stringify` and `structuredClone` of a recursive type are
already refused (`NT1005` / `NT1002`), so `console.log` is the whole exposure. The obvious
spellings are already blocked by the VALUE side (`x.next = y` is `NT1604` for a parameter and a
MOVE for an owned local) — **the alias route defeats both**, which is why a rule was needed
rather than an argument. `test/forward-type-ref.test.ts` carried the opposite claim ("a cycle is
not reachable there today, linearity stops it") and is corrected in place.

The rule: a field is cycle-capable iff the receiver's tag is type-reachable from the field's
type. `Ty` is flat text and a nominal name has exactly two spellings — folded `@Name` and
inline `Name{…}` — so one scan covers every depth, through `{…}`, `[]`, `?N`/`?U`, `U<…>`,
`G<…>` and function types; close over `recTypes` to a fixpoint. Conservative in one direction:
an `@X` absent from `recTypes` reaches everything (cannot decide ⇒ refuse).

**THE CENSUS, which is what decides whether this is a fix or a moved wall.** All 144 non-`this`
`o.f = v` sites, taken from real `FieldAssign` nodes via the compiler's own parser rather than
from `grep`:

| verdict | sites | |
|---|---|---|
| **CLEARED** | **117** | checker 46, modules 27, parser 17, codegen 10, coverage-preprocess 9, ownership 5, lexer 1, coverage 1, ast 1 |
| CYCLE-CAPABLE (refused) | 15 | `body`, `init`, `iterable`, `argument`, `args`, `callee`, `value` — the AST CHILD slots |
| UNDECIDABLE (refused) | 12 | receivers typed as an ANONYMOUS inline object literal (`st.pos`, `state.shadowed`), which have no named declaration for the attribute to attach to |

Excluding ast.ts: **116 of 143, 81%**. The prediction going in was that an AST pass mostly writes
CHILD fields and the share would be small. It is not: the compiler's assignments are
overwhelmingly TYPE AND NAME ANNOTATIONS written onto an already-built node (`ty`, `returnTy`,
`retTy`, `elemTy`, `annot`, `names`, `captures`, `drops`, `narrowed`). Child-slot REWRITING
is what ast.ts's walkers did, and the previous lane already converted those 45 to reconstruction
— so the two halves of this problem have different right answers and each got the one it needed.

Two method notes, since this document is partly a record of measurement mistakes:

- **the first run of this census said 95 of 144 were unclassifiable, and that was a BUG in the
  census, not a finding.** Prose in doc comments ("…type names…", "…interface for…") produced 209
  junk declaration matches, and each junk match brace-scanned forward and **swallowed the real
  declarations after it**. Stripping comments first fixed it. Fourth measurement-that-understates
  recorded here, and the first caught by its own author before it was acted on.
- **the 15 is corroborated by two methods with different blind spots** — the earlier grep-based,
  name-only upper bound in the CONSTRUCT CENSUS section said 15, and this AST-based,
  receiver-specific count says 15. A single number with one derivation is what this project keeps
  getting burned by.

The receiver-specific reading is worth 7 sites over the easy one: `Program.imports:
ImportDecl[]` mentions a record but never reaches `Program`, so it clears; `MemberExpr.object:
Expr` reaches `MemberExpr`, so it does not.

**3 — the parameter arm.** The opt-in is NOMINAL and therefore part of the SIGNATURE, so
`function tick(c: Cell)` announces "may mutate" at the call site — the objection that ruled out
inferring it. Records only (`MutableInfo` grows a `records` set beside the `classes` set that
`mutableTags` merges). An ALIAS receiver, a container element, a call result, a capture and
`p.b.n = 1` all stay refused. The three memory obligations already held — a borrow never frees,
the assigned value is consumed, the overwritten value is leaked not freed — so only EXCLUSIVITY
is given up, which docs/decorators.md Decision 3 already disclaims.

**Where it landed.** `//@@mutable` on `BlockDropsStmt` — one comment, no other source change —
exercises all three pieces at once (a tagged member of the recursive `Stmt` union, a
non-cycle-capable `names: string[]` write, and an element receiver), and `setBlockDrops`'s
`last.names = names` compiles:

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT1606` — `o.f = v`, `setBlockDrops` | **`NT1606` — `.push`**, the next line of the same function |
| the other eight, linked | `NT1606` — `o.f = v`, inherited | **`NT1606` — `.push`**, inherited |
| `lexer.ts`, `diagnostics.ts`, `coverage-preprocess.ts` | rung 3 | **unchanged — rung 3, and all three emit BYTE-IDENTICAL IR** (161740 / 111243 / 152673, diffed against the branch base and equal modulo the interned worktree path) |

**Nine modules moved and none reached IR, and that is the honest headline.** What is behind
`setBlockDrops` is `list.push(…)` on a **PARAMETER** — the accumulator opt-in is on a
`let`/`const` BINDING and cannot reach one — and behind that `new Map(p.recTypes ?? [])`
(`NT1014`, the tuple-entries form). Both were predicted, and neither is this feature: the first
is the array opt-in's equivalent of piece 3 and would need its own decision, the second is a
plain feature gap. Separately, a property read through a recursive-union field
(`Property 'kind' does not exist on @Expr`) still blocks most of `checker.ts`.

So the claim this lane can make is bounded and should not be overstated: **the mutable-AST wall
is down and 81% of the tree's field writes are now expressible, but no new module self-compiles**,
because ast.ts's chain is at least three deep and the next two links belong to other lanes.

The standalone column, which is the one that says whose gap it is, is unchanged for every module
except `ast.ts`: `checker.ts` `NT2001` (a `.set` value shape), `parser.ts` and `modules.ts`
`NT2001` (`Property 'kind' does not exist on number`), `codegen.ts` `NT1012`
(`new DataView`), and `cli.ts` / `coverage.ts` / `driver.ts` / `ownership.ts` the `NT1003`
unlinked-import artifact.

**PRE-EXISTING BUG, found in this lane's blast radius and FIXED.** `console.log` of a
`@@mutable` record printed its TAG:

```
node:      { n: 1 }          nativets:  Cell { n: 1 }          exit 0 on BOTH
```

A record reuses the CLASS tag encoding (that is what makes its mutability nominal) and
`genInspectObject` folds the tag into util.inspect's opening brace — right for a class (node
really does print `Counter { pos: 0 }`) and wrong for a record, which has no constructor to
name. It reproduces on an untouched tree on a plain non-recursive record, and it SCALES with this
lane: tagging the ~48 ast.ts interfaces would have made every `console.log` of an AST node wrong.
`program.mutableRecords` already distinguishes the two carriers. Both sides are asserted in one
test, or the fix reads as a regression to the next reader.

---

### `.push` ON A PARAMETER IS CLEARED — ONE line gated all nine, and they all moved one term

The previous section's predicted next term, measured and closed. The headline is the SIZE of
the thing, not the feature: **the nine remaining modules did not have nine blockers, or even
nine sites of one blocker. They had ONE LINE** — `src/ast.ts`'s

```ts
export function setBlockDrops(list: Stmt[], names: string[]): void { … list.push({ kind: "BlockDrops", names }); }
```

— which every one of them imports. Established by patching `mutationError` to carry the
receiver and the line (it carries neither; see the bug below) and re-running the frontier
instrument: all nine reported `@RECV=Identifier:list @LINE1133`, the same site.

**Which gate fires: the CHECKER, on the RECEIVER — and it is NOT the field case's gate.** The
previous section's finding was `NT1606` from the checker on the TYPE (`isMutableTy`), with
ownership's `NT1607` never reached. Here it is `NT1606` from the checker in
`inferArrayMethod`'s `case "push"`, where `accumulatorName(recv, scope)` returns `null`
because the scope binding for a parameter has no `mutable` flag. Ownership was never reached
either, but for a different reason, and an ownership-side fix would again have cleared
nothing. **Do not generalize "it is the checker" into "it is the same check".**

**The record precedent does NOT transfer, and that decided the lane.** `@@mutable` on a record
works because it tags a NOMINAL type that travels with the signature. An array type is
**structural** (`T[]`): there is no name to tag, and inventing a tagged array encoding would
touch `isArrayTy`/`elemTy`/`makeArrayTy` and every array operation in the tree.

**The census, taken with the compiler's own parser** (walk each module's AST, classify every
`.push` receiver against the enclosing function's parameter set):

| | |
|---|---|
| `.push` calls tree-wide | **210** (162 identifier receivers, 48 `MemberExpr`) |
| on a **PARAMETER** | **9**, in 3 modules — `ast.ts` ×1, `parser.ts` ×3, `checker.ts` ×5 |
| distinct (function, parameter) pairs | **7** |
| actually BLOCKING anything | **1** — `ast.ts`'s `setBlockDrops` |

Eight of the nine are the **out-parameter accumulator** shape (`directBound(stmts, out)`,
`addFact(…, out)`, `applyWrappers(…, emitted, decorators)`): the caller allocates a fresh
array, hands it in, and reads it afterwards. The ninth, the blocking one, is different — an
**in-place AST annotation**, where the array belongs to the tree the pass is walking.

**What was rejected, and why:**

- **CONSUMING the parameter** is simply wrong here. All nine callers read the list after the
  call; `setBlockDrops`'s list *is* the AST that codegen reads next. Consumption is the
  constructor-parameter-property rule and it does not describe this shape.
- **The SOURCE change** was costed and is not cheap for the one site that matters. The list
  belongs to the AST, so there is no local to return into: `scoped(list)` receives it as a
  parameter too, and the outermost caller passes `s.body`, a field. Writing it back would be
  `o.f = v` on a parameter. The only source alternative is to **pre-seed a `BlockDrops` marker
  into every block at parse time**, so `setBlockDrops` only ever does `last.names = names`
  (which already compiles) — that changes every program's AST and every snapshot, to avoid a
  two-line marker. The eight out-parameter sites *could* be rewritten to return, and this
  document's usual verdict would apply — but none of them blocks anything, so rewriting them
  buys nothing measurable today.
- **New lexer syntax** turned out not to be needed, which is what made the language change
  cheap. A previous lane established that `//@@mutable(c)` mid-parameter-list is silently
  ignored, and concluded a per-parameter opt-in would need new lexing. **Measured, that is
  false for the spelling that matters**: the lexer already emits `@@` + `mutable` for a
  `//@@mutable` comment at ANY position, including between parameters. What the earlier lane
  hit was the *argument* form `@@name(x)`, not the position.

**So: a per-parameter marker**, `//@@mutable` on its own line before the parameter. It meets
the record answer's own criterion — it is part of the SIGNATURE, so the calling convention is
visible at the call site — and it is more precise, because it names which parameter grows.
Two call-site rules carry the rest (`NT1607` the marker must travel, `NT1603` iterator
invalidation); the full design, the soundness argument and the imprecision are in
`docs/decorators.md`.

**Where it landed.** Two marked parameters in the whole tree: `setBlockDrops`'s `list` and
`ownership.ts`'s `scoped`'s `list`.

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT1606` — `.push` on `list` | **`NT1014`** — its own `new Map(p.recTypes ?? [])` |
| the other eight, linked | `NT1606` — inherited | **`NT1014`** — inherited |
| stage-1 (`cli.ts` as a compiler) | rung 0, `NT1606` | **rung 0, `NT1014`** |
| `lexer.ts`, `diagnostics.ts`, `coverage-preprocess.ts` | rung 3 | **unchanged — rung 3, IR byte-length identical** (161959 / 111252 / 152886, before and after) |

**Nine modules moved one term and NOT ONE reached IR.** That is the fourth time this document
has recorded it and the sentence does not improve with repetition: the frontier is a
CONJUNCTION. `NT1014` here is the **dynamic** entries-form site the earlier "entries form is
gone from `src/`" section explicitly parked (it needs a real `[K, V]` tuple TYPE, which is why
the `.set`-chain rewrite could not reach it), and behind it is the `@Expr` property read that
blocks most of `checker.ts`. Both have their own lanes.

#### PRE-EXISTING BUGS this turned up

**1 — `NT1606` carries NO source location, and it is the most-hit refusal in the tree.**

```sh
printf 'const xs: number[] = [];\nconsole.log(1);\nxs.push(2);\n' > /tmp/b.ts
bun run src/cli.ts run /tmp/b.ts
# error[NT1606]: arrays are immutable: `.push` would mutate the array in place
#   = help: …
# — no line, no column, no gutter, no receiver name.
```

Every sibling rule renders one (`NT1607` on the same program shape prints
`| 3 | const f = … ^^^ occurs here`). `mutationError(message, hint)` takes no `line` and
builds an `NTError` with no `spans`. On a 5,748-line module with 205 `.push` sites the
diagnostic says only *that* something is refused — locating the ONE blocking site across nine
modules for this lane required patching the compiler and re-running the instrument, which is
exactly the work a diagnostic exists to prevent. **Not fixed here**: threading a location into
`mutationError` changes the rendering of ~12 call sites across three checks, which is a
diagnostics lane, not this one.

**2 — a `//@@name` comment in a non-declaration position is a PARSE ERROR, on valid
TypeScript.** The pragma lexes to real tokens everywhere, so a comment that merely happens to
be positioned in an expression is rejected where node runs the file:

```ts
const x = 1 +
  //@@mutable
  2;
console.log(x);        // node: 3     nativets: error[NT0001] Unexpected token '@@' at 2:3
```

A refusal, not a miscompile, so it does not violate the prime directive — but the message
names a token the user did not write. The design note in `docs/decorators.md` ("only an exact
match counts, so a comment that merely mentions `@@mutable` in prose stays a comment") is about
the comment's BODY and does not cover its POSITION. Not fixed; it wants a decision about which
positions the pragma is meaningful in, which is the same decision the arrow-parameter refusal
above is waiting on.

### `NT1014` IS GONE AGAIN — and the TUPLE TYPE was not built, because the census said not to

The nine modules' shared blocker was `new Map(p.recTypes ?? [])` in `src/ast.ts`, against a
declared `recTypes?: [string, Ty][]`. The brief was to decide between building a real `[K, V]`
tuple `Ty` and changing the source. **The census decided it, and it decided it emphatically.**

`parseTupleType` (src/parser.ts) already models `[T, U]` as `T[]` — the FIRST element's array —
which is why the diagnostic reads `new Map(string[][])` rather than naming a tuple at all. So the
question is not "is the erasure wrong", it is "where is it wrong". Counted by INSTRUMENTING
`parseTupleType` and re-parsing all twelve modules — the compiler's own parser, not a grep, since
a grep cannot tell a tuple type from an array index:

| site | tuple | homogeneous? |
|---|---|---|
| `checker.ts:996`, `:1103`, `:1645` | `[Expr, Expr][]` | yes |
| `parser.ts:1012` | `[Ty, Ty]` | yes |
| `ast.ts:1298` | `[string, Ty][]` | yes (`Ty` IS `string`) |

**Six annotations, three files, every one homogeneous.** The erasure is already the correct
answer for all six, and a real 2-tuple would have bought a new `Ty` spelling — plus a check
against `isArrayTy`/`isObjectTy`/`isFuncTy`/`isNullableTy`/`isUnionTy`/`isTypeRefTy`/`elemTy`/
`objectFields`/`fieldIndex`/`isLinearTy`/`emitDrops`, which this document records going wrong
three separate times — plus a representation, plus contextual reshaping of a mixed array
literal, for ONE site. **Option (b), a named record, was taken:** `Program.recTypes` is
`RecTypeEntry[]` (`{ name: string; ty: Ty }`), which is the shape `objectFields` already returns
and which needs no encoding at all. Five source sites in three files (`ast.ts` ×2 declaration +
`recTypeTable`, `parser.ts` ×1 write, `modules.ts` ×1 read + ×1 write); zero compiler change for
this half. The two `[...map]` writes become explicit loops, which the linker was doing anyway.

A heterogeneous tuple is still refused, and refused SAFELY rather than erased: the erasure is
masked by the array-literal rule, so `const p: [string, number] = ["a", 1]` is `NT2001 array
elements must share a type`. Reject, never miscompile — but the message names the wrong thing.

**One compiler fix was needed behind it, and it is a real gap.** With the record in place all
nine modules moved to `Property 'callee' does not exist on {…}|{…}|…` — `src/ast.ts:1383`:

```ts
if (e.kind === "CallExpr" && e.callee.kind === "MemberExpr") {
```

**A discriminated-union tag test did not narrow across the SHORT CIRCUIT of `&&`/`||` at all**,
on a plain non-recursive union. It is not the same mechanism as the nullish narrowing that
already crossed a short circuit (landed with the `||` lane): a nullish fact is a `NarrowFact` on
the `narrowStack`, while a tag narrowing is a **shadow BINDING** declared in a child scope
(`Checker.narrowInto`), so `withFacts` could never have carried it. `Checker.narrowTagsInto`
now walks the guard with the same De Morgan rule `guardFacts` uses — `&&` proves both operands
when true, `||` proves both when false — and applies the narrowings SEQUENTIALLY through one
child scope, which is what makes a chain (`s.kind === "circle" && s.radius > 1 && s.radius < 100`)
work and makes a contradictory chain collapse safely instead of re-narrowing from the full union.
Three call sites share it: the right operand of a short circuit, the two arms of an `if`, and
`eliminateAfterEarlyExit`, so `if (s.kind === "a" || s.kind === "b") return …;` now leaves the
third member behind for the rest of the block.

Fixture: `test/unions/narrow-shortcircuit.ts`, shapes borrowed from `microsoft/TypeScript`
`tests/cases/conformance/controlFlow/controlFlowBinary{And,Or}Expression.ts`. Memory: the
narrowing is pure type space and emits no code — `__objLive()`/`__arrLive()` are `0`/`0` over a
200-iteration loop, byte-identical to the nested-`if` CONTROL spelling, exit 0 both ways.

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT1014` — `new Map(p.recTypes ?? [])` | **`NT2001`** — `Property 'kind' does not exist on @Expr` |
| the other eight, linked | `NT1014` — inherited | **`NT2001`** — inherited |
| stage-1 (`cli.ts` as a compiler) | rung 0, `NT1014` | **rung 0, `NT2001`** |
| `lexer.ts`, `diagnostics.ts`, `coverage-preprocess.ts` | rung 3 | **unchanged — rung 3, IR byte-length identical** (161667 / 111240 / 152602) |

**Nine modules moved one term and NOT ONE reached IR** — the fifth time this document records
it. The term they landed on is the one the brief predicted: `e.callee` is typed `@Expr`, the
folded back-edge, and a `@Expr` unfolds for an ordinary field read but not for the discriminant
read a narrowing needs. That is the `@Expr` lane.

#### PRE-EXISTING BUG this turned up

**`parseTupleType` erases `[T, U]` to `T[]` with no diagnostic**, so a tuple's SECOND element
type is silently discarded. It is safe today only by accident — the array-literal rule catches
the mixed case first — and the accident does not cover every position:

```ts
function pair(): [string, number] { return ["a", 1]; }   // node: fine
// nativets: error[NT2001] array elements must share a type (got string, number)
```

The message names the array-literal rule, not the tuple, and points at the wrong thing. A
homogeneous tuple is accepted with its ARITY erased too — tsc rejects an out-of-range tuple
index outright (TS2493), nativets does not:

```ts
function f(p: [number, number]): number { return p[5]; }
console.log(f([1, 2]));
// node: undefined     tsc: TS2493     nativets: compiles, then panics at 1:51
```

(A `const` initialized with a literal is caught by the ordinary bounds check — `NT2002` — so the
gap only shows where the length has to come from the ANNOTATION, i.e. exactly where a tuple type
is the only thing that knows it.) This is also what made
`recTypes?: [string, Ty][]` read as `string[][]` and produce an `NT1014` that named `new Map`
rather than the tuple that caused it. **Not fixed** — the honest fix is `NT1xxx` on any tuple
annotation whose elements are not all the same type (and a hint naming the record spelling),
which is a diagnostics decision touching a construct with six sites in `src/` and an unknown
number in `test/`; it wants its own lane, and this lane's whole finding is that the tuple TYPE
itself should not be built.

---

### THE `@Expr` PROPERTY READ IS CLEARED — the unfold was missing from the one place a value's type is PRODUCED

The last known term in the chain, and it was exactly what the brief predicted: a **missing
unfold**, not a representation problem.

`ast.ts`'s `@Name` block already stated the invariant — *"`@Name` appears only NESTED inside a
shape (a field type, an element type). A value's own static type is always the expanded shape …
the reference is unfolded on demand — exactly when a field carrying one is read."* The encoding
shipped with that promise kept everywhere a shape is **consumed** (`assignable`, `reshapable`,
`retypeLiteral`, the three deep walks) and **nowhere it is produced**. So the declared field type
`CallExpr.callee: @Expr` came straight back out of `Checker.infer` as the value's own type, and
`@Expr` matches none of the structural predicates: `NT2001 Property 'kind' does not exist on
@Expr`.

**Where it landed: two funnels and four predicates.**

| # | site | what it was |
|---|---|---|
| 1 | `Checker.type` (`checker.ts`) | the ONE place an expression's type is produced — unfold there |
| 2 | `CodeGen.genExpr` (`codegen.ts`) | its codegen twin, so the two never see different types for one value |
| 3 | `arrayElementOk` | a slot predicate that had no `@N` arm — `args: Expr[]` was `NT1001 arrays of @Expr` |
| 4 | `fieldOnBase` / `indexResultTy` / the `ForOfStmt` element binding | receivers that arrive as `baseTy("?U@N")` or `elemTy("@N[]")`, i.e. NOT through `type()` |

**Why the FUNNEL and not the member access.** Unfolding only at a receiver would have left
`const o = e.operand` bound at `@Expr` — and a tag narrowing is not a fact, it is a **constant
shadow BINDING** whose type `restrictUnion` computes from a real union (the same distinction the
short-circuit lane recorded one section up). The narrowing would not have attached and `o.value`
would be refused one line later with a *different* message for the same gap. Unfolding where a
value's type is produced makes the binding an ordinary union, and every downstream pass —
narrowing, `switch`, drops, codegen's layout — is unchanged. The `ForOfStmt` element binding is
the proof: it is declared directly from `elemTy` rather than through `type()`, so it kept the
folded spelling and a `for (const a of call.args)` loop would not narrow while the identical
non-recursive loop did.

**The termination argument, explicitly.** `expandTypeRef` replaces a bare `@N` with `N`'s shape
and is the identity on everything else, *including a type that merely CONTAINS a reference*. A
shape's own recursive positions stay folded — the parser mints a back-edge exactly there — so the
result is either concrete or another `@N` one access deeper. There is no fixpoint, no transitive
expansion, and no `seen` set: each unfold is paid for by a real source-level access and a program
has finitely many. (`assignable` is the one place that DOES need the coinductive `assumed` set,
because it descends into two shapes at once; that was already there.)

**The encoding trap, checked.** `isArrayTy`, `isObjectTy`, `isFuncTy`, `isNullableTy`,
`isUnionTy`, `isTypeRefTy`, `elemTy`, `objectFields`, `fieldIndex`, `isLinearTy` and `emitDrops`'
selection were each re-read against the change. Nothing moved in the last two: a `@N` and the
union/object it names are both linear and both free through `nt_obj_free`, so the drop sets are
identical before and after — which is also why unfolding is representation-neutral. `fieldIndex`
was the one real hazard and it now REFUSES a folded receiver outright (see the wrong answer
below).

**A second spelling problem, found on the way.** `recTypes` stores the `parseTypeInner` form,
which KEEPS a string-literal field type (a recursive union's discriminant must survive, or
`unionDiscriminant` cannot prove the tag sits at one slot in every member); an ANNOTATION goes
through `parseType`, which widens it. So `interface N { tag: "m"; n: number; next?: N }` declared
one spelling and unfolded the other, and the refusal printed BOTH SIDES IDENTICALLY —
`declared {tag:string,n:number,next:?U@N} but initialized with {tag:string,n:number,next:{…}}` —
because the message applies the same widening. Both `unfold`s now widen; `widenLiteralTys` does
not descend into a `U<…>`, so a recursive union keeps the tags its dispatch reads, and a
literal-typed field is one string slot either way.

| Module | Before | After |
|---|---|---|
| `ast.ts` (standalone + linked) | `NT2001` — `Property 'kind' does not exist on @Expr` | **`NT2001` — `Property 'property' does not exist on U<Expr…> — narrow it first`** |
| the other eight, linked | `NT2001` — `@Expr`, inherited | **`NT2001` — the same, inherited** |
| `lexer.ts`, `diagnostics.ts`, `coverage-preprocess.ts` | rung 3 | **unchanged — rung 3, and all three emit BYTE-IDENTICAL IR** (161886 / 115242 / 152815, `cmp`'d against the branch base in the same worktree) |

**Nine modules moved and none reached IR — the sixth time this document records it.** The wall is
now a term that has nothing to do with recursion: **a tag test does not narrow a DOTTED PATH.**

```ts
if (e.callee.kind === "MemberExpr") e.callee.property   // src/ast.ts:1383, freshArray
// NT2001 Property 'property' does not exist on U<…> — narrow it first
```

Verified NOT recursion-specific — the identical non-recursive program is refused the same way:

```ts
type Inner = { kind: "A"; a: number } | { kind: "B"; b: string };
const o: { name: string; inner: Inner } = { name: "x", inner: { kind: "A", a: 1 } };
if (o.inner.kind === "A") o.inner.a;   // same NT2001, no recursion anywhere
```

Probed one deeper (neuter `freshArray` by binding `const callee = e.callee` first, re-measure):
the next site is `exprLoc`'s `e.left`, the same construct again. **Census, because a
first-blocker row never sizes a construct** — `x.y.kind === "lit"` taken from real `BinaryExpr`
nodes via the compiler's own parser, not from `grep`: **198 sites in five modules** (checker 110,
codegen 47, ownership 25, parser 10, ast 6). That is an upper bound on what needs the feature
(not every one is followed by a read of the narrowed path), and it is the same order as the
`o.f = v` census that decided the mutable-AST question — so the source-side workaround (bind a
local first) is 198 edits across five files, and the compiler-side fix is one feature.

So it is ONE feature held at many sites, and it is a real decision rather than a gap: the nullish half already exists
(`narrowedPath`), a tag narrowing would need to key its shadow binding on the PATH text rather
than a name, and soundness needs the path to be provably stable — which means refusing to narrow
through a `@@mutable` receiver. That is a narrowing lane, not this one, and it should not be
started without agreeing which tests define it.

#### PRE-EXISTING BUGS this turned up

**1 — THE LINKER LEFT MUTUAL BACK-EDGES DANGLING, AND THE COMPILER HUNG.** `rewriteRefs` took a
single `from`/`to` pair — right for a SELF-recursive declaration, wrong for every mutual cycle.
`Call.callee: Expr` and `Expr = Num | Call` are two entries of one SCC, so `Call`'s shape carries
a reference to a SIBLING, which the single-name form left unrenamed and therefore **dangling in
the merged table**. `src/ast.ts` is a 46-declaration cycle imported by every other module of this
compiler, so this was the shape that mattered.

It did not fail loudly. `expandTypeRef` returns an unknown name UNCHANGED (the deliberate "cannot
decide, do not guess" rule), `genInspect` re-enters itself with it, and JSC turns that tail call
into a **loop**: no diagnostic, no exit code, nothing for a differential test to compare. On an
untouched tree:

```ts
// m.ts
export interface A { kind: "A"; b: B }
export interface B { kind: "B"; s: string; a?: A }
// main.ts
import type { A } from "./m.ts";
const a: A = { kind: "A", b: { kind: "B", s: "hello" } };
console.log(a);
// node: <the object>, exit 0.   nativets: HANGS in codegen. Killed at 25s, 120s.
```

Fixed three ways, because the rename had three doors: `rewriteRefs` takes a MAP of every
recursive name the module declares; the module's own AST types go through it (`Renamer`), or a
non-entry module's signatures keep the pre-rename spelling and an argument typed by the
correctly-renamed imported shape is refused against its own callee; and the EXPORTED shape goes
through it, or the importer resolves an `@N` against ITS names. `genInspect` now refuses a `@N`
the table cannot resolve instead of looping, which is what property 2 of the encoding promises.
Gated by `test/modules/rectypes` (differential) plus a structural test that the merged table is
CLOSED — asserted structurally on purpose, since the failure mode of an open table is a hang and
a hang has no output to diff.

**2 — A SILENT WRONG ANSWER through `?.`, created and closed inside this lane.** Clearing the
property read turned an optional chain through a back-edge from a refusal into a wrong answer:
`genOptChain` unboxes with `baseTy(cur.ty)` — the bare `@N` — and hands it to `genFieldRead`,
where `objectFields("@N")` is the empty list, so `fieldType` is `undefined` and `fieldIndex` is a
slot number computed from nothing.

```ts
interface N { n: number; label: string; next?: N }
const a: N = { n: 1, label: "x", next: { n: 2, label: "y" } };
console.log(a.next?.n, a.next?.label);
// node: 2 y      nativets (mid-lane): 0 (null)      exit 0 on BOTH
```

`genOptChain` unfolds, and `genFieldRead` now throws an internal error on a folded receiver so
the NEXT caller that forgets reports itself instead of loading the wrong offset. That is the
`objectFields("@N")` phantom-record trap for the second time in this project; the guard is there
so there is not a third.

**A THIRD refusal moved, and a pinned test asked for it.** `test/mutable-records.test.ts` held
*"an ARRAY of the recursive type never reaches the cycle rule — NT1001 is nearer"*, pinned
explicitly so the lane that implemented `@Node[]` would come back and check that the
cycle-capability rule carried the shape. It does: with `arrayElementOk`'s `@N` arm the nearer
gate is gone and `a.kids = []` on a `@@mutable` recursive record is now
`NT1030 'kids' … is a RECURSIVE field (its type '@Node[]' can contain a Node)` — the right
refusal, naming the array type. The test is rewritten to assert that instead, with its own
history in the comment so the change does not read as a relaxation.

**Memory.** Measured against a CONTROL (the same program with the recursive field flattened to a
structurally identical non-recursive one), not against zero: `__objLive()`/`__arrLive()` are
`3`/`0` vs `3`/`0` for the record shape, `0`/`0` vs `0`/`0` for the union shape, and `2`/`1` vs
`2`/`1` for the array-of-back-edge shape — identical in every pair, and the record shape's
one live block is the pre-existing nullable-field leak this document already records (it
reproduces byte-for-byte on the branch base).

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
  - **Linear, like the record it is** — move-checked (`NT1601`) and dropped once (`nt_obj_free`).
    Consequently `const n = nodes[i]` on a union array is `NT1605`, exactly as for an object
    element (Stage 28); pass it by value instead.
    **The drop is SHALLOW, exactly like every other object's**, so `__objLive() → 0` holds only
    for a member whose fields are all scalars. A member with an object or array field leaks that
    field — `type Sq = { kind: "sq"; inner: { n: number } }` measures `__objLive() === 1`. This is
    not union-specific and is not a union regression: it is the `array/object ELEMENTS` item under
    **Still open** in [`ROADMAP.md`](ROADMAP.md)'s Phase C, inherited unchanged because a union
    *is* the ordinary object machinery. Pinned in `test/drops-obj.test.ts`.
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
  - **FLATTENING (done).** `A | (B | C)` splices the nested union's members into the outer
    member list, and with three or more arms a single `null`/`undefined` arm hoists into the
    existing `?U`/`?N` encoding. Both are what `src/ast.ts`'s `ForStmt.init: VarDecl | Expr |
    null` needs, and neither adds a representation. `A | B | null | undefined` stays refused.
    Tests: `test/unions/flatten-nested.ts` + two refusal-boundary tests in `test/unions.test.ts`.
  - **The four residuals of ast.ts's SCC are CLOSED and `NT1030` is empty tree-wide** — see
    "`NT1030` IS GONE" above, including the two candidate shapes for `ArrowFunction.body`
    that were measured and rejected, and why the boxed `G<…>` was the wrong trade (it is
    missing from `isLinearTy`, so it leaks both box and payload).
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
