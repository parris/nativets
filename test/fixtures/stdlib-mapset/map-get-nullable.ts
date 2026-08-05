// Map#get returns V | undefined (A2 nullable): a hit yields the value, a miss
// yields undefined (node prints `undefined`), and `?? fallback` recovers.
const m = new Map<string, number>();
const m2 = m.set("a", 1).set("b", 2);
console.log(m2.get("a"), m2.get("b")); // 1 2
console.log(m2.get("missing"));        // undefined
console.log(m2.get("missing") ?? 99);  // 99
console.log(m2.get("a") ?? 99);        // 1
