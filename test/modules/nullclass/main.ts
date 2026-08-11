import { Scope, Box, pick, widen } from "./scope.ts";

const root = new Scope();
const kid = root.child();
const grandkid = kid.child();
console.log(root.depth(), kid.depth(), grandkid.depth());

const b = new Box("hi");
console.log(pick(undefined, b).label);
console.log(pick(new Box("a"), b).label);
console.log(widen(b)?.label);
console.log(widen(new Box(""))?.label);
