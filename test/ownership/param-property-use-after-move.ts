// The other half of a consuming parameter: the caller GAVE THE VALUE UP, so using it
// after the `new` is a use of a moved value. rustc E0382, the shape of
// `tests/ui/moves/moves-based-on-type-block-bad.rs` — a value moved into a call and
// then read on the next line.
class Box {
  constructor(readonly inner: {x:number}) {}
}
function f(): number {
  const v: {x:number} = {x: 1};
  const b = new Box(v);
  return v.x + b.inner.x; //~ ERROR NT1601
}
console.log(f());
