/*
 * stdlib: URL parsing — differential vs node.
 *
 * Batch 3 turned this into the REAL `new URL(u)` class (classes landed in
 * SH3–SH3.6), so these fixtures are now ordinary TypeScript that node runs as
 * written: node is the DIRECT oracle, with no polyfill. (Before classes existed
 * the same subset was exposed as `urlProtocol(u)`-style global functions and the
 * oracle needed a `URL_POLYFILL` prelude; both are gone.)
 *
 * The fixtures stay here rather than in test/fixtures/ purely for history — they
 * would run fine under the generic harness now.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "stdlib-url");

const files = ["basic.ts", "ports-empty.ts", "searchparams.ts"];

describe("stdlib: URL (differential vs node)", () => {
  for (const file of files) {
    describe(file, () => {
      const source = readFileSync(join(DIR, file), "utf8");

      test("matches node (differential)", async () => {
        const oracle = runWithNode(source);
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });

      test("matches curated expected output", async () => {
        const ep = join(DIR, `${file}.expected`);
        if (!existsSync(ep)) return;
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(readFileSync(ep, "utf8"));
        expect(ours.exitCode).toBe(0);
      });
    });
  }
});
