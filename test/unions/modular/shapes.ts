export interface Square { kind: "square"; size: number; }
export interface Circle { kind: "circle"; radius: number; }
export type Shape = Square | Circle;
export function area(s: Shape): number {
  switch (s.kind) {
    case "square": return s.size * s.size;
    case "circle": return 3 * s.radius * s.radius;
  }
}
