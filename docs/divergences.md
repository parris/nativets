# Divergences & unsupported features

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

A wrong-but-plausible `0` is the worst outcome available: the program keeps running and computes
a wrong answer from a value that was never there. Memory safety is supposed to mean *a guaranteed
controlled stop*, never *continuing into a phantom value*. Reproducing node's `undefined` would
mean making every element read nullable (`T | undefined`) — the whole language pays a tagged-pair
box on every index so that a bug can be *quietly propagated*. So we take the third option, the one
Rust takes: stop, loudly, at the exact source location.

Rules:

- **Covered accessors:** array read `a[i]`, string index `s[i]`, `Uint8Array` read `u[i]` **and
  write** `u[i] = v` (including compound `u[i] += v`), and `arr.with(i, v)` (flat *and* past the
  32-element persistent-trie threshold — node throws a `RangeError` here, so node stops too).
  **Negative indices panic everywhere** (they are not Python-style wrap-around).
- **A panic is NOT an exception.** It deliberately does not go through the Stage-20
  pending-exception protocol: `try { a[5] } catch {}` still aborts, and a `finally` does not run.
  It stops the program; it is not a control-flow construct.
- **`.at(i)` is the node-exact escape hatch** and is unchanged: it returns `T | undefined`
  (`a.at(5)` → `undefined`, `a.at(-1)` → the last element), matching node byte for byte. It is the
  documented way to ask "give me `undefined` instead of panicking", which is what the panic's
  `help:` line names. `String#charAt(i)` is likewise untouched — node *defines* it as `""` out of
  range, so it is not a defect and does not panic.
- **Compile-time beats runtime.** When the length and the index are both statically known — a
  literal array/string, or a `const` bound to one, indexed by a numeric literal — the program is
  **rejected** with **`NT2002`** (`index 5 is out of bounds for an array of length 3`) rather than
  built and aborted. It is a real user error, hence the NT2xxx type-error band rather than the
  NT1xxx "not yet implemented" gradient, and `coverage` surfaces it.
- **Only written indices panic.** Compiler-generated in-bounds reads (`for-of`, the array HOFs,
  `JSON.stringify`, destructuring, spread-call expansion) keep the internal non-panicking
  accessor, so nothing pays twice and in-bounds programs are behaviourally unchanged.

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
  — `$x` IS quoted), **class instances** `Point { x: 1 }`, **arrays** `[ 1, 2, 3 ]` /
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
- **`%j`** of a `Map`/`Set`/`Dyn`/handle (`JSON.stringify` has no meaning for them here);
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
- **`Date.now()` is not node-differential** (a clock read): it is tested behaviorally —
  monotonic, whole milliseconds, plausible epoch range.

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
- **A Date is an IMMUTABLE time value.** `setHours`/`setDate`/… are refused (**`NT1023`**),
  pointing at reconstruction (`new Date(d.getTime() + ms)`). So is `Date#toString`/
  `toLocaleDateString` — those are locale + zone-*display-name* formatting, which needs tables
  we do not ship. `"" + date` is refused for the same reason.
- **`new URL(u)` covers absolute `http(s)` URLs.** Out of subset: relative URLs, other schemes
  (`file:`, `data:`), IPv6 bracket hosts, punycode/IDNA, and path/percent **normalization**
  (input is assumed canonical; node re-normalizes). node throws a `TypeError` on a URL it cannot
  parse and so do we — catchably — but for a *different set* of inputs: a `file:///x` that node
  accepts throws here. `.href` and `URL#toString()` need the WHATWG serializer, so they are
  refused (`NT1023`) rather than approximated; `console.log(url)` likewise (node inspects it as
  `URL { … }`).
- **`URLSearchParams` is read-only**: `.get`/`.has`/`.getAll`/`.toString`. `.append`/`.set`/
  `.delete`/`.sort` mutate, so they are refused — consistent with immutable-by-default.
- **Memory:** a `Date` allocates NOTHING (it is a `double`), so it is never a leak and never
  needs a drop. A `URL`/`URLSearchParams` handle is an rc-registered string that codegen does
  not release, so it is on the same conservative over-retention as other heap handles — a
  bounded residual leak, never a dangling pointer (`__strLive()` will not return to 0 in a
  program that builds URLs).
- **`Object.freeze(o)` is the identity, and that is honest**: objects are already immutable
  (Stage 29), so freezing changes nothing and node's contract (same object back, non-writable)
  holds exactly; `Object.isFrozen` is therefore constant-`true`. `Object.assign`/
  `defineProperty`/`setPrototypeOf` MUTATE their target and are refused with **`NT1606`**
  pointing at object spread.
- **`String#normalize` and `#localeCompare` are refused** (`NT1023`), not approximated:
  normalization needs the Unicode character database and collation needs ICU
  (`"a".localeCompare("B")` is `-1` in node but `+1` under any byte compare — §A on string
  relational order).
- **String concatenation with a `T | null` / `T | undefined` is now refused** (`NT1009`,
  "unwrap it first"). It previously reached codegen and emitted invalid IR — a real defect, found
  by this lane through `URLSearchParams#get`.

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

> **Pre-existing, and NOT fixed by that lane:** the A2 nullable box has three of the same holes,
> two of them silently wrong. With `const x: number | undefined = [0].at(0)`, `if (x)` prints
> `truthy` where node prints `falsy`, and `JSON.stringify(x)` prints `null` where node prints `0`;
> `` `${x}` `` emits invalid IR. These predate general unions and need their own lane.

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

### Modules (SH1) — a whole-program link, and no import cycles

`import`/`export` across `.ts` files are compiled by resolving the graph from the entry file and
merging every module into ONE program (`src/modules.ts`). For an **acyclic** graph this matches
node exactly — same evaluation order (post-order DFS), each module's top level run **once**, same
bindings. Two deliberate differences:

- **Import cycles are refused** (`NT1702`, naming the cycle). ESM permits them via live bindings
  and a TDZ; a whole-program link has no such machinery, so we reject rather than pick an order
  that silently differs from node. Break the cycle with a third shared module.
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
`src/ast.ts`, the single copy shared with codegen's receiver-temp free.

On a fresh receiver `.sort()` is exactly `.toSorted()` — same value, and the temporary it would
have sorted in place is discarded either way — so it is **rewritten to `toSorted`** in the
checker and lowers through the copying path above. That is what keeps the permission safe: the
rewrite means `.sort()` never hands its receiver back, so it cannot create the two-bindings-one-
array alias that in-place mutation would need. Verified in the emitted IR (the fresh temp is
freed exactly once, the result is a distinct pointer) and node-differentially in
`test/immutable.test.ts`, including node's lexicographic default (`[10,9,1,100,2].sort()` →
`1,10,100,2,9`).

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

### Strings are reference-counted, not linear (memory model)

Heap strings keep JS **value semantics** (free copy/alias) and are reclaimed by **reference
counting** — so, unlike arrays/objects (linear ownership + move-check), strings are **never**
move-checked: aliasing a string is always fine, no `NT1601` on strings. Reclamation is invisible to
behavior (rc is a memory-model detail); the only observable guarantee is no leak of heap strings
(`nt_str_live()` → 0). This supersedes the earlier "strings are linear" research direction.

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
    **Known boundary:** the guard is NAME tracking in the parser, not dataflow, so an async
    function that escapes into a *function parameter* (`run(f)`, then `f()` inside `run`) or is
    returned as a value and called through the result is **not** reached today. Closing it needs
    the async-ness to survive on the TYPE, which `Promise<T>` erasure currently discards.
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

## B. Unimplemented features (we refuse to compile — never miscompile)

Everything else we don't support is **rejected with an `NT1xxx` diagnostic**, not silently
miscompiled. Run `nativets coverage <file>` to see exactly what blocks a program, grouped by
code, milestone, and frequency. The catalog lives in `src/diagnostics.ts` (`NYI`):

| Code | Feature | Milestone | Needs |
|------|---------|-----------|-------|
| NT1001 | arrays: empty `[]`, nested/object element types | M1 | (basic `number[]`/`string[]` are ✅ supported; `console.log(arr)` is ✅ node-exact — see the util.inspect section above) |
| NT1002 | objects: nested object fields, object methods | M1 | (flat objects, `.f`/`o["f"]`, `Object.keys`, `for-in` are ✅ supported) |
| NT1003 | arrow functions / function values / closures | M2 | captured environments |
| NT1004 | `try`/`catch`/`throw` | M2 | unwinding |
| NT1005 | `JSON` | M3 | `JSON.stringify` ✅ and `JSON.parse` + `dyn as T` runtime typecheck ✅ (scalars/objects/arrays, nested); code reused to reject un-validatable narrow targets (functions, unions). A compound `Dyn` now PRINTS node-exactly (util.inspect, see above) |
| NT1006 | spread | M2 | arrays/objects |
| NT1007 | destructuring | M2 | arrays/objects |
| NT1008 | rest parameters | M2 | arrays |
| NT1009 | optional `?.()` call / `?.[]` index / general or >2-arm unions | M2 | `?.` on object fields, `??`, and restricted `T\|undefined`/`T\|null` are ✅ (A2); the reused code now rejects only the out-of-subset forms |
| NT1010 | `for-in` | M1 | objects |
| NT1011 | `for-of` over non-strings | M1 | arrays/iterables |
| NT1013 | generics | M3 | generic **functions** monomorphize ✅ (Stage 36) and type arguments erase ✅ (SH2); the code now rejects only the corners below |

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
| NT1020 | promises / concurrency: `Promise.*`, `new Promise`, `.then`/`.catch`/`.finally`, un-awaited `async` results | later | an event loop — or, the chosen answer, the **actor** model (`spawn`/`send`/`receive`). `async`/`await`/`fetch` themselves are ✅ supported (blocking; see §A) |
| NT1025 | `console.log` of a value with no node-identical rendering: a **function value** anywhere, or a `Uint8Array`/`TextEncoder`/`TextDecoder`/`Response`/`Headers`/`URL`/`URLSearchParams` handle **nested inside** a printed value | later | objects, class instances, arrays, Map/Set and `Dyn` are ✅ node-exact (util.inspect, see above); this code covers only the leaf types that have no node-identical form here |

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

Everything outside the implemented surface is **`NT1028`**, never half-implemented — including
the argument *values* that decide what node returns: `readFileSync(p)` with no encoding (node
yields a Buffer), a computed encoding, `spawnSync` without `{ encoding: "utf8" }`, and any other
`spawnSync` option (`cwd`/`env`/`input`/`shell`/`timeout`), since accepting and ignoring one
would silently change what the program does.

| NT1028 | a `node:` builtin module, or a member of one, outside the implemented host FFI surface | later | the surface is what a self-hosted compiler needs: `node:fs` (`readFileSync`/`writeFileSync`/`existsSync`), `node:child_process` (`spawnSync`) |

The single biggest unlock is **M1 (a heap value model → arrays + objects)**, which in turn
unblocks much of M2. That is the next architectural push.

When a feature ships: delete its row here, move its corpus case out of `KNOWN_UNSUPPORTED`
in the relevant `test/*conformance*`/`test/gap.test.ts` allow-list, and drop the `NYI` entry.
