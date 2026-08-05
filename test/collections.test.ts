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

  test("`.sort()` is refused (it mutates) with a pointer at `.toSorted()`", () => {
    expect(codeOf("const a = [3, 1, 2];\na.sort();")).toBe("NT1606");
    expect(codeOf("const a = [3, 1, 2];\na.sort((x: number, y: number) => x - y);")).toBe("NT1606");
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
