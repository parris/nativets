// roman.ts — Roman numeral conversion in the nativets subset.
//
// Converts integers to Roman numerals (`toRoman`) and parses them back
// (`fromRoman`), then demonstrates a round trip on hardcoded numbers. It runs
// identically under plain `node` and under nativets (byte-for-byte).
//
// Written in the *current* nativets language subset (see examples/calculator.ts):
//   - Arrays are IMMUTABLE: no `.push` / `arr[i] = v`. The value/symbol tables
//     are seeded, non-empty literals (`number[]` + parallel `string[]`) that are
//     only ever READ by index — the greedy subtraction loop indexes them inline.
//   - String elements are read inline (`syms[i]`) and appended with `+=`; no
//     element is bound to a local, so nothing is moved out of an array.
//   - No classes: the tables are two parallel arrays; a single-char value lookup
//     is a plain if-ladder over `charAt`.

// ---------------------------------------------------------------------------
// int -> roman  (greedy, largest symbol first)
// ---------------------------------------------------------------------------

// The 13 value/symbol pairs, largest first. Kept as two parallel arrays so each
// is a non-empty literal (no unsupported empty-`[]`) read purely by index.
function toRoman(n: number): string {
  const values: number[] = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms: string[] = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let result: string = "";
  let i: number = 0;
  // For each pair, subtract its value as many times as it fits, appending the
  // symbol each time — the classic greedy encoding.
  while (i < values.length) {
    while (n >= values[i]) {
      result += syms[i];
      n = n - values[i];
    }
    i = i + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// roman -> int
// ---------------------------------------------------------------------------

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
function fromRoman(s: string): number {
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

// ---------------------------------------------------------------------------
// Demo: hardcoded round trips (argv/stdin input is a follow-on once Host I/O
// FFI lands — see examples/calculator.ts).
// ---------------------------------------------------------------------------

const nums: number[] = [4, 9, 40, 58, 90, 49, 1994, 2024, 3888, 3999];

for (const n of nums) {
  const r: string = toRoman(n);
  const back: number = fromRoman(r);
  console.log(n + " -> " + r + " -> " + back);
}
