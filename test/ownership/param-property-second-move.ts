// A consuming parameter is consumed EXACTLY ONCE, by the field it defines. Handing the
// same value out again would give the object and the new binding one pointer each, and
// the object's drop would free it under the binding. rustc E0382/E0507 on a partially
// moved binding (`tests/ui/moves/move-out-of-slice-1.rs` shape: the owner is elsewhere).
class Sized {
  n: number;
  constructor(readonly xs: number[]) {
    const stolen: number[] = xs; //~ ERROR NT1604
    this.n = stolen.length;
  }
}
function f(): number {
  const s = new Sized([1, 2, 3]);
  return s.n;
}
console.log(f());
