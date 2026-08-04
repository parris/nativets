/*
 * Gap conformance — the "make the whole thing work" corpus (test/corpus/gap_cases.json,
 * 55 node-verified cases spanning features beyond Stage 1-5).
 *
 * Same contract as the base conformance test: every case that COMPILES must match
 * node byte-for-byte; the rest are an explicit allow-list of features that need the
 * heap value model / closures / unions / exceptions (a real architectural push,
 * tracked in docs/divergences.md). A minimum-supported gate guards coverage.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
interface Case { name: string; feature: string; code: string; expectedStdout: string; }
const cases: Case[] = JSON.parse(readFileSync(join(HERE, "corpus", "gap_cases.json"), "utf8"));

// Features that need the heap value model / closures / unions / exceptions — the
// next architectural frontier. Rejected with an NT1xxx diagnostic, never miscompiled.
const KNOWN_UNSUPPORTED = new Set([
  // arrays, objects, Object.keys, for-in, and .map/.filter/.reduce (inline arrows) supported ✅.
  // first-class functions + closures supported ✅ except nested function types:
  "higher-order-compose",
  "optional-chaining", // needs nested objects + optional fields
]);
const MIN_SUPPORTED = cases.length - KNOWN_UNSUPPORTED.size;

describe("gap conformance corpus", () => {
  test(`compiled cases match node; >= ${MIN_SUPPORTED} supported`, async () => {
    const mismatches: string[] = [];
    const unexpectedSkips: string[] = [];
    let supported = 0;

    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), "gap-"));
      try {
        const bin = join(dir, "p");
        let compiled = true;
        try { await buildBinary(c.code, bin, { target: "host" }); } catch { compiled = false; }
        if (!compiled) {
          if (!KNOWN_UNSUPPORTED.has(c.name)) unexpectedSkips.push(c.name);
          continue;
        }
        supported++;
        const out = spawnSync(bin, [], { encoding: "utf8" }).stdout ?? "";
        if (out !== c.expectedStdout) mismatches.push(`${c.name}: got ${JSON.stringify(out)} want ${JSON.stringify(c.expectedStdout)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    expect(mismatches).toEqual([]);
    expect(unexpectedSkips).toEqual([]);
    expect(supported).toBeGreaterThanOrEqual(MIN_SUPPORTED);
  }, 180_000);
});
