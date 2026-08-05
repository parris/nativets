import "./banner.ts"; // side-effect-only import: runs the module, binds nothing
import { add } from "./math.ts";

console.log(add(2, 3));
console.log(add(add(1, 1), 40));
