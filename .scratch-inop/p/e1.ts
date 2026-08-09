class Box { constructor(public p: P) {} }
class P { constructor(public n: number) {} wrap(): Box { return new Box(this); } }
const b = new P(3).wrap();
console.log(b.p.n);
