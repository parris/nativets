// Moving an array while a for-of borrow of it is live is a conflict (mirrors Rust E0505).
let a: number[] = [1, 2, 3];
for (const x of a) {
  const b = move(a); //~ ERROR NT1602
}
