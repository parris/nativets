const s = "a\u0041b";
console.log(s, s.length);
const u = "a\u0001b";
console.log(u.length);
console.log(JSON.stringify(u));
