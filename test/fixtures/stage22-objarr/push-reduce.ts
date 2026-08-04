const items = [{ n: 1 }, { n: 2 }];
items.push({ n: 3 });
items.push({ n: 4 });
console.log(items.length);
for (const it of items) console.log(it.n);

const total = items.reduce((acc, it) => acc + it.n, 0);
console.log(total);

const last = items.pop();
console.log(last.n, items.length);
