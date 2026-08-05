// `.get` → `V | undefined` for string and object value types.
type Pt = { x: number; y: number };
const s = new Map<string, string>().set("hi", "world");
console.log(s.get("hi"));                 // world
console.log(s.get("nope"));               // undefined
console.log(s.get("nope") ?? "fallback"); // fallback
console.log(s.get("hi") ?? "fallback");   // world

const m = new Map<string, Pt>().set("origin", { x: 3, y: 4 });
const hit = m.get("origin") ?? { x: 0, y: 0 };
const miss = m.get("gone") ?? { x: -1, y: -1 };
console.log(hit.x, hit.y, miss.x, miss.y); // 3 4 -1 -1
