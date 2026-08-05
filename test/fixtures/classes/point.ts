class Point {
  x: number;
  y: number;
  constructor(a: number, b: number) {
    this.x = a;
    this.y = b;
  }
  distSquared(): number {
    return this.x * this.x + this.y * this.y;
  }
  scaledX(k: number): number {
    return this.x * k;
  }
}

const p = new Point(3, 4);
console.log(p.x);
console.log(p.y);
console.log(p.distSquared());
console.log(p.scaledX(10));
console.log(new Point(5, 12).distSquared());
