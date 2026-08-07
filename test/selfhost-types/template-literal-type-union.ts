// The exact shape of `src/ast.ts:14` — a string-literal union widened alongside two
// template-literal arms. Every arm erases to `string`, so the union COLLAPSES to one
// base and never reaches the general-union refusal.
type ScalarTy = "number" | "boolean" | "string" | "void" | "undefined" | "null" | "Dyn";
type Ty = ScalarTy | `${string}[]` | `{${string}}`;

function isArrayTy(t: Ty): boolean { return t.endsWith("[]"); }
function elemTy(t: Ty): Ty { return t.slice(0, -2) as Ty; }
function isObjectTy(t: Ty): boolean { return t.startsWith("{") && t.endsWith("}"); }

const scalar: Ty = "number";
const arr: Ty = "number[]";
const nested: Ty = "string[][]";
const obj: Ty = "{name:string,age:number}";

console.log(isArrayTy(scalar), isArrayTy(arr), isArrayTy(nested));
console.log(elemTy(arr));
console.log(elemTy(nested));
console.log(isObjectTy(obj), isObjectTy(arr));
