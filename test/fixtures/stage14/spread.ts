const a = [1, 2, 3];
const b = [0, ...a, 4, ...a];
console.log(b.join(","));
function add3(x: number, y: number, z: number): number { return x + y + z; }
const args: [number, number, number] = [4, 5, 6];
console.log(add3(...args), Math.max(...[3, 9, 2, 7]));
const base = { a: 1, b: 2 };
const merged = { ...base, c: 3, b: 9 };
console.log(merged.a, merged.b, merged.c);
