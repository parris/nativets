// Chained immutable updates: each .with returns a fresh array; every prior
// version stays independently valid (persistent versions coexist).
const v0: number[] = [1, 2, 3];
const v1: number[] = v0.with(0, 100);
const v2: number[] = v1.with(2, 300);
console.log(v0.join(","));
console.log(v1.join(","));
console.log(v2.join(","));
console.log(v0 === v1, v1 === v2);
