/*
 * Conformance harness — runs the node-verified corpus (test/corpus/cases.json,
 * distilled from TypeScript conformance semantics) through our full pipeline.
 *
 * A case either COMPILES (then its stdout must match node exactly) or is REJECTED
 * by the checker as an unsupported construct (a skip, tracked). No compiled case
 * is ever allowed to MISMATCH node, and we gate on a minimum supported count so
 * coverage can't silently regress.
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
const cases: Case[] = JSON.parse(readFileSync(join(HERE, "corpus", "cases.json"), "utf8"));

// Constructs deliberately outside the static-typed subset (documented divergences).
const KNOWN_UNSUPPORTED = new Set([
  "logical-and-shortcircuit", // value-returning && with mixed operand types
  "logical-or-shortcircuit",  // value-returning || with mixed operand types
]);
const MIN_SUPPORTED = cases.length - KNOWN_UNSUPPORTED.size;

describe("conformance corpus", () => {
  test(`compiled cases match node; >= ${MIN_SUPPORTED} supported`, async () => {
    const mismatches: string[] = [];
    const unexpectedSkips: string[] = [];
    let supported = 0;

    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), "conf-"));
      try {
        const bin = join(dir, "p");
        let compiled = true;
        try {
          await buildBinary(c.code, bin, { target: "host" });
        } catch {
          compiled = false;
        }
        if (!compiled) {
          if (!KNOWN_UNSUPPORTED.has(c.name)) unexpectedSkips.push(c.name);
          continue;
        }
        supported++;
        const out = spawnSync(bin, [], { encoding: "utf8" }).stdout ?? "";
        if (out !== c.expectedStdout) {
          mismatches.push(`${c.name}: got ${JSON.stringify(out)} want ${JSON.stringify(c.expectedStdout)}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    expect(mismatches).toEqual([]);
    expect(unexpectedSkips).toEqual([]);
    expect(supported).toBeGreaterThanOrEqual(MIN_SUPPORTED);
  }, 120_000);
});
