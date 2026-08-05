// primes.ts — the Sieve of Eratosthenes written in the nativets subset.
//
// Computes every prime up to a compile-time constant N and prints them on one
// line, space-separated. It is fully deterministic (no input), so it prints the
// same bytes under plain `node` and under a compiled nativets binary.
//
// Written in the *current* nativets language subset (docs/examples.md C-a),
// leaning on the IMMUTABLE data model (Stage 29):
//   - The sieve is a `boolean[]` (true = "still prime", false = "composite").
//     There is NO `sieve[i] = false`: marking a composite is a functional,
//     copy-on-write update, `sieve = sieve.with(i, false)` (ES2023 `.with`),
//     which returns a BRAND-NEW array with one cell changed and leaves the old
//     one untouched — the old owner is dropped, the new value reassigned.
//   - The all-`true` starting array is grown functionally from an empty literal
//     (`const s: boolean[] = []` is inferred from the annotation) by spreading a
//     fresh `true` onto a reassigned local (`sieve = [...sieve, true]`) — never
//     `.push`, which the immutable model forbids.
//   - Cells are READ inline (`sieve[i]`); a plain index read is a borrow.
//   - Plain `while`/`if` and `number`/`boolean`/`string` only; no classes.

// ---------------------------------------------------------------------------
// The bound: compute all primes up to and including N (compile-time constant).
// ---------------------------------------------------------------------------

const N: number = 100;

// ---------------------------------------------------------------------------
// Build the sieve, all `true`, indices 0..N. Grown one cell at a time from an
// empty array by immutable spread — the shape the immutable model wants.
// ---------------------------------------------------------------------------

let sieve: boolean[] = [];
let k: number = 0;
while (k <= N) {
  sieve = [...sieve, true];
  k = k + 1;
}

// 0 and 1 are not prime. Each `.with` returns a new array (copy-on-write).
sieve = sieve.with(0, false);
sieve = sieve.with(1, false);

// ---------------------------------------------------------------------------
// The sieve proper: for each prime i, strike out its multiples starting at i*i
// (smaller multiples were already struck by smaller primes). Every strike is an
// immutable `.with`, so `sieve` is rebuilt cell-by-cell — no in-place mutation.
// ---------------------------------------------------------------------------

let i: number = 2;
while (i * i <= N) {
  if (sieve[i]) {
    let j: number = i * i;
    while (j <= N) {
      sieve = sieve.with(j, false);
      j = j + i;
    }
  }
  i = i + 1;
}

// ---------------------------------------------------------------------------
// Collect the survivors into one space-separated line (no leading space, no
// trailing newline — `console.log` adds the newline).
// ---------------------------------------------------------------------------

let out: string = "";
let n: number = 2;
while (n <= N) {
  if (sieve[n]) {
    if (out === "") {
      out = out + n;
    } else {
      out = out + " " + n;
    }
  }
  n = n + 1;
}
console.log(out);
