// lib/money.ts — a leaf module imported by BOTH ../report.ts and ../main.ts.
// It is loaded exactly ONCE (a diamond in the import graph), so this line prints
// once no matter how many modules import it.
//
// Note the nested path: specifiers are resolved relative to the importing file,
// so `../report.ts` reaches this as `./lib/money.ts` and `./lib/money.ts` from
// main.ts — the same module either way.

export const CURRENCY = "$";

// Round to cents and render with exactly two decimals (no toFixed in the subset).
export function money(n: number): string {
  const cents = Math.round(n * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents - whole * 100;
  const pad = rest < 10 ? "0" : "";
  return CURRENCY + whole + "." + pad + rest;
}
