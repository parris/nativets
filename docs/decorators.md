# Decorators — two sigils, two mechanisms

nativets has **two** decorator forms, and they are not variations on one feature. They are
different mechanisms with different costs, and the sigil tells you which one you are looking at.

| Sigil | What it is | Runtime footprint | Applies to |
|---|---|---|---|
| `@@name` | a **compile-time attribute** the compiler reads — Rust's `#[derive]` | **none** | a `class`, a record `type`/`interface`, or a `let`/`const` array ACCUMULATOR |
| `//@@name` | the **same attribute**, spelled as a comment (see "Two toolchains" below) | **none** | ditto |
| `@name` | a real **runtime wrapper** — Python's `f = w(f)` | a real call | a `class` or a **method** |

```ts
@@mutable                    // compile-time: changes how the class is CHECKED and COMPILED
class Counter {
  private pos = 0;
  @log bump(): Counter {     // runtime: `log` is an ordinary function that wraps the method
    this.pos++;
    return this;
  }
}
```

An **unknown `@@attribute` is an error** (`NT1023`), never a comment. An attribute changes how
code compiles; silently ignoring a misspelled one would silently change the program's meaning.
The single-`@` form has no such list — the name is just a function you wrote.

---

## The three decisions

### Decision 1 — two sigils, two mechanisms

Already stated above. `@@` is read by the checker and vanishes; `@` produces code.

### Decision 2 — a setter that does not return gets an implicit `return this`

A method that assigns a field but has no `return` gets one inserted:

- for an `@@mutable` class, `this` is the mutated receiver;
- for an ordinary class, `this` is the **new instance** the method just produced.

It is not an error, and it is not `void`. So both of these work, and mean the same thing:

```ts
bump(): Counter { this.pos++; return this; }
bump() { this.pos++; }               // ≡ the above
```

The consequence is that a return-less setter **chains** (`a.bump().bump()`), which is a
divergence from node (where a return-less method is `undefined`). See `docs/divergences.md`.

### Decision 3 — `@@mutable` means TRUE in-place mutation

The object really mutates. Every handle observes it:

```ts
@@mutable
class Counter {
  private pos = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;        // alias
a.bump();
console.log(b.get());   // 1 — b observes the mutation
```

This is the one place in nativets where a value is mutated in place: arrays and objects are
immutable (Stage 29), and an ordinary class is too (below). `@@mutable` is the opt-in.

---

## The ordinary (undecorated) class is copy-on-write

Without `@@mutable`, a field-assigning method **produces a new instance** and leaves the
original alone:

```ts
class Counter {
  private pos = 0;
  bump(): Counter { this.pos++; return this; }   // copy, modify, hand back
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a.bump();
console.log(a.get(), b.get());   // 0 1
```

Lowering: the method gets a prologue that rebinds `this` to a fresh **shallow copy** of the
receiver, so every `this.f = …` in the body writes to the copy and `return this` yields it.
Slots are copied verbatim, which is the same convention every other container follows (a
container frees its handle, never what its slots point at) — a residual leak at worst, never a
double free.

Because the copy is the only observable result, an ordinary setter **may only hand `this` back**.
Returning anything else, or `void`, would throw the copy away, so it is rejected (`NT1023`) with
the two fixes named: write `return this`, or put `@@mutable` on the class.

Before this lane, `this.f = v` in a method was `NT1606`. It now compiles, in both flavors.

---

## Ownership: only the owner may mutate

`@@mutable` reintroduces real mutation into a linear (single-owner, deterministically-dropped)
memory model, so the ownership pass (`src/ownership.ts`) has to keep it single-owner. The rule,
in one line: **only the owner may mutate, and a borrow may never outlive its owner.**

Concretely, three adjustments, all inert in a program with no `@@mutable` class:

1. **`const b = a` is an ALIAS (a borrow), not a move.** That is what makes "every alias observes
   it" expressible at all. Ownership never leaves the original binding, so the value is dropped
   exactly once, by that binding — aliasing can never double-free. A **method call result is an
   alias too** (`const c = a.bump()`), because a `@@mutable` method hands back its receiver.
2. **An alias is a borrow binding**, so consuming it — returning it, `move(b)`, storing it into an
   array/object — is the existing **`NT1604`** (≈ rustc E0507). It can never escape past its owner.
   Consuming a method *result* is `NT1604` for the same reason.
3. **A setter needs an OWNED receiver** (Rust's `&mut self`). Calling one through anything the
   pass cannot prove we own is **`NT1607`** (≈ rustc E0596):
   - an alias (`const b = a; b.bump()`),
   - a **parameter** — parameters are borrows, the caller owns them (`function tick(c: Counter) { c.bump(); }`),
   - a `for-of` element,
   - a **container element** (`items[0].bump()`), a **callback parameter**, a **capture** — any
     receiver that is not a binding whose ownership this scope can establish.

   The receiver is resolved through a method chain, so `a.bump().bump()` is still `a`.

   **One receiver is not a binding and is owned anyway: a fresh `new C(…)` TEMPORARY.**
   `new Counter().bump().get()` is accepted. Nothing in this scope — or any other — can
   name the temporary, which makes it strictly *more* uniquely owned than the "local bound
   to `new C(…)`" the NT1607 hint asks for, so exclusive access holds by construction. This
   is the same fact commit `1ea7fa2` used to keep `.push` refused ("a syntactically-fresh
   receiver is a temporary nothing can name"), with the sign flipped: there it made the
   rule vacuous, here it makes the call safe. Rule 2 is untouched — a fresh chain's *result*
   still may not escape (`return new C().bump()`, `[new C().bump()]`, `move(…)` are all
   `NT1604`), because a method still hands back a borrow and there is no owning binding to
   return instead. A fresh receiver is subject to the pre-existing unbound-temporary leak:
   the object is never dropped, exactly as for an ordinary class's `new P(7).get()`.
4. **Reassigning an aliased owner is `NT1602`** (≈ rustc E0506): `let b = a; a = new C();` would
   free the old value out from under `b`.

Reading through any handle is always fine. `a.bump(); b.get()` is the canonical accepted program.

### What this proves, and what it does not

**Proves** (this is the whole point of the lane, stated plainly):

- **No double free and no use-after-free from aliasing.** Exactly one binding owns a `@@mutable`
  instance; every other handle is a non-owning borrow that is never dropped, cannot escape the
  owner's scope, and cannot outlive it by reassignment. Verified with `__objLive()` → 0.
- **Mutation has one entry point.** Only the owning binding can invoke a setter, so a mutation is
  always attributable to a name in the current scope.

**Does not prove:**

- **This is not full `&mut` exclusivity.** The owner may mutate while an alias is live and the
  alias will then observe it — that is the *specified* behaviour (Decision 3), not an accident.
  Rust would reject that program (E0502); we accept it deliberately, because "every alias observes
  the mutation" is the feature. What we refuse is mutation through a handle whose lifetime we
  cannot bound, which is the part that is a *memory* question rather than a *reasoning* question.
- **Nothing about concurrency.** nativets' actors are isolated (a structured message is
  deep-copied on send), and the scheduler is cooperative and single-threaded, so there are no data
  races to prove absent. An M:N runtime would need this revisited.
- **The `setterProps` check is name-based**, so a *non*-`@@mutable` class with a method whose name
  matches some `@@mutable` class's setter can be over-refused when its receiver is a container
  element or a callback parameter. Over-refusal, never miscompilation.
- **Aliases are scope-wide**, not lifetime-precise: there is no NLL-style "the borrow ended
  early". An alias borrows for the rest of the function.

---

# EXTENSION — `//@@name` and `@@mutable` on records

> **Both sections below are an EXTENSION of the design above, not part of what was
> specified.** The owner asked for `@@mutable` on **classes**; the pragma spelling and
> record support were added by the mutable-records lane because the compiler's own source
> needs them (see `docs/self-hosting.md`). They are additive — every program written
> against the spec above behaves identically — and can be vetoed without touching it.

## Two toolchains, one source: `//@@mutable`

`@@mutable` is **not valid TypeScript**. For an ordinary program that is fine: nativets is the
only thing that ever reads it. But there is one program that must satisfy **two toolchains at
once** — nativets' own source, which `bun` runs *today* and nativets must compile *tomorrow*. A
file carrying the bare sigil cannot be run by bun at all, so `src/parser.ts` could not say that
`class Parser` is mutable.

So the attribute has a second spelling: **a line comment whose entire content is `@@name`**.

```ts
//@@mutable
class Parser { private pos = 0; /* … */ }
```

The lexer turns `//@@mutable` into exactly the two tokens the bare sigil produces (`@@`, `mutable`),
so everything downstream — the parser, the checker, the ownership pass — is untouched, and the two
spellings emit **byte-identical IR** (pinned in `test/mutable-records.test.ts`). To TypeScript it is
a comment; to nativets it is the attribute.

Three deliberate details:

- **Only an exact match counts.** The comment body must be `@@name` and nothing else, so a comment
  that merely *mentions* `@@mutable` in prose stays a comment.
- **An unknown pragma is still `NT1023`.** The comment spelling changes the syntax, not the rule:
  `//@@mutabel` is an error, not an ignored comment, for the same reason `@@mutabel` is.
- **node stays the oracle, with no stripping at all.** A pragma source is *already* valid TS, so its
  oracle is `runWithNode` directly — better than the sigil form, which needs `stripAttributes`.

This is the general answer for every future `@@attribute`, not a one-off for `@@mutable`.

## `@@mutable` on a record `type` / `interface`

```ts
@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = 41;
c.n++;          // and compound assignment, and `+=`
```

An undecorated record is unchanged: `o.f = v` is still `NT1606` pointing at `{ ...o, f: v }`.

### Mutability is NOMINAL, carried by a TAG

A `@@mutable` record type is compiled to the **tagged** object type `Cell{n:number}` — exactly the
encoding a class instance already uses (`Point{x:number,y:number}`), rather than the untagged
`{n:number}` of a plain record literal. That is the whole design decision, and it is what makes

```ts
@@mutable type Cell   = { n: number };
          type Frozen = { n: number };
```

two *different* types: `Frozen` is still immutable even though it is structurally identical. Had
mutability been attached to the SHAPE, the compiler could not have told them apart and any
`{n:number}` anywhere would have become assignable in place — a silent hole. Reusing the class tag
also means every downstream rule is the class rule, unchanged: `classTag`, the checker's field-
assignment check, and the ownership pass's `NT1607`/`NT1604`/`NT1602`.

Because a record has no constructor, its values come from object **literals**, so a literal takes
the tag from its **context** — a binding annotation, a declared return type, a parameter type, an
array element type. `const c: Cell = { n: 1 }`, `return { n: 1 }` and `f({ n: 1 })` all produce a
`Cell` through the one hint channel the checker already had.

### A `@@mutable` record may be a DISCRIMINATED-UNION MEMBER

`discriminatedUnion` (src/parser.ts) used to require `classTag(a) === undefined` of every arm, so
a tagged record made `Expr`/`Stmt` an `NT1009`. That clause dates to SH2 behavior 1, when the only
carrier of a tag was a CLASS instance — and **it is vacuous even for that subject**: a class field
annotation is parsed with `parseType`, which WIDENS a string-literal type, while a record field
goes through `parseTypeInner`, which keeps it. So a class instance can never hold the
literal-typed discriminant `unionDiscriminant` demands; removing the clause outright, a union of
two classes still fails one step later with *"the shared field(s) kind are not string-literal
typed"*.

A tagged member is sound for the reason the whole encoding is: there is **no box**, a union value
IS the member's object block, and a tagged block has the same slots as an untagged one.

The relaxation is therefore exactly as wide as the dead guard was — a tag is admitted only when it
names a `@@mutable` record. A class-tagged arm still takes the old path and keeps its exact
message.

**The tag set has to be SHARED across the hoist.** `hoistTypeDecls` re-parses each declaration in
a **fresh sub-Parser**, which has never seen the `//@@mutable` on some *other* declaration in the
file. A **recursive** union is resolved through that hoist, so without sharing the set, a tagged
member fell back to the general-union refusal and stalled the whole cycle — `NT1030 recursive type
'Expr' … what is left is not recursion but [NT1009] general union type 'Num{…} | @Neg'`. A
non-recursive union never goes through the hoist and passed either way, which is precisely why
this needed its own test. The set is shared by reference, exactly as `recTypes` already was.

### A RECURSIVE `@@mutable` record: the refusal is on the FIELD, not the declaration

`@@mutable` + recursive used to be refused whole (`recursiveMutableError`). The hazard was never
memory safety — it is that in-place mutation of a self-containing value can close a **CYCLE**, and
every walk here assumes a tree.

**The cycle is real and REACHABLE**, verified with the old refusal neutered rather than argued:

```ts
const a: Node = { n: 1, next: null };
const alias = a;      // an ALIAS — it survives the move the next line performs
a.next = a;           // an OWNED receiver, so nothing refuses it
console.log(alias);
// node:     <ref *1> { n: 1, next: [Circular *1] }
// nativets: Node { n: 1, next: Node { n: 1, next: [Node] } }      exit 0 on BOTH
```

Depth-limited, so **not a hang** — a silent wrong answer, which is worse than a refusal.
`JSON.stringify` and `structuredClone` of a recursive type are already refused (`NT1005` /
`NT1002`), so `console.log` is the entire exposure. Note the obvious spellings are already blocked
by the **value** side — `x.next = y` with `y` a parameter is `NT1604`, with `y` owned it MOVES `y`
— and the alias route defeats both. `test/forward-type-ref.test.ts` used to claim "a cycle is not
reachable there today, linearity stops it"; that claim was wrong.

So the declaration compiles and the refusal moves to the assignment of a **cycle-capable** field:

> **`ft` is cycle-capable for receiver tag `R` iff `R` is type-reachable from `ft`.** `Ty` is flat
> text and a nominal name appears in exactly two spellings — folded `@Name` and inline `Name{…}` —
> so ONE scan finds every occurrence at every depth, through `{…}`, `[]`, `?N`/`?U`, `U<…>`, `G<…>`
> and function types alike. Close over `recTypes` to a fixpoint.

Conservative in one direction on purpose: a folded `@X` absent from `recTypes` is treated as
reaching everything (**cannot decide ⇒ refuse**), and the rule is a TYPE-level over-approximation
of a VALUE-level question, so it refuses writes that happen not to close a cycle. A false refusal
is a missing feature; a false accept is the wrong answer above. Mutual recursion falls out of the
same fixpoint with no extra flag, and a NON-recursive `@@mutable` record has an empty fixpoint, so
nothing that compiled before changes.

**Why this is exactly the cycle boundary:** a cycle can only be created by an in-place write into
a slot of a value already reachable from the value being written, and any such write's field type
must type-reach the receiver's own type. CONSTRUCTION cannot make one — a literal's fields are
values that already exist.

### The CLASS spelling, split the same way

A `@@mutable` **class** that is recursive used to stay refused at the declaration, on the ground
that "its write is `this.f = v` inside a method, a different receiver question". **That reason was
wrong**, and it is worth recording why, because it is the shape of error this project keeps
finding: the rule above is **TYPE-level** — receiver type, field name, field type — and inside a
member body `this` has the class's own `classTag`-tagged instance type. It was never a different
receiver question. The only thing separating the two spellings was a `!e.viaThis` guard on the
call site.

Measured with the declaration refusal neutered, both directions:

```ts
//@@mutable class N { next: N | null = null; loop(): void { this.next = this; } }
// compiles, and prints N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }
// where node prints <ref *1> N { v: 7, next: [Circular *1] }   — so SOMETHING must refuse

//@@mutable class S { vars = new Map(); parent: S | null = null;
//                    declare(k, v): void { this.vars = this.vars.set(k, v); } }
// compiles, runs, matches node exactly — nothing here can close a cycle
```

So the refusal moves to the write, exactly as it did for records. Two carve-outs, both load-bearing:

**The CONSTRUCTOR is exempt unless the value names `this`.** A constructor writes into a freshly
allocated block nothing else holds a pointer to, so the value it stores cannot already reach the
receiver — the only way in is to name the block, and `this` is the only name it has. This is not a
convenience: a field initializer (`next: N | null = null`) and a parameter property
(`constructor(private parent: S | null = null)`) both **desugar into constructor writes of the
recursive field**, so without the carve-out the field rule would refuse every recursive `@@mutable`
class at its own declaration and the split would be vacuous. Both halves verified —
`constructor() { this.next = this }` reproduced the wrong answer above, and the aliased spelling
`constructor() { const t = this; this.next = t }` is already `NT1604` ("cannot move out of `t`: it
is borrowed"), so it cannot reach the hole. The check is `mentionsThis` (src/ast.ts), a syntactic
scan of one expression tree — no fixpoint, nothing that can diverge.

**UNDECORATED classes are untouched.** An ordinary class's field-assigning method COPIES the
instance and hands the copy back (Stage 29, `NT1023`), so `this.next = this` there stores the
ORIGINAL into a fresh copy and no cycle exists. The rule fires only on a `@@mutable` receiver,
which is exactly when the write lands in place — so the blast radius on everything that compiled
before is zero, per-function.

**What it unlocked:** `Scope` in `src/checker.ts`, whose `parent: Scope | null` made it recursive
and therefore un-`@@mutable`. It never writes `parent` after construction — the chain points up and
nothing points down — so the field rule is silent on it, and it now carries the attribute.
`Scope.declare` left the blocker list. `Scope.lookup` did not: its `hits` `Set` still uses the
discarded-mutator spelling, and rebinding it replaces an object read from outside the class, which
is a real aliasing question rather than a transcription.

**The leak position, stated.** A cycle that does get built through some future hole would LEAK,
because refcounting cannot free cycles and drop here is shallow anyway. That is acceptable — leaks
are the user's problem, use-after-free is not, and C and Rust both take this position. What is NOT
acceptable, and what this rule actually protects, is the silent wrong answer out of `console.log`.
The freeing side is gated separately: `test/mutable-records.test.ts` churns a recursive
`@@mutable` class 200 times under ASan+UBSan built through `emitIRAsan` (the instrumented path
that can see a stale READ, not just a double free) and against a live-object CONTROL.

### The ownership rule is the SAME one

Only the **owner** may mutate, and a borrow may never outlive its owner — stated over a field write
instead of a setter call:

| | |
|---|---|
| `const b = c` | an **alias** (a borrow), not a move — every handle observes the mutation, and the value is still dropped exactly once, by the owner (`__objLive()` → 0) |
| `b.n = 1` through an alias, a **container element** (`cells[0].n = 1`), `p.b.n = 1`, a call result, a capture | **`NT1607`** (≈ rustc E0596) — the receiver is not a binding whose ownership this scope can establish |
| `c.n = 1` through a **PARAMETER** or a `for-of` **element** | **ACCEPTED** — see below |
| a setter on a **fresh** `new C(…)` receiver (`new Counter().bump().get()`) | **accepted** — a temporary nothing can name is uniquely owned by construction |
| letting an alias **escape** (`return b`) | **`NT1604`** (≈ E0507) — including a *fresh* chain's result |
| reassigning an owner that is still aliased | **`NT1602`** (≈ E0506) |
| **reading** through any handle | always fine |

#### The PARAMETER / `for-of` arm is dropped for a `@@mutable` RECORD

A mutating helper — `function tick(c: Cell) { c.n++; }` — used to be `NT1607`. It is accepted.

**The opt-in travels with the NOMINAL type, which is part of the SIGNATURE**, so `tick(c: Cell)`
announces "may mutate" in its own type and the calling convention stays visible at the call site.
That is the objection that ruled out *inferring* a mutating parameter; requiring a second opt-in
at each (function × receiver) site would not have satisfied it any better.

Dropped for **records only**. A class's mutation is a setter CALL whose receiver is `this` inside
the method, which is a different question, so `MutableInfo` grows a `records` set beside the
`classes` set that `mutableTags` deliberately merges.

`borrowBindings` is exactly {parameters} ∪ {aliases} ∪ {`for-of` elements}, so subtracting
`aliasOf` leaves precisely the two this arm covers. **Still refused:** an ALIAS receiver, a
container element, a call result, a capture, and `p.b.n = 1` — the record actually mutated there
is a container element, not a binding.

**Soundness.** The three obligations already held, and none of them is new machinery:

- **a borrow never FREES**, so the caller still drops exactly once — no double free, no UAF;
- **the assigned VALUE is consumed** — `b.items = local` MOVES `local`, which is the rule that
  closed the use-after-free `.push` once had;
- **the OVERWRITTEN value is leaked, not freed** — required, since an alias may still hold it.

What is lost is **exclusivity**, which "What this proves, and what it does not" above already
disclaims. Measured: `__objLive()` 0 / `__arrLive()` 0 through three mutating calls, exit 0,
stdout matching node.

### `delete o.k` is still refused, and that is a decision

`@@mutable` legalizes assigning a **slot**, not changing a **shape**. A record's fields are static
slots resolved at compile time — the shape *is* the type — so removing a key would change a value's
type mid-program, which is a different and much larger feature (it needs runtime-keyed objects).
It stays `NT1606`, now with a hint that names the two real fixes: declare the field optional
(`k?: T`) and set it to `undefined` — which a `@@mutable` record can now actually do — or rebuild
without the key.

### Known imprecision

- **A record tag is a NAME.** The module linker renames a non-entry module's record tags per module
  (like class tags), so two modules may each declare a `Cell` — verified in
  `test/mutable-records.test.ts`. Within one module the name must be unique, as any type name must.
- **Compound assignment re-reads the receiver.** `o.f += v` desugars to `o.f = o.f + v`, which is
  sound only for a side-effect-free receiver path, so a computed one (`f().x += 1`) is refused
  rather than double-evaluated.
- Everything under "What this proves, and what it does not" above applies verbatim: this is not
  full `&mut` exclusivity, and aliases borrow for the whole scope (no NLL).

---

## `@@mutable` on an ARRAY ACCUMULATOR (`let` / `const`)

```ts
//@@mutable
let tokens: Token[] = [];
for (…) tokens.push(t);        // a real in-place append
return tokens;                 // handed out by MOVE — an ordinary immutable array again
```

An undecorated binding is unchanged: `xs.push(v)` is still `NT1606` pointing at `[...xs, v]`.

### ...and on a PARAMETER

```ts
function collect(
  //@@mutable
  out: Token[],
  src: string,
): void {
  out.push(lex(src));          // a real in-place append the CALLER observes
}
```

An unmarked parameter is unchanged: `xs.push(v)` is still `NT1606`.

**No new syntax was needed.** The lexer already turns a line comment whose whole body is
`@@name` into the two tokens `@@` + `name` at ANY position, including inside a parameter
list — so the pragma spelling works here for free, the source stays valid TypeScript, and
node is the oracle directly with no stripping. (A previous lane established that
`//@@mutable(c)` mid-list is silently ignored; that is a different spelling — an
*argument* to the attribute — and it stays unsupported.)

#### Why not the record's answer

The record answer is nominal: `@@mutable` tags a TYPE, the tag travels with the signature,
so the calling convention stays visible at the call site — the objection that ruled out
inference. **An array type is STRUCTURAL (`T[]`), so there is no name to tag**, and the
precedent does not transfer. A marker on the parameter meets the same criterion directly:
it is part of the signature, and it is *more* precise than a type tag, because it says
WHICH parameter grows rather than "arrays of this type grow everywhere".

It is also not the accumulator's answer, for the reason that section already gives: the
attribute on a `let`/`const` describes one binding this scope owns, and a parameter is a
borrow with no declaration here to hang it on.

#### The two rules that live at the CALL SITE

The callee cannot see either of these, so both are checked where the array is handed over.

| | |
|---|---|
| passing a **plain (unmarked) parameter** into a marked position | **`NT1607`** — the marker must TRAVEL |
| passing a binding a live **`for-of` borrows** into a marked position | **`NT1603`** — iterator invalidation |

The first is not decoration; it is what makes the second reachable. `outer(xs: T[])`
announces nothing, and the invalidation check fires at the call that hands the array over
— which is the call to `outer`, not to the marked callee inside it. One unmarked hop would
route around every announcement and every check below it.

The second is a **wrong-answer** hazard, not a memory one. `nt_arr_get` re-reads `data`
every step so nothing dangles, but a `for-of` reads the length ONCE — so nativets would
walk the old length where node walks the growing array. Measured, on the compiler with the
call-site rules keyed only on a bare-identifier callee: `1 2 3 4` against node's
`1 2 3 1 4`, exit 0 on both sides. Which is why a **method's** marked parameter is checked
too, by its bare property NAME with the implicit `this` discounted — the same name-based
over-approximation `setterProps` already uses (over-refusal, never a wrong answer).

#### Soundness, and what it costs

The runtime append cannot dangle: `NtArray` is a stable header (`{len, cap, data}`) and
`nt_arr_push` reallocs `data` behind it, so the caller's pointer stays valid and observes
the growth. A parameter is a **borrow**, so the callee never frees it and the caller still
drops exactly once. `.push`'s argument is **consumed**, guarded on the receiver's array
type. Measured against a CONTROL rather than against zero (an array frees its handle, never
its slots): 200 rounds × 5 pushed objects leave `__arrLive()` 0 and `__objLive()` 1000
through a parameter — **the same counts the local accumulator leaves**, exit 0 both.

Refused (`NT1023`): the marker on a non-array parameter, on a destructuring parameter, and
on a **constructor** parameter — `new C(…)` is a call site the two rules above do not
resolve, and an unchecked marked position is a silent wrong answer, not a missing feature.
An **arrow** parameter cannot carry it either (the arrow parser does not accept `@@`), so
it is a parse refusal rather than a silent no-op.

Still refused inside the callee: a marked parameter a **closure captures** is `NT1607`, the
accumulator's one hole verbatim. Admitted: a **field-path** argument (`f(node.body)`), a
`for-of` **element**, and a captured local as the *argument* (the append happens during the
call, with the owner in scope).

**Known imprecision.** Both call-site rules key on an argument that is a bare identifier.
A field or element path (`f(node.body)`) is admitted — memory-safe for the reasons above —
but a `for-of` over that same path in this scope is not caught, because `borrowed` is keyed
by binding name. The travel rule is what bounds it: the array reached that call through an
owned binding or a marked parameter somewhere up the chain.

**Why it exists.** `src/ast.ts`'s `setBlockDrops(list, names)` appends the ownership pass's
`BlockDrops` marker to an AST statement list. That is a genuine in-place annotation — the
list belongs to the AST, so there is no local to return into, and the only source
alternative was to pre-seed a marker into every block at parse time, which changes every
program's AST. It is ONE line, and every one of the nine remaining compiler modules imports
it, so it was the first blocker of all nine. Two marked parameters (`setBlockDrops`'s
`list`, `ownership.ts`'s `scoped`'s `list`) moved all nine — onto `new Map(p.recTypes ?? [])`,
the tuple-entries form. See `docs/self-hosting.md`.

### The attribute is on the BINDING, not the type

This is the one place the three `@@mutable` forms differ, and it is deliberate. A class's
mutability is nominal (the tag); a record's is nominal (the tag). An **array's is neither** — it is
a property of one `let`/`const`.

Had it travelled with the type, every `T[]` anywhere would have become appendable through any
handle, which is the silent hole the record section already warns about. Attached to a binding, the
opt-in cannot leak: the value this binding eventually hands out — returned, stored in a container,
passed to a function — is an ordinary immutable array, and the receiving scope must opt in on its
own binding before it can append. So the attribute has no reach beyond the declaration you can see.

One declarator only. `@@mutable let a = [], b = []` would have to say which binding it means, and a
destructuring pattern lowers to several declarators none of which the user wrote — both `NT1023`.

### Why it exists: a TWO-TOOLCHAIN cost, not a semantics one

The sanctioned `xs = [...xs, v]` is **already O(1) amortized in nativets** (codegen's
consuming-append). It is a real **O(n) copy per append under bun**, and bun is stage 0 — it runs
`src/*.ts` and the whole test suite today. 30,000 appends:

| idiom | bun | nativets |
|---|---|---|
| `xs = [...xs, v]` | 760 ms | 4 ms |
| `xs.push(v)` | 2 ms | 0 ms |
| builder object + `.build()` | 632 ms | 20 ms |

`lex`'s `tokens` reaches ~35,000 elements on `src/checker.ts` alone. The builder was measured
because it is the obvious immutable-first answer, and it loses on exactly the axis that matters: it
is a **source rewrite of 185 sites** AND still 632 ms under bun, because its own internal append has
to be the spread. `.push` under an opt-in needs **no source rewrite at all** — `src/*.ts` keeps
writing `.push`, which is native speed in bun, and nativets compiles it as real mutation. That is
the whole argument. The standing performance follow-up is in `docs/ROADMAP.md`.

### Ownership: the SAME rule, and no new analysis

Only the owner may mutate. For an accumulator the compiler already had everything it needs:

| | |
|---|---|
| `const b = xs` | a **MOVE** — an array is LINEAR, so a second live handle cannot exist; a push after one is `NT1601` |
| a **parameter** | a borrow, and it cannot carry *this* attribute (this one is on a `let`/`const`) — so `NT1606`, **unless the parameter carries its own `@@mutable`** (see "…and on a PARAMETER" above) |
| `this.f`, `xs[0]`, `f()` | name **no binding** — never match the opt-in, so `NT1606` |
| a **captured** accumulator | **`NT1607`** — the one hole the three facts above do not cover |
| pushing while a `for-of` borrows it | `NT1603` (iterator invalidation), the pre-existing rule |
| `.push`'s **argument** | **CONSUMED**, exactly as an array-literal element is |

The closure rule is the only new one, and it is the only one that had to be. Our closure
environment is a heap block filled **by value** when the closure is built (see `NT1031`), so an
arrow copies the array POINTER — and unlike a scalar capture, writing through a copied pointer is
visible outside. What that buys the closure is a second handle this scope cannot null, on a value
this scope will free. The refusal is over-approximated ("mentioned inside ANY arrow in this scope"),
which refuses the push whether it is written inside the arrow or outside it while an arrow holds the
name. Over-refusal, never a use-after-free. It is what keeps `src/modules.ts` refused, whose
accumulators are all pushed from inside `const walk = (list) => { out.push(…) }`.

**`.push` consuming its argument was a REAL use-after-free, found here.** While the argument was
merely borrowed — which is right for every *other* call, where the callee only reads it — a linear
value pushed inside a function stayed owned by its local, the local freed it at scope exit, and the
array went on pointing at it:

```ts
function fill(): number { const a: number[] = [4, 5]; g.push(a); return a.length; }
console.log(fill(), g[0].length);   // printed "2 3" — exit 0, WRONG ANSWER
```

It is now the same move `[...xs, v]` makes, guarded on the RECEIVER'S TYPE rather than the method
name, so a user class's own `.push` still only borrows its argument.

### Known imprecision

- **An accumulator has no statically-known length**, even as a `const` bound to a literal, so it is
  excluded from the `NT2002` compile-time bounds check. Recording the literal length would have
  rejected an index that is in range after the appends.
- The closure refusal is **scope-wide**, like every other borrow here: an arrow anywhere in the
  function poisons the name for the whole function. No NLL.
- `.pop`/`.shift`/`.unshift`/`.splice`/`.fill`/`.copyWithin` are **not** legalized. The opt-in is
  `.push` only — an append is the one mutation whose immutable equivalent was measured to be the
  bottleneck, and each of the others has a different aliasing story.

---

## `@wrapper` — the runtime decorator

A `@wrapper` is an **ordinary user function** that takes the thing being decorated and returns
the replacement — Python's model. It is applied **once**, where the class is declared, not per
call, so state the wrapper keeps persists across calls.

A decorated method is split in three:

```
C.m$inner(this, …p)                                   the original body, renamed
const __dec_C_m = w((__self, …p) => C.m$inner(__self, …p));   applied ONCE
C.m(this, …p) { return __dec_C_m(this, …p); }         the replacement
```

so the decorator's type is `(fn) => fn` over the method's own signature **with the receiver as
the first parameter**:

```ts
class Counter {
  pos: number = 3;
  @log scaled(n: number): number { return this.pos * n; }
}
function log(f: (c: Counter, n: number) => number): (c: Counter, n: number) => number {
  return (c: Counter, n: number) => { console.log("enter"); return f(c, n); };
}
```

The explicit receiver is a consequence of the lowering (methods become top-level functions taking
`this`), and it is the reason the decorator can be a plain function value with no new machinery.

**A class decorator wraps the CONSTRUCTOR.** nativets' classes are not first-class values, so
Python's `C = wrap(C)` has no literal analogue; the closest expressible reading is to wrap the
initializer, typed `(instance, …ctorArgs) => instance` — nativets allocates the instance, the
initializer fills it in and hands it back, and the wrapper may do anything around that (and may
return a *different* instance, which `new C(…)` will use).

**Stacked decorators apply BOTTOM-UP, exactly like Python.** `@a @b m()` ≡ `a(b(m))`: the
decorator written closest to the method wraps first, and `a` ends up outermost.

Refused (`NT1023`), because the wrapper's type is the method's own signature:

- a decorated method with **no return type annotation**;
- a decorated method with a **rest** or **default** parameter (a decorator wraps a fixed arity);
- `@@attribute` on a class **member** (attributes are class-level);
- `@wrapper` on a **field** or on a declaration that is not a class or a method.

---

## Tests

`test/push-accumulator.test.ts` (the array accumulator: node as oracle on stdout AND exit code,
the test262-derived `.push` behaviours, the rejection table, and the live-value counters),
`test/decorators.test.ts` (the specified design) and `test/mutable-records.test.ts` (the extension:
the `//@@` pragma, records, their ownership rules, and the module-linker path).

- **node-differential** (the oracle is node on a mechanically desugared source):
  - `@@mutable` classes — the oracle is the same source with the attribute line stripped
    (`stripAttributes` / `runWithNodeAttrs` in `test/harness.ts`), because an `@@mutable` class
    *is* a plain TS class;
  - `@wrapper` method and class decorators — the oracle is the hand-written explicit wrapper
    application (the desugaring itself), since node's own decorator proposal differs.
- **behavioral** (exact expected stdout, the `test/actors.test.ts` contract), where node has no
  desugaring at all:
  - the **ordinary copy-on-write class** (TS classes mutate);
  - the **implicit return** used for chaining (node returns `undefined`);
  - one-time wrapper application / wrapper state;
  - stacked-decorator order;
  - `__objLive()` → 0 for an aliased `@@mutable` instance.
- **rejection table** (`NT1023`, `NT1607`, `NT1604`, `NT1602`), pinned by code.
