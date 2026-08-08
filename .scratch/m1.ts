const s = new Set<string>(); s.add("a");
const m = new Map<string, string>(); m.set("a", "1");
const u = new Uint8Array(2);
function f(x: number): number { return x; }
console.log(JSON.stringify(s));
console.log(JSON.stringify(m));
console.log(JSON.stringify(u));
console.log(JSON.stringify(f));
