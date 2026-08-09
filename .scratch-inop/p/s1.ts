//@@mutable
class P { constructor(public n: number) {} keep(): number { G = this; return 1; } }
let G: P | null = null;
console.log(new P(1).keep());
