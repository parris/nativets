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
   */
  it.failing("new Date(-0) clips to +0, so getTime() is 0 and not -0", async () => {
    await expectSameBytes([
      "console.log(new Date(-0).getTime());",     // node 0, ours -0
      "console.log(new Date(-0.5).getTime());",   // node 0, ours -0
      "console.log(new Date(-0.9).getTime());",   // node 0, ours -0
      "console.log(1 / new Date(-0).getTime());", // node Infinity, ours -Infinity
      "console.log(new Date(-1.5).getTime());",   // node -1, ours -1 — truncation itself is right
      "",
    ].join("\n"));
  });
});

describe("fuzz2 findings — leaks", () => {
  /*
   * An object literal written DIRECTLY in an argument position is never dropped: the callee
   * does not own it and the caller never releases it, so one object per call escapes. The
   * same call with the literal bound to a local first is clean, which is what pins it on the
   * temporary rather than on the function or on the object.
   *
   * This is ordinary, idiomatic code — `f({x: 1})` — so the residue grows with the program's
   * work, without bound. It is invisible on macOS (LeakSanitizer is Linux-only).
   */
  it.failing("an object literal in ARGUMENT position is never freed", async () => {
    await expectResidueDoesNotScale(
      `takeObj({ a: i, b: i });`,
      `function takeObj(o: { a: number; b: number }): number { return o.a; }`,
    );
  });

  /** The same defect on the array side: one array header per call. */
  it.failing("an array literal in ARGUMENT position is never freed", async () => {
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

  /** `Object.keys` allocates a fresh array every call and never releases it. */
  it.failing("Object.keys leaks one array header per call", async () => {
    await expectResidueDoesNotScale(`const o = { a: i, b: i }; Object.keys(o);`);
  });

  /** `Array#concat` allocates a fresh array every call and never releases it. */
  it.failing("Array#concat leaks one array header per call", async () => {
    await expectResidueDoesNotScale(`const a = [i]; const b = [i]; a.concat(b);`);
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
   * `JSON.stringify` leaks EIGHT strings per call on a two-field object — the intermediate
   * pieces of the serializer, not only the final concatenation.
   */
  it.failing("JSON.stringify leaks its intermediate strings", async () => {
    await expectResidueDoesNotScale(`const o = { a: i, b: i }; JSON.stringify(o);`);
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
   */
  it.failing("an actor message copy is never freed after the receiver consumes it", async () => {
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
