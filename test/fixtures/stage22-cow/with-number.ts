// Array.prototype.with (ES2023): returns a NEW array with index i replaced;
// the receiver is UNCHANGED. Real node — the differential oracle.
const a: number[] = [10, 20, 30];
const b: number[] = a.with(1, 99);
console.log(b.join(","));
console.log(a.join(","));
console.log(a.length, a === b);
console.log(a[1], b[1]);
