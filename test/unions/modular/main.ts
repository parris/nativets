import { area, type Shape } from "./shapes.ts";
const s: Shape = { kind: "square", size: 4 };
console.log(area(s));
console.log(area({ kind: "circle", radius: 2 }));
