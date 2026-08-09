const o = { a: 1, b: undefined };
console.log("a" in o, "b" in o, "c" in o);
console.log("toString" in o, "constructor" in o, "hasOwnProperty" in o, "__proto__" in o, "valueOf" in o);
const m = new Map(); m.set("a", 1);
console.log("a" in m, "has" in m, "size" in m);
const arr = [1,2,3];
console.log(0 in arr, 3 in arr, "length" in arr, "0" in arr);
console.log("a" in { a: undefined });
