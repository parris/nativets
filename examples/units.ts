// units.ts — a tiny unit converter CLI.
//
//   nativets run examples/units.ts -- 37 C F      ->  37 C = 98.6 F
//   nativets run examples/units.ts -- 5 km mi      ->  5 km = 3.106855961174242 mi
//   ./units 1 lb kg                                ->  1 lb = 0.45359237 kg
//   ./units                     (no args)          ->  a hardcoded demo set
//
// INPUT is `process.argv.slice(2)` = [value, fromUnit, toUnit]. Three dimensions
// are supported: temperature (C/F/K), length (m/km/mi/ft), and mass (kg/lb/g).
// Each conversion goes through a common base unit — Celsius for temperature (an
// affine map, offsets matter), metres for length, kilograms for mass (both pure
// scale factors). Units from different dimensions (or an unknown unit) are
// rejected with a usage line.
//
// The output is `${value} ${from} = ${result} ${to}` — the RESULT is an ordinary
// double interpolated with `${}`, so number formatting is the interesting part:
// nativets prints doubles with the same shortest-round-trip algorithm as node
// (e.g. 37 C → 98.6, 5 km → 3.106855961174242 mi), so `${result}` matches node
// byte-for-byte. Written in the immutable scalar subset: no mutation, no arrays
// beyond argv, no classes — just `parseFloat`, string `===`, arithmetic, and
// `if` / `else if`. Compiles + runs identically under `node` and nativets and
// cross-compiles to macOS / Linux / iOS / Android unchanged (libc-only runtime).

function dimOf(u: string): string {
  if (u === "C" || u === "F" || u === "K") return "temp";
  if (u === "m" || u === "km" || u === "mi" || u === "ft") return "length";
  if (u === "kg" || u === "lb" || u === "g") return "mass";
  return "?";
}

// Length scale factors, relative to metres.
function factorLen(u: string): number {
  if (u === "m") return 1;
  if (u === "km") return 1000;
  if (u === "mi") return 1609.344;
  return 0.3048; // ft
}

// Mass scale factors, relative to kilograms.
function factorMass(u: string): number {
  if (u === "kg") return 1;
  if (u === "g") return 0.001;
  return 0.45359237; // lb
}

// Temperature is affine (offsets), so route through Celsius explicitly.
function tempToC(v: number, u: string): number {
  if (u === "C") return v;
  if (u === "F") return (v - 32) * 5 / 9;
  return v - 273.15; // K
}
function cToTemp(c: number, u: string): number {
  if (u === "C") return c;
  if (u === "F") return c * 9 / 5 + 32;
  return c + 273.15; // K
}

function convert(value: number, from: string, to: string, dim: string): number {
  if (dim === "temp") return cToTemp(tempToC(value, from), to);
  if (dim === "length") return value * factorLen(from) / factorLen(to);
  return value * factorMass(from) / factorMass(to); // mass
}

const argv: string[] = process.argv.slice(2);

if (argv.length < 3) {
  console.log("units demo — usage: units <value> <from> <to>");
  console.log(`37 C = ${convert(37, "C", "F", "temp")} F`);
  console.log(`98.6 F = ${convert(98.6, "F", "C", "temp")} C`);
  console.log(`100 C = ${convert(100, "C", "K", "temp")} K`);
  console.log(`5 km = ${convert(5, "km", "mi", "length")} mi`);
  console.log(`26.2 mi = ${convert(26.2, "mi", "km", "length")} km`);
  console.log(`1 lb = ${convert(1, "lb", "kg", "mass")} kg`);
  console.log(`70 kg = ${convert(70, "kg", "lb", "mass")} lb`);
} else {
  const value: number = parseFloat(argv[0]);
  const from: string = argv[1];
  const to: string = argv[2];
  const df: string = dimOf(from);
  const dt: string = dimOf(to);
  if (df === "?" || dt === "?" || df !== dt) {
    console.log("usage: units <value> <from> <to>  (same dimension: temp C/F/K, length m/km/mi/ft, mass kg/lb/g)");
  } else {
    console.log(`${value} ${from} = ${convert(value, from, to, df)} ${to}`);
  }
}
