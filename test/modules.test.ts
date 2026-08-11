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
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
  // A `!` non-null assertion in a NON-ENTRY module. `ModuleGen.expr` had no
  // `NonNullExpr` case, so everything under a `!` fell through to the LITERAL default
  // and was never alpha-renamed — `'table' is not defined` for a module-level const,
  // `NT1003 unknown callee` for a call. Correct TypeScript that node runs.
  "nonnull",
  // Recursive types (the nominal `@Name` back-edge) ACROSS a module boundary. A non-entry
  // module is alpha-renamed, and `rewriteRefs` followed only a shape's own SELF-reference —
  // so in a MUTUAL cycle every reference to a SIBLING declaration stayed unrenamed and went
  // dangling in the merged table. That is the compiler's own shape (src/ast.ts is a
  // 46-declaration cycle imported by every other module), and the failure was not a refusal:
  // `console.log` of such a value made `genInspect` unfold `@N` to itself and TAIL-CALL
  // forever, so the compiler HUNG on a program node runs. The case also collides two
  // same-named recursive `Node`s, one per module, to pin that the rename keeps their layouts
  // apart rather than giving one module's nodes the other's.
  "rectypes",
  // A closure's captured LOCAL, versus a same-named local in another module. Each of
  // these two modules compiles alone; together they did not. NT1031 asks "is this
  // binding used outside the closure?" of every body in `bodyChain`, and after the link
  // `bodyChain[0]` is the WHOLE program — so `t` in tokens.ts (a parameter, and a
  // separate local) answered yes for counter.ts's private `t` and refused the
  // escaping-counter idiom that compiles fine on its own. The linker alpha-renames only
  // TOP-LEVEL bindings, so every module's locals and parameters share one flat namespace
  // for any analysis keyed by bare name.
  "closure-name",
  // A LOOP binding that shares a name with a top-level binding of its own module.
  // `Renamer.stmt`'s `ForOfStmt` arm renamed `name` but not `name2` — the value binding
  // of `for (const [k, v] of map)` — and the rename is uniform, so the body's reads of
  // `v` were rewritten to the module's mangled `v` while the binding kept its source
  // spelling. The loop read the module CONST every iteration: `a=999;b=999` where node
  // says `a=1;b=2`, exit 0 on both sides. A MISCOMPILE, not a refusal, and the same
  // shape as the `nonnull` case above (a walker that visits the node and misses one of
  // its fields). The case also covers the `for…of` and `for…in` single bindings, which
  // were already renamed, so the arm cannot be "fixed" by dropping those.
  "loopvar",
  // An ARROW's declared return type (`(x): T => …`) in a non-entry module, where `T` is
  // one of that module's recursive types. `Renamer.expr`'s `ArrowFunction` arm renamed
  // `paramTys` and `retTy` and missed `retAnnot` — and `retAnnot` is the only one of the
  // three that carries anything at LINK time (the other two are written by the checker,
  // which runs after the link), so every annotated arrow in every imported module kept
  // its module's pre-rename `@N`. The arrow's declared type is what the checker hands
  // back, so the stale spelling ESCAPED into the enclosing function and lost against that
  // function's correctly-renamed `returnAnnot`, printing two identical-looking types:
  // `return type U<…inner:@Expr> does not match declared U<…inner:@_m0_Expr>`. Same
  // walker-misses-a-field class as `nonnull` and `loopvar` above, and it was the first
  // blocker of the compiler's own src/ast.ts (`mapExprList`, ast.ts:1874). The entry
  // module here declares its own differently-laid-out `Expr` so the case pins the
  // `rectypes` layout hazard too, and annotates a local arrow to pin that the rename does
  // NOT reach the entry module's own spelling.
  "arrow-retannot",
  // EXPLICIT call-site type arguments (`firstOf<Point>(xs)`) in a non-entry module.
  // `Renamer.expr`'s `NewExpr` arm rewrote `typeArgs` and its `CallExpr` arm did not, so
  // the argument named that module's PRE-rename `Point`/`@Expr` while the declaration was
  // alpha-renamed, and the call printed two spellings of one type: `expects Point{x:number}[],
  // got _m0_Point{x:number}[]`. `typeArgs` is set by the PARSER, so — like `retAnnot` above
  // and unlike `paramTys`/`retTy`/`valTy` — it is live at LINK time. Fourth instance of the
  // walker-misses-a-field class (`nonnull`, `loopvar`, `arrow-retannot`). Both maps
  // `rewriteTy` threads are covered (a class TAG and a recursive `@N` back-edge), and the
  // already-correct `NewExpr` arm is exercised so the fix cannot be a move rather than an add.
  "calltypeargs",
  // `UpdateExpr` in its NAME form (`x++`/`++x`/`x--`) on a non-entry module's top-level
  // `let`. `Renamer.expr` renames `target` only when `targetExpr` is absent — `x++` names
  // a BINDING, while `o.f++`/`a[i]++` update an expression the walk has already rewritten
  // and their `target` is not a binding reference — and nothing covered that condition:
  // `state` exercises the ASSIGNMENT form (`counter = counter + 1`) instead. The entry
  // declares its own `counter` under the same name, so dropping the rename collapses the
  // two cells into one and the numbers diverge from node with BOTH SIDES EXITING 0
  // (verified by deleting the arm: `bumpTwice()` answers 0 rather than 2, and the entry's
  // own counter reaches 102 because the module's `--` reached it) — the silent-wrong-
  // answer shape `loopvar` records for `ForOfStmt.name2`.
  "updatetarget",
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

  /*
   * THE MERGED RECURSIVE-TYPE TABLE IS CLOSED: every `@Name` it mentions has an entry.
   *
   * Asserted structurally rather than through a program, because the failure mode of an
   * open table is not a wrong answer — it is a HANG. `expandTypeRef` returns an unresolvable
   * name UNCHANGED (the deliberate "cannot decide, do not guess" rule) and `genInspect`
   * re-enters itself with it, which JSC turns into a tail-call loop: no diagnostic, no exit
   * code, nothing for a differential test to compare. `rewriteRefs` renamed only a shape's
   * own name, so in a MUTUAL cycle every sibling reference was left open — which is
   * src/ast.ts, a 46-declaration cycle imported by every other module of this compiler.
   *
   * The entry's own declarations keep their names, and a non-entry module's are prefixed, so
   * this also pins that the two halves agree: an `@Node` from the library must NOT resolve
   * to the entry's same-named `Node`.
   */
  test("the merged recursive-type table has no dangling back-edge", () => {
    const entry = join(DIR, "rectypes", "main.ts");
    const prog = linkProgram(readFileSync(entry, "utf8"), entry);
    const names = new Set((prog.recTypes ?? []).map((r) => r.name));
    expect(names.size).toBeGreaterThan(0);
    // Both `Node`s survive, under distinct names, with their own layouts.
    expect(names.has("Node")).toBe(true);                        // the entry's, unrenamed
    const libNode = [...names].find((n) => n !== "Node" && n.endsWith("_Node"));
    expect(libNode).toBeDefined();
    expect(prog.recTypes!.find((r) => r.name === "Node")!.ty).toContain("n:number");
    expect(prog.recTypes!.find((r) => r.name === libNode)!.ty).toContain("label:string");

    // The library's tag is the string `"lib@Node"` — a `@` inside a QUOTED run, which is
    // legal and lands verbatim in the encoding (`hasTypeRef`, ast.ts). The rename must not
    // touch it, or the module's own tag becomes a different string from the one its values
    // carry. Asserted directly, since the scan below has to skip the same runs.
    expect(prog.recTypes!.find((r) => r.name === libNode)!.ty).toContain(`"lib@Node"`);

    // Every `@Name` in a TYPE position resolves. Quoted runs are skipped for the reason
    // above: a `@` in a tag or a property key is not a reference.
    const dangling: string[] = [];
    for (const r of prog.recTypes ?? []) {
      for (let i = 0; i < r.ty.length; i++) {
        if (r.ty[i] === `"`) { const c = r.ty.indexOf(`"`, i + 1); if (c < 0) break; i = c; continue; }
        if (r.ty[i] !== "@") continue;
        let j = i + 1;
        while (j < r.ty.length && /[A-Za-z0-9_$]/.test(r.ty[j]!)) j++;
        const ref = r.ty.slice(i + 1, j);
        if (!names.has(ref)) dangling.push(`${r.name} -> @${ref}`);
      }
    }
    expect(dangling).toEqual([]);
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
    // The RENAMED BINDINGS themselves, not the blocker message. This used to read the
    // message, on the note that "the blocker is what carries the prefix into a
    // user-visible string today" — and that stopped being true the moment src/modules.ts
    // moved onto `.push`, whose diagnostic names no binding. The invariant under test is
    // that the prefix is a function of the sources, so measure the prefix directly: it
    // holds whatever the module's current first blocker happens to be.
    const names = () => {
      const p = linkProgram(readSrc("modules.ts"), entry, (f) => readFileSync(f, "utf8"));
      return p.body.map((s) => ("name" in s ? String((s as { name: unknown }).name) : s.kind)).join(",");
    };
    const a = names(), b = names();
    expect(a).toBe(b);
    // ...and the escalation it lands on is the DETERMINISTIC one. Asserting merely
    // "no `_nts`" was wrong — `_nts0_m` is the correct answer here, since src/modules.ts
    // does contain all three preferred bases. What must never appear is a clock, i.e.
    // anything but the first free counter value.
    expect(a).toContain("_nts0_m");
    expect(a).not.toContain("_nts1_m"); // one escalation step, deterministically
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

/*
 * THE CROSS-MODULE-ONLY BLOCKER SWEEP.
 *
 * The one defect class every other instrument in this repo is structurally blind to: two
 * files that EACH compile alone and cannot be compiled together. Coverage, the ratchet and
 * the self-host frontier all measure ONE module at a time, so per-module is exactly the
 * case that works and the failure appears in no column of any of them.
 *
 * The cause is always the same shape. `linkProgram` alpha-renames TOP-LEVEL bindings only,
 * which is all codegen needs — but it means every module's locals and parameters land in
 * ONE flat namespace, so any analysis that asks a question by bare NAME over the whole
 * program starts answering it with another file's code. Two did: NT1031's "is this capture
 * used outside the closure?", and the `closureAssigned` filter on narrowing.
 *
 * So: link every standalone fixture against a module of pure name NOISE — the commonest
 * short identifiers, bound as parameters, as top-level locals, and as BLOCK-scoped locals
 * assigned inside an arrow (that last is the shape `ownBindings` deliberately does not
 * subtract). None of it is reachable from another module. Any fixture that stops compiling
 * names a name-keyed analysis and locates it.
 *
 * The three CANARIES are the point of the whole thing: a sweep reporting zero has to be
 * able to fail, and each of these did — until both analyses learned to ask their question
 * of the body that DECLARES the binding rather than of the program.
 *
 * WHAT THIS SWEEP DOES NOT COVER: it compares REFUSALS, so it can only see a term whose
 * symptom is a diagnostic. A cross-module term that merely costs a LEAK is invisible to
 * it, and there was one — `shadowedNames` in src/ownership.ts, pinned separately by
 * `test/modules/closure-drop` with a `__objLive()` count rather than a diagnostic. Read a
 * green run here as "no new REFUSAL crosses the link boundary", nothing wider.
 */
const NOISE = `
export function noise(): number {
  let a = 0; let b = 0; let i = 0; let j = 0; let k = 0; let n = 0;
  let s = ""; let t = 0; let v = 0; let x = 0; let out = 0; let last = 0;
  let init = 0; let test = 0; let ty = 0; let ft = 0; let arrow = 0;
  const xs: number[] = [1, 2, 3];
  const ys: number[] = xs.map((e: number) => {
    a = a + e; b = b + e; i = i + e; j = j + e; k = k + e; n = n + e;
    t = t + e; v = v + e; x = x + e; out = out + e; last = e; init = e;
    test = e; ty = e; ft = e; arrow = e; s = "y";
    return e;
  });
  return a + b + i + j + k + n + s.length + t + v + x + out + last + init + test + ty + ft + arrow + ys[0]!;
}
export function blocky(k: number): number {
  if (k > 0) {
    let a = 0; let t = 0; let s = 0; let n = 0; let b = 0; let i = 0; let v = 0;
    let x = 0; let last = 0; let init = 0; let test = 0; let ty = 0; let ft = 0; let arrow = 0;
    const xs: number[] = [1, 2];
    const ys: number[] = xs.map((e: number) => {
      a = a + e; t = t + e; s = s + e; n = n + e; b = b + e; i = i + e;
      v = v + e; x = x + e; last = e; init = e; test = e; ty = e; ft = e; arrow = e;
      return e;
    });
    return a + t + s + n + b + i + v + x + last + init + test + ty + ft + arrow + ys[0]!;
  }
  return 0;
}
`;

/** Sources whose ONLY blocker was the cross-module term — the sweep's self-test. */
const CANARIES: [string, string][] = [
  ["the escaping counter (NT1031)",
    'function makeCounter(): () => number { let t = 0; return () => { t = t + 1; return t; }; }\nconst c = makeCounter();\nconsole.log(c(), c());\n'],
  ["a narrowed local (closureAssigned)",
    'function use(s: string): number { return s.length; }\nfunction f(xs: string[]): number { const a = xs.at(0); if (a !== undefined) return use(a); return -1; }\nconsole.log(f(["hi"]));\n'],
  ["an arrow's own parameter (closureAssigned)",
    'interface Tok { kind: string; value: string }\nconst isP = (t: Tok | undefined, v: string): boolean => !!t && t.kind === "punct" && t.value === v;\nconsole.log(isP({ kind: "punct", value: "+" }, "+"));\n'],
];

describe("no source compiles alone but not linked", () => {
  const ENTRY = "/xlink/main.ts";

  /** The blocker `source` hits when linked against the noise module, or null. */
  function linkedAgainstNoise(source: string): string | null {
    const main = `import { noise, blocky } from "./noise.ts";\nif (noise() < 0) console.log(blocky(1));\n${source}`;
    const read = (p: string): string => (p === ENTRY ? main : NOISE);
    try { check(linkProgram(main, ENTRY, read)); return null; } catch (e) {
      const d = (e as { diag?: { code: string; message: string } }).diag;
      return d ? `${d.code} ${d.message}` : String(e);
    }
  }

  /** Does `source` compile on its own? Only these are the sweep's business. */
  function compilesAlone(source: string): boolean {
    try { check(parse(source)); return true; } catch { return false; }
  }

  for (const [what, src] of CANARIES) {
    test(`canary — ${what}`, () => {
      expect(compilesAlone(src)).toBe(true);
      expect(linkedAgainstNoise(src)).toBeNull();
    });
  }

  test("every fixture that compiles standalone also compiles linked", () => {
    const FIXTURES = join(HERE, "fixtures");
    const failures: string[] = [];
    let swept = 0;
    for (const dir of readdirSync(FIXTURES)) {
      for (const f of readdirSync(join(FIXTURES, dir))) {
        if (!f.endsWith(".ts")) continue;
        const src = readFileSync(join(FIXTURES, dir, f), "utf8");
        if (!compilesAlone(src)) continue; // already blocked alone
        swept++;
        const blocked = linkedAgainstNoise(src);
        if (blocked) failures.push(`${dir}/${f}: ${blocked}`);
      }
    }
    expect(swept).toBeGreaterThan(100); // the sweep must actually be sweeping
    expect(failures).toEqual([]);
  });

  /*
   * ...and the same class where the symptom is a LEAK rather than a diagnostic, which is
   * why it needed its own test and its own oracle.
   *
   * `shadowedNames` (src/ownership.ts) disqualifies a closure env from being dropped when
   * its name is DECLARED more than once, because codegen gives a name one frame slot per
   * function and two declarations would then share storage — freeing on the inner one
   * would leave the outer name reading freed memory. It counted every declaring
   * occurrence anywhere under the body it was given, and for the module frame that body is
   * the whole linked program: one `let add = 0` inside an unrelated module's function was
   * enough to delete the drop for a `const add = …` closure here.
   *
   * A leak, never a wrong answer — which is exactly why it survived, since LeakSanitizer
   * runs on Linux CI only and nothing on a laptop notices. `__objLive()` makes it local:
   * the env is allocated in a block it never escapes, so it is freed at the block's exit
   * and the counter reads 0 on the next line.
   */
  test("a closure env is still dropped when another module declares its name", async () => {
    const ours = await compileAndRunFile(join(DIR, "closure-drop", "main.ts"));
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("7\n1\n0\n"); // the last line is __objLive(): nothing left alive
  });
});
