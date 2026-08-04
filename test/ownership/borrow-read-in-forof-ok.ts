//@ check-pass
// Reading a field through the borrowed for-of element (not moving it) is fine.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
let total: number = 0;
for (const e of xs) {
  total = total + e.x;
}
console.log(total);
