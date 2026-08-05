/*
 * Host I/O FFI — differential vs node.
 *
 * Each fixture under test/hostio/ reads INPUT (CLI args / stdin / env). The
 * harness feeds identical argv + stdin + env to `node file.ts <args>` and to our
 * compiled `./binary <args>`, then asserts stdout + exit code match byte-for-byte.
 *
 * These live OUTSIDE test/fixtures/ on purpose: the generic fixtures harness runs
 * every case with no args / no stdin (and snapshots its IR), which is wrong for a
 * program that reads input. Here node is still the oracle — stdin's readLine/
 * readStdin are polyfilled for the node run only (see harness.ts).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "hostio");

interface Case { file: string; io: IOInput; }
const cases: Case[] = [
  { file: "echo-argv.ts", io: { args: ["alpha", "beta", "gamma"] } },
  { file: "echo-argv.ts", io: { args: [] } }, // no user args: length 2, slice(2) empty
  { file: "sum-argv.ts", io: { args: ["10", "20", "12"] } },
  { file: "sum-argv.ts", io: { args: [] } }, // empty → 0
  { file: "echo-line.ts", io: { stdin: "hello world\nsecond line\n" } },
  { file: "echo-line.ts", io: { stdin: "" } }, // EOF → empty line
  { file: "stdin-length.ts", io: { stdin: "abcdef" } },
  { file: "stdin-length.ts", io: { stdin: "line1\nline2\n" } },
  { file: "multi-line.ts", io: { stdin: "one\ntwo\nthree\nfour" } },
  { file: "env-exit.ts", io: { env: { GREETING: "hi there" } } },
];

describe("host I/O (differential vs node)", () => {
  for (const { file, io } of cases) {
    const label = `${file} ${JSON.stringify(io)}`;
    test(label, async () => {
      const source = readFileSync(join(DIR, file), "utf8");
      const oracle = runWithNodeIO(source, io);
      const ours = await compileAndRunIO(source, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
