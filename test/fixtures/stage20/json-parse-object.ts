const p = JSON.parse('{"x":1,"y":2}') as { x: number; y: number };
console.log(p.x + p.y);
const q = JSON.parse('{"x":1,"y":2,"z":99}') as { x: number; y: number };
console.log(q.x + q.y);
const c = JSON.parse('{"center":{"x":0,"y":2},"r":5}') as { center: { x: number; y: number }; r: number };
console.log(c.center.x + c.center.y + c.r);
const u = JSON.parse('{"name":"ann","admin":true}') as { name: string; admin: boolean };
console.log(u.name, u.admin);
