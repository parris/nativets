class Counter {
  n: number;
  constructor(n: number) { this.n = n; }
  bump(d: number): number { { const n: number = d * 2; return this.n + n; } }
}
const n: number = 1;
const c = new Counter(10);
console.log(c.bump(3));
console.log(n);
