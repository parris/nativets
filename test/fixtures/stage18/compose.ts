const compose = (f: (n: number) => number, g: (n: number) => number) =>
  (x: number) => f(g(x));
const inc = (n: number) => n + 1;
const dbl = (n: number) => n * 2;
console.log(compose(inc, dbl)(10));
console.log(compose(dbl, inc)(10));
const addThenDouble = compose(dbl, inc);
console.log(addThenDouble(4));
