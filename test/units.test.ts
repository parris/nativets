/*
 * units CLI (examples/units.ts) — an argv-driven unit converter across three
 * dimensions (temperature C/F/K, length m/km/mi/ft, mass kg/lb/g). Uses the Host
 * I/O differential harness: the same argv goes to `node file.ts <args>` and to
 * our compiled binary, and stdout + exit code must match byte-for-byte.
 *
 * The point of interest is number formatting: the converted result is a plain
 * double interpolated with `${}`, and nativets prints doubles with the same
 * shortest-round-trip algorithm node uses — so fractional / irrational-ish
 * results (37 C -> 98.6 F, 5 km -> 3.1068559611866697 mi, 2 kg -> ...lb) must
 * come out identical without any rounding of our own. Also asserts the demo
 * (no-args) output equals the shipped examples/units.ts.expected.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "units.ts"), "utf8");
const expected = readFileSync(join(HERE, "..", "examples", "units.ts.expected"), "utf8");

const cases: string[][] = [
  // temperature, both directions (affine — offsets matter)
  ["37", "C", "F"], // -> 98.6 (fractional; classic body-temp case)
  ["98.6", "F", "C"], // -> 37 (exact round-trip partner)
  ["100", "C", "K"], // -> 373.15
  ["273.15", "K", "C"], // -> 0 (freezing point)
  // length, both directions (pure scale factors)
  ["5", "km", "mi"], // -> 3.1068559611866697 (irrational-ish, stresses formatting)
  ["3", "mi", "km"], // -> 4.828032
  ["1000", "m", "km"], // -> 1
  ["6", "ft", "m"], // -> 1.8288
  // mass, both directions
  ["1", "lb", "kg"], // -> 0.45359237
  ["2", "kg", "lb"], // -> 4.409245243697551 (many-digit, stresses formatting)
  ["500", "g", "kg"], // -> 0.5
  // invalid usage
  ["10", "C", "m"], // cross-dimension -> usage line
  ["5", "banana", "m"], // unknown unit -> usage line
  [], // no args -> demo set
];

describe("examples/units.ts (argv-driven unit converter)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  // The shipped .expected is the no-args demo output — assert our binary matches
  // it without needing node at test time.
  test("no-args demo matches examples/units.ts.expected", async () => {
    const ours = await compileAndRunIO(source, { args: [] });
    expect(ours.stdout).toBe(expected);
    expect(ours.exitCode).toBe(0);
  });
});
