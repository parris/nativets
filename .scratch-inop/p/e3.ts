class P { constructor(public n: number) {} id(q: P): number { return q.n; } via(): number { return this.id(this); } }
console.log(new P(4).via());
