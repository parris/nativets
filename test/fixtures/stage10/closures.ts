function applyTwice(f: (n: number) => number, x: number): number {
  return f(f(x));
}
console.log(applyTwice((n) => n + 1, 4));
console.log(applyTwice((n) => n * 3, 2));
const base: number = 100;
const add = (x: number) => base + x;
console.log(add(5), add(23));
const scale: number = 10;
const g = (v: number) => v * scale + base;
console.log(g(1), g(2));
