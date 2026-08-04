//@ check-pass
// Field reads, Object.keys, and for-in are borrows — they never consume.
const a: {x:number, y:number} = {x: 1, y: 2};
console.log(a.x, a["y"]);
for (const k of Object.keys(a)) {
  console.log(k);
}
console.log(a.x);
