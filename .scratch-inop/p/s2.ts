//@@mutable
class P { constructor(public n: number) {} bump(): P { this.n = this.n + 1; return this; } }
console.log(new P(1).bump().n);
