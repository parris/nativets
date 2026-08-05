// An exported CLASS is both a value (its constructor + methods lower to top-level
// functions) and a type (the tagged instance shape) — both cross the module boundary.
export class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
  label(): string {
    return `${this.w}x${this.h}`;
  }
}

// An exported closure VALUE (an arrow bound to a const), called from another module.
export const scaleBy = (n: number, k: number): number => n * k;

export function areaOf(r: Rect): number {
  return r.area();
}
