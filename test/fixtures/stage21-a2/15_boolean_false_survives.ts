const o: { flag?: boolean } = { flag: false };
console.log(o.flag ?? true);
const p: { flag?: boolean } = {};
console.log(p.flag ?? true);
