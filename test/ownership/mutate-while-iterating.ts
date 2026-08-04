// Mutating an array while iterating it (iterator invalidation) is a borrow conflict.
const a: number[] = [1, 2, 3];
for (const x of a) {
  a.push(x); //~ ERROR NT1603
}
