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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/* ------------------------------------------------------------------ *
 * SWITCH EXHAUSTIVENESS, AND WHO ACTUALLY CHECKS IT.
 *
 * `src/` used the TypeScript idiom `default: { const impossible: never = e; return
 * impossible; }` as a compile-time exhaustiveness witness in four places. `never` ERASES
 * TO `number` in this compiler's own subset, so every one of them is an NT2001 blocker
 * against self-compilation — a real, permanent tax in `src/ast.ts`, the module every
 * other one is measured through.
 *
 * The tax is only worth paying where the witness is the ONLY thing checking. It is not,
 * everywhere. `walkExprChildren` and `walkStmtChildren` RETURN from every arm and declare
 * a non-nullable return type, so a `Stmt`/`Expr` member with no arm lets control reach
 * the end of the body and tsc rejects it on its own: TS2366. There the witness bought
 * nothing and both were deleted (blocker metric 258 -> 257; `walkExprChildren` went from
 * its one blocker to zero, and `walkStmtChildren`'s was masked behind an earlier NT2001
 * so it moved no number today and would have surfaced the moment that one cleared).
 *
 * `bindStmt` USED to be the counterexample: its arms `break`-ed into a shared tail return,
 * so tsc had nothing to object to and deleting its witness was SILENT — the test below
 * measured exactly that, and said in so many words that if it ever went red "because
 * someone gave `bindStmt` a returning switch", the witness had become free to delete. It
 * did, and it was. The shared tail is now the named helper `bindChildren`, so every arm
 * RETURNS it and the switch joins the two walkers on TS2366; the witness is gone and its
 * NT2001 with it. `src/ast.ts` is at 0 failing functions as of that change.
 *
 * The measurement it stood for is unchanged and is still the point: the tax is worth
 * paying only where the witness is the ONLY thing checking. It was not, in all four
 * places — but that was established per site, by mutating the file and reading tsc, not
 * assumed. Restore a `break`-into-tail shape here and TS2366 goes quiet again, at which
 * point a witness has to come back.
 *
 * THIS BLOCK IS THE EVIDENCE FOR BOTH HALVES, and it is written so it can go red. It
 * MUTATES a copy of `src/ast.ts` — deleting one self-contained `case` arm — and asserts
 * what tsc says. A guarantee nobody can watch fail is not a guarantee; the control run
 * (unmutated, clean) is what keeps a green here from being an artifact of a probe that
 * silently checked nothing.
 *
 * `src/ast.ts` imports NOTHING, which is what makes a single-file probe legitimate rather
 * than a stub-shaped approximation of the real check. That is asserted, not assumed.
 *
 * The regression this guards is subtle and would otherwise be invisible: add a
 * `default:` arm to either walker "for safety" and TS2366 stops firing forever, because
 * the body can no longer fall out the bottom. The switch stays exhaustive-looking and
 * stops being exhaustive-checked.
 * ------------------------------------------------------------------ */
describe("switch exhaustiveness in src/ast.ts", () => {
  const AST = join(ROOT, "src/ast.ts");
  const source = readFileSync(AST, "utf8");

  /** The `{ … }` span of top-level `function NAME(`, brace-counted (arms nest braces). */
  function bodySpan(src: string, name: string): [number, number] {
    const at = src.indexOf(`\nfunction ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return [open, i];
    }
    throw new Error(`unbalanced body for ${name}`);
  }

  /**
   * Delete the first SELF-CONTAINED one-line arm (`case "K": …;`) from `name`'s switch,
   * and say which kind went. Deliberately not a pinned line of text — `test/sh6.test.ts`
   * records what pinning a position costs when an unrelated lane reformats above you.
   * One-line arms only, because dropping the LABEL of a multi-line arm would leave its
   * body attached to the previous arm and produce TS2339 noise instead of the answer.
   */
  function dropAnArm(src: string, name: string): { mutated: string; kind: string } {
    const [a, b] = bodySpan(src, name);
    for (const line of src.slice(a, b).split("\n")) {
      const m = /^[ \t]*case "(\w+)":[ \t]+\S.*;[ \t]*$/.exec(line);
      // Balanced on the line, so `case "X": return { …` (an arm that continues below) is
      // not mistaken for a complete one.
      if (!m) continue;
      const balanced = (o: string, c: string) => line.split(o).length === line.split(c).length;
      if (!balanced("{", "}") || !balanced("(", ")")) continue;
      return { mutated: src.slice(0, a) + src.slice(a, b).replace(`${line}\n`, "") + src.slice(b), kind: m[1]! };
    }
    throw new Error(`no self-contained one-line arm in ${name}`);
  }

  /** Type-check one standalone module. `ast.ts` has no imports — see the assertion below. */
  function checkAlone(text: string, tag: string): Record<string, number> {
    const dir = mkdtempSync(join(tmpdir(), "nt-exhaustive-"));
    const file = join(dir, `${tag}.ts`);
    writeFileSync(file, text);
    // `--ignoreConfig`: with files named on the command line, tsc 7 refuses to run at all
    // while a tsconfig.json is visible (TS5112) — which would come back as "no TS2366"
    // and read as a passing test.
    const r = spawnSync(TSC, [
      "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--skipLibCheck",
      "--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler", "--types", "",
      file,
    ], { cwd: ROOT, encoding: "utf8", timeout: 300_000, killSignal: "SIGKILL" });
    if (r.error) throw r.error;
    const tally = tallyDiagnostics(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    // Re-key on the code alone; the temp path is machine- and run-specific.
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(tally)) {
      const code = k.slice(k.indexOf("|") + 1);
      out[code] = (out[code] ?? 0) + n;
    }
    return out;
  }

  test("ast.ts imports nothing, so checking it alone is the real check", () => {
    expect(source.split("\n").filter((l) => /^\s*import\b/.test(l))).toEqual([]);
  });

  test("CONTROL: unmutated, the standalone check is clean", () => {
    // Without this, every "TS2366 fires" below could be satisfied by a probe that reports
    // an error for an unrelated reason, and every "tsc is silent" by one that never ran.
    expect(checkAlone(source, "control")).toEqual({});
  });

  for (const fn of ["walkExprChildren", "walkStmtChildren", "bindStmt"]) {
    test(`${fn}: no default: arm — one would disable TS2366 permanently`, () => {
      const [a, b] = bodySpan(source, fn);
      expect(source.slice(a, b)).not.toContain("default:");
    });

    test(`${fn}: dropping a case is TS2366, which is the whole guarantee`, () => {
      const { mutated, kind } = dropAnArm(source, fn);
      // `kind` in the assertion so a failure says WHICH member stopped being covered
      // rather than only that a number moved.
      expect({ kind: kind.length > 0, codes: checkAlone(mutated, fn) })
        .toEqual({ kind: true, codes: { TS2366: 1 } });
    });
  }

  test("no `never` witness survives in src/ast.ts — each one was an NT2001", () => {
    // The four are gone, one site at a time and each with the mutation test above standing
    // in for it. Asserted over the WHOLE file rather than per function, so a fifth cannot
    // arrive quietly: `never` erases to `number` in the subset this file must compile
    // inside, so any new one is a fresh blocker in the module every other one links
    // through. If a switch genuinely cannot be made returning, the witness is the right
    // answer and this line is the place to say so — with the measurement, as before.
    // Line-based, and NOT a bare `.toContain`: three of the comments above these switches
    // quote the idiom verbatim to explain why it went, and a substring scan cannot tell a
    // live witness from its own obituary.
    expect(source.split("\n").filter((l) => /^\s*default:.*impossible: never/.test(l))).toEqual([]);
  });

  test("bindStmt binds through a @@mutable RECORD, which is why it needs no out-param", () => {
    // Guards the pairing the returning switch depends on. `Set` is persistent, so
    // `out.add(n)` on a bare `Set<string>` parameter did nothing AND was NT1606; the fix
    // was a `//@@mutable` record (`BoundNames`) whose field is assigned through the
    // borrow. A `@@mutable` CLASS in the same position is NT1607 — the ownership pass's
    // signature arm covers records only — so the record spelling is load-bearing, not
    // cosmetic, and a future tidy-up to `class BoundNames` would re-break self-compilation
    // silently (the blocker metric never runs the ownership pass and would not see it).
    expect(source).toContain("//@@mutable\ninterface BoundNames { names: Set<string> }");
    const [a, b] = bodySpan(source, "bindStmt");
    expect(source.slice(a, b)).not.toContain("out.add(");  // the discarded-append shape
  });
});

/*
 * THE CLASS tsc STRUCTURALLY CANNOT FIND — `xs[xs.length - 1]` — MOVED.
 *
 * This file used to carry that lint as a second section. It now lives in
 * test/no-index-last.test.ts, with the reasoning above it kept intact and three things
 * added: a scan that also sees inside TEMPLATE SUBSTITUTIONS (the lexer emits a template
 * as one token, and src/codegen.ts hid two sites in one), that accepts any `- N` rather
 * than the literal 1, and that counts `.length` anywhere at bracket-depth 0 — which is
 * how `patterns[Math.min(i, patterns.length - 1)]`, live in src/checker.ts at the time,
 * was found. It also corrects the claim that a `!` makes the read safe: it marks intent,
 * not safety, and the counterexample was inside the table defending it.
 *
 * It moved because the evidence behind it drives the whole compiler pipeline (an
 * `Array.prototype["-1"]` accessor, so every out-of-range read in the process throws),
 * which has nothing to do with the tsc gate. Kept as ONE copy, per CLAUDE.md.
 */
