const s = new Set<string>(); s.add("a");
const m = new Map<string, string>(); m.set("a", "1");
const u = new Uint8Array(2);
function f(x: number): number { return x; }
// object field
console.log(JSON.stringify({ v: s, ok: 1 }));
console.log(JSON.stringify({ v: m, ok: 1 }));
console.log(JSON.stringify({ v: u, ok: 1 }));
console.log(JSON.stringify({ v: f, ok: 1 }));
// array element
console.log(JSON.stringify([s]));
console.log(JSON.stringify([m]));
console.log(JSON.stringify([u]));
console.log(JSON.stringify([f]));
