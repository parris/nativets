function outer(n: number): number {
  const t: number = n;
  let sum: number = 0;
  for (let i = 0; i < 3; i++) {
    const t: number = i * 10;
    if (t > 5) {
      const t: number = 1000;
      sum = sum + t;
    } else {
      const t: string = "z";
      sum = sum + t.length;
    }
    sum = sum + t;
  }
  return sum + t;
}
console.log(outer(7));
try {
  const t: number = 1;
  throw "e";
} catch (t) {
  console.log(t);
} finally {
  const t: number = 9;
  console.log(t);
}
const m: Map<string, number> = new Map<string, number>();
for (const [k, v] of m) { console.log(k, v); }
{ const k: string = "kk"; console.log(k); }
