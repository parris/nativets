/*
 * Number -> String: ECMAScript §6.1.6.1.20 (`Number::toString`).
 *
 * This routine sits under EVERY program that prints a number, so it is held to
 * the prime directive the hard way: not a hand-picked table (numeric formatting
 * is exactly where hand-picked cases lull you) but a FUZZ against node.
 *
 * The generator is SEEDED (mulberry32) so a failure reproduces exactly. Each
 * value is emitted as a source literal via `String(x)`, which round-trips a
 * double exactly, so both sides parse the identical bit pattern — the oracle is
 * a separate `node case.ts` run over that same source, never our own formatter.
 */

import { describe, expect, test } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

/* ---- literal emission ------------------------------------------------- */

/** Source text for a double. `String(-0)` is "0", so the sign is re-attached. */
function lit(x: number): string {
  if (Object.is(x, -0)) return "-0";
  return String(x);
}

/** A program that prints every value on its own line (the bare console.log path). */
function printProgram(xs: number[]): string {
  return `const xs: number[] = [${xs.map(lit).join(", ")}];\nfor (const x of xs) console.log(x);\n`;
}

/** Compile+run and node-run the same source; assert byte-identical stdout. */
async function expectSameAsNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(oracle.exitCode).toBe(0);
  expect(ours.exitCode).toBe(0);
  if (ours.stdout !== oracle.stdout) {
    // Report the FIRST divergence rather than a 10k-line diff.
    const a = ours.stdout.split("\n");
    const b = oracle.stdout.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) throw new Error(`line ${i + 1}: ours=${JSON.stringify(a[i])} node=${JSON.stringify(b[i])}`);
    }
  }
  expect(ours.stdout).toBe(oracle.stdout);
}

/** Fuzz a batch of doubles through the printer, reporting the count checked. */
async function fuzz(xs: number[]): Promise<number> {
  await expectSameAsNode(printProgram(xs));
  return xs.length;
}

/* ---- seeded generators ------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` doubles from random 64-bit patterns (NaN/Infinity filtered out). */
function randomBits(seed: number, n: number): number[] {
  const rnd = mulberry32(seed);
  const dv = new DataView(new ArrayBuffer(8));
  const out: number[] = [];
  while (out.length < n) {
    dv.setUint32(0, (rnd() * 4294967296) >>> 0);
    dv.setUint32(4, (rnd() * 4294967296) >>> 0);
    const d = dv.getFloat64(0);
    if (Number.isFinite(d)) out.push(d);
  }
  return out;
}

/* ---- 1. the spec table ------------------------------------------------- */

describe("Number -> String: the §6.1.6.1.20 digit-placement rules", () => {
  test("fixed vs exponential, both thresholds", async () => {
    await expectSameAsNode(
      printProgram([
        0, 1, -1, 7, -7, 10, 100, 1000,
        0.5, -0.5, 1.5, 0.1, 0.2, 1 / 3,
        // the small threshold: exponential only BELOW 1e-6
        1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1.5e-7, 0.00001, 0.000001, 0.0000001,
        // the big threshold: exponential at/above 1e21
        1e18, 1e19, 1e20, 1e21, 1e22, 1.5e21, 999999999999999999999, 1e300,
        // exponent formatting: never zero-padded, `+` on the positive side
        1e-9, 1e100, 1e-100, 1.7976931348623157e308, 5e-324,
      ]),
    );
  });

  test("shortest round-trip digits, not the exact expansion", async () => {
    await expectSameAsNode(
      printProgram([
        123456789012345680000, 179329094418421740000, -728856327476375700,
        9007199254740991, 9007199254740992, 9007199254740994,
        0.1 + 0.2, 1e23, 4.35, 1.005, 2 ** 53, 2 ** 60, 2 ** 70,
      ]),
    );
  });

  test("zero, negative zero, NaN, Infinity", async () => {
    await expectSameAsNode(`
console.log(0);
console.log(-0);
console.log(0 / 1);
console.log(NaN);
console.log(Infinity);
console.log(-Infinity);
console.log(String(-0));
console.log(\`\${-0}\`);
console.log(String(NaN), String(Infinity), String(-Infinity));
`);
  });

  test("subnormals and the MIN/MAX boundaries", async () => {
    await expectSameAsNode(
      printProgram([
        5e-324, 1e-323, 1.5e-323, 2.5e-323, 1e-320, 1e-310, 2.2250738585072014e-308,
        2.225073858507201e-308, 1.7976931348623157e308, Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER, Number.EPSILON,
      ]),
    );
  });
});

/* ---- 2. every call site reaches the same routine ----------------------- */

describe("Number -> String: all call sites agree with node", () => {
  test("console.log, template, concat, String(), .toString(), JSON.stringify", async () => {
    await expectSameAsNode(`
const vals: number[] = [1e-7, 1e-5, 0.00001, 123456789012345680000, 1e21, 1e20, 5e-324, 0.1 + 0.2];
for (const v of vals) {
  console.log(v);
  console.log(\`\${v}\`);
  console.log("" + v);
  console.log(String(v));
  console.log(v.toString());
  console.log(JSON.stringify(v));
  console.log(JSON.stringify({ v: v }));
  console.log(JSON.stringify([v]));
  console.log([v].join(","));
}
`);
  });

  test("a JSON.parse'd Dyn number prints like console.log (incl. -0)", async () => {
    await expectSameAsNode(`
console.log(JSON.parse("-0"));
console.log(JSON.parse("1e-7"));
console.log(JSON.parse("0.00001"));
console.log(JSON.parse("123456789012345680000"));
console.log(JSON.parse("1e21"));
`);
  });

  test("the default .toSorted() comparator (node compares STRING forms)", async () => {
    // `[10, 9].toSorted()` is [10, 9] because "10" < "9" — so the default sort
    // order depends on this exact routine, notation switch included.
    await expectSameAsNode(`
const xs: number[] = [1e21, 1e20, 9, 10, 1e-7, 1e-6, 0.00001, 2, 123456789012345680000];
console.log(xs.toSorted().join("|"));
console.log(xs.join(","));
`);
  });

  test("Map / Set rendering of number keys and values", async () => {
    await expectSameAsNode(`
let m = new Map<string, number>();
m = m.set("a", 1e-5);
m = m.set("b", 1e21);
for (const k of m.keys()) console.log(k, m.get(k));
let s = new Set<number>();
s = s.add(1e-7);
s = s.add(123456789012345680000);
for (const v of s) console.log(v);
`);
  });
});

/* ---- 3. the fuzz ------------------------------------------------------- */

describe("Number -> String: fuzz against node", () => {
  test("10000 random 64-bit patterns", async () => {
    expect(await fuzz(randomBits(0xc0ffee, 10000))).toBe(10000);
  }, 180000);

  test("10000 structured values (integers, powers of ten, thresholds, subnormals)", async () => {
    const rnd = mulberry32(0xbadf00d);
    const xs: number[] = [];
    // small integers, every magnitude
    for (let i = 0; i <= 1200; i++) xs.push(i, -i);
    // powers of ten across the whole range, and their neighbours
    for (let e = -330; e <= 308; e++) {
      const p = Number(`1e${e}`);
      if (!Number.isFinite(p) || p === 0) continue;
      xs.push(p, -p, p * 1.5, p * 9.999999999999999);
    }
    // dense around the 1e-6 / 1e21 fixed<->exponential thresholds
    for (let i = 0; i < 400; i++) {
      xs.push(1e-6 * (1 + (rnd() - 0.5) * 1e-3), 1e-7 * (1 + (rnd() - 0.5) * 1e-3));
      xs.push(1e21 * (1 + (rnd() - 0.5) * 1e-3), 1e20 * (1 + (rnd() - 0.5) * 1e-3));
    }
    // exact threshold neighbours by ULP
    for (const anchor of [1e-6, 1e-7, 1e21, 1e20, 1e-5]) {
      let v = anchor;
      for (let i = 0; i < 8; i++) { xs.push(v); v = nextUp(v); }
      v = anchor;
      for (let i = 0; i < 8; i++) { xs.push(v); v = nextDown(v); }
    }
    // subnormals: the bottom of the exponent range, scaled
    for (let i = 1; i < 600; i++) xs.push(5e-324 * i, -5e-324 * i);
    // random big integers (the exact-expansion trap)
    for (let i = 0; i < 1200; i++) xs.push(Math.floor(rnd() * 2 ** 53) * 2 ** Math.floor(rnd() * 20));
    // random "human" decimals
    for (let i = 0; i < 1200; i++) xs.push(rnd() * 10 ** Math.floor(rnd() * 24 - 12));
    const uniq = [...new Set(xs)].filter(Number.isFinite);
    expect(await fuzz(uniq)).toBeGreaterThan(4000);
  }, 180000);

  test("few-significant-bit values (m * 2^k) — where decimal TIES live", async () => {
    // The only two bugs the 200k-value out-of-band fuzz found were both here:
    // a power of two whose rounding interval is asymmetric, so the NEAREST
    // p-digit decimal falls outside it while its neighbour (the one V8 prints)
    // does not. Keep this family in the committed suite.
    const rnd = mulberry32(0x5eed);
    const xs: number[] = [];
    for (let k = -1074; k <= 1023; k++) {
      const p = 2 ** k;
      if (!Number.isFinite(p) || p === 0) continue;
      xs.push(p, -p, p * 3, p * 5);
    }
    for (let i = 0; i < 3000; i++) {
      const m = 1 + Math.floor(rnd() * 4096);
      const v = m * 2 ** (Math.floor(rnd() * 200) - 100);
      if (Number.isFinite(v) && v !== 0) xs.push(rnd() < 0.5 ? v : -v);
    }
    const uniq = [...new Set(xs)].filter(Number.isFinite);
    expect(await fuzz(uniq)).toBeGreaterThan(4000);
  }, 180000);
});

/** IEEE next-representable helpers (bit increment on the magnitude). */
const NEXT_DV = new DataView(new ArrayBuffer(8));
function nextUp(x: number): number {
  NEXT_DV.setFloat64(0, x);
  let hi = NEXT_DV.getUint32(0), lo = NEXT_DV.getUint32(4);
  if (x >= 0) { lo = (lo + 1) >>> 0; if (lo === 0) hi = (hi + 1) >>> 0; }
  else { if (lo === 0) hi = (hi - 1) >>> 0; lo = (lo - 1) >>> 0; }
  NEXT_DV.setUint32(0, hi); NEXT_DV.setUint32(4, lo);
  const r = NEXT_DV.getFloat64(0);
  return Number.isFinite(r) ? r : x;
}
function nextDown(x: number): number {
  return -nextUp(-x);
}

/* ---- 4. the neighbouring, separately-verified paths must not regress --- */

describe("toFixed / toString(radix) are unaffected (Stage 40)", () => {
  test("toFixed keeps its ECMAScript-exact rounding", async () => {
    await expectSameAsNode(`
console.log((1.25).toFixed(1));
console.log((1.005).toFixed(2));
console.log((0).toFixed(2));
console.log((1e21).toFixed(2));
console.log((123.456).toFixed(0));
console.log((-1.5).toFixed(0));
console.log((0.000001).toFixed(7));
`);
  });

  test("toString(radix) still matches V8 digit for digit", async () => {
    await expectSameAsNode(`
console.log((255).toString(16));
console.log((0.1).toString(2));
console.log((1 / 3).toString(3));
console.log((-255).toString(2));
console.log((1e21).toString(36));
console.log((123.456).toString(8));
`);
  });
});
