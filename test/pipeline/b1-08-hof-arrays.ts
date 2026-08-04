function scale(xs: number[], k: number): number[] { return xs.map((x) => x * k); }
function sumAll(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }

const r = [1, 2, 3] |> scale(10) |> sumAll();
console.log(r);
