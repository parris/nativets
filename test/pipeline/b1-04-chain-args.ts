function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }

const r = 2 |> add(3) |> mul(4);
console.log(r);
