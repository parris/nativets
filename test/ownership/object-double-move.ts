// Moving twice reads an already-moved object.
const a: {x:number} = {x: 1};
const b = move(a);
const c = move(a); //~ ERROR NT1601
