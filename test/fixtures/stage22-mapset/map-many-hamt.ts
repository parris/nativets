// Cross the small-flat → HAMT promotion boundary (~32) by building 50 entries,
// re-binding the immutable map each `.set`. Exercises the Bagwell trie via codegen.
let m = new Map<string, number>();
for (let i = 0; i < 50; i = i + 1) { m = m.set("k" + i, i * i); }
console.log(m.size, m.get("k0"), m.get("k7"), m.get("k49"), m.has("k25"), m.has("k50"));
