// .with on a string[] — element slots hold string pointers; CoW copies them
// by value, so the original array is untouched and the new one has the swap.
const a: string[] = ["ant", "bee", "cat"];
const b: string[] = a.with(2, "dog");
console.log(b.join("-"));
console.log(a.join("-"));
console.log(a === b);
console.log(a[2], b[2]);
