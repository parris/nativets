function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }

const r = mul(add(2, 3), 4);
console.log(r);
