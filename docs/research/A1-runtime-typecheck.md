# A1 — Dynamic value + runtime typechecking: behavior spec (red-green test vectors)

Source distillation of the **zod** (`colinhacks/zod`, `src/__tests__/*`) and **io-ts**
(`gcanti/io-ts`, `test/*`) suites, constrained to nativets' type subset
(`number | boolean | string`, arrays, flat+nested objects, nullable only). Drives Phase **A1**
(see `docs/ROADMAP.md`): `JSON.parse(s): Dyn`, then narrow `Dyn → T` via `x as T` (or
`parseAs<T>`/`check<T>`) — a runtime validator generated from `T`'s static shape that throws a
typed error on mismatch and hands back a statically-`T` value.

---

## The oracle caveat (read first — this changes the test methodology)

`x as T` is **erased by tsc/node** — node performs **zero** runtime validation. So:

- **Success paths stay node-oracle-matched.** Valid JSON + `as T` + read a field: node and
  nativets print the same bytes. These are ordinary differential fixtures.
- **Failure paths are a *deliberate divergence*** (document in `docs/divergences.md`): where
  nativets' validator **throws**, node's erased `as` silently yields `undefined`/`NaN`/garbage.
  These cannot be gated by the node oracle; they are specified **by fiat** (io-ts/zod semantics)
  and verified rustc-`compiletest`-style ("this program must throw `TypeError` with this message on
  this line"), exactly like `test/ownership/`. For each failure case below I give **both** node's
  erased-`as` output *and* the required nativets throw.
- **JSON *syntax* errors are NOT a divergence** — `JSON.parse` throws `SyntaxError` under node too,
  so those stay oracle-matched (behavior 0).

Recommendation: land a `//~ THROWS TypeError` corpus under `test/typecheck/` (mirroring
`test/ownership/`) for the failure vectors, plus normal `test/fixtures/typecheck/` differential
cases for every success vector.

**Error surface.** The validator throws a JS-shaped `TypeError` whose `.message` follows a fixed
template so cases can assert it:
`expected <type> at <path>, got <actualtag>` (path is `$` for root, `$.field`, `$.a.b`, `$[2]`,
`$[1].y`; `<actualtag>` ∈ `number|boolean|string|null|array|object`). Match io-ts/zod, which both
report a **dot/-index path** to the offending node.

**Compile-time vs runtime split.**
- A validator throw is a **runtime** event (a native `TypeError`), *not* an `NT####` diagnostic.
- Compile-time `NT####` rejects apply to *unsupported narrowings* and *un-narrowed Dyn use*
  (behaviors 22–24): `NT2xxx` type errors, `NT16xx` if it interacts with ownership.

---

## Type fixtures used below

```ts
type Point  = { x: number; y: number };
type Circle = { center: Point; r: number };
type User   = { name: string; age: number; admin: boolean };
```

---

## Ordered behaviors (simplest → hardest)

### 0. Invalid JSON → SyntaxError (oracle-matched, not a divergence)
```ts
const d = JSON.parse("{bad json");
console.log("unreached");
```
- **node:** throws `SyntaxError`, exit ≠ 0, prints nothing to stdout. **nativets:** identical
  (runtime JSON parser rejects, throws `SyntaxError`). ✅ differential-matched.
- Diagnostic: runtime throw (`SyntaxError`); no `NT####`.

---

### 1. Primitive `number` — success
```ts
const d = JSON.parse("5");
const n = d as number;
console.log(n);           // 5
```
- **node & nativets:** `5`. ✅ oracle-matched. Validator: assert `tag == number`, unbox to `double`.

### 2. Primitive `number` — failure (string payload)
```ts
const d = JSON.parse("\"hi\"");
const n = d as number;
console.log(n);
```
- **node (erased `as`):** `hi`. **nativets (required):** throw `TypeError: expected number at $, got string`. ⚠️ divergence.

### 3. Primitive `string` — success / failure
```ts
const s = JSON.parse("\"ok\"") as string;   console.log(s);   // "ok"  ✅ matched
const s2 = JSON.parse("5") as string;                          // node: prints nothing meaningful; nativets THROWS
console.log(s2);
```
- success → `ok`. failure → `TypeError: expected string at $, got number`. ⚠️ divergence on the failure form.

### 4. Primitive `boolean` — success / failure
```ts
const b = JSON.parse("true") as boolean;  console.log(b);   // true  ✅
const b2 = JSON.parse("1") as boolean;     console.log(b2);  // nativets THROWS: expected boolean at $, got number
```
- **Danger zone (zod-emphasized):** `1`/`0` must **not** coerce to boolean; `"true"` (string) must
  **not** coerce either. No truthiness coercion in a validator — exact tag match only.

### 5. `null` payload vs a primitive type — failure
```ts
const n = JSON.parse("null") as number;   // nativets THROWS: expected number at $, got null
console.log(n);
```
- **node (erased):** `null`. **nativets:** throw. `null` is a *present value* with its own tag, not
  "missing" — keep it distinct from absent (see optional/nullable, 18–20). ⚠️ divergence.

---

### 6. Object shape — success
```ts
const d = JSON.parse("{\"x\":1,\"y\":2}");
const p = d as Point;
console.log(p.x + p.y);     // 3
```
- **node & nativets:** `3`. ✅ oracle-matched. Validator walks `{x:number, y:number}` slot-by-slot.

### 7. Object — missing required field → failure
```ts
const d = JSON.parse("{\"x\":1}");
const p = d as Point;
console.log(p.y);
```
- **node (erased):** `undefined`. **nativets:** throw `TypeError: expected number at $.y, got undefined`
  (key absent). ⚠️ divergence. (zod `object.test.ts` "incorrect #1": `Test.parse({})` throws.)

### 8. Object — wrong-typed field → failure
```ts
const d = JSON.parse("{\"x\":\"nope\",\"y\":2}");
const p = d as Point;
console.log(p.x);
```
- **node (erased):** `nope`. **nativets:** throw `TypeError: expected number at $.x, got string`.
  ⚠️ divergence. Path points at the offending field (io-ts context path / zod `error.issues[].path`).

### 9. Object — extra/unknown keys are IGNORED → success (danger zone)
```ts
const d = JSON.parse("{\"x\":1,\"y\":2,\"z\":99}");
const p = d as Point;
console.log(p.x + p.y);     // 3
```
- **node & nativets:** `3`. ✅ matched — validator reads only declared slots, ignores `z`. This is
  zod's **default (`strip`)** and io-ts `t.type` behavior. (Note: zod's opt-in `.strict()` would
  *reject* extra keys; nativets adopts strip-by-default, no strict mode planned — cite in
  `divergences.md`.)

### 10. Object — first field valid, second wrong (path is stable, checks all fields)
```ts
const d = JSON.parse("{\"x\":1,\"y\":true}");
const p = d as Point;
console.log(p.y);
```
- **nativets:** throw `expected number at $.y, got boolean`. Confirms per-field walk, not just field 0.

---

### 11. Nested object — success
```ts
const d = JSON.parse("{\"center\":{\"x\":0,\"y\":0},\"r\":5}");
const c = d as Circle;
console.log(c.center.x + c.r);   // 5
```
- **node & nativets:** `5`. ✅ oracle-matched. Recurse into `center: Point`.

### 12. Nested object — bad inner field → failure with nested path
```ts
const d = JSON.parse("{\"center\":{\"x\":0,\"y\":\"no\"},\"r\":5}");
const c = d as Circle;
console.log(c.center.y);
```
- **nativets:** throw `expected number at $.center.y, got string`. ⚠️ divergence. Nested dot-path
  is the io-ts/zod hallmark.

### 13. Nested object — inner object entirely missing → failure
```ts
const d = JSON.parse("{\"r\":5}");
const c = d as Circle;
console.log(c.center.x);
```
- **nativets:** throw `expected object at $.center, got undefined`. (Missing sub-object reported at
  the object node, before descending.)

### 14. Wrong *kind* at root: object type but array payload (or vice versa)
```ts
const d = JSON.parse("[1,2]");
const p = d as Point;
console.log(p.x);
```
- **nativets:** throw `expected object at $, got array`. Symmetric: `{...} as number[]` →
  `expected array at $, got object`. Danger zone — arrays are objects in JS; the validator must
  distinguish by tag, not `typeof`.

---

### 15. Array-of-`number` — success
```ts
const d = JSON.parse("[1,2,3]");
const a = d as number[];
console.log(a.length, a[2]);   // 3 3
```
- **node & nativets:** `3 3`. ✅ oracle-matched. Validate `tag==array` then each element.

### 16. Array-of-`number` — one bad element → failure with index path
```ts
const d = JSON.parse("[1,2,\"x\",4]");
const a = d as number[];
console.log(a[0]);
```
- **node (erased):** `1`. **nativets:** throw `expected number at $[2], got string`. ⚠️ divergence.
  (zod array test: reports the failing element index in the path.)

### 17. Empty array — success (vacuous)
```ts
const a = JSON.parse("[]") as number[];
console.log(a.length);   // 0
```
- **node & nativets:** `0`. ✅ matched. Empty array validates against `T[]` for any `T` (no elements
  to fail). Danger zone: `[]` must **not** be confused with a missing/`null` value.

### 18. Array-of-object — success and bad-element-field → failure
```ts
const ok  = JSON.parse("[{\"x\":1,\"y\":2},{\"x\":3,\"y\":4}]") as Point[];
console.log(ok[1].y);                                   // 4  ✅ matched
const bad = JSON.parse("[{\"x\":1,\"y\":2},{\"x\":3}]") as Point[];   // nativets THROWS
console.log(bad[1].y);
```
- failure → throw `expected number at $[1].y, got undefined`. ⚠️ divergence. Combines index + field
  path — the deepest common case in both suites.

### 19. Nested arrays `number[][]` — success / failure
```ts
const g  = JSON.parse("[[1,2],[3,4]]") as number[][];  console.log(g[1][0]);   // 3  ✅
const g2 = JSON.parse("[[1,2],[3,\"x\"]]") as number[][];                        // THROWS
console.log(g2[0][0]);
```
- failure → `expected number at $[1][1], got string`. ⚠️ divergence.

---

### 20. Optional field **absent** → success  *(depends on A2's optional type `{ a?: T }`)*
```ts
type Opt = { name: string; nick?: string };
const d = JSON.parse("{\"name\":\"a\"}");
const o = d as Opt;
console.log(o.name);   // a
```
- **node & nativets:** `a`. ✅ matched. Absent optional key is allowed; result field is `undefined`.
  (zod `object.test.ts` "optional keys are unset" — absent optionals omitted / undefined.)

### 21. Optional field **present & well-typed** → success; present & wrong-typed → failure
```ts
const o1 = JSON.parse("{\"name\":\"a\",\"nick\":\"x\"}") as Opt; console.log(o1.nick); // x ✅
const o2 = JSON.parse("{\"name\":\"a\",\"nick\":5}")   as Opt;                          // THROWS
console.log(o2.nick);
```
- failure → `expected string at $.nick, got number`. Optional means *absent-or-T*, **not** *any type*.

### 22. **null vs undefined** — the headline zod danger zone  *(A2)*
```ts
// optional (T | undefined): null is NOT allowed
const a = JSON.parse("{\"name\":\"a\",\"nick\":null}") as { name: string; nick?: string };
// nativets THROWS: expected string at $.nick, got null
```
```ts
// nullable (T | null): null IS allowed, absent is NOT
type NN = { name: string; nick: string | null };
const b = JSON.parse("{\"name\":\"a\",\"nick\":null}") as NN;   console.log(b.nick);   // null ✅
const c = JSON.parse("{\"name\":\"a\"}")               as NN;   // nativets THROWS: expected string|null at $.nick, got undefined
```
- The distinction zod's tests hammer: `optional` ⇄ `undefined`/absent; `nullable` ⇄ `null`;
  they are **not** interchangeable. JSON can only produce `null` (never `undefined`), so `null`
  arrives as a real payload and absence arrives as a missing key — the validator must treat them
  separately. Composes with `??` (already static in nativets; extend to nullable operands per A2).

---

## Danger-zone notes (zod/io-ts emphasize; several are N/A for our subset — record why)

- **NaN / Infinity:** zod `z.number()` **rejects NaN**, **accepts ±Infinity**; `.finite()` rejects
  Infinity. **N/A as an input**: JSON has no `NaN`/`Infinity` literal, so `JSON.parse` can never
  produce them — the validator never sees them. (Only relevant if we later validate computed
  values; then match zod: reject NaN.) No enforcement needed for A1.
- **integer vs float:** zod distinguishes `z.number()` (any) from `.int()` (rejects `3.14`); io-ts
  has branded `t.Int`. **N/A**: nativets `number` is one IEEE-754 `double` type — `1` and `1.5` are
  both `number`; there is no `int` type to enforce. Note in `divergences.md` (no `.int()` surface).
- **extra keys:** default **strip/ignore** (behavior 9). No `.strict()` reject mode planned.
- **`0` / `false` / `""` are valid, not "missing":** a validator must accept falsy-but-well-typed
  values; only an absent key or wrong tag fails. (Common zod regression — falsy ≠ absent.)
- **`null` is a value, not absence** (behaviors 5, 22).
- **arrays are not plain objects** (behavior 14) — tag-based, never `typeof`.
- **empty array / empty object** validate vacuously (behavior 17); don't special-case as invalid.

---

## Compile-time rejects (`NT####`, not runtime throws)

### 23. Reading a `Dyn` field/element without narrowing → reject (or runtime tag check)
```ts
const d = JSON.parse("{\"x\":1}");
console.log(d.x);      // no `as T`
```
- Per ROADMAP A1: either **reject at compile time** — `NT2xxx` "cannot access field on dynamic value
  `Dyn`; narrow with `as T` first" — or fall back to a per-access **runtime tag check**. Recommend
  the reject (forces the io-ts/zod discipline: validate once at the boundary).

### 24. `as T` to an unsupported narrowing target → reject
```ts
const d = JSON.parse("5");
const x = d as (n: number) => number;   // function type — not validatable from JSON
```
- **nativets:** `NT2xxx` "cannot validate dynamic value against type `<T>`" for any `T` outside the
  validatable subset (functions, non-nullable unions, etc.). Reject-don't-miscompile, surfaced by
  `coverage`.

### 25. Ownership interaction (Dyn/validated value is a heap value)
- The validated result is a heap object/array → it enters the **linear ownership** model
  (`src/ownership.ts`). A validator that returns an owned array/object must be move/drop-tracked;
  mis-narrowing that leaks or double-drops is an `NT16xx`. (Cross-check with Phase C; Dyn boxes
  themselves currently follow the never-free placeholder like strings/objects.)

---

## Suggested implementation order of the vectors (RED list for the stage)

1. Primitives success+failure (1–5) — smallest validator, exercises tag box + throw path.
2. Flat object success, missing, wrong-typed, extra-keys-ignored (6–10).
3. Nested object (11–13) + wrong-kind-at-root (14).
4. Arrays of primitive (15–17), arrays of object, nested arrays (18–19).
5. Optional/nullable (20–22) — gated behind **A2**; also closes `optional-chaining`.
6. Compile-time rejects (23–25).
7. Wire `json-roundtrip` (the actual gap corpus case) as the capstone differential fixture.

Sources: zod `src/__tests__/{object,number,nan}.test.ts` (colinhacks/zod, v3); io-ts codec/context
model (gcanti/io-ts). Behaviors distilled and constrained to nativets' subset.
