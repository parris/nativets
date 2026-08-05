// Map<string,string>: string values ride the same i64 value slot as numbers.
// Immutable — chain off the returned handle so node's mutable Map matches.
const m = new Map<string, string>();
const m2 = m.set("hello", "world").set("foo", "bar");
console.log(m2.get("hello"), m2.get("foo"), m2.has("foo"), m2.size);
