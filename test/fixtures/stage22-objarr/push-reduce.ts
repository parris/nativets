// Immutable model: build the object array by spreading, never `.push` (which would
// mutate in place — NT1606). `items` is a value; the original `base` is unchanged.
const base = [{ n: 1 }, { n: 2 }];
const items = [...base, { n: 3 }, { n: 4 }];
console.log(items.length);
for (const it of items) console.log(it.n);

const total = items.reduce((acc, it) => acc + it.n, 0);
console.log(total);

console.log(items[items.length - 1].n, items.length);
