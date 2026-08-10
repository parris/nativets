/*
 * B2 immutable Map/Set — the "sharp turn" DIVERGENCE from JS's mutable Map/Set:
 * `.set`/`.add`/`.delete` return a NEW handle and leave the source UNCHANGED
 * (persistent, structural-sharing via nt_hamt). node's Map/Set mutate in place,
 * so these "old version unchanged" behaviors cannot be node-differential — they
 * are compile-and-run + assert (like drops/actors tests). The observable-equal
 * cases (use the returned value) live under test/fixtures/stage22-mapset/.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

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
   * A `this.<field>` receiver — the form that dominates the compiler's own source
   * (`this.generics.set(fn.name, fn)`, `this.strings.set(s, sym)`). The hint has to name
   * the whole path, not just the last segment, or it is not copy-pasteable. The rebind is
   * genuinely right here: a `@@mutable` class's own field IS assignable in place.
   */
  test("a `this.<field>` receiver is refused and the hint names the FULL path", () => {
    const r = rejectionOf(
      `//@@mutable\nclass Box {\n  m: Map<string, number> = new Map<string, number>();\n  note(): void { this.m.set("a", 1); }\n}\nconsole.log(new Box().m.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("this.m = this.m.set(");
  });

  /*
   * …AND THE REBIND STOPS BEING RECOMMENDED WHERE IT DOES NOT COMPILE.
   *
   * `THE RECEIVER DECIDES THE HINT` is already this rule's own comment, learned once for
   * PARAMETERS. It was learned only half way: the `else` arm names `X = X.<m>(…)` for
   * EVERY other receiver, and two of them are shapes this very compiler refuses.
   *
   *     const b = { m: new Map<string, number>() };
   *     b.m.set("a", 1);       // hint: write `b.m = b.m.set("a", 1)`
   *                            //   -> NT1606 "objects are immutable: `b.m = v`"
   *
   *     const sets: Set<string>[] = [new Set<string>()];
   *     sets[0]!.add("a");     // hint: write `sets[0]! = sets[0]!.add("a")`
   *                            //   -> NT0001 "Invalid assignment target"
   *
   * Both were measured by COMPILING the advice, which is the only way this class of defect
   * is ever found: the hint reads plausible, node runs the recommended line (it strips the
   * `!` and mutates), and tsc accepts even the `sets[0]! =` spelling. Only nativets says no
   * — to advice nativets itself wrote. An unfollowable hint on a correct refusal is the
   * same failure as a wrong answer with extra steps, so the arms below name a shape that
   * compiles instead, and the tests that follow RUN it.
   */
  test("an OBJECT-FIELD receiver is not told to write a refused field assignment", () => {
    const src = `type Box = { m: Map<string, number> };\nconst b: Box = { m: new Map<string, number>() };\nb.m.set("a", 1);\nconsole.log(b.m.size);\n`;
    const r = rejectionOf(src);
    expect(r?.code).toBe("NT1606");
    // It must not RECOMMEND the rebind. Naming it as the thing NOT to write is what the
    // PARAMETER arm already does, and is more useful than silence to someone who tried it.
    expect(r?.hint).toContain("do NOT write `b.m = b.m.set(\"a\", 1)`");
    expect(r?.hint).toContain("CONTAINER");
    // …and what it recommends instead must compile. This is that line, verbatim.
    expect(rejectionOf(
      `type Box = { m: Map<string, number> };\nconst b: Box = { m: new Map<string, number>() };\nconst b2: Box = { ...b, m: b.m.set("a", 1) };\nconsole.log(b2.m.size);\n`,
    )).toBeNull();
  });

  test("an ELEMENT receiver is not told to write an invalid assignment target", () => {
    const r = rejectionOf(
      `const sets: Set<string>[] = [new Set<string>()];\nsets[0]!.add("a");\nconsole.log(sets[0]!.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("do NOT write `sets[0]! = sets[0]!.add(\"a\")`");
    expect(r?.hint).toContain("not an assignment target at all");
    // The replacement — seed a LOCAL from the element, accumulate, rebuild the container.
    // The `slice` spelling is the hint's own words, and it RUNS: node prints the same.
    expect(r?.hint).toContain("[...xs.slice(0, i), acc, ...xs.slice(i + 1)]");
    expect(rejectionOf(
      `const xs: Set<string>[] = [new Set<string>(), new Set<string>()];\nconst i = 0;\nlet acc = xs[i]!;\nacc = acc.add("a");\nconst next: Set<string>[] = [...xs.slice(0, i), acc, ...xs.slice(i + 1)];\nconsole.log(next.length, next[0]!.size, next[1]!.size);\n`,
    )).toBeNull();
  });

  test("the hint's rebuild spellings RUN, and agree with node", async () => {
    const elem = `const xs: Set<string>[] = [new Set<string>(), new Set<string>()];
const i = 0;
let acc = xs[i]!;
acc = acc.add("a");
const next: Set<string>[] = [...xs.slice(0, i), acc, ...xs.slice(i + 1)];
console.log(next.length, next[0]!.size, next[1]!.size);`;
    const field = `type Box = { m: Map<string, number> };
const b: Box = { m: new Map<string, number>() };
const b2: Box = { ...b, m: b.m.set("a", 1) };
console.log(b2.m.size, b2.m.get("a"));`;   // only b2 — b.m is the §A persistence divergence
    for (const src of [elem, field]) {
      const ours = await compileAndRun(src);
      const theirs = await runWithNode(src);
      expect(ours.stdout).toBe(theirs.stdout);
      expect(ours.exitCode).toBe(theirs.exitCode);
    }
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
if (m.size) { console.log("size"); }
if (m.has("a")) { console.log("has"); }
if (m.get("a")) { console.log("get"); }
if (s.has("a")) { console.log("shas"); }
if (!m.has("zz")) { console.log("nothas"); }
console.log(m.has("zz") ? "y" : "n");`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("size\nhas\nget\nshas\nnothas\nn\n");
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

/*
 * THE VACUOUS COLLECTION TEST — the residual hole above, closed by widening.
 *
 * The `.delete` rule keys on `.delete`, so routing the result through a binding escaped it:
 *
 *     const gone = m.delete("zz");
 *     if (gone) { … } else { … }     // node: else.  here, before: THEN. Exit 0, no diagnostic.
 *
 * At `if (gone)` the expression is a plain Map-typed identifier, indistinguishable from
 * `if (m)`. There is no analysis that separates them, so the honest move is to refuse BOTH —
 * and the reason that is affordable is that `if (m)` is not a check in EITHER language.
 *
 * A non-nullable handle is never `null`/`undefined`, so node evaluates the test to `true`
 * too: it is vacuous, not divergent. Refusing it costs a user nothing semantically — no
 * correct program's behaviour depends on a condition that cannot be false — while leaving
 * it open costs a silent wrong answer that survives one `const`. Measured blast radius
 * before widening: NO occurrence of a non-nullable collection truthiness test anywhere in
 * `src/`, `test/fixtures/` or `examples/`.
 *
 * `Map | undefined` is a DIFFERENT type and a real check — `if (maybeMap)` must keep
 * working, and does: the nullable box is `?N…`/`?U…`, which is not `isMapTy`.
 */
describe("a truthiness test on a NON-NULLABLE Map/Set is vacuous, and refused", () => {
  test("`if (m)` on a plain handle is NT1606 — always true in node too", () => {
    const r = rejectionOf(`const m = new Map<string, number>().set("a", 1);\nif (m) { console.log("t"); } else { console.log("f"); }\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("always truthy");
    expect(r?.message).toContain("2:5");
    expect(r?.hint).toContain("m.size");
    expect(r?.hint).toContain("m.has(");
  });

  test("it closes the `.delete`-through-a-binding hole this rule exists for", () => {
    const r = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nconst gone = m.delete("zz");\nif (gone) { console.log("hit"); } else { console.log("miss"); }\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("gone.size");
  });

  test("every truthiness position, and `Set` as well as `Map`", () => {
    const pre = `const m = new Map<string, number>().set("a", 1);\nconst s = new Set<string>().add("a");\n`;
    for (const tail of [
      `while (m) { console.log("x"); }`,
      `do { console.log("x"); } while (m);`,
      `for (; m; ) { console.log("x"); }`,
      `console.log(m ? "y" : "n");`,
      `if (!m) { console.log("x"); }`,
      `if (s) { console.log("x"); }`,
      `if (!s) { console.log("x"); }`,
    ]) expect(rejectionOf(pre + tail + "\n")?.code).toBe("NT1606");
  });

  /*
   * The one that must NOT be refused. `Map | undefined` can genuinely be absent, so the
   * test decides something and node and we agree on what — this is the whole reason the
   * rule is written on NON-nullable types rather than on "a collection in a condition".
   */
  test("a NULLABLE Map/Set test is a real check and still compiles", async () => {
    const src = `
const hit: Map<string, number> | undefined = new Map<string, number>().set("a", 1);
const nope: Map<string, number> | undefined = undefined;
const noSet: Set<string> | undefined = undefined;
if (hit) { console.log("some", hit.size); } else { console.log("none"); }
if (nope) { console.log("some2"); } else { console.log("none2"); }
if (!noSet) { console.log("no-set"); }`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("some 1\nnone2\nno-set\n");
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

/*
 * REBINDING A PARAMETER — the fix the discarded-mutator hint used to RECOMMEND, and a
 * silent wrong answer in the opposite direction from every other case in this file.
 *
 * The refusal above says "write `out = out.add(n)`" with no test of what `out` IS. On a
 * local that advice is exactly right and costs nothing (node's `.add` returns the
 * receiver, so the rebind is the identity there). On a PARAMETER it is wrong, because a
 * parameter is a BORROW — the caller owns the collection and the callee's rebind cannot
 * reach it:
 *
 *     function collect(names: string[], out: Set<string>): void {
 *       for (const n of names) out = out.add(n);   // what the hint told you to write
 *     }
 *     let acc = new Set<string>(); collect(["a","b","c"], acc); console.log(acc.size);
 *
 * node prints 3 — its `.add` MUTATES the receiver, so the caller observes every append
 * and the rebind is incidental. We print 0: `.add` returns a new set, the rebind is
 * local, and the caller's `acc` never changes. Exit 0 on both sides, stdout wrong.
 *
 * Note the DIRECTION, because it is the reverse of `.delete`. A discarded `.delete`
 * rebind (`m = m.delete(k)`) breaks under BUN, where `.delete` answers a boolean. This
 * one breaks under NATIVETS. They are two different refusals and neither rule implies
 * the other.
 *
 * The rule is narrow on purpose: only an assignment whose VALUE is a mutator call on the
 * parameter itself. A plain `m = new Map()` on a parameter is NOT refused — node agrees
 * that one is invisible to the caller, so there is no divergence to report. The
 * divergence exists only because node's mutator has a side effect on the receiver that
 * ours does not.
 *
 * The sanctioned spelling was already decided in docs/self-hosting.md ("a persistent Map
 * cannot be an accumulator argument — RETURN the bindings"); only the diagnostic had not
 * learned it.
 */
describe("rebinding a Map/Set PARAMETER from its own mutator is refused", () => {
  test("`out = out.add(n)` on a parameter is NT1606, not a lost update", () => {
    const r = rejectionOf(
      `function collect(names: string[], out: Set<string>): void {\n  for (const n of names) out = out.add(n);\n}\nconst acc = new Set<string>();\ncollect(["a"], acc);\nconsole.log(acc.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("parameter");
  });

  /*
   * THE HINT IS THE DELIVERY MECHANISM, and this is the test that matters most in the
   * file. A wrong answer a user stumbles into is bad; a wrong answer the compiler
   * INSTRUCTS them to write is worse, because a diagnostic is trusted exactly when
   * someone is uncertain. The discarded-mutator refusal used to print
   * "write `out = out.add(n)`" for every receiver alike — so following the hint on an
   * out-parameter produced the lost update above, and after the rule above it would be
   * recommending a program this same compiler now rejects.
   */
  test("the DISCARDED-mutator hint does not recommend the rebind on a parameter", () => {
    const r = rejectionOf(
      `function collect(names: string[], out: Set<string>): void {\n  for (const n of names) out.add(n);\n}\nconst acc = new Set<string>();\ncollect(["a"], acc);\nconsole.log(acc.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
    // It must not RECOMMEND the rebind. It may still name it, and it does — as the thing
    // NOT to write — which is more useful than silence to someone who already tried it.
    expect(r?.hint).toContain("do NOT write `out = out.add(n)`");
    expect(r?.hint).toContain("PARAMETER");
    // …and it must name a spelling that works: a local, returned, rebound by the caller.
    expect(r?.hint).toContain("let acc = out;");
    expect(r?.hint).toContain("return acc;");
  });

  /*
   * THE SAME HINT STATED A FLAT FALSEHOOD ABOUT `.delete`, and it is the third instance of
   * this lane's theme. The tail read "node's `.delete` mutates and returns the receiver".
   * node's `.delete` answers a BOOLEAN (test262
   * built-ins/Map/prototype/delete/returns-{true,false}.js — re-measured here: after
   * `m = m.delete("a")` node reports `typeof m === "boolean"`, value `true`).
   *
   * That matters more than a wording slip, because `.delete` is the one case where the
   * recommended rebind does not merely become redundant under node — it means something
   * ELSE. bun is stage 0 of the bootstrap and runs `src/`, so a hint that hides this is a
   * hint that breaks the compiler's own source. divergences.md §A and this method's own
   * doc comment always had it right; only the emitted text did not.
   */
  test("the `.delete` hint does not claim node returns the receiver, and warns about bun", () => {
    const r = rejectionOf(`let m = new Map<string, number>().set("a", 1);\nm.delete("a");\nconsole.log(m.size);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).not.toContain("`.delete` mutates and returns the receiver");
    expect(r?.hint).toContain("BOOLEAN");
    expect(r?.hint).toContain("`true`");
  });

  /* …while `.set`/`.add` genuinely DO return the receiver under node, so that tail stays. */
  test("the `.set` hint still says node returns the receiver, which is true", () => {
    const r = rejectionOf(`const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log(m.size);\n`);
    expect(r?.hint).toContain("node's `.set` mutates and returns the receiver");
    expect(r?.hint).not.toContain("BOOLEAN");
  });

  /* A LOCAL receiver is the case the old hint was written for, and it must be untouched. */
  test("a LOCAL receiver still gets the rebind hint", () => {
    const r = rejectionOf(`const s = new Set<number>();\ns.add(1);\nconsole.log(s.size);\n`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("s = s.add(1)");
    expect(r?.hint).not.toContain("PARAMETER");
  });

  /*
   * NO FALSE POSITIVES on the assignment rule. Assigning something that is NOT derived
   * from the parameter's own mutator is invisible to the caller under node TOO, so there
   * is no divergence and nothing to refuse. Refusing it would be over-refusal with an
   * untrue hint.
   */
  test("`out = new Set()` on a parameter is NOT refused — node agrees it is invisible", async () => {
    const src =
      `function reset(out: Set<string>): number {\n  out = new Set<string>();\n  return out.size;\n}\n` +
      `const acc = new Set<string>().add("a");\nconsole.log(reset(acc), acc.size);\n`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.exitCode).toBe(0);
  });

  /* The CHAINED rebind roots at the same parameter and is caught too. */
  test("`out = out.add(a).add(b)` on a parameter is refused", () => {
    const r = rejectionOf(
      `function collect(out: Set<string>): void {\n  out = out.add("a").add("b");\n}\nconst acc = new Set<string>();\ncollect(acc);\nconsole.log(acc.size);\n`,
    );
    expect(r?.code).toBe("NT1606");
  });

  /*
   * A LOCAL rebind is the whole point of the persistent model and must stay legal — this
   * is the 12-site group in `src/` for which the ROADMAP's advice was always correct.
   */
  test("rebinding a LOCAL from its own mutator still compiles and matches node", async () => {
    const src =
      `let s = new Set<string>();\nfor (const n of ["a", "b", "c"]) { s = s.add(n); }\nconsole.log(s.size);\n`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.exitCode).toBe(0);
  });

  /*
   * THE SANCTIONED SPELLING, end to end, against node. This is what the new hint tells
   * you to write, so it has to actually work — a hint is only as good as the program it
   * produces, which is the failure this whole block exists to close.
   */
  test("the LOCAL-seeded-from-the-parameter spelling the hint names matches node", async () => {
    const src =
      `function collect(names: string[], out: Set<string>): Set<string> {\n` +
      `  let r = out;\n  for (const n of names) { r = r.add(n); }\n  return r;\n}\n` +
      `let acc = new Set<string>();\nacc = collect(["a", "b", "c"], acc);\nconsole.log(acc.size);\n`;
    expect(rejectionOf(src)).toBeNull();
    const r = await compileAndRun(src);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.stdout).toBe("3\n");
    expect(r.exitCode).toBe(0);
  });
});
