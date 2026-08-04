// The for-of variable borrows each element; moving it out is E0507.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
for (const e of xs) {
  const stolen = move(e); //~ ERROR NT1604
}
