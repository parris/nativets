const o: { a?: { c: number } } = {};
console.log(o.a?.c ?? -1);
const p: { a?: { c: number } } = { a: { c: 9 } };
console.log(p.a?.c ?? -1);
