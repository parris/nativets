const o: { x?: number } = {};
console.log((o.x ?? 3) + 1);
const t: { name?: string } = {};
console.log(`hello ${t.name ?? "world"}`);
