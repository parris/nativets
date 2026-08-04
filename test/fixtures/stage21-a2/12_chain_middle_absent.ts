const o: { a?: { b?: { c: number } } } = { a: {} };
console.log(o.a?.b?.c);
