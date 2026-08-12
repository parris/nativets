/*
 * THE TYPED READ SCAN vs THE REFLECTIVE ONE — an equivalence proof by corpus.
 *
 * `daReads` walked `Object.values(node)` over an `unknown`. That is uncompilable in this
 * subset (`for (const x of node)` over `unknown` is NT1011) and it was the single shared
 * blocker of SIX modules — checker, codegen, ownership, cli, coverage and driver all
 * stopped on that one line. The replacement is a pair of typed switches with no `default:`
 * arm, so tsc enforces that every `Expr`/`Stmt` kind is handled.
 *
 * TSC CANNOT CHECK THE PART THAT MATTERS. Exhaustiveness catches a missing KIND; it says
 * nothing about a missing CHILD inside a kind — and `daReads` feeds definite assignment,
 * where a missed read means a use-before-assign goes unrefused. That is a wrong answer,
 * not a lost diagnostic, and it is exactly what the reflective walker's comment was
 * defending against when it said a hand-written switch "would go stale".
 *
 * So the reflective walker is KEPT, as an oracle, and this runs both over every `.ts`
 * fixture in the corpus — every expression of every statement of every parsed program —
 * and asserts they find the same names with the same locations. A child dropped from one
 * arm shows up here as a corpus mismatch naming the file.
 *
 * The oracle is the thing being replaced, which is the point: it is known-correct by
 * construction (it visits every own property, so it cannot miss a child), and it is the
 * only thing that can check the typed version arm by arm.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { parse } from "../src/parser.ts";
import { daReadsTypedForTest } from "../src/checker.ts";

/*
 * THE ORACLE — the reflective walker that used to be `daReads` in src/checker.ts, moved
 * here verbatim when the typed one replaced it.
 *
 * It lives in `test/` because `test/` is outside the self-hosting surface and `src/` is
 * not: `Object.values` over an `unknown` is precisely what could not be compiled. Keeping
 * it here costs nothing and keeps the equivalence claim runnable — delete it and the
 * assertion below becomes a tautology.
 *
 * It is known-correct BY CONSTRUCTION, which is what makes it a usable oracle: it visits
 * every own property, so it cannot miss a child. That is the one property the typed
 * version has to be checked against, since tsc can only prove it handles every KIND.
 */
type Rec = Map<string, { line: number; col: number } | undefined>;
function daReadsReflective(node: unknown, out: Rec): void {
  if (Array.isArray(node)) { for (const x of node) daReadsReflective(x, out); return; }
  if (node === null || typeof node !== "object") return;
  const n = node as { kind?: string; name?: unknown; op?: unknown; target?: unknown; loc?: { line: number; col: number } };
  if (n.kind === "Identifier" && typeof n.name === "string") {
    if (!out.has(n.name)) out.set(n.name, n.loc);
    return;
  }
  if (typeof n.target === "string" &&
      (n.kind === "UpdateExpr" || (n.kind === "AssignExpr" && n.op !== "="))) {
    if (!out.has(n.target)) out.set(n.target, n.loc);
  }
  for (const v of Object.values(node)) daReadsReflective(v, out);
}

function daReadsForTest(s: unknown): Rec {
  const out: Rec = new Map();
  daReadsReflective(s, out);
  return out;
}

const ROOT = new URL("..", import.meta.url).pathname;

/** Every `.ts` file under a directory, one level of nesting deep. */
function fixtureFiles(dir: string, limit: number): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    if (out.length >= limit) break;
    const full = `${dir}/${name}`;
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) { for (const f of fixtureFiles(full, limit - out.length)) out.push(f); continue; }
    if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `name@line:col` for every read, sorted — a comparable rendering of one walker's answer. */
function render(m: Map<string, { line: number; col: number } | undefined>): string[] {
  return [...m.entries()]
    .map(([k, v]) => `${k}@${v === undefined ? "-" : `${v.line}:${v.col}`}`)
    .sort();
}

describe("the typed read scan agrees with the reflective one it replaces", () => {
  const corpus = [
    ...fixtureFiles(`${ROOT}test/fixtures`, 400),
    ...fixtureFiles(`${ROOT}src`, 40),
  ];

  test("the corpus is not empty — a vacuous pass here would prove nothing", () => {
    // This project's recurring failure mode: a sweep that measures zero programs and
    // reports success. If the fixture layout moves, this fails instead of going quiet.
    expect(corpus.length).toBeGreaterThan(20);
  });

  test("every expression in every corpus program yields identical reads", () => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const file of corpus) {
      let prog;
      try { prog = parse(readFileSync(file, "utf8"), { file }); } catch { continue; } // a refusal fixture
      for (const s of prog.body) {
        const a = render(daReadsForTest(s));
        const b = render(daReadsTypedForTest(s));
        compared++;
        if (a.join("|") !== b.join("|")) {
          mismatches.push(`${file.slice(ROOT.length)}\n  reflective: ${a.join(" ")}\n  typed:      ${b.join(" ")}`);
        }
      }
    }
    expect(mismatches.join("\n\n")).toBe("");
    // Statements, not files: a per-file count would hide a program that parsed to nothing.
    expect(compared).toBeGreaterThan(200);
  });
});
