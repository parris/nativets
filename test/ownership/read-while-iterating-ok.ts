//@ check-pass
// Reads (.length, indexing) during iteration are fine — shared borrows don't conflict.
const a: number[] = [1, 2, 3];
let sum: number = 0;
for (const x of a) {
  sum += a.length;
  sum += a[0];
  sum += x;
}
console.log(sum);
