//@@mutable
class P {
  constructor(public n: number) {}
  get(): number { return this.n; }
}
let g: P | null = null;
function keep(p: P): number { g = p; return 1; }
const x = new P(5);
console.log(keep(x));
