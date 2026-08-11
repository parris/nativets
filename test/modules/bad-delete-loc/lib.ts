export interface Rec { a: number; b?: number }

export function strip(r: Rec): number {
  const o: Rec = { a: r.a, b: r.b };
  delete o.b;
  return o.a;
}
