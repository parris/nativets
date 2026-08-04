const a = JSON.parse('[1,2,3]') as number[];
console.log(a.length, a[2]);
const e = JSON.parse('[]') as number[];
console.log(e.length);
const g = JSON.parse('[[1,2],[3,4]]') as number[][];
console.log(g[1][0]);
const ps = JSON.parse('[{"x":1,"y":2},{"x":3,"y":4}]') as { x: number; y: number }[];
console.log(ps[1].y);
