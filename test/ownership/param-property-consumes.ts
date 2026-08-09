//@ check-pass
// A CONSTRUCTOR PARAMETER PROPERTY takes OWNERSHIP of its argument — rustc's
// `fn new(d: D) -> Self { Self { d } }`, not `fn new(d: &D)`. The parameter is stored
// into a slot that outlives the call, so it cannot be a borrow; the caller moves.
class Box {
  constructor(readonly inner: {x:number}) {}
}
function f(): number {
  const v: {x:number} = {x: 1};
  const b = new Box(v);   // `v` MOVES into the box
  return b.inner.x;
}
console.log(f());
