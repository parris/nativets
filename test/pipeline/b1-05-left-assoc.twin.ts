function inc(n: number): number { return n + 1; }
function dbl(n: number): number { return n * 2; }
function neg(n: number): number { return -n; }

const r = neg(dbl(inc(1)));
console.log(r);
