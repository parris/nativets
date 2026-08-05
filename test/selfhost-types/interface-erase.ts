// `interface` is erased but its structural shape resolves in annotations.
interface Point {
  x: number;
  y: number;
}

function area(p: Point): number {
  return p.x * p.y;
}

const origin: Point = { x: 3, y: 4 };
console.log(area(origin));
console.log(area({ x: 6, y: 7 }));
