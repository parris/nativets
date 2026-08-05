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
  - **`fetch` / `Headers` / `Request` / `Response`** → the networking tier (sockets + TLS; the
    HTTP-client lane is the seed).
  - **`Promise` / `async` / `await`** → an **event loop** — *or* a decision to expose async via the
    **actor** model instead (nativets already has BEAM-style actors; promises may be the wrong
    primitive for this language). A real fork to decide.
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

### Batch 3 — needs new infrastructure (Tier C)
**`URL` / `URLSearchParams`** (string-based, actually tractable soon), **`fetch`** (networking),
**`RegExp`** (regex engine), **`Promise`/`async`** (event loop vs actors — decide), **`setTimeout`**
(timers), streams.

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
