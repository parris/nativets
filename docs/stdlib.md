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
  "prelude"). This is the delivery vehicle for composed helpers **until the module system exists**
  (self-hosting **SH1** adds real `import`/bundling); at SH1 the prelude becomes proper
  `import`ed `std/*` modules. Writing the stdlib in nativets is the ultimate dogfood — it also
  drives the language toward self-hosting.
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

### Batch 1 — tractable now (Tier A/B, no new infra), high value
- **`Date.now(): number`** (ms since epoch, via `time`/`clock_gettime`). *(`new Date()` object +
  methods want classes — defer, or expose a functional date API.)*
- **`btoa` / `atob`** — base64 encode/decode (pure byte ops).
- **`String.fromCharCode` / `fromCodePoint`, `codePointAt`, `at`, `padEnd`, `replaceAll`,
  `startsWith` / `endsWith`** — fill the obvious string gaps (`fromCharCode` also retires the TUI
  lane's `\xHH` workaround).
- **`Object.entries` / `Object.values` / `Object.fromEntries`** — compile-time-known keys, like the
  existing `Object.keys`.
- **`Array.isArray`, `Array.from`, `Array.of`, `Array#at` / `flat` / `flatMap` / `find` / `some` /
  `every`** — the common array surface (HOFs already exist for `map`/`filter`/`reduce`).
- **`Number.isInteger` / `isFinite` / `isSafeInteger` / `isNaN`, `Number.parseInt`/`parseFloat`.**
- **`structuredClone`** — a type-directed deep copy (reuse the `JSON.stringify` walk shape).

### Batch 2 — needs a bytes type first
`Uint8Array`/`ArrayBuffer` → then **`TextEncoder` / `TextDecoder`**, **`crypto.getRandomValues`**,
**`crypto.randomUUID`**, **`crypto.subtle.digest`** (SHA-256), **`Blob`**.

**Bytes ✅ (done).** `Uint8Array` (`new Uint8Array(n)` zero-filled / `new Uint8Array([..])` from a
number array with JS ToUint8 wrap; index read/**write** — a genuinely mutable typed array, unlike
our immutable `T[]`; `.length`; `for-of`) + `TextEncoder().encode(str)` / `TextDecoder().decode(u8)`
(UTF-8 round-trip — trivial since nativets strings are already UTF-8). Backed by `runtime/nt_bytes.c`
(compact 1-byte-per-element buffer, linked conditionally-on-usage like `nt_mapset`/`nt_http`). node is
the oracle for every op (`test/bytes.test.ts`). **Divergence:** `console.log(u8)` is rejected
(`NT1016`), not printed — node's size-dependent, column-grouped typed-array layout (7+ elements →
multi-line) isn't cheap to match byte-for-byte, so reject-don't-miscompile. **Deferred:** `ArrayBuffer`
/ `DataView`, other typed-array flavors, `.slice`/`.set`/`.subarray`, `crypto`, `Blob`. Bytes buffers
are on the allocate-and-never-free placeholder (not linear/RC yet — safe, may leak).

### Batch 3 — needs new infrastructure (Tier C)
**`URL` / `URLSearchParams`** (string-based, actually tractable soon), ~~**`fetch`**~~ ✅,
**`RegExp`** (regex engine), ~~**`Promise`/`async`** (event loop vs actors — decide)~~ ✅ decided,
**`setTimeout`** (timers), streams.

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

1. **Batch 1** (this track's first tranche) — immediate ergonomic wins, all node-oracle-matched.
2. **Bytes type** → Batch 2 (encoding + crypto).
3. **The prelude → real `std/*` modules at self-hosting SH1.**
4. Tier-C initiatives (networking, event-loop/async decision, regex) as they mature.
