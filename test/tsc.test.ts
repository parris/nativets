/*
 * `tsc` HAS NEVER SEMANTICALLY CHECKED THIS PROJECT. This file is the gate that keeps
 * it checking.
 *
 * ---- The hole this closes ----
 * `bunx tsc --noEmit` against the root `tsconfig.json` reported 16 errors, all TS1109
 * ("Expression expected"), all in `test/pipeline/*.ts`. Those fixtures use nativets'
 * pipeline operator `|>`, which is not TypeScript syntax. And tsc does not compute
 * SEMANTIC diagnostics for a program that has SYNTACTIC ones — so 16 parse errors in
 * eleven fixture files masked every type error in `src/` for the life of the project.
 * The mask was total and permanent: no amount of running the command would have shown
 * one, and the output looked like a small, tidy, well-understood failure.
 *
 * Lifting it (see `tsconfig.src.json`) found 57 real semantic errors in `src/`, among
 * them a "reject, never miscompile" hole:
 *
 *   parser.ts `scanExternalNames` stopped at the module specifier with
 *   `u.type === "string"`, and `TokenType` spells that token `"str"` — TS2367, "these
 *   types have no overlap". The stop never fired, so a `import "./m.ts";` or an
 *   `import.meta.url` made the scan run to end of file and put every identifier in the
 *   module into `externalNames`, which is what DECLINES the NT2003 unknown-name
 *   refusal. `const x: Bogus = 1;` compiled. 67 of the 496 `.ts` files in this tree
 *   contain such an import, so NT2003's "fires zero times across the corpus"
 *   measurement had been taken over a corpus that structurally could not produce the
 *   signal in 13% of its files.
 *
 * plus a `Ty` union missing eight of its own arms (every `isDateTy`/`isBytesTy`-style
 * predicate was provably-false to tsc), and `exprLoc`'s `UnaryExpr` arm reading a field
 * name that does not exist, which silently dropped the source span from every
 * diagnostic about a unary expression.
 *
 * ---- What this file asserts ----
 *   1. the mask is REAL and is why a second config exists — the root config still
 *      reports syntax errors and NOTHING ELSE, so a future reader cannot conclude that
 *      `bunx tsc` alone was ever sufficient;
 *   2. the honest config is CLEAN, as a ratchet keyed by (file, code): a count may fall
 *      but never rise, and a pair that reaches zero is DELETED from the table rather
 *      than set to 0, so a cleared file cannot silently take an error back.
 *
 * The table is EMPTY today. All 57 were fixed rather than suppressed.
 *
 * ---- Why the fixtures are excluded, and why that is not a rug ----
 * `tsconfig.src.json` checks `src`, `types`, `test/*.test.ts` and `test/harness.ts`.
 * Everything else under `test/` is a nativets PROGRAM — a fixture this compiler
 * compiles and node runs as the oracle — not a TypeScript module. Checked as one tsc
 * project they produce ~950 errors that are all artifacts of the framing: TS2451
 * redeclarations, because 480-odd standalone programs each declaring `main`/`x` are one
 * shared script scope to tsc, and TS2304 for nativets globals (`spawn`, `send`,
 * `receive`, `self`). Not one is a fact about the code. The measurement is recorded in
 * the constant below so the exclusion stays a decision with a number attached rather
 * than a habit: `src` + harness = 57 errors, all real; whole tree = 1023, ~950 noise.
 */

import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSC = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));

/**
 * The RATCHET. `"<file>|<TS####>"` -> count. It may shrink, never grow, and an entry
 * that reaches zero is REMOVED rather than set to 0 — the same discipline as
 * `test/no-regex.test.ts`'s `REMAINING`, and for the same reason: a file cleared of a
 * class of error must not be able to quietly take one back.
 *
 * Keyed by file and code, not by line: line numbers move whenever a lane adds code
 * above, and `test/sh6.test.ts` records what pinning a position costs (a test reddened
 * because an unrelated lane shifted `1109:66` to `1169:66` while nothing had moved).
 */
const ALLOWED: Record<string, number> = {}; // EMPTY — all 57 fixed. Keep it that way.

/** Measured once, at the commit that introduced this file. See the header. */
const WHOLE_TREE_ERRORS_INCLUDING_FIXTURE_NOISE = 1023;

/** `path(line,col): error TS####: text` -> `"path|TS####"`, tallied. */
export function tallyDiagnostics(output: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of output.split("\n")) {
    // The continuation lines of a multi-line diagnostic ("  Type 'x' is not assignable
    // to…") are indented and carry no `error TS` of their own; they are not errors.
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const at = line.indexOf(": error TS");
    if (at < 0) continue;
    const paren = line.lastIndexOf("(", at);
    if (paren < 0) continue;
    const file = line.slice(0, paren);
    const rest = line.slice(at + ": error ".length);
    const end = rest.indexOf(":");
    const code = end < 0 ? rest.trim() : rest.slice(0, end);
    const key = `${file}|${code}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Every distinct TS code in a tally, sorted — the shape a reader wants first. */
function codesIn(tally: Record<string, number>): string[] {
  return [...new Set(Object.keys(tally).map((k) => k.slice(k.indexOf("|") + 1)))].sort();
}

function runTsc(project: string): string {
  const r = spawnSync(TSC, ["-p", project, "--noEmit"], {
    cwd: ROOT, encoding: "utf8", timeout: 300_000, killSignal: "SIGKILL",
  });
  if (r.error) throw r.error;
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("tsc type-checks this project", () => {
  test("the type-checker is installed (a skipped gate is a vacuous one)", () => {
    // Deliberately NOT `test.skipIf(...)`. A lint that silently disappears when its tool
    // is missing is exactly the failure mode this whole file exists to correct: it
    // reports success for a check it did not run. `typescript` is a devDependency and
    // CI installs with `--frozen-lockfile`, so absence here is a real breakage.
    expect(existsSync(TSC)).toBe(true);
  });

  /*
   * THE MASK, pinned. The root config still contains the `|>` fixtures, and this asserts
   * what that costs: syntax errors and NOT ONE semantic diagnostic, no matter how many
   * type errors `src/` contains. If a future change makes the root config semantic too,
   * this test fails and `tsconfig.src.json` can be retired — which is the outcome it is
   * here to make visible, rather than leaving two configs and no explanation.
   */
  test("the ROOT config reports syntax errors ONLY — this is why a second config exists", () => {
    const tally = tallyDiagnostics(runTsc("tsconfig.json"));
    // TS1xxx is the syntactic range; TS2xxx and up are semantic.
    const semantic = codesIn(tally).filter((c) => !c.startsWith("TS1"));
    expect({ semantic, syntactic: codesIn(tally) }).toEqual({ semantic: [], syntactic: ["TS1109"] });
  });

  test("the honest config is CLEAN (src, types, and the *.test.ts harness)", () => {
    const tally = tallyDiagnostics(runTsc("tsconfig.src.json"));
    // Compared as whole objects so BOTH directions are visible in the failure: a new
    // (file, code) pair, and an entry in ALLOWED that no longer occurs and must be
    // deleted. `toEqual` on the tally is the ratchet — there is no "<=" slack, because
    // slack is how a fixed error gets replaced by a different one for free.
    expect(tally).toEqual(ALLOWED);
  });

  /*
   * The parser must be able to FAIL, or the green above means nothing. Exercised on
   * canned tsc output rather than a second compiler run: the shapes below are the ones
   * that actually appeared, including the indented continuation line that would double
   * the count of every multi-line diagnostic if it were treated as an error.
   */
  test("the diagnostic scan counts real errors and not continuation lines", () => {
    const output = [
      "src/checker.ts(2367,11): error TS2322: Type '\"TextDecoder\" | \"TextEncoder\"' is not assignable to type 'Ty'.",
      "  Type '\"TextDecoder\"' is not assignable to type 'Ty'.",
      "src/parser.ts(490,13): error TS2367: This comparison appears to be unintentional because the types 'TokenType' and '\"string\"' have no overlap.",
      "src/checker.ts(1668,43): error TS2367: This comparison appears to be unintentional.",
      "",
    ].join("\n");
    expect(tallyDiagnostics(output)).toEqual({
      "src/checker.ts|TS2322": 1,
      "src/checker.ts|TS2367": 1,
      "src/parser.ts|TS2367": 1,
    });
  });

  test("a path containing parentheses is still split at the POSITION, not the path", () => {
    expect(tallyDiagnostics("a (b)/c.ts(1,2): error TS2339: nope")).toEqual({ "a (b)/c.ts|TS2339": 1 });
  });

  test("clean output, and non-diagnostic chatter, tally to nothing", () => {
    expect(tallyDiagnostics("")).toEqual({});
    expect(tallyDiagnostics("Version 7.0.2\nFound 0 errors.\n")).toEqual({});
  });

  /*
   * The number that keeps the fixture exclusion honest. It is a recorded MEASUREMENT,
   * not an assertion about today's tree — re-measure with
   *   include: ["src", "test"], exclude: ["test/pipeline"]
   * if you want to argue the boundary should move. Pinned as a constant so the header's
   * "~950 of them are noise" claim has a date and a source rather than being folklore.
   */
  test("the excluded surface was measured, not assumed", () => {
    expect(WHOLE_TREE_ERRORS_INCLUDING_FIXTURE_NOISE).toBeGreaterThan(Object.keys(ALLOWED).length);
  });
});
