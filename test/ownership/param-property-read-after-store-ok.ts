//@ check-pass
// Inside the constructor, a consuming parameter keeps BORROWING the value the object now
// owns, so reading it after the definitional store is fine. This is rustc's
// `Self { n: xs.len(), xs }` — the read happens before the move in Rust's field order and
// after it in TypeScript's desugaring, but the object is the sole owner either way.
class Sized {
  n: number;
  constructor(readonly xs: number[]) {
    this.n = xs.length;
  }
}
function f(): number {
  const s = new Sized([1, 2, 3]);
  return s.n;
}
console.log(f());
