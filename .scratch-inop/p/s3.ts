class P { constructor(public xs: number[]) {} f(): number[] { return this.xs; } }
const r = new P([1,2,3]).f();
console.log(r[0], __objLive(), __arrLive());
