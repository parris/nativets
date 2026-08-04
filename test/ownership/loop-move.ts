// A value moved in a loop body is already moved on the next iteration (fixpoint).
let a: number[] = [1, 2, 3];
for (let i: number = 0; i < 3; i = i + 1) {
  const b = move(a); //~ ERROR NT1601
}
