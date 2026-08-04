// Moved on one branch => "maybe moved" => moved after the join (control-flow merge).
let a: number[] = [1, 2, 3];
const cond: boolean = true;
if (cond) {
  const b = move(a);
}
console.log(a.length); //~ ERROR NT1601
