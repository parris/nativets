> §A.2), unchanged.

### THE HEADLINE DIVERGENCE — an out-of-bounds index PANICS

In JS an out-of-range read is *defined*: `a[5]` on a 3-element array is `undefined`, and an
out-of-range write to a typed array is a silent no-op. **nativets aborts instead.**

```
panic: index out of bounds: the length is 3 but the index is 5
  at examples/thing.ts:12:9
  help: array index is out of range; use `.at(5)` to get `undefined` instead of panicking
```

on **stderr** (stdout is flushed first and stays byte-comparable), via `abort()` — SIGABRT, so
a shell sees **exit code 134**, the same path as `nativets: out of memory`.

**Why, given that node is the oracle.** Every indexed accessor in the runtime is bounds-checked,
so nativets never performs an out-of-bounds *memory* access — that part was never in question.
What was wrong was the **policy on a failed check**: it returned a benign value (`nt_arr_get` →
`0`, `js_str_char_at` → `""`, `nt_bytes_get` → `0`, an OOB `Uint8Array` write → nothing,
`nt_pv_update` out of range → an unchanged copy). Measured, that matched **neither** node **nor**
a trap:

| | nativets (before) | node |
|---|---|---|
| `a[5]` on `[1,2,3]` | `0` | `undefined` |
| `a[-1]` | `0` | `undefined` |
| `"abc"[7]` | `""` | `undefined` |
| `u[9] = 1` on a 4-byte array | silently ignored | silently ignored |
| `a[1.5]` on `[1,2,3]` | `2` (truncated!) | `undefined` |

A wrong-but-plausible `0` is the worst outcome available: the program keeps running and computes
a wrong answer from a value that was never there. Memory safety is supposed to mean *a guaranteed
controlled stop*, never *continuing into a phantom value*. Reproducing node's `undefined` would
mean making every element read nullable (`T | undefined`) — the whole language pays a tagged-pair
box on every index so that a bug can be *quietly propagated*. So we take the third option, the one
Rust takes: stop, loudly, at the exact source location.

Rules:

- **Covered accessors:** array read `a[i]`, string index `s[i]`, `Uint8Array` read `u[i]` **and
  write** `u[i] = v` (including compound `u[i] += v`), and `arr.with(i, v)` (flat *and* past the
  32-element persistent-trie threshold). **Negative indices panic everywhere** (they are not
  Python-style wrap-around). See the next bullet for what node actually does at each of these —
  the answer is not uniform, and the `.with` case is a real divergence, not a shared stop.
- **A NON-INTEGER index is out of bounds too** — `NaN`, `±Infinity` and any fraction. In JS
  `a[1.5]` is a property lookup on the string `"1.5"`, which no array, string or typed array
  has, so node reads `undefined`; it does **not** truncate to `a[1]`. The runtime used to
  truncate the double and read the neighbour, which was a *silent wrong answer*, not a
  divergence:

  ```ts
  const a: number[] = [1, 2, 3];
  let i = 1.5;
  console.log(a[i]);   // node: undefined   nativets (before): 2   nativets (now): panic
  ```

  Also `"abc"[1.5]` → `"b"`, `u[1.5]` → byte 1, and `u[1.5] = 7` **overwrote byte 1** where node
  stores an ordinary `"1.5"` property and leaves the bytes alone. All exited 0 with no
  diagnostic. The **compile-time** half had always agreed with node here — `checkStaticBounds`
  requires `Number.isInteger`, so the literal `a[1.5]` has always been `NT2002` — so the two
  halves of the same rule disagreed, and the runtime was the one that was wrong. Fixed:
  `NT_IS_INDEX` in `runtime/runtime.c` (guarded copy in `nt_bytes.c`).

  **`arr.with(i, v)` is deliberately excluded**: node's `.with` runs its index through
  `ToIntegerOrInfinity`, so `[1,2,3].with(1.7, 9)` really *is* `[1,9,3]` — truncating there
  matches node and is left alone. Bracket indexing has no such coercion. (`.with(NaN, 9)` is
  `[9,2,3]` in node and still panics here — see the negative-index table's `.with` row for the
  same class of gap.)
- **What node does with a NEGATIVE index — and where our rule genuinely diverges.** Verified
  against node, every case:

  | expression | node | nativets |
  |---|---|---|
  | `a[-1]` on `[1,2,3]` | `undefined` | panic |
  | `"abc"[-1]` | `undefined` | panic |
  | `u[-1]` on a 3-byte array | `undefined` | panic |
  | `u[-1] = 7` | silent no-op (sets a `"-1"` property) | panic |
  | `[1,2,3].with(-1, 9)` | **`[1,2,9]`** | **panic** |
  | `[1,2,3].with(-4, 9)` | `RangeError` | panic |
  | `[1,2,3].with(3, 9)` | `RangeError` | panic |

  **node never stops on a negative index at any of these accessors.** An earlier draft of this
  section justified the whole negative-index rule with "node throws a `RangeError` here, so node
  stops too". That is true **only when the index is out of range** — `i >= len`, or `i < -len`
  for `.with`. It was never true for an *in-range* negative index, and it was never true at all
  for `a[i]` / `s[i]` / `u[i]`, which are plain `undefined` in node. The claim is withdrawn.

  The rule still stands for the four `undefined` rows, on the Stage-41 reasoning above,
  unchanged: node's answer there is a phantom value, and propagating it quietly is the outcome
  we rejected. **`.with(-1, v)` is the one row that reasoning does not cover** — node has a
  defined, useful, non-phantom answer (`[1,2,9]`), and we abort on a correct program.
  Recorded as a divergence rather than silently repaired: see **STILL OPEN** below.
- **A panic is NOT an exception.** It deliberately does not go through the Stage-20
  pending-exception protocol: `try { a[5] } catch {}` still aborts, and a `finally` does not run.
  It stops the program; it is not a control-flow construct.
- **`.at(i)` is the node-exact escape hatch** and is unchanged: it returns `T | undefined`
  (`a.at(5)` → `undefined`, `a.at(-1)` → the last element), matching node byte for byte.
  `String#charAt(i)` is likewise untouched — node *defines* it as `""` out of range, so it is not
  a defect and does not panic.

  **`.at` is only the right advice for a read at or past the end**, and both the `NT2002` hint
  and the runtime `help:` line used to offer it unconditionally, to every accessor and every
  index. Following it did not avoid the panic — it silently returned a **different value**:

  | written | node | the advised replacement | node |
  |---|---|---|---|
  | `[1,2,3][5]` | `undefined` | `[1,2,3].at(5)` | `undefined` ✅ |
  | `[1,2,3][-1]` | `undefined` | `[1,2,3].at(-1)` | **`3`** — the LAST element ❌ |
  | `"abc"[-1]` | `undefined` | `"abc".at(-1)` | **`"c"`** ❌ |
  | `[1,2,3][1.5]` | `undefined` | `[1,2,3].at(1.5)` | **`2`** — truncates ❌ |
  | `[1,2,3][NaN]` | `undefined` | `[1,2,3].at(NaN)` | **`1`** — element 0 ❌ |
  | `u[i] = v` | discards the write | — | `.at` is a **read**; it cannot express a write ❌ |
  | `a.with(i, v)` | `RangeError` / relative | — | `.at` is a **read**; it cannot update ❌ |

  **Both hints are now keyed on the accessor and the index.** `nt_panic_bounds` already received
  a `what` argument and now composes a different `help:` line per accessor (`nt_bytes.c`'s write
  passes its own `what`, `"Uint8Array write index"`, rather than sharing the read's), and
  `checkStaticBounds` does the same for `NT2002` through `atSuggestion`. What each says now:

  - **read, at or past the end** — unchanged; ``use `.at(5)` to get `undefined` instead of
    panicking`` is true there.
  - **read, negative** — names that node reads `undefined` and that `.at` counts from the END
    instead, so it is *not* the same value.
  - **read, fractional / `NaN`** — names that `.at` truncates and that `.at(NaN)` reads
    element 0.
  - **read, infinite** — the one non-finite case `.at` gets right (`.at(±Infinity)` really is
    `undefined`), said so, with a note that an infinite index means the arithmetic is wrong.
  - **typed-array write** — node *discards* an out-of-range write, so no accessor replaces it:
    test `i >= 0 && i < u.length` first. `.at` is named only to rule it out.
  - **`.with`, negative** — points at `.with(a.length - 1, v)`, which is exactly node's
    `.with(-1, v)`.
  - **`.with`, out of range** — node throws `RangeError: Invalid index` too; to append, spread.

  Every one of those lines is **executed against node** in `test/panic.test.ts` ("the advice
  compiles and matches node"). A hint whose advice is never run is a hint nobody checked, and
  this class is only caught by running it.
- **Compile-time beats runtime.** When the length and the index are both statically known — a
  literal array/string, or a `const` bound to one, indexed by a numeric literal — the program is
  **rejected** with **`NT2002`** (`index 5 is out of bounds for an array of length 3`) rather than
  built and aborted. It is a real user error, hence the NT2xxx type-error band rather than the
  NT1xxx "not yet implemented" gradient, and `coverage` surfaces it.

  **This covers index syntax only.** `a[5]`, `a[-1]` and `s[7]` on a `const` literal are all
  `NT2002`; `a.with(5, 9)` and `a.with(-1, 9)` on the same `const` are **not** — they compile and
  panic at run time, even though both operands are just as statically known. Not a correctness
  hole (the program stops either way), but `.with` is listed as a covered accessor above and does
  not get the compile-time treatment the other four do.
- **Only written indices panic.** Compiler-generated in-bounds reads (`for-of`, the array HOFs,
  `JSON.stringify`, destructuring, spread-call expansion) keep the internal non-panicking
  accessor, so nothing pays twice and in-bounds programs are behaviourally unchanged.

#### STILL OPEN — `.with(-1, v)` panics on a program node runs correctly

The only row in the table above where we abort on a program node completes. Kept as an open
divergence rather than repaired in this lane, because repairing it is a **behaviour change** and
this is a documentation audit.

```ts
const a: number[] = [1, 2, 3];
const b = a.with(-1, 9);   // node: [1,2,9]     nativets: panic, exit 134
console.log(b[0], b[1], b[2]);
```

**What it would cost to match node.** Less than the other four rows, and that asymmetry is the
argument for doing it. `a[-1]` → `undefined` cannot be matched without making every element read
a nullable `T | undefined` box — the whole language pays for it, which is exactly the trade
rejected above. **`.with` pays none of that**: it returns an array, never `undefined`, so the
result type is unchanged and no box appears anywhere. The change is one line of index resolution
at the accessor — `i < 0 ? i + len : i`, then the existing bounds check, which still panics for
`i < -len` and `i >= len` where node throws a `RangeError` and stops too. Both the flat and the
past-32 trie path go through it.

So the negative-index rule is uniform in the code but **not** uniform in its justification: four
accessors are covered by the Stage-41 phantom-value argument, and `.with` is covered by nothing
except consistency with them. Whoever changes it should change the rule, not this document.

#### FIXED — the two lying hints on this path

Both were filed here by the documentation audit and are now repaired; kept as a record because
the *class* recurs. Both were "the hint recommends code that does something else".

1. **`src/checker.ts` (`NT2002` hint) — `.at(-1)` does not give `undefined`.** For a negative
   literal index the hint read ``use `.at(-1)` if you want `undefined` instead of a panic``.
   `[1,2,3][-1]` is `undefined` but `[1,2,3].at(-1)` is `3`, so the advice silently changed the
   answer; likewise `"abc".at(-1)` → `"c"`. Now keyed on the index by `atSuggestion`, which also
   covers the fractional case that the same audit did not reach.
2. **`runtime/runtime.c` (`nt_panic_bounds` help line) — `.at` was suggested for non-reads.** One
   line was composed for every accessor, so a `Uint8Array` **write** and `arr.with(i, v)` were
   both told to use `.at`, a read that cannot express either. Now keyed on the `what` argument
   the caller already passed.

**And the defect that fell out of fixing them:** writing a truthful hint for a *fractional* index
meant producing one, and the runtime never panicked on it at all — it truncated, so `a[1.5]` was
`2` where node reads `undefined`. That was a silent wrong answer hiding behind a lying hint, and
it is the argument for the standing rule: **compile the advice you write and run it against
node.** Recorded in the non-integer bullet above.

### A string past node's maximum length PANICS (node throws a catchable `RangeError`)

`"abc".padStart(Infinity, "xy")`, `"x".repeat(2 ** 53)` and friends are a **`RangeError` at
exit 1** in node. nativets stops too, but as a **panic**:

```
panic: invalid string length: the padded string would be Infinity bytes, past the 536870888-byte maximum
  help: node throws `RangeError: Invalid string length` at exactly this boundary; build the
        text in pieces, or write it out incrementally, instead of materialising one string this large
```

```
panic: invalid count value: -1
  help: `.repeat(n)` needs `n` to be finite and >= 0; node throws `RangeError: Invalid count value: -1`
```

on **stderr**, stdout flushed first and byte-comparable up to the stop, `abort()` → **exit 134**.
**The exit code is the divergence** (node's is 1), and so is catchability: like every other panic
this does not go through the pending-exception protocol, so `try`/`catch` cannot stop it.

**The cap is node's own number.** V8's maximum string length on 64-bit is `2**29 - 24` =
**536870888**, found by binary search against node v24: `"abc".padStart(536870888)` succeeds on
both sides and `536870889` stops on both. We count **UTF-8 bytes** where node counts UTF-16 code
units (§A.2), so the boundaries coincide for ASCII and ours is the stricter one above U+007F.

**Covered:** `String#padStart`, `String#padEnd`, `String#repeat` (both its `RangeError`s — the
count check of ES 22.1.3.18 step 3 runs *before* the length check, which is why `"".repeat(Infinity)`
stops while `"".repeat(1e100)` is a plain `""`), and `+` / `String#concat`. `new Array(n)` never
reaches this: it is refused at compile time (`NT1012`).

**Why a panic and not a raise, when node throws something catchable.** The pending-exception
protocol *could* carry a `RangeError`, and that would match node's exit code. It would also make
every `.repeat` / `.padStart` / `.padEnd` call site a **fallible call**, which `emitExcCheck`
*refuses to compile* inside a `try` with no `catch`, and inside a `try` whose `catch` binds an
object type. Those are ordinary formatting calls: the trade would be a rare stop for a common
**rejection of programs that compile and run correctly today**. One stop discipline — the same one
as an out-of-range index and `nativets: out of memory` — is worth the exit code.

**What this replaced.** All four builders took their length as `(long)d`, which C leaves
**undefined** for a non-finite or out-of-range double, and then did the size arithmetic in `size_t`,
which **wraps**. Measured, that was worse than a divergence:

| | nativets (before) | node |
|---|---|---|
| `"abc".padStart(Infinity, "xy")` | SIGABRT, **empty stderr** on arm64; `"abc"` at **exit 0** on x86-64 | `RangeError`, exit 1 |
| `"abcd".repeat(2 ** 62)` | **SIGBUS, empty stdout AND stderr** — 2^64 bytes truncated to 0, so it wrote 2^62 times into a **1-byte** buffer | `RangeError`, exit 1 |
| `"".repeat(1e100)` | **hung forever** (a `LONG_MAX`-trip loop of zero-byte copies) | `""` |
| `"x".repeat(-1)` | `""` at **exit 0** | `RangeError`, exit 1 |

The `repeat` wrap was an out-of-bounds heap write in a memory-safe compiler, and it had smashed
stdio's own buffer before it died — which is why even the line printed *before* the fault was lost.
Every length argument now goes through ES 7.1.5 `ToIntegerOrInfinity` **as a double**, so ±Infinity
survives the conversion, and the size arithmetic is done in double, which is exact below the cap and
cannot wrap. Regression tests: `test/panic.test.ts`, "string length".

### Decorators — a class method that assigns a field (`docs/decorators.md`)

Full design in `docs/decorators.md`; these are the three places node cannot be the oracle.

- **An ordinary (undecorated) class is COPY-ON-WRITE, not mutating.** In TypeScript
  `p.moveTo(3, 4)` mutates `p`. In nativets a field-assigning method **copies the instance,
  modifies the copy, and hands it back**; the receiver is unchanged. This is the same
  immutable-by-default rule arrays and objects took in Stage 29, extended to classes, and it is
  the owner's chosen idiom for guaranteed immutability. Opt out per class with the `@@mutable`
  attribute, which restores TS's semantics exactly (and *is* node-differential: an `@@mutable`
  class is a plain TS class, so the oracle is the same source with the attribute line stripped).
  The copy-on-write behaviour has no node desugaring, so it is pinned behaviorally with exact
  stdout in `test/decorators.test.ts`.
- **A field-assigning method with no `return` returns the instance, not `undefined`.** Decision 2:
  the implicit return is `this` (the new instance, or the mutated receiver). So a return-less
  setter **chains** — `a.bump().bump()` works here and is a `TypeError` in node. The *mutation*
  half of that is still node-differential; only the chaining is ours.
- **`@wrapper` decorators are not node's decorators.** The wrapper is applied **once**, at the
  class declaration (Python's `m = w(m)`), it receives the method with the **receiver as its
  first parameter** (methods lower to top-level functions taking `this`), a **class** decorator
  wraps the **constructor** (`(instance, …args) => instance`), and stacked decorators apply
  **bottom-up** — `@a @b m` ≡ `a(b(m))`, Python's order. The oracle for each of these is the
  hand-written explicit wrapper application, which is exactly what the compiler emits.

Refusals, never approximations: an unknown `@@attribute` (`NT1023` — an attribute changes how a
class compiles, so a misspelled one cannot be a comment), an ordinary setter that returns
anything but the instance (`NT1023` — the copy would be lost), and the `@@mutable` aliasing
shapes whose ownership cannot be established (`NT1607` / `NT1604` / `NT1602` — see
`docs/ownership.md` and `docs/decorators.md`).

### `console.log` of a COMPOUND value — node's `util.inspect`, and what is refused

`console.log(obj)` used to print a **bare newline**: `emitPrint` fell through to
`js_print_str` on the heap POINTER. A silent wrong answer, and the reason this section
exists. Compound values now render through a port of node's
`lib/internal/util/inspect.js` at console.log's defaults — **breakLength 80, compact 3,
depth 2, maxArrayLength 100** — and are **byte-identical to node**:

- **objects** `{ a: 1, b: 'x' }` (keys bare only for node's `/^[a-zA-Z_][a-zA-Z_0-9]*$/`
  — `$x` IS quoted), **class instances** `Point { x: 1 }` — but a **`@@mutable` RECORD prints
  UNTAGGED**, `{ n: 1 }`, even though it carries a tag in the type encoding, because node has no
  constructor to name for it (this was a silent wrong answer at exit 0 — `Cell { n: 1 }` — until
  the mutable-recursive lane; the depth cut follows the same split, `[Object]` for a record and
  `[C]` for a class) —, **arrays** `[ 1, 2, 3 ]` /
  `[]`, **Map/Set** `Map(1) { 'a' => 1 }` / `Set(2) { 1, 2 }`, and every nesting of them;
- **node's line-breaking**, including the column-grouped layout for arrays past six
  entries and the `... n more items` cut at 100;
- **node's depth cut** (`[Object]`/`[Array]` below depth 2), where an EMPTY compound
  still prints (`{}`) because node checks emptiness first;
- **node's string quoting** — `'`, falling back to `"` then `` ` `` to avoid escaping —
  with a **nested** string quoted and a **top-level** one bare;
- `-0` prints as `-0` (util.inspect's `formatNumber`), while `String(-0)` stays `"0"`;
- a **`Dyn`** (a `JSON.parse` result) uses the same algorithm at runtime — closing the
  Stage-20 deferral, where a compound printed the literal `[object]`.

Refused (**`NT1025`**), never printed as a pointer:

- a **function value**, anywhere in a printed value — node names a function after the
  binding it came from (`[Function: f]`), and our lambda-lifted arrows carry no name;
- a **`TextEncoder` / `TextDecoder` / `Response` / `Headers` / `URL` /
  `URLSearchParams`** handle, anywhere in a printed value. At the ROOT `Response`/
  `Headers` keep `NT1002` and `URL`/`URLSearchParams` keep `NT1024`.
  (A **`Uint8Array` is no longer refused**: Stage 49 found node's typed-array layout to
  be the array layout with the length folded into the opening brace, so it renders
  through the same builder — `Uint8Array(3) [ 1, 2, 3 ]`, column-grouped past six.
  `NT1016` is retired.)

A value below node's depth cut is never rendered, so a refused type there does **not**
block the program. Two residual divergences:

- **An ABSENT optional field still prints** — `{ a?: number }` is encoded exactly as
  `{ a: number | undefined }` (the parser's own equivalence), so a slot always exists
  and `console.log({ b: 'x' })` typed that way prints `{ a: undefined, b: 'x' }` where
  node prints `{ b: 'x' }`. This is the **pre-existing** optional-field-slot divergence
  already visible through `Object.keys` (`a,b`) and `JSON.stringify` (`{"a":null,…}`),
  not something inspect introduces — inspect is consistent with the rest of the compiler.
- **Widths are counted in UTF-8 BYTES**, node counts UTF-16 units (§A.2), so a non-ASCII
  entry can tip the 80-column break differently. Identical for ASCII.

Worth recording alongside: `js_number_to_string` has its own pre-existing gaps (`1e-7` →
`1e-07`, `1e-5` → `1e-05` instead of `0.00001`, and very large integers print their exact
rather than shortest-round-trip digits). Independent of inspect — they show identically
through `String(x)` — and not fixed here. (Format specifiers WERE also unimplemented; see
the next section, which closes them.)

### `console` format specifiers — compile-time, and what a NON-LITERAL format string does

`console.log("a %s b", "x")` printed `a %s b x` where node prints `a x b`: node's
`formatWithOptionsInternal` consumes `%s %d %i %f %j %o %O %c %%` from a **leading string
argument when further arguments follow**, and we appended every argument instead. Another
silent wrong answer, now closed — with two deliberate limits.

**The scan runs at COMPILE time.** Arguments here are statically typed and the format
string is virtually always a literal, so `planConsoleFormat` (in `src/checker.ts`, node's
loop transcribed) turns the call into a fixed sequence of literal chunks and per-argument
conversions, each lowered from the argument's static type. There is no runtime format
interpreter and no per-call cost, and the checker validates each argument for **the role
it plays** — `%d` of an object is node's `NaN` and needs no renderer, `%c` discards its
argument entirely (though it is still evaluated, like node).

**A non-literal format string panics if — and only if — it turns out to hold a
specifier.** `console.log(label, x)` is common and correct while `label` holds no
specifier, so it keeps the plain space-separated path plus a runtime guard
(`nt_fmt_guard`) that applies node's exact rule to the actual string:

```
panic: console format specifier in a non-literal format string: "a %s b"
  help: nativets expands `%s`/`%d`/… at compile time, so the format string must be a
        literal — build the line with a template literal (`${x}`) or pass a literal format
```

on stderr, stdout flushed first, via `abort()` (exit 134) — the Stage-41 panic path. The
alternative was printing a line node would have formatted, which is the defect this
section exists to remove. `typeof args[0] === 'string'` is a runtime fact for a nullable
and for a `Dyn`, so both feed the guard a pointer that is null exactly when node would not
have scanned.

**Refused at compile time (`NT1026`)** — conversions with no faithful form here, never an
approximation:

- **`%o`** of a compound (node adds `showHidden`: `[ 1, 2, 3, [length]: 3 ]`) — use `%O`;
- **`%j`** of whatever `JSON.stringify` itself refuses — a `Dyn`, a `URL`/`Response` handle,
  a value with a `toJSON` — and **nothing else**. `%j` IS `JSON.stringify`, so it routes
  through the one predicate (`checkJsonStringifyArg`) rather than keeping a second list in
  step. It previously refused a `Map`/`Set` outright while the direct call rendered the
  literal `null` for one; both now render `{}`, which is what node prints for every Map and
  every Set.

  `%j` accepts strictly MORE in exactly one place, and node is the reason: `%j` does not
  RETURN the stringify result, it CONCATENATES it (`formatWithOptions` does
  `tempStr = tryStringify(arg)` and joins), so a value stringify DROPS prints the literal
  `undefined` instead of having no answer. `console.log("%j", undefined)` is `undefined` in
  node and in nativets; the direct `JSON.stringify(undefined)` stays refused, because its
  result type is `string` here and the undefined VALUE does not fit in one. The same holds
  for a `T | undefined`. Routing `%j` through the direct call's predicate without that
  carve-out is a REGRESSION — a node-correct answer traded for a wrong rejection — and
  `test/json-fallthrough.test.ts` pins both directions;

- **`%d`/`%i`/`%f`** of an array or `Dyn`, which node coerces through `ToPrimitive`
  (`String([1,2,3])` is `"1,2,3"`, so `%f` of it is `1`);
- **`%s`** of a `Uint8Array`: node inspects an object only when it has no custom
  `toString`, and a typed array has one, so node prints `String(u8)` — `1,2,3` — not the
  `Uint8Array(3) [ … ]` form every other compound gets. `%O` and printing it alone are exact.
- any other `console.*` method (`table`, `group`, `dir`, `time`, `count`, `assert`,
  `trace`): **`console.log`/`error`/`warn`/`info`/`debug` are the supported surface**, with
  node's streams (error/warn → **stderr**, log/info/debug → **stdout**). `console.error`
  previously did not exist at all — it failed with `NT2001: 'console' is not defined`.

### stdlib Batch 1 — what cannot match node, and what we do instead

The Batch-1 stdlib (`docs/stdlib.md`) is node-differential everywhere except these, all of
which are **refusals or already-documented consequences**, never approximations:

- **In-place array mutators are refused** — `.fill`, `.sort`, `.splice`, `.shift`, `.unshift`,
  `.copyWithin` join `.push`/`.pop` under **`NT1606`** (arrays are immutable, Stage 29), each
  with a hint naming the immutable replacement. `.sort`'s hint points at the ES2023 copying
  form `.toSorted()` (delivered by the ordering lane, not this one).
- **String index space is UTF-8 bytes** (§A.2 above): `.charCodeAt`, `.at` and string indices
  address BYTES, so for non-ASCII they differ from node's UTF-16 code units (`"é".charCodeAt(0)`
  is `195` here, `233` in node). `.codePointAt` *decodes* the UTF-8 sequence, so it returns the
  same code point as node. ASCII is identical throughout; the non-ASCII behavior is pinned
  behaviorally in `test/stdlib-batch1.test.ts`.
- **`.replace`/`.replaceAll` accept STRING patterns only** — there is no `RegExp` (Tier C). The
  `$$`/`$&`/``$` ``/`$'` replacement substitutions are supported; capture-group `$1` is literal,
  as it is in node for a string pattern.
- **`toFixed(digits)` / `toString(radix)` require a literal argument** in range (`0..100` /
  `2..36`). node throws a `RangeError` outside those; we make the program **not compile**
  instead of emulating the throw. The formatting itself is exact (ECMAScript ToFixed; V8's
  `DoubleToRadixCString`).
- **`Object.entries` needs a string-valued object**, and **`Object.fromEntries` needs literal
  entries** — a `[string, number]` pair is a mixed-type tuple (our arrays are homogeneous) and
  object keys must be compile-time known. Both are `NT1002` refusals with hints.
- **`Array#at` / `Array#find` / `#findLast` are restricted to scalar elements** — handing back a
  heap element would alias its owner under the linear model (`NT1001`).
- **`Array#map` is NOT restricted that way, and the neighbouring bullet is why people think it
  is.** `.at`/`.find` hand back a BORROW of an element the receiver still owns; `.map`
  CONSTRUCTS a fresh array. Its callback may produce any slot-sized value — scalars, objects,
  arrays, nullables, a discriminated union `U<…>`, or a `@N` back-edge — because the question
  `mapResultOk` (src/checker.ts) asks is whether codegen has a STORE for the body's value, and
  every one of those is one pointer. Still `NT1001`: a GENERAL union `G<…>`, which is a heap
  BOX rather than a bare pointer and whose drop schedule is known-wrong (`isGeneralUnionTy` is
  missing from `isLinearTy`, so it leaks box *and* payload — see docs/ROADMAP.md, "Why ELEMENTS
  is not a one-line fix"), and `Date` (the pre-existing `allowDate` asymmetry).

  **`xs.map(x => x)` aliases the receiver's elements and is allowed** — not because it is
  checked and found safe, but because an array's elements are **never freed at all**
  (`nt_obj_free` is `free(o)` and never walks the slots), so the receiver and the result leak
  one set of elements between them rather than double-freeing it. Measured: a plain
  `const xs: Box[] = [{v:1},{v:2}]` with no `.map` in the program leaves `__objLive() === 2`.
  This is the same "never freed once, so it cannot be freed twice" argument ROADMAP already
  makes for nullable boxes, and it is a property of the MEMORY MODEL, not of this predicate —
  the day per-type destructors land, `.map(x => x)` over a heap element becomes a real double
  free, and so does every array-of-objects program in the tree. The guard that lane needs is an
  ownership rule about the arrow's result aliasing its parameter, near `searchBorrowBase`.

  **That guard is necessary and nowhere near sufficient — `.map` is one of EIGHT, and the
  other seven need no arrow at all.** Measured with a depth-1 element destructor spliced into
  `emitDrops` and run under ASan: `.map(x => x)`, `.filter`, `.slice`, `[...xs]`, `.concat`,
  `.toSorted`, `.toReversed` and `.with` each became an `attempting double-free`. Every one of
  them builds a new array by COPYING SLOTS, so the same element pointers land in a second
  header and both headers are then dropped — no callback, no aliasing rule, just the method.
  A rule about an arrow's result would catch exactly one of the eight. The blocker is a list of
  METHODS, each of which must deep-copy, consume its receiver, or be refused on a linear
  element type. Pinned as allocation counts (which need no destructor to observe) in
  `test/drops-obj.test.ts`, "array methods that ALIAS elements".

  The shapes that let an element escape **by name** are, by contrast, already refused, and that
  is why the list is methods-only: `const e = xs[0]` and `return xs[0]` are `NT1605`, a borrowed
  parameter stored into a local array is `NT1604`, and one object named by two arrays is
  `NT1601`. Pinned in the same block.
- **`Date.now()` is not node-differential** (a clock read): it is tested behaviorally —
  monotonic, whole milliseconds, plausible epoch range.

### base64 (`btoa`/`atob`) — the BINARY-STRING contract, and it is NOT a divergence

This one is here because it *was* a divergence, silently, and is not one any more.

`btoa`/`atob` are defined on a **binary string**: one **code point** per byte. Ours were
implemented as "pure byte ops over the string's bytes" — the one reading of them that is
never right, because §A.2's UTF-8 byte orientation had reached the single function whose
entire contract is *which bytes those are*:

| | node | nativets, before |
|---|---|---|
| `btoa("é")` | `6Q==` | `w6k=` |
| `btoa("你")` | **throws** `InvalidCharacterError` | `5L2g`, **exit 0** |
| `atob("YQ===")` | **throws** | `"a"` |
| `atob("!!!!")` | **throws** | `""` |
| `atob("/w==")` stdout | `C3 BF` | the bare byte `FF` — stdout that is not valid UTF-8 |

Two of those are the worst outcome the prime directive names, and the last is the
byte-level one a text-decoding comparison would have shown as a match.

**Now:** `btoa` decodes its UTF-8 input to code points and takes each one's single byte;
above U+00FF there is no byte, so it raises — which is also where a **lone surrogate**
(`\ud800`, WTF-8 in our representation) and a **malformed sequence** land, the latter
because node's string would hold U+FFFD there, above U+00FF for the same reason. `atob`
implements WHATWG *forgiving-base64 decode* (strip the five ASCII whitespace code points —
**VT is not one**; strip up to two trailing `=` only from a length that is already `%4 == 0`;
then reject a non-alphabet character, then a length leaving remainder 1) and re-encodes each
decoded byte as the code point of that value. `atob(btoa(s)) === s` for every `s` `btoa`
accepts.

**The throw follows the `JSON.parse` precedent** rather than inventing one: the runtime
raises on the pending-exception slot (`nt_exc_raise_msg`) and codegen emits the matching
`emitExcCheck`, exactly as for `JSON.parse` and `decodeURIComponent`. So it is **catchable
in a `try` in the same frame**, and uncaught it exits 1 with node's stdout. `emitExcCheck`'s
existing refusals now reach these calls too, unchanged and for the unchanged reason —
`btoa("x")` inside a `finally`-only `try` is `NT1004` ("a call that can raise inside a `try`
that has a `finally` and no `catch`"), exactly as `JSON.parse` there already was. Both are
pinned in `test/fuzz-diff.test.ts`.

**What still differs, and why neither is a base64 question:**

- **The message shape.** node's `e` is a `DOMException`; ours is the string
  `"InvalidCharacterError: Invalid character"` (or `"…: The string to be decoded is not
  correctly encoded."`). That is the pre-existing shape of *every* runtime-raised message —
  `JSON.parse`, `fs`, `fetch` all do this — not something this pair decides.
- **`.length` of a non-ASCII decode.** `atob("////").length` is `6` here and `3` in node:
  three `0xFF` bytes are three code units in node and six UTF-8 bytes here. That is §A.2, the
  documented index-space divergence. The decoded **value** is equal (`atob("////") ===
  "ÿÿÿ"` is `true` on both sides); only the index space differs.
- **A decoded NUL truncates** — `atob("AA==")` is `""`, not `"\0"`. That is the runtime-NUL
  door, tabulated with the rest of them under `NT1705` above.

### Number → String is NOT a divergence (it used to be, silently)

`Number::toString` (ECMAScript §6.1.6.1.20) sits under every printed number, and until now the
runtime approximated it with C's `%g` / `%.0f`. That is a different function, and it disagreed
with node three ways — none of them documented, all of them prime-directive violations:

| | nativets (before) | node |
|---|---|---|
| `1e-7` | `1e-07` | `1e-7` |
| `1e-5`, `0.00001` | `1e-05` | `0.00001` |
| `123456789012345680000` | `123456789012345683968` | `123456789012345680000` |

i.e. a **zero-padded exponent**, the **wrong notation threshold** (`%g` switches to exponential
below `1e-4`; the spec switches below `1e-6` and at/above `1e21`), and the double's **exact
decimal expansion** where the spec asks for the **shortest round-tripping digits** zero-filled.

It is now the spec algorithm: the shortest digit string that `strtod`s back to the same bits
(precisions 1..17, first round-tripping one wins — with the adjacent decimal probed too, because
near a power of two the rounding interval is asymmetric and the *nearest* p-digit decimal can fall
outside it while its neighbour, the one V8 prints, does not), then the spec's k/n placement rules.
Verified by a seeded fuzz of ~250k doubles against `String(x)` under node (`test/numtostr.test.ts`
plus a larger out-of-band run): **zero mismatches**. There is no remaining divergence to document
here — this entry exists so the old behaviour is not mistaken for a deliberate choice.

Two things that look like divergences and are not:

- **`console.log(-0)` prints `-0`, `String(-0)` / `` `${-0}` `` / `"" + -0` produce `"0"`.** That
  is node: `console.log` renders a number through `util.inspect`, which shows the sign of negative
  zero, while `Number::toString` does not. Both sides are matched deliberately.
- **`.toSorted()` with no comparator orders by these strings** (`[10, 9].toSorted()` is `[10, 9]`),
  so fixing the notation thresholds also fixed the default sort order for values below `1e-6` or
  at/above `1e21`.

`toFixed(digits)` and `toString(radix)` are separate, separately-verified code paths (ECMAScript
ToFixed; V8's `DoubleToRadixCString`) and are unchanged — see the Batch 1 entry above for their
one restriction (literal, in-range arguments).

### `typeof` is NOT a divergence (it leaked the internal type spelling, silently)

`typeof` answers from a **closed set of eight strings**, of which five are reachable in this
subset — `"undefined"`, `"boolean"`, `"number"`, `"string"`, `"function"` — and *everything*
else in the language is `"object"`. There is no sixth answer.

The lowering was written the other way round. It **enumerated the object-ish kinds it knew
about** — `null`, arrays, records/classes, `Date`, `URL`, `URLSearchParams` — and let anything
else fall through to `inner`, the raw `Ty` encoding. So a kind nobody remembered to list did
not fail loudly; it printed the compiler's own internal spelling as if that were a JavaScript
answer:

```ts
const s: Set<string> = new Set<string>(["a", "b"]);
console.log(typeof s);                                  // node: "object"   before: "Set<string>"
if (typeof s === "object") { … } else { … }             // node: then.      before: ELSE.
```

Exit `0`, wrong stdout — and **not cosmetic**, because `typeof` is a *branch* primitive and
`typeof x === "object"` is the standard JS spelling of "is this a reference?". Every such test
took the wrong arm.

**Eight kinds were wrong, across three separate code paths**, found by running a 30-kind
differential probe against node rather than by reading the code:

| kind | node | before |
|---|---|---|
| `Set<T>` | `"object"` | `"Set<string>"` |
| `Map<K, V>` | `"object"` | `"Map<string,number>"` |
| `Uint8Array` | `"object"` | `"Uint8Array"` |
| `TextEncoder` / `TextDecoder` | `"object"` | `"TextEncoder"` / `"TextDecoder"` |
| a discriminated union | `"object"` | `"U<{k:\"a\",v:number}\|{k:\"b\",v:string}>"` — the whole member list |
| `Set<T> \| undefined` holding a set | `"object"` | `"Set<string>"` |
| `Uint8Array \| undefined` holding one | `"object"` | `"Uint8Array"` |

The last two rows are a **third, independent copy** of the same default arm: the present arm
of the A2 nullable box (`genTypeofNullable`) computed the base's name with its own inline
chain. The first probe missed them because the only nullables it sampled were
`string | undefined` and `number[] | null`, whose bases are kinds the old chain *did*
enumerate — **a probe that only samples the arms already covered proves nothing about the
default arm.** They were re-measured on the pre-fix tree before being claimed.

**The fix is the DIRECTION of the dispatch, not seven more cases.** `staticTypeofName`
(`src/ast.ts`) enumerates the five non-object answers and defaults to `"object"`, which is
exhaustive *by construction*: a type encoding added tomorrow is an object unless it is a
number, string, boolean, undefined or function, and that list is not growing. It returns
`undefined` — never a guess — for the three things whose `typeof` is not a compile-time
constant: the nullable box and the general union (a genuine runtime fact, decided by the tag,
which is the point of the tag), `Dyn`, and an unsubstituted `#T`. Codegen turns that
`undefined` into an **internal error** rather than falling back to `"object"`, so a kind added
later is a loud failure instead of a quiet wrong answer.

`typeofTagOf` was deleted in the same change. It was correct only over its one caller's domain
(general-union arms: number/string/boolean/array) and answered `"object"` for `undefined` and
for a *function* type — right for that caller, a landmine for the next, the same shape as the
`objectFields("@N")` phantom-record hazard documented beside it. There is now one rule and one
copy of it, with `generalUnionArmTypeof` as a named domain adapter over it.

This is the **fifth** defect found in the default arm of a dispatch, after `join` on booleans,
nested-array `join`, string coercion (directly below) and `===` on two nullables. Pinned in
`test/typeof-operator.test.ts`, differentially against node.

### String coercion of a NON-primitive (`NT1032`) — it used to be a clang error

`"a=" + x`, `` `${x}` `` and `String(x)` all run through one codegen helper
(`coerceToString`), which handled `string`, `number`, `boolean`, `undefined`, `null` and the
A2 nullable box — and then **fell through to the boolean path** for everything else, emitting
`zext i1 <ptr>`. The checker let those types past, so the user's error was clang's:

```
console.log("a=" + [1, 2, 3]);
build error: clang failed (1): error: '%t4' defined with type 'ptr' but expected 'i1'
```

That is an internal representation mismatch escaping as a build error where this project
promises an `NT****` code with a hint, and it applied to arrays, objects, class instances,
`Map`, `Set`, `Uint8Array` and a `JSON.parse` result alike. Decided per type, each measured
against node first:

| expression | node | here |
|---|---|---|
| `"" + [1, 2, 3]`, `"" + ["a","b"]` | `1,2,3` / `a,b` | **implemented** — node's `Array#toString` IS `join(",")` |
| `"" + ([] as number[])` | `` (empty) | **implemented** |
| `"" + { a: 1 }` | `[object Object]` | `NT1032` |
| `"" + new C()` (class) | `[object Object]`, or its `toString()` | `NT1032` |
| `"" + new Map()` / `new Set()` | `[object Map]` / `[object Set]` | `NT1032` |
| `"" + [true, false]` | `true,false` | **implemented** — see below |
| `"" + [[1,2],[3]]`, `"" + [{},{}]` | `1,2,3` / `[object Object],…` | `NT1032` |
| `"" + new Uint8Array([1,2])` | `1,2` | `NT1032` |
| `` `${JSON.parse(s).f}` `` | the field's own string | `NT1032`, hint: narrow it (`as string`) |

**Why the `[object …]` forms are refused and not implemented**, given each is one interned
constant. The constant is node-exact only for a value with **no own `toString`** — node calls
the method when the class defines one (`class C { toString() { return "hi"; } }; "" + new C()`
is `hi`, measured). Emitting the constant unconditionally would turn a loud build error into a
**silent wrong answer** for exactly the programs that bothered to define the method: the worst
outcome available, traded for the second-worst. `[object Object]` is also never the string the
line meant, so the hint points at `JSON.stringify(x)` — and at `console.log(x)` on its own,
which already renders objects, class instances, `Map`/`Set` byte-identically to node.

**...AND `.join()` ITSELF WAS NEVER GATED ON THIS LIST — a silent wrong answer, now closed.**
The paragraph above says the checker's allow-list and `coerceToString`'s cases "are one list
written twice and must stay in step". They were written on ONE of the two paths. `.join()` is
the same `joinFn` dispatch reached by an explicit method call, and `inferArrayMethod` checked
only the SEPARATOR argument, never the element type — so the default arm (`nt_arr_join_str`,
`strlen` on the slot) was reachable directly:

| expression | node | here, before | here, now |
|---|---|---|---|
| `[[1],[2]].join(";")` | `1;2` | `\x01;\x01`, **exit 0** | `NT1032` |
| `[{x:1},{x:2}].join(",")` | `[object Object],…` | `,`, **exit 0** | `NT1032` |
| `[1,2,3].join("-")` / `["a","b"].join("")` / `[true,false].join(",")` | as node | as node | **unchanged** |

Exit 0 on both sides with different stdout is the class CLAUDE.md calls the worst outcome
available, and it had nothing to do with the nullable elements that exposed it — it reproduces
on any array of arrays or objects. `.join()` consults the same allow-list now. Pinned in
`test/nullable-element.test.ts`.

**`boolean[]` WAS refused, and no longer is.** The reason was never about the coercion: it was
that `.join` was itself broken for booleans. `genArrayMethod` split array methods on one bit
(`el === "number"`, number vs "everything else = strings"), so `[true, false].join(",")` went
to `nt_arr_join_str`, which read each slot — holding `zext i1`, i.e. the integers 0 and 1 — as
a `char *` and ran `strlen((char *)1)`. Empty output, exit 255, no diagnostic. Routing `+`
into a join that is already wrong would have laundered that into a second construct, so the
refusal was the right call *at the time*. `nt_arr_join_bool` closes the join (booleans spell
`true`/`false`, which neither sibling produces), the split is now the three-way `joinFn`, and
the coercion follows it. Pinned against node in `test/boolean-array-join.test.ts`.

A **nested or object** array stays refused for a different reason, which has not expired: what
node splices in is each element's OWN coercion, and that is the `[object …]` problem above, one
level down.

The refusal is **default-deny** — the checker allows a fixed list and rejects everything else —
because the failure being closed is precisely "a type nobody added a case for reached codegen".
`coerceToString` now raises an internal error rather than falling through, so the two lists
cannot drift apart silently. Pinned in `test/string-coercion.test.ts`.

### NUMERIC coercion of a non-primitive (`NT1039`) — the same hole, one operator along, and it was a SILENT WRONG ANSWER

`+x` and `Number(x)` share one codegen helper (`coerceToNumber`) exactly as `+`/`${…}`/`String`
share `coerceToString`. It handled `number`, `string`, `boolean` and the `null` **literal**, and
then ended in a bare `return llvmDouble(NaN)` — while the checker returned `number` for every
`+` operand **without looking at one** (`if (e.op === "+") return "number"`). So unlike NT1032,
whose fall-through emitted invalid IR and at least stopped the build, this one **compiled, ran
and printed a number node does not print, at exit 0**:

```
console.log(+new Date(1000));   // node 1000,  we printed NaN
console.log(+[]);               // node 0,     we printed NaN
console.log(+[1]);              // node 1,     we printed NaN
const n: number | null = null;
console.log(+n);                // node 0,     we printed NaN
```

`+new Date()` is the everyday *"now, as a number"* idiom, so this was not an exotic corner. The
asymmetry that hid it: unary **`-`** on a Date is refused (`NT2001` "Unary '-' needs number, got
Date") while its sibling **`+`** silently answered NaN — one door guarded, the other open. And
`d.valueOf()` / `d.getTime()` spelled out were both already correct, which pins it on the
coercion rather than on `Date`.

**The allow-list is `checkStringCoercion`'s, by delegation rather than by copy.** ToNumber of a
non-primitive is `ToPrimitive(x, number)` = `valueOf` then `toString`, and an ordinary object's
`valueOf` returns the object itself — so ToNumber **is** StringToNumber of the value's string
form, and a value coerces to a number exactly when it coerces to a string. `checkNumberCoercion`
calls `checkStringCoercion` and re-files the refusal under the numeric code, so the two lists
cannot drift apart. Each row measured against node first:

| expression | node | here |
|---|---|---|
| `+[]` / `+([] as string[])` | `0` | **implemented** — `Array#toString` is `join(",")`, and `Number("")` is 0 |
| `+[1]`, `+["1"]`, `+["  12  "]`, `+[1.5]` | `1` / `1` / `12` / `1.5` | **implemented** |
| `+[1, 2]`, `+["a"]`, `+[true]` | `NaN` | **implemented** — those really are NaN, via `"1,2"` / `"a"` / `"true"` |
| `+[-0]` | `0` (and `1/+[-0]` is `Infinity`) | **implemented** — `String([-0])` is `"0"` |
| `+(null as number \| null)` | `0` | **implemented** — the BOX, by its tag |
| `+(undefined as number \| undefined)` | `NaN` | **implemented** — a *different* answer from null's |
| `+new Date(1000)`, `Number(d)` | `1000` | **implemented** — see below |
| `+{ a: 1 }`, `+new C()` | `NaN`, or its `valueOf()`/`toString()` | `NT1039` |
| `+new Map()` / `+new Set()` | `NaN` | `NT1039` |
| `+new Uint8Array([5])` | `5` (node JOINS it) | `NT1039` |
| `+[[1],[2]]` | `NaN` (via `"1,2"`) | `NT1039` |
| `+JSON.parse(s).f` | the field's own coercion | `NT1039`, hint: narrow it (`as number`) |

**`Date` is the one addition, and it is a SPECIFIC rule rather than a general one.** It is the
only type where the two ToPrimitive hints diverge: the *number* hint runs `valueOf` first and
yields the time value, where the *string* hint runs `toString` and yields
`"Thu Jan 01 1970 …"` — which is why `"" + date` **stays** refused (`NT1024`, no tz display-name
tables) while `+date` is now ordinary. nativets represents a Date **as** its time value, so the
numeric coercion is the identity. The strongest evidence this was an oversight and not a
decision: `%d` in `console.log` (`genFormatNumber`) already had exactly that rule, with exactly
that comment, on the other ToNumber path.

**Why an object / class instance / `Map` / `Set` is refused even though node's answer is a
constant `NaN`** — the identical argument to NT1032's `[object Object]` one directly above. The
constant holds only for a value with **no own `valueOf`/`toString`**; node calls the method when
a class defines one, and this compiler has no prototype chain to consult at the coercion site.
Answering NaN unconditionally would trade a loud build error for a silent wrong answer in
exactly the programs that bothered to define it.

**The hint separates the exact answer from the guess at intent**, because a hint that quietly
hands back a *different value* is the `.at(-1)`-for-`a[-1]` mistake. Writing `NaN` is **exact**
— it is node's own answer for an object, a class instance, a `Map` and a `Set`, measured. The
alternatives it also offers (`+o.count`, `m.size`, `u[0]`) are **not** spellings of the
coercion and the hint says so. The `Uint8Array` row carries its own warning, because it is the
one that looks like the others and is not: node **joins** it, so `+new Uint8Array([5])` is `5`
and `+new Uint8Array([1,2])` is `NaN`. All three claims are compiled against node in
`test/number-coercion.test.ts` rather than asserted.

A **general ToPrimitive is not implementable here** and this is not a step toward one: objects
are flat records whose slot layout is fixed at compile time, and methods resolve from the type
tag rather than from a chain carried by the value. Every row above is either a rule this
compiler can state exactly (`Date`'s `valueOf`, an array's `join`, a box's tag) or a refusal.

**STILL OPEN — unary `-` does not share the coercion.** `-x` is ToNumber(x) then negate, so
`-new Date(1000)` is `-1000` in node; here it is still `NT2001` *"Unary '-' needs number, got
Date"*. That asymmetry is what hid the whole defect (one door guarded, its sibling silently
answering NaN), and closing it is two lines — route `-` through `checkNumberCoercion` as `+`
now is. It was left alone on purpose: it would also move every *other* `-` refusal from
`NT2001` (a type error) to `NT1039` (an unimplemented feature), which is a different
conversation. What remains is a **refusal**, not a wrong answer, so no rule is broken — the
same is true of `~x`, which requires a `number` outright.

`coerceToNumber` now raises an internal error rather than falling through to NaN. Pinned in
`test/number-coercion.test.ts`; the originating reports are in `test/fuzz2-diff.test.ts`.

### stdlib Batch 3 — `Date` (and the TIMEZONE decision), `URL`, URI encoding

**The timezone decision: local time is REALLY local, and the tests pin `TZ`.**

`getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`/`getSeconds`/`getDay`/
`getMilliseconds` are LOCAL-time accessors in node, and they are local here too: the runtime
breaks a time value down with `localtime_r` and converts a zoneless date-time string back with
`mktime`, both of which read the same IANA zone (`TZ`, `/etc/localtime`) that node's ICU reads.
So on one machine, in one zone, **we match node exactly** — including across DST transitions and
in half-hour zones.

The alternative — making the local accessors secretly UTC — was rejected: it would make
`d.getHours()` disagree with node for most of the world, silently, which is the one thing this
project does not do. The cost is that a Date fixture's *expected output* depends on the zone, so
the local-time cases in `test/stdlib-batch3.test.ts` run with **`TZ` pinned identically on both
sides** (`differentialTZ`, over `UTC`, `America/New_York` and `Asia/Kolkata`). The `getUTC*`
aliases and `toISOString()` are zone-independent by specification and need no pinning; they go
through pure civil-calendar arithmetic (no `time_t`), so the whole ±8.64e15 ms JS range works,
including the extended-year form `+275760-09-13T00:00:00.000Z`.

Everything else about Batch 3:

- **`new Date()` is not node-differential** (a clock read), exactly like `Date.now()`: it is
  tested behaviorally — non-decreasing, agrees with `Date.now()`, plausible epoch range.
- **`new Date(string)` accepts the ECMAScript Date Time String Format ONLY**
  (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss[.sss]]`, with `Z` / `±HH:MM`; a zoneless date-TIME is
  local, a date-only string is UTC — node's rules). node additionally accepts
  implementation-defined formats (`"March 15, 2020"`, RFC 2822); those are an **Invalid Date**
  (`NaN`) here. A time value stays `NaN` rather than becoming a wrong instant, and every getter
  on it returns `NaN`, like node.
- **`toISOString()` of an Invalid Date THROWS** (node's `RangeError: Invalid time value`) —
  catchably, through the pending-exception protocol. `console.log(date)` prints the ISO string
  (node's `util.inspect` of a Date) and `Invalid Date` for `NaN`; `JSON.stringify` emits the
  quoted ISO string, or `null` for an Invalid Date — all node-exact.
- **`toJSON()` is NOT `toISOString()` under another name, and it used to be.** ECMA-262
  21.4.4.37 takes the primitive at **step 3** and returns `null` for a non-finite time value,
  so step 4's `toISOString` invocation is never reached and the method **cannot throw**. We
  routed both spellings through one line, so `new Date(NaN).toJSON()` exited **1 with empty
  stdout** where node prints `null` and carries on. Its type is `string | null` here, exactly as
  in node, so `?? "…"` and `=== null` compose. `JSON.stringify(invalidDate)` was already
  correct (the runtime's serializer has its own NaN check), which is precisely what hid this —
  only the *direct* call was wrong.
- **`TimeClip` normalises `-0` to `+0`.** TimeClip is `ToIntegerOrInfinity(t)` clamped
  (21.4.1.15), and ToIntegerOrInfinity ends with *"If integer is -0, return +0"* (7.1.5) — so
  node's time value for anything in `(-1, 0]` is **positive** zero. We truncated toward zero and
  kept the sign, so `new Date(-0).getTime()` stored a negative zero and `1 / d.getTime()` was
  `-Infinity` where node says `Infinity`. `-0.5` and `-0.9` landed on it too. Both `String()`
  and `toISOString()` erase the sign, which is why it survived every string-shaped test; the
  regression test probes with `1/x`.
- **A Date is an IMMUTABLE time value.** `setHours`/`setDate`/… are refused (**`NT1024`**),
  pointing at reconstruction (`new Date(d.getTime() + ms)`). So is `Date#toString`/
  `toLocaleDateString` — those are locale + zone-*display-name* formatting, which needs tables
  we do not ship. `"" + date` is refused for the same reason. **`+date` is NOT** — the numeric
  coercion goes through `valueOf`, not `toString`; see the `NT1039` section above.
- **`date === date` is REFUSED (`NT1024`), and it used to emit invalid IR.** node compares Date
  **identity**: two distinct Dates are `false` however equal their instants, and an Invalid Date
  *is* `===` itself even though `NaN !== NaN`. A Date here **is** its time value, so there is no
  identity left to compare, and both plausible codegens are wrong for a program somebody writes.
  It previously fell into the equality chain's `js_str_eq` default and produced
  `'%t2' defined with type 'double' but expected 'ptr'` — a build error with no `NT` code and no
  hint, which is the one outcome the diagnostics contract rules out. The hint hands back
  `a.getTime() === b.getTime()` **with** the caveat that it is a value comparison and node's is
  not; both halves are compiled against node in `test/narrowing.test.ts`.

  That `else` was the **default** arm rather than the string arm, so it swallowed one more type:
  `null === null` (node `true`) came back as `'%t0' defined with type 'i8' but expected 'ptr'`.
  `undefined`/`null`/`void` are unit types, so their equality is now the constant it is, and the
  byte-wise arm asserts its operand is a pointer — the same default-deny the string and numeric
  coercions got.
- **`new URL(u)` covers absolute `http(s)` URLs.** Out of subset: relative URLs, other schemes
  (`file:`, `data:`), IPv6 bracket hosts, punycode/IDNA, and path/percent **normalization**
  (input is assumed canonical; node re-normalizes). node throws a `TypeError` on a URL it cannot
  parse and so do we — catchably — but for a *different set* of inputs: a `file:///x` that node
  accepts throws here. `.href` and `URL#toString()` need the WHATWG serializer, so they are
  refused (`NT1024`) rather than approximated; `console.log(url)` likewise (node inspects it as
  `URL { … }`).
- **`URLSearchParams` is read-only**: `.get`/`.has`/`.getAll`/`.toString`. `.append`/`.set`/
  `.delete`/`.sort` mutate, so they are refused — consistent with immutable-by-default.
- **Memory:** a `Date` allocates NOTHING (it is a `double`), so it is never a leak and never
  needs a drop. A `URL`/`URLSearchParams` handle is an rc-registered string that codegen does
  not release, so it is on the same conservative over-retention as other heap handles — a
  bounded residual leak, never a dangling pointer (`__strLive()` will not return to 0 in a
  program that builds URLs).
- **`Object.freeze(o)` is the identity, and that is honest**: objects are already immutable
  (Stage 29), so freezing changes nothing and node's contract for `freeze` itself (same object
  back, non-writable) holds exactly. `Object.assign`/`defineProperty`/`setPrototypeOf` MUTATE
  their target and are refused with **`NT1606`** pointing at object spread.

  **`Object.isFrozen` USED to be constant-`true`, which was a silent wrong answer. It is now
  REFUSED (`NT1002`), together with `Object.isSealed` and `Object.isExtensible`.**

  The constant was justified by "objects are immutable here anyway, so nothing can ever be
  unfrozen". node does not ask that question: `isFrozen` reports whether *this object* was
  frozen, not whether the language permits mutation, so a never-frozen object is `false` there.

  ```ts
  const o = { a: 1 };
  console.log(Object.isFrozen(o));   // node: false   nativets (before): true   — exit 0 both sides
  ```

  Refused rather than answered, and the choice was between the two:

  - **A frozen bit is not available.** An object is a bare block of `i64` slots — codegen reads
    field *i* at `getelementptr i64, ptr o, i64 i` — with no header to carry one. Adding it is a
    change to the representation of every object in the language.
  - **A compile-time approximation would be UNSOUND, not merely incomplete.** `Object.freeze`
    returns the *same* object, so `const f = Object.freeze(o)` makes `Object.isFrozen(o)` true in
    node as well. Deciding it from the syntactic form of the argument would need alias analysis,
    and getting it wrong reproduces the very defect being removed — a closer-looking guess in
    place of a wrong constant. **Reject, never miscompile.**

  So `Object.isFrozen` joins `Date#setHours` and `URL#href`: refused because it cannot be
  answered honestly. `isSealed`/`isExtensible` are the same question and already landed on the
  same `NT1002`; they now share the specific hint, which names the aliasing reason and says the
  useful thing — objects here are already deeply immutable and every mutation is a compile
  error, so a freeze guard has nothing to guard.

  **`Object.freeze` itself is untouched**: node's contract for it — the same object back — is met
  exactly, and the frozen-ness it establishes was only ever observable through the three
  predicates that now refuse. (One divergence remains on it: `Object.freeze(o)` **moves** `o`
  under the ownership rules, so `Object.freeze(o) === o` is `NT1601` here where node says `true`.
  A refusal, not a wrong answer.)
- **`String#normalize` and `#localeCompare` are refused** (`NT1024`), not approximated:
  normalization needs the Unicode character database and collation needs ICU
  (`"a".localeCompare("B")` is `-1` in node but `+1` under any byte compare — §A on string
  relational order).
- **String concatenation with a `T | null` / `T | undefined` was refused** (`NT1009`, "unwrap it
  first") after it was found emitting invalid IR through `URLSearchParams#get`. That refusal has
  since been LIFTED: node's coercion is unambiguous — `String(undefined)` is `"undefined"` and
  `String(null)` is `"null"` — so `"" + x` and `` `${x}` `` now branch on the box tag and match
  node exactly. See the nullable-box section below.

### General (non-object) unions — supported narrowly, refused loudly (`G<…>`)

A union whose arms are not all object types (`number | string`, `number | number[]`) has no
discriminant field inside the value, so it is a **tagged box**: a 2-slot `[tag, value]` block
(the A2 nullable's shape) with `tag` = the arm's index in the union's canonical member order.
Members are sorted and de-duplicated, so `number | string` and `string | number` are the same
type with the same tag numbering.

What works is what dispatches on that tag: `typeof`, `Array.isArray`, `console.log`, narrowing
via either predicate, and union-typed parameters, returns and bindings. **Everything else is
refused with `NT1009`**, because it is generated from the STATIC type — which for a `G<…>`
describes the box, not the arm in it. Each was measured against node first, and each was
silently wrong rather than loud:

| Refused | What it did before the refusal |
|---|---|
| `if (x)` and every other truthiness position | tested the box POINTER — always true, so `0` and `""` came out truthy |
| `a === b` between unions | compared the two boxes' TAGS, so `1 === 2` was true |
| `JSON.stringify(x)` | rendered the box as the literal `null` |
| `"" + x`, `` `${x}` `` | emitted invalid IR |

Each is a tag dispatch away from working — the printer already is one — but reject-never-miscompile
says the refusal lands first. Arms are restricted to `number`/`string`/`boolean`/arrays with
*distinct* `typeof` tags: `number[] | {a: number}` is refused because `typeof` cannot tell those
apart, and an object arm is refused outright. A 3-arm union narrows only when ONE arm survives
the test — the else branch of a 3-arm union is a sub-union whose tags would need renumbering, so
the binding stays the full union and arm-specific uses of it are refused.

> **Pre-existing, and not fixed by that lane** — since FIXED by the nullable-box lane below.

### The A2 nullable box — reading the BOX instead of the value (three holes, now closed)

A `T | undefined` / `T | null` is a 2-slot `[tag, value]` heap block. Three places generated code
from the static type, met that pointer, and answered from it rather than from the value. Two were
SILENT; all were measured against node, not reasoned out.

| Was | node | ours, before |
|---|---|---|
| `if (x)` on any nullable | tag, then the VALUE — a present `0`/`NaN`/`""`/`false` is falsy | always **truthy** (it tested the box POINTER) |
| `JSON.stringify(x)`, present | the value | the literal `null` |
| `JSON.stringify({k: x})`, absent-undefined | `{}` — the key is **omitted** | `{"k":null}` |
| `` `${x}` `` | `"undefined"` / `"null"` / the value | invalid IR (loud) |
| `"" + x` | same | refused (`NT1009`) |

All now match node. Two consequences worth knowing:

- **Truthiness was fixed for more than nullables.** The same fall-through — "not a boolean or a
  number, so treat it as a string and call `js_str_len`" — also reached objects and `Dyn`. `[]` and
  `{}` came out **false** where node says every object is truthy, and `JSON.parse("0")` came out
  true. `truthyOf` is exhaustive now, and a type on neither list throws rather than defaulting, so
  the next box type added is a compiler error instead of a fresh silent wrong answer.
- **`JSON.stringify(x)` at the ROOT of a `T | undefined` is REFUSED** (`NT1005`). node returns the
  undefined VALUE there, not a string; our `JSON.stringify` is typed `string`, so `null` was wrong
  and `"undefined"` would be wrong the moment the result is used as one. Use `x ?? null`, or
  `T | null` — which serializes as `null` exactly like node. As an object FIELD it is fine: the key
  is omitted, as node does. An `undefined` inside an ARRAY is unaffected — `null` is what node
  writes there.

### A NULLISH guard did not compose with a TAG narrowing (`E | undefined`) — closed

The **fourth** hole in the same box, and the only one that was never written down. A discriminated
union behind a nullable — `E | undefined`, `E | null` — could be proved present and then could not
be narrowed:

```ts
interface A { kind: "A"; left: number }
interface B { kind: "B"; right: number }
type E = A | B;
function f(e: E | undefined): number {
  if (!e) return -1;                  // proves e is present
  if (e.kind === "A") return e.left;  // NT2001 — "narrow it first (`if (x.kind === "…")`)"
  return 0;
}
```

node prints `7`. We refused it, **with a hint prescribing the exact line above it**. Dropping
`| undefined` made the identical body compile, which is the tell.

**Why.** The two narrowings are different mechanisms and did not meet. A nullish guard is a
control-flow `NarrowFact` carried on `Checker.narrowStack` (`withFacts`): the BINDING still says
`?UU<…>`, and each read is stamped `narrowed` so codegen unwraps the box there. A tag test is a
shadow BINDING (`Checker.narrowInto`). `discriminantRead` asked the binding for its type, saw a
nullable rather than a `U<…>`, and declined — so no tag narrowing was ever attempted.

**What changed** (`src/checker.ts`, `src/codegen.ts`):

- `discriminantRead` reads the type through `accessPath`, i.e. **as narrowed at that point**,
  not off the binding. That is the whole fix in one line; the rest is making it sound.
- A shadow declared over a name whose STORAGE is a box carries `Binding.nullBox`, and reads of
  such a name are stamped `narrowed` too. Without it the member's field layout would have been
  applied to the box POINTER — a silent wrong answer, not a diagnostic.
- `narrowRead` (codegen) applies the member type to what comes OUT of the box, the same retype the
  `Identifier` case already applied to a non-nullable union binding.
- The tag walk now runs with the arm's own facts live (`narrowTagsWith`), at the `if` arms and
  across `&&`/`||` short circuits — otherwise `if (e !== undefined && e.kind === "A")` still had no
  union to discriminate when the second operand was read. This is the fourth wiring of
  `narrowTagsInto`.
- `truthyOf` gained the discriminated-union case: `if (e)` on an `?UU<…>` reaches it through
  `truthyNullable`, and a union value IS the member object pointer, so it is always truthy. (A
  GENERAL union `G<…>` is deliberately NOT in that list — it is a box that can carry `0` or `""`.)

Every in-place spelling was affected and all are fixed: `!e`, `e === undefined`,
`if (e !== undefined) { … }`, `if (e) { … }`, on `?U` and `?N`, with `if` and with `switch`, for a
parameter and for a local `let`/`const`. Only the spellings that introduce a NEW binding —
`const q = e!`, `e ?? fallback` — worked before, because those bind a plain `U<…>`. A nullable
RECORD (a single object type, not a union) was never affected.

**~~Still refused, on purpose:~~ NOW ACCEPTED.** A bare nullable as a `&&` operand
(`if (e && e.kind === "A")`) used to be `NT2001: '&&' operands must be matching …`, and the
reason given was the VALUE: node's `a && b` evaluates to `a` when `a` is falsy, so the
expression's type is a general union we cannot represent. That reason is true and it is
exactly the thing a CONDITION never asks for — `Boolean(a && b)` is `Boolean(a) && Boolean(b)`
for every pair of JS values — so the refusal was wider than its own justification. In
truthiness position (`if`/`while`/`do`/`for`, a `?:` test, the operand of `!`, and
recursively the operands of a truthiness-position `&&`/`||`) the operands may now have any
types; the result is `boolean` and codegen short-circuits on `truthyOf` of each side.
`if (e && e.kind === "A")` and `if (o && o.n > 1)` both compile and match node.
Outside a condition the value rule is unchanged — `const x = b && s` is still `NT2001`, for
the reason above. See test/logical-condition.test.ts.

**And the hint was fixed.** "Narrow it first" was one fixed sentence, and three shapes reached it
with a tag test already written. `Checker.narrowAdvice` now says which one it is:

| Receiver | What it says now |
|---|---|
| a plain name, never narrowed | narrow it first — `if (e.kind === "A")` or `switch (e.kind)` |
| a PATH (`o.inner`, `this.e`) | narrowing tracks a plain NAME — bind it first (`const v = o.inner;`) and narrow `v` |
| already narrowed to a SUB-union (`case "A": case "B":` sharing a body) | *which of the three clauses below the field fails*, and the member that fails it — see the next row |

Each of the three workarounds it prescribes was verified to compile and match node.

**The sub-union row was itself untruthful, and is now split three ways.** It used to read
"narrowed here to MORE THAN ONE member (`"A"`, `"B"`), so only the shared tag is readable — give
each tag its own arm". That asserts a *rule*, and the rule is false:
`test/unions/shared-field.ts` reads a non-tag field off a two-member narrowing on every run
(`case "Bin": case "Log": return depth(n.left)`). Narrowing to several members is not what makes
a field unreadable; failing one of the three clauses below is. So the message now names the
clause and the member:

| Why the read fails | What it says |
|---|---|
| absent from a member | `'v' is not in every surviving member — "C" does not have it` — give each tag its own arm |
| present everywhere, **different slots** | `'n' is in every surviving member with the same type, but at DIFFERENT slots ("A" slot 1, "B" slot 2)` — either make the layouts agree **or** give each tag its own arm |
| present everywhere, **different types** | `'v' is in every surviving member at the same slot, but at DIFFERENT types ("A" number, "B" string)` — give each tag its own arm |

Only the slot row offers the layout option, because it is the only one with a layout fix.
**Both of the fixes that row prescribes are compiled against node** — stdout and exit code — in
`test/unions.test.ts`, on the very fixture that produces the message.

### A SHARED field is readable on an un-narrowed union — but only at an agreeing slot

`tsc` reads a property that is present in **every** surviving constituent, and types it as the
union of the per-member types. The compiler's own first self-hosting blocker was exactly that
read, in `src/ast.ts`:

```ts
case "BinaryExpr": case "LogicalExpr": return exprLoc(e.left);
//                                                     ^ NT2001 (as it read at the time) —
//                                                       narrowed here to MORE THAN ONE member,
//                                                       so only the tag is readable
```

That now compiles. **Our rule is tsc's plus two clauses, and they are a REPRESENTATION question
rather than a typing one.** A `U<…>` value IS the member object pointer — no box, no per-member
vtable — so a field read lowers to one `getelementptr` at a *constant* slot. So
`unionCommonField` (`src/ast.ts`) admits a field only when it is:

1. present in every surviving member — tsc's clause; and
2. at the **same slot index** in every one of them; and
3. of the **same type** in every one of them, once literal tags are widened.

The discriminant is the degenerate case of that rule, not a special one (in every member at one
index by construction, every member's literal tag widening to `string`), so the tag read and the
shared-field read are a single code path in both the checker and codegen.

**Clauses 2 and 3 are load-bearing, and were proved by mutation rather than argument.** Deleting
either from `unionCommonField` produces a silent wrong answer one `if` away from the accepting
path:

| Mutation | Program | node | nativets with the guard deleted |
|---|---|---|---|
| slot check removed | `{kind:"A",n,other}` / `{kind:"B",other,n}`, read `.n` | `222` | `111` — it read `other` |
| type check removed | `{kind:"A",v:number}` / `{kind:"B",v:string}`, read `.v` | `hello` | `2.1254528236e-314` — a string pointer as a double |

Both are permanent tests in `test/unions.test.ts`; the accepting side runs against node as
`test/unions/shared-field.ts`.

**What stays refused, and what would lift it.** A field at DIFFERENT slots, or with different
types, keeps its `NT2001`. Two strictly wider *compiler* designs exist and neither is taken:
making the compiler lay a union's members out so common fields agree on a slot (a layout change
reaching every object mechanism), and branching on the tag to pick the slot (a runtime test on
every such read). A sound partial rule beats a risky complete one. The `narrowAdvice` row above
therefore fires only when the receiver *is* narrowed to several members AND the field fails one
of the three clauses.

**But agreeing slots can be arranged in the SOURCE, and for `src/` they are — this is how the
stage-1 first blocker was cleared.** The rule is about layout, and layout is declaration order,
so a program that wants a shared read can simply declare the field at the same position in every
member. Nothing in the compiler moves. `src/ast.ts` now does this deliberately: **`body` is slot
1 in all six body-carrying statements** (`WhileStmt`, `DoWhileStmt`, `ForStmt`, `ForOfStmt`,
`ForInStmt`, `BlockStmt`). It had drifted to slots 2, 2, 4, 4, 3 and 1, which made

```ts
case "WhileStmt": case "DoWhileStmt": case "ForStmt":
case "ForOfStmt": case "ForInStmt": case "BlockStmt": walk(s.body);
```

in `src/parser.ts`'s `valueReturns` an `NT2001` — and that arm was the **first blocker of
`cli`, `coverage`, `driver`, `modules`, `parser` and of the stage-1 program itself**. Every one
of the six had the field, all six at `Stmt[]`; six declarations had simply drifted apart. Slot 1
is the only value available, since `BlockStmt` is `{kind, body}` and can put `body` nowhere else.
Object *literals* are unaffected — the checker reorders a literal to its contextual type — so no
construction site changed. The invariant is gated by a test, not left to a comment: the identical
rule for `WhileStmt`/`DoWhileStmt` was documented in `ast.ts` and drifted anyway.

#### The union field WRITE is refused too — and it is a gap, not a representation limit

Everything above is about the **read**. `e.f = v` on an un-narrowed union receiver is also
refused, and until now it was refused *with the wrong reason attached*. The refusal stays; only
the diagnostic changed.

**What was wrong.** The hint walked users in a circle, and each step is reproducible:

| step | source | what nativets says |
|---|---|---|
| 1 | `interface A {kind:"A";ty?:string}` / `B`, `e.ty = "n"` on `A\|B` | `NT1606` — *"objects are immutable … To assign in place instead, declare the record `@@mutable`"* |
| 2 | take that advice: `//@@mutable` on both members | `NT1606` **again** — and the `@@mutable` sentence has silently **vanished** |
| 3 | take what is left, `{ ...e, ty: "n" }` | `NT2001` — *"an object literal for `A{…} \| B{…}` must set 'kind' to one of the literals"* |

Step 2 is the mechanical cause: the hint chose its branch on `isObjectTy(ot)`. Two structurally
identical *undecorated* members collapse to a single object type, so step 1 took the object
branch; adding `@@mutable` **tags** them, the type becomes a real `U<…>`, `isObjectTy` goes
false, and the hint dropped to the bare-spread fallback — while still opening with "objects are
immutable" about two records the user had just declared mutable. The spelling that actually
works was never mentioned at any step.

**The reason is a missing feature, not an unrepresentable one** — which is worth stating because
the old message implied otherwise. The **read** of that same field compiles today and agrees
with node: `ty` sits at slot 1 in both members, `unionCommonField` proves the constant slot, and
`e.ty` on an un-narrowed `U<…>` works. So most of the machinery a store needs already exists;
nobody has built the write half. `Checker.allUnionMembersMutable` exists purely to tell the two
causes apart in the message and changes no decision.

**The fix that compiles**, and what the hint now names — narrow on the discriminant first, then
assign. Both spellings are run against node in `test/mutable-records.test.ts`:

```ts
function annotate(e: E): void {
  if (e.kind === "Num") { e.ty = "number"; } else { e.ty = "string"; }   // works
}
function annotate2(e: E): void {
  switch (e.kind) { case "Num": e.ty = "number"; break; case "Str": e.ty = "string"; break; }
}                                                                        // also works
```

Inside the arm the member is known, the store lands in place, and every handle observes it. The
dead-end spread of step 3 is pinned as `NT2001` in the same file, so the hint cannot drift back
to it.

**Why this matters beyond the message.** It is the shape the compiler's own source is built out
of: `Renamer.expr`, `Checker.type`, `Checker.retypeLiteral` and five other functions all write
`e.ty = v` on an `Expr`. Those sites are *not* covered by the fix above — see the census under
"`@@mutable` on records does not scale to the AST" in `docs/self-hosting.md`.

### `break` is not `return` — one conflation, one false refusal and four wrong answers (closed)

Two passes asked "does this code leave?" and both got `break` wrong, in opposite directions.

**The false refusal.** A BRACED case body — `case "X": { … return …; }` — read as *falling
through*, so the next case was narrowed to both tags and its member read refused:

```ts
switch (n.kind) {
  case "A": { const x = n.a; return "A" + x; }
  case "B": return "B" + n.b;   // NT2001 — 'b' is not in every surviving member
}
```

`leavesBlock` tested only the KIND of the case body's last statement, and a braced body's last
statement is a `BlockStmt`. Nothing was ever miscompiled — codegen terminates the block correctly
— these were refusals of programs node runs. `src/` writes that shape **181 times** (counted with
our own parser; a line-based grep undercounts it).

**The wrong answers**, all in definite assignment (NT1600), all the same root cause: a `break` or
`continue` path was treated as *diverging*, so it was dropped from the assignment intersection and
the code after the construct was never analyzed at all. Each printed the slot's zero where node
prints `undefined`:

```ts
switch (c) { case 1: x = 1; break; default: break; }   return x; // 0, not undefined
switch (c) { default: { if (b) break; x = 1; break; } } return x; // 0, not undefined
do { if (c) break; n = 7; } while (false);             return n;  // 0, not undefined
do { continue; } while (false);                        return n;  // 0, not undefined
```

**What changed** (`src/checker.ts`). The return value now answers only "does control reach the
statement AFTER this one?" (`DAExit` = `"fall" | "left"`), because a path that leaves by `break`
or `continue` is not lost — it is RECORDED, with the flow it carries, in a `DAEscapes` collector.
That split is the fix: a `break` halfway down a body escapes exactly as much as one at the end,
and no single return value can carry a flow from the middle.

`breaks` land at the enclosing switch-or-loop's EXIT; `conts` land at the enclosing loop's TEST,
which may then fall out of the loop. Both are live incoming paths to the construct that owns them
and join its merge. Ownership follows the language: a `switch` shadows `breaks` and passes `conts`
through to the loop, a loop shadows both — neither carries a label here, so "nearest enclosing" is
the whole rule. Only `return`/`throw`/`process.exit` truly diverge.

`while`/`for`/`for-of`/`for-in` were never affected: they may run zero times, so they keep nothing
their body assigns, and the entry flow is already a subset of every escape path's. `do…while` is
the one loop whose body always runs and whose assignments are therefore kept — which is exactly
why it is the one loop where the escape paths change the answer.

`leavesBlock` then **delegates** to that same analysis in a shape-only mode (`tracked === null`:
track nothing, prove nothing, refuse nothing) rather than keeping a second, weaker model of
control flow. That is what closes the false refusal, and it only became sound once the `break`
conflation above was fixed: without it, `case "X": { switch (y) { default: break; } }` would have
read as *leaving*, and the next case's member read would have been wrongly ACCEPTED.

**Oracle.** The TypeScript conformance suite is not on disk, so the cases are derived, not mined;
but all twelve were run through `tsc --strict` as the same program, and tsc's verdict agrees with
ours on every one — the six that end (`return`, `throw`, `break`, a nested block, an if/else
returning on both arms, a `try` whose `finally` cannot rescue it) and the six that fall through
(an `if` with only one arm returning, a `try` whose `catch` falls out, an inner `switch` whose
arms only `break`, a side effect with no terminator, an empty braced body, a bare fallthrough).

**Not fixed, and still a gap:** `leavesFunction` — read only by the exhaustive-tail-switch
diagnostic — is still the shallow last-statement test, so a tail switch whose arms are all braced
does not get its missing-tag diagnostic. That direction is a MISSED refusal, not a wrong answer,
so it was left alone rather than widened here.

### `JSON.stringify` — the default-to-`null` fall-through (closed)

`genJsonStringify` handled number/boolean/string/`Date`/nullable/array/object and then
ended with `return { v: this.mod.intern("null"), ty: "string" }`. **Every type nobody had
written a rule for serialized as the literal `null`** — the same shape as the `truthyOf`
fall-through above, and with the same property: it absorbed each new box type as it was
added, silently. Six were already wrong, measured against node (stdout and exit code, all
exit 0):

| Was | node | ours, before |
|---|---|---|
| `JSON.stringify(new Set().add("a"))` | `{}` | `null` |
| `JSON.stringify(new Map().set("a","1"))` | `{}` | `null` |
| `JSON.stringify({m: aMap, ok: 1})` | `{"m":{},"ok":1}` | `{"m":null,"ok":1}` |
| `JSON.stringify(new Uint8Array(2))` | `{"0":0,"1":0}` | `null` |
| `JSON.stringify({f: aFunction, ok: 1})` | `{"ok":1}` — key omitted | `{"f":null,"ok":1}` |
| `JSON.stringify(JSON.parse(s))` | the JSON back | `null` |
| `JSON.stringify(undefined)` | the undefined VALUE | `null` |

The **nested** rows are the dangerous ones: they sit inside an otherwise-correct object, so
nothing about the output looks wrong.

**The fix is the fall-through, not the six rows.** `genJsonStringify` is exhaustive now and
`internalError`s on a type with no rule, and `checkJsonStringifyArg` in the checker walks
the SAME shape first, so anything with no node-exact rendering is refused with `NT1005`
before codegen sees it. A seventh box type is a compile error, not a seventh wrong answer.

What is now RENDERED, and why it is exact rather than approximate:

- **`Map` / `Set` → `{}`.** Neither has any own ENUMERABLE property — the contents live in
  internal slots `JSON.stringify` never walks — so `{}` is what node prints for every Map
  and every Set, whatever they hold. A constant, not a guess.
- **`Uint8Array` → `{"0":1,"1":255}`.** A typed array's own enumerable properties ARE its
  indices, so node writes an index-keyed OBJECT, not the array form. Empty is `{}`, inline
  even under an indent. Pretty-printing is supported (`runtime/nt_bytes.c`, `nt_bytes_json`).
- **a FUNCTION-typed object field → the key is omitted**, as node does. Unlike a
  `T | undefined` field this is a COMPILE-TIME decision, so an object of only function
  fields is `{}`.

What is REFUSED (`NT1005`), each with the fix named:

- **a function at the ROOT**, and the bare **`undefined`** — node returns the undefined
  VALUE, which a `string`-typed `JSON.stringify` cannot; the `T | undefined` precedent above.
- **a `Dyn`** — `JSON.stringify(JSON.parse(s))`. node round-trips it; nativets has no
  `Dyn`→JSON walk in the runtime, so it is refused rather than rendered `null`. Keep the
  original string, or narrow (`d as T`) and stringify the `T`. A `Dyn`→JSON runtime
  function is the obvious follow-up.
- **`URL` / `URLSearchParams` / `Response` / `Headers` / `TextEncoder` / `TextDecoder`** —
  no renderer here. (node's answers are known — `u.href` for a URL, `{}` for the rest — so
  these are addable; they are refused rather than guessed until measured case by case.)
- **anything with a `toJSON`** — a class declaring a `toJSON()` method, or an object literal
  with a callable `toJSON` field. `toJSON` REPLACES the value: node calls it and serializes
  what it RETURNS, at every position (test262
  `built-ins/JSON/stringify/value-tojson-result.js`; `JSON.stringify([q])` is `[{"y":2}]`).
  nativets builds the serializer from the STATIC FIELDS, so it ignored the method and
  emitted the raw shape — `{"x":1}` where node gives `"P!"`. Call it yourself:
  `JSON.stringify(x.toJSON())`. Only a CALLABLE `toJSON` is refused — node ignores a
  non-callable one (`value-tojson-not-function.js`), so `{toJSON: 1, a: 2}` still
  serializes as `{"toJSON":1,"a":2}` exactly as node does.

  This one is worth calling out as the pattern: a class instance is STRUCTURALLY an object
  here, so it fell into the object arm and was "handled". Making a fall-through exhaustive
  closes the types with no arm; it does not close the types that reach the WRONG arm.

The ARRAY-element position is unreachable for all of these: `Map<…>[]`, `Uint8Array[]` and
an array of functions are `NT1001` ("arrays of X is not supported yet"), which predates
this. `checkJsonStringifyArg` still carries the `"element"` case, so lifting NT1001 yields a
refusal rather than a fresh wrong answer.

**Two more found while pinning, both emitting output that was not JSON at all** — it did
not survive its own `JSON.parse`:

- **a non-finite number**: `JSON.stringify(NaN)` was the token `NaN` (node: `null`), and
  `{"n":NaN}` is not parseable JSON. JSON has no non-finite number (RFC 8259 §6). Cause:
  JSON reused `js_num_to_str`, which is `String(x)`, where `NaN` is right. Now `nt_json_num`.
- **a control character**: `JSON.stringify("ab")` embedded a RAW `0x01` byte (node:
  `"ab"`). RFC 8259 §7 forbids a literal character below U+0020 in a string.
  `js_json_quote` escaped only `" \ \n \t \r` and passed the other 27 through; it now takes
  the short form for `\b \f \n \r \t` and `\u00XX` for the rest, as node's QuoteJSONString
  does. U+007F is not a JSON control character and stays literal, as in node.
### Optional element access `a?.[i]` — the guard is on the BASE only

`a?.[i]` short-circuits the whole chain to `undefined` when `a` is `null` or `undefined`, and
does **not evaluate the index** in that case (observable through a side effect — tested). It is
the same lowering as `a?.b`: one guarded unit with a shared short-circuit join, so a trailing
non-optional link (`a?.[0].name`) is skipped too, and the result is an A2 nullable box like every
other `?.` result. All node-differential.

The one deliberate disagreement is **not** new, and is the reason this entry exists: `?.` guards
the base being nullish, and changes **nothing** about the index rule. A *present* base indexed out
of range still faults — `NT2002` when the length and index are both statically known, otherwise
the Stage 41 runtime panic — where node yields `undefined`. So:

| | node | ours |
|---|---|---|
| `a?.[0]`, `a` absent | `undefined` | `undefined` |
| `a?.[idx()]`, `a` absent | index not evaluated | index not evaluated |
| `a?.[99]`, `a` present, len 2 | `undefined` | **panics** (Stage 41) |

Reading the guard as "make this read safe" is therefore wrong: it makes the *base* safe. Use
`.at(i)` for node's out-of-range `undefined`, exactly as with a plain `a[i]` — **but only for a
NON-NEGATIVE WHOLE `i`**. `.at(-1)` is node's *last element* and `.at(1.5)`/`.at(NaN)` truncate,
none of them `undefined`, so they are not substitutes for `a?.[-1]` / `a?.[1.5]`; see the
headline section's `.at` table for the full trap. The panic's own `help:` line now says which of
these applies, per accessor and per index.

**`?.` in a write position is refused (`NT0001`) — this is agreement with node, not a
divergence.** ECMAScript's `IsValidSimpleAssignmentTarget` returns `false` for an
`OptionalExpression`, so `a?.b = v`, `a?.[i] = v`, `a?.b++` and `a?.[i]++` are all *early*
errors: node reports a `SyntaxError` before running a line (test262
`optional-chaining/static-semantics-simple-assignment.js`, `…/update-expression-postfix.js`).

We used to **accept** these. The refusal is in the parser, because it is a syntax rule rather
than a type rule: with a genuinely mutable receiver (`Uint8Array`, a `@@mutable` record) every
type rule was satisfied and `b?.[0] = 7` lowered to a real store — a program node rejects
outright, silently compiled. A nullable receiver happened to be caught, but only by an
unrelated `NT1606` about array immutability, which was the wrong reason and the wrong message.

### Actor messages (B3 v5) — structured messages are COPIES, and the shape is checked

node has no actors, so the whole surface (`spawn`/`send`/`receive`) is behavioral, not
node-differential (`test/actors*.test.ts` assert exact stdout under the deterministic
cooperative scheduler). Within that surface, three deliberate rules:

- **A sent record/array is DEEP-COPIED, always.** `send(pid, obj)` gives the receiver a
  private value; the sender's object is untouched and unaliased (isolation is the actor
  model's whole point, and immutability makes the copy semantically invisible — nothing can
  observe the difference except identity, and `===` between actors is meaningless anyway).
  The copy is the Stage-40 `structuredClone` walk, extended to copy **string leaves** too so
  a receiver's record can never point into the sender's refcounted buffer.
- **The shape is checked at runtime, and structurally — including FIELD ORDER.** A message
  carries its canonical type encoding (`{kind:string,n:number}`); a receive compiled for a
  different one aborts with a diagnostic naming both shapes and **exit 70**, rather than
  reinterpreting the slots. Because our object types are insertion-ordered everywhere,
  `{a:number,b:string}` and `{b:string,a:number}` are *different* shapes — TS would call them
  the same type. This is conservative (it rejects a valid program, loudly, never miscompiles
  it): write the receiver's annotation in the sender's field order. A **selective** receive
  treats a foreign shape like a foreign kind — skipped, left queued in order (the save queue).
- **Un-copyable message types are refused at compile time (`NT1021`).** A function value
  captures the *sender's* environment; a `Map`/`Set`/`Uint8Array`/`Response` handle has no
  deep-copy walk. Messages are `number`, `string`, or a record/array of those, recursively.
  A **nullable** (`T | undefined`) is refused as a *sent* value too — it is a two-slot tagged
  box, so sending one would put the box pointer on the wire for a receiver expecting a `T`
  (this used to compile and print garbage). A message is always present: unwrap it first
  (`send(pid, x ?? fallback)`). As a *receive annotation* `T | undefined` keeps its A2
  meaning — "a `T`, or a timeout".

### An ARRAY OF FUNCTIONS is `NT1001` — and the reason is the type ENCODING

`((n: number) => number)[]` was already refused in its array-literal spelling ("arrays of X is
not supported yet"). The ANNOTATION is now refused at the same code, in the type parser, and the
reason is worth recording because it constrains whoever lifts the refusal.

Types are strings. The function encoding is `(p1,p2)=>ret` and the array encoding is a bare
`${elem}[]` suffix with **no parentheses**, so:

```
makeFuncTy(["number"], "number[]")        === "(number)=>number[]"   // (n) => number[]
makeFuncTy(["number"], "number") + "[]"   === "(number)=>number[]"   // ((n) => number)[]
```

The two types are **the same string**. `isArrayTy` used to answer *array* for both — including
for a plain arrow returning an array, which put the closure in the scope's drop set and freed it
with `nt_arr_free`; `const g = () => arr` died with exit 255 and no diagnostic. It now answers
*function*, which is correct for the shape that occurs and wrong for the one that does not.

That is safe only while arrays of functions cannot exist, so the ambiguous string is no longer
constructible from source: the parser refuses the suffix where it would form it. **Implementing
arrays of functions therefore starts with the encoding** (parenthesize the element, or stop
encoding types as strings) — not with lifting the refusal. Pinned in
`test/arrow-returns-array.test.ts`.

Answering *function* also took closures OUT of the scope drop set entirely, so from that fix
until Stage C's closure-env drops **every bound arrow leaked its environment** — one heap block
per arrow evaluated, so a bound arrow in a 100-iteration loop leaked 100. Corruption traded for
an unbounded leak, which was the only direction available at the time and the safe one. It is
now a BOUNDED leak: `test/closure-env-drops.test.ts` frees the env as the OBJECT it is
(`nt_obj_free`, never `nt_arr_free`), shallowly, and only for a `const f = <arrow literal>` whose
name is used nowhere but as the callee of a direct call — so an env that ESCAPES (returned,
aliased, passed as an argument, stored, captured by another closure) is still never freed. The
naive version of this — putting function types back into `isLinearTy` — was measured and frees
the escaping-counter idiom's live env: exit 255. See docs/ROADMAP.md's Phase C.

### A function DECLARATION used as a VALUE — the diagnostic was FALSE, and the fix is a shim

```ts
function dbl(n: number): number { return n * 2; }
apply(dbl, 21);        // was: error[NT2001]: 'dbl' is not defined
```

`dbl` **is** defined — it calls fine as `dbl(21)` on the next line. The cause was a two-table
split. `check` registers every top-level `FuncDecl` in the SIGNATURE table (`functions`), which
is keyed by name and consulted only at direct CALL sites, and it never binds the name in the
value `Scope`; so `scope.lookup("dbl")` missed and the `Identifier` case reported the one thing
that was certainly untrue. The same program written `const dbl = (n: number) => n * 2` always
worked, which localizes it to BINDING rather than codegen — the machinery to *call* a function
value already existed and was exercised, only the machinery to *produce* one from a declaration
did not.

Across a module boundary the message was worse still, because the linker has renamed the symbol
by then: `'_m0_eraseOne' is not defined`, naming a spelling that appears nowhere in the source
and cannot be grepped for.

**Why a shim.** A function value is a heap block `[fn_ptr, cap0, …]` and `callClosure` passes
that block as an implicit leading `ptr` argument. A top-level function has no such parameter, so
its symbol cannot go into slot 0 directly — storing it there would shift every real argument by
one, which is a wrong answer rather than a crash. Codegen therefore emits one trampoline per
function used this way (`ModuleGen.fnValue`, the lazy pattern `cmpShim`/`actorEntry` already
use), taking the env and ignoring it.

**Why it is cheaper than a closure.** A declaration captures nothing, so its block is a
compile-time constant: a `private constant [1 x i64]` global, not an `nt_obj_new`. That removes
the ownership question instead of answering it — no allocation, so nothing to own, nothing to
drop, no leak on the argument path and no double free when the same function is passed twice.
One block per function, which is also a CORRECTNESS requirement and not merely a saving: node
says `dbl === dbl`, so both references must yield the same pointer. Verified clean under
ASan+UBSan with `-fno-sanitize-recover=all`.

**Hoisting is supported.** node hoists function declarations, so a reference may precede the
textual definition; the signature table is fully populated in pass 1, before any body is checked,
so this costs nothing and refusing it would have been the divergence.

Two shapes stay refused (`NT1003`), and both are ABI facts rather than missing cases — a call
through a function value passes exactly the arguments the function TYPE spells, while the
machinery that supplies a **default** or packs a **rest** array lives at the direct call site
and nowhere else:

| shape | verdict |
|---|---|
| `function f(a, b = 2)` / optional `b?` | `NT1003` — `b` would enter unwritten. Hint: wrap in `(a0) => f(a0)` |
| `function f(...ns: number[])` | `NT1003` — the rest array is packed at the call site. Same hint |
| generic `function f<T>(…)` | `NT1013`, its own pre-existing and more precise message |
| point-free `xs.map(f)` | unchanged — refused a layer earlier by the INLINE-ARROW rule above, not by this |

That last row is why the `src/` census reads the way it does. Of 8 value-position references to
a top-level declaration in the LINKED stage-1 program, **7 are point-free array HOFs** blocked by
`.map`/`.every`/`.some` demanding a literal arrow — a `const` bound to an arrow cannot pass those
either, which is what proves the two defects independent — and exactly **1** is unblocked here:
`mapTypesDeepExpr(arrow, eraseTypeParams)` at `src/parser.ts:3359`. `blocker-metric` cannot show
even that one clearing, because `Parser.parseAssign` is masked by an `NT1606` twenty-six lines
above it; the cross-module fixture in `test/modules/fndecl-value/` verifies it directly instead.
The value of this entry is the false diagnostic, not the count.

Both hints are RUN in `test/fndecl-value.test.ts` and asserted against node. Shadowing is proved
by mutation: a function-typed parameter named `dbl` that is forwarded onward as a value resolves
to the function's constant block if the `isBound` check is hoisted, printing **42 at exit 0**
where node prints 22.

### `.find` / `.findLast` — one element shape opens, two stay refused, and the result is a BORROW

`.find` over a `(T | undefined)[]` compiles. Over anything else heap-shaped it is `NT1001`, and
the three cases have three different reasons — which is the whole content of this entry, because
they had one shared (and partly wrong) reason before.

| element | verdict | why |
|---|---|---|
| `number` / `string` / `boolean` | compiles | the result is a freshly boxed **copy**; it owns itself |
| `(T \| undefined)[]` | compiles | the element **is** a `[tag,value]` box; hand that box back |
| `(T \| null)[]` | `NT1001` | the result is `T \| null \| undefined` — **two** nullish arms |
| `Loc[]`, `Loc[][]`, `U<…>[]` | `NT1001` | a fresh box owning a pointer the array still holds |

**Why `(T | undefined)[]` is not a relaxation of the aliasing rule.** node's `.find` cannot
distinguish "found `undefined`" from "found nothing" — both answer `undefined` — so one nullish
arm is the entire answer and the hit path returns the element's own box unchanged. Nothing is
allocated and nothing is re-wrapped. Re-wrapping it *was* the bug: a box holding a box, described
by a static type with one level, so a field read loaded the inner box's **tag** and bit-cast it
to a double. `node r 7 14` against `nativets r 1e-323 2.1326037835e-314`, **exit 0 on both
sides**.

**Why `(T | null)[]` is refused rather than answered.** `?N`/`?U` is a one-arm encoding, and node
tells the arms apart (`x === null` against `x === undefined`). The old code path did not refuse —
it called `makeNullable("undefined", el)`, which computes `baseTy("?Nstring")` first and answers
`?Ustring`, dropping the null arm from the static type with no diagnostic. Unreachable at the
time because the element guard sat in front of it; refused by name now, so lifting that guard
cannot resurrect it.

**The result is a BORROW.** `const hit = xs.find(p)` over a linear element type binds a name that
aliases an element the array still owns, so moving it out is `NT1604` — the same answer a `for-of`
element over a linear array already gives (rustc E0507). Without that rule
`const h: Loc = hit` under a narrowing becomes a second owner and frees the array's element:
`node after 3 4` against `nativets after 1e-323 1e-323`, again exit 0 on both sides.

**The refused case has a compilable hint**, and it is not the obvious one. `const hit = xs[i]!`
is `NT1605` — binding an element is a second owner — so the hint says to *read through* the
index, which is the spelling `fieldType` (`src/ast.ts`) already uses for exactly this reason:

```ts
const i = xs.findIndex((l) => l.line === 3);
if (i >= 0) console.log(xs[i]!.col);
```

`.at` carries the identical element guard and has NOT been widened; it will need the same three
decisions. Pinned in `test/find-borrow.test.ts`, both guards proved by mutation.

### `.forEach` — the inline arrow compiles; only the POINT-FREE spelling needs a function value

`.forEach` was refused unconditionally by `inferArrayMethod`, before it looked at the argument,
with the message *"array .forEach (needs first-class function values)"*. That message was wrong
for most of the calls it refused. A census of `src/` run through the compiler's **own parser**
(line-based `grep` undercounts the multi-line spellings — it reads 55 where a real parse reads
68) puts the split at:

| spelling | sites in `src/` | verdict |
|---|---|---|
| `xs.forEach((x) => …)` — inline arrow | **78** | compiles (this entry) |
| `xs.forEach(go)` — point-free | **32** | still `NT1003`, and it really does need a function value |

An inline arrow is the shape `.map`/`.filter`/`.reduce` have always inlined into a loop, so it
needs no function value at all: `.forEach` is `.map`'s loop with no output array and the callback
result discarded. It reuses the same `hofLoop` skeleton, the same `freshenHofArrow` per-inlining
slots and the same `prepHofLocals`, so an inlined `.forEach` body is a **scope** on exactly the
terms a `.map` body is — its nested-block locals are freed per iteration, and a value it merely
captures is not. Only the refusal's *message* changed for the point-free half, to one that names
which spelling is which; `xs.forEach((x) => go(x))` is the hint, and it compiles.

Two limits, both matching `.map` rather than inventing anything: the callback took **`(elem)`
only**, and `.forEach` itself evaluates to `void`. The first of those has since been lifted —
`(elem, index)` is bound, see the entry below — and only the `array` parameter is still refused.

A callback `return` means **"next element"**, not "leave the enclosing function". Codegen carries
that on `hofReturnStack`; `.forEach` pushes a *discard* frame, because node throws the result away
and a body of type `void` has no slot to store into (`alloca void` is not IR LLVM accepts). The
returned expression is still evaluated, for its side effects.

Pinned in `test/foreach.test.ts`; the drop, capture and name-collision guards are proved by
mutation (deleting `freshenHofArrow` reproduces the `2.1578754706e-314`-at-exit-0 shape).

### HOF callbacks bind `(elem, index)`; only the trailing `array` parameter is refused

node passes `(element, index, array)` to `.map`/`.filter`/`.forEach`/`.flatMap`/`.some`/`.every`/
`.find*`, and `(acc, element, index, array)` to `.reduce`. We accepted only the shortest prefix of
each and refused the rest with **`NT2001 ".map callback takes (elem)"`**.

That refusal was *safe* — an unbound `i` reads a frame slot nothing ever wrote — but it was wrong
twice over. It reported a **type error on valid TypeScript**, and it was the first blocker in **17
of the compiler's own functions**, including two spellings `src/` itself recommends in NT hints
(`src/parser.ts` advises `xs.filter((_, i) => i !== 0)`; `src/checker.ts` carries a comment
apologising for writing an indexed loop "rather than `.every((m, i) => …)`"). Neither compiled.

The index needed no new machinery. These HOFs do not build closures — they **inline the arrow body
into a loop**, and that loop already keeps its counter in a `number` slot (`hofLoop`'s `idx`,
`genSearchHof`'s own `idx`). Binding the parameter is one extra `store` from the slot the loop is
already stepping. Reusing that slot rather than a separate forward counter is also what makes
`.findLast`/`.findLastIndex` node-exact: they walk **backwards**, so their index counts *down*.

`.reduce` is the exception to every "one rule covers all" instinct here — its index is parameter
**two**, not one, because the accumulator comes first. The arity rule lives in one place
(`hofCallbackParams` in `src/checker.ts`) and is *told* the leading prefix rather than deriving it.

The trailing **`array`** parameter stays refused. It is the receiver the loop is walking, so
binding it would make the body a second owner of an array the caller still owns — the aliasing
`.find` on a heap element already refuses one method over. Zero of the ~90 HOF callbacks in `src/`
use it. What it must *not* do is blame the index, so it gets its own message naming the `array`
parameter, and a callback that binds **fewer** than the leading parameters (`xs.map(() => 1)`,
still refused) gets a third message about the missing element — the single shared message told
that site to "drop the last parameter" and lectured it about an `array` argument it had never
written, which is the same defect one arity over.

Frontier: **227 → 217** failing functions in the linked stage-1 program. All 17 arity blockers
cleared; 10 functions became fully clean and 7 revealed a second, pre-existing blocker underneath
(`.push` mutation, nullability, heterogeneous array literals) — the ~2 masking depth the
`blocker-metric` header describes. **Zero functions newly blocked**, checked per-function rather
than by reading the total.

Pinned in `test/hof-index.test.ts`, both hints executed against node, and the binding proved by
mutation: deleting the index `store` prints `10 20 30` where node prints `10 21 32`, **at exit 0**.

### `return` from under a `finally` in an INLINED callback is `NT1018` (it was a wrong answer)

Found while landing `.forEach`, but **pre-existing and worse in `.map`**. Codegen routes an
inlined callback's `return` to the per-element join only when no `finally` is live — the arm is
gated on `finallyStack.length === 0`, and a `finally` outranks it. So the `return` compiled as an
ordinary **function** return: it abandoned the rest of the loop *and* returned from the caller.

```ts
function run(): number {
  const m: number[] = [1, 2, 3].map((x) => { try { if (x === 2) { return 99 } return x } finally { console.log("fin " + x) } });
  console.log(m.join(","));
  return 0;
}
console.log(run());
```

| | stdout | exit |
|---|---|---|
| node | `fin 1` / `fin 2` / `fin 3` / `1,99,3` / `0` | 0 |
| nativets (before) | `fin 1` / `1` | **0** |

Exit 0 on both sides — the silent wrong answer. The stray `1` is the giveaway: the first
element's `return x` returned it from **`run`**, so `console.log(run())` printed `1` and neither
the remaining elements nor `m.join(",")` ever happened. Refused now in `typeArrowBody`, the one entry
every inlined HOF body passes through, so `.map`/`.filter`/`.reduce`/`.flatMap`/`.forEach`/the
search HOFs are all covered by one guard. The `finally` itself is fine; only a `return` from
under it is refused, and a `return` inside a `try` with **no** `finally` still compiles.

Both remedies the hint names are compiled against node in `test/foreach.test.ts`: move the
`try`/`finally` into a named helper the callback calls, or assign to a local inside the `try` and
`return` it after the `try`/`finally` ends.

### Modules (SH1) — a whole-program link, and no import cycles

`import`/`export` across `.ts` files are compiled by resolving the graph from the entry file and
merging every module into ONE program (`src/modules.ts`). For an **acyclic** graph this matches
node exactly — same evaluation order (post-order DFS), each module's top level run **once**, same
bindings. Two deliberate differences:

- **Import cycles are refused** (`NT1702`, naming the cycle). ESM permits them via live bindings
  and a TDZ; a whole-program link has no such machinery, so we reject rather than pick an order
  that silently differs from node. Break the cycle with a third shared module.
- **…including a cycle whose closing edge is `import type`** — and this one diverges from node,
  bun AND tsc, all three of which accept it. It is the sharper case, so it gets its own note.

#### A TYPE-ONLY import cycle is still `NT1702`

```ts
// main.ts
import { widen } from "./dep.ts";
export interface Cell { n: number }
console.log(widen({ n: 41 }));       // node & bun: 42.  nativets: error[NT1702]

// dep.ts
import type { Cell } from "./main.ts";   // erased — binds nothing at run time
export function widen(c: Cell): number { return c.n + 1; }
```

node and bun erase the `import type` statement outright, so **at run time this graph is acyclic**
and both run it; tsc permits type-level cycles by design. nativets refuses it anyway.

The reason is **ordering, not evaluation**. The linker walks the graph in post-order and links
each module seeded with the type exports of the modules linked *before* it, so a type reachable
only by going *forward* in that order has nothing to resolve against — and a cycle, by
definition, admits no such order. The type-only edge binds no value, but it still constrains
where the type can be resolved.

The tempting one-line fix — skip type-only edges when detecting the cycle — was **measured, and
it is not sound**. Dropping the edge does not make the type resolve; it makes it *unseeded*, and
an unresolved type name falls through the parser's last resort (`SCALARS.has(id) ? id : "number"`)
and silently becomes `number`. In the example above, `c: Cell` becomes `c: number`. That is the
silent-wrong-answer class this compiler exists to avoid, so the refusal stays until the linker
can seed type exports on a pass ordered independently of evaluation order.

What the diagnostic does instead is **name the edge**, because the fix is one declaration:

```
error[NT1702]: import cycle:
  → main.ts
  → dep.ts
  → main.ts   (this edge is `import type`)
  = help: node erases an `import type`, so this cycle does not exist at run time — but nativets
    resolves each module's types from the modules linked BEFORE it, and a cycle has no such
    order. Move the shared TYPE into a module that both import — usually the one that does not
    import the other.
```

The compiler's own source hit exactly this (`coverage.ts ⇄ coverage-preprocess.ts`, closed by
`import type { Blocker }`) and was fixed the same way: `Blocker` moved down into the leaf that
produces it. Pinned by the `bad-type-cycle` case in `test/modules.test.ts`, which also asserts
node prints `42` for it.
- **Only relative `./`/`../` specifiers with an explicit extension resolve.** There is no
  `node_modules`/bare-specifier resolution, no `export default`, no `import * as ns`, no
  `export * from`, and no dynamic `import()` — each is `NT1017` with a hint naming the supported
  form. (`NT1701` = unreadable module, `NT1703` = no such export.)

### Text imports (SH5) — `with { type: "text" }`, a construct node does not have

```ts
import runtimeSource from "../runtime/runtime.c" with { type: "text" };
```

The file is read **at compile time**, relative to the importing file, and the identifier binds a
plain **string constant** that lands in the `.ll` as an interned literal. No runtime file I/O and
no `node:fs`: this is how the compiler embeds its own C runtime (twelve files, ~305KB) so a
single executable is self-contained. Semantics are **bun's**, so `src/driver.ts` compiles
unchanged under both.

**node cannot run a program that uses it.** node implements only `with { type: "json" }`; there
is no `text` attribute, so a fixture using one fails to load and the ordinary
"stdout must equal `node <file>`" oracle does not exist for this construct. That is the
divergence, and it is deliberate: bun's semantics are the specification here rather than node's,
because the construct's whole purpose is to be resolved before a program runs.

The oracle is not abandoned, only split. Every fixture in `test/textimport/` is a pair — a
`main.ts` using the text import and an `oracle.ts` obtaining the same string with
`readFileSync`, identical line for line below the binding. node therefore still decides what the
string **is** and what `.length`, indexing, comparison and printing do with it; only the import
form itself is unverifiable against node. The one line a pair may differ on is `String#length`,
which is UTF-8 byte-oriented here (§A.2) — the twin prints `Buffer.byteLength` so the two mean
the same thing.

Two refusals, both of the reject-don't-miscompile kind:

- **Any attribute other than `type: "text"` is `NT1017`**, including node's own
  `type: "json"` — that one binds *parsed JSON*, not source text, so accepting it and handing
  back the text would be a silent wrong answer. A plain default import (no attribute) stays
  `NT1017` too; the attribute is what makes this form compilable.
- **A NUL byte in the file is `NT1704`.** nativets strings are NUL-terminated (`js_str_len` is
  `strlen`), so an inlined NUL would truncate the constant at run time while the `.ll` still
  carried every byte. Text imports are for text; refuse rather than truncate.

### A NUL in a string LITERAL is `NT1705` — the same rule, on the other doors

`NT1704` guarded exactly one way for a NUL to enter a string: a text import's bytes. Every
other way in was a **silent wrong answer**, the worst outcome the prime directive names:

```ts
const s = "a\0b";
console.log(s.length);   // node: 3     nativets, before NT1705: 1
```

A nativets string is a NUL-terminated UTF-8 `const char *` (`runtime.c`: `js_str_len` **is**
`strlen`), so a NUL inside a value ends it. Nothing warned; the `.ll` carried all three bytes
and the program answered `1`.

**The rule.** A string or template literal whose **decoded value** contains U+0000 is refused
with `NT1705`. The check is on the value, not on the syntax, so every spelling lands on it at
once — `\0`, `\x00`, `\u0000`, `\u{0}`, and a raw NUL byte pasted into the source, in both
quoted strings and templates (including the quasis around a `${…}`). It is checked over the
token stream, so an object key, an import specifier and a string literal *type* are covered
too, not just expressions.

**This refuses programs node accepts** — hence its place here. node prints `3`; we refuse.
The alternative was to keep printing `1`.

**What it does NOT cover, and cannot.** A compile-time rule only sees compile-time values. A
NUL computed at RUN time still truncates silently, and these all remain open:

| runtime door | node | nativets |
|---|---|---|
| `String.fromCharCode(0).length` | `1` | `0` |
| `("a" + String.fromCharCode(0) + "b").length` | `3` | `2` |
| `readFileSync(binaryFile, "utf8").length` (NUL inside) | full length | truncated at the NUL |
| `JSON.parse` of JSON text holding a `\u0000`, then `.length` | `3` | `1` |
| `atob("AA==")` — base64 that decodes to a zero byte | `"\0"` (length `1`) | `""` (length `0`) |

The `atob` row is the newest; it was found while making that pair node-exact (see
"base64 (`btoa`/`atob`) — the BINARY-STRING contract" below). It belongs to THIS door, not
to base64: `atob` is *supposed* to produce a byte of any value, so the single input class it
cannot represent is exactly the one a NUL-terminated string forbids. Raising there was
considered and rejected — node **accepts** `atob("AA==")`, so a throw would be a divergence
invented to paper over a representation limit, in a function whose neighbouring rows in this
very table stay silent. It closes when they do.

`String.fromCharCode(0)` in particular **must not** be refused: `src/lexer.ts` and
`src/modules.ts` both call it deliberately (it is how the compiler spells a NUL now that a
`"\0"` literal is `NT1705`), so refusing it would widen the self-hosting gap. Closing the
runtime doors needs a length-carrying string representation, or a runtime panic at each
producer — neither is in this change. Until then a self-compiled nativets cannot detect its
own NULs, the same caveat `src/modules.ts` already carries for `NT1704`.

### Octal escapes (`\1`…`\7`, and `\0` followed by a digit) are `NT0001`

Establishing what `\0` means turned up a neighbouring silent wrong answer: `"a\1b"` decoded
to the character `"1"` (`charCodeAt` 49) where node says 1. `\1`…`\7` are ECMAScript Annex
B.1.2 **LegacyOctalEscapeSequence**, and so is `\0` when a decimal digit follows it —
`"\01"` is U+0001, *not* a NUL then `"1"`.

They are `NT0001`, the ordinary syntax band. A bare `\0` is untouched — it is the NUL escape,
legal in strict mode, and refused as `NT1705` for its own reason.

**These ARE a divergence for a script-shaped file, and the earlier claim that they are not was
wrong.** That claim read: "they are SyntaxErrors in strict mode, and a TypeScript module is
strict, so node refuses them too". The premise is true and the conclusion does not follow,
because **whether node treats a `.ts` file as strict depends on the file's shape**, and the
fixtures this rule is tested on are the shape that is *not* strict. Measured, all four
combinations:

| file | `"a\1b"` under node | `"a\8b"` under node | nativets |
|---|---|---|---|
| **script** — no `import`/`export`, no `"use strict"` | **prints `1`, exit 0** | prints `a8b`, exit 0 | `\1` **refused** `NT0001`; `\8` → `a8b` |
| **module** — any `import`/`export` (or `"use strict"`) | `SyntaxError` | `SyntaxError` | `\1` refused `NT0001`; `\8` **accepted** |

node's type-stripping loads a bare `.ts` as CommonJS, which is sloppy mode; an `export` makes it
a module, which is strict. Since a divergence fixture is normally a single file with no
`import`/`export`, `node <file>` — this project's oracle, literally — runs it **sloppy**. So:

- **`\1`…`\7` refuse a program node accepts.** That is a real refusal and it belongs in this
  document as one, which is why this entry no longer claims exemption. The refusal itself is
  kept — the value half of the original finding stands (node decodes `"a\1b"` to U+0001, and we
  used to produce the character `"1"`, `charCodeAt` 49, which was a silent wrong answer), and
  refusing a deprecated Annex B form is the safe direction.
- **`\8` and `\9` are the mirror gap.** They are **NonOctalDecimalEscapeSequence**, decode to
  `"8"`/`"9"`, and that matches node in the script shape (test262
  `legacy-non-octal-escape-sequence-8-non-strict.js` — note the cited file is the *non-strict*
  one). In the module shape node rejects them (`SyntaxError: \8 and \9 are not allowed in strict
  mode`) and we accept. Not a wrong answer in either shape, but it is us being more permissive
  than node, and it is the same strictness question answered the other way.

The inconsistency worth naming: the old text reasoned "the file is strict" for `\1` and cited a
**non-strict** test262 case for `\8`, two lines apart. Both cannot be the oracle for one file.
`test/nul-string.test.ts` carries the same claim in its header comment ("a TypeScript module IS
strict … Verified against node run as ESM") while its own fixtures are script-shaped and it
asserts only the `NT` code, never a node-differential run — that comment wants the same
correction.

> Fixing this needed `\uHHHH` / `\u{H+}` to exist at all: `\u` was not an escape the lexer
> knew, so it fell through to "an unknown escape is the character itself", and `"a\u0041b"`
> compiled to the seven characters `au0041b` where node gives `aAb`. That is now implemented
> and node-differentially tested (`test/nul-string.test.ts`), and it is also what routes a
> `\u0000` into `NT1705`. `String#length` over the result is still UTF-8 byte-oriented —
> §A.2, unchanged.

### Ambient lib type names (`NT1035`) — 56 of them silently meant `number`

`AMBIENT_TYPES` in `src/parser.ts` is the set of names TypeScript's own lib declares, so a
program may use one without declaring it. It exists so `NT2003` ("Cannot find name") can
tell *"you never declared this"* from *"this is a global you never have to declare"* — and
its escape handed control back to `resolveNamed`'s last line, which answers `number`. So
every name on the list that no earlier arm claimed **became `number`**. Measured: 56 of the
62 names, and only `Date`, `Error`, `Uint8Array`, `Response`, `Headers`, `URL` and
`TextEncoder` resolved honestly.

It was never only `any`/`unknown`/`never`. `symbol`, `bigint`, `Function`, `Iterable`,
`Generator`, `ArrayBuffer`, `globalThis`, every `Readonly*`, and a **bare** `Map`/`Set`/
`Promise`/`Record` written without type arguments all erased the same way. (An *applied*
`Map<K,V>` never reaches that line — `parseGenericType` claims it — which is why the bug
stayed invisible: the common spellings work.)

The erasure is **destructive**, in exactly the sense `NT1033` and `NT2003` already document:
`number` is a real type, so once `resolveNamed` answers it the spelling is gone and no later
pass can tell the result from a `number` the user wrote. Three failures came out of it, in
increasing order of severity:

| written | node | before `NT1035` |
|---|---|---|
| `function f(x: unknown): string` | — | `'f' arg 0 expects number, got string` — a type the source never contains |
| `const a = s as unknown` | `string` | clang's own `'%t1' defined with type 'ptr' but expected 'double'` |
| `const b = (a as any[]); b[0]` where `a: string[]` | `x` | **no output, exit 255** |

The third is the one that mattered. `any[]` erased to `number[]`, and since a `string[]` and
a `number[]` are *both* `ptr` at the LLVM level, the verifier — which caught the scalar case
above — had two matching types and passed it. A silent wrong answer is the worst outcome
available, so the erasure is now a refusal, in the **parser**, which is the last pass that
still holds the spelling.

**What is refused:** only `resolveNamed`'s erasing fallback. A name some earlier arm claims
is untouched, and so is every applied generic `parseGenericType` maps to a real shape. A
bare container names its fix (`Map` → "write `Map<string, number>`").

**The residue — three names, annotation position only.** `unknown`, `never` and `object`
still erase in an annotation, because `src/` uses all three and none has an honest rewrite:
`never` is a divergent return and the exhaustiveness witness `src/ast.ts` calls load-bearing
(`default: { const impossible: never = e; … }` — "add an `Expr` member and this stops
compiling"), and `unknown`/`object` are the parameter and identity-set types of the
reflective AST walks in `checker.ts`/`ownership.ts`/`codegen.ts`. Closing them needs a
**feature**, not a deletion: a bottom type for `never`; an opaque unusable `Ty`, or
reflective walks the subset can express, for `unknown`/`object`. Refusing them instead would
mean deleting a real `tsc`-checked invariant to satisfy a subset limitation.

All three are refused inside an `as`/`satisfies` **assertion** regardless: an annotation is
*checked* against the value it annotates, so a wrong erased type produces a refusal, while
an assertion *adopts* the type and leaves nothing to compare. The line stops at a nested
binder — a field annotation inside an asserted record, and a type argument — because `node
as Record<string, unknown>` is how every reflective walk in `src/` opens an unidentified
node. That boundary is a consequence of the residue and disappears with it.

**A correction.** That paragraph used to open "That is the **only** position where the
erasure was ever a wrong answer", and it was wrong — the refusal is keyed on the ambient
NAME, and a body can adopt the erased type one indirection later without writing one:

```ts
function asStr(e: unknown): string { return e as string; }
console.log(asStr(42));                 // node: "42", exit 0
```

`e: unknown` is the residue's own annotation position, so nothing refuses it; from there `e`
IS a `number`, and `e as string` names no ambient type at all. Row 2 of the table above came
back verbatim — `'%t0' defined with type 'double' but expected 'ptr'`, a raw LLVM error with
no `NT` code and no location in the user's program.

That is closed **in the checker, not here**, because the erasure is only one of the ways to
reach it: `const n = 12345; (n as string).length` emitted the same invalid IR with no
ambient name in sight. `Checker.type`'s `AsExpr` case now refuses an assertion that crosses
the **scalar/reference boundary** — `number` is a double, `boolean` is a bit, and a string,
object, array, `Map` or `Set` is a pointer, so there are no bytes to reinterpret between
them (`reprClass`, `NT2001`). Nullables and unions are exempt by construction: they are
boxes whose `as` behaviour `nt_as_unbox`/`nt_as_tag` already check at run time, and
classifying them would refuse the narrowing casts those checks exist to allow. node erases
`as` and answers `undefined`; there is no such value here, and the same reasoning already
refuses an assertion to a *wider object*. Pinned by `test/as-cast.test.ts` section 3b.

### Generic `type`/`interface` parameters (`NT1013`) — the same erasure, a third source

`skipGenerics` in `src/parser.ts` collects a generic *declaration's* own parameters
(`type Box<T> = { v: T }`) so `NT2003` will not fire on `T` — it **is** declared, right
there in the angle brackets. But that escape returned control to the same last line of
`resolveNamed`, so `T` in the body answered `number`, and every instantiation became the
`number` shape whatever type argument was written.

This is the `NT1035` bug from a third source, and it reproduces all three of that entry's
failures:

| written | node | before `NT1013` |
|---|---|---|
| `type Arr<T> = T[]; const a: Arr<string> = ["x"]` | `x` | `'a' declared number[] but initialized with string[]` — a type the source never contains |
| `type Id<T> = T; (s as Id<string>).toUpperCase()` | `HI` | `number method 'toUpperCase' is not supported yet`, about a string |
| `type W<T> = T; const v = s as W<string>; v + 1` | `51` | clang's `'%t1' defined with type 'ptr' but expected 'double'` |

The third is the telling one: in an assertion the named type is *adopted* rather than
checked, so nothing in the checker noticed a `string` had been retyped to a `double` and the
erasure reached **codegen**. A build error is the lucky outcome — the two-`ptr` case
(`as any[]`) is the one LLVM cannot catch, and that one prints nothing and exits 255.

`NT1013` (`GENERIC`, "generics need monomorphization") because that is what the gap actually
is: nothing in this subset substitutes the type argument. The hint says to write the concrete
type, or to declare one alias per instantiation (`type ArrOfString = string[]`).

**Cost: two declarations, both in `test/forward-type-ref.test.ts`.** The whole tree, `src/`
included, declares no other generic `type`/`interface`, and zero of the 871 fallback
resolutions in a linked `src/cli.ts` parse arrive from this source. The guard those two
declarations came from asserted the erasure was harmless, and only passed because both
instantiate at `<number>` — the one argument the erasure gets right.

**Generic FUNCTIONS are untouched.** Their parameters live in `typeParamScopes` and are
monomorphized for real; `function first<T>(xs: T[]): T` is the one generic form the subset
genuinely supports. The refusal keys on `genericParamNames`, not on "a `<` after the name",
precisely to keep that line.

### Inline import types (`import("./m").T`) — the same last line, reached differently

`parseImportType` **drops the module path** and resolves the bare name against *this* file.
That works when the file already has the name; when it does not, the name reached the same
`number` fallback and the annotation quietly changed meaning. It was live here:
`src/coverage.ts` wrote `new Map<string, import("./ast.ts").Ty>()`, and `Ty` is a structural
type *string*, so the map's value type said `number`. Now refused with the fix in the hint —
import the name and annotate with the bare `T` — which is what `src/coverage.ts` does.

### Heterogeneous tuple types (`NT1037`) — the erasure invented a type, then blamed the program

`parseTupleType` modelled `[T, U, …]` as `T[]`: it kept the **first** element's type and
discarded every other one. Same destructive erasure as `NT1033`/`NT1035`/`NT1036` — the
parser is the last pass holding the spelling — but with a sharper edge, because the
invented type then appeared in diagnostics as if the *user* had written it:

```ts
function second(t: [number, string]): string { return t[1]; }
// was: error[NT2001] return type number does not match declared string
```

`tsc` accepts that and node runs it. The declared return type **is** `string`; the `number`
came from our own erasure. Three other shapes were rejected the same way, and the one that
mattered was in `src/parser.ts` itself: `skipQuoted` returned `[string, number]`, so
`const [txt, next] = skipQuoted(raw, i); i = next` was `Cannot assign string to number 'i'`
— the **first blocker of five modules at once** (`parser`, `modules`, `driver`, `coverage`,
`cli`, all of which reach it through the template-literal builder). It is now a named
record, `QuotedRun { text, next }`, exactly as `decodeEscapeAt` → `DecodedEscape` fixed the
identical defect in `src/lexer.ts`.

It was **also a latent silent wrong answer**: `t[1]` reads a `string` at a `number` type,
and the only thing that stopped it reaching codegen is that a heterogeneous array literal
cannot be built at all (`NT2001 array elements must share a type`), so the sole construct
able to witness the discarded type is caught in an unrelated pass. Correct by accident, out
of a check never meant to be holding it up. Hence the refusal now, while the gap is still
theoretical.

**Homogeneous tuples are still accepted.** `[T, T]` erases to `T[]` and every element really
does have type `T`, so no type is misreported — only the arity is lost, and reading past the
end already panics (Stage 41). `src/checker.ts` has four such sites (`as [Expr, Expr][]`
×3, `(): [Ty, Ty]`); refusing those would move that module *away* from self-hosting and buy
no soundness. The line is drawn exactly at the set where the erasure can lie.

Real tuples remain unimplemented — they need a `Ty` inhabitant with per-index types, which
is a type-system feature, not a diagnostic. The hint's replacement is a named record.

### Handing a MODULE-LEVEL binding out of a function is `NT1604` (it was a silent double free)

```ts
const shared = { a: 1 };
function getShared(): { a: number } { return shared; }   // NT1604
const x = getShared();
console.log(shared.a, x.a);                              // node: "1 1", exit 0
```

The module scope owns `shared` and frees it when the program ends. Returning it made `x` a
second owner, so `main` emitted **two consecutive `nt_obj_free`s on one pointer**.

**The signature is the worst on this page**: the allocator's abort discards buffered stdout, so
the compiled binary printed **nothing on stdout AND nothing on stderr** and exited 133/134 — a
differential test that compares only stdout compares two empty strings and passes whenever node
also printed nothing. ASan (which, unlike LeakSanitizer, works on macOS) reports `attempting
double-free`. A `console.log` placed *before* the free is lost too, so no amount of tracing
inside the program can see it.

Refused rather than compiled, and the reason "just move the global" is not available is worth
stating: **the module binding is still live and still readable afterwards** — node prints
`shared.a` fine — so transferring ownership would produce a wrong *answer* instead of a
refusal. A return-position **borrow** is the expressive fix and is a language feature, not a
bug fix. Until then, per *reject, never miscompile*, this is `NT1604`, in the same band and by
the same machinery as a by-borrow parameter escaping via `return o`.

| shape | verdict |
|---|---|
| `return g` / `const t = g` / `return c ? g : …` | `NT1604` |
| `return { w: g }` / `return [g]` | `NT1604` — a container is an owner too |
| `=> g` (arrow expression body) | refused; it used to disagree with its own `=> { return g; }` spelling, which was already an error |
| `get()` with the result discarded | `NT1604` — the rule is about the frame the value leaves |
| across a module boundary | `NT1604`; SH1 links the graph into one program, so it is one binding |
| `return g.field`, `for (const v of g)`, `g.length` | **compiles** — reads through a borrow |
| `return g.inner` (a field OF the global) | **compiles** — a distinct allocation |
| a module-level **string** | **compiles** — strings are refcounted, not linear |
| a local that SHADOWS a global | **compiles** — it is the function's own binding |

See `docs/ownership.md` and `test/global-return.test.ts` (both directions, exit codes asserted,
ASan-pinned, live counts at two scales).

`node` is our oracle. Two kinds of "we differ from node" exist, tracked separately.

## A. Semantic divergences (we compile it, but differ deliberately)

These are consequences of the **static-typing** design. Small in number; pinned by the
conformance corpus allow-lists.

### 1. Value-returning `&&` / `||` — same-type operands only
JS returns an *operand* of possibly-different type. As of A2 we support **value-returning
`&&`/`||` when both operands share a type** (`0 || 5 → 5`, `"" || "x" → "x"`, matching node),
which the `??`-vs-`||` test vectors require. **Mixed-type** logical expressions
(`true && 0`, `false || "hi"`) remain a type error — we don't unify across types. `??` is
sentinel/tag-based (A2): `0 ?? 5 → 0`, unlike `||`. Boolean logic (`a > b && c`, `!flag`)
matches node exactly. Corpus: `logical-and-shortcircuit`, `logical-or-shortcircuit`.

### Immutable `Map`/`Set` (B2) — the "sharp turn" away from JS

nativets `Map`/`Set` are **immutable/persistent** (ROADMAP Phase B): `.set`/`.add`/`.delete`
return a **new** collection sharing structure, leaving the source unchanged — unlike JS's mutable
Map/Set. Consequences vs node: (1) *old version unchanged* is the headline divergence, tested
behaviorally (compile+run+assert), not via the node oracle; (2) `.delete` returns a **new
collection**, where node returns a **boolean**; (3) ~~`.get` of an absent key returns `0`~~ **RESOLVED**: `.get` now returns `V | undefined`
via the A2 nullable machinery (miss → `undefined`, node-matched byte-for-byte). Fixtures
use the *use-the-returned-handle* pattern, whose observable output matches node.

#### The discarded mutator is REFUSED (`NT1606`) — it used to be a silent no-op

Everything above describes the **return value**. Nothing described the call whose return
value nobody takes, and that is the ordinary way to write a `Map` in JavaScript:

```ts
const m = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
console.log(m.size, m.get("a"));   // node: "2 1"    nativets, before: "0 undefined"
```

Exit code `0` on both sides, wrong stdout — the worst outcome this project recognises. It
is now **rejected** at check time:

```
error[NT1606]: `Map` is persistent: `.set` returns a NEW map and leaves the receiver
               unchanged, so discarding the result here does NOTHING at 2:1
    |
  2 | m.set("a", 1);
    | ^^^^^^^^^^^^^^ mutated here
    = help: write `m = m.set("a", 1)` — the result IS the updated map, and dropping it
            drops the whole operation. Declare the binding `let` …
```

**Why the trap is shaped this way.** Under node, `Map.prototype.set` and
`Set.prototype.add` return the **receiver** (test262 `built-ins/Map/prototype/set/returns-this.js`,
`built-ins/Set/prototype/add/returns-this.js`), so the result carries no information and
discarding it is the *idiomatic* call. Under a persistent collection the result *is* the
operation. The two conventions are spelled identically and mean opposite things, so the
JS-fluent spelling is exactly the one that silently does nothing.

**Affected operations — the complete set,** measured rather than assumed:

| receiver | discarded call | before | now |
|---|---|---|---|
| `Map` | `.set(k, v)`, `.delete(k)` | silent no-op | `NT1606` |
| `Set` | `.add(v)`, `.delete(v)` | silent no-op | `NT1606` |
| `Map`/`Set` | `.clear()` | — | already `NT1014` (not implemented) |
| `Array` | `.reverse()` | **matches node** (returns its receiver, reverses in place) | unchanged |
| `Array` | `.push`/`.pop`/`.splice`/… | already `NT1606` | unchanged |
| `Array` | `.toSorted()`, `.with()` | no-op under node **too** — not a divergence | unchanged |
| `string` | `.replace()`, `.slice()`, … | no-op under node **too** — not a divergence | unchanged |

**The rule is "result discarded", with no reachability test** — deliberately, not for lack
of analysis. A discarded mutator is a guaranteed no-op in *every* execution of *every*
program, so the refusal has no false-positive direction. The refinement ("…and the receiver
is read later") does have an **unsound** direction: it must chase aliases, escapes through
calls and fields, and returns, and any miss silently restores the wrong answer the rule
exists to remove. It also matches how arrays are already handled — `arr.push(x)` is
`NT1606` unconditionally, never "only if `arr` is read afterwards".

**Why refuse rather than auto-rebind.** Rewriting `m.set(k, v);` to `m = m.set(k, v);`
looks like a free fix, and it is not: it repairs the single-binding case while leaving every
**aliased** case silently wrong, which is strictly worse than a uniform refusal. Aliasing
here is not hypothetical — it is the divergence in this very section:

```ts
let m = new Map<string, number>(); const m2 = m; m = m.set("a", 1);
console.log(m.size, m2.size);      // node: "1 1"   nativets: "1 0"
```

Under node a mutation is observed through *every* handle; a rebind updates *one*. A user who
tested the simple case would be trained to trust a construct that breaks as soon as the map
is passed to a function or stored in a field. Genuine node-compatible mutation needs the
handle to become a box (one indirection, refcounted, every alias observing the write) — the
`@@mutable` treatment that classes and records already have (docs/decorators.md). That is a
runtime-representation change, i.e. a stage of its own, and it is the recommended follow-on.
Until it exists, the refusal is the honest answer.

**`src/` IS SUBJECT TO THIS DIVERGENCE, AND IS LINTED FOR IT** (`test/single-owner.test.ts`).
Stage 0 runs the compiler under bun, where `.set`/`.add` mutate — so every instrument in the
tree is green *because* of the very semantics `src/` must not depend on, and no `NT` code can
see it. The checker structurally cannot: `NT1606`'s rule is "the result is **discarded**",
whereas the shape that bites keeps the result and assigns it, and only the **aliasing**
question decides whether that is wrong. The two are orthogonal, and chasing aliases is the
unsound direction this section already refuses to take for user programs.

`check` had exactly this bug: it built the signature table into a local, handed the local to
`new Checker(functions, …)`, and then went on rebinding it. Under bun both names stayed one
object; under the semantics this compiler implements, `Checker.functions` would have been
**empty for the whole check**, so no call in any program would resolve. Reduced, and measured
both ways at exit 0:

```ts
let m = new Map<string, number>(); const c = new Table(m);
m = m.set("a", 1); m = m.set("b", 2);
console.log(m.size, c.size());     // node: "2 2"   nativets: "2 0"
```

The rule for `src/` is **single owner**: fill a collection *before* sharing it, or let exactly
one holder own it and write through that holder (`c.functions = c.functions.set(…)`, which
needs the owner to be `@@mutable`). Returning the new collection and rebinding at the call
site (`out = f(…, out)`) is the other correct spelling. The lint reports the remaining sites.

#### `.delete` consumed as a BOOLEAN is REFUSED (`NT1606`) — it used to invert control flow

Item (2) at the top of this section — "`.delete` returns a new collection, where node returns
a boolean" — was documented as a *type-level* difference. In a **condition** it stops being
type-level and becomes a wrong answer, because a collection handle is truthy for **every**
input while node's boolean is not:

```ts
let m = new Map<string, number>().set("a", 1);
if (m.delete("a"))  { console.log("deleted");  } else { console.log("absent");  }
if (m.delete("zz")) { console.log("deleted2"); } else { console.log("absent2"); }
// node:            deleted / absent2
// nativets, before: deleted / deleted2    ← exit 0, wrong branch, no diagnostic
```

`while (m.delete(k))` was the same fault and **never terminated** on an absent key. Both are
now rejected:

```
error[NT1606]: `Map` is persistent: `.delete` returns a NEW map, not a boolean, so this
               `if` condition is ALWAYS true — the `else` arm is unreachable at 2:5
    |
  2 | if (m.delete("zz")) { … } else { … }
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ mutated here
    = help: node's `.delete` returns whether the key was there; ours returns the map without
            it. Test with `m.has("zz")`, and remove with `m = m.delete("zz")` —
            `if (m.has("zz")) { m = m.delete("zz"); }` says both. …
```

**Why this needs no analysis and has no false-positive direction.** The condition is not a
condition: its value is decided by the *representation*, not by the data, so the `else` arm
is unreachable and the loop cannot exit — in every execution of every program. There is no
program in which the result of `.delete` is a meaningful boolean, so nothing correct is being
rejected. Same rule shape as the discarded mutator above, for the same reason.

**Why not "make it match node" instead.** `.delete` cannot return both a boolean and the new
collection, and the collection is the one thing a persistent structure *must* return —
`m = m.delete(k)` is the documented removal spelling, used by existing fixtures. Returning a
boolean and rebinding the receiver implicitly reintroduces exactly the aliasing unsoundness
that ruled out auto-rebind for `.set` (a rebind updates one handle; node's mutation is seen
through every alias), and additionally makes `const m` collections un-deletable-from. Real
node-compatible mutation needs the boxed handle described above — a stage of its own.

**Where the rule applies, measured against node rather than assumed.** The boolean contexts
split three ways:

| position | before | now |
|---|---|---|
| `if` / `while` / `do…while` / `for` test | **silently wrong** (wrong arm; loops never exit) | `NT1606` |
| `?:` test, `!x`, `!!x` | **silently wrong** | `NT1606` |
| `&&` / `\|\|` operand (either side) | was `NT2001` (operands must be matching boolean/number/string) | **`NT1606`** — see below |
| `return` from a `: boolean` function | already `NT2001` (return type mismatch) | unchanged |
| argument to a `boolean` parameter | already `NT2001` | unchanged |
| `const b: boolean = m.delete(k)` | already `NT2001` | unchanged |
| `m.delete(k) === true` | already `NT2001` (cannot compare) | unchanged |
| `Boolean(m.delete(k))` | already `NT1003` (`Boolean` unsupported) | unchanged |
| **`const r = m.delete(k)` with NO type annotation** | **silently wrong, and still is** | **open — see "STILL OPEN" below** |

The `&&`/`||` row moved, and how it moved is worth recording. It said "already `NT2001`",
which was true but ACCIDENTAL: the value rule refused every mismatched operand pair, so it
happened to catch the collection case on its way past. When truthiness-position `&&`/`||`
was widened to accept any operand types (see "NOW ACCEPTED" above), that accident stopped
holding and `if (flag && m.delete("zz"))` printed `THEN` where node prints `ELSE` — with no
diagnostic, in the widening's own first hour. The fix is that `rejectVacuousCollectionTest`
now runs on the OPERANDS as well as on the whole condition; the `if` call site can no longer
see through, because the condition's type is `boolean` by then. The lesson is the row's, not
the rule's: a refusal that a DIFFERENT rule is incidentally producing is not a guarantee, and
this table could not tell the two apart. Pinned in test/logical-condition.test.ts §4.

Read that last row before trusting the six above it. Every "already `NT2001`" row is a
**type-level** rescue: it fires because the *annotation* says `boolean` and `.delete` hands
back a collection. Drop the annotation and nothing fires — `const r = m.delete(k)` infers the
collection type and compiles, and the divergence reaches stdout. The rows above are not
evidence that the boolean confusion is contained; they are evidence that it is contained
*wherever the user happened to write a type*.

The `return`-from-`: boolean` row holds for a `function` declaration, a method **and now an
arrow**. It used **not** to: an arrow's declared return type was never checked against its
body at all — `parseArrow` parsed the annotation and threw it away — so
`const f = (k: string): boolean => m.delete(k); console.log(f("zz"))` printed the map where
node prints `false`, with no diagnostic. That hole was worse than it looks *and* harder to
spot, for the same reason: an unchecked annotation agrees with node by **accident** in most
programs, because node erases types too — `(n: number): string => n + 1` prints `2` on both
sides. It became a wrong *answer* only where the declared type is load-bearing for our
codegen and the body's real type differs, so the bug was the **asymmetry** with the
`function` spelling (which *is* `NT2001`), and `.delete` merely made it visible. Found here,
fixed in its own lane (see "String coercion" above for that lane's second defect); the row
now has no exception.

`if (m.size)`, `if (m.has(k))` and `if (m.get(k))` — the spellings the hint points at — are
`number`/`boolean`/`V | undefined` tests and never reach the rule. A user class with its own
`.delete(): boolean` method is untouched (measured). All are pinned as passing tests in
`test/mapset-immutable.test.ts`.

test262 basis, re-measured on node here: `built-ins/Map/prototype/delete/returns-true.js`,
`returns-false.js` and the `Set/prototype/delete` pair — `.delete` answers "was the key
there?", `true` on the first call and `false` on the second.

#### …and a truthiness test on a NON-NULLABLE `Map`/`Set` is refused too (`NT1606`)

The `.delete` rule above keyed on `.delete`, and one `const` walked around it:

```ts
let m = new Map<string, number>().set("a", 1);
const gone = m.delete("zz");
if (gone) { console.log("hit"); } else { console.log("miss"); }   // node: miss.  here: hit.
```

At `if (gone)` the expression is a plain `Map`-typed identifier — **indistinguishable** from
`if (m)`, and `const gone = m.delete(k)` is itself the legitimate persistent spelling. There
is no analysis that separates them short of a taint that leaks one alias later
(`const g2 = gone; if (g2)`), and being *partly* clever is worse than not trying: it trains
confidence the rule cannot honour. So the rule is written on the **type** and refuses both:

```
error[NT1606]: a non-nullable `Map` is always truthy, so this `if` condition at 3:5 is
               ALWAYS true — the `else` arm is unreachable
  = help: `gone` is a handle and its type is not `Map<…> | undefined`, so it can never be
          absent — node evaluates this test to `true` as well, which makes it dead code
          rather than a check. Did you mean `gone.size` (is it empty?) or `gone.has(k)`
          (is the key there?)? A `Map<…> | undefined` IS worth testing and is still accepted
```

**Why refusing `if (m)` costs nothing.** It is not a check in *either* language. A
non-nullable handle is never `null`/`undefined`, so node evaluates the test to `true` too:
the condition is **vacuous, not divergent**, and no correct program's behaviour can depend on
a condition that cannot be false. Against that, leaving it open costs a silent wrong answer
that survives one binding. The blast radius was measured before widening: **no** non-nullable
collection truthiness test exists anywhere in `src/`, `test/fixtures/` or `examples/`.

**`Map | undefined` is a different type and a real check, and still compiles** — that test
decides something and node and we agree on what. The nullable box is `?N…`/`?U…`, which the
`isMapTy`/`isSetTy` predicates do not match, so it never reaches the rule:

```ts
const hit: Map<string, number> | undefined = new Map<string, number>().set("a", 1);
const nope: Map<string, number> | undefined = undefined;
if (hit) { console.log("some", hit.size); } else { console.log("none"); }   // "some 1"
if (nope) { console.log("some2"); } else { console.log("none2"); }          // "none2"
```

The two diagnostics are deliberately worded differently for the same code: a `.delete` test
is a **misunderstanding** (you wanted node's boolean; the fix is `.has`), a bare handle test
is **dead code** (delete it, or test `.size`).

#### STILL OPEN: `.delete` in a VALUE position, and what it actually costs

The boolean *contexts* above are closed. The **value** positions are not, deliberately —
`const m2 = m.delete(k)`, the chained `new Set<T>().add(x).delete(x)` and `m.delete(k).size`
are the supported persistent idioms and are pinned as *accepted* in
`test/mapset-immutable.test.ts` ("the value-consuming `.delete` spellings still compile") and
`test/collections.test.ts`. So this is a **known-open divergence with a written rationale**,
not a rule that leaked. Anyone widening the refusal is overturning that decision, not
patching an oversight.

What it costs, stated in full, because an earlier version of this paragraph understated it
in two ways and that is what made it read as benign:

```ts
const s: Set<string> = new Set<string>(["a", "b"]);
const r = s.delete("a");
console.log(typeof r);        // node: "boolean"   here: "object"
console.log(s.size);          // node: 1           here: 2
```

**Exit 0 on both sides, wrong stdout on both lines, no diagnostic.** This is the shape a
node-fluent programmer actually writes — bind the result of `.delete`, then read the
**receiver** — and neither line goes anywhere near a boolean context, so none of the three
rules above sees it. The `s.size` line is §A item (1), the headline persistence divergence,
reached through a call that *looks* like a mutation. The `typeof r` line is §A item (2).

> The earlier wording claimed printing the result was "the *correct* rendering,
> indistinguishable from `console.log(m.set(k, v))`". **That sentence was false.** Under node
> `.set` returns the **receiver**, so `console.log(m.set(k, v))` prints a `Map` there and a
> `Map` here — the two agree in kind, and only the contents can differ. `.delete` returns a
> **boolean**, so `console.log(m.delete(k))` prints `false` there and `Map(1) { … }` here:
> a different *type*, not a different rendering of the same thing. The two cases are
> distinguishable, and conflating them is what made the value hole look cosmetic. A
> divergence note that understates its own symptom is its own defect.

**Why the obvious narrowings were not taken.** Two were costed:

| candidate rule | closes every door? | cost |
|---|---|---|
| refuse `.delete` anywhere but a self-rebind `x = x.delete(k)` | **yes** — the rule sits on the *call*, and a call has exactly one site | overturns the pinned decision above and breaks four pinned tests; an owner-level language call |
| refuse only *direct* rendering (`console.log(m.delete(k))`, `typeof m.delete(k)`) | **no** — the repro above routes through a `const` and still leaks | worse than nothing: it is exactly the "being *partly* clever" failure the vacuous-test section warns about, and buys false confidence |

The reason no *binding-level* rule works is the same one that forced the vacuous-test rule to
be written on the type: at `console.log(gone)` the expression is a plain `Map`-typed
identifier, and `console.log(m)` on a genuine map **agrees with node byte-for-byte**. Refusing
the type would cost a real, correct capability, and one-level taint (`const g2 = gone`) is
unsound at the second binding.

**The complete fix** is the one the discarded-mutator section names: box the handle, so
`.delete` can return node's boolean *and* the receiver can be updated through every alias.
That is a stage of its own, not a checker rule.

#### Rebinding a `Map`/`Set` PARAMETER from its own mutator is refused (`NT1606`)

The three rules above all police the *discarded* result. This one polices the fix they
**recommended**, which was right for a local and a silent wrong answer for a parameter:

```ts
function collect(names: string[], out: Set<string>): void {
  for (const n of names) out = out.add(n);   // exactly what the hint told you to write
}
let acc = new Set<string>();
collect(["a", "b", "c"], acc);
console.log(acc.size);        // node: 3.  here, before this rule: 0, at exit 0.
```

A parameter is a **borrow** — the caller owns the collection. node's `.add`/`.set` MUTATES
the receiver, so the caller observes every append and the rebind is incidental; ours returns
a NEW collection, so the rebind is purely local and the caller's handle never changes.

**Note the direction, because it is the reverse of the `.delete` rule.** A `.delete` rebind
is wrong under **bun**, where `.delete` answers a boolean. This one is wrong under
**nativets**. They are independent refusals and neither implies the other — a single blanket
rule would have to be wrong for one of them.

The rule is **narrow on purpose**: only an assignment whose VALUE is a mutator call rooted at
the parameter itself (the chained `out = out.add(a).add(b)` roots at the same parameter and
is caught too). `out = new Set<string>()` on a parameter is **not** refused — node agrees
that one is invisible to the caller, so there is no divergence to report. The divergence
exists only because node's mutator has a side effect on the receiver that ours does not.

The sanctioned spelling — accumulate into a **local** seeded from the parameter, return it,
and rebind at the **call site** — matches node exactly and is what the hint now names:

```ts
function collect(names: string[], out: Set<string>): Set<string> {
  let r = out;
  for (const n of names) { r = r.add(n); }
  return r;
}
let acc = new Set<string>();
acc = collect(["a", "b", "c"], acc);   // 3 under both
```

This is what docs/self-hosting.md already meant by "a persistent `Map` cannot be an
accumulator argument — RETURN the bindings"; `src/` uses the out-parameter shape in **12**
places, which is the largest sub-bucket of the remaining `Map`/`Set` `NT1606` debt.

#### Two corrections to the `NT1606` hint itself — the diagnostic was the delivery mechanism

Both of these were *wrong text*, not wrong analysis, and both are worse than an ordinary bug
because a diagnostic is trusted precisely when the reader is uncertain:

1. The hint said `write \`out = out.add(n)\`` for **every** receiver alike, so following it on
   an out-parameter produced the lost update above. It is now receiver-aware and names the
   return-and-rebind spelling for a parameter.
2. The tail claimed **"node's `.delete` mutates and returns the receiver"**. node's `.delete`
   returns a **BOOLEAN** (test262 `built-ins/Map/prototype/delete/returns-{true,false}.js`;
   re-measured: after `m = m.delete("a")` node reports `typeof m === "boolean"`, value
   `true`). `.delete` is the one case where the recommended rebind does not merely become
   redundant under node — it means something *else* there, and bun is stage 0 of the
   bootstrap, so the hint now says so out loud.

In both cases this file and the checker's own doc comments were already correct; only the
emitted text disagreed with them.

### `Record<K, V>` is a `Map`, not an object — and an object literal cannot initialize one

In TypeScript `Record<K, V>` is an **object** type, so `const o: Record<string, string> = { a: "1" }`
is ordinary code and `o["a"]` prints `1` under node. nativets erases `Record<K, V>` to its
**`Map<K, V>`** (`parseGenericType`, `src/parser.ts`), so that program is **rejected**:

```
error[NT2001]: 'o' declared Record<string,string> but initialized with {a:string}
```

**Why the erasure is the right one.** An object here is a flat slot array whose field list comes
from its TYPE, and a `Record`'s key set is by definition *not* statically known — that is the
whole point of the type. So `Record` cannot be an object in this model without runtime-keyed
objects (the same machinery whose absence forces the `delete` and key-enumeration refusals
above). A `Map` is what a dictionary with runtime keys already is.

**The read side cannot match node either, and that is the deeper reason.** node's `o[k]` consults
the **prototype chain**. Measured on `{ n: "N" }`:

| expression | node |
|---|---|
| `o["n"]` / `o["zz"]` | `"N"` / `undefined` |
| `o["toString"]`, `o["constructor"]`, `o["hasOwnProperty"]` | a **function** |
| `o["__proto__"]` | an **object** |
| `o["toString"] ?? FALLBACK` | the inherited **function**, not the fallback |

nativets objects have no prototype chain — a literal-key `o.toString` is refused outright
("Property 'toString' does not exist on `{n:string}`") — so *any* own-keys-only lowering of a
variable-key index would answer `undefined` where node answers a function. Indexing an object by
a non-literal key therefore stays refused, and a `Map` is the sound alternative: node's own
`m.get("toString")` is `undefined`, which we match exactly.

**What to write instead:** build the dictionary with `new Map<K, V>()` and a `.set(k, v)` chain,
reading it with `.get(k)`. Note that the **entries-array constructor is not available** —
`new Map([["n","\n"]])` is `NT1014` ("the entries form needs a `[key, value]` tuple type we do not
have yet; use `.set`"), so a table of any size becomes a `.set` chain. If the key set really is
fixed, annotating the exact object shape (`{ n: string, t: string }`) also works — but only where
every read uses a **literal** key. The compiler's own lexer took a third option for its escape
table: a `switch`, which is what a hand-written lexer would reach for anyway and which reads
better than eight chained `.set`s (`escapeChar`, `src/lexer.ts`).

**Known imprecision:** `Record` and `Map` erase to the same `Ty`, so the two are the same type to
the checker; only the diagnostic distinguishes them, by keeping the annotation's leading
identifier as written (`annotHead`, `src/ast.ts`). A `Record`-annotated **parameter** is simply a
`Map` parameter, with no trace of the spelling.

#### STANDING CONCLUSION — variable-key indexing cannot match node under ANY representation

> Stated as a conclusion, not a status, because it does not depend on what we implement next.

**`o[k]` with a non-literal `k` cannot be made node-exact by any representation available to
us**, because node resolves it through `Object.prototype` and nativets has no prototype chain.
Whatever the value is backed by — a slot array, a HAMT, a comparison chain — `o["toString"]` is a
function in node and is not one here. Only a real prototype chain closes it, which this language
should not have.

Two corollaries worth having in writing, because each looks like a fix until you check it:

- **"Compile a literal-initialized `Record` to a real object and lower `rec[e]` to a comparison
  chain over its own keys."** Tempting, and the reasoning that gets you there is sound as far as
  it goes: objects are immutable (Stage 29), so a literal's key set is fixed *forever* — there is
  no `o[k] = v` that could add one — which means the key set is static and only the QUERY is
  dynamic. It still ships a silent wrong answer: the chain answers `undefined` for `toString` /
  `constructor` / `hasOwnProperty` / `__proto__`, and `ESCAPES[e] ?? e` would take the fallback
  where node takes the inherited function. That is exactly the expression that motivates the idea.
- **"Accept an object literal where a `Map` is expected, so `Record` values can be built."** This
  makes `Record` values *constructible* and thereby REACHES divergences that are unreachable
  today: `console.log(rec)` prints `Map(1) {…}` where node prints `{ n: '\n' }`, and
  `JSON.stringify` differs too. It would add two silent wrong answers to remove one refusal.

**Why today's behaviour is already safe**, which is the justification the mapping never had
written down: nativets objects have no prototype chain *and* the literal-key path refuses
inherited names outright ("Property 'toString' does not exist on `{n:string}`"), so the question
never gets asked. A `Map` is sound on the same axis — node's own `m.get("toString")` is
`undefined`, matching us exactly.

**The design that would actually work, sketched and NOT taken.** A comparison chain over the
object's own keys, and *on a miss* a check against the ~12 `Object.prototype` names that
**panics** rather than returning `undefined` — reusing the Stage 41 out-of-bounds panic mechanism
(the headline divergence at the top of this file). It is sound because it never answers where it
would be wrong, and cheap because only misses pay for the extra comparisons. It is a **stage, not
a lane**: it needs the chain in codegen, the name table in the runtime, and the panic path. Do not
implement the chain without the miss guard — the guard is the entire reason the chain is legal.

### Map/Set iteration: insertion-ordered (node-matched), but the iterators are arrays

Iteration **order matches node exactly** — node guarantees insertion order and the runtime keeps
a persistent insertion-order key log next to the (hash-ordered) HAMT, honoring node's rules:
re-`set`ting an existing key keeps its original position, `delete` + re-insert moves it to the
end. Supported: `for (const k of m.keys())`, `.values()`, `for (const [k, v] of m.entries())`,
`for (const [k, v] of m)`, `for (const v of set)` / `set.values()`, plus `Array.from(it)` and
`[...it]`.

The divergence: `m.keys()` is a **real array** here, where node returns a lazy **Map Iterator**
object. In `for-of` / `Array.from` / `[...]` the two are indistinguishable — everywhere else they
are not (`m.keys().length` is `3` for us, `undefined` in node). Rather than diverge silently, an
iterator is **only typed in those three positions**; anywhere else it is refused (`NT1014`).
Likewise refused, all with the working spelling in the hint:
- `for (const x of m)` / `[...m]` / `Array.from(m)` with a **single** binding — node yields a
  `[key, value]` **pair array** and we have no tuple type; use `for (const [k, v] of m)`.
- `.entries()` outside the `[k, v]` loop (same reason).
- `.forEach` on a Map/Set — use the (identically ordered) `for-of`.

### `new Set(iterable)` / `new Map(iterable)`: which sources are accepted

Bulk construction is **node-matched** for the sources we accept — the runtime folds the source
through the same add/put path `.add`/`.set` take, so dedup (SameValueZero: `NaN` dedupes against
itself, `-0` normalizes to `+0`) and the insertion-order log are maintained identically, and the
first occurrence of a duplicate keeps its position. Accepted: `new Set(array)`, `new Set(otherSet)`,
`new Map(otherMap)`. A copy is a **fresh handle**, as node's is — `new Set(a) === a` is `false`
(`===` on a collection is handle identity here, so aliasing the source would have been visible).

Refused:
- **`new Set(string)`** (`NT1014`). node iterates a string by **code point** — `new Set("a😀b")`
  has size 3 — while our string `for-of` walks **bytes**, which would silently build a 6-element
  set. A `string` cannot be proven ASCII at compile time, so the refusal is unconditional; the
  hint points at `new Set(s.split(""))` for ASCII input.
- **`new Map([[k, v], …])`**, the entries form (`NT1014`) — it needs the `[key, value]` **tuple
  type** we do not have (`["a", 1]` is already `NT2001`, "array elements must share a type").
  Use `.set`.
- **spreading a Map** (`[...m]`, `NT1014`) — the same gap reached from the other side, since a
  Map spread yields `[key, value]` pairs. `for (const [k, v] of m)` / `m.keys()` / `m.values()`
  are the supported spellings.

The `.set` chain the hint prescribes is not a workaround, it is the **same program**:
`Map.prototype.set` returns its receiver (ES2024 24.1.3.9 §8), and the constructor's entries form
calls `set` once per entry in order (24.1.1.1 §8). So `new Map([[a,1],[b,2]])` and
`new Map().set(a,1).set(b,2)` are one computation by construction, and — unlike the `.push`
rewrite — the chain costs bun nothing. Every `new Map` table in `src/*.ts` is spelled that way;
`test/collections.test.ts` lifts the real tables out of the real files and diffs nativets on the
chain against **node running the entries form**.

### Ordering: `.toSorted()` instead of `.sort()` — but `.reverse()` is accepted

node's `.sort()` sorts **in place**, which the immutable-by-default model forbids, so `.sort()`
on a **shared** array is refused with `NT1606` pointing at **`.toSorted()`** — the ES2023 *copying* method, which is
non-mutating in node too, so **node stays the oracle** (no divergence in what we do compile).
`.toSorted()`, `.toSorted(cmp)` and `.toReversed()` are node-matched: the default comparator
compares the elements' **string** forms (`[10, 9, 1].toSorted()` → `1, 10, 9`), and the sort is
**stable** (a merge sort), as node's is required to be. A comparator may be any function value
(inline arrow or a captured closure); its result is mapped to a sign, with `NaN` treated as `0`
like node.

**`.reverse()` is NOT refused** — unlike every other in-place mutator. It reverses in place and
returns its **receiver**, byte-for-byte like node, so `.toReversed()` is the *recommended*
spelling but not the only one. (Prior to this being written down, both this section and the
comment in `checker.ts` claimed `.reverse` was rejected alongside `.sort`; it never was.)

Because the call hands back the receiver, binding its result gives one allocation **two names**
(`const b = a.reverse()`). The ownership pass records `b` as an **alias** of `a` — the same
mechanism `@@mutable` handles use — so `a` remains the single owner and the value is freed
exactly once. Two consequences, both `NT16xx` refusals rather than divergences in behaviour:

- **an alias may not escape its owner's scope** — `const b = a.reverse(); return b;` is `NT1604`,
  since returning it would hand the caller a pointer this scope still drops. Write
  `return a.reverse();` (which *moves* the array out) or `return a;` instead;
- **the owner may not be reassigned while an alias is live** — `let a = …; const b = a.reverse();
  a = […];` is `NT1602`, which would otherwise leave `b` dangling.

Reading through both names is fine and matches node: after `const b = a.reverse()`, `a` and `b`
are the same reversed array.

**`.sort()` on a FRESH receiver is allowed** (and is *not* a divergence — it is node's own
answer). The immutability rule exists to stop one binding mutating an array another binding can
still see. A newly constructed array has no other owner, so sorting it is unobservable:
`[...xs].sort()`, `[3,1,2].sort()`, and `xs.map(f).sort()` / `.filter(f)` / `.concat(ys)` /
`.slice(0)` results are accepted, while `xs.sort()`, an alias `const b = xs; b.sort()`, a
parameter, a module-level array, and the result of a **plain function call** (`mk().sort()` — the
callee may still own it) stay `NT1606`. Freshness is decided syntactically by `freshArray` in
`src/ast.ts`, the single copy shared with codegen's receiver-temp free and the ownership pass.

The two rules compose through that one definition: `.reverse()` **passes freshness through**
(it hands back the pointer it was given), so `[3,1,2].reverse().sort()` is still a fresh
receiver and is accepted, while `xs.reverse().sort()` bottoms out at `xs` and stays `NT1606` —
sorting storage `xs` can still see is exactly what the rule exists to stop.

On a fresh receiver `.sort()` is exactly `.toSorted()` — same value, and the temporary it would
have sorted in place is discarded either way — so it is **rewritten to `toSorted`** in the
checker and lowers through the copying path above. That is what keeps the permission safe: the
rewrite means `.sort()` never hands its receiver back, so it cannot create the two-bindings-one-
array alias that in-place mutation would need. Verified in the emitted IR (the fresh temp is
freed exactly once, the result is a distinct pointer) and node-differentially in
`test/immutable.test.ts`, including node's lexicographic default (`[10,9,1,100,2].sort()` →
`1,10,100,2,9`).

### Binding a LINEAR FIELD off a BORROWED receiver is an ALIAS (`const b = o.lines`)

The third source of aliases, added for the same reason as the `.reverse()` one above and
closing a **use-after-free** rather than a leak.

```ts
type Box = { lines: string[] };
function probe(o: Box): string { const b = o.lines; return b.join("|"); }
const o: Box = { lines: ["a", "b"] };
probe(o);
console.log(o.lines.join("|"));   // node "a|b";  we printed an EMPTY LINE, at exit 0
```

`const b = o.lines` was **neither a move nor an alias** — nothing recorded the binding at all,
so it became an ordinary linear local and scope exit emitted `nt_arr_free(b)` on storage the
caller's object still points at. The next read through the owner printed an empty array **at
exit 0**, the silent-wrong-answer shape this project ranks worst; the same program through a
`@@mutable` class field **SEGFAULTED** (exit 139) out of a memory-safe language.

The binding is now recorded as an **alias** of the receiver, exactly as `const b = a.reverse()`
is, which is what the model already said the answer was: the object owns the field, `b` only
names it, and nobody frees it twice.

**Three borrowed receivers**, the same set the analysis already treats as borrows everywhere else:
a **linear parameter** (the caller owns and drops it), a method's **`this`** (the receiver belongs
to the caller), and a **`for-of` element** over a linear element type (the array owns it for the
loop's extent). The last two **SEGFAULTED** rather than merely printing a wrong answer:

```ts
type Tok = { parts: string[] };
for (const t of toks) { const b = t.parts; console.log(b.join("|")); }   // exit 139
```

**Alias, not refusal, and the distinction is the whole point.** The READ is safe and matches
node; refusing it would reject `const b = o.lines; b.length`, a shape this compiler's own source
is full of. What is unsafe is letting the handle **escape**, and that falls out of the alias
mechanism for free — an alias is a borrow binding, so `return b` is the existing `NT1604`.

One boundary, deliberate: a **locally-owned** receiver is untouched (`const o = { lines: […] };
const b = o.lines`) — there the move is genuine, `nt_obj_free` is shallow so nothing is freed
twice, and that shape compiles and matches node today.

The cost is a **leak where there used to be a dangling pointer** — the array-in-object class
`nt_obj_free` already leaks by construction (`docs/ROADMAP.md`, "Why ELEMENTS is not a one-line
fix"), so this joins a known list rather than opening a new one. Pinned node-differentially in
`test/drops-obj.test.ts` and as UI tests in `test/ownership/move-out-of-field.ts`.

### Assigning to a LINEAR PARAMETER is `NT1608` — it used to free the caller's value

The same borrow, written to rather than read from — and the same failure mode, one notch worse
because it did not reproduce identically.

```ts
function f(out: string[]): void { out = ["z"]; }
const acc: string[] = ["a", "b"];
f(acc);
console.log(acc.length);   // node 2;  we printed 3, then 6875746259392517000, at EXIT 0
```

`3` is not the length of anything in that program (`["z"]` is 1, `acc` is 2), and the next run
printed a fresh garbage integer. The spread spelling — `for (const n of names) out = [...out, n]`
— printed a different address-sized number on every run, always at exit 0. **Nondeterministic
output at exit 0 is the worst failure this project recognises**: a differential test can pass by
luck.

**Cause, one token wide.** `AssignExpr` sets `dropOld` — "this scope frees the value being
overwritten" — from `droppable()`, which proves only *not moved out* and *not captured by a
closure*. It never asked whether this scope **owns** the binding. A linear parameter is in
`linear` (the move checker tracks it) but is deliberately **not** in the scope-exit drop set,
because it is a **borrow**: `paramBorrows`, `src/ownership.ts`. `dropOld` was the one place that
read `linear` without also reading `borrowParams`, so `out = […]` freed the **caller's** array and
every later read of `acc` dangled. An **object** parameter took the same path and died on
**SIGTRAP** (heap corruption, exit 133) with nothing on stdout at all.

**Why a refusal and not a fix.** Suppressing `dropOld` for a borrow parameter is memory-safe and
matches node on every case above — but then nothing ever frees the value the *callee* allocated
(measured: `__arrLive()` **2** where 1 is live for the straight-line case, **5** where 1 is live
for the loop). Freeing it at scope exit instead needs a per-parameter drop flag for the paths that
did not reassign, and getting that wrong is a **double free** — strictly worse than what was
fixed. The pattern people reach for here is an accumulator out-param, and that **cannot work in
node either**: JS parameters are by-value bindings, so the caller never observes the rebinding.
`docs/self-hosting.md` had already decided the same question for a persistent `Map` — *return the
value*. So the rebinding is refused with the reason, rather than made to silently do nothing.

`NT1608` ≈ rustc **E0384** ("cannot assign twice to immutable variable"): a Rust parameter is an
immutable binding unless declared `mut`, which is the same rule arrived at from the same model.

**Only LINEAR parameters** — array, object, union, class instance. A `string` or `number`
parameter is `Copy`, is not in `linear`, and is untouched, so `s = s.trim()` keeps working. A
`for-of` element is a borrow too but is not in `linear`, so it never had the use-after-free; it
does leak the assigned value, which is the pre-existing container-element leak class, not this one.

**The hint that recommended it.** `NT1606` on `out.push(n)` used to answer "to accumulate in a
loop, reassign: `acc = [...acc, x]`". Applied to the parameter the reader was actually holding,
that is the second program above — the diagnostic handed out the use-after-free. The `.push` hint
is now receiver-aware: on a parameter it says the receiver is a borrow, names `NT1608` rather than
recommending it, and gives the true answer (accumulate into a **local** and **return** it). A hint
is trusted exactly when the reader is unsure, so one that routes into a refusal is worse than none.

Pinned in `test/drops.test.ts` (the refusal, plus the string parameter and the ordinary local that
must stay accepted) and `test/immutable.test.ts` (the hint, including the negative that the
rebinding advice is *absent* on a parameter receiver).

### `.push()` — refused by default, legal on a `@@mutable` ACCUMULATOR binding

> **Superseded in part.** The section below argued — correctly, and it is kept because the
> argument is still the reason the *fresh*-receiver permission was never taken — that a fresh
> receiver buys nothing and that the shape people want is a NAMED accumulator needing real
> in-place mutation. That shape is now legal, behind an explicit opt-in. Everything the old
> section says about a fresh receiver still holds: `[1,2].push(3)` is still refused.

```ts
//@@mutable
let acc: T[] = [];
for (…) acc.push(x);          // a real in-place append
```

**The default is unchanged.** `.push` on any other receiver is still `NT1606` with the spread
hint — the Stage 29 immutability rule is not relaxed, an opt-in is added next to it, exactly as
`@@mutable` was added for classes (Stage 45) and records (Stage 49). The attribute attaches to a
**BINDING**, not to a type: it never travels with the value, so an array handed out of the scope
(returned, stored, passed on) is an ordinary immutable array again and the caller cannot append to
it without opting in itself.

**Why the opt-in exists is a two-toolchain fact, not a semantics one.** `xs = [...xs, v]` is
already **O(1) amortized in nativets** — that is what the rest of this section documents. It is a
real **O(n) copy per append under bun**, and bun is stage 0: it runs `src/*.ts` and the whole test
suite today. 30,000 appends:

| idiom | bun | nativets |
|---|---|---|
| `xs = [...xs, v]` | 760 ms | 4 ms |
| `xs.push(v)` | 2 ms | 0 ms |
| builder object + `.build()` | 632 ms | 20 ms |

`lex`'s `tokens` reaches ~35,000 elements on `src/checker.ts` alone. This is a deliberate,
documented trade with a standing performance follow-up in `docs/ROADMAP.md`, not a silent
relaxation of the immutability model.

**What makes it sound.** `@@mutable` means TRUE in-place mutation, so exclusive access has to be
established — but not by a new analysis. Three facts the compiler already has do it:

- an array is **LINEAR**, so `const b = xs` **MOVES**; a second live handle cannot exist, and a
  push after one is the ordinary `NT1601`;
- a **PARAMETER** is a borrow (the caller owns and drops it) and cannot carry the attribute, since
  the attribute is on a `let`/`const`;
- `this.f`, `xs[0]` and `f()` name **no binding**, so they never match the opt-in.

The one hole those do not cover is a **CLOSURE WITH AN ENV**: a *bound* arrow copies the array
POINTER into a heap env this scope cannot null, and the closure may outlive the binding. A push to
such a captured accumulator is `NT1607`.

**An INLINED HOF callback is not that, and is allowed.** The rule was originally stated over "any
arrow", which refused the most idiomatic accumulator shape there is —
`src.forEach((x) => { out.push(x); })` — for a reason that does not apply to it. `.forEach`, `.map`,
`.filter`, `.reduce`, `.flatMap`, `.some`, `.every`, `.find`, `.findIndex`, `.findLast` and
`.findLastIndex` take an arrow **literal** (the checker requires one) and codegen emits its
statements straight into the enclosing frame as a loop: **no env is allocated, no pointer is
snapshotted, and the body cannot outlive the statement it is written in, because it IS the
statement.** The accepted program is exactly the `for-of` loop it desugars to, which always
compiled, and `nt_arr_push` mutates the `NtArray` header in place (only `a->data` is reallocated),
so the accumulator's pointer does not move under the loop either.

Two guards keep that narrow, and both are load-bearing rather than decorative:

- the **receiver must be an array** — a user class may declare its own `.forEach` taking a real
  function value, and *its* argument is an ordinary closure with an env. Remove this test and that
  program compiles;
- `.toSorted(cmp)` is **excluded**: its comparator goes through `Module.cmpShim`, which loads a
  `fn_ptr` out of a real `[fn_ptr, caps…]` env, so it is a closure in every sense the rule cares
  about.

The **drop** decisions (`droppable`, `dropOld`) deliberately keep consulting the wider,
conservative "mentioned inside any arrow" set. Relaxing a refusal costs a leak at worst; relaxing a
drop is the direction that mints a use-after-free, and the two are not relaxed together.

**The closure shapes that keep the refusal**, proved by mutation — with the guard forced off, a
returned closure over the accumulator compiles and ASan reports `heap-use-after-free … READ of size
8 … in nt_arr_push`, freed by `nt_arr_free`; and a reassigned binding compiles, exits **0**, and
prints `9 1` where node prints `9,1 2` — the silent wrong answer.

**The receiver shapes that stay refused**, each pinned in `test/push-accumulator.test.ts`:

| receiver | code |
|---|---|
| an undecorated local | `NT1606` |
| an **unmarked parameter** | `NT1606` |
| `this.<field>` on an **ordinary** class (the method copy-on-writes) | `NT1606` |
| an array field through a handle that is **not `this`** (`b.xs.push(v)`) | `NT1606` |
| a container **element** (`g[0].push(v)`) | `NT1606` |
| an accumulator captured by a **bound arrow** (one that gets an env) | `NT1607` |
| an accumulator captured by a `.toSorted` **comparator** | `NT1607` |
| an accumulator a **user class's** own `.forEach`/`.map` receives an arrow over | `NT1607` |
| an accumulator already **moved out** | `NT1601` |
| the accumulator while a `for-of` **borrows** it (iterator invalidation) | `NT1603` |
| a `@@mutable` class's field while a `for-of` over **that same field** is live | `NT1603` |
| `@@mutable` on a non-array, or on a multi-name declaration | `NT1023` |
| `.pop`/`.shift`/`.unshift`/`.splice`/`.fill`/`.copyWithin` — the opt-in legalizes `.push` ONLY | `NT1606` |

**`push` CONSUMES its argument**, exactly as `[...xs, v]` does, and getting that wrong was a real
use-after-free found in this lane: while the argument was merely borrowed (which is right for every
*other* call), a linear value pushed inside a function stayed owned by its local, the local freed it
at scope exit, and the array went on pointing at it — `g.push(a)` then `g[0].length` printed `3`
for a 2-element array, at **exit 0**. The move is guarded on the RECEIVER'S TYPE, not the method
name, so a user class's own `.push` still only borrows.

node's behaviour is matched exactly, mined from test262 `test/built-ins/Array/prototype/push/`: the
return value is the **new length** (`S15.4.4.7_A2`), `push()` with no arguments is legal and returns
the current length (`S15.4.4.7_A1`), and multiple arguments append **left to right** (`S15.4.4.7_A3`).

#### …and a SECOND receiver: a parameter carrying its own `@@mutable`

The table's "a parameter" row now reads "an **unmarked** parameter", because a parameter can
carry the opt-in itself:

```ts
function collect(
  //@@mutable
  out: Token[],
  s: string,
): void { out.push(lex(s)); }     // the CALLER observes the append
```

The accumulator's attribute is on a `let`/`const` and could never reach a parameter; a record's
is on the nominal TYPE, and an array type is structural, so that answer does not transfer
either. The marker goes on the parameter, which is still part of the SIGNATURE — the property
the record answer was chosen for. It needed **no new lexer syntax**: `//@@mutable` already lexes
to `@@` + `mutable` inside a parameter list, so the source stays valid TypeScript and node stays
the oracle with no stripping.

Two rules live at the CALL SITE, because the callee cannot see either: passing a **plain
parameter** into a marked position is `NT1607` (the marker must travel, or an unmarked hop
launders the mutation past every check below it), and passing a binding a live `for-of`
**borrows** is `NT1603` — a *wrong-answer* hazard, since a `for-of` reads its length once while
node re-reads it. `test/push-param.test.ts`; full design in `docs/decorators.md`.

#### …and a THIRD receiver: `this.<field>` on a `@@mutable` class

The table's "a field" row is gone. Inside a method of a `@@mutable` class, `this.f.push(v)`
on an array field is legal:

```ts
//@@mutable
class ModuleGen { liftedFns: string[] = [];
  lift(fn: string): void { this.liftedFns.push(fn); } }
```

**No new syntax** — the attribute is the one already on the `class`; `@@` on a class MEMBER
is still `NT1023`. An **ordinary** class keeps the refusal (its field-assigning method
copy-on-writes, so the append would land in the copy), and the receiver must be `this`
(`b.xs.push(v)` stays `NT1606`).

The refusal's stated reason — "`this.f` names no binding whose ownership can be
established" — was a fact about the *analyzer*, not the program: `this.f = [...this.f, v]`
already compiled with the same observable effect, and the field-read **alias** rule supplies
the exclusivity a local's linearity supplies. What it hid was **one** real defect, and it hid
it by making it uncheckable:

```ts
//@@mutable
class A { xs: number[] = [1,2,3];
  boom(): number { let s = 0;
    for (const x of this.xs) { if (this.xs.length < 40) this.xs.push(x + 100); s = s + x; }
    return s; } }
console.log(new A().boom(), new A().xs.length);   // node 24779 40 — we printed 6 6, exit 0
```

The same **wrong-answer** iterator-invalidation hazard the parameter rule above names, except
the check could not fire: `borrowed` was keyed by binding NAME, and a field has none. Fixed at
the key — the borrow is keyed by the receiver's PATH, so a bare name is its own path and
`this.<field>` has one too. That shape is `NT1603`, proved by mutation (remove the arm and
`6 6` returns). `.forEach` is deliberately **not** refused: node's `forEach` also snapshots the
length, so the inlined-HOF lowering agrees with node exactly.

Still refused on a field, exactly as on a local: `.pop`, `.shift`, `.unshift`, `.splice`,
`.fill`, `.copyWithin` — the attribute legalizes **append**, nothing else.

#### The original argument, kept: `.push()` gets NO fresh-receiver permission — unlike `.sort()`

The obvious next question after the rule above is whether `.push` can take the same treatment.
It **cannot usefully**, and it is refused on *every* receiver, fresh ones included.

The `.sort` permission works because `.sort` on a fresh receiver is rewritten to the **copying**
`.toSorted()` — same value, no mutation, so the aliasing question is never asked. `.push` has no
such equivalent: its value is the new **length**, and its whole purpose is the side effect.

A fresh receiver *could* be permitted by the same trick — `e.push(x)` on a fresh `e` is exactly
`[...e, x].length`, since the mutated array is a temporary nothing can name. But that is precisely
why it is **useless**: the mutation is unobservable *because* the result is discarded, so
`[1,2].push(3)` and `xs.map(f).push(9)` are dead code and no real program writes them. The
permission would buy zero expressiveness while adding an in-place path to the one method that has
already produced both a **double free** (a retained receiver owned by two bindings) and a **leak**
(a realloc that abandoned the old block). The shape people actually want — `xs.push(x)` on a named
accumulator — is *not* fresh, and needs real in-place mutation on a binding: the aliasing hazard
itself. A narrower correct rule beats a broad one with a use-after-free.

**The replacement is the accumulator**, already legal and node-exact:

```ts
let acc: T[] = [];
for (…) acc = [...acc, x];
```

This is *not* a copy per element — codegen's consuming-append (`consumingSpread`) lowers it to an
in-place append (`nt_arr_extend_own` **moves** the old block rather than copying it) whenever
nothing else shares the storage, so it is **O(1) amortized**. Worth stating explicitly because it
is the surprising direction: under node this exact spelling really *is* O(n²) — **12.4 s** for
100 000 appends, against **21 ms** for the same program built here, scaling linearly across
100k/200k/400k. Verified single-owner: 200 appends leave `__arrLive() === 0` at exit with exit
code 0, and the emitted IR has exactly **one** `nt_arr_free` site for the superseded array —
not zero (a leak), not two (a double free). The negatives — a named binding, an alias, a
parameter, a module-level array, a function's returned array, and all three fresh shapes — are
pinned in `test/immutable.test.ts`.

Two limits of the accumulator, both correct refusals rather than divergences:
- appending a **borrowed** loop element (`for (const t of src) acc = [...acc, t]`) is `NT1604`
  (cannot move out of a borrow); construct a fresh element instead (`{ ...t }` / a new literal),
  which compiles and matches node;
- assigning the accumulator from **inside a closure** currently **miscompiles** — captures are
  by value (`writeCapture` in `src/codegen.ts` stores into the closure env, never the enclosing
  alloca), so the write is silently dropped. This is a known open bug, not a divergence: it
  affects *any* write to a captured variable, not just arrays, and must become a refusal until
  by-reference capture exists.

### String relational compare (`<` `<=` `>` `>=`) is UTF-8 byte order

node compares strings by **UTF-16 code units**; we compare our UTF-8 bytes (`strcmp`), which is
**code-point** order. The two agree for the entire BMP up to U+FFFF *except* when an astral
character (≥ U+10000) is compared against one in U+E000–U+FFFF at the same position: UTF-16 puts
the astral string first (its lead surrogate is 0xD800–0xDBFF), code-point order puts it last. All
ASCII and ordinary non-ASCII text (accents, CJK) matches node exactly. Same rule applies to the
default `.toSorted()` on `string[]` and to `String#length` (see §2 below).

### Immutable-by-default: in-place mutation is rejected (B2, the "sharp turn")

Arrays and objects are **immutable**. In-place mutation is **refused** with `NT1606` (reject-don't-
miscompile), pointing at the immutable replacement:
- `arr.push(x)` / `arr.pop()` → use `[...arr, x]` (node's `.push` returns a length, `.pop` an
  element; rejecting avoids a silent semantic divergence).
- `arr[i] = v` (and compound `arr[i] += v`) → use `arr.with(i, v)`.
- `o.f = v` → use `{ ...o, f: v }`.

This is a deliberate divergence from node (which mutates). The immutable API is node-matched:
`arr.with(i, v)` is real ES2023, and spread runs identically on node. ~~`.with` does a full copy~~
**RESOLVED (B2 step 2)**: past 32 elements `.with` and the leading-spread append `[...a, x]` are
backed by a **refcounted persistent vector trie** and copy only the root→leaf path — O(log32 n) /
O(1) amortized instead of O(n), with the untouched subtrees shared by pointer. Not a behavioural
divergence: every observable (indexing, `.length`, `for-of`, HOF, `.join`, `.slice`, `.reverse`,
spread, `JSON.stringify`, `===`) stays byte-identical to node — see `test/sharing.test.ts`.
Consequence: `NT1603` iterator-
invalidation is now unreachable (you can't mutate during iteration if you can't mutate). `.reverse`
still mutates in place (which *matches* node, so not a divergence — but violates the frozen-value
spirit; slated to reject/copy-return later). Because it returns its receiver, binding its result
creates an alias rather than a second owner — see *Ordering* above. Heap `===`/`!==` on arrays/objects is **reference
identity** (pointer comparison), matching JS `===` on objects.

### `delete` is REFUSED — because absent and present-`undefined` are the same value here

`delete o.k` and `delete xs[i]` are rejected with **`NT1606`**, in every spelling (`o.k`,
`o["k"]`, `xs[i]`, on a `@@mutable` record, on an optional field, inside a nested function).
This is a *refusal*, not a divergence: nothing is compiled.

The reason is not that `delete` mutates — `@@mutable` already legalizes mutation. It is that
node's `delete` changes a value's **shape**, and node lets you *observe* the difference between
a key that is absent and a key that is present holding `undefined`. Measured against node:

```ts
const o: { a?: number; b: number } = { a: 1, b: 2 };
delete o.a;                 // → true    (a BOOLEAN; `true` even for a key that was never there)
"a" in o;                   // → false
Object.keys(o);             // → ["b"]

const u: { a?: number; b: number } = { a: undefined, b: 2 };
"a" in u;                   // → TRUE    ← present-undefined is NOT absent
Object.keys(u);             // → ["a","b"]
```

nativets has no representation for that distinction. An object is a flat `i64` slot array whose
field list comes from its **type** (`objectFields`, `src/ast.ts`); an omitted optional field is
still allocated and holds the same `undefined` an explicit one does; and `Object.keys`/`for-in`
lower to a **compile-time-constant** string array (`buildStringArray`, `src/codegen.ts`). So
`delete o.a` compiled as "assign `undefined`" prints `["a","b"]` where node prints `["b"]` —
exit 0 on both sides, differing stdout, no diagnostic. That is the silent-wrong-answer class the
prime directive exists to prevent, so `delete` is refused until a per-field **presence bit** and
a runtime `Object.keys`/`for-in`/`in` exist. This is the same reasoning `docs/decorators.md`
gives for `@@mutable` legalizing a **slot** but never a **shape**.

The array reading is refused separately and for its own reason, since node's array `delete`
punches a **hole** rather than removing an element:

```ts
const xs = [1, 2, 3];
delete xs[0];               // → true
xs.length;                  // → 3            ← length UNCHANGED
Object.keys(xs);            // → ["1","2"]
JSON.stringify(xs);         // → "[null,2,3]"
```

A dense slot array cannot hold a hole, and the record hint ("declare the field optional") is
wrong advice for an array — so `delete xs[i]` gets its own message naming the hole and pointing
at `xs.filter((_, i) => i !== 0)`. Pinned in `test/delete-refusal.test.ts`.

Not to be confused with `Map#delete` / `Set#delete`, which are supported and return a **new**
collection (see *Immutable `Map`/`Set`* above) — that is a method, not the `delete` operator.

### Key ENUMERATION over an optional field is refused (same root cause)

The key set of an object is decided **at compile time**, from its type. node decides it **at
runtime**, per value. An **optional** field is exactly where those part company, so these five
constructs are refused when the object type carries one:

| Construct | Code |
|---|---|
| `Object.keys` / `Object.values` / `Object.entries` / `Object.getOwnPropertyNames` | `NT1002` |
| `for (const k in o)` | `NT1010` |
| `k in o` (the operator) — the optional key only; see below | `NT1002` |

This closed a **silent wrong answer** — it is not a new restriction on working code:

```ts
type O = { a?: number; b: number };
const o: O = { b: 2 };
Object.keys(o);           // node ["b"]   — nativets printed ["a","b"], exit 0, no diagnostic
for (const k in o) …      // node "b"     — nativets printed "a" then "b"
```

There is no compile-time answer available: `f({})` and `f({a: 1})` reach the same call site with
the same static type and different correct key sets. The workaround is to read the field
(`o.a !== undefined`), or to use a `Map` when the key set genuinely varies at runtime.

Three things to know about the edges:

- **`a: T | undefined` is refused too, and that is over-refusal, not a bug.** nativets encodes
  `a?: T` and `a: T | undefined` identically (`?U<T>`), so it cannot tell them apart — even
  though node always has the key present for the second. Refusing both is the reject-don't-
  miscompile side of the trade; spell the field required if you need it enumerated.
- **`a: T | null` is NOT refused.** That is the `?N` arm, whose key is always present in node, so
  the static key list is already correct and stays accepted.
- **`JSON.stringify` agrees with node here by LUCK, not by design.** It skips slots holding
  `undefined`, which happens to match node's "absent keys are not serialized" — but it is the
  *value* being consulted, not a presence bit, so `{a: undefined, b: 2}` serializes as `{"b":2}`
  in both, while node's `Object.keys` still reports `["a","b"]`. Anyone changing that walk should
  not assume the agreement is load-bearing.

**`in` was refused unconditionally; it is now DECIDED, and that reasoning was the mistake.**
"Over a fixed shape it could only restate the declared type" is true and is not a reason to
refuse — restating the declared type IS the right answer, and it is the same answer node
computes, because over a shape with no optional field the presence set and the field set are
the same set. So `k in o` now folds at compile time, exactly as `instanceof` does:

| Shape | Answer |
|---|---|
| a literal key naming a REQUIRED field | `true` |
| a literal key naming NOTHING | `false` |
| a literal key on an `Object.prototype` name (`"valueOf" in {}`) | `true` — `in` walks the PROTOTYPE CHAIN |
| a literal key naming an OPTIONAL field | **`NT1002`** — `{}` and `{a:1}` share the type |
| a NON-literal key (`k in o`) | **`NT1002`** — see below |
| a `Map`/`Set` right operand | **`NT1002`** — see below |
| an array (`0 in xs`) | **`NT1002`** — INDEX presence, and the length is not static |
| a primitive (`"length" in "s"`) | **`NT1002`** — node throws a `TypeError` |

Presence, never truthiness: a field holding `undefined`/`0`/`""`/`false` is present. Folding
from the field list gets that for free, since no value is consulted.

Two of those refusals are worth their own line:

- **A non-literal key.** The own-key half would be a runtime string compare against a static
  list, which is fine — what defeats it is node's prototype chain. `"valueOf" in {}` is `true`
  (test262 `S8.12.6_A2_T1`) and nativets objects have no prototype, so an own-fields-only
  test would answer `false` there. A LITERAL key can be checked against `Object.prototype`'s
  names and is; a key we cannot see cannot.
- **A `Map`/`Set` right operand**, which is the trap. `Record<K,V>` erases to `Map<K,V>` here
  (see above), so `k in someRecord` reaches `in` with a Map on the right — and in node,
  `m.set("a", 1); "a" in m` is **`false`**: `in` tests the Map OBJECT's properties, never its
  entries. Lowering it to `.has` would be a silent wrong answer in the user's favour, so it is
  refused and `.has` is named as the fix.

Semantics are borrowed from tc39/test262 `test/language/expressions/in/` — `S8.12.6_A1`,
`S8.12.6_A2_T1`, `S8.12.6_A3`, `S11.8.7_A3` — each re-run against node as a `.ts` fixture in
`test/key-presence.test.ts`. The four enumerating `Object.*` constructs and `for-in` are
unchanged: they ask for the WHOLE key set, which an optional field really does make unanswerable.

### Strings are reference-counted, not linear (memory model)

Heap strings keep JS **value semantics** (free copy/alias) and are reclaimed by **reference
counting** — so, unlike arrays/objects (linear ownership + move-check), strings are **never**
move-checked: aliasing a string is always fine, no `NT1601` on strings. Reclamation is invisible to
behavior (rc is a memory-model detail); the only observable guarantee is no leak of heap strings
(`nt_str_live()` → 0). This supersedes the earlier "strings are linear" research direction.

#### The rc entry also memoizes the BYTE LENGTH, and one-byte strings are INTERNED

Two consequences of the representation, neither of them a divergence — `.length` returns the
same number it always did (UTF-8 **bytes**, §A.2 below, unchanged), and `s[i]` returns the same
one-byte string.

- **Length.** A nativets string is a bare NUL-terminated `char *`, so `.length` and `s[i]` both
  used to `strlen` the whole string: the scanner idiom `while (i < s.length) { const c = s[i]!; … }`
  was **O(n²)** in the input, measured at exponent 1.98 and 155 s to lex 1.39 MB. The byte length
  now lives in the rc side-table entry (computed once, lazily, on the first query). A length
  **header** was rejected: a string LITERAL is an `@.str` global in rodata and cannot carry one,
  and telling a literal from a heap string requires the side table anyway — so the table holds the
  length and a nativets string stays *exactly* a `const char *` at the FFI boundary.
- **Interning.** `s[i]`, `.charAt`, `.at`, `"".split("")` and the stdin byte reads return one of
  **256 interned statics** instead of a fresh 1-char allocation. Being untracked they behave like
  literals — `nt_str_retain`/`nt_str_release` are already no-ops for any pointer not in the table.
  So a character scan now allocates **nothing**: RSS over the same 1.39 MB lex fell 300 MB → 78 MB.
  The one visible effect is on the debug counter: `__strLive()` no longer counts characters, and a
  program that indexes strings reports a smaller live count than it used to.

### Actor receive timeouts run on a VIRTUAL clock (B3 v4)

`receive(ms)` / `receiveMatch(pred, ms)` are Erlang's `after`, but `ms` is measured on a **virtual
clock that only advances when the run queue is empty** — i.e. a timeout fires exactly when nothing
runnable could still send you a message, never by wall-clock sleeping. Consequences: (a) the value
of `ms` orders competing timeouts but does not make the program slower; (b) at quiescence *every*
pending timeout eventually fires, so a program whose only pending work is a long timeout completes
immediately instead of waiting. `ms <= 0` is Erlang's `after 0` — poll the mailbox, never block.
This is what keeps actor programs deterministic and their stdout byte-assertable.

### Actor messages are statically typed: `number | string` (B3 v4)

Messages travel through one 8-byte slot, so a message's type comes from the program, not the wire:
`const m: string = receive()` (the declared type), or the predicate's parameter type for
`receiveMatch`. Unannotated `receive()` is `number`. **String messages are deep-copied on send**
(isolation: the receiver never aliases the sender's buffer). Sending anything else — objects,
arrays, `Dyn` — is refused with a diagnostic (`NT1003`), never shipped without a deep copy. Because
sender and receiver are typed independently, each message also carries a runtime **kind tag**: a
receive compiled for `number` that meets a string aborts with a diagnostic on stderr (exit 70)
rather than reinterpreting the pointer — a runtime reject, never a miscompile.

### Actors are behavioral-tested, not node-differential (B3 v0)
node has no BEAM-style actor runtime, so `spawn`/`send`/`receive`/`self` programs can't use the
node oracle. They are verified by **running the native binary and asserting exact stdout**
(`test/actors/`) — deterministic under the single cooperative v0 scheduler; only **pairwise**
send-order is guaranteed. Actor programs are **host-verified only**: `nt_actor.c` uses `ucontext`,
absent from the Android NDK (API 24) — so the runtime is linked **only when a program uses
actors**, keeping the Android/iOS cross-build green for every non-actor program.

### M:N scheduler threads are OPT-IN, because parallelism is not free of meaning (B3 v6)

`NATIVETS_SCHED_THREADS` selects the scheduler at run time:

| value | scheduler |
|---|---|
| unset, or `1` | **the default.** One cooperative scheduler, one FIFO run queue, ucontext switches, reduction-counted preemption — v0..v5 exactly, byte for byte |
| `N` (> 1), or `auto` | `N` OS threads (`auto` = core count), each with its own scheduler + run queue, **work stealing** between them, and per-actor **lock-free MPSC** mailbox intake |

The default is single-threaded **on purpose**, and it is a divergence worth stating plainly:
a BEAM-style runtime would just use all your cores. Here, an actor program's stdout is only a
*specification* while the interleaving is a pure function of the program — which is exactly what
the whole `test/actors/` corpus asserts, and what makes a crash record reproducible. True
parallelism destroys that. So parallelism is a thing you ask for, and when you do, only what the
actor model actually guarantees survives:

- **guaranteed under M:N:** per-sender (pairwise) FIFO ordering, exactly-once delivery, mailbox
  contents, supervision outcomes (a crash still restarts the child under its registered name),
  eventual completion, and stable **pids** (one global actor table; actors migrate, pids do not);
- **NOT guaranteed:** any particular interleaving of two actors' output, which scheduler runs an
  actor, or the *order* in which independent actors reach a print. Programs that were relying on
  the single-scheduler order are relying on an artifact.

Two further behavioural differences in M:N mode, both consequences of real threads:

- **A brutal `__kill` of an actor that is RUNNING on another scheduler thread is asynchronous.**
  Its registers are live on another CPU, so the runtime records the kill and the victim reaps
  itself at its next compiler-emitted safepoint (`nt_reduction_tick`, at every call site and loop
  back-edge) — BEAM's discipline. Single-threaded, the kill is immediate as before.
- **Receive timeouts still use the virtual clock** (above): it advances only at *system-wide*
  quiescence — every scheduler idle and nothing queued or running — so the "fires exactly when
  nothing runnable could still send" rule is preserved rather than degraded to wall clock.

**Thread safety of the rest of the runtime.** The string refcount side-table and the persistent
vector's node refcounts (including Stage 44's `rc == 1 ⇒ mutate in place` transient, a
check-then-act) are single-threaded structures. Under M:N they run under one recursive lock,
installed by `nt_sched_init` *only* when it starts more than one scheduler thread; otherwise the
hook is `NULL` and the cost is one predictable branch. Values themselves need no protection: every
message is **deep-copied on send** (Stage 42) and arrays/objects are **immutable** (Stage 29), so
what crosses threads is shared *read-only* storage plus its refcount. Gated by ThreadSanitizer,
with a negative control that must report races when the lock hook is removed
(`test/runtime/mn_rc_race_test.c`).

**Async IO.** The poller (kqueue/epoll) exists and is gated (`test/runtime/poll_test.c`): an actor
can park on a file descriptor and be resumed by kernel readiness, costing no scheduler slice. It is
**not yet wired to any TS-visible IO**: `readLine` slurps all of stdin up front and `fetch` is
blocking libcurl (see "`async`/`await` … NO concurrency"), so today those still block their
scheduler thread.

### 2. `String#length` / string ops are UTF-8 byte-oriented
We store strings as NUL-terminated UTF-8 and measure/slice by byte. Identical to JS for
ASCII (all fixtures); differs for non-ASCII (an emoji is 4 bytes here, 2 UTF-16 units in JS).

**Scope: this is about the UNIT, not about character identity.** §A.2 covers how a string is
*measured* (`.length`) and *cut* (`slice`, `substring`, `s[i]`, `indexOf`) — byte offsets
instead of UTF-16 code-unit offsets. It does **not** license returning the wrong *character*.
`toUpperCase`/`toLowerCase` were once read as covered here and were a no-op outside ASCII;
they were not covered, and that was a defect, not a decision — `é` → `É` is two bytes to two
bytes in either encoding, so no unit question arises. It is fixed; the *remaining* limit on
case mapping is its own entry, **§A.4** below.

> `typeof undefined` (a former divergence) is now **supported** and matches node.

### 3. Pipeline operator `|>` (Elixir semantics, not TC39 Hack-style)
We implement `|>` (ROADMAP §B1) as a **pure parser desugar** with **Elixir semantics**:
`x |> f(a)` ≡ `f(x, a)` — the left operand is threaded as the **first argument** of the
right-hand call. It is the **loosest** expression operator (below `?:`/logical/comparison/
bitwise/arithmetic) and **left-associative**, so `a + b |> f() |> g(c)` → `g(f(a + b), c)`.

This deliberately diverges from the (unfinished) **TC39 Hack-style** proposal, which uses an
explicit topic token (`x |> f(%, a)`) placing the value wherever `%` appears. nativets has **no
topic token**. Rules (v1):
- The **RHS must be a call** whose callee is a **named function or a function-valued variable**.
  A bare identifier (`x |> f`), a non-call (`x |> y`, `x |> dbl() + 1`), or a member/method
  callee (`x |> obj.m()`) is a **clean parse error (NT0001)** — never a silent guess. We
  require the explicit call form `f()` (not F#-style tacit application) for one uniform rule.
- The value goes into **argument slot 0 only**; it cannot be placed in a later position or into
  multiple positions (those need the Hack topic and are intentionally unsupported).

**Oracle note:** `node` rejects `|>` outright today, so there is no oracle conflict yet; the
twin-file strategy (`test/pipeline/*.ts` + hand-desugared `*.twin.ts`, gated by
`test/pipeline.test.ts`) keeps a defined node oracle. If a Hack-style `|>` ever ships in
standard JS/TS, our `|>` will diverge from conforming TS (same token, different lowering) — this
entry is that pre-registered divergence.

### 4. `toUpperCase` / `toLowerCase` map U+0000–U+017F; above that they are the identity

`toUpperCase` and `toLowerCase` are **exact** for every code point up to **U+017F** — ASCII,
Latin-1 Supplement, and Latin Extended-A. From **U+0180 up** — Latin Extended-B, IPA, Greek,
Cyrillic, Armenian, Georgian, Latin Extended Additional, and the rest — a character is
returned **unchanged**, where node maps it:

```ts
"é".toUpperCase()   // "É"    — covered, matches node
"straße".toUpperCase()  // "STRASSE" — covered, matches node
"αβγ".toUpperCase() // "αβγ"  — node gives "ΑΒΓ"        ← the divergence
"да".toUpperCase()  // "да"   — node gives "ДА"         ← the divergence
```

**Why the line is here and not further out.** `runtime/` is **libc-only** so it cross-links
to macOS, Linux, iOS, Android, Windows and wasm. That rules out two otherwise-obvious
implementations:

- **`toupper`/`towupper` are locale-dependent.** The answer would vary with the environment
  the binary happens to run in, so the same program would print different bytes on two
  machines. A divergence that is *stable and documented* is worth more than one that is
  merely smaller but unpredictable, and an environment-dependent answer cannot be tested
  against a fixed oracle at all.
- **The full tables do not fit the constraint.** 2981 code points are cased. Beyond their
  size, `Default Case Conversion` is not a pure per-character function: it has
  **context-sensitive** rules (final sigma — `Σ` lowercases to `ς` word-finally and `σ`
  elsewhere) and **locale-sensitive** ones (Turkish/Azeri dotted and dotless `i`, Lithuanian
  retained dots). A `const char *` in, `const char *` out, with no locale argument, cannot
  express either. Implementing the table but not the conditions would be a *wrong* whole,
  which is worse than a *correct* part.

**What the covered range buys.** Those 360 cased code points collapse to six arithmetic
rules per direction plus eight exceptions, so the whole thing is exact in ~40 lines with no
tables at all. It also includes the five **length-changing** unconditional mappings, which
are the ones an implementation is most likely to get wrong:

| mapping | | note |
|---|---|---|
| `ß` U+00DF → `SS` | upper | one character becomes two |
| `ŉ` U+0149 → `ʼN` | upper | 2 bytes → 3 |
| `İ` U+0130 → `i` + U+0307 | lower | 2 bytes → 3 — the worst growth ratio, 1.5x |
| `ı` U+0131 → `I` | upper | 2 bytes → 1 |
| `ſ` U+017F → `S` | upper | 2 bytes → 1 |
| `µ` U+00B5 → `Μ` U+039C | upper | leaves the block entirely (into Greek) |

Because of these, neither method can work **in place** or size its output from its input;
both measure the result with the same mapper that fills it.

**Uncovered input is never damaged, including ill-formed UTF-8.** No decoder is involved:
the covered range is *self-identifying* in UTF-8 (one byte below 0x80, or two bytes with a
lead in `0xC2..0xC5` and a real continuation byte after it), so any byte that does not begin
a covered scalar is copied through singly and longer sequences reassemble untouched. That
matters more than it sounds, because §A.2 makes ill-formed UTF-8 **reachable from ordinary
source**: `.slice` cuts bytes, so `"é".slice(0, 1)` is a lone lead byte. `("é".slice(0, 1) +
"A").toLowerCase()` keeps the stray lead byte as-is and lowers the `A` — it does not re-frame
the pair into `Á` and eat the `A`, and it does not substitute U+FFFD.

**Tested by** `test/case-mapping.test.ts`: every code point in U+0001–U+017F swept against
node in both directions, every code point in U+0180–U+FFFF asserted byte-identical (the
regression test for *this* entry — it fails the day the range widens without this section
widening), the growth cases built under `-fsanitize=address`, and the half-character slice
above pinned at the byte level.

### Template-literal TYPES parse and erase to `string` — the pattern is NOT enforced

A template-literal type — `` `${string}` ``, `` `user-${string}` ``, `` `{${string}}` `` — is
accepted anywhere a type is (alias RHS, union arm, parameter/return annotation, object field,
array element, generic type argument, `as`) and **erases to plain `string`**. The literal
segments and the `${…}` placeholders are parsed for grammar and then dropped; we never check
that a value matches the pattern. `tsc` *does* check it, so this is a divergence from
**TypeScript**, and the only one in this document that has no node-side half:

- **node has no opinion.** It strips types without checking them, so the differential oracle
  agrees with us by construction — for every program in this class, `node` and nativets print
  the same thing. There is nothing here to miscompile.
- **The pattern cannot reach emitted code.** A template-literal type constrains which *strings*
  are well-typed; it never selects a different representation, a different instruction, or a
  different amount of storage. Every value it describes is already a UTF-8 string. So enforcing
  it would buy static strictness only, at the cost of a string-pattern matcher in the checker.
- **Consequence, stated plainly:** `const id: \`user-${string}\` = "nothing-like-it"` compiles
  here and is an error under `tsc`. We accept a program a stricter type-checker rejects. That is
  the safe direction for *this* construct — it widens what type-checks without widening what
  the generated code can do — but it is a real gap, and a pattern typo will not be caught.

**Interaction with `dyn as T` (next entry).** Narrowing a `Dyn` through a template-literal
type emits the ordinary **string** validator: `parsed.id as \`user-${string}\`` checks *that it
is a string* and nothing more, so a non-matching string passes (node agrees — it prints the
same thing), while a non-string still throws the documented runtime `TypeError`. The pattern
adds no validation; it neither tightens nor weakens the string check itself.

This is what unblocked the compiler's own `src/ast.ts:14`
(`` export type Ty = ScalarTy | `${string}[]` | `{${string}}` ``) — the only template-literal
type site in `src/`; before it, that line was a hard `NT0001` parse error. Fixtures:
`test/selfhost-types/template-literal-type*.ts`, each differential against node.

### `dyn as T` performs runtime validation (io-ts/zod semantics)

`JSON.parse(s)` returns a dynamic `Dyn`; narrowing it with `x as T` emits a validator that
walks the value against `T`'s static shape and **throws a runtime `TypeError` on a mismatch**,
then hands back a statically-`T` value. tsc/node **erase** `as T` (zero runtime checks), so:

- **Success paths match node** byte-for-byte (ordinary differential fixtures,
  `test/fixtures/stage20/json-parse-*`).
- **Failure paths deliberately diverge:** where node's erased `as` silently yields
  `undefined`/`NaN`/garbage, nativets **throws** (uncaught → non-zero exit, empty stdout). These
  are asserted by fiat (not the node oracle) in `test/typecheck.test.ts`, compiletest-style.
  Extra object keys are **stripped** (ignored), matching zod's default / io-ts `t.type`; there is
  no `.strict()` reject mode. `null` and absent are distinct (a present `null` tag vs a missing
  key). No `.int()` / NaN concerns — `number` is one IEEE-754 `double`, and JSON can't produce
  `NaN`/`Infinity` literals.

**JSON.parse danger zones** (stdout + exit code are compared, never the `SyntaxError` message
text): D1 reject-message text is V8-specific; D2 an embedded ` ` truncates our NUL-terminated
strings; D3 `.length` counts UTF-8 bytes not UTF-16 units for non-ASCII; D6 surrogate-pair `\u`
escapes and lone surrogates are not yet decoded (BMP `\uXXXX` is); D7 `-0` prints `-0` on direct
print but `0` via `JSON.stringify`. A **compound `Dyn` printed directly** (`console.log(parsed)`
of an array/object) would need `util.inspect` emulation and is deferred — scalars print correctly.

### A STATIC `expr as T` is CHECKED too — a false assertion PANICS

The entry above is `Dyn`-only. The same reasoning applies to `as` on an ORDINARY static value,
and until this landed it did not: `Checker.type`'s `AsExpr` case was
`{ this.type(e.expr, scope); return e.ty; }` — an identity retype with no check — and codegen
handed the same pointer back under the new type.

That is memory REINTERPRETATION, and `tsc` cannot save us from it: tsc **accepts** a
union-to-member downcast (the member is a subtype of the union), so no diagnostic anywhere fired.
This is one of the places the two type systems genuinely disagree, because tsc reasons about
types and nativets reasons about LAYOUT. Where tsc's unsoundness costs an `undefined`, ours cost
a slot read at the wrong offset:

```ts
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function bad(s: Shape): number { const c = s as { kind: "circle"; r: number }; return c.r; }
console.log(bad({ kind: "square", label: "hello" }));
```

node prints `undefined`. nativets printed **`2.1241009864e-314`** — the `label` string POINTER
loaded as a `double`. With two same-shaped arms it printed a perfectly plausible `3`.

**Now:** the assertion is checked and a false one aborts, with the same stderr + exit-134 shape as
the headline out-of-bounds panic and for the same stated reason — a wrong-but-plausible value that
the program keeps computing from is the worst outcome available.

```
panic: type assertion failed: the value is not {kind:string,r:number}
  its tag is "square"; the assertion requires one of: circle
  at examples/thing.ts:2:43
  help: `as` does not convert a value — it reinterprets the bytes at the asserted type's
        layout, so nativets checks the assertion rather than trusting it. Narrow with a
        `switch` on the discriminant, an `x.kind === "..."` test, or `typeof`, instead of asserting
```

**Refusing `as` outright was not available.** A lexer-accurate census counts **217** `as`
assertions in `src/` alone (51 `as Ty`, 28 `as Expr`, 26 `as Stmt`, 18 `as Stmt[]`, 16
`as VarDecl`, seven `as Extract<…>`), so a blanket refusal would break the compiler's own source
many times over. Hence a checked cast, reusing the machinery that already existed.

**What is checked, and what stays free** — the case analysis is entirely about representation,
so only the directions that can actually be wrong pay anything:

| Cast | Representation change | Cost |
|---|---|---|
| `U<…>` → one of its MEMBERS | none (a union IS the member pointer) | `nt_as_tag`: one slot load + a string compare |
| `U<…>` → an object SOME members can be read through | none | `nt_as_tag` against exactly those members |
| `U<…>` → an object EVERY member can be read through | none, and always TRUE | **free** — no check emitted |
| `U<…>` → an object NO member can be read through | — | **refused**, `NT2001` |
| member → `U<…>` (widening) | none, and always TRUE | **free** — no check emitted |
| `G<…>` → an arm, `?U T` → `T` | UNBOX a 2-slot `[tag, value]` block | `nt_as_unbox`: one tag test |
| arm → `G<…>`, `T` → `?U T` | BOX | the ordinary store-boundary `coerce` |
| identical layouts (`42 as number`, same-shape objects) | none | **free** |

The union rows are one predicate, `objectLayoutFits`: a shape can be read off a member when every
one of its fields sits at the SAME slot with the same type. That is stricter than assignability —
a field read compiles to a slot offset, so finding the key elsewhere is worthless, and `{a,b}`
asserted to `{b,a}` would take both at the wrong offset.

It is what makes the `(e as {name: string}).name` DUCK-TYPING idiom work rather than be refused:
the target need not be a member, only a readable window onto one. Getting there took a
correction — the first version of this rule required the target to BE a member, which refused
`src/`'s own `retainedReceiver` for no safety gain. Where NO member fits, there is nothing to
compare and the assertion is refused outright:

```
error[NT2001]: '{x:number}' is not a valid assertion for the union
               'U<{kind:"a",x:number}|{kind:"b",y:string}>':
               no member of the union can be read through that shape
```

That one was a SECOND silent wrong answer (`2.12e-314`, the `kind` pointer as a double, where
node returns `7`), left open by the first version of this lane's own fix and found by testing the
fallthrough rather than the reported case.

**A panic is not an exception**, exactly as for the out-of-bounds rule: `try { x as T } catch {}`
still aborts. The escape hatch is to narrow rather than assert — a `switch` on the discriminant,
an `x.kind === "…"` test, or `typeof` — all of which are proved at compile time and cost nothing.

Two further defects were closed by the same lane and are NOT divergences, just bugs:

- **A double free.** `as` reinterprets a PLACE, so `const b = a as T;` gives one allocation two
  names — and ownership did not know it, leaving `a` owned while `b` became an owner too. The
  scope freed the same pointer twice, out of safe TypeScript with no `@@mutable` and no `unsafe`
  construct anywhere, and SILENTLY: the allocator's abort discards buffered stdout, so the
  program printed nothing rather than a wrong answer. `b` is now an ALIAS of `a` (the rule
  `const b = a.reverse()` already used), which also keeps `as` legal on a borrowed PARAMETER —
  the shape `src/` is full of. Letting the alias ESCAPE is still `NT1604`.
- **A raw clang error.** `as` across a box boundary emitted IR that did not verify, so the user
  saw `'%t0' defined with type 'ptr' but expected 'double'` — no `NT****` code, no location in
  their own program, no hint.

`test/as-cast.test.ts` is the full spec; `test/unions.test.ts` pins the union case.

### `async` / `await` are real syntax, but there is NO concurrency (networking tier)

nativets has no event loop and no promises. The decision (deliberate, and the reason `fetch`
exists at all): **`async` is erased and `await` is an identity pass-through over an
already-resolved value**, while `fetch` and every other I/O call **BLOCKS**. The payoff is that
ordinary idiomatic source —

```ts
const res = await fetch(url);
const body = await res.text();
```

— compiles here **and runs unchanged under `node`**, so node stays the byte-for-byte oracle for
networking (`test/fetch.test.ts` runs the same `.ts` under both, against a local mock server).

What this buys and what it costs:

- **Matches node** whenever the program is *sequential*: each `await` resumes with the same value
  in the same order, so stdout is identical.
- **No interleaving.** `await` never yields, so nothing else can run while a request is in flight.
  Anything whose meaning depends on that is **rejected with `NT1020`**, never silently
  serialized-but-claimed-parallel and never miscompiled:
  - `Promise.all` / `Promise.race` / any `Promise.*` static, and `new Promise(...)`;
  - `.then(...)` / `.catch(...)` / `.finally(...)` on any value;
  - calling an `async function` **without `await`** when its value is used, or when top-level code
    follows it (under node that yields a *Promise* and lets the rest of the program run first).
    The one allowed form is the canonical entrypoint `main();` as the **last** top-level statement —
    with nothing after it, node's suspend-and-resume and our run-it-now produce identical output.
    This holds **across module boundaries**: `export async function` is supported (the `async` is
    erased there like anywhere else), and the async-ness travels on the export table — through
    `import { f as g }` and through `export { f } from "./m.ts"` — so an un-awaited call to an
    *imported* async function is `NT1020` too, not a silently-erased wrong answer.
    It also holds for an async **arrow**, which is the same promise wearing different syntax:
    `const f = async () => …` is guarded exactly as `async function f` is, and so are a direct
    alias chain (`const g = f; g()`), an immediately-invoked `(async () => …)()`, and an
    `export const f = async () => …` seen from an importing module.
    It holds for a **higher-order** async function too — one passed as a VALUE and called
    through a parameter, or handed back as a return value. That was the last silent wrong
    answer in this area: `callit(one)` where `function callit(f: () => Promise<number>)
    { return f(); }` printed `1` where node prints `Promise { 1 }`. The guard is NAME
    tracking and a name does not survive a call, so what carries the fact across the
    boundary is the **declared type**: a parameter or return type written
    `(…) => Promise<T>` is exactly as promise-returning as an `async function`, and a call
    through it needs `await` like any other. `Promise<T>` erases to `T` in type position
    (below), so this is read syntactically while the annotation is still tokens.
    A parameter is scoped to its own body, so two unrelated functions each taking an `f`
    do not contaminate each other.
    **The escape itself is checked**, because the type is only load-bearing if it is true:
    handing an async value to a parameter (or returning it where the return type says)
    *not* `(…) => Promise<T>` is `NT1020`. `function twice(f: () => number)` given an async
    arrow used to compute `1 + 1` = `2`; node concatenates two pending promises
    (`[object Promise][object Promise]`), and tsc rejects the assignment outright — we
    answered something neither of them says. An **unknown** callee (a method, a builtin, a
    value) counts as an escape too, since it declares no parameter to carry the fact.
    **Deliberate over-rejection.** A promise that is threaded through un-awaited and only
    awaited further up (`function callit(f: () => Promise<number>) { return f(); }` with
    `await callit(one)` at the top) produces node's answer here, but is still refused —
    exactly as the pre-existing guard already refuses the same shape for a *named* async
    function (`function callit() { return one(); }`). Knowing which of these is safe is a
    taint analysis over promise values; refusing the un-awaited call is the same rule
    everywhere, and `await` at the inner call site is always the fix.
    **Still out of reach:** an async function stored in an array or an object field — those
    are `NT1001`/`NT1002` (no heap function values yet), so they are refused before the
    async question arises rather than by this rule.
  - The diagnostic points at the **actor model** (`spawn`/`send`/`receive`, Stage 22/27/31), which
    is nativets' concurrency primitive. Promises may simply be the wrong abstraction here.
- `Promise<T>` in **type position** is erased to `T` (as are `Awaited<T>` and friends), so
  `async function f(): Promise<User>` annotates exactly as it does in TS.

### `fetch` is host-only, and its Response is a narrow subset

`fetch` / `Response` / `Headers` are backed by libcurl (`runtime/nt_http.c`), linked **only when a
program calls them** — so every non-fetch program, and every iOS/Android cross-build, stays
curl-free. Consequences:

- **Platforms:** macOS/Linux **host only**. iOS/Android would need the platform HTTP stack
  (NSURLSession / OkHttp / cronet) — a follow-on, exactly like the existing `httpGet`/`httpPost`.
- **Supported surface:** `fetch(url)`, `fetch(url, { method, headers, body })`; `res.status`,
  `res.ok`, `res.headers`, `await res.text()`, `await res.json()`, `res.headers.get(name)`
  (case-insensitive, `string | null`), `res.headers.has(name)`. Everything else on the standard
  `Response`/`Headers`/`Request` (streams, `res.body`, `formData`, `blob`, `arrayBuffer`,
  `redirect`/`signal`/`AbortController`, `res.statusText`, iterating headers, constructing a
  `Request`/`Response`) is **not implemented** and rejected.
- **`init` is read statically** — `method`/`body` are strings and `headers` is an object of string
  values, so the wire header block is unrolled at compile time. An unknown `init` key is rejected
  rather than silently dropped.
- **`await res.json()` returns a `Dyn`**, so narrowing it with `as T` performs the same generated
  runtime validation (and same deliberate throw-on-mismatch divergence) as `JSON.parse` above.
- **Errors match node's shape, not its message:** a transport failure (DNS/refused/TLS) **throws**
  a catchable exception, like node's fetch rejecting; a non-2xx is a normal Response with
  `ok === false` (no throw), exactly like node. The thrown value here is our message string, not a
  `TypeError` object — so compare control flow, not `e`.
- **Repeated response headers:** `.get` returns the **last** occurrence (correct across redirects)
  rather than node's comma-joined list.
- A `Response` is a plain heap handle: it is neither linear nor reference-counted yet, so it rides
  the allocate-and-never-free placeholder (safe; may leak for the process lifetime).

### Definite assignment — `let x: T;` read before it is assigned is REFUSED (NT1600)

A bare `let x: T;` whose `T` does not admit `undefined` starts with **no value**. node
prints `undefined` for a read before the first assignment; we have nothing of type `T` to
print and no slot to hold `undefined` in, so codegen could only serve the slot's zero —
`(null)` for a string, `0` for a number. That is a silent wrong answer, so instead the
read is **refused** with `NT1600` (≈ rustc's `E0381` "used binding is possibly-
uninitialized", the same rustc numbering `src/ownership.ts` already mirrors).

This is the one divergence in this entry: **node runs some of these programs and we
reject them.** Nothing is miscompiled.

```ts
let s: string;  console.log(s);              // node: undefined   — we REFUSE (NT1600)
let s: string;  s = "hi"; console.log(s);    // node: hi          — we agree ✅
```

The analysis is forward and path-sensitive; a merge keeps only what is assigned on
**every** incoming path, and a path that diverges (`return`/`throw`/`break`/`continue`,
or `process.exit(…)`) contributes nothing — which is what makes the guard-clause and
`try`/`catch`-and-exit idioms compile:

```ts
let source: string;
try { source = readFileSync(file, "utf8"); }
catch { console.error(`cannot read '${file}'`); process.exit(1); }   // diverges
console.log(source.length);                                          // ✅ assigned
```

Unsure is always a refusal, never an accept. These are rejected even though node runs
them, because the assignment is not provably on every path:

| Program | node | us |
|---|---|---|
| `let s: string; if (c) s = "a"; …s…` | prints `a` | **NT1600** — not assigned on all paths |
| `let n: number; while (c) { n = 1; } …n…` | prints `1` | **NT1600** — a loop body may run zero times |
| `let s: string; try { s = f(); } catch {} …s…` | prints the value | **NT1600** — the throw may precede the assignment |
| `let s: string; { let s: string = "in"; } …s…` | prints `undefined` | **NT1600** — the OUTER `s` is never assigned on any path |

That last row used to read "shadowing is name-indistinguishable here", and the refusal
really was about shadowing: this pass is name-based, codegen was too, and an inner
`let s` looked exactly like an assignment to the outer one. `alphaRenameShadows` gives
them different names before this pass runs (see *Block scopes get their own storage*
below), so the two are distinguishable now and the special-cased "redeclared" refusal is
gone. The program above is still refused, by the ordinary rule and for the true reason —
the outer `s` genuinely never gets a value. Shadowing an *assigned* binding
(`let s: string; s = "outer"; { let s = "in"; } …s…`) now compiles and prints node's
answer, where the old rule rejected it.

A `switch` only counts if it has a `default` **and** every case assigns or diverges. A
`do…while` body *does* count — it always runs once.

**The escape hatch is a different type, and it is not a divergence at all.**
`let x: T \| undefined;` genuinely *is* initialized to `undefined`, exactly as node has
it, and never reaches this check:

```ts
let s: string | undefined;   // starts as undefined — matches node ✅
console.log(s);              // prints "undefined", like node
```

### Block scopes get their own storage

Until `alphaRenameShadows` (`src/checker.ts`), codegen keyed a function's frame slots by
SOURCE NAME — `addLocal` returned early when the name was already known — so every block
scope in a function shared storage with every other one, and

```ts
const a: number = 1;
if (a > 0) { const a: number = 2; console.log(a); }
console.log(a);              // node: 2 then 1.  nativets: 2 then 2.
```

was a silent wrong answer, exit 0 on both sides, on the most basic construct the language
has. It was never really about *shadowing*: two **sibling** blocks reusing a name collided
identically, and at different types the first declaration's type won, so the second read a
string pointer as a double (`2.16e-314`) or crashed the compiler outright. With a linear
type it was a **double free**, exit 255. Every declaration form was affected — `const`,
`let`, an `if`/bare/loop/`try`/`catch` block, a `for` head, a `for-of` element, a `switch`
case, and a block declaration shadowing a **parameter**. Separate frames (an arrow body, a
nested function body) were always correct and are unchanged.

A declaration in a nested scope whose name is already spoken for in the frame is now
renamed to `name.N` — a spelling no source identifier can have — and every reference the
scope chain resolves to it is rewritten. Module-level bindings, parameters, a function
body's top-level names and `FuncDecl` names deliberately never move, so a program with no
name reuse inside a frame compiles to byte-identical IR. `test/shadowing.test.ts` has the
whole measured matrix against node; `var` is a separate matter — it is not supported at
all (`NT0001`).

**One shape is still wrong**, and it is the pre-existing forward-reference gap rather than
a scoping one:

```ts
const g = (): number => 100;
{ const f = (): number => g() + 1; const g = (): number => 5; console.log(f()); }
console.log(g());            // node: 6 then 100.  nativets: 101 then 100.
```

A name is bound where it is DECLARED, not on scope entry, so `f`'s reference resolves to
the outer `g`. Binding on entry is the correct JS model and resolves it to the inner `g` —
whose slot is uninitialized at that point, so `f()` called through garbage and the program
died at 255, which is strictly worse than a wrong answer. Forward-referencing a `const`
arrow is not supported anyway: the identical program with no outer `g` to absorb the
reference is `NT1003`.

**Related, and not fixed here:** nativets accepts two declarations of one name in a single
scope (`const a = 1; const a = 2;` prints `2`), which node rejects as a `SyntaxError`. Those
are the one case still sharing a frame slot, which is why the ownership pass keeps its
`shadowedNames` disqualification — it holds that gap to a leak rather than a use-after-free.

**A second shape is still wrong, and it is a `function` DECLARATION inside a block.**
`alphaRenameShadows` binds every hoisted `FuncDecl` name with `pinned = true` in *every*
scope, frame or not — "they genuinely hoist and never rename" — so a block-level
declaration keys the same storage as an enclosing declaration of that name, and the call
resolves to the *enclosing* one:

```ts
function fmt(n: number): string { return `outer:${n}`; }
function run(): string {
  { function fmt(n: number): string { return `inner:${n * 2}`; }
    return fmt(21); }
}
console.log(run());          // node: inner:42.  nativets: outer:21.
console.log(fmt(1));         // outer:1 on both.
```

Exit 0 on both sides, no diagnostic — a silent wrong answer, and the inner body is never
emitted. It survives at any signature: the shadowing declaration's parameters and return
type are simply ignored in favour of the outer function's.

It needs an enclosing declaration of the same name to land on. With no outer `fmt` to
absorb the reference — two **sibling** blocks each declaring `function tag()`, say — the
call is `NT1003` instead, so the refusal, not the miscompile, is the common case. That is
the identical structure as the `const g` gap above, and the same root: a name is resolved
against what the frame already knows rather than against the block that declares it.

Fixing it properly is not a rename. node's block-level function declarations follow
Annex B — the declaration creates a **var-scoped** binding in the enclosing function,
assigned where the block *evaluates* it — which is why node prints `4`, not `3`, for

```ts
function pick(): number { return 1; }
function outer(): number {
  let t = 0;
  { function pick(): number { return 2; } t += pick(); }
  t += pick();                 // still the INNER one: Annex B var-scoped it
  return t;
}
console.log(outer());        // node: 4.  nativets: 2.
```

Until that is modelled, the honest interim is to **refuse** a `FuncDecl` in a nested block
whose name is already bound in the frame, rather than pin it onto the outer one.

## B. Unimplemented features (we refuse to compile — never miscompile)

Everything else we don't support is **rejected with an `NT1xxx` diagnostic**, not silently
miscompiled. Run `nativets coverage <file>` to see exactly what blocks a program, grouped by
code, milestone, and frequency. The catalog lives in `src/diagnostics.ts` (`NYI`):

| Code | Feature | Milestone | Needs |
|------|---------|-----------|-------|
| NT1001 | arrays: empty `[]`, nested/object element types | M1 | (basic `number[]`/`string[]` are ✅ supported; `console.log(arr)` is ✅ node-exact — see the util.inspect section above) |
| NT1002 | objects: nested object fields, object methods | M1 | (flat objects, `.f`/`o["f"]`, `Object.keys`, `for-in` are ✅ supported) |
| NT1003 | arrow functions / function values / closures | M2 | captured environments |
| NT1004 | a `throw` with no `catch` IN THE SAME FRAME, unless the WHOLE PROGRAM contains no `try` (or the throw is at top level), or every call site of its function catches it one frame up; and any raise inside a `finally`-only `try` | M2 | propagation past ONE frame (see below); `try`/`catch`/`throw` within one frame ✅, an UNCAUGHT `throw` ✅, and a throw crossing ONE frame ✅ where the rule below allows it |
| NT1005 | `JSON` | M3 | `JSON.stringify` ✅ and `JSON.parse` + `dyn as T` runtime typecheck ✅ (scalars/objects/arrays, nested); code reused to reject un-validatable narrow targets (functions, unions). A compound `Dyn` now PRINTS node-exactly (util.inspect, see above) |
| NT1006 | spread | M2 | arrays/objects; spreading a VALUE into a call is supported only where the arity is known or the fold has an identity — see below |
| NT1007 | destructuring | M2 | arrays/objects |
| NT1008 | rest parameters | M2 | arrays |
| NT1009 | optional `?.()` call / general or >2-arm unions | M2 | `?.` on object fields **and `?.[i]` element access** ✅, `??`, and restricted `T\|undefined`/`T\|null` are ✅ (A2); the reused code now rejects only the out-of-subset forms |
| NT1010 | `for-in` | M1 | objects |
| NT1011 | `for-of` over non-strings | M1 | arrays/iterables |
| NT1013 | generics | M3 | generic **functions** monomorphize ✅ (Stage 36) and type arguments erase ✅ (SH2); the code now rejects only the corners below |
| NT1030 | a recursive type with nowhere to put a back-edge (`type P = Q[]`), an in-place write to a **cycle-capable FIELD** of a `@@mutable` record **or class** (in a method always; in a CONSTRUCTOR only when the value names `this`, since a constructor writes into a block nothing else can reach yet), or a cycle one of whose members is refused for its own reason | later | self- AND mutually-recursive object/union declarations now COMPILE via the nominal `@Name` back-edge; ordering was never the problem — see below |

### An UNCAUGHT `throw` compiles, and a throw may now CROSS ONE FRAME; deeper is `NT1004`

`throw` is lowered as a **branch to the enclosing `try`'s catch block**, which is why the
`try` has to be in the same function: there is no unwinder, and an exception has never been
able to leave a frame. That is still true. What changed is that the single refusal was
covering two different programs, and only one of them needs the unwinder.

A throw **nobody can catch** needs nothing at all. It is node's uncaught exception: whatever
was printed stays printed, the error goes to stderr, and the process exits **1**. Two shapes
are provably in that class, and both are exact rather than heuristic:

- the throw is in **module top-level** (`main`) — nothing calls top-level code, so no
  ancestor frame exists to unwind to. This covers a rethrow out of a top-level `catch` and a
  throw out of a top-level `finally`, neither of which its own `try` catches;
- the program contains **no `try` at all** — then no handler exists in any frame, after any
  number of calls.

Both lower to `nt_exc_raise_msg(<message>)` + `nt_exc_abort()`, the pending-exception
protocol the host FFI (SH4) has always used for an uncaught `ENOENT`.

**The divergence is the stderr TEXT, and only that.** node prints
`Error: boom` plus a stack trace naming source positions; we print one line,
`nativets: uncaught boom`. stdout and the exit code match node exactly, which is what the
differential asserts (`test/uncaught-throw.test.ts`). A stack trace needs frame metadata the
compiled program does not carry.

**A throw may now cross ONE frame** — the ordinary "raise in the callee, handle at the call
site" idiom, which was the second thing the single refusal covered. It uses the SAME
protocol: the escaping frame raises on the pending flag and returns its default, and the
caller checks the flag after the call exactly as it already does after a fallible host
call. No unwinder appears, and no IR form that did not exist before.

It is allowed only where a raise **provably cannot reach a call site that fails to check**,
because a set flag that nobody checks means a zeroed default and a program that carries on —
a silent wrong answer. So `scanEscaping` (src/codegen.ts) admits a function only when all of:

- every call site is a **direct** call sitting inside a `try` WITH a `catch` in its
  immediate caller — or in `main`, whose uncaught arm is node's own behaviour;
- the name is **never used as a value**, so no closure or function-value call can dodge it;
- the thrown type is one the slot can carry — a `string`, or **any object** (see the next
  subsection) — and **every covering `catch` binds exactly that type**. The binding is not
  `any` here, and reconstructing a different shape into it is the raw-store bug the in-frame
  `ThrowStmt` already refuses;
- no `throw` in the function sits in an arrow body, and the program uses no actors (an
  actor handler is called by the scheduler, from no call site the scan can see).

**One frame, by construction:** the first rule means an escaping callee's raise is always
consumed by its immediate caller, so no intermediate frame ever has to propagate.

**Still refused:** a throw with the `try` **two or more** frames up. Every intermediate
frame would have to propagate too, which needs an exception check after every call that can
raise AND the live owned set dropped at each of those call sites — the drop set exists for
throws (`ThrowStmt.drops`) but not yet for arbitrary call expressions. On the compiler's own
program that is the whole cost: only **16 of 1209** call sites reaching a may-throw callee
sit inside a `try`/`catch` in their own frame, so the one-frame rule clears none of stage-1.
See docs/self-hosting.md. Also refused: `throw 42`, and any payload that is neither a string
nor an object — there is nothing to put on the slot and inventing one would be a wrong
answer. (`throw { … }` with **no** `message` field is fine now: the object moves, and the
message was only ever needed for the stderr line an uncaught raise prints.)

#### The payload crosses the frame by MOVE — the object pointer, not a copy

The pending-exception slot used to be one `const char *`, so a raise could carry a `string`
or the single-field `{message:string}` that `new Error(m)` is here, which `emitExcCheck`
rebuilt by BOXING the message. Anything richer was `NT1004` — and `src/` throws
`NTError{message,name,diag:{code,spans}}` at 145 sites.

Widening it by **flattening** was measured against the linked stage-1 tree and is dead:
today's rule clears **7** of the 129 NT1004 seed functions, N flat scalar fields clears
**20**, and a DEEP recursive flatten clears **20** as well — literally nothing more, because
`NTError.diag` carries `spans?: DiagSpan[]`, an optional ARRAY that no flattening carries.
Moving the pointer clears **83**.

So the object BLOCK POINTER goes on the slot and the single owner transfers with it:

| step | what owns the object |
|---|---|
| `nt_exc_raise_obj(obj, msg)` | the slot. `ThrowStmt.drops` subtracts the thrown name, so the raising frame does **not** free it |
| `nt_exc_take_object()` in the `catch` | the binding. The call **NULLs the slot**, and the handler's existing drop set frees it once |
| `nt_exc_clear()` | frees only what nobody took — i.e. `catch { }` with no binding |
| uncaught → `nt_exc_abort()` | nobody; the process exits 1 |
| a raise while one is already **pending** | the old payload is cleared first. That silently leaked a retained message before, and would now leak the object too |

Exactly one owner and exactly one free, and **nothing is copied** — so a nested `diag` is
never walked, and a shared sub-object can never be double-freed. `msg` rides alongside as a
BORROWED view of the object's `message` field (or `null`), used only for the stderr line an
uncaught raise prints; it is retained and released on the message path independently.

**The `const char *` fast path stays**, and that is a fact about host calls rather than a
conservatism: `JSON.parse`, `fs` and `fetch` raise a message and have no typed object to
hand over. So a `catch` binding reached from a HOST call can still only be a `string` or
`{message:string}`, and one binding a richer record inside the same `try` is `NT1004` — give
the host call a `try` of its own whose `catch` binds one of those two. A USER function's
`throw` of that same record does cross the frame.

Pinned in `test/exc-move.test.ts`, including the leak probes (two scales, since a fixture
that ends at zero because its frame exited proves nothing) and an ASan run with
`sanitize_address` asserted present on the `define`s — on macOS LeakSanitizer does not exist,
so use-after-free and double-free are the two faults a sanitizer can actually see here.

##### CLOSED: an IN-FRAME `throw` of a local declared OUTSIDE the `try` double-freed

The move above is the CROSS-FRAME path. The in-frame path — a `throw` lowered as a branch to
the enclosing `catch` — did not move, and where the thrown value is a linear local declared
outside the `try`, two owners freed one block:

```ts
class E { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }
function run(n: number): number {
  const err = new E("x", n);
  try { if (n % 2 === 0) throw err; return n; } catch (e) { return e.code; }
}
```

node printed `190` for a loop of 20; nativets **exited 133 with no output and no diagnostic**
(exit 255 through the test harness). The handler emitted `nt_obj_free` twice on the same
pointer — once for the catch binding (an owner since the `TryStmt` case in
`src/ownership.ts`) and once for `err` (still an owner). Present at `47b28d2`, i.e. it
predated the move work and was unchanged by it.

**The one-word fix needed a SECOND fix first, and the two shipped together.** Making the
`throw` consuming (`this.expr(s.argument, state, true)`) fixes it — the conditional-drop
machinery (`condDrops`/`moveSites`/`nullOnMove`) nulls the slot at the move site, so the
second free is the no-op `nt_obj_free(NULL)` — but on its own it also refuses
`if (c) throw err; use(err);` as `NT1601`, on a program node runs: the ownership pass merged
an `if` branch back into the state unconditionally, so a value moved on a TERMINATING path
was seen as maybe-moved afterwards. That was never specific to `throw` — `return` is
consuming today and had exactly the same false positive at `47b28d2`:

```ts
function pick(n: number): E {
  const a = new E(n);
  if (n % 2 === 0) return a;
  return new E(a.code + 1);   // node: fine. nativets: NT1601 "use of moved value: `a`"
}
```

**The rule that shipped.** An `if` arm or a `switch` case that LEAVES THE FRAME contributes
nothing to the fall-through join, because that join is not a program point on any path
through it (`Analyzer.escapes`, `src/ownership.ts`). Three conditions, each load-bearing:

| condition | why it is there |
|---|---|
| `leavesFrame` — every path out of the arm is a `return`/`throw` | a LOOP body never counts however it ends: it may run zero times. An `if` counts only when BOTH arms diverge |
| `hasJump` — no `break`/`continue` anywhere in the arm | those leave the BLOCK, not the frame. `for (…) { if (c) { const b = a; if (d) break; return 1; } } use(a);` looks diverging on the `return` and reaches `use(a)` down the `break` with `a` moved |
| `tryDepth === 0` — not lexically inside a `try` | a `return` there runs the `finally` and a `throw` runs the `catch`; both read this state, and the catch/finally ENTRY state *is* the block's fall-through state, so there is nowhere else for the moves to be recorded |

`break` and `continue` therefore still merge unconditionally, and that is a deliberate
conservatism, not an oversight: `if (c) { const b = a; break; } … ; use(a)` after the loop
is refused where node runs it. Relaxing them needs the dataflow to grow a second,
EXCEPTIONAL state — the same split `src/checker.ts` already made for definite assignment
(`DAExit`/`DAEscapes`, see "`break` is not `return`" above) — not a wider predicate. The
same goes for the `try` guard.

**One new refusal.** Reading the raised local FROM the handler is now `NT1601` where it used
to compile and exit 255:

```ts
const err = new E("boom");
try { if (n > 0) throw err; return 1; }
catch (e) { return err.message.length; }   // node: 4. nativets: NT1601
```

To node `err` and `e` are one object; to us the raise MOVED the pointer to the handler's
binding, so naming the raiser is a use-after-move. A refusal in place of a silent double
free is the trade this project always takes. Read it through the catch binding (`e`).

Pinned in `test/move-diverge.test.ts` — seven newly-accepted programs against node, five
refusals that must stay refused (including both `break` shapes and the `finally` one),
`__arrLive`/`__objLive`/`__strLive` at two scales 4x apart, and ASan builds with the
`sanitize_address` attribute asserted present rather than assumed.

The **stderr text divergence above applies to a propagated throw that nobody catches too**:
it reaches `main`, and `main` prints one line and exits 1 where node prints a stack trace.

#### The second shape is WHOLE-PROGRAM, and narrowing it to the per-throw rule buys nothing

Read the second bullet literally: the gate is `scanHasTry(program)`, a structural walk of the
entire linked program, not a property of the throw. So an uncaught throw that crosses nothing
is refused because **an unrelated function elsewhere in the program contains a `try`**:

```ts
function boom(n: number): number { if (n < 0) throw "negative"; return n * 2; }
function unrelated(): string { try { return "ok"; } catch (e) { return "bad"; } }
console.log(boom(1));            // node: 2. nativets: NT1004 at the throw.
```

Delete `unrelated`'s `try` and the identical throw compiles and prints `2`.

> **RESOLVED 2026-08-10.** That exact snippet compiles now, and prints `2` — not by
> narrowing `scanHasTry` (the paragraphs below still stand: the honest per-throw rule
> clears zero of the compiler's own sites) but because `boom`'s only call site is in
> `main`, which the cross-frame rule above admits: the throw raises on the flag, returns,
> and `main`'s check aborts with node's exit code. Pinned in
> `test/cross-frame-throw.test.ts`, "uncovered call from main, in a program that HAS a try
> elsewhere". What remains true is the general point — the whole-program bit still gates
> every shape the cross-frame rule does NOT admit.

That over-approximation was measured rather than assumed, because the header above promises a
per-throw property (*crosses a call boundary*) that the code does not implement. The honest
rule is implementable — build the call graph, mark every function transitively reachable from
a call site inside a `try` block, and a throw in a function outside that set can be lowered as
uncaught. **On the compiler's own linked program it clears zero of the 123 NT1004 functions**,
under an over-approximating (therefore sound) call graph:

- `parser.ts`'s `tokenize` does `try { tokens = lex(source) } catch`, so `lex` and
  `decodeEscapeAt` — the two NT1004 refusals that make `lexer.ts` dirty when linked, though it
  reaches IR standalone — are **genuinely** caught across a frame. They are the documented
  rule working, not the over-approximation misfiring;
- `coverage.ts` wraps `parse`, `linkProgram` and `check` in `try`/`catch` for its recovery
  path, which puts essentially every function in the lexer, parser, linker and checker inside
  a live handler's dynamic extent;
- what is left over is reached through function-valued calls (`try { return f(); } finally`),
  which no sound analysis can resolve without whole-program closure typing.

So for **this** program the whole-program bit is very nearly exact, and the refusal count is a
statement about `try`-based error recovery in the compiler, not about the gate's precision.
For ORDINARY programs the over-approximation is real and it does refuse working code — the
snippet above — which is the honest cost of the current gate and the reason it is written down
here instead of only in a code comment.

#### The NT1004 tail GROWS when we do the right thing, and that is the argument for propagation

`parseTupleType` is the worked example, and it is worth stating because the obvious reading of
it is wrong. It looks like new code landing already-refused; the count of the compiler's own
functions went 701 → 702 in the same cycle it appeared in the tail. It is neither.

The function dates to the Stage-19 baseline, and at `5f90e26` it was seven lines with **no
`throw`** and no blocker: it read `[T, U, …]`, kept `tys[0]`, and returned `T[]`. That was a
silent wrong answer — the erasure invented a type and then blamed the program for it (above,
and `test/tuple-type.test.ts`). Replacing it with an honest `throw nyi(NYI.TUPLE, …)` is
exactly what "reject, never miscompile" asks for. And that `throw` is `NT1004`, genuinely so
rather than through the over-approximation: `parseParenOrFuncType` does `try { return
this.parseFuncType(); } catch { this.pos = save; }`, and `parseFuncType` → `parseType` →
`parseTupleType`, so a heterogeneous tuple inside a parenthesized function type has its throw
caught one frame up, by design.

So the tail did not grow because someone wrote careless code. **It grew because a lane removed
a silent wrong answer**, and the honest replacement for a silent wrong answer is a `throw`.
Every such fix that lands in a function reachable from a `try` adds one, and this compiler
catches around its own front end deliberately (`tokenize` around `lex`, `coverage` around
`parse`/`check`, `parseParenOrFuncType` around `parseFuncType`) because recovery is a feature.

The two prime rules therefore pull against each other while cross-frame propagation is missing:
obeying "reject, never miscompile" enlarges the one refusal that most blocks self-hosting. That
is a stronger reason to do the propagation work than the size of the tail on any given day,
because the tail is not a fixed backlog to be burned down — it refills from correctness fixes.

#### A `finally` with no `catch` is NOT a handler

`try { … } finally { … }` catches nothing: node runs the finalizer and keeps propagating. The
lowering has no way to express that — a `throw` is a branch to a catch block, and there is no
catch block — so a `throw`, or any call that can raise, inside a `finally`-only `try` is
`NT1004`. Give the `try` a `catch` clause, or move the raising code out of it.

This was a **raw clang error** before it was a refusal. `TryStmt` pushed a handler entry
unconditionally but only emitted the block it names when the `try` had a `catch`, so the throw
terminated its block with `br label %catchN` for a `%catchN` that does not exist:

```
build error: clang failed (1): … error: use of undefined value '%catch1'
```

— a temp path and a line of our own IR, from three ordinary shapes: a `throw` in a catch-less
`try`, the same nested inside an outer `try`/`catch`, and a `JSON.parse` failure in a
catch-less `try` (the last through `emitExcCheck`, the host-failure path). No miscompile —
clang rejects the module either way — but no `NT****` and no hint either.

### `catch (e)` takes ONE type — a `try` with throws of two types is `NT1004`

node's `catch` parameter is `any`. Nothing here is, so the binding is given ONE type, from
three sources in precedence order:

1. the **first `throw` the checker can see in the block** — it decides the type it throws;
2. what the block's **callees raise**, when they all agree on one type;
3. `{message:string}` when the block calls a host builtin (SH4) — an `fs` failure is an Error.

A block that can produce two different types therefore has no honest binding type, and is
refused, naming both and where each came from.

**Rule 2 is new, and without it the payload work above is unreachable in real code.** The
plain idiom — the one `src/parser.ts::tokenize` is written in —

```ts
try { return lex(s) } catch (e) { e.message }
```

has no `throw` in the block at all, so the binding fell to the `"string"` default, and
`scanEscaping`'s third rule requires the covering binding to EQUAL the raised type. Every
object payload in `src/` is written this way, so the slot's capacity was never the only
blocker. Measured: `test/escape-metric.ts`'s `SEED w/ CARRIABLE` row went **7 → 83**.

Rule 2 is **syntactic**, and it has to be: it runs while checking some other function's body,
so the callee may not have been checked yet and its `throw` arguments carry no type
annotation. Only the spellings that need no scope are read — a string, a template,
`new Error(m)`, and `new C(…)` on a user class (whose instance type is parameter 0 of its
registered constructor signature). Everything else answers **"cannot say"**, which leaves the
binding at today's default and keeps the NT1004: a refusal, never a wrong binding type. In
particular `const err = new C(…); throw err;` is not read, because the identifier needs the
callee's own scope; nor is a **method** call in the block, because a method resolves only by
PROPERTY name and every same-named method in the program would have to agree.

This was a **silent wrong answer** before it was a refusal, in two shapes:

```ts
function f(n: number): void {
  try { switch (n) { case 1: throw new Error("boom"); } } catch (e) { console.log(e); }
}
f(1);        // node: `Error: boom`      nativets: `}@`   — AT EXIT 0
```

The scan did not descend into a `switch`, so the binding kept its `"string"` default and the
`throw` stored the object pointer into it raw. That one is **fixed** — the scan now covers
`switch` — and it is not refused, it compiles and matches node. The second shape:

```ts
try { if (n > 0) throw new Error("boom"); throw "plain"; } catch (e) { console.log(e.message); }
```

is the one that is refused: the string would be stored under `{message:string}`, and reading
`.message` reads the first eight bytes of `"plain"` as a pointer. Deliberately **not**
descended into: a NESTED `try`, whose throws belong to its own `catch`.

### Spreading a value INTO a call — the three cases, and why only two compile

`f(...xs)` needs to know how many arguments it is producing. There are three shapes, and
only the first two have an answer at compile time:

1. **The length is syntactic** — `f(...[a, b])` inlines to `f(a, b)`. No array is built.
2. **The arity is fixed** — `f(...xs)` for a declared `f(a, b)` expands to `f(xs[0], xs[1])`.
   Extra elements are discarded, exactly as in node.
3. **Neither** — refused with **`NT1006`**, *except* for `Math.max` / `Math.min`, which fold
   with a well-defined IDENTITY (`-Infinity` / `+Infinity`). Because the identity exists, the
   length need not be known: `Math.max(...xs)` lowers to a runtime fold over the array, an
   EMPTY array correctly yields `±Infinity` rather than an arity error, and spreads mix
   freely with fixed arguments (`Math.max(1, ...xs, 5)`). The spread must be a `number[]`.

The fold step is `js_math_max`/`js_math_min` in `runtime/runtime.c`, **not** C's
`fmax`/`fmin`: `fmax(NaN, 1)` is `1` where JS says `NaN`, and IEEE-754 `maxNum` leaves the
`+0`/`-0` case unspecified where JS orders them (`Math.max(-0, 0)` is `+0`, `Math.min(-0, 0)`
is `-0`). Both were silent wrong answers before `test/variadic-spread.test.ts` pinned them.

Spreading into a **rest parameter** (`function total(...ns: number[])`) falls in case 3 and is
refused. It previously miscompiled: a rest parameter counts as one entry in the signature, so
`total(...xs)` expanded as case 2 to `total(xs[0])` and answered `1` where node answers `6`.

### Generics — what M3 deliberately does NOT do (all rejected, never miscompiled)

Generic function definitions are compiled by **monomorphization**: one specialization per distinct
type-argument tuple, resolved from explicit call-site type args or inferred structurally from the
argument types. node runs the same source unchanged (it just strips annotations), so every
supported case is node-differential — there is **no runtime divergence**. The refusals:

- **Polymorphic recursion** — a generic whose self-call uses a *bigger* type argument
  (`f<T>` → `f<T[]>`) has no finite monomorphization. Capped at 200 instantiations, then
  `NT1013` (TypeScript itself accepts this; we reject rather than diverge).
- **A generic used as a value** (`const g = id;`) — specialization happens at the CALL site, so a
  generic has no single type to store. `NT1013`, with a hint to call it directly.
- **Uninferrable type arguments** (a type parameter that appears in no parameter, e.g.
  `function make<T>(): number`) — `NT1013`, with a hint to pass them explicitly (`make<string>()`),
  which IS supported.
- **Generic arrows are not monomorphized** — an arrow is a value, so `<T>(x: T) => …` takes its
  *contextual* parameter type when used as an argument (this works at any type), and otherwise
  falls back to the pre-M3 erasure of `T` to `number`. Using a standalone generic arrow at a
  non-number type is therefore a plain `NT2001` type error, not a miscompile.
- **Generic classes** (`class Box<T>`) — `NT1015` (classes are not monomorphized at all).
- **Constraints and defaults are erased** — `T extends U` / `T = U` are parsed and dropped;
  specialization is driven by the types that actually flow, so a constraint adds nothing, but it
  is also **not enforced** (a bound violation surfaces as an ordinary error inside the
  specialization, not as a constraint violation at the call site).

### Indexed access types (`T["field"]`) — resolved exactly, or refused (`NT1029`)

An indexed access type (TypeScript's "lookup type") is a pure type-layer construct: node strips
it, so every supported case is node-differential and there is **no runtime divergence**. It is
resolved **precisely or not at all** — when the base is a record whose fields are known in *this
file* and the key is a string **literal**, the lookup becomes that field's type exactly. The
refusals, all `NT1029`:

- **A non-literal index** — `T[number]` (array element), `T[K]`, `T[keyof T]`. Each would have to
  stand for several types at once, which this subset cannot represent. The hint names the
  supported spelling.
- **A base whose fields this file does not know.** An unknown named type erases to `number` in the
  parser (`resolveNamed`), so a *cross-module* `Mod["field"]` has no fields to look up. This is
  the common case, and the hint says to declare the type here or write the field's type directly.
- **A key the record does not have** — the hint lists the fields it does have.

Why refuse rather than erase: a lookup carries no runtime of its own, but its **result** decides
how the annotated value is stored, compared and printed. Erasing an unresolved lookup to a guess
would be a silent wrong answer — the worst outcome available. Before `NT1029` the whole construct
died in the `[]` array-suffix loop as an **anonymous `NT0001 Expected ']'`**, with no code and no
hint; it was the last unnamed refusal in the tree.

### `Extract<T, U>` — RESOLVED to the member(s); the empty result is `NT1036`

`Extract` used to sit in the "multi-arg utility types erase to their first (subject) type
argument" group in `parseGenericType`, next to `Omit`/`Pick`/`Parameters`/`ReturnType`. So
`Extract<Expr, { kind: "ArrowFunction" }>` **was** the whole 30-member `Expr` union, and every
field read on a parameter so annotated was refused — a field is readable off an un-narrowed union
only when it sits at the same slot with the same widened type in *every* member, and `params` is
in one member out of thirty. Measured over the linked stage-1 program that was **31 of 136**
remaining `NT2001` blockers, the largest single bucket, and it was never a narrowing gap: there is
nothing to narrow, because the parameter's declared type already *is* the member. `tsc` is
authoritative about what a type means and it sees the member; erasing to `T` was us disagreeing
with `tsc` about a type, which is the direction this project always loses.

It is resolved now. `Extract<T, U>` distributes over `T`'s members and keeps the ones assignable
to `U`, TypeScript's `T extends U ? T : never`. A member survives when every field of the pattern
`U` is present under the same key at a matching type — **exactly** for a string-literal pattern
field (that is the tag test), by widened type otherwise. One survivor gives the member with its
tag widened, which is byte-identical to what narrowing already produces (`unionMemberFor`), so a
value that reaches such a parameter through a `switch` and one that reaches it through the
annotation are the *same* `Ty`. Several survivors give the sub-union, still discriminated by
construction.

**It selects; it never reinterprets** — and that is the line that separates it from
`objectLayoutFits`, which is slot-keyed. `Extract` hands back a member of `T` unchanged, so the
value is always read at its own layout. What *can* reinterpret is the `as` that consumes the
result, and that has been a checked assertion (tag load, compare, panic) since `481c463` — which
is why resolving `Extract` had to wait for it. Verified by mutation: with codegen's `nt_as_tag`
emission disabled, `s as Extract<Shape, {kind:"square"}>` on a circle returns
`2.1263599894e-314` (the `name` pointer read as a double) where node says `undefined`, and a
plausible `1` where the two members' slots happen to agree.

**The empty result is refused (`NT1036`), not erased back to `T`.** TypeScript answers `never` and
this subset has no inhabitant for it: every `Ty` here denotes a set of values *with a layout*, and
the empty set has neither. Erasing would be the wider (so nominally safe) answer, but it is
destructive in the sense `NT1033` and `NT1035` already record — `Extract<Expr, {kind:"Aggregate"}>`
is a misspelt tag, and answering it with the whole union turns one typo into a scatter of
field-read refusals in the body below, each blaming a line that is correct.

**Two fallbacks keep their old erasure to `T`, and both are conservative.** A non-union subject
(`Extract<number, number>`, an unresolved import, a generic parameter) and a non-object pattern
are answered with `T`, as before. A wider type refuses more field reads and permits fewer casts,
so a fallback can cost a blocker but never a wrong answer.

**The one residue: a pattern field that is a UNION of string literals.**
`Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>` — which `src/` writes twice — selects
nothing in particular, because `"MemberExpr" | "IndexExpr"` has already collapsed to `string` in
`parseTypeInner` (the same rule that keeps `type Dir = "n" | "s"` a `string`) long before
`Extract` runs. Every member then matches by widened type and the answer is the whole union: the
old erasure, arrived at by the rule rather than by a special case. It is left supported-as-before
rather than refused, because this refusal happens at PARSE time and would be fatal for the whole
program. Reads through such a parameter still need an ordinary narrowing.

### Type queries — `typeof x` and `keyof T` in TYPE position are `NT1033`

Both are **refused**, and the reason is that neither can be *answered* where annotations are
resolved. `Ty` (`src/ast.ts`) is produced by the parser, before any inference has run, so
`typeof S` has no value environment to ask for `S`'s type; and `keyof T` has no `Ty` inhabitant at
all — "one of these keys" is the same unrepresentable thing `NT1029` already refuses for
`T[keyof T]`. It has to be the *parser* that says so, for the reason `NT2003` gives: the erasure
to `number` is destructive, and once it happens no later pass can tell the result from a `number`
the user wrote.

**`typeof` as an EXPRESSION is untouched** — `typeof s === "string"` is a different parse path
(`parseUnary`) and compiles exactly as it always did.

**What it replaced was one bug with two faces.** `typeof` and `keyof` both sat in the parser's
`AMBIENT_TYPES` escape, which resolves a bare *name*. So the KEYWORD was resolved as though it
were the type — erasing to `number` — and the OPERAND was left in the token stream, where it
re-parsed as a stray expression statement:

```ts
const S = "a";
type X = typeof S;                              // became: type X = number;  then  S;
function f(v: X): number { return v.length; }
console.log(f("hello"));   // node: 5   was: error[NT2001] 'f' arg 0 expects number, got string
```

```ts
type T = { a: number, b: number };
type K = keyof T;          // became: type K = number;  then  T;
                           // node: a   was: error[NT2001] 'T' is not defined
```

The first is the dangerous one: the stray `S;` is a *legal* statement, so `X` silently meant
`number` and the program was rejected downstream blaming the CALL for a type nobody wrote. The
second is merely misattributed — it names a line the user did not write.

**Why not implement the decidable subset.** Resolving `typeof S` where `S` is a `const` with a
literal initializer *is* possible in the parser, and it was rejected on purpose: it puts the
accept/reject boundary on the SYNTAX of the initializer — `const S = "a"` would compile while
`const S = f()` one line below it would keep erasing silently. That is the same trade
`docs/self-hosting.md` rejected for a `new Map`-argument-position-only entries form. A partial
answer that keeps the silent case is worse than no answer.

### `interface B extends A` — a field-set UNION, base fields FIRST (`NT1034` otherwise)

An interface is erased **structurally** here: a declaration binds a name to a `Ty` string
(`{a:number,b:number}`) and nothing else, and the field ORDER in that string *is* the slot order
codegen geps with. So inheritance is a field-set union at resolution time — the base's fields
first, in base order, then the derived declaration's own. There is **no runtime divergence**: node
erases the whole construct, so every supported case is node-differential
(`test/interface-extends.test.ts`).

**Base fields go first, and that is a decision, not an accident.** It makes a derived interface's
layout a *prefix-extension* of its base's, so a chain (`C extends B extends A`) puts A's fields at
the same indices in all three — and the common tagged-union idiom

```ts
interface Base { kind: string }
interface Add extends Base { kind: "add"; lhs: number; rhs: number }
interface Neg extends Base { kind: "neg"; arg: number }
```

puts `kind` at index 0 in *both* members, which is the same-slot invariant SH2's
`unionDiscriminant` (`src/ast.ts`) proves before it will build a `U<…>`. Appending the base
instead would put the tag at index 2 in one member and index 1 in the other, and the union would
be refused.

A **redeclared** member overrides the base's type and keeps the base's **slot**, which is what
lets the idiom above narrow `kind` from `string` to `"add"` without moving it. TypeScript
additionally requires the override to be assignable to the base's member (TS2430) and we do not
check that — but types are erased before node ever sees the program, so an incompatible override
cannot change the **answer**, only tsc's opinion of it.

Refused as `NT1034`, at the `extends` clause:

- **A class base.** `interface I extends C` is legal TypeScript, but a class instance type is
  `C{…}` — *tagged* — and the tag is what method resolution keys on. Folding its fields into an
  untagged record would silently drop every method.
- **A `@@mutable` record base** (`docs/decorators.md`), for the same reason: `@@mutable` is
  deliberately NOMINAL, so that an undecorated record can never become mutable by sharing a shape.
- **A base with no field list here** — anything that does not resolve to a plain record in *this
  file*, including an **imported** one. `resolveNamed` erases an unknown named type to `number`,
  so there are no fields to inherit; see the note under `NT1029` above, which refuses a
  cross-module `Mod["field"]` for exactly the same reason.

**What this replaced was a silent wrong answer, not a missing feature.** The `extends` clause used
to be parsed and *discarded*, so `B` meant its own fields alone. Reading an inherited field was an
`NT2001` blaming the *property* — `Property 'a' does not exist on {b:number}`, pointing at the use
rather than at the dropped clause — and a program that never read one compiled clean and wrong:

```ts
interface A { a: number }
interface B extends A { b: number }
const x: B = { a: 10, b: 2 };
console.log(JSON.stringify(x));   // node: {"a":10,"b":2}   was: {"b":2}, exit 0
```

### `static` class members — supported, and the four refusals

A static member has no receiver, so it is a **namespaced top-level definition**: `static m(…)`
lowers to the function `C.m(…)` with no `this` parameter, and `static f = init` to a module-level
`const C.f` initialized where the class is declared. Both are ordinary TypeScript that node runs
unchanged, so every supported case is node-differential (`test/fixtures/classes/static-*.ts`,
plus `test/modules/statics/` across a module boundary). What is refused:

- **A static field with no initializer** (`static f: number;`) — it would read as `undefined`,
  which is not a value this language has for a `const`. `NT1015`.
- **Writing a static field** — it is a `const`, like every other module-level binding here
  (§A, immutable-by-default). `NT1606`. node allows every one of these:

  | spelling | node | nativets |
  |---|---|---|
  | `C.f = v`, and every compound (`+=`, `*=`, `<<=`, …) | writes | `NT1606` |
  | `C.f++`, `++C.f`, `C.f--`, `--C.f` | writes | `NT1606` |
  | `C.xs.push(x)` / `C.xs[0] = v` / `C.o.g = v` | writes | `NT1606`, from the array/object
    immutability rule for the value the static holds — not from this one |

  The hint names both fixes and both were run: a static **method** that returns the value, for
  a constant; a module-level **`let`** or a field of a **`@@mutable`** class instance, for state
  that actually changes. A pure static method cannot express `C.f++`, which is why the second
  half of the hint exists.

  **The four update spellings used to CRASH the compiler** rather than refuse — an internal
  `TypeError: undefined is not an object (evaluating 'e.kind')` with a bun stack trace and no
  `NT` code, which is neither of the two acceptable outcomes. `resolveStaticFieldReads`
  detected a write by matching `FieldAssign` alone, so `C.f = v` *and* `C.f += v` were caught
  (a compound store is one `FieldAssign` with an `op`) while `UpdateExpr` fell through to the
  read rewrite, which turned the `C.f` in `targetExpr` into a bare `Identifier`. Codegen's
  update arm asserted `tgt as Extract<Expr, {kind:"MemberExpr"}>` and read `.object` off it.
  Both halves are fixed: `staticExpr` has an `UpdateExpr` arm, and the `as` is a checked
  narrowing that raises `internalError` — the `as` was the same lying-cast shape as the
  `(e.callee as {name:string}).name` family, and would have handed `undefined` to `genExpr`
  for any future node that reached it.
- **A binding that shadows a class with static fields** — a read of `C.f` is resolved by NAME
  (that is what makes it a module binding rather than a slot on a receiver), so a parameter
  named after the class would silently redirect the read to the static. Refused with `NT1015`
  rather than answered wrongly; node reads the shadowing value.
- **A decorator on a static** (`@w static m()`) — a `@wrapper` is typed over the method's own
  signature *with the receiver as its first parameter* (`docs/decorators.md`), and a static has
  no receiver. `NT1015`.

Reaching a member through the wrong side — a static through an instance, or an instance method
through the class name — is a **compile-time rejection**. node throws a `TypeError` at runtime
for both (the property genuinely does not exist there), so this rejects strictly earlier than
node fails.

| NT1020 | promises / concurrency: `Promise.*`, `new Promise`, `.then`/`.catch`/`.finally`, un-awaited `async` results | later | an event loop — or, the chosen answer, the **actor** model (`spawn`/`send`/`receive`). `async`/`await`/`fetch` themselves are ✅ supported (blocking; see §A) |
| NT1025 | `console.log` of a value with no node-identical rendering: a **function value** anywhere, or a `Uint8Array`/`TextEncoder`/`TextDecoder`/`Response`/`Headers`/`URL`/`URLSearchParams` handle **nested inside** a printed value | later | objects, class instances, arrays, Map/Set and `Dyn` are ✅ node-exact (util.inspect, see above); this code covers only the leaf types that have no node-identical form here |

### Optional-property objects: a LITERAL argument reshapes, a variable does not

An object type's slot layout is decided by its type, not by the value: a field declared
`a?: number` is a POINTER to a nullable box, while a field inferred `a: number` is a raw
double in the slot. So `{a: 1}` and `{a?: number}` are structurally compatible but have
**different layouts**, and passing one where the other is expected is only safe if
something rebuilds the value.

For an object **literal** that is exactly what happens — `retypeLiteral` rewrites it in the
parameter's layout, the same way it has always rewritten a declaration's initializer
(`const o: Opts = {a: 1}`). So all of these compile and match node:

```ts
interface Opts { a?: number }
function f(o: Opts): number { return o.a ?? 0; }
f({ a: 1 });          // 1
f({});                // 0
f({ a: undefined });  // 0
```

A **non-literal** argument is still rejected with `NT2001`, even though node runs it:

```ts
const v = { a: 1 };
f(v);                 // node: 1 — we REFUSE
```

`v`'s layout was fixed at its own declaration and there is no literal at the call site to
rewrite; accepting it would need codegen to **copy** the value into the parameter's layout,
which is a separate feature (structural coercion) and is not implemented. This is a
deliberate false rejection. The alternative — accepting it on the assignability predicate
alone, without a reshape — produces a program that dereferences the raw double `1.0` as a
pointer: it compiled, then died with **exit 255 and empty stdout**. Reject, never
miscompile. Pinned in `test/optional-props.test.ts`.

**Still refused for the same reason:** the same shape in RETURN position
(`function g(): Opts { return { a: 1 }; }`) — a known gap, not a decision.

**A SCALAR is not an object, and now passes.** The paragraphs above are about slot LAYOUT,
and that argument never applied to `null`, `undefined`, or a `string` reaching a nullable
parameter — those box, they do not reshape. `fitsParam` refused them anyway, because it
was type identity; TypeScript's rule (`null` assignable to `T | null`, `undefined` to
`T | undefined`, a `T` to either) now holds at a parameter, a constructor argument and a
return. The widening is deliberately narrower than the `assignable` predicate: exactly the
matching nullish literal and a value of the base type, which are exactly the two sources
codegen's `coerce` can build a `[tag,value]` box from. Everything in this section stays
refused, unchanged, and `test/nullable-assign.test.ts` pins that — including `null` for a
non-nullable parameter, and each nullish literal for the WRONG arm (`f(null)` where the
parameter is `string | undefined`).

### `===` between TWO nullable values is refused (`NT1009`) — it was a silent wrong answer

```ts
const p: number | undefined = 1;
const q: number | undefined = 2;
console.log(p === q);      // node: false      nativets, before: TRUE, exit 0
```

A nullable is a `[tag, value]` **box**, and `genExpr`'s comparison chain dispatched on
`number` / `boolean` / array+object / relational-string and then fell through to
`js_str_eq` — `strcmp` over the box, which stops at the first NUL byte of the i64 tag. So
every *present* box compared equal to every other one regardless of what it carried, and
`?Nstring` was wrong the same way (`"a" === "b"` was `true`). This is the **default-arm**
failure mode `src/codegen.ts`'s own `joinFn` comment names: *"a two-way choice written twice
is exactly how the third case gets missed twice."*

It is the fourth member of a family `refuseUnboxedUnion` (`src/checker.ts`) already records
for the general-union box — truthiness tested the pointer, `===` compared tags,
`JSON.stringify` rendered `null`, concatenation emitted invalid IR. Three of the four were
fixed for the nullable box; this one had **no refusal in front of it**. Refused now, because
"reject, never miscompile" says the refusal lands first: a correct lowering is a tag dispatch
(*both nullish → true; both present → compare the unwrapped bases; else false*) that needs a
branch per base type, and guessing is the worse outcome.

**Still accepted, and unchanged** — `x === undefined` / `x === null` (either operand order).
That really *is* a tag comparison, which is why it was always right. The fixes the diagnostic
hands back are `if (a !== undefined && b !== undefined)` (narrowing makes both operands the
base type) or `(a ?? d) === (b ?? d)`; both match node. `test/narrowing.test.ts`.

### `instanceof` on a NULLABLE or UNION operand is refused (`NT1022`) — it was a silent wrong answer

```ts
class Dog { name: string; constructor(n: string) { this.name = n; } }
const d: Dog | undefined = new Dog("rex");
console.log(d instanceof Dog);            // node: true       nativets, before: FALSE, exit 0

const a: number[] | string = [1, 2];
console.log(a instanceof Array);          // node: true       nativets, before: FALSE, exit 0
```

`instanceof` here is a **constant fold**, not a runtime test: the checker decides it from the
operand's static type and codegen emits `true`/`false` (the left operand is still evaluated
for its effects). That is exact — and it is the same answer node computes — only while the
static type names ONE thing, which is the premise `InstanceOfExpr` was written against: *"a
value's static type IS its exact class in this subset."*

A nullable or a union breaks the premise, and the five arms of the fold were being applied to
the WHOLE type spelling anyway. Each one then answers `false` for a **structural** reason
rather than a semantic one, so the wrong answer was unanimous and silent:

| arm | why it said `false` on `?UDog{…}` / `G<number[]|string>` |
|---|---|
| a user class | `classTag` reads the tag as `?UDog`, not an identifier → `undefined` |
| `Array` | `isArrayTy` excludes nullables by construction (`!isNullableTy(t)`) |
| `Map` / `Set` | anchored on a `Map<` / `Set<` **prefix** that `?U` / `?N` displaces |
| `Uint8Array` | an exact `t === "Uint8Array"` match, which `?UUint8Array` is not |

The fold is now decided **per arm**, which is the smallest rule that is both correct and
non-lossy:

- **arms agree → still folded, still compiled.** `x instanceof Array` on a union of record
  types is a real `false`; so is `s instanceof Map` on `string | undefined`. Neither was
  wrong, and neither is refused. These are the mutation guards in
  `test/selfhost-parse.test.ts` — widen the refusal to "compound operand" and they fail.
- **arms disagree → `NT1022`.** The answer depends on which arm the value holds at run time,
  and `e.result` is one compile-time boolean with nowhere to put a runtime test. A nullable's
  nullish arm votes `false` (in node, `undefined instanceof C` is false for every `C`), which
  is exactly why `d instanceof Dog` above is *undecidable* rather than simply `true`.

The hint names the test that does decide it, and the rewrite it names compiles and matches
node: `x !== undefined` for a nullable (the narrowing the branch body wanted anyway), a
discriminant comparison for a union. `test/selfhost-parse.test.ts`.

### Narrowing does not reach `this.<field>` (`NT2001`) — a refusal, with a reason

```ts
class C { s?: string; get(): string { return this.s === undefined ? "none" : this.s; } }
```

node prints `none`; we refuse. A narrowing fact is about an access PATH, and a path is
only eligible when nothing can change it out from under the proof — which holds for
`d.spans`, since a non-`@@mutable` object's field cannot be written at all. It does **not**
hold for `this`: `this.s = undefined` is legal inside a method, and the invalidation scan
is by NAME, so it sees a rebinding of `d` and never a write to `this.s`. No fact is
recorded rather than a false one proved.

Optional class fields made this far easier to hit the day they started producing real
nullables, so the diagnostic explains the refusal rather than reporting a bare type
mismatch, and hands back the fix — bind a local first, after which the value cannot change
under the guard at all:

```ts
get(): string { const s = this.s; return s === undefined ? "none" : s; }
```

Closing it properly needs a synthetic binding for `this` plus a path-aware invalidation
scan; it is a known gap, not a permanent decision. Pinned in `test/nullable-assign.test.ts`,
along with the requirement that the hint's own suggested fix compiles and matches node.

**Adjacent, also refused:** a ternary does not JOIN a present arm with `undefined` —
`function f(b: boolean): string | undefined { return b ? "yes" : undefined; }` is `NT2001`
("Ternary branches differ"), because the join wants one type for both arms and does not
widen `string` + `undefined` into `string | undefined`. The `if`/`return` spelling of the
same function compiles.

### `{ __proto__: v }` is refused (`NT1038`) — it is the prototype setter, and we have no prototypes

```ts
console.log(JSON.stringify({ __proto__: 1 }));                  // node: {}   nativets, before: {"__proto__":1}, exit 0
console.log(Object.keys({ __proto__: 1, other: 2 }).join("|")); // node: other  nativets, before: __proto__|other
```

`__proto__` written as `PropertyName : AssignmentExpression` inside an object literal is not a
property at all. ECMAScript **B.3.1** (*`__proto__` Property Names in Object Initializers*)
rewrites that one production into a `[[SetPrototypeOf]]`, so the key never becomes an own
property and never appears in `Object.keys`, `for-in`, `Object.values` or `JSON.stringify`. We
built an ordinary field, printed it, and exited 0 — the silent-wrong-answer shape, found by the
node-differential fuzz lane.

**It is unimplementable here, not merely unimplemented.** A nativets object is a flat record
whose slot layout is fixed at compile time from its static type, with no prototype link and no
place to put one; class methods are resolved from the type tag rather than carried by the value.
All three shapes of the setter need exactly the chain we do not have:

| written | what node does | why we cannot |
|---|---|---|
| `{ __proto__: obj }` | `[[Prototype]] = obj` | a later `o.b` has to resolve on `obj` |
| `{ __proto__: null }` | drops `Object.prototype` — `"toString" in o` turns **false** | our `in` answers from `OBJECT_PROTO_KEYS` (`src/ast.ts`), a compile-time list with no per-object exception |
| `{ __proto__: 1 }` | a primitive is ignored — a pure no-op | *this one alone is expressible* (drop the key), but such a literal is an obfuscated `{}`, and compiling it would leave a value that is evaluated, owned by nobody and stored nowhere in the one path where every other property MOVES into the object |

Refusing the production **whole** is both the honest answer and the only uniform one; limping
through the third row would buy no real program and add a discarded-temporary case to the
literal path. Note that node's third row is *also* where a would-be fix is most tempting and
least useful.

**Refused in the parser** (`parseObjectLiteral`), which is unusual for an `NT1xxx` and
deliberate: it is the last point that still knows the production. The shorthand desugars to
`{ key, value: Identifier(key) }`, which is indistinguishable downstream from
`{ __proto__: __proto__ }` — and those two disagree in node.

**Deliberately narrow — B.3.1 rewrites only that one production, so the neighbours are ordinary
properties in node and still compile here, unchanged:**

| spelling | node | nativets |
|---|---|---|
| `{ __proto__ }` shorthand | ordinary property (`IdentifierReference`, not `PropertyName :`) | **compiles, matches node** — this is what `NT1038`'s hint sends you to |
| `{ ["__proto__"]: v }` | ordinary property | `NT0001` — computed keys are unsupported generally, not a wrong answer |
| `JSON.parse('{"__proto__":1}')` | ordinary property (`CreateDataProperty`) | unaffected |
| `"__proto__" in o` | `true` | `true` — `OBJECT_PROTO_KEYS` already lists it |

**Still open, and NOT closed by this refusal:** `o.__proto__` as a member expression. In node
that is the `Object.prototype` accessor pair, so a *read* yields the prototype and a *write*
sets it — `o.__proto__ = {b:2}` creates no own property either. `docs/divergences.md`'s
Record/dict section already records that `o["__proto__"]` answers an object. Both `{ __proto__ }`
and every clause of `NT1038`'s hint were compiled and byte-diffed against node;
`test/fuzz-diff.test.ts` holds the refusal contract and that proof.

### Host FFI (SH4) — `node:fs` / `node:child_process`

A `node:` import binds a **compiler builtin**, not a file: there is no `node_modules`, no JS to
run, and nothing to link. `readFileSync`/`writeFileSync`/`existsSync`/`spawnSync` are backed by
libc (stdio, `stat`, `fork`+`execvp`), so `runtime/runtime.c` still cross-links unchanged. The
same `.ts` runs under node, so every supported case is node-differential
(`test/hostfs.test.ts`). Three deliberate departures:

- **A host builtin is not ambient.** It is in scope only where it was imported, unlike
  `readLine`/`fetch`/`parseInt`. That is *stricter* than treating it as a global (node also
  requires the import) and it leaves a user function named `readFileSync` compiling normally.
- **`spawnSync().status` is a `number`, and a spawn FAILURE is `-1`.** node reports a failure to
  spawn — and death by a signal — as `status: null` plus an `.error`/`.signal` property. Typing
  it `number | null` would make the idiomatic `r.status !== 0` (which the compiler's own
  `src/driver.ts` is written with) need narrowing at every call site, so the value is `-1` and
  the shape stays flat. Like node, it **does not throw**: an unrunnable command is a reported
  result, not an exception. Exit codes of a program that *did* run are exact.
- **Errors are node's, byte-for-byte.** A failed `readFileSync`/`writeFileSync` raises
  `ENOENT: no such file or directory, open '/x'` — node's exact `err.message` — through the
  pending-exception protocol, so `try`/`catch` works; a try block containing a host call binds
  its catch parameter to `{message:string}` (nativets' `Error` shape), so `e.message` prints the
  same text on both sides. `existsSync` never throws, matching node.

`spawnSync` takes **exactly two options literals**, and its RESULT SHAPE follows which one:

| options | what it does | result type |
|---|---|---|
| `{ encoding: "utf8" }` | two pipes, drained with `poll(2)` | `{status:number,stdout:string,stderr:string}` |
| `{ stdio: "inherit" }` | the child gets OUR fds — output goes straight to the terminal, and the child can read our stdin | `{status:number}` |

The inherited form captures nothing, so node's result carries `stdout: null` / `stderr: null`
and ours simply **has no `stdout` field**: reading `r.stdout` is a type error rather than an
empty string that silently claims the child printed nothing. It is what `nativets run` needs
(`src/cli.ts`) — a compiled program must reach the user's terminal, not a buffer. The `-1`
convention above extends to it unchanged: the captured form tells "`execvp` never ran" from a
real exit 127 by noticing the child produced no output, and the inherited form (whose output we
never see) learns the same fact from a **close-on-exec pipe** the child writes its `errno` into
only if `execvp` returns. So `spawnSync("nope", [], { stdio: "inherit" })` is `-1` and
`sh -c "exit 127"` is `127`, on both sides of the options fork.

Everything outside the implemented surface is **`NT1028`**, never half-implemented — including
the argument *values* that decide what node returns: `readFileSync(p)` with no encoding (node
yields a Buffer), a computed encoding, `spawnSync` without one of the two literals above (`{
stdio: "pipe" }`, the node default, yields Buffers), and any other `spawnSync` option
(`cwd`/`env`/`input`/`shell`/`timeout`), since accepting and ignoring one would silently change
what the program does.

### `process.stdout.write(s)` — the effect is supported, the RETURN VALUE is not

`console.log` appends a newline, and for a program whose output *is* its product — a compiler
printing `.ll` to stdout, which is `nativets emit` — that newline is a wrong byte, not a
cosmetic difference. So `process.stdout.write(s)` is a host builtin: the string's bytes on
stdout, through the same buffer `console.log` uses (`js_print_str`), so the two interleave in
source order and `process.exit` flushes both.

It is typed **`void`, where node returns a `boolean`**. node's answer is `false` when the
stream's internal buffer is backed up — a runtime fact about a pipe that nativets does not
model — and returning a constant `true` would be a silent wrong answer in the one place the
value is ever read. `const ok = process.stdout.write(s)` is therefore refused, exactly like
binding the result of any other `void` call.

Only the one-argument string form exists. node's `(chunk, encoding?, callback?)` and its
`Buffer`/`Uint8Array` chunk are `NT1028`; `process.stdout.<anything else>` — `isTTY`,
`columns`, `end` — is refused by name rather than guessed at. Like `process.argv` and
`process.exit`, it is recognized only when `process` is not shadowed by a user binding, which
is node's own rule.

| NT1028 | a `node:` builtin module, or a member of one, outside the implemented host FFI surface — and the ambient `process.stdout` members outside `.write(s)` | later | the surface is what a self-hosted compiler needs: `node:fs` (`readFileSync`/`writeFileSync`/`existsSync`), `node:child_process` (`spawnSync`), `process.stdout.write` |

### `process.platform` — the TARGET's platform, and the one value node has no word for

`process.platform` is a host builtin returning node's spelling for the platform the program
is running on: `darwin`, `linux`, `win32`, `android`. On every platform node itself runs on
this is **not** a divergence — `node file.ts` and our compiled binary print the same string,
which is what `test/hostio/platform.ts` asserts differentially on whatever box runs it (so a
Linux runner checks the branch a macOS laptop cannot).

The interesting part is *when* it is resolved. For an AOT binary "the platform I am running
on" **is** the platform I was built for, so the answer has to follow `--target`. It is
therefore computed by the **C preprocessor** in `runtime/runtime.c` (`nt_platform`), not
folded to a constant by codegen. That is forced by a rule this project keeps elsewhere: the
emitted `.ll` deliberately carries **no target triple** so clang can retarget it, and
`linkArgv` puts `-target` on the one clang command that compiles both the `.ll` and the
runtime `.c`. Codegen runs once and cannot know the target; the preprocessor is told. Had we
folded a constant, `nativets build --target linux` on a Mac would have produced a Linux ELF
that reported `darwin` — a silent wrong answer, the worst outcome available.

`__ANDROID__` is tested **before** `__linux__`, because Android defines both and node reports
`android` there.

**The actual divergence is `wasm` only.** No node build targets wasi, so there is no oracle to
match, and a wasi binary reports **`wasi`** — a value node never produces. That is deliberate:
guessing one of node's spellings (`linux`, say) would make a wrong answer *look* right. An
unrecognized platform reports `unknown` for the same reason.

### Type declarations HOIST; recursive types are still not representable (NT1030)

TypeScript hoists every type declaration in a scope — a type may be used above the line
that declares it, and order is irrelevant. nativets now matches that for **top-level**
`type`/`interface` declarations: `hoistTypeDecls` (`src/parser.ts`) resolves them to a
fixpoint before the file proper is parsed, so each round resolves whatever its dependencies
allow and the declarations settle in dependency order regardless of how they are written.

Three things stay outside it, all refusals rather than miscompiles:

- **A type declared inside a function or block** stays in source order. Its meaning can
  depend on where it sits — a type PARAMETER in scope resolves to a `#T` marker, not to a
  shape — so hoisting it to file scope could change what it resolves to. `NT1030` says so,
  and the hint names the fix (move it to the top level).
- **A CLASS named above its declaration.** A class declares a type too, but its instance
  shape only exists once `parseClass` has run, so classes are not part of the fixpoint and
  cannot be. `function f(x: MyC)` above `class MyC` used to erase `MyC` to `number` and
  then fail as `'f' arg 0 expects number, got MyC{n:number}` — the value blamed for the
  ordering. It is now `NT1030` on the annotation, with a hint that says to move the class
  up. Reordering genuinely fixes it, and the reordered program matches node.
- **A cycle.** The fixpoint identifies these exactly: what is still unresolved when a round
  makes no progress, and is blocked on something else that is also unresolved, contains
  itself. Those get the *recursion* wording, naming the type the cycle closes through
  (`recursive type 'TemplateLiteral' — it contains itself through 'Expr'`), and explicitly
  do **not** get told to reorder.

Before hoisting, this was neither. `resolveNamed` fell back to `number` for any unregistered name, so
the annotation was silently erased and the program failed later against the *value*:
`'x' declared number but initialized with {kind:string,a:number}`. That message names
neither the type nor the cause, and it cost a round of self-hosting work — `ForStmt.init:
VarDecl | Expr | null` in `src/ast.ts` read as a union-representation bug when in fact
`Expr` (declared at ast.ts:550, its 29 member interfaces from 621) had already been erased
to `number` before the union code saw it.

**The same erasure had one door left open, and it is now `NT2003`.** `NT1030` only ever
covered names *declared in this file*; a name declared **nowhere** — a typo — kept the old
`number` fallback, so `function g(t: Nope)` compiled the annotation away and the program
was refused at the call site (`'g' arg 0 expects number, got {x:number}`) with the typo
never mentioned. That is now `Cannot find name 'Nope'`, pointed at the annotation, matching
tsc's TS2304. See the `NT2003` entry below for exactly which names are still let through.

**Recursion is the harder half, and it is not a parser problem.** `interface N { next: N }`
cannot be fixed by reordering, and hoisting does not touch it either. The real obstacle is
the type encoding. `Ty` is a **structural string** (`src/ast.ts`) — `{a:number,b:string}`,
`number[]` — chosen precisely so `===` is type comparison. A type that contains itself has
no finite structural string, so no amount of multi-pass resolution helps; a resolver that
did not stop would replace the silent erasure with infinite expansion.

### Recursive types ARE representable now — the nominal `@Name` back-edge

The paragraph above used to end "supporting it honestly requires a nominal, by-reference
form in `Ty`". That form exists. A declaration in a cycle keeps its structural shape at the
top level and encodes the recursive POSITION as a reference, `@Name`, whose shape lives in a
table on the `Program`:

```
interface N { v: number; next?: N }    ->  {v:number,next:?U@N}
class Scope { parent: Scope | null }   ->  Scope{parent:?N@Scope}
```

`Ty` stays a string, `===` stays type comparison, and a type that is not recursive keeps its
exact previous encoding — no `Ty` contained `@` before, so this is additive rather than a
rewrite, and a `@N` reaching a site that has not been taught about it fails loudly instead
of being mistaken for something else.

**MUTUAL recursion** takes the same encoding one declaration wider. When the hoisting
fixpoint stalls it has PROVED a set of names is stuck on each other; each is then re-parsed
with every member's name resolving to `@Name`. Inside that round a **union member may not be
a bare `@Name`** — a union value IS the member's object block (there is no box, see SH2), so
`unionDiscriminant` needs each member's SHAPE to prove the tag sits at the same slot index in
every one. A reference is therefore expanded **one level** at the member boundary and only
references below it stay folded:

```
type Expr = Num | Negate;  interface Negate { kind: "Negate"; operand: Expr }
  ->  U<{kind:"Num",value:number}|{kind:"Negate",operand:@Expr}>
```

One level, not transitive, so it is finite even where the member points back at the union it
belongs to.

**A component is encoded ALL OR NOTHING.** A back-edge is only minted where it resolves, so
one member the subset cannot represent takes the whole cycle with it and every member reports
as recursion. That is sound and it is a measurement hazard — `src/ast.ts` encodes **41 of its
45** cycle members, and the four that do not (general unions like
`ArrowFunction.body: Expr | Stmt[]`, an array arm beside a discriminated-union arm) made all
45 look like a recursion problem. So the NT1030 **hint** now names the residual members and
their own diagnostics. The message is deliberately unchanged: it is what
`test/selfhost-ratchet.baseline.json` records as a blocker's identity.

**A VALUE never carries the folded spelling.** The invariant is that `@Name` appears only
NESTED inside a shape; a value's own static type is always the expanded one. That is enforced
in exactly two places — `Checker.type` and `CodeGen.genExpr`, the single funnels where an
expression's type is produced — plus the three receivers that do not go through them (a
nullable base, an array element, a `for-of` binding). One level per access, driven by a real
source-level read, so it terminates without a fixpoint. Before that, `e.operand.kind` on a
recursive union was `NT2001 Property 'kind' does not exist on @Expr` while passing the same
value to a function that annotates the type worked — the information was there, it was just
not consulted where a value's type is made.

The unfold WIDENS string-literal field types, because the table and an annotation are two
spellings of one declaration: `recTypes` keeps `tag: "m"` (a recursive union's discriminant
must survive) and `parseType` widens it to `string`. Widening does not descend into a `U<…>`,
so a recursive union keeps the tags its dispatch reads.

**...so `===` alone is NOT type comparison for a recursive type.** The two halves above meet:
a value's own type is the EXPANDED shape, a nested back-edge stays FOLDED — so the instant a
value goes back into a field of its own type, the composed type carries the expanded spelling
in a position the declaration spells folded, and the two disagree as strings while denoting
one type. `interface Node { name: string; kids: Node[] }` with
`function leaf(n: string): Node { return { name: n, kids: [] } }` refused itself with
`{name:string,kids:{name:string,kids:@Node[]}[]}` **vs** `{name:string,kids:@Node[]}`. Both
spellings are what the invariant *requires* at their own site, so there is no over-eager
unfold to delete; **equality is what has to normalize**. `assignable` already did (the
coinductive rule); `fitsParam`, the return/argument gate, was pure `===` — which is why
`const a: Node = {…}` compiled and `return {…}` did not.

`Checker.sameShape` is that normalization, and it is IDENTITY, not the widening `assignable`:
fields must match in count, key and **order** (a field list is a slot order), union members in
count and order (index is the tag), and unfolding is **one-sided**, so `@A` vs `@B` stays
false and the encoding does not quietly become equirecursive. It terminates on a well-founded
measure rather than a fixpoint — a structural step shortens both strings, an unfold replaces a
bare `@N` with a fixed table entry and cannot repeat immediately — with a plain depth counter
as the hang guard, answering *false* (a refusal) at the bound.

**Across MODULES the back-edge is renamed with the module.** A non-entry module is
alpha-renamed, and every `@Name` it mints travels with it — in the shape table, in the
module's own signatures, and in the shape it exports. Two modules may each declare a
recursive `Node` and they stay distinct types with distinct layouts. A `@` inside a quoted
tag or property key (`kind: "user@host"`) is NOT a reference and is left alone.

Still refused, each with its own message: a cycle with nowhere to put a back-edge
(`type P = Q[]` / `type Q = P[]` — a reference needs a slot to be a pointer in), and the four
deep-walk cases below.

### An UNRESOLVED type name is `NT2003` — "Cannot find name" (tsc's TS2304)

A name in type position that resolves to nothing used to become `number`. The erasure is
silent and DESTRUCTIVE: `Ty` (`src/ast.ts`) is a flat structural string with no inhabitant
meaning "unresolved `Nope`", so once the parser returns `number` the spelling is gone from
the program and every later diagnostic derived from it is misattributed by construction.
That is why the check lives in `resolveNamed` (`src/parser.ts`) and not in the checker or a
post-link pass — the parser is the last place that still holds the name.

The cost of checking there is that the parser's view is **file-local**, so each way a name
can be legitimately unresolved *at that instant* needs its own escape. All of them are
checked before the refusal, and a name matching any of them keeps exactly the behavior it
had:

| still falls back to `number` | why the parser cannot judge it |
|---|---|
| a generic type parameter (`<T>`) | in scope, resolves to a `#T` marker — never reaches the fallback |
| a `type`/`interface` declared later in the file | the ordering diagnostic (`NT1030`) owns it |
| a class declared later in the file | likewise `NT1030` — see above |
| an **imported** name | `modules.ts` seeds imported types from the exporting module's `finalTypes`, and a type that module refused for its own reason is simply *absent*. The name is well declared one file over; blaming the annotation would move the report away from the cause. |
| an **ambient** name (`any`, `unknown`, `never`, `ReadonlyMap`, `Iterable`, `Partial`, `Buffer`, …) | declared by TypeScript's own lib, so a program never has to declare it. The list (`AMBIENT_TYPES`, `src/parser.ts`) is deliberately generous: a name wrongly *out* of it is a false refusal on valid code, a name wrongly *in* it merely preserves the status quo. |

Two consequences worth knowing:

- **The refusal is speculation-safe by design.** `tryCallTypeArgs` parses `<…>` after a
  primary as a type-argument list and backtracks on any throw, so `i < n` speculatively
  resolves `n` as a type name and lands on this path — 199 times across the corpus. Throwing
  is *correct* there precisely because it is caught: the throw is what tells the speculation
  this was not a type. So `NT2003` must stay a throw and must never be recorded as a side
  effect.
- **The `import` escape is what still leaves the cross-module hole open.** A type its own
  module refused never gets seeded, so an annotation naming it still erases to `number` —
  live today for `Ty`/`Expr`/`Stmt` out of `src/ast.ts`. Closing that needs a *linker*
  diagnostic ("your dependency refused this type"), because the linker is the only pass that
  can tell it from "no such name". Until then it stays on the fallback rather than becoming
  a refusal pointed at the wrong file.

### A recursive value is assumed to be a TREE — the walks that refuse a cycle

Three passes walk a value by its STATIC type: `structuredClone`, the actor-message deep copy,
and `JSON.stringify`. A recursive type is the one shape whose type is finite while the value
it describes need not be, so each walk has to be told to stop.

- **`structuredClone` of a recursive value is refused.** It was a real silent wrong answer:
  `genDeepClone` had no case for `@N`, so it hit its value-semantics fallthrough and stored
  the SOURCE's pointer into the clone — `a.next === b.next` was `true` where node says
  `false`. Correct once the walk carries a seen-set, which node's structured-clone algorithm
  has and a type-directed walk does not.
- **An actor message of a recursive type is refused**, same walk, same reason. It was already
  rejected before, but only because `isObjectTy("@N")` is false and a back-edge fell off the
  end of `msgLeafOk` — two bugs cancelling rather than a guarantee. It is now deliberate, and
  `genDeepClone` itself throws on a back-edge so the safety is a property of the walk rather
  than of two independent gates staying in place.
- **The test for "is this recursive" is STRUCTURAL, not a substring.** `Ty` is a flat string
  and the first cut was `t.includes("@")` — but `@` is legal inside a string-literal tag
  (`kind: "user@host"`) and inside a property key (`{ "x@y": 1 }`), both of which land
  verbatim in the encoding, so structuredClone refused a program node runs. `containsTypeRef`
  walks the type instead; `hasTypeRef` survives as a cheap pre-filter whose `false` is
  conclusive and whose `true` decides nothing. Same landmine as `objectFields("@N")` once
  returning a phantom one-field record.
- **`JSON.stringify` of a recursive value is refused** (NT1005). The serializer is unrolled
  at compile time from the static type, so it terminates only because the type shrinks at
  every step — and a back-edge does not. `genJsonStringify` refuses one by name, with a
  64-level ceiling behind it.
- **`@@mutable` + recursive is refused.** Linearity keeps a recursive value a tree — a second
  owner is NT1601/NT1604 — but `@@mutable class N { loop() { this.next = this } }` compiled
  and ran, and `this` is not a second owner. The cost is measured, and it is not the leak it
  was predicted to be (`__objLive()` is 1 for the same class *without* the cycle, the
  pre-existing shallow drop). It is a silent wrong answer:

  ```
  node:     <ref *1> N { v: 7, next: [Circular *1] }
  nativets: N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }
  ```

  `genInspect` unfolds the back-edge and stops on util.inspect's DEPTH limit, which is a cap
  on nesting and not a cycle detector.

Everything else about a recursive value is ordinary object machinery: it is linear,
move-checked, and dropped once — and the drop is **shallow**, exactly like every other
object's, so a node reached through a field leaks (ROADMAP Phase C, not recursion-specific).

Until the four general unions above are representable, the compiler's own `Expr`/`Stmt`
(`src/ast.ts`) stay outside the subset, and **that — not the recursion, and not any single
intersection — is what now gates `src/ast.ts` self-hosting**.

### A parameter default makes a `function` parameter optional — but not a value ARROW's

A parameter's **type** now comes from its default in every parameter position — `(n = 1)` is
`number`, `(s = "a")` is `string`, `(b = true)` is `boolean`, TypeScript's widening rule. What
does **not** hold uniformly is the *arity* half:

```ts
function f(n = 1) { return n + 1; }
f();                        // 2 — the default fires, node-exact

const g = (n = 1) => n + 1;
g();                        // node: 2      nativets: [NT2001] 'g' expects 1 arguments, got 0
```

A named function has a real signature (`Sig.required` / `Sig.defaults`, `src/checker.ts`) and
codegen materializes the missing arguments at the call site. A **value arrow** is a closure, and a
nativets function type is the flat string `(number)=>number` — it has no notion of an optional
parameter, so a short call has nothing to consult. It is a refusal, not a wrong answer, and it is
an asymmetry between two spellings of the same thing rather than a considered rule.

Two related refusals of node-correct programs, from the same missing notion of optionality:

- **An explicit `undefined` argument does not trigger the default.** `f(undefined)` prints `2` in
  node (`undefined` is exactly what "argument absent" means in JS); we refuse the argument —
  `'f' arg 0 expects number, got undefined` — so the rule is unreachable rather than wrong.
- **A default may not name a parameter to its left.** `function f(a, b = a)` is ordinary
  JavaScript; codegen materializes defaults before the parameter allocas are stored, so accepting
  it would emit a load from an undefined `%a.addr`. Refused with `'a' is not defined`.

What a default **may not be**: `undefined`, `null`, or `[]`. TypeScript answers those with `any`,
`null`/`undefined` and `any[]`; none is a nativets type, so each is refused with a hint naming the
two ways out rather than guessed. Pinned in `test/param-defaults.test.ts`.

Lifting the arrow case means giving function types a required-arity — every `funcParams` consumer,
assignability, and a call-site pad in codegen. A real feature, not a patch.

### Closures capture by VALUE — a write to a capture is refused (`NT1029`)

A closure's environment is a heap block `[fn_ptr, cap0, cap1, …]`, and codegen fills the capture
slots **when the closure is built**. Reading one loads its slot; that is a snapshot, and for a
binding nobody writes a snapshot IS the by-reference answer, so the overwhelming majority of
closures — every read of a capture — compile and match node exactly.

Writing one does not. `writeCapture` stores back into the closure's own slot and never into the
enclosing frame's `%x.addr`, while **JS closures capture by reference**. Until this refusal, the
difference was silent — right exit code, wrong number:

```ts
let n: number = 0;
const add = () => { n = n + 1; };
add(); add();
console.log(n);            // node: 2      nativets, before NT1029: 0   (both exit 0)
```

So a captured write is **refused**, except in the one shape where the by-value slot *is* the whole
variable. Both conditions must hold:

1. **Nothing outside the closure mentions the binding.** That covers a later read (`return n`), a
   later write (`n = 10`, which the snapshot predates), and a *second* closure over the same
   binding — which would get its own slot and drift away from the first.
2. **The binding is a `number`.** The other types were measured in exactly the safe shape and are
   not safe: a captured `number[]` rewritten this way died with `panic: index out of bounds: the
   length is 0` where node printed `1 2 3`, and a captured `string` printed correctly but **leaks**
   — `writeCapture` emits a bare `store i64` and never releases the string it overwrites.

What that carve-out buys is the escaping-counter idiom, which is common, correct today, and
differential-tested (`test/fixtures/stage11/counter.ts`):

```ts
function makeCounter() { let count = 0; return () => { count++; return count; }; }
```

`makeCounter`'s frame is gone before the closure ever runs and never names `count` again, so
nothing can observe the stale copy. Accumulating in an **inlined** `map`/`filter`/`reduce`
callback is likewise unaffected: those run in the enclosing frame, so they write the real
binding, and the `NT1029` hint points at them.

The rule is decided in `computeCaptures` (`src/checker.ts`) and pinned in
`test/capture-write.test.ts`, whose false-positive wall — a closure-local shadowing an outer
name, an arrow parameter, a nested arrow writing its own parameter — is the part most worth
keeping green. Lifting the refusal means **boxing** the captured cell: allocate the variable on
the heap and store the box pointer in the env slot, so every closure and the enclosing frame
share one cell. That is a real feature, not a patch, and it is what would let condition 2 go away.

| NT1029 | a closure writing a binding it captured, where the write would be observable (or the binding is not a `number`) | later | by-reference capture: box the captured cell so every closure and the declaring frame share one |

### STRICTER THAN `tsc` ON PURPOSE — a dotted-path narrowing an inline callback invalidates

A dotted path narrows now (`if (o.inner.kind === "A") { o.inner.left }`, `docs/self-hosting.md`),
and its stability rules are `tsc`'s — with **one place where we deliberately refuse a program
`tsc` accepts**, because `tsc` is wrong there and we would miscompile it.

```ts
let o: Box = { name: "p", inner: { kind: "A", left: 1 } };
if (o.inner.kind === "A") {
  [1].map((x: number): number => { o = { name: "q", inner: { kind: "B", right: "boom" } }; return x; });
  return "n" + o.inner.left;      // tsc: fine. node: "nundefined".
}
```

`tsc --strict` reports no error: it does not invalidate the narrowing for an assignment inside a
callback. node runs the callback inline, so by the read `o.inner` is the `B` member and `.left`
is `undefined`. For `tsc` that is a type-level lie with a benign runtime result; for us the same
lie is a **slot layout**, and the read would return a string pointer reinterpreted as a double.

So `closureAssigned` drops the fact and the read keeps its `NT2001`. Same input, three answers:

| | `tsc --strict` | node | nativets |
|---|---|---|---|
| the narrowed read above | accepted | `nundefined` | **refused**, `NT2001`, naming the assignment |

The *neighbouring* case needs no special pleading — `tsc` refuses a plain `o = other;` between
the proof and the read exactly as we do (`TS2339`, verified against `typescript@7.0.2`). Only the
callback shape diverges, and it diverges toward refusing.

| refusal | why | lift it by |
|---|---|---|
| a dotted-path tag narrowing whose root is assigned inside any arrow in the program | the arrow may run between the proof and the read, and unlike `tsc` we would emit the wrong slot layout rather than a merely-wrong type | tracking WHERE each arrow can run (an effect/order analysis), not by matching `tsc` |

### A tag test in a `?:` CONDITION narrows both arms — the FIFTH wiring

`if`, `switch`, and the `&&`/`||` short circuit each routed their condition through
`Checker.narrowTagsWith` (the "fourth wiring", above). `ConditionalExpr` was the one
conditional form that never did, so two spellings of one program disagreed:

```ts
function f(e: E): number { return e.kind === "A" ? e.left : 0; }   // NT2001 "narrow it first"
function g(e: E): number { if (e.kind === "A") return e.left; return 0; }   // fine
```

That was an arbitrary difference in surface syntax, not a soundness line. The ternary already
had the NULLISH half (`factsFor`, so `x !== undefined ? x.f : …` worked) — which is why the gap
read as a nullable problem and **is not one**: a tag test failed to narrow a ternary whether or
not a nullable was anywhere in sight.

`ConditionalExpr` is now a fifth CALL SITE of the one rule, not a fifth copy of it: all five
conditional forms share `narrowTagsWith` → `narrowTagsInto` → `narrowInto`/`narrowPathInto`, so
the path-stability rules (`accessPath`, `unstableNames`, `closureMayAssign`) apply to a ternary
unchanged. The arms take SEPARATE fact frames and SEPARATE child scopes — the consequent is
proved the tested tag, the alternate the remaining members.

54 of the 454 ternaries in `src/` have a tag test in the condition (counted with the compiler's
own parser; a line-based grep undercounts the multi-line spellings). Clearing this closed three
`NT2001` blockers in the stage-1 metric (268 → 265 of 666) and promoted one masked `NT1606`.

**The refusals are unchanged**, and the path one was verified by MUTATION: passing an empty
`blocked` set to `narrowTagsWith` makes

```ts
let o: Box = { inner: { kind: "A", left: 1 } };
return o.inner.kind === "A" ? ((o = { inner: { kind: "B", text: "zzzz" } }), o.inner.left) : 0;
```

compile and print `2.126700047e-314` — the string pointer `"zzzz"` read as a double — where node
prints `undefined`. With the filter it keeps its `NT2001`.

**A widening that could REMOVE programs, and the fallback that prevents it.** Narrowing makes an
arm *more precise*, and `joinTernary` is deliberately narrow (only a nullish literal joins with a
present arm). So `e.kind === "A" ? e : f` — both arms the whole union before, joining trivially —
became the `A` member vs the union, two unrelated object types. `e.kind === "A" ? e : e` is worse:
`restrictUnion` widens the tag literal away, so nothing downstream can tell the two members share
a union. Both compiled before this lane. Because the narrowing is a pure RETYPE of the same
pointer (a discriminated union value IS the member object pointer — there is no box), the
un-narrowed typing is still a correct account of the same program, so `ConditionalExpr` falls back
to it when the join fails. This only ever widens: the narrowed pass runs FIRST and its diagnostics
still propagate, so `e.kind === "A" ? e.text : "-"` stays refused.

That fallback is a MUTATION, not a query, and it now UNDOES itself when it does not take.
`Checker.type` writes the type it computes onto the AST nodes and codegen reads them back, so
re-typing the arms un-narrowed rewrites them in place: on `x.kind === "Neg" ? x.inner : x` it
retypes the receiver `x` to the whole union and only *then* throws on `.inner` (unreadable there),
and the `catch` swallowed the throw but not the damage. Nothing could observe that while every
failing path re-threw — codegen never saw the AST — but the moment any widening rescued the join
after that point, codegen got an AST with the narrowing rubbed out and reported the internal
"not at one slot in every member" instead of a refusal. The fallback re-runs the narrowed pass on
failure, so the AST always describes the typing that was actually returned. A new widening should
still prefer to run BEFORE the fallback; this makes that ordering safe rather than moot.

**Still refused, unchanged:** `e && e.kind === "A"` as a ternary condition, for exactly the reason
the fourth-wiring section gives — a bare nullable as an `&&` operand is `NT2001` in `if` too. It is
not specific to ternaries.

### A `?:` ARM IN A CONSUMING POSITION MOVES — `NT1604` was bypassable through a ternary

`Ownership.expr`'s `ConditionalExpr` walked both arms with a hard-coded `consume: false`, throwing
away the caller's `consume`. The move checker therefore could not see through a `?:` **at all**, so
every ownership rule had a one-token bypass:

```ts
function pick(x: string[], o: string[], c: boolean): number {
  const y: string[] = x;          // error[NT1604]: cannot move out of `x`: it is borrowed
  const y: string[] = c ? x : o;  // the IDENTICAL move — compiled, exit 0
  return y.length;
}
```

This is the same defect as `AsExpr`'s (see "A STATIC `expr as T` is CHECKED too"), one node type
over, and it was **not refusal-only**. The laundered binding becomes a second owner of a value the
caller still owns, so the callee frees it: ASan reports `heap-use-after-free` in `nt_arr_free` for
the declarator shape and *attempting double-free* when a union member is returned through an arm.
Both are SILENT on an ordinary run — the allocator's abort discards buffered stdout, so the binary
exits 0 having printed a prefix of the right answer. `move(x)` in an arm was always caught (its own
case consumes), which is why only the IMPLICIT move survived.

The arms now inherit `consume`; only the TEST is unconditionally a borrow. Reading THROUGH the
result is still a borrow, which is what keeps the useful half — `(e.kind === "A" ? e : f).kind`,
the union-join shape from the section above, compiles unchanged.

**MOVE, not the ALIAS reading `as` takes.** `as` retypes ONE place, so its result is always the
operand's allocation; a `?:` picks between two, and an arm can be a fresh value (`c ? a : ["z"]`)
that nothing else will ever free — aliasing would leak those. The cost is the mirror case, two
owned locals as the two arms:

```ts
const a: string[] = ["x"]; const b: string[] = ["y", "z"];
const y: string[] = c ? a : b;   // both marked moved; only the one that RAN is reachable
```

Both are marked moved but only one is reachable through `y`, so the other **leaks**. Making that
exact needs a per-path drop flag this pass does not have — the same one the `NT1608` linear-parameter
rule also declined to invent — and a leak is the better of the two failures. It was a
use-after-free before. node's answer is still exact in every accepted case.

**What this removed.** Five tests rested on the hole, all of them on the same unsound spelling —
a helper that returns a borrowed parameter through an arm (`opt(e, on) { return on ? e : undefined }`,
and `pick(e, f) { return e.kind === "A" ? e : f }`). Both are now written to BUILD their value in
the arm, or to read through the result; `test/unions/narrow-nullable.ts` produces byte-identical
output under node, so its `.expected` file needed no change. In `src/`, exactly one site changed
behaviour — `Codegen.msgValue`, whose `if` spelling was ALREADY `NT1604`, so the fix makes the two
spellings agree rather than narrowing anything. Pinned in `test/ownership/ternary-move.ts` and
`test/drops.test.ts` (which carries the ASan gate).

### A `switch` ARM THAT REBINDS ITS DISCRIMINANT — the const shadow was standing in for a filter

`narrowNameInto` takes a `blocked` set so a region that rebinds the narrowed name **declines to
narrow** instead of shadowing the name `const` and turning the rebind into an error. Every
condition form routes through it — `if`, `while`, `&&`/`||`, the early-exit guard, `?:` — except
one. `checkStmt`'s `SwitchStmt` arm called `narrowInto` **directly**, and computed a `blocked` set
only for a dotted-path discriminant, so a plain NAME discriminant got `null`. Two spellings of one
program disagreed, and the `switch` was the one refused:

```ts
let cur: N = { kind: "a", x: 1 };
if (cur.kind === "a") { cur = { kind: "b", s: "swapped" }; }            // fine
switch (cur.kind) { case "a": cur = { kind: "b", s: "swapped" }; break; }  // NT2001 "cannot assign"
```

`switch (x.kind)` is the more idiomatic form over a discriminated union and the one `src/` is
written in throughout, so this was the worse half to have missed.

**It was not refusal-only.** The const shadow had been doing the filter's job, and there is one
arm shape that never gets a shadow: a **non-literal case test** (`case pick:`, legal — only its
TYPE is checked against the discriminant) contributes no tags, so `restrictUnion` answers
`undefined` and `narrowInto` declares nothing. With no shadow the arm's rebind was simply allowed,
and if the arm falls through, `carry` narrows the successor to a **sub-union** where
`unionCommonField`'s same-slot rule admits the read:

```ts
type N = { kind: "a"; v: number } | { kind: "b"; v: number } | { kind: "c"; s: string };
let cur: N = { kind: "a", v: 1 };
switch (cur.kind) {
  case pick: cur = { kind: "c", s: "boom" };   // no shadow ⇒ allowed
  case "b":  console.log(cur.v);               // narrowed to {a,b}; `.v` is slot 1 in both
}
```

`a` and `b` both carry a number at slot 1, so the read is accepted — but the value there is a `c`,
whose slot 1 is a **string pointer**. On main at `9c9477f` this printed `2.157443986e-314` at
exit 0 where node prints `undefined`: this project's signature silent wrong answer, for the eighth
recorded time. `carry` could not have caught it — it tracks TAGS, and the tags were right; it was
the VALUE that had moved.

**The region is per-arm, not the whole switch.** A NAME shadow must be stable over the arm's own
body plus every arm reachable from it by FALL-THROUGH — the same reachability `carry` already
computes with `leavesBlock`, so the new `flow` is `carry`'s twin in the assignment domain. The
blunt all-bodies set the dotted-path case uses would also be sound, but it would refuse
`case "a": read; break; default: assign;`, which node runs and which is not stale at all: the two
arms cannot reach each other. (The path case keeps the blunt set — a path fact is the more fragile
of the two and nothing has measured a need for more.)

| | before | after |
|---|---|---|
| an arm rebinds, reads no narrowed field | **refused** at the assignment | compiles, matches node |
| a sibling arm reads a narrowed field, both `break` | **refused** | compiles, matches node |
| an arm rebinds then reads a narrowed field | refused at the assignment | refused at the READ, hint names the assignment |
| a non-literal arm rebinds and falls through | **`2.157443986e-314`, exit 0** | refused, `NT2001` |

Pinned in `test/narrowing.test.ts`, "narrowing 7". The `flow` term is proved by MUTATION: drop it
and the sub-union fall-through compiles to `2.124223034e-314` where node prints `undefined`.

### `this` IN A `@@mutable` METHOD IS A BORROW — untracking it had been standing in for unchecking it

Every rule in "@@mutable ownership" says the same thing: a `@@mutable` method returns a **borrow**
of its receiver, and that borrow may not escape. `return a.bump()` out of the owner's scope is
`NT1604`; `[new Counter().bump()]` is `NT1604`; binding a method result as an owner is `NT1604`.
All of them name the borrow **at the call site**. `this` is the identical borrow named from
**inside the body**, and it was exempt from all of it:

```ts
//@@mutable
class C { n: number = 30; box(): C[] { return [this]; } }
function f(): C[] { const c = new C(); return c.box(); }
console.log(f()[0].n);        // node: 30
```

This compiled at **exit 0** printing `1e-323` — the receiver is freed at the end of `f` while the
returned array still points at it, and the denormal is the stale slot re-read. Under
`-fsanitize=address` it is `heap-use-after-free` in `main`. **The undecorated twin of the same
program was refused `NT1604` already**, so the attribute was the only thing standing between the
program and a silent wrong answer — a wrong answer is not what `@@mutable` is supposed to buy.

**Mechanism, and why it is a mechanism rather than a symptom.** `untrackedThis` (`ownership.ts`)
drops `this` from `linear` *and* from `paramBorrows` for every member of a `@@mutable` class. The
first is right and is the point: move-tracking the receiver would invent spurious re-move reports
on the fluent chain. The second was collateral — with `this` out of `paramBorrows` it is out of
`borrowBindings`, so the `NT1604` arm can never fire on it, and **every** consuming position in the
body goes unchecked at once: a field store, an array or object literal, a `.push`, an argument in a
consuming slot. The comment justifying the exemption names exactly one position, `return this`, and
delegates the rest to "the call-site rules" — but those rules inspect the **result of a call**, and
none of these happen at a call. The RECEIVER side (`checkOwnedReceiver`, which returns early for
`this`) was reasoned about; the VALUE side never was.

The two jobs are now separate: **untracked for move state, borrowed for escape** (`Analyzer.borrowThis`).
`return this` is the one hand-back that stays legal, because the call-site rules can see it.
`const self = this` also still compiles, by an older mechanism — `collectAliases` already records it
as an ALIAS of `this`, which makes the initializer a borrow and makes `self` itself a borrow binding.

**The other two `untrackedThis` arms are deliberately NOT included.** A copy-on-write setter on an
ordinary class works on a private fresh copy, and `untrackThis` marks a decorated constructor whose
only consuming use of `this` is the `return this` the parser itself synthesized. In both the
receiver really is this frame's value, and there is nothing to escape.

**What this costs, stated plainly.** `new C(this)` where `C`'s constructor declares a **parameter
property** of the receiver's type is now `NT1604` — a parameter property *consumes* its argument
(it stores it in a slot that outlives the call), so the expression asks the new object to take
ownership of a receiver the caller owns. That is rustc's `FnGen::new(*self)` from `&self`, E0507,
and it is refused for the same reason. `src/codegen.ts` relies on it at four sites
(`new FnGen(this)`), so the compiler's own source is now outside the subset it compiles at those
lines. They are invisible today — `codegen.ts` is blocked earlier by the pre-existing `NT1606`
`Set.add` refusal, and `bun run test/blocker-metric.ts` is unchanged at 206/693 because it counts
CHECKER refusals only — but they are a real future blocker, recorded here rather than narrowed
around. The shapes where the container escapes are measured use-after-free; this pass cannot prove
that a given container does not, so it refuses rather than guesses. `new Scope(this)` in
`src/checker.ts` is unaffected: `Scope | null` is nullable, so the parameter property does not
consume.

Pinned in `test/decorators.test.ts` ("`this` may not ESCAPE its own method body"). Proved by
MUTATION: drop the `borrowedThis` argument in `analyzeOwnership`'s `runScope` call and the first
case compiles to `1 1e-323` at exit 0 against node's `1 30` — a MISCOMPILE, not a crash.

The single biggest unlock is **M1 (a heap value model → arrays + objects)**, which in turn
unblocks much of M2. That is the next architectural push.

### CLOSED — a module-level binding's promoted global slot lost its declared type

Filed here as "a module-level nullable assigned by a function emits invalid IR", with the
warning **not** to fix it by making the constant well-formed. That warning was right, and
the reason it was right turned out to be the whole diagnosis: the ill-formed constant was
the *loudest* member of a family, not the bug.

```ts
let g: number | undefined = 5;
function clear(): void { g = undefined; }
clear();
console.log(g ?? 0);          // node prints 0
```

A module-level binding a function body touches is promoted to an LLVM global (`@nt.g.x`,
SH1). `FnGen.addr` looked its address up in `mod.globals`; the two places that needed its
**type** did not, and `varTypes` never holds a promoted global in any frame but `main`:

- **write** (`AssignExpr`) fell back to `"number"`, so *every* write to a global from
  inside a function was lowered as a bare `double` — `store double 0, ptr @nt.g.g` for the
  case above, three lines from that same slot's correctly-boxed initializing store.
- **read** (`Identifier`) fell back to `e.ty`, the checker's type for *this read*, which
  control-flow narrowing may already have sharpened to the present arm — so a narrowed
  read loaded the A2 box pointer as if it were the base value.

Both now consult `mod.globals`, and the whole family agrees with node.

**Why the constant was the wrong place to fix it.** Patching `double 0` → `double 0.0`
gave `clang -x ir -c` exit 0 → link exit 0 → **run exit 139 (SIGSEGV)**. And the family
contained two shapes that never produced a build failure at all — valid IR, exit 0, wrong
answer:

| shape | node | before |
|---|---|---|
| `g = 7` where `g: number \| undefined` is a global | `7` | `store double 7.0` into a box slot → **SIGSEGV** |
| `if (g) { g.length }` on a global `string \| undefined` | `3` | **`1`** — `js_str_len` of the box, i.e. the tag word read as UTF-8 |

Neither is reachable by any IR-level check. The rest of the family — `T | null`, a
`string`/`boolean`/array global assigned plainly, and `s += "b"` on a `string` global
taking the `fadd` path — happened to be caught by clang's parser, which is what made the
whole thing look like a formatting problem.

**Its diagnostic was also circular**, which is how this stayed hidden. The NT2001
nullable-read hint advises `g?.x`, `if (g) { … }`, `!`, or binding a local copy; for a
module-level nullable **every one of those routes failed to build or ran wrong**. All four
now compile and match node, and each is pinned as a test — `?.`, `!` and the local copy in
`test/nullable-assign.test.ts` block 6, alongside the write family.

One narrowing refusal in that area survives on purpose and is *not* this bug — but its
boundary is **not** where it was first described, and the difference matters because it is
the shape the original report used. Measured both ways:

```ts
// A — WORKS. The write is at top level.
let g: string | undefined = "abc";
function f(): void { if (g) { console.log(g.length); } else { console.log("absent"); } }
f(); g = undefined; f();                       // node: 3 / absent — nativets matches

// B — REFUSED (NT2001). Identical, except a FUNCTION does the write.
let g: string | undefined = "abc";
function clear(): void { g = undefined; }
function f(): void { if (g) { console.log(g.length); } else { console.log("absent"); } }
f(); clear(); f();                             // node: 3 / absent
```

So the trigger is **"some function writes the global"**, not "the narrowing is at top
level" — in B the narrowing is *inside* the reading function and is still dropped, because
any call could have invalidated it. It is a refusal, not a miscompile.

**The hint used to be circular for exactly this case — CLOSED.** On B it advised *"prove
it non-nullish first — `if (g) { … }`"* at a read whose author wrote precisely that. The
other routes (`g?.length`, `!`, a local copy) do work here, so the hint was not useless —
but its first suggestion was the one the reader had already tried. It now says why no
guard on that spelling can work and **names the writer it found**:

```
error[NT2001]: 'g' is possibly undefined
  = help: 'g' is assigned by `clear`, so a guard on it records NOTHING — any call between
    the guard and this read could rebind it … BIND IT FIRST and test the local:
    `const v = g; if (v) { … v.length … }` — the local is read once, before any call can
    change it. Or use '?.' … or `!`
```

Every spelling it recommends is compiled against node in `test/narrowing.test.ts`
("a module-level binding a function assigns"), and a binding no function assigns keeps the
original wording — that case is the mutation guard. This was the SECOND reading of this
hint as circular; the first (a `@@mutable` receiver, where the dotted path is what
`accessPath` declines) is closed in `test/mutable-narrowing.test.ts`. The **refusal**
itself is unchanged and deliberate: see that file for the counterexample and for what
relaxing it would cost.

**Related boundary worth stating explicitly:** `verifyModule` passing means *the module
parses*, explicitly **not** that it is correct. The segfault above is the proof, and the
distinction has to stay written down or the check becomes a licence to trust.

When a feature ships: delete its row here, move its corpus case out of `KNOWN_UNSUPPORTED`
in the relevant `test/*conformance*`/`test/gap.test.ts` allow-list, and drop the `NYI` entry.
