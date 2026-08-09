/*
 * Validation for `test/blocker-metric.ts` — the INSTRUMENT, never the frontier.
 *
 * Read the distinction before adding to this file, because it is the whole point.
 * Seven lanes move the blocker COUNT at once, so nothing here asserts what that count is;
 * a threshold would only fight them, and docs/self-hosting.md is full of ratchets that
 * had to be re-recorded on a strict improvement. What is asserted is that the tool tells
 * the truth:
 *
 *   1. it reads ZERO on programs that actually compile and run (a metric that flags
 *      working code makes every lane's delta meaningless);
 *   2. it reads ZERO on the three compiler modules recorded clear, single-module;
 *   3. its own arithmetic is consistent (the per-module rows sum to the totals);
 *   4. recovery CONTAMINATION stays negligible — the number that makes the whole
 *      recovering measurement trustworthy, and the one most likely to rot silently;
 *   5. an abort OUTSIDE the per-function loop is reported as an abort, not as "0
 *      failing". This project has scored a compiler CRASH as "no blockers" before
 *      (`coverage`, docs/self-hosting.md), and this is that trap's second door;
 *   6. two runs of the same tree produce byte-identical output.
 *
 * IF A TEST HERE FAILS, RE-RUN THIS FILE ALONE BEFORE BELIEVING IT. Several tests carry
 * generous explicit timeouts because they link real binaries, and a timeout CAPS the
 * reported duration at 5001 ms — so a starved run looks like a FAST failure, not a slow
 * one, and the "six-digit milliseconds means machine load" rule of thumb cannot fire for
 * it. The load itself is not what you would guess either: the builds are serial
 * (`spawnSync`) and macOS Gatekeeper scans every never-before-seen binary (~0.37 CPU-sec),
 * so a fleet of concurrent suites queues on one system daemon and times out with the CPU
 * mostly IDLE. Re-running the file alone is the only reading that separates the two.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { measure, render, MetricAborted, STAGE1_ENTRY } from "./blocker-metric.ts";
import { compileAndRunFile, runWithNodeFile } from "./harness.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("blocker-metric — the instrument", () => {
  /*
   * 1. THE NEGATIVE CONTROL, and it is deliberately a program we also RUN.
   *
   * "Zero blockers" is only worth something if the same source really does compile to a
   * binary that behaves. Asserting `failing === 0` alone would pass for a tool that
   * always returns 0, which is exactly the class of instrument this repo keeps finding.
   */
  test("reads 0 on a multi-module program that compiles AND runs correctly", async () => {
    const entry = join(REPO, "test/modules/basic/main.ts");

    const ours = await compileAndRunFile(entry);
    const node = runWithNodeFile(entry);
    expect(ours.stdout).toBe(node.stdout);
    expect(ours.exitCode).toBe(node.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0); // never an empty-vs-empty match

    const r = measure(entry);
    expect(r.checksClean).toBe(true);
    expect(r.failing).toBe(0);
    expect(r.firstBlocker).toBeNull();
    expect(r.modules).toBeGreaterThan(1); // the LINKED path, not the single-file one
    expect(r.functions).toBeGreaterThan(0);
  }, 120_000);

  /*
   * 2. The three modules docs/self-hosting.md records as clear, measured single-module.
   * If one of these ever reads non-zero, either the frontier regressed or the tool did —
   * both worth a stop, which is why it is a hard assertion and the stage-1 count is not.
   */
  for (const m of ["lexer", "diagnostics", "coverage-preprocess"]) {
    test(`reads 0 on src/${m}.ts, recorded clear standalone`, () => {
      const r = measure(join(REPO, `src/${m}.ts`));
      expect(r.failing).toBe(0);
      expect(r.checksClean).toBe(true);
    });
  }

  /* 3. Internal arithmetic. Catches an aggregation or attribution bug without pinning
   *    any particular frontier number: the rows must add up to the totals, whatever
   *    those totals happen to be today. */
  test("the per-module and per-code tables sum to the totals", () => {
    const r = measure(STAGE1_ENTRY);
    const fns = r.byModule.reduce((n, m) => n + m.functions, 0);
    const fail = r.byModule.reduce((n, m) => n + m.failing, 0);
    const byCode = r.byCode.reduce((n, c) => n + c.count, 0);
    expect(fns).toBe(r.functions);
    expect(fail).toBe(r.failing);
    expect(byCode).toBe(r.failing);
    expect(r.failing).toBeLessThanOrEqual(r.functions);
    // Every function is attributed to a real module (or to the entry, index -1).
    for (const m of r.byModule) expect(m.index).toBeGreaterThanOrEqual(-1);
  }, 60_000);

  /*
   * 4. CASCADE CONTAMINATION. The measurement recovers from each failure and keeps going,
   * so the honest question is how much of what it then reports is damage IT caused. It
   * is structurally small — signatures are registered before the loop and `checkBlock`
   * has already given every module binding its final type, so a failing body cannot
   * change what another body sees — and it measured exactly 1 of 301 when the tool
   * landed. The bound is loose enough that ordinary lane progress cannot trip it and
   * tight enough that a real loss of isolation will.
   */
  test("recovery contamination stays negligible", () => {
    const r = measure(STAGE1_ENTRY);
    expect(r.cascadeSuspects).toBeLessThanOrEqual(3);
    expect(r.failing).toBeGreaterThan(0); // otherwise the bound is vacuous
  }, 60_000);

  /*
   * 3b. GENERICS must not inflate the denominator. `check` rewrites `program.body` on its
   * way out — templates spliced OUT, monomorphized specializations spliced IN — so a tool
   * that reads the body after checking counts functions the per-function loop never
   * visited, and the per-module rows stop summing to the total. Found by reading, then
   * pinned here: this program has ONE function the loop visits and TWO specializations
   * that appear only afterwards.
   */
  test("monomorphized specializations are not counted as functions", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-blockermetric-"));
    try {
      const entry = join(dir, "gen.ts");
      writeFileSync(entry,
        "function id<T>(x: T): T { return x; }\n" +
        "function useIt(): number { return id<number>(1); }\n" +
        'console.log(useIt(), id<string>("a"));\n');
      const r = measure(entry);
      expect(r.checksClean).toBe(true);
      expect(r.functions).toBe(1); // `useIt` only — `id` is a template, its two clones come later
      expect(r.byModule.reduce((n, m) => n + m.functions, 0)).toBe(r.functions);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * 4b. THE POSITIVE CONTROL — the one that catches a DEAD HOOK.
   *
   * Everything above this asserts zeros, and every one of them would still pass if
   * `check`'s collection argument were dropped by a bad three-way merge (CLAUDE.md names
   * checker.ts as a shared hot spot for exactly that) — the tool would find an empty list
   * and the zeros would look like good news. So: a program with exactly ONE bad function
   * body, in an IMPORTED module, and the tool must find it, count it once, and attribute
   * it to the right module.
   *
   * The defect is an ordinary RETURN-TYPE MISMATCH on purpose. Every construct in the
   * NT1xxx buckets is being worked by a lane right now, and a control built on one of
   * those would break the moment its lane lands; a plain type error is not a gap anyone
   * will ever "fix", so this control cannot rot.
   */
  test("finds exactly one bad function in an imported module, and attributes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-blockermetric-"));
    try {
      writeFileSync(join(dir, "lib.ts"),
        "export function good(n: number): number { return n + 1; }\n" +
        "export function bad(): number { const s: string = \"x\"; return s; }\n");
      const entry = join(dir, "main.ts");
      writeFileSync(entry, 'import { good, bad } from "./lib.ts";\nconsole.log(good(1), bad());\n');

      const r = measure(entry);
      expect(r.failing).toBe(1);
      expect(r.functions).toBe(2);
      expect(r.checksClean).toBe(false);
      expect(r.byCode).toEqual([{ code: "NT2001", count: 1 }]);
      // Attributed to the imported module (index 0), not to the entry (-1).
      const rows = r.byModule.filter((m) => m.failing > 0);
      expect(rows.length).toBe(1);
      expect(rows[0]!.index).toBe(0);
      expect(rows[0]!.file.endsWith("lib.ts")).toBe(true);
      expect(rows[0]!.functions).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * 5. THE ABORT DOOR, and the other PRECONDITION doors beside it.
   *
   * A failure before the per-function loop leaves the collected list empty, and a tool
   * that printed "0 failing" there would report a hard failure as a clean program —
   * `coverage` scoring a compiler crash as "no blockers", again. The same reasoning
   * covers an unreadable entry and a tree that does not link: eight lanes will read this
   * number, and a gate that emits a plausible count when its own inputs are broken
   * teaches people to ignore it just as surely as one that silently skips.
   */
  test("an abort OUTSIDE the function loop is an abort, not 0 failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-blockermetric-"));
    try {
      const entry = join(dir, "toplevel.ts");
      // Refused at the TOP LEVEL, before any function body is reached.
      writeFileSync(entry, 'const n: number = "not a number";\nconsole.log(n);\n');
      expect(() => measure(entry)).toThrow(MetricAborted);

      // ...and a tree that does not LINK is a broken tree, not a frontier number.
      const broken = join(dir, "broken.ts");
      writeFileSync(broken, 'import { nope } from "./absent.ts";\nconsole.log(nope);\n');
      expect(() => measure(broken)).toThrow(MetricAborted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // ...and an entry that is not there at all.
    expect(() => measure(join(tmpdir(), "nativets-blockermetric-absent.ts"))).toThrow(MetricAborted);
  });

  /*
   * 5b. EVERY `src/*.ts` IS ACTUALLY IN THE MEASUREMENT. Discovered from the directory,
   * never a hardcoded twelve, so a module added and not imported cannot sit outside the
   * numbers unnoticed. This is the same shape as the mask test/tsc.test.ts exists for:
   * 16 syntax errors in fixtures made tsc report zero TYPE errors for the life of the
   * project, and nobody saw it because the tool kept answering.
   */
  test("the stage-1 measurement reaches every src/*.ts", () => {
    const r = measure(STAGE1_ENTRY);
    expect(r.unmeasured).toEqual([]);
    const srcModules = readdirSync(join(REPO, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    expect(r.modules).toBe(srcModules.length);
  }, 60_000);

  /* 6. Determinism. The repo has a determinism test because a `Date.now()` in the
   *    linker's prefix chooser once made the compiler unable to reproduce itself; a
   *    metric people paste before/after has to be stable for the same reason. */
  test("two runs of the same tree render byte-identically", () => {
    const a = render(measure(STAGE1_ENTRY), true);
    const b = render(measure(STAGE1_ENTRY), true);
    expect(a).toBe(b);
    expect(a).toContain("by module (link order)");
  }, 120_000);
});
