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
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";
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
  // `export async function` — `async` is ERASED, so an exported one is an ordinary
  // exported function. The export path is the only place that needed to learn it.
  "async",
  "async-await",      // an exported async function that itself awaits (identity)
  "async-arrow",      // an exported async ARROW — an ordinary exported const
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
  // The floating-async guard is per-module in the parser, so an IMPORTED async
  // function has to be seeded into the importing module's async set — otherwise
  // `one()` without `await` prints `1` here and `Promise { 1 }` under node.
  { dir: "bad-async-floating", code: "NT1020", needle: "without 'await'" },
  // …and the ARROW spelling of that export, which the export table must publish as
  // async too — otherwise the importing module has nothing to guard on.
  { dir: "bad-async-arrow-floating", code: "NT1020", needle: "without 'await'" },
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

/*
 * A cycle whose closing edge is `import type`.
 *
 * node and bun ERASE a type-only import, so at run time that graph is acyclic and both
 * run it; tsc permits it outright. nativets refuses it anyway, and the reason is
 * ORDERING, not evaluation: the linker seeds each module's type environment from the
 * modules linked BEFORE it (src/modules.ts), so a type reachable only by going FORWARD
 * in the order has nothing to resolve against.
 *
 * Dropping type-only edges from the DFS was measured, and it is NOT sound: the name is
 * then simply never seeded, and an unresolved type falls through src/parser.ts's last
 * resort (`SCALARS.has(id) ? id : "number"`) and becomes `number`, silently. So this
 * stays a refusal — a documented divergence (docs/divergences.md) — and the diagnostic's
 * job is to name the type-only edge, because THAT is the one declaration to move.
 */
describe("a type-only import cycle", () => {
  const entry = join(DIR, "bad-type-cycle", "main.ts");
  const diagFor = (file: string): { code: string; message: string; hint?: string } => {
    let err: unknown;
    try { sourceToIR(readFileSync(file, "utf8"), file); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    return (err as NTError).diag;
  };

  test("node runs it — the edge really is erased", () => {
    const oracle = runWithNodeFile(entry);
    expect(oracle.stderr).toBe("");
    expect(oracle.stdout).toBe("42\n");
  });

  test("we refuse it, naming the cycle IN ORDER and marking the `import type` edge", () => {
    const diag = diagFor(entry);
    expect(diag.code).toBe("NT1702");
    const lines = diag.message.split("\n");
    expect(lines[1]).toContain("bad-type-cycle/main.ts");
    expect(lines[2]).toContain("bad-type-cycle/dep.ts");
    expect(lines[3]).toContain("bad-type-cycle/main.ts");
    expect(lines[3]).toContain("import type"); // the closing edge, marked
    expect(diag.hint).toContain("import type");
  });

  test("a genuine VALUE cycle is unchanged — still refused, still not blamed on types", () => {
    const diag = diagFor(join(DIR, "bad-cycle", "main.ts"));
    expect(diag.code).toBe("NT1702");
    expect(diag.message).not.toContain("import type");
    expect(diag.hint).not.toContain("import type");
  });
});

/*
 * Checking a module WITHOUT linking it first.
 *
 * `check()` on a bare `parse()` result sees `import { parse } from "./parser.ts"` as
 * nothing at all — the binding is introduced by the LINKER (src/modules.ts), so an
 * imported callee is simply an unknown name. It used to be reported as
 *   [NT1003] call to 'parse' (function values / unknown callee) is not supported yet
 *   hint: function values / closures need captured environments
 * which is a diagnostic about a feature the program does not use, on a call the
 * compiler handles perfectly once linked. It sent two self-hosting lanes at a phantom
 * closure blocker: `src/coverage.ts` and `src/driver.ts` both "needed" NT1003, and
 * neither does — linked, both calls check and run.
 *
 * The name is right there in `program.imports`, so the diagnostic says so.
 */
describe("an unlinked import is reported as an unlinked import", () => {
  const SRC = 'import { helper } from "./dep.ts";\nconsole.log(helper(1));\n';

  test("a call to an imported function names the module, not closures", () => {
    let err: unknown;
    try { check(parse(SRC)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    const diag = (err as NTError).diag;
    expect(diag.message).toContain("helper");
    expect(diag.message).toContain("./dep.ts");
    expect(diag.message).not.toContain("function values");
  });

  // The `coverage` tool reaches the same call by a different road: it ERASES the import
  // preamble (src/coverage-preprocess.ts) so a module whose preamble does not parse can
  // still be measured, which drops the binding names too. docs/self-hosting.md attributes
  // driver.ts's NT1003 to exactly this path, so it needs the honest message just as much.
  test("the coverage tool names the unlinked import too", () => {
    const r = coverage(SRC);
    expect(r.firstError!.code).toBe("NT1003");
    expect(r.firstError!.message).toContain("./dep.ts");
    expect(r.firstError!.message).not.toContain("function values");
  });

  test("a genuinely unknown callee still reports the closure gap", () => {
    let err: unknown;
    try { check(parse("console.log(nosuch(1));\n")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    expect((err as NTError).diag.message).toContain("function values");
  });
});

/*
 * DETERMINISM of the alpha-rename prefix.
 *
 * `linkProgram` renames each non-entry module's top-level bindings with a per-module
 * prefix. `choosePrefixBase` prefers `_m`, escalating to `_nt_m` then
 * `_nativets_module_` if a source literally contains the shorter one — and if all
 * three appear it fell back to `` `_nts${Date.now().toString(36)}_m` ``, a CLOCK
 * read, so the same inputs produced different global names on every run.
 *
 * The one file in the tree guaranteed to contain all three strings is
 * `src/modules.ts` itself (they are the candidate list, spelled in this very
 * function), so the escalation was reached by exactly the module the self-hosting
 * measurement cares most about. Three ways that bites, in increasing severity:
 *
 *   1. `test/selfhost-ratchet.test.ts` records the blocker MESSAGE as blocker
 *      identity, and a message naming a renamed binding then differs between two
 *      measurements IN THE SAME RUN — the ratchet cannot hold.
 *   2. `test/sh6.test.ts`'s `blameOf` attributes a blocker by byte-identical message,
 *      so a name-carrying blocker can never be attributed to the dependency it
 *      actually lives in.
 *   3. SH7's definition of done is "`nativets-2` and `nativets-3` are BYTE-IDENTICAL".
 *      A compiler that mints global names from the clock cannot reproduce itself.
 *
 * The fix keeps the escalation but derives it from the sources: keep counting until
 * no source contains the candidate. Same guarantee (no collision), same inputs ->
 * same answer.
 */
describe("the alpha-rename prefix is a function of the sources, never the clock", () => {
  const readSrc = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", f), "utf8");

  test("linking src/modules.ts twice produces identical output", () => {
    const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules.ts");
    const src = readSrc("modules.ts");
    const names = () => {
      // The blocker is what carries the prefix into a user-visible string today.
      try { sourceToIR(src, entry); return "IR OK"; } catch (e) { return (e as NTError).diag.message; }
    };
    const a = names(), b = names();
    expect(a).toBe(b);
    // ...and the escalation it lands on is the DETERMINISTIC one. Asserting merely
    // "no `_nts`" was wrong — `_nts0_m` is the correct answer here, since src/modules.ts
    // does contain all three preferred bases. What must never appear is a clock, i.e.
    // anything but the first free counter value.
    expect(a).toContain("_nts0_m");
  });

  test("a program containing all three candidate bases still links deterministically", () => {
    // Every candidate appears as a literal, forcing the escalation path.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "modules-prefix");
    const read = (p: string): string =>
      p.endsWith("dep.ts")
        ? 'export const bases = ["_m", "_nt_m", "_nativets_module_"];\nexport function two(): number { return 2; }\n'
        : 'import { two, bases } from "./dep.ts";\nconsole.log(two(), bases.length);\n';
    const ir = () => {
      const p = linkProgram(read(join(dir, "main.ts")), join(dir, "main.ts"), read);
      return p.body.map((s) => ("name" in s ? String((s as { name: unknown }).name) : s.kind)).join(",");
    };
    const a = ir();
    expect(ir()).toBe(a);
    expect(a).toContain("_nts0_m0_two"); // the first free counter value, not a timestamp
  });
});
