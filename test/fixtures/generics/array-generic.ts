// Generic type arguments in annotations are erased to the supported shape:
//   Array<number>  →  number[]   (a real array, runtime-visible)
// The `<number>` on the call-site type arg of a generic function is erased too.
function first<T>(xs: T[]): T {
  return xs[0];
}
const xs: Array<number> = [3, 1, 4, 1, 5];
console.log(xs.length);
console.log(xs[2]);
console.log(first<number>(xs));
