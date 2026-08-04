//@ check-pass
// Scalar elements are Copy — indexing reads a copy, not a move out of the array.
const ns: number[] = [1, 2, 3];
const first = ns[0];
console.log(first, ns[1], ns.length);
