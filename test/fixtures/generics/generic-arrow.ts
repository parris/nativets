// Generic ARROWS: the `<T>` type-param list on an arrow value is parsed and ERASED.
// A leading `<` unambiguously starts a generic arrow in this subset (no JSX), so it
// needs no backtracking. Runtime-visible: the arrows are ordinary function values.
const identity = <T>(x: T): T => x;
const dup = <T>(a: T, b: T): T => a;
console.log(identity(99));
console.log(dup(7, 8));
console.log(identity(2) + identity(3));
