# Standard library — bringing the web standards in

Removing Node/Bun/V8 gave us a small native binary — but it also removed the **standard
library**. Today a nativets program has only what the C runtime + codegen builtins expose
(`console.log`, `Math.*`, string methods, `JSON`, `Map`/`Set`, `parseInt`/`Number`, the Host I/O
FFI). Familiar web/JS globals — `Date`, `btoa`, `TextEncoder`, `URL`, `crypto`, `fetch`,
`structuredClone`, `setTimeout`, `RegExp`, `Promise` — are all missing. This document is the plan
to build a **web-standards-shaped standard library**, done the nativets way: native, immutable,
memory-safe, differential-tested against `node`, and **reject-don't-miscompile**.

## Principle: keep the good web APIs, delete the footguns

`node` implements the web/ECMAScript standards, so it's the **perfect oracle** — every stdlib API
we add is differential-tested to match `node` byte-for-byte (modulo our documented divergences,
e.g. UTF-8 byte lengths). But we offer the **good** parts of the platform, not the footguns: the
stdlib stays immutable-by-default, tag-based (no truthiness coercion surprises), and refuses what
it can't do safely instead of miscompiling.

## Delivery architecture (three tiers)

- **Tier A — C-runtime primitives.** Anything OS- or performance-bound: `Date`/time, byte
  encoding (base64), entropy (`crypto`), high-resolution timers. Added exactly like the existing
  `Math`/`JSON` builtins — a runtime function + a codegen `genGlobal` case + a checker signature.
- **Tier B — a nativets *prelude* (dogfooded).** Higher-level APIs that are *expressible in the
  supported subset* are written **in nativets itself** and auto-prepended to every program (a
  "prelude"). This was the delivery vehicle for composed helpers until the module system existed.
  **Self-hosting SH1 has now landed a real module system** (`src/modules.ts`: `import`/`export`
  across `.ts` files, whole-program linked — see `docs/self-hosting.md`), so the prelude can become
  proper `import`ed `std/*` modules: a `std/` directory of ordinary nativets `.ts` files that a
  program pulls in with `import { … } from "…/std/x.ts"`, with no compiler change needed. Writing
  the stdlib in nativets is the ultimate dogfood — it also drives the language toward self-hosting.
  *(Open design question deliberately left for the stdlib lane: how `std/*` is located — a bare
  `"std:collections"`-style specifier would need a resolver hook, since only relative paths resolve
  today.)*
- **Tier C — needs new infrastructure (each its own initiative).** Some web APIs require machinery
  we don't have yet:
  - ~~**`fetch` / `Headers` / `Request` / `Response`**~~ **✅ done (host-only)** — see "fetch" below.
  - ~~**`Promise` / `async` / `await`** → an **event loop** *or* the **actor** model~~ **✅ fork
    resolved** — see "the async decision" below.
  - **`RegExp`** → a regex engine (NFA/backtracking) — sizable.
  - **`setTimeout` / `setInterval` / `queueMicrotask`** → an event loop / timer wheel (the actor
    scheduler is a starting point).
  - **`Uint8Array` / typed arrays / `ArrayBuffer`** → a **bytes** value type — a prerequisite for
    `TextEncoder`/`TextDecoder`, `crypto`, `Blob`, and streams.

## Prioritized catalog

### Batch 1 ✅ DONE — tractable now (Tier A/B, no new infra), high value

Landed in two tranches; `node` is the oracle for every API below
(`test/stdlib-batch1.test.ts`, plus `test/base64.test.ts` for the base64 CLI). The exact
supported surface:

**Globals / statics**
- **`Date.now(): number`** — ms since epoch (`clock_gettime`). Non-deterministic, so it is
  tested behaviorally (monotonic + plausible range + whole ms), not against node.
  *(`new Date()` and the date-component API landed later, in **Batch 3** — see below.)*
- **`btoa(s)` / `atob(s)`** — base64 over the string's bytes, all padding lengths.
- **`String.fromCharCode(...)` / `String.fromCodePoint(...)`** — variadic, UTF-8 encoded.
- **`Number.isInteger` / `isFinite` / `isSafeInteger` / `isNaN` / `parseInt` / `parseFloat`**
  (the `Number.*` forms are the namespaced aliases of the globals; no ToNumber coercion is
  needed since the argument is already statically a `number`).
- **`Number.MAX_SAFE_INTEGER` / `MIN_SAFE_INTEGER` / `EPSILON` / `MAX_VALUE` / `MIN_VALUE` /
  `POSITIVE_INFINITY` / `NEGATIVE_INFINITY` / `NaN`** — constant-folded to their exact
  IEEE-754 values.
- **`Array.isArray(x)`** (compile-time, from the static type), **`Array.from(str)`** (code-point
  characters), **`Array.from(arr)`** (shallow copy), **`Array.of(...)`**.
- **`Object.keys` / `Object.values` / `Object.entries` / `Object.fromEntries`** — all
  compile-time-key driven. `Object.entries` requires a **string-valued** object (a `[string, T]`
  pair is a mixed-type tuple, which our homogeneous arrays cannot hold — otherwise `NT1002`,
  pointing at `Object.keys` + field access). `Object.fromEntries` takes a **literal** array of
  literal `["key", value]` pairs (the keys must be known at compile time).
- **`structuredClone(v)`** — a **type-directed deep copy** (the `JSON.stringify` walk shape):
  scalars pass through, objects become a fresh slot block with every field cloned, arrays a
  fresh vector with every element cloned. Nested objects/arrays are new references, exactly
  like node. Functions/`Map`/`Set`/`Dyn` are refused (`NT1002`), as node throws `DataCloneError`.

**String methods** — `charCodeAt`, `codePointAt` (`number | undefined`), `at`
(`string | undefined`, negative indices), `padEnd`, `startsWith` / `endsWith` (incl. the
position argument), `replace` / `replaceAll` (**string patterns only** — no `RegExp`; `$$`,
`$&`, ``$` ``, `$'` substitutions supported), `concat` (variadic), `lastIndexOf`, and
`split(sep, limit)`. These join the pre-existing `slice`/`substring`/`charAt`/`toUpperCase`/
`toLowerCase`/`trim`/`repeat`/`padStart`/`includes`/`indexOf`/`split`.

**Number methods** — **`toFixed(digits)`** (ECMAScript-exact: the double's exact decimal
expansion, rounded half-up on the magnitude, so `1.25 -> "1.3"` but `1.005 -> "1.00"`;
`|x| >= 1e21`, `NaN` and the infinities fall back to `ToString`), and **`toString(radix)`**
(a faithful port of V8's `DoubleToRadixCString`, so integers *and* fractions match node digit
for digit: `(0.1).toString(2)`, `(1/3).toString(3)`, `(2**60).toString(16)`, …). Both require a
**literal** argument in range (`0..100` / `2..36`), which makes node's `RangeError` unreachable
instead of emulated.

**Array methods** — `at` (`T | undefined`, negative indices), `lastIndexOf`, `concat`
(variadic), `flat()` (one level), and the predicate HOFs `some` / `every` / `find` /
`findIndex` / `findLast` / `findLastIndex` / `flatMap`, all with an **inline arrow** inlined
into the generated loop (the Stage-12 `map`/`filter`/`reduce` contract, including captures).
`find`/`findLast` return `T | undefined`; `findLast`/`findLastIndex` iterate **backwards**, so
even a side-effecting callback observes node's exact call order.

**Rejected on purpose** (arrays are immutable — Stage 29): `fill`, `sort`, `splice`, `shift`,
`unshift`, `copyWithin` all mutate in place in node, so each is refused with **`NT1606`**
naming the immutable replacement (`.with` / `.slice` + spread / `.map`), exactly like
`.push`/`.pop` (`.sort`'s hint names the ES2023 copying `.toSorted()`).

**ARITY follows TypeScript's lib, not node** (Stage 51). node accepts more than `lib.es5.d.ts`
declares, and the two disagree in both directions, so the rule is: **an arity `tsc` rejects is a
real user type error (`NT2001`); an arity `tsc` accepts must not be reported as one.** Refusing a
form tsc accepts is not merely rude — `coverage` counts only NT1xxx as feature blockers and treats
NT2xxx as a user error, so such a gap is invisible to the self-hosting gradient. Filled because tsc
accepts them: **`s.slice()` / `arr.slice()`** (both parameters optional; the zero-argument form is
the whole receiver, and `slice` is in `FRESH_ARRAY_CALLS` so `xs.slice().sort()` is legal),
**`s.lastIndexOf(search, position)`**, and **`arr.indexOf(x, fromIndex)` / `arr.lastIndexOf(x,
fromIndex)`**. The three `fromIndex`/`position` forms clamp *differently on purpose* (ES 22.1.3.11 /
23.1.3.17 / 23.1.3.20): absent means 0 forward but `len-1` backward, and a negative index that
underflows restarts at 0 for `indexOf` but gives up with -1 for `lastIndexOf`. Still `NT2001`
because tsc requires the argument even though node defaults it: **`s.substring()`**, **`s.charAt()`**,
**`s.at()`**, **`arr.at()`**.

**Still open in Batch 1's spirit** (deferred, each needs more than a fill): `Array.from` of an
array-*like* or with a `mapFn`, and `.flat(depth)` beyond one level (chain `.flat().flat()`).
*(`new Date()` + the date-component API landed in Batch 3; `String#normalize` is refused there,
`NT1024` — it needs the Unicode character database. Anything RegExp-shaped is still Tier C.)*

### Batch 2 — needs a bytes type first
`Uint8Array`/`ArrayBuffer` → then **`TextEncoder` / `TextDecoder`**, **`crypto.getRandomValues`**,
**`crypto.randomUUID`**, **`crypto.subtle.digest`** (SHA-256), **`Blob`**.

**Bytes ✅ (done).** `Uint8Array` (`new Uint8Array(n)` zero-filled / `new Uint8Array([..])` from a
number array with JS ToUint8 wrap; index read/**write** — a genuinely mutable typed array, unlike
our immutable `T[]`; `.length`; `for-of`) + `TextEncoder().encode(str)` / `TextDecoder().decode(u8)`
(UTF-8 round-trip — trivial since nativets strings are already UTF-8). Backed by `runtime/nt_bytes.c`
(compact 1-byte-per-element buffer, linked conditionally-on-usage like `nt_mapset`/`nt_http`). node is
the oracle for every op (`test/bytes.test.ts`). `console.log(u8)` was the one refusal here
(`NT1016`, for node's size-dependent column-grouped typed-array layout); **Stage 49 closed it** —
that layout is the array layout with the length in the opening brace, so a `Uint8Array` now prints
exactly like node (`Uint8Array(3) [ 1, 2, 3 ]`, grouped past six). Only `"%s"` of one is refused
(node prints `String(u8)`, the comma-joined bytes). **Deferred:** `ArrayBuffer`
/ `DataView`, other typed-array flavors, `.slice`/`.set`/`.subarray`, `crypto`, `Blob`. Bytes buffers
are on the allocate-and-never-free placeholder (not linear/RC yet — safe, may leak).

### Batch 3 ✅ DONE (except RegExp/timers) — the object-shaped web APIs

Batch 3 was deferred while nativets had no classes. Classes landed (SH3–SH3.6), so the
functional workarounds became the real API. `node` is the oracle for every case
(`test/stdlib-batch3.test.ts`, `test/stdlib-url.test.ts`) — with **no polyfill**, which is the
point: these fixtures are ordinary TypeScript that node runs as written. The exact surface:

**`Date`** — `new Date()` (the clock), `new Date(ms)` (ES `TimeClip`: truncate toward zero,
`|t| > 8.64e15` → Invalid Date), `new Date(isoString)`, plus `getTime`/`valueOf`,
`getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`/`getSeconds`/`getMilliseconds`/
`getDay`, the zone-independent **`getUTC*`** aliases of all eight, `toISOString`/`toJSON`, and
`console.log(date)` (node's `util.inspect` of a Date IS the ISO string). A `Date` VALUE is the
epoch-ms `double` itself — no allocation, no drop, and `Date[]` is a `number[]` in every way that
matters. `Date` works as a parameter/return/object-field type; `JSON.stringify` serializes it
through `toJSON` (quoted ISO, or `null` for an Invalid Date), and `structuredClone` copies it.

> **TIMEZONE (the decision, in full in `docs/divergences.md`): local time is REALLY local.** The
> runtime uses `localtime_r`/`mktime`, which read the same IANA zone node's ICU reads, so
> `getHours()` matches node on the same machine — DST transitions and half-hour zones included.
> To keep the tests deterministic the local-time cases pin **`TZ` on both sides** (`UTC`,
> `America/New_York`, `Asia/Kolkata`). `toISOString` and `getUTC*` are zone-independent by
> specification, via pure civil-calendar arithmetic (no `time_t`, so the full ±8.64e15 ms range
> works, incl. `+275760-09-13T00:00:00.000Z`). `new Date()` itself is a clock read, so — like
> `Date.now()` in Batch 1 — it is tested behaviorally, never against node.

**`URL`** — `new URL(u)` with `.protocol`/`.host`/`.hostname`/`.port`/`.pathname`/`.search`/
`.hash`/`.origin`/`.searchParams`, over the same absolute-`http(s)` subset the Batch-1 functional
accessors had (default ports dropped, hostname lowercased, userinfo stripped). A URL outside the
subset **throws catchably**, like node's `TypeError: Invalid URL` — the obligation a class has
that loose functions did not. **The old functional entry points (`urlProtocol(u)`, …) are
REMOVED**, along with the `URL_POLYFILL` oracle in `test/harness.ts`; `test/stdlib-url/*.ts` were
migrated to `new URL(...)` and are now differential against plain `node`.

**`URLSearchParams`** — `new URLSearchParams(query)` (with or without the leading `?`) and
`url.searchParams`, then `.get(k)` (`string | null`, node's exact shape, so `?? "…"` composes),
`.has(k)`, `.getAll(k)` (`string[]`), `.toString()` (re-serialized, `+`/`%XX` normalized).
Read-only: `.append`/`.set`/`.delete`/`.sort` mutate, so they are refused.

**`Object.freeze` / `isFrozen` / `getOwnPropertyNames`** — `freeze` is the **identity** and
honestly so: objects are already immutable (Stage 29), so freezing changes nothing and node's
contract (same object back, non-writable) is met exactly; `isFrozen` is constant-`true`;
`getOwnPropertyNames` == `Object.keys` for a plain record. `Object.assign`/`defineProperty`/
`setPrototypeOf` MUTATE their target → **`NT1606`** pointing at object spread.

**`encodeURIComponent` / `decodeURIComponent` / `encodeURI` / `decodeURI`** — byte-exact per
ECMAScript §19.2 (uppercase hex, the two different "unescaped" sets, `decodeURI` preserving the
reserved escapes). nativets strings are already UTF-8, so the spec's UTF-16→UTF-8 step is the
identity and node's lone-surrogate `URIError` is unreachable; a malformed `%` sequence throws
catchably, like node's `URIError: URI malformed`.

**Refused on purpose (`NT1024`, the new web-API code)** — nothing here is approximated:
`String#normalize` (needs the Unicode character database), `String#localeCompare` /
`toLocale*` (needs ICU collation), `Date#setX` (a Date is an immutable time value → build a new
one), `Date#toString`/`toLocaleDateString` and `"" + date` (locale + zone-display-name tables),
`new Date(y, m, d, …)`, `new URL(relative, base)` (URL resolution), `URL#href`/`toString` (the
WHATWG serializer, which normalizes), and `console.log(url)`.

**Still Tier C, untouched by this batch:** **`RegExp`** (a regex engine — its own initiative) and
**`setTimeout`/timers**/streams. ~~`fetch`~~ ✅ and ~~`Promise`/`async`~~ ✅ (decided) — see below.

### `fetch` ✅ (done, host-only) + the async decision

**The async fork is resolved: no event loop, no promises.** `async` is **erased** and `await` is an
**identity pass-through** over an already-resolved value; `fetch` is a **blocking** call. The payoff
is large — ordinary idiomatic source (`const res = await fetch(url); const body = await res.text();`)
compiles under nativets **and runs unchanged under `node`**, so node stays the byte-for-byte oracle
for networking (`test/fetch.test.ts` runs the same `.ts` under both, against a local
`http.createServer` mock; never the real internet). The cost is that **there is no concurrency**:
`await` never yields, so overlapping/parallel requests are **rejected with `NT1020`** —
`Promise.all`/`Promise.*`/`new Promise`, `.then`/`.catch`/`.finally`, and un-awaited `async` results
— pointing at the **actor** model (`spawn`/`send`/`receive`) as nativets' concurrency primitive.
Never silently serialized-but-claimed-parallel, never miscompiled. `Promise<T>` in type position
erases to `T`.

**Surface:** `fetch(url)` / `fetch(url, { method, headers, body })` → `Response`, with `.status`,
`.ok` (2xx), `.headers`, `await res.text()`, `await res.json()` (→ `Dyn`, so `as T` runs the
Stage-20 generated validator), and `Headers#get(name)` (case-insensitive, `string | null`) /
`#has(name)`. A transport failure **throws catchably** (node's fetch rejects); a non-2xx is a normal
Response. Backed by `runtime/nt_http.c` (libcurl) beside the existing `httpGet`/`httpPost`
primitives, linked **only when used** — so non-fetch programs and every cross-build stay curl-free.
**Host (macOS/Linux) only**: iOS/Android need the platform HTTP stack (NSURLSession/OkHttp).
**Deferred:** streams/`res.body`, `blob`/`arrayBuffer`/`formData`, `AbortController`/timeouts,
`statusText`, header iteration, constructing `Request`/`Response`/`Headers` values. Example app:
`examples/fetch-json.ts` (fetch → headers → validate with `as T` → summary).

## Testing

Every Tier-A/B API gets `node`-differential fixtures (node is the oracle) plus curated `.expected`.
Encoding APIs (base64, TextEncoder) note the UTF-8-byte vs UTF-16 divergence already tracked in
`docs/divergences.md`. Tier-C APIs that node can't mirror deterministically (timers, network) use
behavioral tests / local mocks, like the actor and HTTP lanes.

## Order

1. ~~**Batch 1**~~ ✅ **done** — immediate ergonomic wins, all node-oracle-matched.
2. ~~**Bytes type** → Batch 2~~ ✅ **done** for `Uint8Array` + `TextEncoder`/`TextDecoder`;
   `crypto` / `Blob` / `ArrayBuffer` still open.
3. ~~**Batch 3** — `Date`, `URL`/`URLSearchParams`, `Object.freeze`, URI encoding~~ ✅ **done**
   (classes unblocked it).
4. **The prelude → real `std/*` modules** — unblocked: self-hosting **SH1** (a real
   `import`/`export` module system) has landed.
5. Remaining Tier-C initiatives: **`RegExp`** (a regex engine) and **timers/streams**.

> **`RegExp` is NOT on the self-hosting path — measured, Stage 51.** It is tempting to pair "stdlib
> helpers" with "and a regex engine", so the measurement is recorded here to stop the next lane
> re-deciding it from intuition. `src/` contains **zero** regex literals, deliberately and
> permanently: `test/no-regex.test.ts` is a ratchet (a module that reaches zero is *deleted* from
> its table, so a cleared module cannot take one back) and its premise is that a compiler which
> cannot compile itself because of a construct it refuses on principle will never self-host. The
> compiler scans characters instead, and the equivalence of every rewritten class is pinned over
> all 65,536 BMP code points. So an engine is pure surface growth against the "keeping the gap from
> growing" rule in `docs/self-hosting.md`: a large new compiler+runtime subsystem that must itself
> stay inside the self-hostable subset, buying the frontier nothing. It remains a legitimate
> *user-facing* feature — just never justify it as self-hosting work, and never let it into `src/`.
