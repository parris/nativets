// Map<number,string>: number keys with string values (both non-default).
const m = new Map<number, string>();
const m2 = m.set(10, "ten").set(20, "twenty");
console.log(m2.get(10), m2.get(20), m2.size);
