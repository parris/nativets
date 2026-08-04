//@ check-pass
const a: {x:number} = {x: 1};
const b = move(a);
console.log(b.x);
