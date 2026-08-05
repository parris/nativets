// Object.values — compile-time-known keys, homogeneous value type (arrays are homogeneous).
const scores = { alice: 90, bob: 85, carol: 100 };
const vals = Object.values(scores);
console.log(vals.length);          // 3
console.log(vals.join(","));       // "90,85,100"
console.log(vals[0], vals[2]);     // 90 100

const names = { first: "Ada", last: "Lovelace" };
const nv = Object.values(names);
console.log(nv.join(" "));         // "Ada Lovelace"

// keys still works alongside values
console.log(Object.keys(scores).join(","));  // "alice,bob,carol"

// values feed straight into HOFs
const total = Object.values(scores).reduce((a, b) => a + b, 0);
console.log(total);                // 275
