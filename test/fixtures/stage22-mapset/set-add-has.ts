// Immutable Set: `.add` returns the (new) set, so chaining + reading it matches
// node's mutable Set observably. Duplicate add is idempotent (size unchanged).
const s = new Set<string>().add("a").add("b").add("a"); // dup "a"
console.log(s.has("a"), s.has("b"), s.has("c"), s.size);
