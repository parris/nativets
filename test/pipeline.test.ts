/*
 * Pipeline operator `|>` tests (B1) — twin-file strategy.
 *
 * `node` cannot run `|>`, so it can't be the direct oracle for a `.ts` that uses
 * it. Each behavior ships as a twin pair under test/pipeline/:
 *   - `case.ts`       the intended program written with `|>` (compiled by nativets)
 *   - `case.twin.ts`  the same program hand-desugared to nested calls (node-runnable)
 *
 * Gates (per pair):
 *   nativets(case.ts).stdout  ==  node(case.twin.ts).stdout   # |> lowers correctly
 *   nativets(case.ts).stdout  ==  nativets(case.twin.ts).stdout # desugar == hand form
 * both with exit code 0.
 *
 * NOTE: these files live OUTSIDE test/fixtures/** on purpose — the generic
 * differential harness there runs `node` on every .ts, which would choke on `|>`.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";
import { parse } from "../src/parser.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "pipeline");

const pipeFiles = readdirSync(ROOT)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".twin.ts"))
  .sort();

describe("pipeline |>", () => {
  for (const f of pipeFiles) {
    const pipeSource = readFileSync(join(ROOT, f), "utf8");
    const twinSource = readFileSync(join(ROOT, f.replace(/\.ts$/, ".twin.ts")), "utf8");

    test(f, async () => {
      const oracle = runWithNode(twinSource);       // node runs the desugared twin
      const ours = await compileAndRun(pipeSource);  // nativets runs the `|>` form
      const twinOurs = await compileAndRun(twinSource); // nativets runs the twin

      expect(ours.stdout).toBe(oracle.stdout);       // |> lowers to the nested form
      expect(ours.exitCode).toBe(0);
      expect(oracle.exitCode).toBe(0);

      expect(ours.stdout).toBe(twinOurs.stdout);     // desugar == hand-written nested
      expect(twinOurs.exitCode).toBe(0);
    });
  }
});

// The RHS of `|>` must be a call to a plain function. Everything else is a clean
// parse error (NT0xxx) — never a silent guess. (Elixir semantics, no topic token.)
describe("pipeline |> rejections", () => {
  const rejected: [string, string][] = [
    ["bare-identifier RHS", "const r = 5 |> inc;"],
    ["member RHS (not a call)", "const r = 5 |> obj.field;"],
    ["non-call RHS (arithmetic binds looser)", "const r = 4 |> dbl() + 1;"],
    ["member/method callee", "const r = 5 |> obj.m(1);"],
  ];
  for (const [label, src] of rejected) {
    test(label, () => {
      expect(() => parse(src)).toThrow(/\|>/);
    });
  }
});
