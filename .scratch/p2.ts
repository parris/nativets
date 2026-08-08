const a: number | null = 1;
const b: number | null = null;
const xs: (number | null)[] = [a, b];
console.log(JSON.stringify(xs));
console.log(JSON.stringify({ a: [{ b: [1, 2] }, { b: [3] }] }));
