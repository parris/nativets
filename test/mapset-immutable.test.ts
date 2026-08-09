/*
 * B2 immutable Map/Set — the "sharp turn" DIVERGENCE from JS's mutable Map/Set:
 * `.set`/`.add`/`.delete` return a NEW handle and leave the source UNCHANGED
 * (persistent, structural-sharing via nt_hamt). node's Map/Set mutate in place,
 * so these "old version unchanged" behaviors cannot be node-differential — they
 * are compile-and-run + assert (like drops/actors tests). The observable-equal
 * cases (use the returned value) live under test/fixtures/stage22-mapset/.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, emitIR } from "./harness.ts";

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/*
 * THE DISCARDED-MUTATOR REFUSAL.
 *
 * The persistence divergence above is documented for its RETURN VALUE, and every case in
 * this file and in test/collections.test.ts happens to USE that return value (chained or
 * reassigned). Nothing caught the far more common JS spelling, where the result is thrown
 * away and the call is written for its EFFECT:
 *
 *     const m = new Map<string, number>();
 *     m.set("a", 1);                      // node: m now has "a".  nativets: a NO-OP.
 *     console.log(m.size, m.get("a"));    // node: "2 1"   nativets: "0 undefined"
 *
 * Exit code 0 on both sides, stdout wrong — a silent wrong answer, which CLAUDE.md ranks
 * as the worst outcome available. It is refused instead.
 *
 * WHY node's spelling is universal, from test262: `Map.prototype.set` and
 * `Set.prototype.add` return the RECEIVER, not a new collection
 * (test262 `test/built-ins/Map/prototype/set/returns-this.js`,
 * `test/built-ins/Set/prototype/add/returns-this.js` — both re-measured on node here:
 * `m.set("a",1) === m` is `true`). So under node the return value carries no information
 * and discarding it is the NORMAL way to write the call. Under a PERSISTENT collection the
 * return value is the entire result, and discarding it discards the whole operation.
 * `.delete` differs again: node returns a BOOLEAN
 * (test262 `test/built-ins/Map/prototype/delete/returns-{true,false}.js`), which is the
 * §A divergence already documented — but the discarded STATEMENT is a no-op just the same.
 *
 * The rule is DISCARDED RESULT, with no "is the receiver read later?" reachability test.
 * A discarded `.set`/`.add`/`.delete` is a guaranteed no-op in EVERY program — there is no
 * execution in which it does anything — so refusing it has no false-positive direction,
 * while a reachability analysis has an UNSOUND one (miss an alias, and the silent wrong
 * answer comes straight back). It is also what this compiler already does for the exact
 * same class of mistake on arrays: `arr.push(x)` is refused (NT1606) with no check for
 * whether `arr` is read afterwards.
 */
describe("a DISCARDED .set/.add/.delete is refused, not silently dropped", () => {
  test("`m.set(k, v);` in statement position is NT1606, not a no-op", () => {
    const r = rejectionOf(`const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log(m.size);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("2:1");
    expect(r?.hint).toContain("m = m.set(");
  });

  test("`s.add(v);` is refused the same way (test262 add/returns-this.js)", () => {
    const r = rejectionOf(`const s = new Set<number>();\ns.add(1);\nconsole.log(s.size);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("s = s.add(1)");
  });

  test("a discarded `.delete` is refused for BOTH collections", () => {
    const map = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nm.delete("a");\nconsole.log(m.size);\n`);
    expect(map?.code).toBe("NT1606");
    expect(map?.hint).toContain(`m = m.delete("a")`);
    const set = rejectionOf(`let s = new Set<number>().add(1);\ns.delete(1);\nconsole.log(s.size);\n`);
    expect(set?.code).toBe("NT1606");
    expect(set?.hint).toContain("s = s.delete(1)");
  });

  /*
   * The whole CHAIN is discarded here, not a single call. This is the shape that would
   * slip through a rule written as "the receiver is a plain identifier": the outer call's
   * receiver is the inner CALL. Checking the statement's outermost expression catches it,
   * because the inner call's result type is still the collection.
   */
  test("a discarded CHAIN is a no-op too, and is refused", () => {
    const r = rejectionOf(`const m = new Map<string, number>();\nm.set("a", 1).set("b", 2);\nconsole.log(m.size);\n`);
    expect(r?.code).toBe("NT1606");
  });

  /*
   * A MEMBER receiver — the form that dominates the compiler's own source
   * (`this.generics.set(fn.name, fn)`, `this.strings.set(s, sym)`). The hint has to name
   * the whole path, not just the last segment, or it is not copy-pasteable.
   */
  test("a member-path receiver is refused and the hint names the FULL path", () => {
    const r = rejectionOf(
      `type Box = { m: Map<string, number> };\nconst b: Box = { m: new Map<string, number>() };\nb.m.set("a", 1);\nconsole.log(b.m.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("b.m = b.m.set(");
  });

  /*
   * NO FALSE POSITIVES. Every form that already works must keep working — the refusal is
   * about a DISCARDED result, so any form that consumes the result is untouched. `.get`,
   * `.has` and `.size` are not mutators and never reach the rule at all.
   */
  test("the forms that USE the result still compile", async () => {
    const src = `
let m = new Map<string, number>();
m = m.set("a", 1);                              // reassigned
const m2 = new Map<string, number>().set("b", 2); // chained into a binding
const s = new Set<number>().add(1).add(2);        // chained into a binding
if (m.has("a")) { console.log(m.get("a"), m2.size, s.size, m.size); }`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1 1 2 1\n");
    expect(r.exitCode).toBe(0);
  });

  /*
   * The rule is STATEMENT position, not "anywhere the value looks unused". A mutator in a
   * `return`, an argument or an initializer is consumed by its context and must stay legal —
   * an over-broad rule here would break the chained form above. (A BOOLEAN context is the
   * one exception, and it is a rule of its own: see the next describe.)
   */
  test("a mutator in a non-statement position is NOT refused", async () => {
    const src = `
function grow(m: Map<string, number>): Map<string, number> { return m.set("g", 1); }
const out = grow(new Map<string, number>());
console.log(out.size, out.get("g"));`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1 1\n");
  });
});

/*
 * `.delete` CONSUMED AS A BOOLEAN — the other half of the same divergence.
 *
 * The refusal above covers the call whose result is DISCARDED. This one covers the call
 * whose result is USED, in the one context where using it is guaranteed to be wrong:
 *
 *     let m = new Map<string, number>().set("a", 1);
 *     if (m.delete("zz")) { console.log("deleted"); } else { console.log("absent"); }
 *     // node: "absent"    nativets, before: "deleted"   — exit 0, wrong branch, no diagnostic
 *
 * node's `Map.prototype.delete` / `Set.prototype.delete` return a BOOLEAN — whether the key
 * was there (test262 `test/built-ins/Map/prototype/delete/returns-{true,false}.js`,
 * `test/built-ins/Set/prototype/delete/returns-{true,false}.js`; re-measured on node here).
 * Ours returns the NEW COLLECTION, and a collection handle is `true` for every input. So the
 * condition is not a condition at all: the `else` arm is unreachable and `while (m.delete(k))`
 * cannot terminate. That is decided by the REPRESENTATION, not by the data — which is why
 * this needs no reachability analysis and has no false-positive direction. There is no
 * program in which `.delete`'s result is a meaningful boolean.
 *
 * The rule keys on `.delete`, NOT on "a Map/Set in a condition". `if (m)` on a plain handle
 * is always-true under node too, so it AGREES and must keep compiling; so must `.size`,
 * `.has(k)` and `.get(k)`, which are the spellings the hint points at.
 */
describe(".delete consumed as a BOOLEAN is refused (node returns a boolean, we return a map)", () => {
  test("`if (m.delete(k))` is NT1606, not a silently-taken branch", () => {
    const r = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nif (m.delete("zz")) { console.log("hit"); } else { console.log("miss"); }\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("2:5");
    expect(r?.hint).toContain(`m.has("zz")`);
  });

  /*
   * The worst of the family: `while (m.delete(k))` under node drains the key and stops;
   * here the test is a handle, so the loop NEVER terminates. Measured before the fix: the
   * `if` case merely printed the wrong line, this one hangs. Same for `do`/`while` and the
   * classic `for (;;)` test slot.
   */
  test("every LOOP test refuses — `while`, `do/while`, and the `for` test", () => {
    const w = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nwhile (m.delete("zz")) { console.log("x"); }\n`);
    expect(w?.code).toBe("NT1606");
    expect(w?.message).toContain("`while` condition");
    const d = rejectionOf(`let m = new Map<string, number>().set("a", 1);\ndo { console.log("x"); } while (m.delete("zz"));\n`);
    expect(d?.code).toBe("NT1606");
    const f = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nfor (; m.delete("zz"); ) { console.log("x"); }\n`);
    expect(f?.code).toBe("NT1606");
  });

  /*
   * The two expression-level boolean contexts. `!m.delete(k)` is the spelling of "the key
   * was NOT there", which inverts to a constant `false` here; the ternary test is the `if`
   * in expression position. `!!` nests, so the `!` case must reject its operand rather than
   * only the outermost test.
   */
  test("the ternary test and `!` refuse too", () => {
    const t = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nconsole.log(m.delete("zz") ? "hit" : "miss");\n`);
    expect(t?.code).toBe("NT1606");
    const n = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nif (!m.delete("zz")) { console.log("miss"); }\n`);
    expect(n?.code).toBe("NT1606");
    const nn = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nif (!!m.delete("zz")) { console.log("hit"); }\n`);
    expect(nn?.code).toBe("NT1606");
  });

  /* `Set.prototype.delete` has the identical node contract, so it gets the identical rule. */
  test("Set.delete in a condition refuses, and the hint names the Set spellings", () => {
    const r = rejectionOf(`let s = new Set<string>().add("a");\nif (s.delete("zz")) { console.log("hit"); } else { console.log("miss"); }\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("`Set` is persistent");
    expect(r?.hint).toContain(`s.has("zz")`);
    expect(r?.hint).toContain(`s = s.delete("zz")`);
  });

  /*
   * NO OVER-REFUSAL. This is the failure mode that would make the cure worse than the
   * disease, so every neighbouring spelling is pinned as PASSING — including `if (m)` on a
   * plain handle, which is always-true under node too and therefore agrees.
   */
  test("the truthiness spellings that AGREE with node still compile", async () => {
    const src = `
const m = new Map<string, number>().set("a", 1);
const s = new Set<string>().add("a");
if (m) { console.log("handle"); }
if (m.size) { console.log("size"); }
if (m.has("a")) { console.log("has"); }
if (m.get("a")) { console.log("get"); }
if (s.has("a")) { console.log("shas"); }
if (!m.has("zz")) { console.log("nothas"); }
console.log(m.has("zz") ? "y" : "n");`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("handle\nsize\nhas\nget\nshas\nnothas\nn\n");
    expect(r.exitCode).toBe(0);
  });

  /*
   * And the legitimate `.delete` spellings — the ones §A tells users to write. The refusal
   * is about the BOOLEAN context only; producing, rebinding and iterating a deleted-from
   * collection are the supported idioms and must be untouched.
   */
  test("the value-consuming `.delete` spellings still compile", async () => {
    const src = `
let m = new Map<string, number>().set("a", 1).set("b", 2);
m = m.delete("a");                                   // rebind
const m2 = m.delete("b");                            // fresh binding
const s = new Set<string>().add("x").add("y").delete("x"); // chained
console.log(m.size, m2.size, s.size, s.has("y"));
if (m.delete("b").size === 0) { console.log("emptied"); }`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1 0 1 true\nemptied\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("immutable Map/Set (old version unchanged / structural sharing)", () => {
  test("Map.set returns a new map; the source is unchanged", async () => {
    const src = `
const m1 = new Map<string, number>().set("a", 1);
const m2 = m1.set("b", 2);
// m1 must NOT see "b" (node would, because it mutates); m2 has both.
console.log(m1.has("a"), m1.has("b"), m1.size);
console.log(m2.has("a"), m2.has("b"), m2.size);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("true false 1\ntrue true 2\n");
    expect(r.exitCode).toBe(0);
  });

  test("Map value-update does not mutate the source's value", async () => {
    const src = `
const m1 = new Map<string, number>().set("k", 10);
const m2 = m1.set("k", 999); // overwrite on a copy
console.log(m1.get("k"), m2.get("k"));`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("10 999\n"); // m1 still 10 (JS would print 999 999)
    expect(r.exitCode).toBe(0);
  });

  test("Map.delete returns a new map; the source keeps the key", async () => {
    const src = `
const m1 = new Map<string, number>().set("a", 1).set("b", 2);
const m2 = m1.delete("a");
console.log(m1.has("a"), m1.size);
console.log(m2.has("a"), m2.has("b"), m2.size);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("true 2\nfalse true 1\n"); // m1 intact; m2 without "a"
    expect(r.exitCode).toBe(0);
  });

  test("Set.add / Set.delete are immutable; the source is unchanged", async () => {
    const src = `
const s1 = new Set<number>().add(1).add(2);
const s2 = s1.add(3);
const s3 = s1.delete(1);
console.log(s1.has(3), s1.has(1), s1.size);
console.log(s2.has(3), s2.size);
console.log(s3.has(1), s3.has(2), s3.size);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("false true 2\ntrue 3\nfalse true 1\n");
    expect(r.exitCode).toBe(0);
  });

  test("many persistent versions all remain independently intact", async () => {
    // Cross the HAMT boundary while keeping older handles; each must keep its own
    // contents (proves no aliasing writes / real path-copying structural sharing).
    const src = `
let base = new Map<string, number>();
for (let i = 0; i < 40; i = i + 1) { base = base.set("k" + i, i); }
const bigger = base.set("k40", 40);
const changed = base.set("k0", 500); // value-update on an existing key
console.log(base.size, bigger.size, changed.size);
console.log(base.get("k0"), changed.get("k0"), bigger.has("k40"), base.has("k40"));`;
    const r = await compileAndRun(src);
    // base: 40 entries, k0==0, no k40. bigger: 41, has k40. changed: 40, k0==500.
    expect(r.stdout).toBe("40 41 40\n0 500 true false\n");
    expect(r.exitCode).toBe(0);
  });
});
