const p = { name: "Ada", age: 36, active: true };
console.log(p.name, p.age, p["active"]);
const o = { x: 1, y: 2, z: 3 };
console.log(Object.keys(o).join(","), Object.keys(o).length);
let ks: string = "";
for (const k in o) {
  ks += k;
}
console.log(ks);
