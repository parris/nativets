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

**Still refused, on purpose:** a bare nullable as a `&&` operand (`if (e && e.kind === "A")`) is
`NT2001: '&&' operands must be matching …`. That is a different gap — node's `a && b` evaluates to
`a` when `a` is falsy, so the expression's type is a general union — and it is not specific to
unions (`if (o && o.n > 1)` on any `R | undefined` is refused the same way). Spell it
`e !== undefined && e.kind === "A"`.

**And the hint was fixed.** "Narrow it first" was one fixed sentence, and three shapes reached it
with a tag test already written. `Checker.narrowAdvice` now says which one it is:

| Receiver | What it says now |
|---|---|
| a plain name, never narrowed | narrow it first — `if (e.kind === "A")` or `switch (e.kind)` |
| a PATH (`o.inner`, `this.e`) | narrowing tracks a plain NAME — bind it first (`const v = o.inner;`) and narrow `v` |
| already narrowed to a SUB-union (`case "A": case "B":` sharing a body) | narrowed here to MORE THAN ONE member (`"A"`, `"B"`), so only the shared tag is readable — give each tag its own arm |

Each of the three workarounds it prescribes was verified to compile and match node.

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
`.at(i)` for node's out-of-range `undefined`, exactly as with a plain `a[i]`.

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

These are **not** a divergence: they are SyntaxErrors in strict mode, and a TypeScript module
is strict, so node refuses them too (`SyntaxError: Octal escape sequences are not allowed in
strict mode`). They are `NT0001`, the ordinary syntax band. A bare `\0` is untouched — it is
the NUL escape, legal in strict mode, and refused as `NT1705` for its own reason.

`\8` and `\9` are **NonOctalDecimalEscapeSequence**, decode to `"8"`/`"9"` exactly as node
does, and stay accepted (test262 `legacy-non-octal-escape-sequence-8-non-strict.js`).

> Fixing this needed `\uHHHH` / `\u{H+}` to exist at all: `\u` was not an escape the lexer
> knew, so it fell through to "an unknown escape is the character itself", and `"a\u0041b"`
> compiled to the seven characters `au0041b` where node gives `aAb`. That is now implemented
> and node-differentially tested (`test/nul-string.test.ts`), and it is also what routes a
> `\u0000` into `NT1705`. `String#length` over the result is still UTF-8 byte-oriented —
> §A.2, unchanged.

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
| `&&` / `\|\|` operand (either side) | already `NT2001` (operands must be matching boolean/number/string) | unchanged |
| `return` from a `: boolean` function | already `NT2001` (return type mismatch) | unchanged |
| argument to a `boolean` parameter | already `NT2001` | unchanged |
| `const b: boolean = m.delete(k)` | already `NT2001` | unchanged |
| `m.delete(k) === true` | already `NT2001` (cannot compare) | unchanged |
| `Boolean(m.delete(k))` | already `NT1003` (`Boolean` unsupported) | unchanged |

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

**Still open, and the complete fix.** `console.log(m.delete("zz"))` prints the map where node
prints `false`, and `const gone = m.delete(k); console.log(gone)` does the same — those are
value positions, not boolean ones, and under our semantics printing the resulting collection
is the *correct* rendering, indistinguishable from `console.log(m.set(k, v))`. The complete
fix is the one the discarded-mutator section names: box the handle so `.delete` can return
node's boolean.

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

The one hole those do not cover is a **CLOSURE**: an arrow copies the array POINTER into a heap env
this scope cannot null, and the closure may outlive the binding. A push to a captured accumulator is
`NT1607`.

**The receiver shapes that stay refused**, each pinned in `test/push-accumulator.test.ts`:

| receiver | code |
|---|---|
| an undecorated local | `NT1606` |
| an **unmarked parameter** | `NT1606` |
| `this.<field>` | `NT1606` |
| a container **element** (`g[0].push(v)`) | `NT1606` |
| a **captured** accumulator | `NT1607` |
| an accumulator already **moved out** | `NT1601` |
| the accumulator while a `for-of` **borrows** it (iterator invalidation) | `NT1603` |
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

## B. Unimplemented features (we refuse to compile — never miscompile)

Everything else we don't support is **rejected with an `NT1xxx` diagnostic**, not silently
miscompiled. Run `nativets coverage <file>` to see exactly what blocks a program, grouped by
code, milestone, and frequency. The catalog lives in `src/diagnostics.ts` (`NYI`):

| Code | Feature | Milestone | Needs |
|------|---------|-----------|-------|
| NT1001 | arrays: empty `[]`, nested/object element types | M1 | (basic `number[]`/`string[]` are ✅ supported; `console.log(arr)` is ✅ node-exact — see the util.inspect section above) |
| NT1002 | objects: nested object fields, object methods | M1 | (flat objects, `.f`/`o["f"]`, `Object.keys`, `for-in` are ✅ supported) |
| NT1003 | arrow functions / function values / closures | M2 | captured environments |
| NT1004 | a `throw` that CROSSES A CALL BOUNDARY | M2 | propagation (see below); `try`/`catch`/`throw` within one frame ✅, and an UNCAUGHT `throw` ✅ |
| NT1005 | `JSON` | M3 | `JSON.stringify` ✅ and `JSON.parse` + `dyn as T` runtime typecheck ✅ (scalars/objects/arrays, nested); code reused to reject un-validatable narrow targets (functions, unions). A compound `Dyn` now PRINTS node-exactly (util.inspect, see above) |
| NT1006 | spread | M2 | arrays/objects; spreading a VALUE into a call is supported only where the arity is known or the fold has an identity — see below |
| NT1007 | destructuring | M2 | arrays/objects |
| NT1008 | rest parameters | M2 | arrays |
| NT1009 | optional `?.()` call / general or >2-arm unions | M2 | `?.` on object fields **and `?.[i]` element access** ✅, `??`, and restricted `T\|undefined`/`T\|null` are ✅ (A2); the reused code now rejects only the out-of-subset forms |
| NT1010 | `for-in` | M1 | objects |
| NT1011 | `for-of` over non-strings | M1 | arrays/iterables |
| NT1013 | generics | M3 | generic **functions** monomorphize ✅ (Stage 36) and type arguments erase ✅ (SH2); the code now rejects only the corners below |
| NT1030 | a recursive type with nowhere to put a back-edge (`type P = Q[]`), an in-place write to a **cycle-capable FIELD** of a `@@mutable` record, a `@@mutable` recursive CLASS declaration, or a cycle one of whose members is refused for its own reason | later | self- AND mutually-recursive object/union declarations now COMPILE via the nominal `@Name` back-edge; ordering was never the problem — see below |

### An UNCAUGHT `throw` compiles; a throw that CROSSES A FRAME is still `NT1004`

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

**Still refused, unchanged:** the ordinary "raise in the callee, handle at the call site"
idiom — a throw in a function with the `try` one or more frames up. The value would have to
survive the return, which means a checked error return at every call site of every
may-throw function, a live-set drop at each of those sites, and an interprocedural type for
the `catch (e)` binding. Also refused: `throw 42` / `throw { … }` with no `message` string,
because there is nothing to raise and inventing text would be a wrong answer.

### `catch (e)` takes ONE type — a `try` with throws of two types is `NT1004`

node's `catch` parameter is `any`. Nothing here is, so the binding is given the type of the
**first `throw` the checker can see in the block** (or `{message:string}` when the block calls
a host builtin, SH4). A block that throws two different types therefore has no honest binding
type, and it is refused at the `throw`, naming both types.

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
- **Assignment to a static field** (`C.f = v`) — it is a `const`, like every other module-level
  binding here (§A, immutable-by-default). `NT1606`, pointing at a static method instead. node
  allows the write.
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

The single biggest unlock is **M1 (a heap value model → arrays + objects)**, which in turn
unblocks much of M2. That is the next architectural push.

When a feature ships: delete its row here, move its corpus case out of `KNOWN_UNSUPPORTED`
in the relevant `test/*conformance*`/`test/gap.test.ts` allow-list, and drop the `NYI` entry.
