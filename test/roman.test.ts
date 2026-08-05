/*
 * Roman numeral example test — compile+run `examples/roman.ts` as a real
 * nativets binary and assert its output matches the `node` oracle (and the
 * curated `.expected`). Exercises the immutable-array subset: two parallel
 * seeded tables (`number[]` + `string[]`) read purely by index in a greedy
 * encoder, string building via `+=`, and `.charAt`/`.length` in the decoder.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "roman.ts");

describe("examples/roman.ts", () => {
  const source = readFileSync(FILE, "utf8");

  test("matches node (differential)", async () => {
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0);
  });

  test("matches curated expected output", async () => {
    const ep = `${FILE}.expected`;
    if (!existsSync(ep)) return;
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(readFileSync(ep, "utf8"));
    expect(ours.exitCode).toBe(0);
  });
});
