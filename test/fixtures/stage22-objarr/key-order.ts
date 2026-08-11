// ECMA-262 `OrdinaryOwnPropertyKeys`: every ARRAY-INDEX key enumerates first in ascending
// NUMERIC order, then every other key in insertion order. An object here is a flat slot
// array whose layout IS its type string, so this is one canonical order read back by all
// four enumeration sites — `Object.keys`, `for-in`, `JSON.stringify` and `console.log`.

// POSITIVES — canonical indices, ascending numerically (not lexicographically: 2 < 10).
const p = { z: 1, "10": 2, "0": 3, "2": 4, "1": 5, y: 6, "4294967294": 7, "999999999": 8 };
console.log(JSON.stringify(Object.keys(p)));
console.log(JSON.stringify(p));

// NEGATIVES — an array index is a string P with `ToString(ToUint32(P)) === P`, which is far
// narrower than "looks numeric". Each of these fails that round trip, so each keeps its
// INSERTION position. A fix that sorts anything numeric-ish reorders every one of them.
const n = { m: 1, "01": 2, "1.5": 3, "-1": 4, "4294967295": 5, "1e2": 6, "+1": 7, "00": 8, "-0": 9, "0x10": 10, k: 11 };
console.log(JSON.stringify(Object.keys(n)));
console.log(JSON.stringify(n));

// The exact boundary: 2**32-1 is excluded by the spec, 2**32-2 is an index.
const b = { w: 1, "4294967295": 2, "4294967294": 3 };
console.log(JSON.stringify(Object.keys(b)));

// All four enumeration sites agree — for-in and console.log, not just keys/JSON.
const f = { d: 1, "3": 2, c: 3, "1": 4 };
let acc = "";
for (const k in f) acc += k + ",";
console.log(acc);
console.log(f);
console.log(JSON.stringify(Object.values(f)));

// Canonical at every nesting depth.
console.log(JSON.stringify({ outer: { q: 1, "5": 2, "0": 3 }, "7": 4, a: 5 }));

// A spread rebuilds the key set, so the RESULT is canonical rather than spread-ordered.
const s1 = { b: 1, "2": 2 };
console.log(JSON.stringify({ ...s1, a: 3, "1": 4 }));
