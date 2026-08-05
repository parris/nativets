/*
 * vigenere CLI (examples/vigenere.ts) — a Vigenère cipher (Caesar = the
 * degenerate 1-char-key case), driven by `process.argv.slice(2)` =
 * [mode, key, text]. Uses the Host I/O differential harness: the same args go
 * to `node` and to our compiled binary, and stdout + exit code must match
 * byte-for-byte (plain letter mapping, so node is the oracle).
 *
 * `charCodeAt`/`String.fromCharCode` are not in the accepted subset, so the
 * example maps letters through two alphabet strings via `indexOf`/`charAt`;
 * the output is built with immutable string `+=` (no array mutation).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "vigenere.ts"), "utf8");

const cases: string[][] = [
  ["encode", "LEMON", "Attack at dawn!"], // canonical Vigenère (Wikipedia)
  ["decode", "LEMON", "Lxfopv ef rnhr!"], // decode partner of the above
  ["encode", "KEY", "Hello, World!"], // mixed case + punctuation pass-through
  ["decode", "KEY", "Rijvs, Uyvjn!"], // decode partner
  ["encode", "k", "abcdef"], // 1-char key == Caesar shift 10
  ["decode", "k", "klmnop"], // Caesar decode partner
  ["encode", "abc", "The quick brown FOX."], // longer key, mixed case
  ["decode", "wombat", "P zsjl ba wbvsq!"], // arbitrary decode
  ["encode", "bad", ""], // empty text -> empty line
  ["frobnicate", "x", "y"], // unknown mode -> usage
  [], // no args -> hardcoded demo (round-trip)
];

describe("examples/vigenere.ts (argv-driven Vigenère cipher)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  // Round-trip: decode(encode(x)) === x, both computed by our compiled binary,
  // exercising mixed case + punctuation pass-through.
  test("round-trip encode then decode (mixed case + punctuation)", async () => {
    const plain = "Meet me at 5, by the Old Oak!";
    const enc = await compileAndRunIO(source, { args: ["encode", "SECRET", plain] });
    const cipher = enc.stdout.trim();
    const dec = await compileAndRunIO(source, { args: ["decode", "SECRET", cipher] });
    expect(dec.stdout).toBe(plain + "\n");
    expect(dec.exitCode).toBe(0);
  });
});
