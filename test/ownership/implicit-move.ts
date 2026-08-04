// Binding a linear value to a new name is a move, even without an explicit move().
const a: number[] = [1, 2, 3];
const b = a;
console.log(a.length); //~ ERROR NT1601
