/*
 * Collections lane — Map/Set ITERATION (insertion-ordered) + the ordering
 * primitives (`.toSorted`/`.toReversed`, string relational compare).
 *
 * ORDER IS THE WHOLE POINT: node guarantees Map/Set iterate in INSERTION order,
 * while our storage (nt_hamt) is hash/sorted-ordered. nt_mapset.c therefore keeps
 * a persistent insertion-order key log next to the HAMT, so `for-of` matches node
 * byte-for-byte. Every iteration case here is node-differential (the oracle),
 * except the ones that would need node's MUTATING `.delete` — those compare our
 * persistent program against node running the equivalent mutating program.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";
import { readFileSync } from "node:fs";

/** Compile+run ours and assert stdout/exit match `node` on the same source. */
async function matchesNode(src: string): Promise<string> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

/** The NT code a source is rejected with (or null if it compiles). */
function codeOf(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

/**
 * Lift a top-level declaration VERBATIM out of a real `src/*.ts` file, so the
 * self-hosting gates below test the compiler's own table rather than a copy of it
 * that can drift. Scans to the terminating `;` at bracket depth 0 and drops the
 * `export`. Read with readFileSync, never shell `grep` (project memory: the shimmed
 * grep on some setups silently misses matches, which would make these vacuous).
 */
function liftDecl(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  let end = at, depth = 0;
  for (; end < src.length; end++) {
    const c = src[end]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) { end++; break; }
  }
  const decl = src.slice(at, end);
  return decl.startsWith("export ") ? decl.slice("export ".length) : decl;
}

describe("Map/Set iteration (insertion order)", () => {
  test("for (const k of map.keys()) iterates in insertion order, not hash order", async () => {
    // Deliberately NOT sorted and NOT hash-ordered: node prints z, a, m.
    const src = `
const m = new Map<string, number>().set("z", 1).set("a", 2).set("m", 3);
for (const k of m.keys()) console.log(k);`;
    expect(await matchesNode(src)).toBe("z\na\nm\n");
  });

  test("for (const v of map.values()) follows the same insertion order", async () => {
    const src = `
const m = new Map<string, number>().set("z", 10).set("a", 20).set("m", 30);
let total = 0;
for (const v of m.values()) { console.log(v); total = total + v; }
console.log("total", total);`;
    expect(await matchesNode(src)).toBe("10\n20\n30\ntotal 60\n");
  });

  test("number keys iterate in insertion order (not numeric/hash order)", async () => {
    const src = `
const m = new Map<number, string>().set(30, "c").set(4, "a").set(17, "b");
for (const k of m.keys()) console.log(k, m.get(k));`;
    await matchesNode(src);
  });

  test("re-setting an existing key keeps its ORIGINAL position (node semantics)", async () => {
    const src = `
let m = new Map<string, number>().set("a", 1).set("b", 2).set("c", 3);
m = m.set("a", 99); // update in place, position must NOT move to the end
for (const k of m.keys()) console.log(k);
for (const v of m.values()) console.log(v);`;
    expect(await matchesNode(src)).toBe("a\nb\nc\n99\n2\n3\n");
  });

  test("for (const v of set) and set.values() iterate in insertion order", async () => {
    const src = `
const s = new Set<string>().add("pear").add("apple").add("fig").add("pear");
for (const v of s) console.log(v);
for (const v of s.values()) console.log(v.length);
console.log(s.size);`;
    expect(await matchesNode(src)).toBe("pear\napple\nfig\n4\n5\n3\n3\n"); // dup "pear" not re-added
  });

  test("for (const [k, v] of map.entries()) binds both, in insertion order", async () => {
    const src = `
const m = new Map<string, number>().set("z", 1).set("a", 2).set("m", 3);
for (const [k, v] of m.entries()) console.log(k, v);`;
    expect(await matchesNode(src)).toBe("z 1\na 2\nm 3\n");
  });

  test("for (const [k, v] of map) — the default iterator is entries", async () => {
    const src = `
const scores = new Map<string, number>().set("ada", 3).set("bob", 1);
let report = "";
for (const [name, score] of scores) { report = report + name + "=" + score + ";"; }
console.log(report);`;
    expect(await matchesNode(src)).toBe("ada=3;bob=1;\n");
  });

  test("Array.from(map.keys()) / [...map.keys()] produce real arrays that compose with HOFs", async () => {
    const src = `
const m = new Map<string, number>().set("z", 1).set("a", 2).set("m", 3);
const ks = Array.from(m.keys());
console.log(ks.length, ks[0], ks.join("|"));
const vs = [...m.values()];
console.log(vs.map((x: number) => x * 10).join(","));
const upper = [...m.keys()].filter((k: string) => k !== "a");
console.log(upper.join("+"));
const es = [...new Set<number>().add(5).add(1).add(5).add(9)];
console.log(es.join(","), es.reduce((a: number, b: number) => a + b, 0));`;
    expect(await matchesNode(src)).toBe("3 z z|a|m\n10,20,30\nz+m\n5,1,9 15\n");
  });

  // `.delete` is our documented Phase-B divergence (returns a NEW collection, node
  // returns a boolean and mutates), so these cannot run the SAME source under node.
  // Instead node runs the equivalent MUTATING program — still the oracle for ORDER.
  test("delete-then-re-add moves the key to the END (node's re-insert order)", async () => {
    const ours = `
let m = new Map<string, number>().set("a", 1).set("b", 2).set("c", 3);
m = m.delete("b");
m = m.set("b", 20);
for (const [k, v] of m) console.log(k, v);
console.log(m.size);`;
    const nodeEquivalent = `
const m = new Map();
m.set("a", 1); m.set("b", 2); m.set("c", 3);
m.delete("b");
m.set("b", 20);
for (const [k, v] of m) console.log(k, v);
console.log(m.size);`;
    const oracle = runWithNode(nodeEquivalent);
    const r = await compileAndRun(ours);
    expect(r.stdout).toBe(oracle.stdout);
    expect(r.stdout).toBe("a 1\nc 3\nb 20\n3\n");
  });

  test("the insertion-order log is PERSISTENT: older versions keep their own order", async () => {
    // m1's log must be unaffected by m2's append and by m3's removal (path copying
    // of the key log, exactly like the HAMT itself).
    const src = `
const m1 = new Map<string, number>().set("a", 1).set("b", 2);
const m2 = m1.set("c", 3);
const m3 = m1.delete("a");
const m4 = m1.set("z", 26); // a SECOND child of m1 — must not see "c"
let s1 = ""; for (const k of m1.keys()) s1 = s1 + k;
let s2 = ""; for (const k of m2.keys()) s2 = s2 + k;
let s3 = ""; for (const k of m3.keys()) s3 = s3 + k;
let s4 = ""; for (const k of m4.keys()) s4 = s4 + k;
console.log(s1, s2, s3, s4);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("ab abc b abz\n");
    expect(r.exitCode).toBe(0);
  });

  test("iteration survives the flat→HAMT boundary (40 keys, still insertion order)", async () => {
    const src = `
let m = new Map<number, number>();
for (let i = 39; i >= 0; i = i - 1) { m = m.set(i, i * 2); }
let out = "";
for (const k of m.keys()) out = out + k + ",";
console.log(out);
let sum = 0;
for (const v of m.values()) sum = sum + v;
console.log(sum, m.size);`;
    await matchesNode(src);
  });
});

/*
 * String relational compare. node compares UTF-16 CODE UNITS; our strings are
 * UTF-8 bytes, and byte order == code-point order, so the two agree everywhere
 * except a string containing an astral (>= U+10000) character compared against one
 * containing U+E000..U+FFFF at the same position (documented in docs/divergences.md).
 * Everything tested here is in the agreeing range.
 */
describe("string relational comparison (< <= > >=)", () => {
  test("ASCII ordering matches node, including prefixes, case and digits", async () => {
    const src = `
console.log("apple" < "banana", "banana" < "apple");
console.log("app" < "apple", "apple" <= "apple", "apple" < "apple");
console.log("Zebra" < "apple", "a" > "A", "10" < "9");
console.log("" < "a", "a" >= "", "abc" >= "abd");`;
    await matchesNode(src);
  });

  test("non-ASCII BMP ordering matches node (byte order == code-point order)", async () => {
    const src = `
console.log("café" < "cafz", "éclair" > "zebra", "ä" < "ö");`;
    await matchesNode(src);
  });

  test("comparison drives real code (max-by-name over an array)", async () => {
    const src = `
const names = ["pear", "apple", "fig", "banana"];
let best = names[0];
for (const n of names) { if (n > best) best = n; }
console.log(best);`;
    await matchesNode(src);
  });
});

/*
 * Ordering primitives. Arrays are immutable here (Stage 29), and node's `.sort()`
 * SORTS IN PLACE — so we implement the genuinely non-mutating ES2023 pair
 * `.toSorted()` / `.toReversed()` (real node methods, so node stays the oracle)
 * and refuse `.sort()` with a pointer at them. Sorting is STABLE, like node's.
 */
describe("toSorted / toReversed (ES2023, non-mutating — node is the oracle)", () => {
  test("default .toSorted() compares STRING forms, exactly like node", async () => {
    const src = `
const nums = [10, 9, 1, 100, 2, -3];
console.log(nums.toSorted().join(","));   // string compare: -3,1,10,100,2,9
console.log(nums.join(","));              // source untouched
const words = ["pear", "Apple", "fig", "apple"];
console.log(words.toSorted().join(","));`;
    await matchesNode(src);
  });

  test(".toSorted(cmp) with an inline arrow — numeric and reverse-numeric", async () => {
    const src = `
const nums = [10, 9, 1, 100, 2, -3];
console.log(nums.toSorted((a: number, b: number) => a - b).join(","));
console.log(nums.toSorted((a: number, b: number) => b - a).join(","));
const words = ["pear", "fig", "banana"];
console.log(words.toSorted((a: string, b: string) => a.length - b.length).join(","));`;
    await matchesNode(src);
  });

  test(".toSorted(cmp) accepts a comparator held in a variable (a closure value)", async () => {
    const src = `
const byLen = (a: string, b: string) => a.length - b.length;
const words = ["pear", "fig", "banana", "kiwi"];
console.log(words.toSorted(byLen).join(","));
const factor = -1; // captured by the comparator
const desc = (a: number, b: number) => (a - b) * factor;
console.log([3, 1, 2].toSorted(desc).join(","));`;
    await matchesNode(src);
  });

  test("sorting is STABLE (equal keys keep their input order), like node", async () => {
    const src = `
const people = [
  { name: "ada", age: 36 },
  { name: "bob", age: 24 },
  { name: "cat", age: 36 },
  { name: "dan", age: 24 },
  { name: "eve", age: 36 },
];
const byAge = people.toSorted((a: { name: string, age: number }, b: { name: string, age: number }) => a.age - b.age);
let out = "";
for (const p of byAge) out = out + p.name + ":" + p.age + " ";
console.log(out);`;
    await matchesNode(src);
  });

  test(".toSorted() on strings composes with Map iteration (sorted key report)", async () => {
    const src = `
const m = new Map<string, number>().set("pear", 2).set("apple", 5).set("fig", 1);
for (const k of [...m.keys()].toSorted()) console.log(k, m.get(k));`;
    await matchesNode(src);
  });

  test(".toReversed() returns a NEW reversed array; the source is untouched", async () => {
    const src = `
const a = [1, 2, 3, 4];
const b = a.toReversed();
console.log(b.join(","), a.join(","), a === b);
const s = ["x", "y", "z"];
console.log(s.toReversed().join(""), s.join(""));`;
    await matchesNode(src);
  });

  test("empty and single-element arrays sort/reverse like node", async () => {
    const src = `
const one = [42];
console.log(one.toSorted().join(","), one.toReversed().join(","));
const two = ["b", "a"];
console.log(two.toSorted().join(","), two.toSorted((x: string, y: string) => (x < y ? 1 : -1)).join(","));`;
    await matchesNode(src);
  });

  test("a BLOCK-bodied comparator compiles (lifted arrows must not drop enclosing locals)", async () => {
    // Regression: the ownership pass attaches the ENCLOSING scope's drop list to a
    // `return` inside a block-bodied arrow; the lifted @arrow_N then loaded an
    // undefined `%words.addr`. Lifted arrows now emit no enclosing-scope drops.
    const src = `
const words: string[] = ["pear", "fig", "banana"];
const ranked = words.toSorted((a: string, b: string) => {
  if (a.length !== b.length) { return a.length - b.length; }
  return a < b ? -1 : (a > b ? 1 : 0);
});
console.log(ranked.join(","), words.join(","));`;
    await matchesNode(src);
  });

  test("`.sort()` is refused (it mutates) with a pointer at `.toSorted()`", () => {
    expect(codeOf("const a = [3, 1, 2];\na.sort();")).toBe("NT1606");
    expect(codeOf("const a = [3, 1, 2];\na.sort((x: number, y: number) => x - y);")).toBe("NT1606");
  });
});

/*
 * `new Set(iterable)` — bulk construction.
 *
 * PROVENANCE: these cases are DERIVED, not mined. There is no test262 checkout on this
 * machine, so `test/built-ins/Set/` was never opened and is not cited. Every expected
 * value below comes from running the case under `node` (the project's oracle) — which
 * is why each one goes through `matchesNode` rather than a hand-written literal alone.
 *
 * Construction is fully node-differential: the CONSTRUCTED set is identical to node's.
 * Only the later `.add`/`.delete` are the B2 persistence divergence.
 */
describe("new Set(iterable)", () => {
  test("new Set([1,2,3]) has node's size and iterates in insertion order", async () => {
    const src = `
const s = new Set([3, 1, 2]);
console.log(s.size);
for (const v of s) console.log(v);`;
    expect(await matchesNode(src)).toBe("3\n3\n1\n2\n");
  });

  test("duplicates dedupe and the FIRST occurrence keeps its position", async () => {
    // Size counts distinct elements. The position rule is node's: re-adding an
    // existing element does not move it, so "b" stays at index 1 even though it
    // appears again after "c". Expected values DERIVED from running node (below),
    // not mined from a reference suite — see the header note.
    const src = `
console.log(new Set([1, 2, 2, 3]).size);
for (const v of new Set(["a", "b", "c", "b", "a"])) console.log(v);`;
    expect(await matchesNode(src)).toBe("3\na\nb\nc\n");
  });

  test("the no-argument forms still work (`new Set()` / `new Set<number>()`)", async () => {
    const src = `
const bare = new Set<string>();
const nums = new Set<number>();
console.log(bare.size, nums.size);
console.log(bare.add("x").size, nums.add(1).add(1).size);`;
    expect(await matchesNode(src)).toBe("0 0\n1 1\n");
  });

  test("new Set(anotherSet) copies it, preserving the source's insertion order", async () => {
    const src = `
const a = new Set(["z", "a", "m"]);
const b = new Set(a);
console.log(b.size, b.has("a"), b.has("q"));
for (const v of b) console.log(v);`;
    expect(await matchesNode(src)).toBe("3 true false\nz\na\nm\n");
  });

  test("the copy is a FRESH handle — `new Set(a) === a` is false, as in node", async () => {
    // Our Set is persistent, so handing back the SAME NtColl would be unobservable
    // through .has/.size/iteration — but `===` on a Set is handle identity here, so
    // sharing would print `true` where node prints `false`. Copy, don't alias.
    const src = `
const a = new Set([1, 2]);
const b = new Set(a);
console.log(a === b, a === a);`;
    expect(await matchesNode(src)).toBe("false true\n");
  });

  test("SameValueZero: NaN dedupes against itself, and -0 is the same key as 0", async () => {
    // Set uses SameValueZero, so NaN matches itself for membership (unlike `===`) and
    // -0 is stored normalized to +0 — node prints the surviving element as `0`, never
    // `-0`, which `1 / v === Infinity` pins down. DERIVED from running node, not mined
    // from a reference suite — see the header note.
    const src = `
const nan = new Set([NaN, NaN, 0 / 0]);
console.log(nan.size, nan.has(NaN));
const zero = new Set([-0, 0]);
console.log(zero.size, zero.has(0), zero.has(-0));
for (const v of zero) console.log(v, 1 / v);
const negFirst = new Set([-0]);
for (const v of negFirst) console.log(v, 1 / v);`;
    expect(await matchesNode(src)).toBe("1 true\n1 true true\n0 Infinity\n0 Infinity\n");
  });

  test("a STRING argument is refused (NT1014) rather than iterated as bytes", () => {
    // node iterates a string by CODE POINT: `new Set("a😀b")` has size 3. Our string
    // for-of walks BYTES today, so building the set that way would give size 6 — a
    // silent wrong answer. The checker cannot prove a `string` is ASCII, so the
    // refusal is unconditional. Reject, never miscompile.
    expect(codeOf(`const s = new Set("abc");`)).toBe("NT1014");
    expect(codeOf(`const t = "abc"; const s = new Set(t);`)).toBe("NT1014");
    let msg = "";
    try { sourceToIR(`const s = new Set("abc");`); } catch (e) { msg = (e as NTError).message; }
    expect(msg).toContain("code point");
  });
});

/*
 * `new Map(iterable)` rode the SAME NT1014 line as `new Set(iterable)`, so it comes
 * along: the Map-copy form is now supported. The ENTRIES form stays refused — it needs
 * a tuple type we do not have (`["a", 1]` is already NT2001, "array elements must share
 * a type"), so it is a deeper blocker than this lane, not an oversight.
 */
describe("new Map(iterable)", () => {
  test("new Map(anotherMap) copies it, preserving insertion order", async () => {
    const src = `
const a = new Map<string, number>().set("z", 1).set("a", 2);
const b = new Map(a);
console.log(b.size, b.get("z"), b.get("a"), b.has("q"), a === b);
for (const k of b.keys()) console.log(k);`;
    expect(await matchesNode(src)).toBe("2 1 2 false false\nz\na\n");
  });

  test("the entries form stays refused (NT1014) — no tuple type yet", () => {
    let msg = "";
    try { sourceToIR(`const m = new Map([["a", 1]]);`); } catch (e) { msg = (e as NTError).message; }
    expect(msg).toContain("tuple");
  });

  /*
   * The entries form stays REFUSED, so the sanctioned spelling the diagnostic hands
   * back — a `.set` chain — has to be provably the SAME PROGRAM. It is, and the
   * reason is a spec fact rather than an accident: ES2024 24.1.3.9 step 8 is
   * "Return M", so `Map.prototype.set` returns the receiver. That makes
   * `new Map().set(k, v).set(…)` the exact desugaring the Map constructor itself
   * performs (24.1.1.1 step 8 calls `adder` = `set` once per entry, in order), and
   * it makes the rewrite FREE under bun/node — unlike `xs = [...xs, v]`, which this
   * project measured at 1036x for `.push`.
   *
   * Behaviours borrowed from tc39/test262:
   *   test/built-ins/Map/map-iterable.js                          — entries added in order
   *   test/built-ins/Map/empty-iterable.js, no-arguments.js       — size 0 both ways
   *   test/built-ins/Map/prototype/set/returns-this.js            — `set` returns M
   *   .../set/does-not-change-size-of-existing-key.js             — duplicate key, last wins
   *   .../set/append-new-values-normalizes-zero.js                — SameValueZero: -0 -> +0
   */
  test("the `.set` chain the hint prescribes IS the entries form — node runs both, identically", async () => {
    const entries = `
const m = new Map([["a", 1], ["b", 2], ["a", 3]]);
const z = new Map([[-0, "neg"], [0, "pos"]]);
console.log(m.size, m.get("a"), m.get("b"), m.has("c"));
for (const [k, v] of m) console.log(k, v);
console.log(z.size, z.get(0), 1 / [...z.keys()][0]);
console.log(new Map([]).size, new Map().size);`;
    const chained = `
const m = new Map<string, number>().set("a", 1).set("b", 2).set("a", 3);
const z = new Map<number, string>().set(-0, "neg").set(0, "pos");
console.log(m.size, m.get("a"), m.get("b"), m.has("c"));
for (const [k, v] of m) console.log(k, v);
console.log(z.size, z.get(0), 1 / [...z.keys()][0]!);
console.log(new Map<string, number>().size, new Map().size);`;
    // node on the REFUSED spelling is the oracle for nativets on the SANCTIONED one.
    const oracle = runWithNode(entries);
    const ours = await compileAndRun(chained);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    // Hand-computed as `3 3 2 …` / `2 pos …` and node corrected both: a duplicate key
    // does not grow the Map (test262 does-not-change-size-of-existing-key), and -0 and
    // 0 are ONE key whose stored form is +0 (append-new-values-normalizes-zero — hence
    // `1 / k` is Infinity, not -Infinity). The oracle is the specification.
    expect(oracle.stdout).toBe("2 3 2 false\na 3\nb 2\n1 pos Infinity\n0 0\n");
  });

  /*
   * The self-hosting gate. `DATE_GETTERS` in src/ast.ts was the FIRST blocker for five
   * of the twelve compiler modules (ast, parser, checker, ownership, modules — the last
   * four through the link). It is lifted verbatim out of the real file, so the day
   * someone writes the entries form back into it this goes red rather than the frontier
   * silently regressing. Read with readFileSync, never shell `grep` (project memory: the
   * shimmed grep on some setups silently misses matches, which would make this vacuous).
   */
  test("src/ast.ts's real DATE_GETTERS table compiles, and equals node's entries form", async () => {
    const src = readFileSync(new URL("../src/ast.ts", import.meta.url), "utf8");
    const decl = liftDecl(src, "export const DATE_GETTERS");
    const driver = `
console.log(DATE_GETTERS.size, DATE_GETTERS.has("toString"), DATE_GETTERS.has("getTime"));
for (const [k, g] of DATE_GETTERS) console.log(k, g.which, g.utc);`;
    // The oracle is the ENTRIES form of the same table under node — so this asserts the
    // rewrite is observationally null, not merely that the new spelling runs.
    const oracle = runWithNode(`const DATE_GETTERS = new Map<string, { which: number; utc: number }>([
  ["getFullYear", { which: 0, utc: 0 }], ["getMonth", { which: 1, utc: 0 }], ["getDate", { which: 2, utc: 0 }],
  ["getHours", { which: 3, utc: 0 }], ["getMinutes", { which: 4, utc: 0 }], ["getSeconds", { which: 5, utc: 0 }],
  ["getMilliseconds", { which: 6, utc: 0 }], ["getDay", { which: 7, utc: 0 }],
  ["getUTCFullYear", { which: 0, utc: 1 }], ["getUTCMonth", { which: 1, utc: 1 }], ["getUTCDate", { which: 2, utc: 1 }],
  ["getUTCHours", { which: 3, utc: 1 }], ["getUTCMinutes", { which: 4, utc: 1 }], ["getUTCSeconds", { which: 5, utc: 1 }],
  ["getUTCMilliseconds", { which: 6, utc: 1 }], ["getUTCDay", { which: 7, utc: 1 }],
]);${driver}`);
    const ours = await compileAndRun(decl + driver);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout.split("\n")[0]).toBe("16 false false");
  });

  /*
   * The same gate for `src/checker.ts`'s two tables. Between them they were the FIRST
   * blocker for SIX of the twelve modules — checker's OWN, inherited through the link
   * by codegen, coverage, ownership, driver and cli (= stage-1). Both are annotated
   * `ReadonlyMap<…>`, which is why the ReadonlyMap erasure below had to be fixed first.
   */
  test("src/checker.ts's real CONSOLE_STREAMS table compiles, and equals node's entries form", async () => {
    const src = readFileSync(new URL("../src/checker.ts", import.meta.url), "utf8");
    const decl = liftDecl(src, "export const CONSOLE_STREAMS");
    const driver = `
console.log(CONSOLE_STREAMS.size, CONSOLE_STREAMS.get("log"), CONSOLE_STREAMS.get("warn"), CONSOLE_STREAMS.has("table"));
for (const [m, s] of CONSOLE_STREAMS) console.log(m, s);`;
    // The oracle is the ENTRIES form of the same table under node — so this asserts the
    // rewrite is observationally null, not merely that the new spelling runs.
    const oracle = runWithNode(`const CONSOLE_STREAMS: ReadonlyMap<string, "out" | "err"> = new Map([
  ["log", "out"], ["info", "out"], ["debug", "out"],
  ["error", "err"], ["warn", "err"],
] as const);${driver}`);
    const ours = await compileAndRun(decl + driver);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("5 out err false\nlog out\ninfo out\ndebug out\nerror err\nwarn err\n");
  });

  test("src/checker.ts's real FMT_SPECS table compiles, and equals node's entries form", async () => {
    const src = readFileSync(new URL("../src/checker.ts", import.meta.url), "utf8");
    // The value type is the `FmtSpec` alias, so lift that verbatim too.
    const decl = liftDecl(src, "export type FmtSpec") + "\n" + liftDecl(src, "const FMT_SPECS");
    const driver = `
console.log(FMT_SPECS.size, FMT_SPECS.get("O"), FMT_SPECS.get("o"), FMT_SPECS.has("z"), FMT_SPECS.has("%"));
for (const [c, s] of FMT_SPECS) console.log(c, s);`;
    const oracle = runWithNode(`type FmtSpec = "s" | "d" | "i" | "f" | "j" | "o" | "O" | "c";
const FMT_SPECS: ReadonlyMap<string, FmtSpec> = new Map([
  ["s", "s"], ["d", "d"], ["i", "i"], ["f", "f"], ["j", "j"], ["o", "o"], ["O", "O"], ["c", "c"],
] as const);${driver}`);
    const ours = await compileAndRun(decl + driver);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    // Case matters — `%o` and `%O` are different specifiers in node's formatter.
    expect(oracle.stdout.split("\n")[0]).toBe("8 O o false false");
  });

  /*
   * The DYNAMIC entries site. `src/ownership.ts`'s `clone` built its result from a
   * MAP SPREAD (`new Map([...s].map(([k, v]) => [k, { ...v }]))`), which is the same
   * missing tuple type reached from the other side: spreading a Map yields
   * `[key, value]` pairs. Unlike the tables above, a `.set` CHAIN cannot express it —
   * the entries are not known at the source. The loop is what the constructor does
   * internally anyway (ES2024 24.1.1.1 §8 calls `set` once per entry, in order), so
   * the oracle is again node running the spelling nativets refuses.
   *
   * It was the first blocker for ownership.ts, driver.ts and cli.ts (= stage-1).
   */
  test("src/ownership.ts's real `clone` compiles, and equals node's Map-spread form", async () => {
    const src = readFileSync(new URL("../src/ownership.ts", import.meta.url), "utf8");
    const decl = liftDecl(src, "type VarState =") + "\n" +
      liftDecl(src, "type State =") + "\n" + liftDecl(src, "const clone =");
    const driver = `
const a: State = new Map<string, VarState>().set("x", { moved: true, must: false, at: 3 }).set("y", { moved: false, must: false });
const b = clone(a);
console.log(a.size, b.size, a === b, b.get("x")! === a.get("x")!);
for (const [k, v] of b) console.log(k, v.moved, v.must, v.at);`;
    const oracle = runWithNode(`type VarState = { moved: boolean; must: boolean; at?: number };
type State = Map<string, VarState>;
const clone = (s: State): State => new Map([...s].map(([k, v]) => [k, { ...v }]));${driver}`);
    const ours = await compileAndRun(decl + driver);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    // A SHALLOW copy: same keys and order, but every VarState is a fresh object.
    expect(oracle.stdout).toBe("2 2 false false\nx true false 3\ny false false undefined\n");
  });

  /*
   * PRE-EXISTING BUG, found while sizing the `.set`-chain rewrite of `src/checker.ts`'s
   * two entries-form tables — both are annotated `ReadonlyMap<…>`.
   *
   * `parseGenericType` (src/parser.ts) maps `ReadonlyArray<T>` to `T[]` but has no case
   * for `ReadonlyMap`/`ReadonlySet`, so they fall through `default: resolveNamed(id)` and
   * an unknown named type erases to **`number`**. The result is a program node runs and
   * we reject, with a diagnostic that names a type nobody wrote:
   *     'm' declared number but initialized with Map<string,number>
   * A refusal rather than a miscompile, but the erasure is a guess, and the sibling
   * `ReadonlyArray` case one line above shows what the intended answer is.
   */
  test("ReadonlyMap / ReadonlySet are the Map / Set they say they are (not `number`)", async () => {
    expect(await matchesNode(`
const m: ReadonlyMap<string, number> = new Map<string, number>().set("a", 1).set("b", 2);
const s: ReadonlySet<string> = new Set<string>().add("x").add("y");
console.log(m.size, m.get("b"), m.has("z"), s.size, s.has("x"));
for (const [k, v] of m) console.log(k, v);`)).toBe("2 2 false 2 true\na 1\nb 2\n");
    // The sibling that already worked, pinned so the three stay consistent.
    expect(await matchesNode(`
const xs: ReadonlyArray<number> = [3, 1, 2];
console.log(xs.length, xs.toSorted().join(","));`)).toBe("3 1,2,3\n");
  });
});

describe("Map/Set iteration — what is refused (reject, never miscompile)", () => {
  const M = 'const m = new Map<string, number>().set("a", 1);\n';
  const S = "const s = new Set<number>().add(1);\n";

  test("an iterator OUTSIDE for-of / Array.from / spread is NT1014, not a fake array", () => {
    // node: `m.keys()` is a lazy Map Iterator — `.length` is undefined, `[0]` is
    // undefined. Ours is a real array, so allowing this would silently diverge.
    expect(codeOf(M + "console.log(m.keys().length);")).toBe("NT1014");
    expect(codeOf(M + "const ks = m.keys();")).toBe("NT1014");
    expect(codeOf(S + "console.log(s.values().length);")).toBe("NT1014");
  });

  test("`.entries()` outside `for (const [k, v] of …)` is NT1014 (no tuple type)", () => {
    expect(codeOf(M + "const es = [...m.entries()];")).toBe("NT1014");
  });

  test("for-of / spread over a Map with a single binding is NT1014 (node yields pairs)", () => {
    expect(codeOf(M + "for (const x of m) console.log(x);")).toBe("NT1014");
    expect(codeOf(M + "const a = [...m];")).toBe("NT1014");
    expect(codeOf(M + "const a = Array.from(m);")).toBe("NT1014");
  });

  test(".forEach is refused with a pointer at the insertion-ordered for-of", () => {
    expect(codeOf(M + "m.forEach((v: number, k: string) => console.log(k, v));")).toBe("NT1014");
    expect(codeOf(S + "s.forEach((v: number) => console.log(v));")).toBe("NT1014");
  });
});
