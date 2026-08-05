# Decorators — two sigils, two mechanisms

nativets has **two** decorator forms, and they are not variations on one feature. They are
different mechanisms with different costs, and the sigil tells you which one you are looking at.

| Sigil | What it is | Runtime footprint | Applies to |
|---|---|---|---|
| `@@name` | a **compile-time attribute** the compiler reads — Rust's `#[derive]` | **none** | a `class` |
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

`test/decorators.test.ts`.

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
