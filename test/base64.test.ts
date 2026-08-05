/*
 * base64 CLI (examples/base64.ts) — encode/decode via the stdlib btoa/atob
 * globals, driven by argv. Uses the Host I/O differential harness: the same
 * args go to `node` and to our compiled binary, and stdout + exit code must
 * match byte-for-byte (node has btoa/atob as globals, so it is the oracle).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "base64.ts"), "utf8");

const cases: string[][] = [
  ["encode", "hello"], // basic encode
  ["decode", "aGVsbG8="], // basic decode
  ["encode", "nativets"], // padding-free result
  ["decode", "bmF0aXZldHM="], // round-trip partner of the above
  ["encode", "Man"], // exact 3-byte group, no padding
  ["decode", "TWFu"],
  ["encode", "Ma"], // one pad char
  ["encode", "M"], // two pad chars
  ["encode", ""], // empty input -> empty output
  ["bogus", "x"], // unknown mode -> usage
  [], // no args -> usage
];

describe("examples/base64.ts (argv-driven btoa/atob)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  // Round-trip: decode(encode(x)) === x, both computed by our compiled binary.
  test("round-trip encode then decode", async () => {
    const enc = await compileAndRunIO(source, { args: ["encode", "round trip!"] });
    const b64 = enc.stdout.trim();
    const dec = await compileAndRunIO(source, { args: ["decode", b64] });
    expect(dec.stdout).toBe("round trip!\n");
    expect(dec.exitCode).toBe(0);
  });
});
