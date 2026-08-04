//@ check-pass
// Moving a linear value into a new owner, with no later use of the source, is fine.
const a: number[] = [1, 2, 3];
const b = move(a);
console.log(b.length);
