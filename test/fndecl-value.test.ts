/*
 * A function DECLARATION referenced by NAME as a VALUE.
 *
 *     function dbl(n: number): number { return n * 2; }
 *     apply(dbl, 21);            // error[NT2001]: 'dbl' is not defined
 *
 * The diagnostic was FALSE — `dbl` is defined, and node runs the program. The cause was a
 * two-table split: `check` registers every top-level `FuncDecl` in the SIGNATURE table
 * (`functions`), which is keyed by name and read only at direct CALL sites, and never
 * binds the name in the value `Scope`. So `scope.lookup("dbl")` missed and the Identifier
 * case reported "not defined" — the one message that was certainly wrong, since the name
 * resolves fine one line later as `dbl(21)`.
 *
 * The same-shaped program written with a `const` bound to an arrow always worked
 * (`const dbl = (n: number) => n * 2`), which is what localizes this to BINDING rather
 * than to codegen: `lane-fnvalue` established that calling a function value already works
 * (33 of 36 function-typed parameters in `src/` compile), so the machinery to *call* one
 * existed and only the machinery to *produce* one from a declaration did not.
 *
 * WHY A SHIM. A function value is a heap block `[fn_ptr, cap0, …]` and a call through one
 * passes the block as an implicit first argument (`callClosure`). A top-level function has
 * no such parameter, so its symbol cannot be stored in slot 0 directly — the ABIs differ
 * by exactly that leading `ptr`. Codegen therefore emits one trampoline per function used
 * this way, on the same lazy pattern `cmpShim`/`actorEntry` already use, and — because a
 * declaration captures NOTHING — the block itself is a compile-time constant emitted as a
 * private GLOBAL. That is what makes this cheaper than a closure rather than equal to it:
 * no allocation, so nothing to own, nothing to drop, and nothing to leak.
 *
 * HOISTING is supported, and deliberately: node hoists function declarations, so a
 * reference may legally precede the textual definition. The signature table is fully
 * populated in pass 1, before any body is checked, so the hoisted case costs nothing extra
 * and refusing it would have been the divergence.
 *
 * WHAT STAYS REFUSED, and why each is a real ABI gap rather than a missing case:
 *   - OPTIONAL / DEFAULT parameters and REST. A call through a function value passes
 *     exactly the argument list the function TYPE spells; the defaults live at the direct
 *     call site, so `(a, b = 2) => …` reached through a value would read `b` from an
 *     argument nobody passed. Refused (NT1003) rather than miscompiled.
 *   - GENERIC declarations, which already had their own precise message: a generic is
 *     specialized at its call site, so it has no single type to be a value of.
 *   - Point-free ARRAY HOF callbacks (`xs.map(f)`). These are refused a layer earlier and
 *     by a different rule — `.map`/`.filter`/`.forEach` are INLINED as loops and demand a
 *     literal arrow — so they are unaffected by this and are NOT counted as fixed. A
 *     `const` bound to an arrow cannot pass them either, which is what proves the two
 *     defects independent.
 *
 * THE CENSUS, over the LINKED stage-1 program (src/cli.ts): 8 value-position references to
 * a top-level function declaration, of which 7 are point-free array HOFs blocked by the
 * inline-arrow rule above and exactly 1 — `mapTypesDeepExpr(arrow, eraseTypeParams)` at
 * src/parser.ts:3359 — is blocked by this defect. Reported as one site, honestly: the
 * value here is the false diagnostic, not the count.
 *
 * Oracle is `node` on every case, per the prime directive.
 */

import { test, expect, describe } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, compileAndRunFile, runWithNode, runWithNodeFile } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** `{code, message, hint}` for a program the FRONTEND refuses, or null if it compiles. */
function refusal(source: string): { code: string; message: string; hint?: string } | null {
  try {
    sourceToIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    if (!d) throw e;
    return d;
  }
}

describe("a function declaration used as a value", () => {
  test("is passed by name to a function-typed parameter", async () => {
    await same(`
function dbl(n: number): number { return n * 2; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(dbl, 21));
`);
  });

  // node HOISTS function declarations, so this is a legal program and the oracle prints
  // 42. Supported deliberately rather than by accident: the signature table is fully
  // populated in pass 1, before any body is checked, so the reference resolves whatever
  // its textual position. Refusing it would have been a divergence to write down.
  test("may be referenced BEFORE its textual definition (node hoists declarations)", async () => {
    await same(`
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(dbl, 21));
function dbl(n: number): number { return n * 2; }
`);
  });

  // Bound to a `const` and called THROUGH the binding — the indirect path, where the block
  // is loaded out of a frame slot rather than handed straight to a callee.
  test("is bound to a const and called through it", async () => {
    await same(`
function dbl(n: number): number { return n * 2; }
const f: (x: number) => number = dbl;
console.log(f(21));
`);
  });

  /*
   * A PARAMETER of the same name SHADOWS the function, as node does. This is the guard on
   * the ORDER of the new codegen check — it runs after the binding tables, never before —
   * and it is the mutation witness for this lane.
   *
   * The case is chosen for its failure SHAPE, which was measured rather than assumed.
   * Dropping the guard and re-running:
   *
   *   - `function use(dbl: number) { return dbl + 1 }` fails at CLANG (`fadd` on a `ptr`).
   *     Loud, therefore worthless as a witness — a build error is not the bug we fear.
   *   - the case below, where the shadowing parameter is itself FUNCTION-typed and is
   *     forwarded onward as a VALUE, prints **42 at exit 0** where node prints 22. The
   *     silent wrong answer, which is the outcome the prime directive ranks worst.
   *
   * The forwarding through `call2` is load-bearing: calling the shadowing parameter
   * directly (`dbl(v)`) resolves through the CALL path, which reads `varTypes` first and
   * never reaches this branch — so that spelling survives the mutation and would have
   * pinned nothing.
   */
  test("is SHADOWED by a function-typed parameter forwarded as a value", async () => {
    await same(`
function dbl(n: number): number { return n * 2; }
function call2(g: (x: number) => number, v: number): number { return g(v); }
function apply(dbl: (x: number) => number, v: number): number { return call2(dbl, v); }
console.log(apply((x: number): number => x + 1, 21));
`);
  });

  /*
   * ACROSS MODULES, which is the shape the one real `src/` site actually has: src/ast.ts
   * exports `eraseTypeParams` and src/parser.ts passes it by name to `mapTypesDeepExpr`
   * (src/parser.ts:3359). After linking the import is an ordinary top-level declaration, so
   * this rides the same path — but it is worth its own fixture because the FAILURE was
   * module-specific in an instructive way. On the base tree this exact program reports
   *
   *     error[NT2001]: '_m0_eraseOne' is not defined
   *
   * naming the LINKER's renamed symbol, a spelling that appears nowhere in the user's
   * source. So the message was not merely false about the fact, it was unactionable about
   * the name — the user cannot grep for `_m0_eraseOne`. Fixing the binding removes both.
   *
   * `blocker-metric` cannot show this site clearing: `Parser.parseAssign` is masked by an
   * NT1606 (`Set.add` discarded) at parser.ts:3333, twenty-six lines ABOVE the reference.
   * Hence the fixture — the metric's own header says a correct fix that closes 0 blockers
   * still ships, and this is what "verify it directly instead" looks like.
   */
  test("resolves across a module boundary (the src/parser.ts:3359 shape)", async () => {
    const entry = join(HERE, "modules", "fndecl-value", "main.ts");
    const oracle = runWithNodeFile(entry);
    expect(oracle.stderr).toBe("");
    const ours = await compileAndRunFile(entry);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout).toBe("number,string,number\n");
  });

  /*
   * IDENTITY. `dbl === dbl` is `true` in node, and this is the test that makes the
   * per-function memo in `ModuleGen.fnValue` a CORRECTNESS requirement rather than an
   * optimization: two references to one declaration must yield the same block. Emit a
   * fresh block per reference and this prints `false` — a silent wrong answer, and the
   * reason the caching is worth the one blocker it costs (the same `Map.set` NT1606 that
   * `cmpShim`, `actorEntry`, `msgRenderer` and `intern` all already carry).
   */
  test("two references to one declaration are the SAME value (===)", async () => {
    await same(`
function dbl(n: number): number { return n * 2; }
const a: (x: number) => number = dbl;
const b: (x: number) => number = dbl;
console.log(a === b);
`);
  });

  /*
   * Coexists with a PROMOTED GLOBAL. A module-level binding read from inside a function
   * body is promoted to an LLVM global, so it lives in neither `varTypes` nor `captures`
   * and `isBound` is false for it — the same condition that gates the new lookup. It falls
   * through correctly only because the signature table has no entry under that name, which
   * is worth a test rather than an argument: this is the one place a non-function name
   * legitimately reaches the new branch.
   */
  test("does not intercept a module-level binding promoted to a global", async () => {
    await same(`
const scale = 3;
function dbl(n: number): number { return n * 2; }
function apply(f: (x: number) => number, v: number): number { return f(v) * scale; }
console.log(apply(dbl, 7));
`);
  });
});

/*
 * The two shapes that stay refused. Both are ABI facts: a call through a function value
 * passes exactly the arguments the function TYPE spells, and the machinery that supplies
 * a default (or packs a rest array) lives at the DIRECT call site and nowhere else. So
 * accepting either would enter the callee with a parameter nobody wrote — the silent
 * wrong answer, not a crash. Refused, and each hint is RUN below: a hint whose advice
 * does not compile is worse than no hint at all.
 */
describe("shapes that stay refused because the value ABI cannot carry them", () => {
  const DEFAULTED = `
function add(a: number, b: number = 10): number { return a + b; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(add, 21));
`;

  test("a DEFAULTED parameter is NT1003, naming the parameter as the cause", () => {
    const d = refusal(DEFAULTED);
    expect(d?.code).toBe("NT1003");
    expect(d?.message).toContain("optional or defaulted parameter");
    // Crucially NOT the old lie. `add` is defined; the reason it cannot be a value here
    // is its default, and the message has to say which.
    expect(d?.message).not.toContain("is not defined");
  });

  test("the defaulted hint's advice COMPILES and matches node", async () => {
    expect(refusal(DEFAULTED)?.hint).toContain("(a0) => add(a0)");
    await same(`
function add(a: number, b: number = 10): number { return a + b; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply((a0) => add(a0), 21));
`);
  });

  const REST = `
function total(...ns: number[]): number { let s = 0; for (const n of ns) s += n; return s; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(total, 21));
`;

  test("a REST parameter is NT1003, naming the rest parameter as the cause", () => {
    const d = refusal(REST);
    expect(d?.code).toBe("NT1003");
    expect(d?.message).toContain("REST parameter");
    expect(d?.message).not.toContain("is not defined");
  });

  test("the rest hint's advice COMPILES and matches node", async () => {
    expect(refusal(REST)?.hint).toContain("(a0) => total(a0)");
    await same(`
function total(...ns: number[]): number { let s = 0; for (const n of ns) s += n; return s; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply((a0) => total(a0), 21));
`);
  });

  /*
   * A name that really IS undefined must still say so. The new lookup is a FALLBACK on the
   * miss path, so widening it into "every miss is a function" would have replaced one
   * false message with another.
   */
  test("a genuinely undefined name still reports NT2001 'is not defined'", () => {
    const d = refusal(`
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(nope, 21));
`);
    expect(d?.code).toBe("NT2001");
    expect(d?.message).toBe("'nope' is not defined");
  });

  /*
   * A GENERIC declaration keeps its own, more precise message — it is not merely
   * unsupported as a value, it has no single type to be a value OF. This pins that the new
   * fallback runs after that check and does not swallow it (a generic is registered with
   * the monomorphizer, never in the signature table, so it would otherwise have fallen
   * through to plain "not defined" again).
   */
  test("a generic declaration keeps its specialize-at-the-call-site message", () => {
    const d = refusal(`
function id<T>(x: T): T { return x; }
function apply(f: (x: number) => number, v: number): number { return f(v); }
console.log(apply(id, 21));
`);
    expect(d?.code).toBe("NT1013"); // the GENERIC bucket, not the closure one
    expect(d?.message).toContain("specialized at its CALL site");
  });
});
