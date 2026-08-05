// Read several lines, then drain the rest — exercises the shared stdin cursor.
const a = readLine();
const b = readLine();
console.log("a=" + a);
console.log("b=" + b);
console.log("tail:" + readStdin());
