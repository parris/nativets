//@ check-pass
// Method calls, indexing, .length, and for-of are BORROWS — they never consume.
// (Immutable model: `.push` no longer exists as a mutator, so `.includes` stands
// in as the read-only method-call borrow.)
const a: number[] = [1, 2, 3];
console.log(a.length, a[0], a.includes(2));
for (const x of a) {
  console.log(x);
}
