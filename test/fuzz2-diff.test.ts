/*
 * Findings from the SECOND node-differential fuzz lane (`fuzz2`), covering the areas the
 * first sweep did not reach: Date, JSON round-trips, Map/Set at scale, actors, structured
 * cloning, generics, classes, destructuring, spread, template literals, for-in/for-of,
 * sorting and typed arrays.
 *
 * Two kinds of finding live here.
 *
 * 1. SILENT WRONG ANSWERS (`describe("… — wrong answers")`) — nativets compiles the program,
 *    runs it to exit 0, and prints a value node does not print. Compared on RAW BYTES and the
 *    exit code, never on decoded text.
 *
 * 2. UNBOUNDED LEAKS (`describe("… — leaks")`) — the live-object / live-array counter after
 *    the work is proportional to the AMOUNT of work, so the residue grows without bound.
 *    Each is measured at TWO scales inside one program and the two residues compared: a
 *    constant residue is fine (conservative over-retention), a residue that scales with the
 *    loop count is a leak. LeakSanitizer is Linux-only, so these are invisible on macOS and
 *    the counters are the only instrument that sees them.
 *
 * Everything here is expected to FAIL until fixed, so each case is `.failing`; flipping one
 * to a plain `it` is how a fix is proven.
 */
import { describe, it, expect } from "bun:test";

import { ourRun, nodeRun, isRefusal, isUtf8 } from "./fzq-fuzz.ts";

/** Run both sides and assert byte-for-byte stdout equality plus equal exit codes. */
async function expectSameBytes(source: string): Promise<void> {
  const oracle = nodeRun(source);
  const ours = await ourRun(source);
  if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
  expect({ utf8: isUtf8(ours.stdout) }).toEqual({ utf8: isUtf8(oracle.stdout) });
  expect(ours.stdout.toString("latin1")).toBe(oracle.stdout.toString("latin1"));
  expect(Buffer.compare(ours.stdout, oracle.stdout)).toBe(0);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/**
 * Run `body` 50 times and 500 times inside one program and report the live-counter residue
 * of each round. A leak-free `body` leaves the SAME residue at both scales.
 */
async function expectResidueDoesNotScale(body: string, prelude = ""): Promise<void> {
  const source = `${prelude}
function nt2round(n: number): void {
  for (let i = 0; i < n; i++) { ${body} }
}
const o0 = __objLive(); const s0 = __strLive(); const a0 = __arrLive();
nt2round(50);
const o1 = __objLive(); const s1 = __strLive(); const a1 = __arrLive();
nt2round(500);
const o2 = __objLive(); const s2 = __strLive(); const a2 = __arrLive();
console.log("obj " + (o1 - o0) + " " + (o2 - o1));
console.log("str " + (s1 - s0) + " " + (s2 - s1));
console.log("arr " + (a1 - a0) + " " + (a2 - a1));
`;
  const ours = await ourRun(source);
  if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
  expect(ours.exitCode).toBe(0);
  const rows = ours.stdout.toString("utf8").trim().split("\n").map((l) => {
    const [what, small, big] = l.split(" ");
    return { what: what!, small: Number(small), big: Number(big) };
  });
  // 10x the work must not mean 10x the residue.
  for (const r of rows) expect({ [r.what]: r.big }).toEqual({ [r.what]: r.small });
}

describe("fuzz2 findings — wrong answers", () => {
  /*
   * `new Date(v)` is `TimeClip(ToNumber(v))`, and TimeClip runs the value through
   * ToIntegerOrInfinity, which maps -0 to +0 (ECMA-262 21.4.1.15). So node's time value for
   * `new Date(-0)` is POSITIVE zero. nativets truncates toward zero but keeps the sign, so
   * the stored time value is -0 and every reader of it sees a negative zero.
   *
   * This is a real value difference, not a printing one: `1 / d.getTime()` is `-Infinity`
   * here and `Infinity` in node. `-0.5` and `-0.9` land on it too — anything in (-1, 0].
   * `String()` and `toISOString()` both hide it, which is why it survived: only a direct
   * `console.log` (util.inspect prints `-0`) or a division exposes the sign.
   *
   * FIXED — `nt_time_clip` (runtime/runtime.c) finishes with `+ 0.0`, which IEEE-754
   * round-to-nearest turns into exactly the `-0 → +0` step ToIntegerOrInfinity specifies
   * and leaves every other double (NaN included) untouched. Owned with the rest of the
   * TimeClip rows in test/stdlib-batch3.test.ts.
   */
  it("new Date(-0) clips to +0, so getTime() is 0 and not -0", async () => {
    await expectSameBytes([
      "console.log(new Date(-0).getTime());",     // node 0, ours -0
      "console.log(new Date(-0.5).getTime());",   // node 0, ours -0
      "console.log(new Date(-0.9).getTime());",   // node 0, ours -0
      "console.log(1 / new Date(-0).getTime());", // node Infinity, ours -Infinity
      "console.log(new Date(-1.5).getTime());",   // node -1, ours -1 — truncation itself is right
      "",
    ].join("\n"));
  });

  /*
   * `+d` is ToNumber of a Date, which is `ToPrimitive(d, number)` → `d.valueOf()` → the time
   * value. nativets answers NaN for EVERY Date, in range or out, named or temporary — while
   * `d.valueOf()` and `d.getTime()` spelled out are both correct. `+new Date()` is the
   * ordinary JS idiom for "now, as a number", so this is not an exotic corner.
   *
   * Note the asymmetry that let it through: unary `-` on a Date is REFUSED (`NT2001`,
   * "Unary '-' needs number, got Date"). One door is guarded, its sibling silently answers
   * NaN — the exact shape the prime directive rules out.
   *
   * FIXED — `coerceToNumber` (src/codegen.ts) has a Date case: a Date IS its time value
   * here, and `ToPrimitive(d, number)` runs `valueOf` first, so the coercion is the
   * identity. `%d` in console.log already applied that rule, which is the evidence the
   * missing one was an oversight.
   *
   * The asymmetry is NOT closed, deliberately: `-date` is still `NT2001`. `-x` is ToNumber
   * then negate, so routing it through the same `checkNumberCoercion` would be two lines —
   * but that also moves every OTHER `-` refusal from `NT2001` to `NT1039`, which is a
   * scope this lane was not asked to widen. It leaves a REFUSAL rather than a wrong
   * answer, so it breaks no rule; it is noted in docs/divergences.md so the next lane on
   * `-` inherits the reason rather than rediscovering it.
   *
   * Owned with the rest of the numeric coercions in test/number-coercion.test.ts.
   */
  it("unary + on a Date is its time value", async () => {
    await expectSameBytes([
      "console.log(+new Date(0));",     // node 0,     ours NaN
      "console.log(+new Date(1000));",  // node 1000,  ours NaN
      "console.log(+new Date(-1000));", // node -1000, ours NaN
      "const d = new Date(1000);",
      "console.log(+d);",               // node 1000,  ours NaN — a NAMED Date too
      "console.log(+d + 1);",           // node 1001,  ours NaN
      "console.log(d.valueOf());",      // node 1000,  ours 1000 — the spelled-out form is right
      "console.log(d.getTime());",      // node 1000,  ours 1000
      "",
    ].join("\n"));
  });

  /*
   * The Date row above is one case of a wider rule: ToNumber answers NaN for every operand
   * that is not already a number, a string or a boolean — where node has a DEFINED coercion
   * for each. `Number()` and unary `+` share the fault, so neither spelling escapes it.
   *
   *   +[]     node 0     ours NaN     (ToPrimitive([]) is "", ToNumber("") is 0)
   *   +[1]    node 1     ours NaN     (a one-element array joins to "1")
   *   +null   node 0     ours NaN
   *   +date   node <t>   ours NaN
   *
   * `+[1,2]` really is NaN and `+"  12  "` really is 12, and both agree — so the number and
   * string paths are right and it is only the non-primitive ones that fall through.
   *
   * FIXED, with the boundary decided rather than guessed. ToNumber of a non-primitive is
   * `ToPrimitive(x, number)` = `valueOf` then `toString`, and an ordinary object's
   * `valueOf` returns the object — so ToNumber IS StringToNumber of the value's STRING
   * form, and a value coerces to a number exactly when it coerces to a string.
   * `checkNumberCoercion` therefore DELEGATES to `checkStringCoercion`'s allow-list (the
   * primitives, a nullable box, a `number[]`/`string[]`/`boolean[]`) and adds Date, the
   * one type whose two hints diverge. Everything else — an object, a Map/Set, a class
   * instance, a Uint8Array, a `Dyn` — is refused as NT1039 rather than answered NaN, for
   * the reason NT1032 refuses their string forms: node calls a `valueOf`/`toString` this
   * compiler has no prototype chain to see, so the constant is only right for the programs
   * that did not define one. Owned by test/number-coercion.test.ts.
   */
  it("Number()/unary + coerce every non-primitive node can coerce", async () => {
    await expectSameBytes([
      "const e: number[] = [];",
      "console.log(+e);",              // node 0, ours NaN
      "console.log(Number(e));",       // node 0, ours NaN
      "const n: number | null = null;",
      "console.log(+n);",              // node 0, ours NaN
      "console.log(Number(n));",       // node 0, ours NaN
      "const one = [1];",
      "console.log(+one);",            // node 1, ours NaN
      "console.log(Number(one));",     // node 1, ours NaN
      "const two = [1, 2];",
      "console.log(+two);",            // node NaN, ours NaN — agrees
      'console.log(+"  12  ");',       // node 12,  ours 12  — agrees
      "",
    ].join("\n"));
  });

  /*
   * `Date.prototype.toJSON` is NOT `toISOString`: ECMA-262 21.4.4.37 takes the primitive
   * first and RETURNS null when it is a non-finite Number, so an Invalid Date serialises as
   * `null` and never throws. nativets routes `toJSON` through `toISOString` and throws
   * `RangeError: Invalid time value`, which goes uncaught — exit 1 with EMPTY stdout where
   * node prints `null` and carries on.
   *
   * `JSON.stringify(invalidDate)` is already correct (`null`), so this is the direct
   * `.toJSON()` call only — which is what makes it easy to miss.
   *
   * FIXED — `toJSON` no longer shares `toISOString`'s line. Its result type is now
   * `string | null`, node-exactly, so `?? "…"` and `=== null` compose; the fallible ISO
   * call moved behind a branch so it is only evaluated on the finite side. Owned with the
   * rest of the Date rows in test/stdlib-batch3.test.ts.
   */
  it("Date#toJSON of an Invalid Date returns null, it does not throw", async () => {
    await expectSameBytes([
      "console.log(new Date(NaN).toJSON());",              // node null, ours: throws
      "console.log(new Date(8640000000000001).toJSON());", // node null, ours: throws
      "console.log(new Date(0).toJSON());",                // node the ISO string
      'console.log("still here");',
      "",
    ].join("\n"));
  });
});

describe("fuzz2 findings — invalid IR", () => {
  /*
   * `d1 === d2` between two Dates emits a call to `js_str_eq(ptr, ptr)` with the Date's
   * `double` in the first slot, so the module does not verify:
   *
   *   error: '%t2' defined with type 'double' but expected 'ptr'
   *     %t5 = call i32 @js_str_eq(ptr %t2, ptr %t3)
   *
   * clang catches it, so this is a hard build failure and NOT a miscompile — but it reaches
   * the user as a raw clang error with no `NT****` code and no hint, which is the one thing
   * the diagnostics contract promises never happens. It wants either an equality rule (node
   * compares Date IDENTITY, so two distinct Dates are `false` whatever their time values) or
   * a refusal with a code.
   *
   * FIXED as a REFUSAL (NT1024), because the equality rule is not available: nativets
   * represents a Date AS its time value, so there is no identity left to compare, and both
   * plausible codegens are wrong for a program somebody writes — comparing time values
   * calls two distinct Dates at one instant equal (node: false), and node calls an Invalid
   * Date equal to itself (time values: false, `NaN !== NaN`). The hint hands back
   * `.getTime()` WITH that caveat, and both halves are compiled against node in
   * test/narrowing.test.ts.
   *
   * The `else` that produced the invalid IR was the DEFAULT arm of the equality chain, not
   * the string arm, so it also swallowed `null === null` (node `true`, ours a clang error
   * about an `i8`). That is answered as the constant it is, and the arm now asserts its
   * operand is a pointer — the same default-deny the string and number coercions got.
   */
  it("`date === date` carries a diagnostic code, never invalid IR", async () => {
    const ours = await ourRun([
      "const a = new Date(1000);",
      "const b = new Date(2000);",
      "console.log(a === b);",
      "",
    ].join("\n"));
    // A refusal is acceptable ONLY if it carries a diagnostic code; a bare clang error is not.
    if (isRefusal(ours)) expect(ours.refused).toMatch(/NT\d{4}/);
    else expect(ours.stdout.toString("utf8")).toBe("false\n");
  });
});

describe("fuzz2 findings — leaks", () => {
  /*
   * FIXED (`argTempFree`). An object literal written DIRECTLY in an argument position used
   * to be dropped by nobody: the callee does not own it and the caller never released it,
   * so one object per call escaped. The same call with the literal bound to a local first
   * was already clean, which is what pinned it on the temporary rather than on the function
   * or on the object — a literal in argument position has NO NAME, so no drop set could
   * refer to it.
   *
   * The caller now frees it after the call returns, which is sound because a parameter
   * cannot escape its callee: `return o`, `g = o`, `return new Box(o)` and `return [o]` are
   * each already NT1604 ("cannot move out of `o`: it is borrowed").
   *
   * This is ordinary, idiomatic code — `f({x: 1})` — so the residue grew with the program's
   * work, without bound. It was invisible on macOS (LeakSanitizer is Linux-only).
   */
  it("an object literal in ARGUMENT position is freed", async () => {
    await expectResidueDoesNotScale(
      `takeObj({ a: i, b: i });`,
      `function takeObj(o: { a: number; b: number }): number { return o.a; }`,
    );
  });

  /** The same defect on the array side — one array header per call — fixed by the same rule. */
  it("an array literal in ARGUMENT position is freed", async () => {
    await expectResidueDoesNotScale(
      `takeArr([i, i]);`,
      `function takeArr(a: number[]): number { return a.length; }`,
    );
  });

  /*
   * The control for the two above: bind the literal to a local first and the residue is flat
   * at both scales. Kept as a passing test so a fix cannot "pass" by disabling the counters.
   */
  it("a NAMED object argument is freed (the control)", async () => {
    await expectResidueDoesNotScale(
      `const o = { a: i, b: i }; takeObj(o);`,
      `function takeObj(o: { a: number; b: number }): number { return o.a; }`,
    );
  });

  /*
   * A nested object literal leaks its INNER object. The outer object is freed, but the free
   * is shallow, so an object-typed slot's target survives — the object-valued sibling of the
   * known shallow-free of string slots.
   */
  it.failing("a NESTED object literal leaks the inner object", async () => {
    await expectResidueDoesNotScale(`const o = { a: { b: i } };`);
  });

  /*
   * A call's returned object is freed when it is BOUND and leaked when it is DISCARDED, so
   * the drop is attached to the binding rather than to the value.
   */
  it.failing("a DISCARDED returned object is never freed", async () => {
    await expectResidueDoesNotScale(
      `mkObj(i);`,
      `function mkObj(i: number): { a: number; b: number } { return { a: i, b: i }; }`,
    );
  });

  /*
   * `Object.keys` allocates a fresh array every call and never released it.
   *
   * FIXED (lk-runtime), and the interesting part is WHERE the freshness comes from. The
   * statement DISCARDS the array, so no binding owns it, no drop set names it, and
   * `freeReceiverTemp` never sees it — that rule frees the RECEIVER of a chain, never
   * its result. The shape test `freshArray` (ast.ts) already answers "yes" for both
   * `.keys` and `.concat` and was the wrong instrument to reuse here: it matches on the
   * METHOD NAME, and at a discard there is no context establishing that the receiver was
   * a builtin — a user class with a `keys()`/`concat()` method handing back a field would
   * match it too, and freeing that field is a use-after-free rather than a leak. So the
   * array is marked at the point it is BUILT (`freshArrayTemp`, src/codegen.ts) by the
   * lowerings whose freshness is a fact of the lowering itself, and the discard frees it
   * only on SSA identity. Everything unmarked keeps leaking, as before: a wrong "fresh"
   * is a premature free, so unclaimed has to stay the default.
   */
  it("Object.keys leaks one array header per call", async () => {
    await expectResidueDoesNotScale(`const o = { a: i, b: i }; Object.keys(o);`);
  });

  /*
   * `Array#concat` allocates a fresh array every call and never released it. Same fix,
   * plus the FOLD's own intermediates: `a.concat(b, c)` allocated two headers and
   * returned one, so the discarded middle leaked even when the result was bound.
   */
  it("Array#concat leaks one array header per call", async () => {
    await expectResidueDoesNotScale(`const a = [i]; const b = [i]; a.concat(b);`);
  });

  /*
   * The control for the two above, and the reason the fix is attributable: the same
   * statement shape with a producer that is NOT marked fresh. `[i, i].map(...)` allocates
   * an array and discards it exactly as `Object.keys(o)` does — its residue still scales,
   * because `freshArrayTemp` claims only the lowerings whose freshness was established.
   * Pinned `failing` so that widening the claim later is a deliberate act with a test to
   * flip, rather than something that quietly starts passing.
   */
  it.failing("a DISCARDED map result is still unclaimed (the control)", async () => {
    await expectResidueDoesNotScale(`const a = [i, i]; a.map((x: number): number => x + 1);`);
  });

  /* And the receiver side stays owned: a NAMED array whose concat result is discarded is
   * not freed twice — the residue is flat AND the program still reads `a` afterwards. */
  it("concat frees only its own result, never its receiver", async () => {
    await expectResidueDoesNotScale(
      `const a = [i]; const b = [i]; a.concat(b); use(a.length + b.length);`,
      `function use(n: number): number { return n; }`,
    );
  });

  /*
   * `structuredClone` of a named source leaks the CLONE when the clone is discarded, and
   * `structuredClone` of a literal leaks the argument temporary on top of that — two objects
   * per call for `structuredClone({…})`.
   */
  it.failing("structuredClone leaks its result when the result is discarded", async () => {
    await expectResidueDoesNotScale(`const o = { a: i, b: i }; structuredClone(o);`);
  });

  /*
   * `JSON.stringify` leaked EIGHT strings per call on a two-field object — the intermediate
   * pieces of the serializer, not only the final concatenation.
   *
   * FIXED (lk-runtime), in two halves that are worth keeping apart.
   *
   * SEVEN of the eight were the FOLD's own accumulators. The serializer is a left fold of
   * `js_str_concat`, which always allocates and copies both inputs, so every accumulator
   * but the last is dead the instant the next concatenation has run — and none was ever
   * released. `jsonCat` (src/codegen.ts) is `concat` plus that release, and it is told
   * per operand which side this frame owns rather than releasing both: an interned
   * separator is not in the RC table, so releasing one is a no-op that would only add a
   * dead call to every JSON site's IR. A `genJsonStringify` result is always releasable,
   * because every arm of it either allocates or returns an untracked pointer, and none
   * returns its own argument.
   *
   * The EIGHTH is the result, which this statement discards — claimed through the same
   * `discardFree` mark `Object.keys` and `concat` use. That one is a real claim about a
   * PRODUCER, so it is made only where the producer is generated here and its rc is known
   * (`JSON.stringify`), never inferred from a method's name.
   */
  it("JSON.stringify leaks its intermediate strings", async () => {
    await expectResidueDoesNotScale(`const o = { a: i, b: i }; JSON.stringify(o);`);
  });

  /*
   * The ARRAY fold, whose accumulator count is a RUNTIME fact rather than a compile-time
   * one: one concatenation per element, in a loop, with the accumulator living in a slot
   * across basic blocks instead of in an SSA name.
   */
  it("the JSON array fold releases its accumulators too", async () => {
    await expectResidueDoesNotScale(`const xs = [i, i, i]; JSON.stringify(xs);`);
  });

  /*
   * ...and the pretty-printed spelling, which branches at every step (a leading newline
   * before the first element, `\n<indent>]` at the close) and so has its own accumulators.
   */
  it("JSON.stringify(v, null, 2) releases its accumulators", async () => {
    await expectResidueDoesNotScale(`const xs = [i, i]; JSON.stringify(xs, null, 2); const o = { a: i, b: i }; JSON.stringify(o, null, 2);`);
  });

  /*
   * The THIRD fold — an object with an OPTIONAL field, where the separator and the key are
   * runtime decisions — cannot be measured by the flat-residue rule above, because the
   * shape it needs carries a leak of its own: `const p: {a: number; b?: string} = {a: i, b: "x"}`
   * leaks one OBJECT per iteration with no JSON.stringify anywhere near it (an optional
   * field's nullable box is never dropped). That is a pre-existing defect of the object
   * model, not of the serializer, and conflating the two would either hide this fix or
   * claim someone else's.
   *
   * So this one is measured MARGINALLY: the same program twice, once with the
   * `JSON.stringify` call and once without, and the assertion is that the serializer adds
   * nothing to either counter at either scale. That is the attribution the flat-residue
   * form gets for free when the surrounding shape happens to be clean.
   */
  it("the optional-field fold adds NOTHING to the residue (measured against its own control)", async () => {
    const round = (call: string) => `
type Opt = { a: number; b?: string };
function nt2round(n: number): void {
  for (let i = 0; i < n; i++) { const p: Opt = { a: i, b: "x" }; const q: Opt = { a: i }; ${call} }
}
const o0 = __objLive(); const s0 = __strLive();
nt2round(50);
const o1 = __objLive(); const s1 = __strLive();
nt2round(500);
const o2 = __objLive(); const s2 = __strLive();
console.log((o1 - o0) + " " + (o2 - o1) + " " + (s1 - s0) + " " + (s2 - s1));
`;
    const withJson = await ourRun(round(`JSON.stringify(p); JSON.stringify(q);`));
    const control = await ourRun(round(``));
    if (isRefusal(withJson)) throw new Error(`nativets refused:\n${withJson.refused}`);
    if (isRefusal(control)) throw new Error(`nativets refused:\n${control.refused}`);
    expect(withJson.exitCode).toBe(0);
    expect(control.exitCode).toBe(0);
    // Identical residue with and without the serializer — and the control is NOT zero,
    // which is the point: the leak that remains is the optional field's, not the fold's.
    expect(withJson.stdout.toString("utf8")).toBe(control.stdout.toString("utf8"));
    // Two optional-field objects per iteration -> 100/1000 objects, and ZERO strings on
    // both sides: every accumulator the fold allocated is accounted for.
    expect(control.stdout.toString("utf8").trim()).toBe("100 1000 0 0");
  });

  /*
   * The control, and the reason the claim above is narrow: an ORDINARY string
   * concatenation discarded in statement position still leaks its result. `+` has no
   * producer to mark — `allocatesString` is a shape test over the expression, and the
   * `discardFree` mark is deliberately set only where codegen generated the allocation
   * itself. Pinned `failing` so widening it later is a deliberate act.
   */
  it.failing("a DISCARDED string concatenation is still unclaimed (the control)", async () => {
    await expectResidueDoesNotScale(`const o = { a: i }; use(o.a); "x" + i + "y";`, `function use(n: number): number { return n; }`);
  });

  /*
   * ACTORS. `send` deep-copies the message so the receiver owns a private value — that copy
   * is the whole isolation guarantee and is correct. But the receiver never frees it: the
   * residue is exactly one object per message DELIVERED, at every scale (100 messages leave
   * 100 objects, 1000 leave 1000). A long-running actor system therefore grows without
   * bound in proportion to its traffic, which is the one workload shape actors exist for.
   *
   * A number-only message is the clean control (no heap, flat residue), so this is the
   * message COPY and not the mailbox.
   *
   * FIXED (lk-actor). The copy's ownership story was already right — the mailbox owns it
   * until `receive` dequeues it, and the receiving local becomes its one owner. What was
   * missing was the DROP: `emitDrops` was a blanket no-op inside a lifted arrow, and an
   * actor body is necessarily an arrow because `spawn` takes a closure. The same worker
   * written as a `function` was always clean, which is what pins it there rather than on
   * the message ABI. See `test/actors-leak.test.ts` for the per-path residue matrix.
   */
  it("an actor message copy is never freed after the receiver consumes it", async () => {
    const source = `
const nt2worker = (n: number): void => {
  for (let i = 0; i < n; i++) { const m: { a: number; b: number } = receive(); }
};
function nt2fire(w: number, i: number): void { const req = { a: i, b: i }; send(w, req); }
function nt2round(n: number): void {
  const w = spawn(nt2worker, n);
  for (let i = 0; i < n; i++) { nt2fire(w, i); }
  __drain();
}
const o0 = __objLive();
nt2round(100);
const o1 = __objLive();
nt2round(1000);
const o2 = __objLive();
console.log((o1 - o0) + " " + (o2 - o1));
`;
    const ours = await ourRun(source);
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    expect(ours.exitCode).toBe(0);
    const [small, big] = ours.stdout.toString("utf8").trim().split(" ").map(Number);
    expect(big).toBe(small!);
  });

  /** The control: a number message allocates nothing, and its residue is flat. */
  it("a NUMBER actor message leaves no residue (the control)", async () => {
    const source = `
const nt2worker = (n: number): void => {
  for (let i = 0; i < n; i++) { const m: number = receive(); }
};
function nt2round(n: number): void {
  const w = spawn(nt2worker, n);
  for (let i = 0; i < n; i++) { send(w, i); }
  __drain();
}
const o0 = __objLive();
nt2round(100);
const o1 = __objLive();
nt2round(1000);
const o2 = __objLive();
console.log((o1 - o0) + " " + (o2 - o1));
`;
    const ours = await ourRun(source);
    if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
    expect(ours.stdout.toString("utf8").trim()).toBe("0 0");
  });
});
