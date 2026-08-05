// Pure-erasure generic wrappers in annotations: ReadonlyArray<T> → T[],
// and utility/wrapper types erase to an accepted inner shape. All runtime-visible
// values are ordinary numbers/strings after erasure, so this runs under node too.
function sum(xs: ReadonlyArray<number>): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
const data: ReadonlyArray<number> = [1, 2, 3, 4];
console.log(sum(data));
