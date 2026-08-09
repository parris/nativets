/*
 * DETERMINISM — the same source must compile to the same bytes, every time.
 *
 * SH7's definition of done is "`nativets-2` and `nativets-3` are BYTE-IDENTICAL"
 * (docs/self-hosting.md). That is not a property you get by clearing blockers: ONE
 * clock read, PID, address or unordered walk anywhere in the pipeline makes the fixed
 * point unreachable permanently, no matter how much of the compiler self-compiles.
 * It has already happened once — `choosePrefixBase` minted the module alpha-rename
 * prefix from `Date.now()`, so two measurements in the SAME RUN produced different
 * global names (test/modules.test.ts records the fallout).
 *
 * Two checks, and the second is the load-bearing one:
 *
 *   1. TWICE IN ONE PROCESS. Catches a value that drifts DURING a run.
 *   2. TWICE IN TWO PROCESSES. Catches anything seeded ONCE per process — a
 *      module-level `Date.now()`, a PID, a `Math.random()` cached in a top-level
 *      `const`, a heap address. Check 1 is BLIND to all of those, and it is nearly
 *      blind to the clock bug too: compiling src/lexer.ts in-process takes ~20ms, so
 *      two `Date.now()` reads around it land in the same millisecond often enough
 *      that check 1 alone would be a coin flip. Check 2 is not a nice-to-have.
 *
 * The inputs are DISCOVERED, not listed, and the discovery is asserted non-empty —
 * this repo's instruments have repeatedly turned out to measure nothing (a `phaseOf`
 * that scored a crash as `ir`, a `coverage` that scored a compiler crash as "no
 * blockers"), and a determinism test over an empty set is the same failure.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { sourceToIR } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EMIT = join(HERE, "determinism-emit.ts");

/** IR for `path`, or `null` when the compiler refuses it (a refusal is not our subject). */
function irOf(path: string): string | null {
  try { return sourceToIR(readFileSync(path, "utf8"), path); } catch { return null; }
}

/** IR for `path` from a FRESH PROCESS. Same entry-path spelling, so the only change is the process. */
function irOfChild(path: string): string {
  const r = spawnSync("bun", ["run", EMIT, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`child emit failed for ${path}: ${r.stderr?.slice(0, 400)}`);
  return r.stdout;
}

/* The multi-module case that forces `choosePrefixBase` past ALL THREE preferred bases
 * (test/determinism/dep.ts spells `_m`, `_nt_m` and `_nativets_module_` as literals),
 * i.e. onto the counter branch that used to read the clock. A single-file program never
 * reaches `choosePrefixBase` at all — `linkProgram` is a no-op without imports — so
 * without this asset the whole prefix hazard is outside what this file measures. */
const PREFIX_CASE = join(HERE, "determinism", "main.ts");

/** Every `src/*.ts` that reaches IR today, discovered. The list grows as SH blockers clear. */
function srcModulesReachingIR(): string[] {
  return readdirSync(join(ROOT, "src")).sort()
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(ROOT, "src", f))
    .filter((p) => irOf(p) !== null);
}

/** A deterministic spread of standalone fixtures. */
function fixtureSpread(n: number): string[] {
  const all: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) all.push(p);
    }
  })(join(HERE, "fixtures"));
  all.sort();
  const step = Math.max(1, Math.floor(all.length / n));
  const out: string[] = [];
  for (let i = 0; i < all.length; i += step) out.push(all[i]!);
  return out;
}

describe("the compiler is deterministic", () => {
  const srcIR = srcModulesReachingIR();
  const fixtures = fixtureSpread(24);

  test("the corpus this file measures is not empty", () => {
    // The vacuity guard. If every src module regresses off IR, or the fixture walk
    // finds nothing, the checks below all pass over zero inputs and say nothing.
    expect(srcIR.length).toBeGreaterThan(0);
    expect(fixtures.length).toBeGreaterThan(10);
    expect(irOf(PREFIX_CASE)).not.toBeNull();
  });

  test("the same source compiles to the same bytes TWICE IN ONE PROCESS", () => {
    const differ: string[] = [];
    for (const p of [PREFIX_CASE, ...fixtures, ...srcIR]) {
      const a = irOf(p);
      if (a === null) continue;
      if (irOf(p) !== a) differ.push(p);
    }
    expect(differ).toEqual([]);
  });

  test("the same source compiles to the same bytes IN TWO DIFFERENT PROCESSES", () => {
    // A fresh process per input, so a once-per-process seed cannot hide.
    const differ: string[] = [];
    for (const p of [PREFIX_CASE, ...srcIR, ...fixtureSpread(8)]) {
      const a = irOf(p);
      if (a === null) continue;
      if (irOfChild(p) !== a) differ.push(p);
    }
    expect(differ).toEqual([]);
  });

  test("the alpha-rename prefix is the same in two processes", () => {
    // Narrower and more legible than the sweep above: this is the exact construct the
    // clock bug lived in, named so a failure points at `choosePrefixBase` directly.
    const ir = irOfChild(PREFIX_CASE);
    expect(ir).toContain("_nts0_m0_two"); // the first free counter value, never a timestamp
    expect(irOfChild(PREFIX_CASE)).toBe(ir);
    expect(irOf(PREFIX_CASE)).toBe(ir);
  });

  test("the IR does not depend on the ENVIRONMENT", () => {
    // TZ and locale are the classic accidental inputs (a `toLocaleString`, a
    // locale-aware sort). nativets refuses `localeCompare`/`toLocale*` at NT1024, and
    // this pins that the refusal is load-bearing rather than incidental.
    const base = irOfChild(PREFIX_CASE);
    for (const env of [{ TZ: "UTC" }, { TZ: "Pacific/Auckland" }, { LC_ALL: "tr_TR.UTF-8" }]) {
      const r = spawnSync("bun", ["run", EMIT, PREFIX_CASE],
        { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(base);
    }
  });
});

/*
 * THE ENTRY PATH REACHES THE `.ll`. Pinned as a KNOWN HAZARD, not asserted away.
 *
 * A bounds panic reports `file:line:col`, and `file` is whatever path the caller
 * handed the compiler (`src/codegen.ts` `locArg` → `Loc.file`, set by `src/modules.ts`
 * from `entryPath` for the entry and from the RESOLVED ABSOLUTE path for every
 * imported module). So:
 *
 *   - `nativets build src/lexer.ts` and `nativets build /abs/.../src/lexer.ts` emit
 *     DIFFERENT IR (~5 KB apart on lexer.ts) — the spelling is carried verbatim;
 *   - two byte-identical source trees at different absolute paths emit different IR,
 *     because an imported module's path is always absolute.
 *
 * SH7 survives this only because stage-2 and stage-3 compile the same tree at the same
 * path with the same argv. It does mean the compiler is NOT reproducible across
 * machines or checkout directories, and any bootstrap that stages sources through a
 * `mkdtemp` directory breaks byte-identity outright. Recording it so a future
 * normalization (relative-to-a-root paths) is a deliberate change with a test to
 * update, rather than a surprise.
 */
describe("the entry path is an INPUT to the IR (known SH7 hazard)", () => {
  test("the same file under two spellings emits different IR", () => {
    const abs = join(ROOT, "src", "lexer.ts");
    const rel = "src/lexer.ts"; // resolved against the repo root below
    const a = sourceToIR(readFileSync(abs, "utf8"), abs);
    const b = sourceToIR(readFileSync(abs, "utf8"), rel);
    expect(a).not.toBe(b);
    expect(a).toContain(`c"${abs}:`);
    expect(b).toContain(`c"${rel}:`);
  });
});
