// Immutable Map: `.set` returns the (new) map, so chaining + reading the
// returned value matches node's mutable Map observably (B2 "use the return value").
const m = new Map<string, number>();
const m2 = m.set("a", 1).set("b", 2);
console.log(m2.get("a"), m2.get("b"), m2.size);
