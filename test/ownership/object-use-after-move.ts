// An object is linear: binding it to a new name moves it (mirrors Rust E0382).
const a: {x:number} = {x: 1};
const b = a;
console.log(a.x); //~ ERROR NT1601
