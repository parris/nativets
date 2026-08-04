// `.has` membership + `.set` overwrite-on-existing-key (size stays the same),
// and `.get` reflecting the overwrite — all observable identically under node.
const m = new Map<string, number>().set("x", 10).set("y", 20).set("x", 99);
console.log(m.get("x"), m.has("y"), m.has("z"), m.size);
