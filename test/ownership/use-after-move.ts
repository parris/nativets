// Using a linear value after it was moved is an error (mirrors Rust E0382).
const a: number[] = [1, 2, 3];
const b = move(a);
console.log(a.length); //~ ERROR NT1601
