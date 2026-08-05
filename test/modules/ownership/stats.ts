// An imported function's params are BORROWS — the caller keeps ownership — exactly
// as within one file. So `main.ts` may pass the same array to several of these and
// keep using it afterwards, and its single owner drops it once at scope exit.
export function sum(xs: number[]): number {
  let t = 0;
  for (const x of xs) t = t + x;
  return t;
}

export function biggest(xs: number[]): number {
  let m = xs[0];
  for (const x of xs) if (x > m) m = x;
  return m;
}

export function describe(xs: number[]): string {
  return `${xs.length} values, sum ${sum(xs)}, max ${biggest(xs)}`;
}
