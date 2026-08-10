/*
 * `new Map()` / `new Set()` WITH NO TYPE ARGUMENT — take the type from context.
 *
 * `Checker.infer`'s `NewExpr` case read
 *
 *     let k = e.typeArgs?.[0] ?? "string", v = e.typeArgs?.[1] ?? "number";   // Map
 *     let el = e.typeArgs?.[0] ?? "string";                                   // Set
 *
 * so a bare `new Map()` was `Map<string, number>` and a bare `new Set()` was
 * `Set<string>` — a GUESS, and one that ignored the annotation standing right next to it:
 *
 *     const m: Map<string, string> = new Map();
 *     // NT2001: 'm' declared Map<string,string> but initialized with Map<string,number>
 *
 * That is the same shape the empty ARRAY literal already handles the other way —
 * `const xs: string[] = []` types the literal from its context rather than guessing an
 * element type — and it is TypeScript's rule for the constructor too: an argument-less
 * `new Map()` in a contextually typed position takes the contextual type.
 *
 * The defaults stay for an UNCONTEXTUALIZED `new Map()`, so nothing that compiled before
 * changes; this only fills in where the checker previously refused.
 *
 * WHY IT MATTERS HERE. Five of the compiler's own functions are refused by this and by
 * nothing else, in the parameter-default spelling `= new Map()`:
 * `src/modules.ts`'s `moduleOrder` and `Renamer`'s constructor among them.
 *
 * PROVENANCE. The rule is TypeScript's contextual-typing rule for `new` expressions
 * (`tests/cases/conformance/types/contextualTypes/`); there is no `microsoft/TypeScript`
 * checkout on this machine, so the cases are derived from it rather than mined. Every
 * runtime assertion is differential against node, which is the oracle.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic((err as NTError).diag, source);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

// NOTE: every fixture below reads only the RESULT of `.set`/`.add`, never the receiver
// afterwards. nativets `Map`/`Set` are persistent (docs/divergences.md, "Immutable
// Map/Set (B2)"), so `m.size` after `m.set(…)` is a deliberate divergence from node and
// would be testing that, not this.
describe("1 — an annotation is the context", () => {
  test("`const m: Map<string, string> = new Map()`", async () => {
    await expectNode(`
const m: Map<string, string> = new Map();
const n = m.set("a", "b");
console.log(n.size, n.get("a") ?? "-");
`);
  });

  test("`const s: Set<number> = new Set()`", async () => {
    await expectNode(`
const s: Set<number> = new Set();
const t = s.add(7);
console.log(t.size, t.has(7) ? "y" : "n");
`);
  });
});

describe("2 — a parameter default is the context", () => {
  // `src/modules.ts`'s `Renamer` constructor and `moduleOrder`, minimized.
  test("`function f(refs: Map<string, string> = new Map())`", async () => {
    await expectNode(`
function f(refs: Map<string, string> = new Map()): string {
  return refs.size + ":" + (refs.get("k") ?? "-");
}
const given: Map<string, string> = new Map();
console.log(f(), f(given.set("k", "v")));
`);
  });

  // A NON-scalar value type — the shape `moduleOrder` actually has (`Map<string, T[]>`).
  test("a Map whose values are arrays", async () => {
    await expectNode(`
function f(deps: Map<string, string[]> = new Map()): number { return deps.size; }
const d: Map<string, string[]> = new Map();
console.log(f(), f(d.set("a", ["b"])));
`);
  });
});

describe("3 — the guess survives where there is no context", () => {
  // Unchanged behavior: with nothing to take a type from, `new Map()` is still
  // `Map<string, number>` and `new Set()` is still `Set<string>`.
  test("a bare `new Map()` / `new Set()` keeps its defaults", async () => {
    await expectNode(`
const m = new Map();
const s = new Set();
console.log(m.set("a", 1).get("a") ?? -1, s.add("x").has("x") ? "y" : "n");
`);
  });

  // An explicit type argument still WINS over the context, and a conflict is still an
  // error — the context fills a blank, it does not override what was written.
  test("REFUSED: an explicit type argument that disagrees with the annotation", () => {
    expectRejected(`
const m: Map<string, string> = new Map<string, number>();
console.log(m.size);
`, "NT2001", "Map<string,string>");
  });
});
