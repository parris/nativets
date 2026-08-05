// Generic function declarations: the `<T>` type-param list is parsed and ERASED,
// and a type parameter used in annotations resolves to the concrete flowing type
// (here `number`). A generic identity/util that runs under node too.
function id<T>(x: T): T {
  return x;
}
function pickFirst<T>(a: T, b: T): T {
  return a;
}
console.log(id(5));
console.log(id(3) + id(4));
console.log(pickFirst(10, 20));
