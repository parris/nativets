//@ check-pass
// Method calls, indexing, .length, and for-of are BORROWS — they never consume.
const a: number[] = [1, 2, 3];
a.push(4);
console.log(a.length, a[0], a.includes(2));
for (const x of a) {
  console.log(x);
}
