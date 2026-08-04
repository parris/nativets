const o: { name?: string } = {};
console.log(o.name ?? "none");
console.log(o.name?.length ?? 0);
const p: { name?: string } = { name: "hi" };
console.log(p.name ?? "none");
console.log(p.name?.length ?? 0);
