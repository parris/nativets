# B1 — Pipeline operator `|>` (test-vector spec)

Research/spec for the nativets pipeline operator (ROADMAP §B1, phase2-design §2).
**No source is modified by this doc** — it is a red-green test-vector plan.

nativets picks **Elixir semantics**: `x |> f(a)` ≡ `f(x, a)` — the left operand is
threaded as the **first** argument of the right-hand call. Pure **parser desugaring**,
no runtime, no new IR:

```
a |> f(b) |> g(c)   ==>   g(f(a, b), c)
```

---

## 1. Precedence & associativity

- **Left-associative.** `a |> f() |> g()` parses as `(a |> f()) |> g()` → `g(f(a))`,
  i.e. a value flows left→right through the chain.
- **Lowest precedence** among the expression operators (looser than arithmetic,
  comparison, bitwise, logical). So the entire LHS expression is evaluated to a single
  value, then piped:
  - `a + b |> f()`  →  `f(a + b)`  (the `+` binds tighter, groups first)
  - `x * 2 |> g(3)` →  `g(x * 2, 3)`
- **RHS must be a call expression** whose callee is a function (a named function, a
  function-typed variable/param, or the result of a call). The LHS is spliced in as
  argument index 0; any explicitly-written args shift right by one. If the RHS is not a
  call (`x |> y`, `x |> obj.field`), reject with a diagnostic rather than guessing.
  - **Bare-identifier RHS** (`x |> f`, Elixir-legal ≡ `f(x)`): recommend requiring the
    call form `f()` in v1 for a single, uniform desugar rule; optionally treat a bare
    identifier as a zero-extra-arg call. Pick one and note it in `docs/divergences.md`.
  - **Member-callee RHS** (`x |> obj.m(a)` → `obj.m(x, a)`): out of scope for v1 — our
    calls target named functions / function values. Reject member-expression callees for
    now (a follow-up once methods are first-class).
- Because `|>` binds looser than everything arithmetic, a pipe result used inside a larger
  arithmetic expression needs parens: write `(4 |> dbl()) + 1`, not `4 |> dbl() + 1`
  (the latter would try to pipe into the non-call `dbl() + 1`).

Note: Elixir's real table places `|>` *above* comparison operators; nativets simplifies to
"looser than arithmetic and comparison" (design-doc "lowest precedence"). For the LHS
grouping every fixture here relies on (`a + b |> f`), both rules agree, so the
simplification is invisible to these vectors.

---

## 2. Testing strategy (node can't run `|>`)

`node` has no `|>`, so it cannot be the direct oracle for a `.ts` file that uses it. Each
behavior therefore ships **as a twin pair**:

- **`case.ts`** — the intended program written with `|>`. Compiled + run by **nativets**.
- **`case.twin.ts`** — the byte-identical program with every `|>` hand-desugared to the
  equivalent nested call. Runnable by **plain `node`** (the oracle) and also by nativets.

The gate is:

```
nativets(case.ts).stdout  ==  node(case.twin.ts).stdout   # |> lowers to the nested form
nativets(case.twin.ts)    ==  node(case.twin.ts)          # sanity: twin itself is correct
```

Equivalently, an IR-level check: `codegen(case.ts) == codegen(case.twin.ts)` (the desugar
must produce the identical AST as the hand-written nested form). The stdout differential is
the primary gate; the IR-equality check is an optional stronger assertion.

Below, each behavior lists the **`|>` form**, its **equivalent nested (node-runnable)
form**, and the **expected stdout**. In fixtures the shared helper functions live at the
top of both twin files unchanged; only the piped expression differs.

---

## 3. Behaviors (ordered)

### B1-1 — Single pipe, arity-1 callee (`x |> f()`)
```ts
function inc(n: number): number { return n + 1; }

// |>   :  const r = 5 |> inc();
const r = inc(5);
console.log(r);
```
Expected stdout:
```
6
```

### B1-2 — Pipe with an extra arg (`x |> f(a)` ≡ `f(x, a)`)
```ts
function add(a: number, b: number): number { return a + b; }

// |>   :  const r = 3 |> add(4);
const r = add(3, 4);
console.log(r);
```
Expected stdout:
```
7
```

### B1-3 — First-arg position is observable (order matters)
Proves the LHS lands in slot 0, not last — a non-commutative op makes it visible.
```ts
function sub(a: number, b: number): number { return a - b; }

// |>   :  const r = 10 |> sub(3);   // sub(10, 3), NOT sub(3, 10)
const r = sub(10, 3);
console.log(r);
```
Expected stdout:
```
7
```
(A last-arg design would print `-7`. This vector pins first-arg semantics.)

### B1-4 — Chained pipes with extra args (`a |> f(b) |> g(c)`)
```ts
function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }

// |>   :  const r = 2 |> add(3) |> mul(4);   // mul(add(2, 3), 4)
const r = mul(add(2, 3), 4);
console.log(r);
```
Expected stdout:
```
20
```

### B1-5 — Left-associativity, three unary stages
```ts
function inc(n: number): number { return n + 1; }
function dbl(n: number): number { return n * 2; }
function neg(n: number): number { return -n; }

// |>   :  const r = 1 |> inc() |> dbl() |> neg();   // neg(dbl(inc(1)))
const r = neg(dbl(inc(1)));
console.log(r);
```
Expected stdout:
```
-4
```

### B1-6 — Precedence vs arithmetic on the LHS (`a + b |> f`)
The LHS arithmetic groups first because `+` binds tighter than `|>`.
```ts
function half(n: number): number { return n / 2; }

// |>   :  const r = 10 + 6 |> half();   // half(16), i.e. half(10 + 6)
const r = half(10 + 6);
console.log(r);
```
Expected stdout:
```
8
```

### B1-7 — Pipe result reused in a larger expression (parens required)
```ts
function dbl(n: number): number { return n * 2; }

// |>   :  const r = (4 |> dbl()) + 1;   // dbl(4) + 1
const r = dbl(4) + 1;
console.log(r);
```
Expected stdout:
```
9
```

### B1-8 — Pipe into HOF-backed functions (arrays through `map`/`reduce`)
Threads a heap value (array) through a chain; exercises the operator over non-scalars and
callees that themselves use array HOF.
```ts
function scale(xs: number[], k: number): number[] { return xs.map((x) => x * k); }
function sumAll(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }

// |>   :  const r = [1, 2, 3] |> scale(10) |> sumAll();
//         sumAll(scale([1, 2, 3], 10)) = sumAll([10, 20, 30])
const r = sumAll(scale([1, 2, 3], 10));
console.log(r);
```
Expected stdout:
```
60
```

### B1-9 — Pipe over strings, result reused across statements
```ts
function greet(name: string): string { return "hi " + name; }
function shout(s: string): string { return s + "!"; }

// |>   :  const m = "sam" |> greet() |> shout();
const m = shout(greet("sam"));
console.log(m);
```
Expected stdout:
```
hi sam!
```

### B1-10 — Extra args may be arbitrary expressions / captured vars
The piped value is slot 0; the written arg is evaluated normally in slot 1.
```ts
function add(a: number, b: number): number { return a + b; }
const k = 100;

// |>   :  const r = 5 |> add(k * 2);   // add(5, k * 2) = add(5, 200)
const r = add(5, k * 2);
console.log(r);
```
Expected stdout:
```
205
```

### B1-11 — Pipe into a function-typed value (first-class callee)
The callee is a variable holding a function, not a top-level name — confirms the desugar
targets whatever the RHS callee evaluates to (indirect call), not only named functions.
```ts
const triple = (n: number): number => n * 3;

// |>   :  const r = 7 |> triple();
const r = triple(7);
console.log(r);
```
Expected stdout:
```
21
```

---

## 4. Divergence from TC39 (record in `docs/divergences.md`)

There are three incompatible "pipe" designs. nativets deliberately chooses **Elixir**, not
the TC39 direction:

| Style | Form | Meaning | Threads LHS |
|-------|------|---------|-------------|
| **Elixir (nativets)** | `x \|> f(a)` | `f(x, a)` | implicit, **first arg**, RHS must be a call |
| **Hack (TC39 current)** | `x \|> f(%, a)` | `f(x, a)` | explicit **topic `%`** placeholder; RHS is any expression, value goes wherever `%` is |
| **F# (TC39, twice rejected)** | `x \|> f` | `f(x)` | tacit unary application; to add args, `x \|> (y => f(y, a))` |

**What this means for nativets:**

- The current **TC39 proposal is Hack-style** with a lexically-scoped, immutable **topic
  reference token** (drafted as `%`, possibly `^` — not finalized). nativets has **no topic
  token**: `x |> f(%, a)` is not nativets syntax and must be rejected.
- nativets threads the value into **argument 0 only** — it cannot place the value in a
  later position, into a non-call expression, or into multiple positions. Those all require
  the Hack topic and are intentionally unsupported.
- nativets is **not F#-style** either: `x |> f` (tacit, no parens) is not the primary form;
  extra call args are threaded automatically rather than requiring an explicit lambda.
- **Forward-compat caveat:** if a Hack-style `|>` ever lands in standard JS/TS, nativets's
  `|>` will **diverge from conforming TS** (same token, different lowering). This breaks the
  "match `node` byte-for-byte" prime directive for any program using `|>`, so it MUST be
  logged as a deliberate divergence in `docs/divergences.md`. (Today node rejects `|>`
  outright, so there is no oracle conflict yet — the twin-file strategy in §2 is exactly
  how we keep a defined oracle in the meantime.)
