class P { constructor(public n: number) {} self(): P[] { return [this]; } }
const a = new P(3).self();
console.log(a[0].n);
