// Object struct-update via spread ({...o, k: v}): must return a NEW object with
// one field replaced while the original is a full independent copy — o.x/o.y
// still read their old values, and o !== p.
const o: {x:number, y:number} = {x: 1, y: 2};
const p: {x:number, y:number} = {...o, y: 9};
console.log(p.x, p.y);
console.log(o.x, o.y);
console.log(o === p);
