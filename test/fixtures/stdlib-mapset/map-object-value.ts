// Map<string, {x:number,y:number}>: object values ride the i64 slot as a heap ref.
type Pt = { x: number; y: number };
const m = new Map<string, Pt>();
const m2 = m.set("origin", { x: 0, y: 0 }).set("unit", { x: 1, y: 1 });
const o = m2.get("origin");
const u = m2.get("unit");
console.log(o.x, o.y, u.x, u.y, m2.size);
