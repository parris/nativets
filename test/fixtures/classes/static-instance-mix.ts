// A static method and an instance method on one class. They lower to the same shape of
// name (`Point.origin` / `Point.dist`) and differ only in the receiver, so this pins that
// each is reachable exactly one way: the static through the class, the instance through
// an instance. The static FACTORY (`Point.origin()`) is the canonical use.
class Point {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  static origin(): Point {
    return new Point(0, 0);
  }

  static manhattan(p: Point): number {
    return (p.x < 0 ? -p.x : p.x) + (p.y < 0 ? -p.y : p.y);
  }

  show(): string {
    return `(${this.x}, ${this.y})`;
  }

  far(): boolean {
    return Point.manhattan(this) > 10;
  }
}

const o = Point.origin();
console.log(o.show());
console.log(Point.manhattan(o));

const p = new Point(3, -4);
console.log(p.show());
console.log(Point.manhattan(p));
console.log(p.far());

const q = new Point(-9, 9);
console.log(q.far());
