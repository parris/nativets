// encode.ts — int → Roman numeral.
//
// The greedy encoder, lifted out of the single-file examples/roman.ts into its
// own module. The value/symbol tables are now MODULE-LEVEL consts: a module's
// functions see its module scope, so `toRoman` reads them without re-creating
// the two arrays on every call.

// The 13 value/symbol pairs, largest first. Two parallel arrays so each is a
// non-empty literal read purely by index (arrays are immutable in nativets).
export const VALUES: number[] = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
export const SYMBOLS: string[] = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];

// For each pair, subtract its value as many times as it fits, appending the
// symbol each time — the classic greedy encoding.
export function toRoman(n: number): string {
  let result: string = "";
  let i: number = 0;
  while (i < VALUES.length) {
    while (n >= VALUES[i]) {
      result += SYMBOLS[i];
      n = n - VALUES[i];
    }
    i = i + 1;
  }
  return result;
}
