// Map<string,boolean>: boolean values (zext i1 -> i64 slot, trunc back).
const m = new Map<string, boolean>();
const m2 = m.set("on", true).set("off", false);
console.log(m2.get("on"), m2.get("off"), m2.has("on"), m2.size);
