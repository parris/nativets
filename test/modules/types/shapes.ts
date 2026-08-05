// Type-only exports: erased entirely (no runtime footprint), but an importing
// module's annotations still resolve to the real shape.
export type Point = { x: number; y: number };

export interface Named {
  name: string;
  age: number;
}

export type Label = "left" | "right";

export function describe(p: Point): string {
  return `(${p.x}, ${p.y})`;
}
