// decode.ts — Roman numeral → int.
//
// `romanValue` is PRIVATE to this module (no `export`): nothing outside can
// reach it, and the linker renames it per-module, so another module is free to
// declare its own `romanValue` without a collision.

// Value of a single Roman digit (0 for anything unrecognized).
function romanValue(c: string): number {
  if (c === "I") return 1;
  if (c === "V") return 5;
  if (c === "X") return 10;
  if (c === "L") return 50;
  if (c === "C") return 100;
  if (c === "D") return 500;
  if (c === "M") return 1000;
  return 0;
}

// Left-to-right scan: if a digit is smaller than the one after it, it is a
// subtractive pair (IV, IX, XL, …) worth (next - cur); otherwise add it.
export function fromRoman(s: string): number {
  let total: number = 0;
  let i: number = 0;
  while (i < s.length) {
    const cur: number = romanValue(s.charAt(i));
    if (i + 1 < s.length) {
      const next: number = romanValue(s.charAt(i + 1));
      if (cur < next) {
        total = total + (next - cur);
        i = i + 2;
      } else {
        total = total + cur;
        i = i + 1;
      }
    } else {
      total = total + cur;
      i = i + 1;
    }
  }
  return total;
}
