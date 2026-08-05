/*
 * JSON round-trip + pretty-printer (examples/json-pretty.ts). Reads the JSON text from
 * argv (falling back to a built-in default), so it uses the Host I/O differential harness
 * (same args to `node` and to our binary). Exercises the Stage-17/20 JSON surface end to
 * end: JSON.parse -> Dyn field/index access -> `as T` narrowing -> JSON.stringify round-trip,
 * plus a hand-rolled 2-space pretty printer whose output matches node by construction.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "json-pretty.ts"), "utf8");

// Each case is an argv (identical on both sides). All JSON is ASCII and shape-matches Config.
const cases: string[][] = [
  [], // no args -> the built-in default is parsed + round-tripped
  ['{"name":"woosh","version":10,"stable":false,"tags":["x","y"],"limits":{"min":-5,"max":42}}'],
  ['{"name":"a","version":1,"stable":true,"tags":["p","q","r"],"limits":{"min":0,"max":9}}'],
  // multi-token args are joined with spaces (JSON.parse tolerates the interior whitespace)
  ['{"name":"j","version":3,"stable":false,"tags":["only"],"limits":{"min":7,', '"max":8}}'],
];

describe("examples/json-pretty.ts (JSON round-trip, argv-driven)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
