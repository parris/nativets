//@ check-pass
// Reassigning a moved binding re-initializes it (revival), so later use is fine.
let a: number[] = [1, 2, 3];
const b = move(a);
a = [4, 5];
console.log(a.length, b.length);
