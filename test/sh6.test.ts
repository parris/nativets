/*
 * SH6 — DIFFERENTIAL SELF-COMPILATION, measured.
 *
 * docs/self-hosting.md, milestone SH6: "Compile lexer -> parser -> checker -> codegen
 * -> ... each under nativets and differential-test its output against the `bun`-run
 * version (same discipline as everything else: the existing compiler is the oracle for
 * the self-hosted one)."
 *
 * This file is an INSTRUMENT, not a feature. Nothing else measures SH6: every
 * self-hosting lane's success is currently judged by the PROXY "the module reaches
 * `parse`", which answers a question nobody asked. The question that matters is whether
 * nativets compiles the compiler's own source into something that BEHAVES like the
 * bun-run compiler.
 *
 * ---- THE DIFFERENTIAL, precisely ----
 * The seam is `sourceToIR(source, entryPath)` in `src/driver.ts` — the pure
 * source -> LLVM IR text function that `build`, `run` and `emit` all go through.
 *
 *   For a given .ts input, the IR produced by the BUN-RUN compiler and the IR produced
 *   by a NATIVETS-COMPILED compiler must be IDENTICAL, byte for byte.
 *
 * Not "both compile". Not "both run". Not "both produce working binaries". Byte-for-byte
 * equal IR text, because that is the only statement of equivalence that cannot be passed
 * by accident. `bun` is to the self-hosted compiler exactly what `node` is to nativets:
 * the oracle, and when they disagree WE are wrong.
 *
 * ---- THE RUNG LADDER ----
 * Each of the twelve `src/*.ts` modules, plus the real entry point `src/cli.ts` (whose
 * import graph pulls in everything), records its FURTHEST rung:
 *
 *   rung 0  `sourceToIR` throws          — does not reach IR. The blocking error is recorded.
 *   rung 1  `sourceToIR` returns         — reaches IR.
 *   rung 2  that IR links via clang      — a native binary exists.
 *   rung 3  the binary runs and its output matches the bun-run equivalent.
 *
 * For `cli.ts` rung 3 IS the differential above: the binary is run as
 * `nativets-1 emit <input>` and its stdout must equal `bun run src/cli.ts emit <input>`,
 * which is the IR the oracle produced. That is stage-1 of the bootstrap.
 *
 * ---- IT IS EXPECTED-TO-FAIL TODAY, AND SAYS SO STRUCTURALLY ----
 * Not one module reaches IR right now, so nearly every row sits at rung 0. That is the
 * point. A harness that SKIPS what it cannot yet do measures nothing; one that RECORDS
 * how far each module got measures everything. Ratchet semantics, like
 * `test/bootstrap.test.ts` and the conformance corpora's minimum-supported counts: a
 * module may improve, never regress, and a regression is a hard failure naming the
 * module and the error.
 *
 * ---- WHAT THIS HARNESS CANNOT PROVE ----
 * SH6 green for all twelve modules is STILL NOT SH7, and nobody should read a green run
 * here as a working bootstrap:
 *
 *   1. Rung 3 is a differential over a CORPUS. A compiler can emit correct IR for every
 *      input we happen to test and still miscompile the input that matters — its own
 *      source. Passing corpus IR equality is necessary, not sufficient.
 *   2. Rungs 0-2 for a single module say nothing about the WHOLE compiler. A module that
 *      compiles in isolation may still fail in the merged whole-program link (SH1 merges
 *      the graph into one Program), and the merged program is what stage-1 actually is.
 *   3. Rung 3 for a plain module is WEAK by construction. `src/lexer.ts` is a library: it
 *      prints nothing, so "native output == bun output" compares empty to empty. Such a
 *      match is recorded as `weak` and must not be read as evidence the module works. The
 *      only non-weak module row is `cli.ts`, which has observable behaviour.
 *   4. SH7 is the THREE-STAGE FIXED POINT and is not attempted here: nativets-1 compiles
 *      src/ -> nativets-2, nativets-2 compiles src/ -> nativets-3, and self-hosting holds
 *      only when nativets-2 and nativets-3 are BYTE-IDENTICAL *and* the full differential
 *      suite passes when compiled by nativets-2. A compiler can emit correct IR for a
 *      corpus and still fail to reproduce itself.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { sourceToIR, buildBinary } from "../src/driver.ts";

const SRC = new URL("../src/", import.meta.url);
const pathOf = (m: string) => new URL(m, SRC).pathname;
const read = (m: string) => readFileSync(pathOf(m), "utf8");

/* ============================================================
 * The ladder
 * ============================================================ */

type Rung = 0 | 1 | 2 | 3;

interface Measured {
  rung: Rung;
  /** First line of the error that stopped it (empty once rung 3 is reached). */
  error: string;
  /** The NT diagnostic code parsed out of `error`, or "other". */
  code: string;
  /** Rung 3 reached, but both sides printed nothing — see caveat 3 in the header. */
  weak: boolean;
}

/** An entry the ladder is run on: a file, and the argv it is exercised with. */
interface Entry {
  /** Display name (a module file name under src/, or the control specimen's). */
  file: string;
  /** Absolute path to the entry file — what `import "./x.ts"` resolves against. */
  path: () => string;
  /** argv passed to BOTH the native binary and the bun-run oracle at rung 3. */
  argv: () => string[];
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.trim();
const codeOf = (error: string) => /\[(NT\d+)\]/.exec(error)?.[1] ?? (error ? "other" : "");

/**
 * Run the ladder for one entry.
 *
 * Deliberately lazy: rung 0 and rung 1 are decided by `sourceToIR` alone, which is pure
 * and takes milliseconds. clang is only invoked once a module has actually reached IR.
 * This is measured often, so linking thirteen binaries on every invocation to learn
 * something rung 0 already decided would be waste, not rigor.
 */
async function ladder(entry: Entry): Promise<Measured> {
  const path = entry.path();
  const source = readFileSync(path, "utf8");

  // rung 0 -> 1: does the compiler's own source reach LLVM IR?
  try {
    sourceToIR(source, path);
  } catch (e) {
    return { rung: 0, error: msg(e), code: codeOf(msg(e)), weak: false };
  }

  // rung 1 -> 2: does that IR link to a native binary?
  const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-"));
  try {
    const bin = join(dir, "nativets-1");
    try {
      await buildBinary(source, bin, { target: "host", entryPath: path });
    } catch (e) {
      return { rung: 1, error: msg(e), code: codeOf(msg(e)), weak: false };
    }

    // rung 2 -> 3: does it behave like the bun-run compiler? The oracle is `bun run`
    // over the SAME file with the SAME argv — bun is to the self-hosted compiler what
    // node is to nativets. stdout + exit code are compared, matching the fixture
    // differential's convention; stderr is not, because a compiled compiler's stack
    // traces and bun's are not the same text even when the compilers agree.
    const argv = entry.argv();
    const ours = spawnSync(bin, argv, { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
    const oracle = spawnSync("bun", ["run", path, ...argv], { encoding: "utf8", timeout: 120_000 });
    const oursOut = ours.stdout ?? "";
    const oracleOut = oracle.stdout ?? "";

    if (oursOut !== oracleOut) {
      return { rung: 2, error: `stdout differs from the bun-run compiler (${oursOut.length} vs ${oracleOut.length} bytes)`, code: "DIFF", weak: false };
    }
    if ((ours.status ?? -1) !== (oracle.status ?? -1)) {
      return { rung: 2, error: `exit code differs: ${ours.status} vs ${oracle.status}`, code: "DIFF", weak: false };
    }
    // A library module prints nothing, so an empty==empty match is not evidence.
    return { rung: 3, error: "", code: "", weak: oursOut.length === 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Memoized — several tests read the same rows, and rung 2/3 shell out. */
const measurements = new Map<string, Promise<Measured>>();
function measure(entry: Entry): Promise<Measured> {
  const key = `${entry.path()} ${entry.argv().join(" ")}`;
  let m = measurements.get(key);
  if (!m) measurements.set(key, (m = ladder(entry)));
  return m;
}

/* ============================================================
 * The differential corpus (used at rung 3 of the stage-1 entry)
 * ============================================================ */

/**
 * Inputs the compiled compiler is asked to compile. Kept tiny on purpose: the point of
 * the corpus is to catch a compiled compiler that emits DIFFERENT IR, and the smallest
 * program that exercises the pipeline does that as well as a large one while keeping
 * this measurement fast.
 *
 * When stage-1 lands, this corpus should be widened to the whole `test/fixtures/` tree —
 * per caveat 1 in the header, IR equality over three snippets is not IR equality over
 * everything the compiler can be handed.
 */
const CORPUS: Record<string, string> = {
  "hello.ts": 'console.log("hello, self-host");\n',
  "closures.ts": [
    "function makeCounter(): () => number {",
    "  let n = 0;",
    "  return () => { n = n + 1; return n; };",
    "}",
    "const c = makeCounter();",
    "console.log(c() + c());",
    "",
  ].join("\n"),
  "records.ts": [
    "const xs: number[] = [3, 1, 2];",
    "const o = { name: `n${xs.length}`, tags: xs.toSorted() };",
    "console.log(JSON.stringify(o));",
    "",
  ].join("\n"),
};

const corpusDir = (() => {
  const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-corpus-"));
  for (const [name, src] of Object.entries(CORPUS)) writeFileSync(join(dir, name), src);
  return dir;
})();

const corpusEntry = join(corpusDir, "hello.ts");

afterAll(() => rmSync(corpusDir, { recursive: true, force: true }));

/* ============================================================
 * BASELINE — the recorded frontier. May improve, never regress.
 * ============================================================ */

/**
 * The twelve modules, plus `cli.ts` a second time as the stage-1 entry (there it is
 * exercised as a COMPILER — `emit <input>` — rather than as a library, so it is a
 * genuinely different measurement of the same file).
 *
 * `rung` is the floor: the ratchet fails if a row drops below it. `code` is the blocker
 * as last measured, recorded for the gradient rather than as a floor — clearing one
 * blocker UNMASKS the next, so codes churn while rungs do not.
 */
const BASELINE: Record<string, { rung: Rung; code: string; blame: string }> = {
  // RE-MEASURED CENTRALLY after a twelve-lane round (2026-08-07). EVERY row changed except
  // lexer.ts and modules.ts. NT1017 is gone tree-wide (`export async function` landed);
  // NT0001 is down to one module, and it is a NEW one — codegen.ts got FURTHER when static
  // members landed and stopped on an unnamed parse error behind them.
  //
  // Read the blame column carefully: `driver.ts` and `cli.ts` used to blame themselves and
  // each other for NT1017; they now both blame `parser.ts`, whose `?.[]` they inherit
  // through the link. That is not a regression — they cleared their own blocker and the
  // link surfaced the deepest one they share.
  // ENTRIES-FORM CLEARED, and it was a SOURCE gap, not a compiler one. `DATE_GETTERS`
  // was written as `new Map([[k, v], …])` — the entries form needs a `[key, value]`
  // tuple type nativets does not have — and through the link it was the first blocker
  // for FIVE of the twelve modules. It is now the `.set` chain the diagnostic already
  // prescribed, which is the same program by construction (ES2024 24.1.1.1 builds the
  // entries form by calling `set` per entry) and, unlike `.push` -> `xs = [...xs, v]`,
  // costs nothing under bun because `Map.prototype.set` returns its receiver.
  // Behind it, in ast.ts's own source: `HOST_MODULES`, a `Record` initialized with an
  // object literal — the same class as checker.ts's `NUMBER_CONSTS`.
  // THE RECORD FAMILY IS CLEARED, all ELEVEN declarations in four files (the census, not
  // the first-blocker table — see test/record-dict.test.ts). Every one of them was read
  // with a VARIABLE key, so the "annotate the exact shape" escape hatch applied to none of
  // them: they really are dictionaries, and `Record<K,V>` was the honest TYPE with the
  // wrong CONSTRUCTOR. `new Map().set(…)` + `.get`/`.has` throughout. What ast.ts stops on
  // now is `.push` — the 185-site census elephant — which is a DECISION, not a gap.
  // ...and the elephant MOVED, by OPT-IN rather than by relaxation. `splitTopLevel`'s
  // `out` accumulator carries `//@@mutable` and its `.push` appends in place
  // (docs/decorators.md). Behind it: NT1002, `trimEnd`. Note what did NOT clear —
  // `setBlockDrops(list: Stmt[], …)` pushes to a PARAMETER, which is a borrow, so it stays
  // NT1606 and needs a source change rather than a compiler one.
  // ...and NT1002 is CLEARED: `trimEnd`/`trimStart` are implemented (test/trim.test.ts),
  // which also turned up that `trim` itself had been stripping only 4 of ECMAScript's 25
  // whitespace code points — a silent wrong answer, at exit 0, since the string batch.
  // Behind it, ast.ts's own NT2001 at 244:22: `isIdentifier(tag) ? tag : undefined`, a
  // ternary whose arms are `string` and `undefined` against a `?Ustring` return. Probed
  // one deeper before recording, so the next lane knows the size: behind THAT is NT1001,
  // `.find` on an object array, which is an aliasing refusal rather than a small gap.
  // ...and the ternary is CLEARED: the `?:` join now widens a present arm and a nullish
  // literal into `?U`/`?N`, which is TypeScript's rule (test/ternary-nullable.test.ts).
  // Six more fell with it, one per re-measurement, and only the FIRST was a compiler gap:
  //   NT1001 `.find` on an object array   -> source: index search (aliasing is by design)
  //   NT1606 `Set.add` result discarded   -> source: `values = values.add(…)` (persistent)
  //   NT1003 `.map(widenLiteralTys)`      -> source: an inline arrow (point-free is a value)
  //   NT2001 `.indexOf(x, from)`          -> COMPILER: the 2-arg form did not exist
  //   NT1606 a `Map` OUT-PARAMETER        -> source: `unifyTypeParams` returns its bindings
  //   NT2001 a poisoned narrowing         -> COMPILER: see `addCaptured` in src/checker.ts
  // What ast.ts stops on now is DIFFERENT IN KIND from all of those, and the next lane
  // should size it before starting: `mapTypesDeep(n: unknown, …)` at src/ast.ts:669 is a
  // REFLECTIVE walker — `Array.isArray(n)`, `n as Record<string, unknown>`, `Object.keys`,
  // assigning `o[k]` — over arbitrary AST nodes. Probed one deeper: behind the for-of is
  // `Object.keys expects an object`. ast.ts has THREE such walkers (this one, the static-
  // field rewriter, the declared-name collector). That is either a dynamic `unknown` model
  // or three exhaustive typed traversals of 44 node kinds — not a gap, a design decision.
  // ...and the THREE REFLECTIVE WALKERS ARE GONE, by a source change rather than a dynamic
  // `unknown` model — the option this row named as the alternative, and the one that would
  // have grown the `Ty` encoding. They are one exhaustively-typed traversal now
  // (`walkExprChildren`/`walkStmtChildren`, 48 node kinds, a `never`-bound `default:` so a
  // kind nobody handled is a compile-time error) with three small per-node bodies over it.
  // Evidence it is observationally null: old vs new over the parsed / CHECKED / ownership-
  // analyzed trees of all 495 `.ts` files in src/, test/ and examples/ — 1012 trees x 3
  // walkers, comparing both the resulting tree AND the exact order of the `Ty` callbacks —
  // 0 differences; plus an 84-mutant sweep (skip each of the 48 kinds, drop each field
  // slot, swap two visit orders) with 81 caught, 3 provably equivalent (`BreakStmt`,
  // `ContinueStmt`, `BlockDrops` have no children and no type fields, so skipping them IS
  // the identity). Three mutants survived the 495-file corpus and needed a hand-built
  // input — a comma `SequenceExpr`, an annotated `for (const x: T of …)`, and a do/while
  // whose body and test both carry types — which is the usual finding: a null corpus diff
  // is worth what its coverage is worth and no more.
  //
  // All NINE modules that blamed this line moved together. What was BEHIND it, in ast.ts's
  // own source, is `setBlockDrops`: `list[list.length - 1]` typed `Stmt` (an out-of-range
  // index PANICS by design), guarded `!== undefined` — a general union compared with
  // `undefined`, the same dead-guard defect lexer.ts held two rounds ago and cleared with
  // `.at`. It is worse than dead here: on an EMPTY list node takes the `push` path and
  // nativets would panic, so it is a source defect with a node divergence behind it.
  // Probed one deeper before recording, so the next lane knows the size: behind THAT is
  // NT1606, `o.f = v` on an AST node — the typed walk writes `e.ty = f(e.ty)` where the
  // reflective one wrote `o[k] = f(v)`, so this is the SAME wall in honest clothing, and
  // clearing it means deciding whether the AST interfaces carry `@@mutable` (which makes
  // them nominally tagged) or whether the walkers return new nodes. A decision, not a gap.
  "ast.ts": { rung: 0, code: "NT2001", blame: "self" },
  // Was NT1014 (`new Set([...])` for REGEX_AFTER_KEYWORD) until the collections lane made
  // `new Set(iterable)` compile. It then sat on NT2001 for two rounds, and the recorded
  // reason ("the ESCAPES object literal") was WRONG — measured, the first blocker was
  // `cannot infer type of arrow parameter 'n'` at src/lexer.ts:146, `const advance = (n = 1)
  // => …`. Inferring a parameter's type from its default cleared it; the module now walks
  // into `advance`'s BODY and stops on `line++`, a write to a captured binding.
  // ...and TWO more fell in one lane, both source-side. The cursor became one
  // `//@@mutable` record (mutating a field of an owned local is not a capture write), which
  // unmasked NT1003: `scanTemplateBody`/`scanSubstitution` were MUTUALLY RECURSIVE closures,
  // and nativets supports no nested recursion at all — nor can the cursor travel as a
  // parameter to top-level functions instead (NT1607, a parameter is a borrow). They are now
  // one loop over an explicit frame stack, verified token-identical over 477 files.
  // What is behind them is the census elephant: `tokens.push`, 13 sites in this module and
  // 185 tree-wide. It is NOT free here — see the note on the `.push` idiom's cost below.
  // CLEARED, and the cost note above is exactly why it was cleared THIS way: `tokens` is
  // now an `//@@mutable` ACCUMULATOR and all 13 sites are real in-place appends. The
  // immutable rewrite was never taken — measured at 760 ms vs 2 ms for 30k appends under
  // bun, which is stage 0. Behind it: NT2001, "Cannot compare string with undefined".
  // ...and that NT2001 was a REAL SOURCE DEFECT, not the checker gap it looked like.
  // `const radix = source[st.i + 1]` was compared `!== undefined` — correct TypeScript
  // only because tsconfig sets noUncheckedIndexedAccess. nativets cannot agree: a string
  // index that is out of range PANICS by design (the Stage 41 bounds rule), so the element
  // type is `string`, the guard is dead, and at end-of-file the PANIC happens one line
  // before the guard could have helped. `.at` is the spelling that means "may be absent"
  // in both toolchains. Behind it: NT1004, a `throw` outside a `try` at 202:5.
  "lexer.ts": { rung: 3, code: "", blame: "self" },
  // WALKED, not nudged. This module's blocker CHAIN was measured end to end — six
  // distinct blockers between it and rung 1 — and five of them are now cleared:
  //   1. NT1606  `.push` x4 in formatDiagnostic            -> immutable rebind (src)
  //   2. NT2001  `} as const` erased the catalog to number -> parser: const assertion
  //   3. NT2001  `label = "here"` typed number             -> annotated (src)
  //   4. NT2001  optional field inside an ARRAY element    -> checker: array assignability
  //   5. NT2001  `this.name` on a class extending Error    -> declared the field (src)
  //   6. NT1604  `constructor(readonly diag: Diagnostic)`  -> CONSUMING PARAMETERS
  //
  // Six is the honest number for the rung 0 -> 1 distance of the SHALLOWEST module in the
  // tree, and it is the first time that distance has been measured for any module at all.
  //
  // THE FIRST MODULE OFF THE FLOOR. Blocker 6 was not a false positive and not a nudge
  // away: a linear parameter is a BORROW (the caller owns and drops it), so storing one in
  // a field left the caller freeing a pointer the object still held — suppressing the rule
  // and running `function make(): E { const v = {...}; return new E(v); }` gave exit 255.
  // It took the feature the note asked for: a constructor PARAMETER PROPERTY is a
  // CONSUMING parameter (rustc's `fn new(d: D)`, not `fn new(d: &D)`), and every `new C(v)`
  // site moves `v` — so there is exactly one owner and no second drop. Rungs 1 -> 3 then
  // cost nothing, as this file's ladder predicted: the IR links via clang and the binary's
  // stdout and exit code match the bun-run module exactly.
  //
  // Rung 3 here is WEAK (see caveat 3 in the header): `diagnostics.ts` is a library and
  // prints nothing, so this row compares empty to empty. The non-weak evidence is the
  // driver differential at the end of this file, which exercises the module's exports and
  // matches bun byte for byte over 466 bytes of real output.
  "diagnostics.ts": { rung: 3, code: "", blame: "self" },
  // RE-MEASURED by the `?.[]` lane. parser.ts had been the ONLY module blocking on a
  // problem of its own for several rounds; clearing `?.[]` took its last self-blocker
  // away, and it now inherits ast.ts's forward type reference through the link. The blame
  // column flipping "self" -> "ast.ts" is the real news in this row.
  // Followed ast.ts off the entries form onto ast.ts's `HOST_MODULES` Record literal.
  // Followed lexer.ts off `.push` onto lexer.ts's NT2001. parser.ts's own 18
  // `this.<field>` push sites are NOT cleared — a field names no binding the ownership
  // pass can prove unique, so they stay NT1606 behind this.
  "parser.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // THE CRUX MOVED, then moved again. `Record<string, number | "var">` compiles, so
  // checker.ts left NT1009; it then stopped on `delete o.k` (NT1606), which the delete
  // lane established must STAY refused — node distinguishes an absent key from a
  // present-undefined one and a flat slot array cannot. Sharpening that refusal moved the
  // module on to NT1027, a regex literal.
  // `?.[]` cleared; walked on to `Checker.inArrow`, a method that assigns a field and
  // does not return the receiver (NT1023) — the same shape codegen.ts stops on.
  // ...and then moved SHALLOWER, ~580 lines, which is a CORRECTION and not a regression.
  // `class Scope { constructor(private parent: Scope | null = null) }` at line 93 is the
  // compiler's own symbol table, and a recursive CLASS field used to be erased to `number`
  // silently — the compiler described its own scope chain as `?NScope{parent:?Nnumber}`.
  // This row was crediting checker.ts with reaching line 676 past a miscompiled Scope. It
  // never did. See the "moved shallower is not automatically a regression" rule in
  // test/selfhost-ratchet.test.ts.
  // ...and moved on again. `Checker` is an accumulator (loop/switch depth counters, a
  // pushed-and-popped fnStack), not a copy-on-write value, so it carries `//@@mutable`
  // like `Parser`/`FnGen`/`Analyzer` already did — a SOURCE change, the precedent Stage
  // 45/49 set, not a language change. What sat behind NT1023 is NT1009: `FmtPiece` at
  // checker.ts:4385, `{text: string; spec?: undefined} | {text?: undefined; spec: FmtSpec}`
  // — an optional-field union with no string-literal discriminant.
  // ...and that was a SOURCE gap too, for the same reason NT1023 was. SH2's union has NO
  // BOX, so a union needs a literal-typed discriminant at the same slot in every member;
  // presence-discrimination has none. `FmtPiece` carries a `kind` tag now, five lines.
  // With it, checker.ts has NO BLOCKER OF ITS OWN for the first time ever — the blame
  // column flips "self" -> "ast.ts" and it lands on the mutually-recursive `Expr` SCC that
  // eight other modules already share. That flip is the news in this row, not the code.
  // Followed ast.ts off the entries form onto ast.ts's `HOST_MODULES` Record literal.
  // ARRAY OF NULLABLE ELEMENTS cleared. `argTys: (Ty | null)[]` was not a missing feature
  // but an AMBIGUITY in the `Ty` encoding — the nullable prefix and the array suffix compose
  // to one string, so `(T|null)[]` and `T[]|null` were indistinguishable and the nullable
  // reading won. A parenthesized element (`(?Nstring)[]`) disambiguates. What is behind it
  // is checker.ts's own two remaining entries-form tables (CONSOLE_STREAMS, FMT_SPECS), and
  // behind THOSE — measured in a scratch tree, not inferred — is `.push`.
  // ENTRIES FORM CLEARED. checker.ts CONSOLE_STREAMS/FMT_SPECS became `.set` chains and
  // ownership.ts's `clone` a loop, so NT1014 is GONE from the whole tree — and every one of
  // FIVE of these six landed exactly where the previous lane MEASURED they would in a scratch
  // tree: `.push`, refused by decision (commit 1ea7fa2). cli.ts did NOT — see its row. The
  // blame column moved with them: ast.ts's own `.push` is now the nearest one in the graph,
  // so four rows blame ast.ts and driver.ts blames lexer.ts.
  // MERGED with the `.push` lane, and the five rows moved AGAIN in the same merge: with
  // `.push` legal on a `@@mutable` accumulator, nothing stops here any more and all four
  // walk through to ast.ts's ONE `trimEnd` site (NT1002). driver.ts goes to lexer.ts's
  // NT2001 instead. Neither lane could have measured this alone.
  "checker.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // Left NT1015 (static members) and reached further — an unnamed parse error at 582:33.
  // ...then NT1023 on `ModuleGen.build`, same accumulator shape, same `//@@mutable` fix,
  // and behind it NT1015 again — this time a `get` accessor in `FnGen`, ~165 lines deeper.
  // That getter is now an ordinary METHOD (`isTerminated()`): accessors stay refused, and
  // the whole-tree construct census found exactly ONE getter and NO setters in `src/*.ts`,
  // so the source change was the fix rather than a language feature. Behind it, NT1002 —
  // `op in FCMP` at codegen.ts:2078, the key-presence operator, 1300 lines deeper.
  // Left NT1002 when `in` landed. MEASURED, not assumed: the lane predicted codegen.ts
  // would stop on its OWN four `Record` tables, and it does not — ast.ts's HOST_MODULES
  // fires first through the link. Its own tables are the same shape and sit behind it.
  "codegen.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // The NT1702 is GONE, and it was never a missing language feature — it was a defect in
  // the compiler's OWN module graph. `coverage.ts → coverage-preprocess.ts → coverage.ts`,
  // closed by `import type { Blocker }`. node and bun erase that edge, so the cycle did not
  // exist at run time and nothing had ever noticed it; it only became visible when the
  // recursive-type work stopped ast.ts's NT1030 from firing first.
  //
  // The fix is one moved declaration — `Blocker` now lives in the LEAF that produces it —
  // and NOT a linker change: dropping type-only edges from the DFS was measured, and it
  // leaves the type unseeded, whereupon parser.ts erases it to `number` silently. See
  // docs/divergences.md and the `bad-type-cycle` case in test/modules.test.ts.
  //
  // Both rows moved to their real blockers, and the blame column is the interesting part:
  // coverage.ts is clean on its own and inherits ast.ts's, exactly as this file predicted
  // below; coverage-preprocess.ts finally has one of its OWN.
  "coverage.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // Still inherits checker.ts's blocker, and has now followed it through THREE codes —
  // NT1009 -> NT1606 -> NT1027 — without ever having a blocker of its own under the link.
  // The long-standing "ownership.ts is credited with checker.ts's problem" attribution
  // trap, still visible. MEASURED, not predicted: the lane that moved checker.ts expected
  // this row to land on NT1014, and it did not — it tracks checker.ts exactly, because the
  // two errors are byte-identical. Always re-measure this column rather than inferring it.
  // Now FOUR codes — NT1009 -> NT1606 -> NT1027 -> NT1023 -> NT1030 — still never its own.
  // ...and back to NT1009, still byte-identical to checker.ts's. `Analyzer` has carried
  // `//@@mutable` since Stage 45, so this module has never had an NT1023 of its own.
  // ...and now NT1030, blaming ast.ts DIRECTLY rather than checker.ts — because checker.ts
  // stopped having a blocker of its own, so the nearest module that still does is ast.ts.
  // Six codes, never once its own.
  // Followed ast.ts off the entries form onto ast.ts's `HOST_MODULES` Record literal.
  // The Map spread in `clone` was the one blocker this module ever owned in the STANDALONE
  // column, and clearing it makes that column BLIND: what it reports now is the unlinked-import
  // artifact (see the ratchet baseline). Linked, it still inherits, as it always has.
  "ownership.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  "driver.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // Stage-1's entry point now stops on its OWN code for the first time: calling the async
  // `buildBinary` without `await`. Not a dependency's blocker.
  //
  // ...and it stops owning one again, by the fix the NT1020 diagnostic prescribes. The
  // refusal is a DELIBERATE over-rejection (docs/divergences.md): `await guard(() =>
  // buildBinary(…))` IS awaited under node, one frame up, but proving that is a taint
  // analysis over promise values, so the rule is uniform and `await` at the inner call
  // site is the fix. Both call sites are now `async () => await buildBinary(…)`, which is
  // the same program under bun (guard awaits the callback's promise either way, and a
  // rejection reaches its catch identically — verified by comparing old and new CLI
  // stdout+exit for build/run/emit and for the NT-diagnostic error path). cli.ts is back
  // to inheriting, and what it inherits is checker.ts's `argTys: ["string", null]`.
  // ...and on again with the group when the ARRAY-OF-NULLABLE encoding landed: stage-1's
  // entry point is gated on checker.ts's two remaining `new Map([[k,v], …])` tables.
  // ...and OFF it again: stage-1 owns its blocker for the second time ever, and this one is
  // not a refusal-by-decision but a missing host surface — `process.stdout`. It is the only
  // module in the tree whose first blocker is not `.push`.
  // ...and OFF again, with BOTH of the host surfaces it owned now grown. `process.stdout`
  // was one of two: behind it sat `spawnSync(bin, fwd, { stdio: "inherit" })`, the second
  // options shape, which `nativets run` needs so the compiled program reaches the user's
  // terminal instead of a captured buffer. With both landed cli.ts has NO blocker of its
  // own — its standalone column is now the unlinked-import artifact — and it rejoins the
  // group on ast.ts's ternary. Stage-1's next step is no longer stage-1's to take.
  // ...and at the MERGE with the ternary lane, that ternary was already gone, so cli.ts
  // lands two blockers further along than either branch measured: NT1011, ast.ts's
  // reflective `mapTypesDeep`. NT2001 is now EMPTY tree-wide — cli.ts was its last holder,
  // and it only ever held it because this lane had not landed yet. Sixth time a merge here
  // produced a frontier neither side could have computed from its own diff.
  "cli.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // Followed parser.ts through the link: when parser.ts stopped blaming itself, the three
  // modules that inherited its `?.[]` all moved to ast.ts's NT1030 together.
  // Followed ast.ts off the entries form onto ast.ts's `HOST_MODULES` Record literal.
  // Followed lexer.ts off `.push` onto lexer.ts's NT2001. Its own accumulators are pushed
  // from inside CAPTURING arrows (`const walk = (list) => { out.push(…) }`), which the
  // accumulator opt-in refuses — see the closure rule in src/ownership.ts.
  "modules.ts": { rung: 0, code: "NT2001", blame: "ast.ts" },
  // `line++` inside `advance` — a write to a captured binding, the SAME blocker lexer.ts
  // sat on for two rounds. Its own, not inherited: this module is now a true leaf, since
  // the type-only import cycle that used to mask it moved out of the way.
  //
  // RESOLVED AT THE MERGE: each side was right about its OWN change and stale about the
  // other's. This branch had not seen the type-cycle lane (so it still recorded NT1702 for
  // coverage-preprocess.ts) and main had not seen the entries-form fix (so it still
  // recorded NT1014 for modules.ts). Re-measured on the merged tree rather than picked.
  //
  // NT1031 -> NT1606, and it is a SOURCE change: the `line`/`prev` cursor `tokenize`'s two
  // closures moved is now ONE `//@@mutable` record (`TokState`), the same shape
  // `src/lexer.ts`'s `LexState` used to clear the identical blocker — mutating a FIELD of
  // an owned local is not a capture write. Behind it is `.push`, which the 185-site census
  // predicted and which is refused BY DECISION (commit 1ea7fa2), so this module joins the
  // four already parked there rather than moving a rung. Still `blame: "self"`.
  //
  // THE SECOND MODULE OFF THE FLOOR, and rung 0 -> 3 in one step. `.push` was never the
  // whole blocker: the accumulator opt-in (docs/decorators.md) does not cover a CAPTURED
  // accumulator, and `tokenize`'s array was captured by `const push = (t) => { toks.push(t);
  // st.prev = t; }`. Inlining that closure at its ten call sites is what made the opt-in
  // reachable, and the `prev: Tok` it maintained could not survive the move — `.push`
  // CONSUMES its argument (NT1601 on a second store) and reading it back out is NT1605 — so
  // it became the one boolean it was ever asked for (`TokState.regexOk`).
  //
  // Behind `.push` were three more, in this order, each unmasked by clearing the last:
  //   NT1606  a persistent `Set` with `.add`'s result discarded (x3) -> `s = s.add(x)`
  //   NT2001  `group.length && balanced`  (number && boolean)        -> `length > 0 &&`
  //   NT1605  `const tk = toks[i]!` (x7)  — binding a linear array ELEMENT to a local is a
  //           move out of the array. Fixed structurally: the statement `group` became an
  //           index WINDOW into the token array, and every other read indexes in place.
  //
  // Rung 3 here is WEAK for the same reason `diagnostics.ts`'s is (caveat 3) — a library
  // prints nothing. The non-weak evidence is the second driver differential at the end of
  // this file: 814 bytes of preprocessed statement text over six inputs, byte-identical.
  "coverage-preprocess.ts": { rung: 3, code: "", blame: "self" },
};

/*
 * SH5 — compile-time text imports (`with { type: "text" }`). The blocker this file
 * called "structural" is gone: the parser accepts the import-attributes clause and the
 * linker inlines the file as a string constant, so `src/driver.ts` now parses all
 * twelve of its embedded C files (~305KB) and reaches `export async function` at
 * driver.ts:502. Every rung FLOOR held. Two rows moved WITHIN NT1017:
 *
 *   driver.ts  NT1017 @ 27:1  (text import)  ->  NT1017 @ 502:1 (`export async`)
 *   cli.ts     the same, inherited
 *
 * so the `code` column is unchanged while the frontier moved 475 lines deeper — which
 * is exactly why `code` is recorded for the gradient and never used as a floor.
 *
 * BASELINE HISTORY — recorded because the deltas are the measurement's whole output.
 *
 * First recorded (before SH4 and the regex removal landed):
 *   NT1027 x4 (lexer, diagnostics, ownership, coverage-preprocess) — regex literals
 *   NT1017 x3 (driver, cli, modules)             — `node:fs` and friends
 *   NT0001 x3, NT1009 x1, NT1015 x1
 *
 * After merging main (SH4 host FFI + the compiler's own source made regex-free), every
 * rung FLOOR held — no regressions — and five of the twelve moved to a different, deeper
 * blocker. What the movement shows:
 *
 *   - `NT1027` is an EMPTY bucket, as main claims. What sat behind it: `lexer.ts` then
 *     died on `new Set([...])` (NT1014) at src/lexer.ts:101 — the regex-lexing support
 *     table survived the removal of the regex literals themselves. (SUPERSEDED — the
 *     collections lane made `new Set(iterable)` compile; `lexer.ts` walked on to
 *     NT2001, the `ESCAPES` `Map<string, string>` initialized with an object literal.)
 *   - `NT1017` did NOT clear for `driver.ts`. SH4 cleared `node:fs`; what is left is
 *     `import runtimeSource from "../runtime/runtime.c" with { type: "text" }`
 *     (src/driver.ts:27) — the bun-specific text import that embeds the C runtime into
 *     the single executable. `cli.ts` inherits it. This is structural: a self-hosted
 *     nativets needs its own answer for embedding the runtime, and no host-FFI work
 *     removes it. (SUPERSEDED — SH5 gave it that answer; see the note above the
 *     history. The construct is now compiled, not refused.)
 *   - `diagnostics.ts` now dies with **NT2001**, the TYPE-ERROR band. That matters for
 *     the gradient: `coverage` deliberately counts only the NT1xxx band (an NT2xxx is
 *     "a real user error"), so this blocker is invisible to the coverage histogram by
 *     design, and only a pipeline measurement like this one sees it at all. It is also
 *     reported with NO span, and the identifier it names ('value') does not occur in
 *     `src/diagnostics.ts` — so it is currently unlocatable from the diagnostic alone.
 *
 * After the short-circuit-narrowing lane, `diagnostics.ts` moves **NT2001 -> NT1606**:
 * `formatDiagnostic`'s `if (!diag.spans || diag.spans.length === 0 || !source)` now
 * type-checks (a guard narrows every term to its right, and the narrowed thing may be a
 * dotted name), and what is behind it is `[...diag.spans].sort(…)` at src/diagnostics.ts
 * — the immutable-data refusal, an NT16xx and so still outside the coverage histogram.
 * The same lane fixed the two defects the note above describes: NT2001 now carries a
 * primary span and names the receiver as written (`'diag.spans'`, not `'value'`).
 *
 * THE `.push` IDIOM IS NOT FREE FOR EVERY ACCUMULATOR — measured, because `lexer.ts` is
 * the first module to reach it and the census assumed the 145 plain-local sites were the
 * "mechanical" ones. `xs = [...xs, v]` is O(1) amortized in NATIVETS (the transient path,
 * pinned at 200 appends), and O(n) per append in BUN — which `src/*.ts` must also keep
 * running, and usably, since bun is stage-0. The lexer's `tokens` is not a small
 * accumulator: it reaches 34,987 elements on `src/checker.ts`, and building that array
 * measures
 *
 *     .push                1.1 ms
 *     xs = [...xs, v]   1150.9 ms      (1036x, and quadratic — it gets worse with size)
 *
 * so converting `lex`'s 13 sites would cost ~6 s per full-tree lex and make the test
 * suite, which lexes constantly, unusable. `diagnostics.ts` paid nothing for its 4 sites
 * because its accumulator is a handful of lines. The size of the accumulator, not the
 * shape of the receiver, is what decides whether a `.push` site is mechanical — so the
 * 185-site census needs a second column before it is a plan. Not taken in this lane.
 */

/** As a library (no argv) — every module compiled as its own entry. */
const MODULES: Entry[] = Object.keys(BASELINE).map((file) => ({
  file,
  path: () => pathOf(file),
  argv: () => [],
}));

/** Stage-1: the real entry point, exercised as a COMPILER over the corpus. */
const STAGE1: Entry = { file: "cli.ts", path: () => pathOf("cli.ts"), argv: () => ["emit", corpusEntry] };

/** Recorded separately from BASELINE: this is a different measurement of cli.ts. */
// Stage-1 (cli.ts, the whole compiler through its real entry point) left NT1017 when
// `export async function` landed and now stops on parser.ts's `?.[]` at 1109:66 —
// inherited through the link, not cli.ts's own code. Still rung 0.
//
// It then briefly owned its blocker (NT1020, the un-awaited `buildBinary`) — the only
// time stage-1 has ever stopped on its own code — and gave it back when both call sites
// took the `await` the diagnostic prescribes. Now checker.ts's `argTys: ["string", null]`,
// an ARRAY OF NULLABLE ELEMENTS, which gates five modules. Still rung 0.
// ...and NT1011 gave way to NT2001 when ast.ts's three reflective AST walkers became one
// typed traversal: stage-1 inherits ast.ts's `setBlockDrops` union-vs-undefined guard now.
// Still rung 0, and still nine modules — the frontier is a conjunction, said again.
const STAGE1_BASELINE: { rung: Rung; code: string } = { rung: 0, code: "NT2001" };

describe("SH6: the instrument itself — the upper rungs are exercised, not dead code", () => {
  /**
   * Rungs 1, 2 and 3 are unreachable by every real row today, so without this they would
   * be untested code that only runs on the day a module finally reaches IR — the worst
   * possible moment to discover the measurement is broken. A control specimen (an
   * ordinary program that DOES compile, link, run and print) walks the identical ladder
   * function and must land on a non-weak rung 3. If this fails, no rung reported by this
   * file above 0 can be trusted.
   */
  test("a known-good program walks the whole ladder to a non-weak rung 3", async () => {
    const control: Entry = {
      file: "control specimen",
      path: () => join(corpusDir, "records.ts"),
      argv: () => [],
    };
    const m = await measure(control);
    expect({ rung: m.rung, weak: m.weak, error: m.error }).toEqual({ rung: 3, weak: false, error: "" });
  }, 300_000);
});

describe("SH6: rung ladder (ratchet — a module may improve, never regress)", () => {
  for (const entry of MODULES) {
    const floor = BASELINE[entry.file]!;
    test(`${entry.file} reaches at least rung ${floor.rung}`, async () => {
      const m = await measure(entry);
      expect(
        m.rung >= floor.rung
          ? "ok"
          : `${entry.file} REGRESSED from rung ${floor.rung} to rung ${m.rung}: ${m.error}`,
      ).toBe("ok");
    }, 300_000);
  }

  test(`stage-1 (cli.ts as a compiler) reaches at least rung ${STAGE1_BASELINE.rung}`, async () => {
    const m = await measure(STAGE1);
    expect(
      m.rung >= STAGE1_BASELINE.rung
        ? "ok"
        : `stage-1 REGRESSED to rung ${m.rung}: ${m.error}`,
    ).toBe("ok");
  }, 600_000);
});

describe("SH6: the frontier as it stands (expected-to-fail — flip these when it moves)", () => {
  /**
   * The headline number, and the one that contradicts the current picture.
   *
   * `docs/self-hosting.md` records "| **IR** | `coverage` only |", and
   * `test/bootstrap.test.ts` records `"coverage.ts": "ir"` in its BASELINE. Neither is
   * true: ZERO of the twelve modules produce IR. `coverage.ts` is the module whose own
   * source parses cleanly, but the SH1 link pulls in `ast.ts`, which does not — so
   * `sourceToIR` throws for it exactly like the other eleven.
   *
   * The reason the older instrument reads otherwise is a defect in its scale, not a
   * change in the compiler: `bootstrap.test.ts:phaseOf` returns the phase `"ir"` on BOTH
   * branches of its final try/catch, so "produced IR" and "died during the IR stage"
   * score identically. Its top rung cannot distinguish success from failure. This
   * ladder's rung 1 is exactly that distinction, which is why it exists.
   */
  test("exactly THREE modules reach IR — the rest of the ladder is at rung 0", async () => {
    const rows = await Promise.all(MODULES.map(async (e) => [e.file, (await measure(e)).rung] as const));
    // SORTED: the row order is module-iteration order, an artifact. Asserting it
  // unsorted produced a spurious conflict at the merge.
  const reachedIR = rows.filter(([, r]) => r >= 1).map(([f]) => f).sort();
    // THE HEADLINE NUMBER CHANGED, for the first time since this file was written. It read
    // `[]` — "ZERO of the twelve modules produce IR" — for every measurement until
    // consuming parameters landed. `diagnostics.ts` is the first, and it did not stop at
    // rung 1: it links and runs. Eleven still sit at rung 0, so this is one module, not a
    // trend; the list is exact so the twelfth cannot arrive unnoticed either way.
    //
    // TWO. `coverage-preprocess.ts` joined, and it is the first row here that got off the
    // floor by an ORDINARY source rewrite — no new language feature, no new rule. Four
    // blockers were between it and rung 1 (NT1606 `.push`, NT1606 discarded `Set.add`,
    // NT2001 `number && boolean`, NT1605 binding a linear array element to a local) and all
    // four were cleared inside the module, with a 495-file byte-for-byte diff of the old and
    // new `preprocessForCoverage` as the evidence that nothing observable changed.
    //
    // Two is still not a trend, and the ORDER of the list is a fact worth reading: this is
    // the FILE ORDER of `MODULES`, so a module joining does not reshuffle it.
    expect(reachedIR).toEqual(["coverage-preprocess.ts", "diagnostics.ts", "lexer.ts"]);
  }, 300_000);

  /**
   * The gradient: which blocker stops each module. Recorded so shrinking a bucket is a
   * deliberate, reviewable step. A mismatch here is NOT necessarily a regression —
   * clearing a blocker unmasks the one behind it — it is a prompt to re-record.
   */
  test("the blocker each module dies on", async () => {
    const got: Record<string, string> = {};
    for (const e of MODULES) got[e.file] = (await measure(e)).code;
    const want: Record<string, string> = {};
    for (const [file, b] of Object.entries(BASELINE)) want[file] = b.code;
    expect(got).toEqual(want);
  }, 300_000);

  /**
   * ATTRIBUTION — which FILE the blocker actually lives in, which the diagnostic itself
   * does not say. `sourceToIR` compiles a whole PROGRAM (SH1 merges the import graph), so
   * a module can be stopped by a file it merely imports. Eleven modules are stopped by
   * their own source; `coverage.ts` alone is clean on its own and inherits `ast.ts`'s
   * blocker. Aiming a burn-down at `coverage.ts` would therefore be aiming it at the
   * wrong file — the same class of mistake `coverage`'s preprocess made.
   */
  test("blocker attribution: self vs inherited through the import graph", async () => {
    const got: Record<string, string> = {};
    for (const e of MODULES) got[e.file] = await blameOf(e.file);
    const want: Record<string, string> = {};
    for (const [file, b] of Object.entries(BASELINE)) want[file] = b.blame;
    expect(got).toEqual(want);
  }, 300_000);

  /**
   * The parse-based attribution this test used to do is now WRONG, and recording why
   * matters more than the fix: it is the same mistake twice.
   *
   * `coverage`'s preprocess made a module look blocker-free by stripping what blocked it.
   * "Reaches parse" then became the proxy every self-hosting lane was judged by. Both
   * measure a stage rather than the outcome. Today SIX modules parse their own source
   * cleanly — and four of them are still blocked, two by a dependency and two at the
   * CHECKER, after parse is over. A parse-clean module is not an unblocked module, so
   * attribution has to compare what the whole pipeline actually reports.
   */
  test("parsing clean is not being unblocked — ten parse, one compiles", async () => {
    const { parse } = await import("../src/parser.ts");
    const parseClean: string[] = [];
    for (const e of MODULES) {
      try { parse(read(e.file)); parseClean.push(e.file); } catch { /* blocked at parse */ }
    }
    // NINE now. `driver.ts` joined when `export async function` landed; `modules.ts` when
    // generic class methods did; `parser.ts` when optional element access `?.[]` did —
    // `?.[]` was the last construct in the parser's own source that the parser could not
    // read. The point of this test is unchanged and is the uncomfortable one — parsing
    // clean has never ONCE correlated with being closer to compiling. TEN of twelve
    // modules parse their own source; ONE produces IR. `checker.ts` joined when the
    // `FmtPiece` union got a `kind` tag, and it is the sharpest illustration this test has
    // ever had: the largest module in the tree parses clean, blames no construct of its
    // own, and is still at rung 0.
    // ELEVEN now, and the twelfth is `codegen.ts` — `ast.ts` joined when its 45-member
    // recursive component finally encoded, which was the last module in the tree whose own
    // TYPE DECLARATIONS the parser could not read. It sharpens the point rather than
    // softening it: ast.ts went from "the single highest-leverage blocker on the board,
    // holding nine modules" to parsing clean, and it is STILL at rung 0 — it now stops at
    // `new Map([[k, v], …])`, one line further on.
    // TWELVE now — codegen.ts joined when `in` landed, so EVERY module in the tree parses
    // its own source. One produces IR. That is this test's point at its sharpest: parsing
    // clean has never once correlated with being closer to compiling.
    expect(parseClean.sort()).toEqual([
      "ast.ts", "checker.ts", "cli.ts", "codegen.ts", "coverage-preprocess.ts", "coverage.ts",
      "diagnostics.ts", "driver.ts", "lexer.ts", "modules.ts", "ownership.ts", "parser.ts",
    ]);
    // ...and the point SURVIVES the first module getting off the floor, which is the
    // interesting part. `diagnostics.ts` reaching rung 3 did not come from parsing — it
    // has parsed cleanly for many rounds — it came from clearing six blockers, five of
    // them AFTER parse. The other eight parse-clean modules are still at rung 0.
    //
    // `coverage-preprocess.ts` is the second, and it makes the same point twice: it has
    // ALSO parsed clean for many rounds (it is in the list above), and the four blockers it
    // then cleared were all post-parse. Ten of twelve parse clean and remain at rung 0.
    const AT_RUNG_3 = ["coverage-preprocess.ts", "diagnostics.ts", "lexer.ts"];
    for (const file of parseClean) {
      const m = await measure(MODULES.find((e) => e.file === file)!);
      expect(`${file} rung ${m.rung}`).toBe(`${file} rung ${AT_RUNG_3.includes(file) ? 3 : 0}`);
    }
  }, 300_000);

  /**
   * Stage-1 — the whole compiler, entered at its real entry point. When THIS reaches
   * rung 3 the differential below starts doing real work and self-hosting stage-1 is
   * reached; until then it records how far it got.
   */
  test("stage-1 does not build (records how far it got)", async () => {
    const m = await measure(STAGE1);
    expect({ rung: m.rung, code: m.code }).toEqual(STAGE1_BASELINE);
  }, 600_000);
});

/**
 * ATTRIBUTION — which FILE a module's blocker actually lives in, which the diagnostic
 * itself does not say. `sourceToIR` compiles a whole PROGRAM (SH1 merges the import
 * graph), so a module is routinely stopped by a file it merely imports: `cli.ts` reports
 * `driver.ts`'s `export async`, `ownership.ts` reports `checker.ts`'s union. Aiming a
 * burn-down at the reporting module would be aiming it at the wrong file.
 *
 * A module is blamed on a dependency when that dependency, compiled as its OWN entry,
 * produces the byte-identical error. Dependencies are walked post-order (deepest first),
 * matching the linker's own DFS, so the blame lands on the file that originates the
 * error rather than an intermediate that merely propagates it.
 */
async function blameOf(file: string): Promise<string> {
  const error = (await measure(MODULES.find((e) => e.file === file)!)).error;
  if (!error) return "self";
  for (const dep of depsOf(file)) {
    const d = MODULES.find((e) => e.file === dep);
    if (d && sameBlocker((await measure(d)).error, error)) return dep;
  }
  return "self";
}

/**
 * Two blockers are THE SAME blocker when their messages agree once the linker's
 * alpha-rename prefix is normalized away.
 *
 * Plain string equality was not enough and the failure was silent. `linkProgram`
 * renames every non-entry module's top-level bindings (`HOST_MODULES` becomes
 * `_nt_m0_HOST_MODULES`), so the instant a module's blocker is a diagnostic that
 * NAMES a binding, the dependency's own message and the dependent's differ by that
 * prefix and blame falls through to `"self"`. It cost nothing while the frontier sat
 * on NT1014/NT1030, whose messages carry no identifier; the moment `src/ast.ts`'s
 * `HOST_MODULES` became the shared blocker, four modules were credited with owning a
 * declaration that is not in them — which is exactly the "aiming the burn-down at the
 * wrong file" this function exists to prevent.
 */
function sameBlocker(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  // Every base `choosePrefixBase` can pick, followed by the per-module index.
  const strip = (s: string) => s.replace(/_(?:m|nt_m|nativets_module_|nts\d+_m)\d+_/g, "");
  return strip(a) === strip(b);
}

/** Transitive `./x.ts` imports, post-order (deepest first) — the linker's own order. */
function depsOf(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: string[] = [];
  for (const m of read(file).matchAll(/(?:from|import)\s+"\.\/([\w.-]+\.ts)"/g)) {
    const dep = m[1]!;
    // Only real compiler modules: `src/*.ts` carries commented-out import EXAMPLES
    // (`from "./m.ts"` in a doc comment), and a text scan cannot tell those from code.
    if (!(dep in BASELINE)) continue;
    out.push(...depsOf(dep, seen), dep);
  }
  return out;
}

/* ============================================================
 * The differential itself
 * ============================================================ */

describe("SH6: differential self-compilation (bun-run compiler is the oracle)", () => {
  /**
   * THE assertion this whole file exists for. Once `cli.ts` reaches rung 3, a compiled
   * compiler exists and every corpus input must lower to BYTE-IDENTICAL IR under both
   * compilers.
   *
   * This is not conditional-so-it-can-be-skipped: the rung is measured, and while it is
   * below 3 the test asserts the recorded fact that no compiled compiler exists, which
   * fails the moment that stops being true — at which point the differential below is
   * the gate, and the recorded baseline must be updated deliberately.
   */
  test("a nativets-compiled compiler emits IR identical to the bun-run compiler", async () => {
    const m = await measure(STAGE1);
    if (m.rung < 3) {
      // No compiled compiler exists, so there is nothing to compare — recorded, not
      // skipped. The expected string is hardcoded, so this reds the moment stage-1
      // improves, and the comparison below becomes the real gate.
      // Assert the RUNG, the CODE and the CONSTRUCT — deliberately NOT the line:column.
      // This used to pin `at 1109:66`, which meant any edit ABOVE that line in parser.ts
      // reddened this test without stage-1 having moved at all; the indexed-access lane
      // shifted it to 1169:66 by adding parsing code elsewhere. A position is not the
      // fact being recorded. The fact is: stage-1 is at rung 0, stopped on a forward type
      // reference inherited from ast.ts. That still reds the moment the CONSTRUCT
      // or the rung changes, which is what this test is for.
      //
      // RE-MEASURED by the `?.[]` lane: stage-1 is still at rung 0, but the construct it
      // stops on is no longer parser.ts's `?.[]` — that compiles now. It is ast.ts's
      // forward TYPE reference (NT1030), inherited by every module that imports ast.ts,
      // which is all of them. The construct string is updated, not dropped; naming it is
      // the whole point of the assertion.
      //
      // RE-MEASURED AGAIN by the type-hoisting lane, and this is the interesting part: the
      // forward reference was MASKING the real blocker. Top-level type declarations hoist
      // now, so ast.ts:521's `as Identifier` resolves and 19 of ast.ts's 64 type
      // declarations along with it — but the other 45 (`Expr`, `Stmt` and their members)
      // are one mutually-recursive cluster, which hoisting cannot touch and no reordering
      // can fix. Same code, same rung, DIFFERENT construct: still NT1030, now for the
      // reason that actually gates self-hosting. Lifting it means a nominal, by-reference
      // form in `Ty` (docs/divergences.md), not a parser change.
      //
      // RE-MEASURED by the UNION lane, and the mutually-recursive cluster is GONE. It was
      // 41/45 encoded and the four residuals were not recursion at all — they were unions
      // (`ArrowFunction.body: Expr | Stmt[]`, `ForStmt.init: VarDecl | Expr | null`, and
      // the two aliases selecting over them). Union FLATTENING plus splitting the arrow's
      // body into two folded fields closed all four. Stage-1 is STILL rung 0 and the
      // construct changed again — now codegen.ts's `op in FCMP`, the key-presence
      // operator. Nine modules moved and not one of them reached IR, which is this file's
      // recurring lesson stated a fourth time: the frontier is a CONJUNCTION, and clearing
      // its largest term reveals the next one rather than finishing it.
      expect(`stage-1 rung ${m.rung}, ${m.code}`)
        .toBe(`stage-1 rung ${STAGE1_BASELINE.rung}, ${STAGE1_BASELINE.code}`);
      // SIXTH construct for stage-1, and the return to normal service: the FIFTH was the
      // first blocker cli.ts ever owned (`calling async function 'buildBinary' without
      // 'await'`), and both of its call sites now take the `await` that diagnostic
      // prescribes. Back to a dependency's — checker.ts's `argTys: ["string", null]`, an
      // array of NULLABLE elements, which gates five modules at once.
      // SEVENTH: the array-of-nullable was an ENCODING ambiguity (`?N` is a prefix, `[]` a
      // suffix, so `(T|null)[]` and `T[]|null` were one `Ty` string) and is now spelled
      // `(?Nstring)[]`. Behind it, checker.ts's own two remaining entries-form tables.
      // EIGHTH, and stage-1 owns its blocker for the second time ever: the entries form is
      // cleared tree-wide, and cli.ts does NOT land on `.push` with the other ten. It lands
      // on `process.stdout is not supported` — a host surface nativets has simply never
      // grown, not a refusal-by-decision. So stage-1's next step is now independent of the
      // 185-site `.push` rewrite, which is the first time those two have been separable.
      // NINTH, and the separability was real but SHORT: both of cli.ts's own host-surface
      // blockers are now implemented — `process.stdout.write` (bytes with no trailing
      // newline, which is exactly what this `emit` path needs and what `console.log`
      // cannot do) and `spawnSync(…, { stdio: "inherit" })` (the `run` path). cli.ts owns
      // nothing now, and is back to inheriting with the other eleven: ast.ts's ternary
      // whose branches are `string` and `undefined`. Stage-1 cannot move again until a
      // DEPENDENCY does, which is where it spent every round but two.
      // TENTH — and the dependency moved in the same merge. The ternary lane cleared the
      // `?:` join (a present arm and a nullish literal widen to `?U`/`?N`) and then six
      // more ast.ts blockers behind it, so cli.ts never actually sat on the ternary: it
      // lands on `mapTypesDeep`, the reflective `unknown` walker at src/ast.ts:669. This is
      // the first blocker stage-1 has inherited that is a DESIGN decision rather than a
      // gap — a dynamic object model, or three exhaustive typed AST traversals.
      // ELEVENTH — the dependency moved again, and this time by taking the OTHER fork the
      // note above named: three exhaustive typed AST traversals, not a dynamic object
      // model. Stage-1 now inherits what was behind them, `setBlockDrops`'s
      // `list[list.length - 1] !== undefined` — a general union compared with `undefined`,
      // ast.ts's own source defect (see the BASELINE row). Asserted on the tail of the
      // message rather than the head: the head is the whole 18-member `Stmt` union
      // printed out, which is 3 KB of encoding that would churn on any AST change.
      expect(m.error).toContain("with undefined");
      expect(m.error).toContain("Cannot compare");
      return;
    }

    // Stage-1 exists. Build it once, then compile every corpus input with BOTH compilers
    // and compare the IR text byte for byte.
    const dir = mkdtempSync(join(tmpdir(), "nativets-sh6-stage1-"));
    try {
      const bin = join(dir, "nativets-1");
      await buildBinary(read("cli.ts"), bin, { target: "host", entryPath: pathOf("cli.ts") });
      for (const name of Object.keys(CORPUS)) {
        const input = join(corpusDir, name);
        const selfHosted = spawnSync(bin, ["emit", input], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
        const oracle = sourceToIR(readFileSync(input, "utf8"), input);
        expect(selfHosted.status).toBe(0);
        expect(selfHosted.stdout).toBe(oracle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);

  /**
   * The oracle side of the differential, verified independently of self-hosting: the
   * seam really is `sourceToIR`, and `nativets emit` really is that function's output,
   * so "the compiled compiler's `emit` stdout == `sourceToIR`" is a meaningful equality
   * rather than a comparison of two things that were never the same to begin with.
   *
   * This is the only test here that passes today, and it is deliberately narrow: it
   * proves the MEASURING APPARATUS is sound, not that anything self-hosts.
   */
  test("the seam is sound: `bun run cli.ts emit x` == sourceToIR(x)", () => {
    for (const name of Object.keys(CORPUS)) {
      const input = join(corpusDir, name);
      const viaCli = spawnSync("bun", ["run", pathOf("cli.ts"), "emit", input], { encoding: "utf8", timeout: 120_000 });
      expect(viaCli.status).toBe(0);
      expect(viaCli.stdout).toBe(sourceToIR(readFileSync(input, "utf8"), input));
    }
  }, 120_000);

  /**
   * Rung 3 for a LIBRARY module is weak by construction (caveat 3): a module that prints
   * nothing matches a bun run that prints nothing. Recorded here so that a future green
   * row cannot be read as behavioural evidence. When modules do reach rung 3, this test
   * is the reminder that per-module EXERCISE entries (import the module, do real work,
   * print a digest) are what turn rung 3 into a real behavioural differential.
   */
  test("no module is claiming a non-weak rung 3 (the one that reached it prints nothing)", async () => {
    const strong: string[] = [];
    for (const e of MODULES) {
      const m = await measure(e);
      if (m.rung === 3 && !m.weak) strong.push(e.file);
    }
    // `diagnostics.ts` is at rung 3 and is NOT in this list, which is the caveat doing its
    // job rather than a contradiction: a library that prints nothing matched a bun run that
    // printed nothing. The behavioural evidence is the DRIVER differential below — the
    // "per-module EXERCISE entry" this comment has been asking for since the file was
    // written, now that there is a module to write one for.
    expect(strong).toEqual([]);
  }, 300_000);

  /**
   * THE NON-WEAK DIFFERENTIAL, for the one module that self-compiles.
   *
   * A driver imports `src/diagnostics.ts` and does real work with it — builds three
   * diagnostics through three different constructors, reads `.diag` off the thrown-error
   * class whose parameter property was the last blocker, and renders one with the
   * rustc-style multi-span formatter over real source. It is compiled by nativets (the
   * SH1 linker pulls the module in through an ordinary relative import) and run; the
   * oracle is `bun run` over the identical file. stdout must be byte-identical.
   *
   * This is what caveat 3 asks for and what the row above cannot supply: 466 bytes of
   * output that a broken compile would get wrong, instead of empty == empty. It exercises
   * the consuming-parameter path end to end — `new NTError({...})` moves its argument into
   * the object, and the object is read back out afterwards.
   */
  test("diagnostics.ts DRIVER: real output, byte-identical to the bun-run module", async () => {
    // `realpathSync`, not the raw mkdtemp path: on macOS `/var` is a symlink to
    // `/private/var`, so a `..` chain computed from `/var/...` walks a different number of
    // levels than the resolver sees, and bun cannot find the module. The compiled side
    // happens to survive it; the ORACLE does not, which would have read as a diff.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nativets-sh6-drive-")));
    try {
      const driver = join(dir, "drive.ts");
      // A relative specifier is the only import form the linker takes (SH1), so the path
      // from the scratch directory to the real module is computed rather than written.
      const spec = relative(dir, realpathSync(pathOf("diagnostics.ts")));
      writeFileSync(driver, [
        `import { formatDiagnostic, nyi, parseError, NYI } from ${JSON.stringify(spec)};`,
        ``,
        `const e1 = nyi(NYI.CLASS_FEATURE, "generic classes");`,
        `console.log(e1.message);`,
        `console.log(e1.diag.code + " / " + (e1.diag.hint ?? "(none)"));`,
        `console.log(formatDiagnostic(e1.diag));`,
        ``,
        `const e3 = parseError("Expected ';'");`,
        `console.log(formatDiagnostic(e3.diag));`,
        `console.log(e3.diag.code + " " + e3.name);`,
        ``,
        `const src: string | undefined = "const a = 1;\\nconst b = 2;\\nconsole.log(x);\\n";`,
        `console.log(formatDiagnostic({ code: "NT2001", message: "'x' is not defined", hint: "declare it first", spans: [{ line: 3, label: "here", primary: true }] }, src));`,
        ``,
      ].join("\n"));

      const bin = join(dir, "drive");
      await buildBinary(readFileSync(driver, "utf8"), bin, { target: "host", entryPath: driver });
      const ours = spawnSync(bin, [], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
      const oracle = spawnSync("bun", ["run", driver], { encoding: "utf8", timeout: 120_000 });

      expect(oracle.stdout.length).toBeGreaterThan(0); // the oracle must actually print
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.status).toBe(oracle.status);
      expect(ours.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  /**
   * THE SECOND NON-WEAK DIFFERENTIAL — `src/coverage-preprocess.ts`.
   *
   * A driver imports the module and runs `preprocessForCoverage` over six inputs chosen to
   * reach the parts of it that a plain source file does not: a shebang, an `import` with an
   * inline `type` specifier, an erased `type`/`interface` pair, a regex literal next to a
   * division and a string-divided-by-number, a `//@@` pragma, a class, a `do`/`while`, a
   * template with a substitution, `export default async`, and radix/exponent/separator
   * numerals. It prints every emitted statement with its line, the erased-name list and a
   * character total, so a wrong token boundary anywhere moves the bytes.
   *
   * This is the module whose whole job is to make `src/` measurable, so a weak rung 3 for it
   * would be the least useful green in the file. 814 bytes, byte-identical to `bun run`.
   */
  test("coverage-preprocess.ts DRIVER: real output, byte-identical to the bun-run module", async () => {
    // `realpathSync` for the same reason as the driver above: /var -> /private/var on macOS
    // breaks the ORACLE's module resolution, not the compiled side, which reads as a diff.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nativets-sh6-drive2-")));
    try {
      const driver = join(dir, "drive.ts");
      const spec = relative(dir, realpathSync(pathOf("coverage-preprocess.ts")));
      writeFileSync(driver, [
        `import { preprocessForCoverage } from ${JSON.stringify(spec)};`,
        ``,
        // The inputs are real strings here and JSON.stringify'd into the driver, rather
        // than hand-escaped inside a template — the driver source is itself TypeScript
        // containing regex literals, backticks and backslashes, and escaping it twice by
        // hand is how this test first failed to even parse.
        `const SAMPLES: string[] = [`,
        ...[
          "#!/usr/bin/env bun\nimport { parse, type Ty } from './ast.ts';\nexport type Alias = number;\ninterface Shape { x: number; }\nexport function f(n: number): number { return n + 1; }\n",
          String.raw`const rx = /a\.b/g.test("x"); const d = 6 / 2; const s = "a" / 2;`,
          "//@@mutable\ninterface St { line: number }\nclass Box { m(): number { return 1; } }",
          "do { x(); } while (c);\nfunction g() { return `t${1 + 2}u`; }",
          "export default async function h(a: number[]): Promise<number> { return a[0]!; }",
          "for (const t of xs) { if (t === 0) continue; }\nconst n = 0xff + 1e3 + 1_0;",
        ].map((sample) => `  ${JSON.stringify(sample)},`),
        `];`,
        ``,
        `let total = 0;`,
        `for (const sample of SAMPLES) {`,
        `  const pre = preprocessForCoverage(sample);`,
        `  console.log("=== " + pre.statements.length + " statements, " + pre.erasedNames.length + " erased, " + pre.stripped.length + " stripped");`,
        `  for (const st of pre.statements) {`,
        `    console.log(st.line + " | " + st.text);`,
        `    total = total + st.text.length;`,
        `  }`,
        `  console.log("erased: " + pre.erasedNames.join(","));`,
        `}`,
        `console.log("total emitted characters: " + total);`,
        ``,
      ].join("\n"));

      const bin = join(dir, "drive");
      await buildBinary(readFileSync(driver, "utf8"), bin, { target: "host", entryPath: driver });
      const ours = spawnSync(bin, [], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
      const oracle = spawnSync("bun", ["run", driver], { encoding: "utf8", timeout: 120_000 });

      expect(oracle.stdout.length).toBeGreaterThan(0); // the oracle must actually print
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.status).toBe(oracle.status);
      expect(ours.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
