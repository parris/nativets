import { Rect, areaOf, scaleBy } from "./shape.ts";

const r = new Rect(3, 4);
console.log(r.label());
console.log(r.area());
console.log(areaOf(r));
console.log(scaleBy(6, 7));

// The imported class is usable as a TYPE in this module too.
function twice(box: Rect): number {
  return box.area() * 2;
}
console.log(twice(r));
