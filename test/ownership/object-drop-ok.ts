//@ check-pass
// An owned object with no move is dropped at scope exit (no leak, no GC).
function f(): number {
  const a: {x:number} = {x: 42};
  return a.x;
}
console.log(f());
