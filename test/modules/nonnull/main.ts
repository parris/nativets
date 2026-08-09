import { firsts, tagged, head } from "./tags.ts";

console.log(firsts(["x", "y"]).join(","));
console.log(tagged(["x", "y"]).join(","));
console.log(head("z"));
