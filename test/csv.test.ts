/*
 * examples/csv.ts — a tiny CSV parser + query tool (Host I/O tier).
 *
 * Differential vs node: the SAME stdin is fed to `node csv.ts` (with the harness's
 * readStdin polyfill) and to our compiled binary; stdout + exit code must match
 * byte-for-byte. Exercises the immutable subset (spread growth, `.split`, `.join`,
 * `.charAt`, `Number`, quote-aware field parsing) over Host I/O stdin.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "examples", "csv.ts"), "utf8");
const EXPECTED = readFileSync(join(HERE, "..", "examples", "csv.ts.expected"), "utf8");

const cases: { name: string; io: IOInput }[] = [
  // Empty stdin -> the hardcoded default table (quoted embedded commas).
  { name: "default table (empty stdin)", io: { stdin: "" } },
  // Whitespace-only stdin also falls back to the default (trim -> empty).
  { name: "whitespace-only stdin -> default", io: { stdin: "   \n\t\n" } },
  // A custom table with a quoted field containing a comma.
  {
    name: "custom table with quoted comma",
    io: {
      stdin:
        'name,role,pay\n' +
        '"Doe, John",eng,120\n' +
        'Sue,design,95\n' +
        'Ann,eng,110\n',
    },
  },
  // Escaped quotes ("" -> a literal ") inside a quoted field.
  {
    name: "escaped quotes inside quoted field",
    io: {
      stdin:
        'sku,label,qty\n' +
        'A1,"6\"\" pipe",3\n' +
        'A2,plain,7\n',
    },
  },
  // Header only, no data rows.
  { name: "header only, no data rows", io: { stdin: "a,b,c\n" } },
  // No trailing newline on the last row.
  {
    name: "no trailing newline",
    io: { stdin: "x,y\n1,10\n2,20\n3,30" },
  },
  // A repeating-decimal average, to pin number->string formatting to node.
  {
    name: "repeating-decimal average",
    io: { stdin: "k,v\na,1\nb,2\nc,2\n" },
  },
  // Negative and fractional numeric column values.
  {
    name: "negative and fractional values",
    io: { stdin: "k,v\na,-5\nb,2.5\nc,10\n" },
  },
];

describe("examples/csv.ts (differential vs node)", () => {
  for (const { name, io } of cases) {
    test(name, async () => {
      const oracle = runWithNodeIO(SOURCE, io);
      const ours = await compileAndRunIO(SOURCE, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  // Curated expected: the default-table run matches the checked-in .expected.
  test("default table matches csv.ts.expected", async () => {
    const ours = await compileAndRunIO(SOURCE, { stdin: "" });
    expect(ours.stdout).toBe(EXPECTED);
    expect(ours.exitCode).toBe(0);
  });
});
