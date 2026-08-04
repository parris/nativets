/*
 * B2 immutable Map/Set — the "sharp turn" DIVERGENCE from JS's mutable Map/Set:
 * `.set`/`.add`/`.delete` return a NEW handle and leave the source UNCHANGED
 * (persistent, structural-sharing via nt_hamt). node's Map/Set mutate in place,
 * so these "old version unchanged" behaviors cannot be node-differential — they
 * are compile-and-run + assert (like drops/actors tests). The observable-equal
 * cases (use the returned value) live under test/fixtures/stage22-mapset/.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";

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
