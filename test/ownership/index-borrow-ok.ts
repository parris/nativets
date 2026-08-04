//@ check-pass
// Reading a field through the index borrows the element — it does not move it out.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
console.log(xs[0].x, xs[1].x);
