class P { constructor(private n: number) {} get(): number { return this.n; } }
let t = 0;
for (let i = 0; i < 200; i++) { t = t + new P(7).get(); }
for (let i = 0; i < 200; i++) { t = t + [1, 2, 3].indexOf(2); }
console.log(t);
console.log("obj", __objLive(), "arr", __arrLive());
