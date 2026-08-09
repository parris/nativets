class P { constructor(public n: number) {} pick(a: number[]): number[] { return a; } }
const a = [1,2,3];
const r = new P(1).pick(a);
console.log(r[0], __objLive(), __arrLive());
