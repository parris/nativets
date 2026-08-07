/*
 * Modules (SH1) — `import` / `export` across `.ts` files, differential vs node.
 *
 * Every case is a DIRECTORY under test/modules/ with a `main.ts` entry plus the
 * modules it imports. These cannot live in the flat test/fixtures/ harness (which
 * compiles one standalone file and snapshots its IR), so they get their own harness
 * here — mirroring test/hostio/ and test/stdlib-url/.
 *
 * node is still the oracle: it runs `main.ts` directly, stripping the type
 * annotations and resolving the same `./relative.ts` specifiers we do. nativets
 * links the whole graph into ONE LLVM module (src/modules.ts) and must print the
 * same bytes with the same exit code.
 *
 * The rejection table at the bottom is the reject-don't-miscompile half: module
 * syntax outside the supported surface, and real graph defects (missing file,
 * cycle, missing export), each pinned to its NT code.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunFile, runWithNodeFile } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { linkProgram, moduleGraph } from "../src/modules.ts";
import { coverage } from "../src/coverage.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "modules");

/** Cases that must compile AND match node byte-for-byte. */
const CASES = [
  "basic",            // 1. export function + import { add } from "./math.ts"
  "consts",           // 2. export const — visible inside imported functions
  "multi",            // 3. several names, a nested path, and a diamond (shared runs ONCE)
  "types",            // 4. import type / export type / interface — erased
  "classes",          // 5. export class + an exported arrow/closure value
  "rename",           // 6. import { a as b }
  "reexport",         // 7. export { x } from "./y.ts"
  "collide",          // per-module mangling: two modules declaring the same names
  "ownership",        // an imported function's params are BORROWS (caller keeps ownership)
  "frame",            // top-level loop/block/catch names share ONE flat `main` frame
  "state",            // mutable module state + a module-level array; live imported bindings
  // Cross-feature: M3 generic functions (Stage 36) across a module boundary. Neither
  // lane could cover this alone, and it pins the integration ORDER the merge settled:
  // specializations are drained BEFORE the module-globals table is read, because a
  // specialization's body can be the only reader of a module-level binding (here the
  // generic `label<T>` reads `PREFIX`, and is instantiated at both number and string).
  "generics",
  // Cross-feature: `static` members across a module boundary. A static lowers to a
  // module-level name (`C.m` / `C.f`), so the linker's per-module mangling is what keeps
  // two same-named classes apart — and a static FIELD read cannot be resolved when its
  // module is parsed (the class is in another file), so it is finished after the link.
  "statics",
];

describe("modules (differential vs node)", () => {
  for (const name of CASES) {
    test(name, async () => {
      const entry = join(DIR, name, "main.ts");
      const oracle = runWithNodeFile(entry);
      expect(oracle.stderr).toBe(""); // the oracle itself must be clean
      const ours = await compileAndRunFile(entry);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);

      // Curated expectation: assert the output without needing node at test time.
      const expectedFile = `${entry}.expected`;
      if (existsSync(expectedFile)) expect(ours.stdout).toBe(readFileSync(expectedFile, "utf8"));
    });
  }
});

/* ---- multi-module EXAMPLE apps ---------------------------------------------
 * Real dogfood programs under examples/ that are genuinely split across files.
 * `roman-modular` is examples/roman.ts rebuilt as three modules — same bytes out,
 * asserted against the SINGLE-FILE example's `.expected`, which is the sharpest
 * possible statement that modules changed nothing but the file layout.
 */
const EXAMPLES = join(HERE, "..", "examples");

describe("examples (multi-module)", () => {
  for (const app of ["roman-modular", "inventory"]) {
    test(`${app} matches node + its .expected`, async () => {
      const entry = join(EXAMPLES, app, "main.ts");
      const oracle = runWithNodeFile(entry);
      const ours = await compileAndRunFile(entry);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(0);
      expect(ours.stdout).toBe(readFileSync(`${entry}.expected`, "utf8"));
    });
  }

  test("roman-modular prints exactly what the single-file examples/roman.ts prints", async () => {
    const ours = await compileAndRunFile(join(EXAMPLES, "roman-modular", "main.ts"));
    expect(ours.stdout).toBe(readFileSync(join(EXAMPLES, "roman.ts.expected"), "utf8"));
  });
});

describe("module graph", () => {
  test("a diamond loads the shared module exactly once, dependencies first", () => {
    const entry = join(DIR, "multi", "main.ts");
    const order = moduleGraph(readFileSync(entry, "utf8"), entry).map((p) => p.slice(DIR.length + 1));
    expect(order).toEqual([
      "multi/lib/shared.ts",
      "multi/lib/util.ts",
      "multi/greet.ts",
      "multi/main.ts",
    ]);
  });

  test("IR carries no target triple (still retargetable)", () => {
    const entry = join(DIR, "basic", "main.ts");
    const ir = sourceToIR(readFileSync(entry, "utf8"), entry);
    expect(ir).not.toContain("target triple");
    expect(ir).not.toContain("target datalayout");
  });

  test("a module-less source is untouched by the linker", () => {
    const src = "const x = 1;\nconsole.log(x);\n";
    expect(linkProgram(src).body.length).toBe(2);
  });

  test("coverage reports the whole linked graph as static", () => {
    const entry = join(DIR, "multi", "main.ts");
    const report = coverage(readFileSync(entry, "utf8"), entry);
    expect(report.compiles).toBe(true);
    expect(report.blockers).toEqual([]);
  });
});

/* ---- reject-don't-miscompile ------------------------------------------------
 * Each directory holds a `main.ts` that must be REFUSED with exactly this code.
 * NT1017 = module syntax outside the supported surface; NT17xx = a graph defect.
 */
const REJECTIONS: { dir: string; code: string; needle: string }[] = [
  { dir: "bad-default", code: "NT1017", needle: "export default" },
  { dir: "bad-namespace", code: "NT1017", needle: "namespace import" },
  { dir: "bad-star", code: "NT1017", needle: "export * from" },
  { dir: "bad-bare", code: "NT1017", needle: "node_modules" },
  { dir: "bad-dynamic", code: "NT1017", needle: "dynamic 'import()'" },
  { dir: "bad-missing", code: "NT1701", needle: "cannot read module" },
  { dir: "bad-cycle", code: "NT1702", needle: "import cycle" },
  { dir: "bad-export", code: "NT1703", needle: "no exported member" },
  // The ownership pass runs over the LINKED program, so a move and a later use in
  // a DIFFERENT module are still one dataflow — the diagnostic is unchanged.
  { dir: "bad-move", code: "NT1601", needle: "use of moved value" },
];

describe("modules (rejected with a diagnostic)", () => {
  for (const { dir, code, needle } of REJECTIONS) {
    test(`${dir} → ${code}`, () => {
      const entry = join(DIR, dir, "main.ts");
      let err: unknown;
      try {
        sourceToIR(readFileSync(entry, "utf8"), entry);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NTError);
      const diag = (err as NTError).diag;
      expect(diag.code).toBe(code);
      expect(diag.message).toContain(needle);
    });
  }
});
