export const PREFIX: string = "v=";
export const SCALE: number = 3;

export function label<T>(x: T): string {
  return `${PREFIX}${x}`;   // generic body reads a module-level const
}

export function scaleAll(xs: number[]): number[] {
  return xs.map((n: number): number => n * SCALE);
}
