function scale(xs: number[], k: number): number[] { return xs.map((x) => x * k); }
function sumAll(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }

const r = sumAll(scale([1, 2, 3], 10));
console.log(r);
