/*
 * stdlib: URL parsing — differential vs node.
 *
 * nativets has no classes, so the WHATWG `new URL(u)` API is exposed FUNCTIONALLY:
 * urlProtocol/urlHost/urlHostname/urlPathname/urlSearch/urlHash(u) and
 * urlSearchParam(u, key). Each fixture under test/stdlib-url/ is compiled + run,
 * then asserted equal to node — where a tiny polyfill defines those globals in
 * terms of `new URL(...)` (see URL_POLYFILL in harness.ts), so node stays the
 * oracle for our supported subset (absolute http(s) URLs).
 *
 * These live OUTSIDE test/fixtures/ on purpose (like test/hostio/): the generic
 * fixtures harness runs every case under PLAIN node, where urlProtocol(...) is
 * undefined — so the URL builtins need the polyfilled oracle here instead.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNodeURL } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "stdlib-url");

const files = ["basic.ts", "ports-empty.ts", "searchparams.ts"];

describe("stdlib: URL (differential vs node)", () => {
  for (const file of files) {
    describe(file, () => {
      const source = readFileSync(join(DIR, file), "utf8");

      test("matches node (differential)", async () => {
        const oracle = runWithNodeURL(source);
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
