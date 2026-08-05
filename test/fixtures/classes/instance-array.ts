class Box {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
}

const boxes = [new Box(2, 3), new Box(4, 5), new Box(6, 7)];
let total = 0;
for (const b of boxes) {
  total = total + b.area();
}
console.log(total);
console.log(boxes.length);
console.log(boxes[1].area());
console.log(boxes[2].w);

function sumAreas(items: Box[]): number {
  let s = 0;
  for (const it of items) s = s + it.area();
  return s;
}
console.log(sumAreas(boxes));
