/*
 * Line-diff example test — compile+run `examples/diff.ts` as a real nativets
 * binary and assert its output matches the `node` oracle (and the curated
 * `.expected`). Exercises the immutable-array subset in anger: an LCS dynamic-
 * programming table built with NO in-place mutation — a flat `number[]` grown
 * via spread (`dp = [...dp, 0]`) and filled with copy-on-write `dp.with(k, v)`
 * (the sanctioned replacement for `dp[k] = v`), indexed 2-D as `dp[i*w + j]`.
 * Plus `.split("\n")`, string-element equality, and diff assembly via `+=`.
 *
 * The single program prints four hardcoded scenarios — identical texts (all
 * lines unchanged), a pure insertion, a pure deletion, and a mixed edit
 * (interleaved deletions/additions/unchanged) — so one run covers the diff's
 * every branch. Deterministic; `node` is the byte-for-byte oracle.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "diff.ts");

describe("examples/diff.ts", () => {
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
