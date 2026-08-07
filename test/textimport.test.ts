/*
 * Compile-time TEXT imports — `import s from "./f.c" with { type: "text" }`.
 *
 * The construct that embeds the C runtime into the compiler's own binary
 * (`src/driver.ts` has twelve of them, ~305KB of C source). Semantics are bun's: the
 * referenced file is read AT COMPILE TIME, relative to the importing file, and the
 * identifier is bound to a plain string constant. No runtime file I/O, no `node:fs`.
 *
 * ---- WHY NODE IS NOT THE ORACLE FOR THE IMPORT ITSELF ----
 * node implements only `with { type: "json" }`; there is no `text` attribute, so a
 * fixture using one cannot run under node at all (docs/divergences.md records this as
 * a deliberate divergence). The oracle is therefore split:
 *
 *   main.ts    — nativets: the text import. Compiled and RUN; its stdout is asserted.
 *   oracle.ts  — node: the same program with the same string obtained by readFileSync.
 *
 * Everything after the binding is identical source in both files, so node still decides
 * what the STRING is and what `.length`/indexing/comparison do with it. Only the import
 * FORM is nativets-only. Each test below says which half it is asserting.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRunFile } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "textimport");

/** Run a case's node twin, from inside the case directory (so `./x` resolves). */
function oracle(caseName: string): { stdout: string; exitCode: number } {
  const dir = join(DIR, caseName);
  const p = spawnSync("node", [join(dir, "oracle.ts")], { encoding: "utf8", cwd: dir });
  expect(p.stderr ?? "").toBe(""); // the oracle itself must be clean
  return { stdout: p.stdout ?? "", exitCode: p.status ?? -1 };
}

describe("text imports (node-verified through the readFileSync twin)", () => {
  test("basic: the file's contents become a string constant", async () => {
    const ours = await compileAndRunFile(join(DIR, "basic", "main.ts"));
    const theirs = oracle("basic");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    // Pinned, so a change on BOTH sides can never pass silently.
    expect(ours.stdout).toBe("19\nhello, text import\n\n");
  });
});
