/*
 * DISCARDED PERSISTENT MUTATORS in src/ — a census, for the class NT1606 refuses but the
 * blocker metric cannot count.
 *
 * THE RULE. A nativets `Map`/`Set` is PERSISTENT (docs/divergences.md §A): `.add`/`.set`/
 * `.delete` answer a NEW collection and leave the receiver alone. So a call in STATEMENT
 * position, whose result nothing reads, is a guaranteed no-op under this compiler's own
 * semantics — while under bun, where `src/` runs today, the same line mutates in place and
 * works. Every site below is correct under node and dead under nativets.
 *
 * WHY A TEST AND NOT JUST THE METRIC. `test/blocker-metric.ts` reports the FIRST blocker per
 * function, so a second refusal in the same body is invisible until the first clears. Three
 * of these sites sat in `Parser.resolveCycle` behind a `deferred.push` on an earlier line
 * and could not be seen at all — the count moved by zero when they were fixed. Masking also
 * hides sites a lane ADDS. A census that walks the AST directly is the only instrument that
 * sees the whole class at once, which is the same argument `test/single-owner.test.ts` makes
 * for its (orthogonal) aliasing lint, and this file follows its shape deliberately.
 *
 * THE THREE FIXES, because they are NOT interchangeable and picking wrong is a silent bug:
 *
 *   1. REBIND, when the receiver is a local or a `@@mutable` field that nobody else holds:
 *          this.hits = this.hits.add(name)
 *      Identical under node, where `.add`/`.set` return the RECEIVER, so it self-assigns.
 *
 *   2. RETURN, when the receiver is a PARAMETER the caller reads back:
 *          function f(s, out: Set<string>): Set<string> { … return next; }   // `acc = f(s, acc)`
 *      Rebinding a parameter instead COMPILES and loses the write — the caller never sees
 *      it. That is the trap; NT1606's hint has recommended it in as many words before.
 *
 *   3. REBUILD or RESTORE, for `.delete` and `.clear`, which have NO rebinding spelling:
 *      node's `.delete` returns a BOOLEAN and its `.clear` returns `undefined`, so
 *      `x = x.delete(k)` leaves `x === true` under bun (measured). Filter the survivors
 *      into a fresh collection, or assign a snapshot back wholesale.
 *
 * WHAT THIS DOES NOT SEE. Receiver TYPES are not resolved — the scan is syntactic, so a
 * `.set`/`.add`/`.delete`/`.clear` on something that is not a Map or a Set would be counted
 * too. That direction is safe (it over-reports into a pinned list a human reads) and today
 * the list contains no such entry. Array mutators (`.push`/`.pop`/`arr[i] = v`) and object
 * field writes are the OTHER two thirds of NT1606 and are deliberately out of scope here:
 * they are different problems with costs two orders of magnitude apart.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "../src/parser.ts";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

const SRC = resolve(import.meta.dir, "..", "src");

/** The persistent-collection mutators. `.push`/`.pop` are the ARRAY class — not this one. */
const MUTATORS = new Set(["add", "set", "delete", "clear"]);

export interface Site { file: string; fn: string; shape: string }

/** `x` → `"x"`, `this.f` → `"this.f"`, `a.b.c` → `"a.b.c"`; anything else → a kind tag. */
function recvText(e: unknown): string {
  const n = e as Record<string, unknown> | null;
  if (!n || typeof n !== "object") return "?";
  if (n.kind === "Identifier") return String(n.name);
  if (n.kind === "MemberExpr") return `${recvText(n.object)}.${String(n.property)}`;
  if (n.kind === "IndexExpr") return `${recvText(n.object)}[…]`;
  if (n.kind === "CallExpr") return `${recvText(n.callee)}(…)`;
  return `<${String(n.kind)}>`;
}

/** This expression IS a call on one of the persistent mutators. */
function mutatorCall(expr: unknown): string | undefined {
  const e = expr as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || e.kind !== "CallExpr") return undefined;
  const c = e.callee as Record<string, unknown> | undefined;
  if (!c || c.kind !== "MemberExpr" || !MUTATORS.has(String(c.property))) return undefined;
  return `${recvText(c.object)}.${String(c.property)}(…)`;
}

/**
 * Every mutator call whose result is discarded, given that `expr`'s OWN value is
 * discarded — a list, because one dropped expression can hold several.
 *
 * IT LOOKS THROUGH THE VALUE-DROPPING WRAPPERS, and that is not a refinement: the first
 * cut matched only a bare `CallExpr`, and `src/parser.ts::parseExport` hid a live site
 * from it for the life of the file by spelling the same discard as a TERNARY —
 *
 *     c.typeOnly ? this.exportTypes.add(c.name) : this.exportValues.set(c.alias, c.name);
 *
 * which is `.add`/`.set` in statement position wearing one layer of syntax. Measured on
 * the exact shape: node prints `1 1`, nativets prints `0 0`, and BOTH exit 0. So the
 * detector's own blind spot was the difference between a census that holds the class and
 * one that reports zero while the class is present — this repo's oldest failure mode.
 *
 * The four wrappers are exactly the ones that PROPAGATE the drop. A ternary drops both
 * arms; a comma drops every element; `&&`/`||`/`??` drop the right operand (the left is a
 * test, and a mutator there is read for its truthiness, which is a different bug). Nothing
 * else is unwrapped — an argument, a receiver or an operand of `+` is a value somebody
 * READS, and `x = s.add(k)` is the correct fix, not an instance of the defect.
 */
function discardedMutators(expr: unknown): string[] {
  const direct = mutatorCall(expr);
  if (direct !== undefined) return [direct];
  const e = expr as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return [];
  if (e.kind === "ConditionalExpr") return [...discardedMutators(e.consequent), ...discardedMutators(e.alternate)];
  if (e.kind === "SequenceExpr") return (e.exprs as unknown[]).flatMap(discardedMutators);
  if (e.kind === "LogicalExpr") return discardedMutators(e.right);
  return [];
}

export function census(): Site[] {
  const out: Site[] = [];
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
  for (const file of files) {
    const path = resolve(SRC, file);
    const prog = parse(readFileSync(path, "utf8"), { file: path });
    let fn = "(top level)";

    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown>;

      if (n.kind === "FuncDecl") {
        const prev = fn; fn = String(n.name);
        walk(n.body); fn = prev; return;
      }
      // Statement position: the value is dropped on the floor.
      if (n.kind === "ExprStmt") {
        for (const s of discardedMutators(n.expr)) out.push({ file, fn, shape: s });
      }
      // An arrow with an EXPRESSION body is the same discard whenever the arrow is a void
      // callback — `xs.forEach((x) => seen.add(x))` is exactly the shape, one level in.
      if (n.kind === "ArrowFunction" && n.exprBody === true) {
        for (const s of discardedMutators(n.body)) out.push({ file, fn, shape: s });
      }
      for (const k of Object.keys(n)) {
        if (k === "ty" || k === "loc" || k === "annot" || k === "returnAnnot") continue;
        walk(n[k]);
      }
    };
    walk(prog.body);
  }
  return out;
}

/** Line numbers are deliberately NOT pinned — they churn on every edit above them, and the
 *  thing worth freezing is WHICH receiver in WHICH function, not where it sits today. */
const show = (s: Site): string => `${s.file} ${s.fn}: ${s.shape}`;

describe("discarded persistent mutators in src/", () => {
  /*
   * The detector has to be shown to WORK before its census means anything — this repo's
   * oldest failure mode is an instrument that quietly covers nothing (16 syntax errors made
   * tsc report zero TYPE errors for the life of the project; see test/tsc.test.ts).
   */
  test("the detector fires on a discarded .add/.set/.delete/.clear", () => {
    const evs: Site[] = [];
    const prog = parse(`
      function go(out: Set<string>, m: Map<string, number>): number {
        out.add("a");
        m.set("k", 1);
        out.delete("a");
        m.clear();
        return m.size;
      }
    `);
    let fn = "?";
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown>;
      if (n.kind === "FuncDecl") { fn = String(n.name); walk(n.body); return; }
      if (n.kind === "ExprStmt") {
        for (const s of discardedMutators(n.expr)) evs.push({ file: "x.ts", fn, shape: s });
      }
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(prog.body);
    expect(evs.map((e) => e.shape)).toEqual([
      `out.add(…)`, `m.set(…)`, `out.delete(…)`, `m.clear(…)`,
    ]);
  });

  /*
   * The blind spot that let a live site sit in `src/parser.ts` unseen. Each of these is
   * `.add`/`.set` in STATEMENT position with one layer of syntax on top, and the value is
   * dropped just as flatly as a bare call's. Compiled and measured on the ternary shape:
   * node prints `1 1` where nativets prints `0 0`, both exit 0 — a silent wrong answer,
   * not a refusal, which is why the detector has to reach it rather than the checker.
   */
  test("the detector looks through a ternary, a comma and a short-circuit", () => {
    const evs: string[] = [];
    const prog = parse(`
      function go(a: Set<string>, b: Set<string>, m: Map<string, number>, t: boolean): number {
        t ? a.add("x") : b.add("y");
        (a.add("p"), m.set("q", 1));  // a BARE comma is NT0001 here; parenthesized parses
        t && a.add("s");
        return m.size;
      }
    `);
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown>;
      if (n.kind === "ExprStmt") for (const s of discardedMutators(n.expr)) evs.push(s);
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(prog.body);
    expect(evs).toEqual([`a.add(…)`, `b.add(…)`, `a.add(…)`, `m.set(…)`, `a.add(…)`]);
  });

  /*
   * The LEFT of `&&`/`||`/`??` is deliberately NOT unwrapped: its value is READ (as the
   * test), so it is a different defect with a different fix, and reporting it here would
   * send a reader to rebind a call whose result the program already depends on.
   */
  test("the detector does not fire on a mutator whose value is read", () => {
    const evs: string[] = [];
    const prog = parse(`
      function go(a: Set<string>, m: Map<string, number>): number {
        a.add("x") && m.set("k", 1);
        const b = a.add("y");
        return b.size + m.size;
      }
    `);
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown>;
      if (n.kind === "ExprStmt") for (const s of discardedMutators(n.expr)) evs.push(s);
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(prog.body);
    // Only the RIGHT operand of the `&&`; the left is the test, and the `const` is a read.
    expect(evs).toEqual([`m.set(…)`]);
  });

  test("the detector does NOT fire on any of the three correct fixes", () => {
    // 1. REBIND a local / an owned field. 2. RETURN, for a parameter the caller reads back.
    // 3. REBUILD, the only route for `.delete`/`.clear`.
    const sites: Site[] = [];
    const prog = parse(`
      //@@mutable
      class S {
        hits = new Set<string>();
        note(n: string): void { this.hits = this.hits.add(n); }
        reset(): void { this.hits = new Set<string>(); }
      }
      function thread(xs: string[], out: Set<string>): Set<string> {
        let next = out;
        for (const x of xs) next = next.add(x);
        return next;
      }
      function drop(all: Set<string>, keep: Set<string>): Set<string> {
        let out = all;
        out = new Set([...out].filter((n) => keep.has(n)));
        return out;
      }
    `);
    let fn = "?";
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const n = node as Record<string, unknown>;
      if (n.kind === "FuncDecl") { fn = String(n.name); walk(n.body); return; }
      if (n.kind === "ExprStmt") {
        for (const s of discardedMutators(n.expr)) sites.push({ file: "x.ts", fn, shape: s });
      }
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(prog.body);
    expect(sites).toEqual([]);
  });

  /*
   * THE CENSUS. Not zero, and the remainder is not a to-do list of equal items — it splits
   * by WHICH of the three fixes each site needs, and the second group is an order of
   * magnitude more work than the first.
   *
   * CLEARED so far (each verified byte-identical under node and nativets on its exact shape):
   *   checker.ts  Scope.lookup / check      `this.hits` — rebind, and a fresh Set for `.clear()`
   *   checker.ts  Checker.assignable        `seen` — rebind; the set's only consumer is the
   *                                         recursive call that takes it as an ARGUMENT
   *   checker.ts  daMerge                   `out.delete` — rebuilt by filtering
   *   checker.ts  collectBlockLocals        returns the extended set; both callers thread a local
   *   parser.ts   Parser.resolveCycle       `cycleNames`/`cyclicTypes` rebuilt, `recTypes` restored
 *   coverage.ts coverage                  `found` — the ARROW that wrote it (`flag`) became the
 *                                         top-level `bumpBlocker(found, …) -> Map`, so the
 *                                         rebind happens in the owner's frame, not a capture
   *   codegen.ts  ModuleGen.fnValue         `this.fnValues` — rebind on a `@@mutable` field (fix 1)
   *   codegen.ts  FnGen.collectBoundNames   returns the extended set (fix 2); both callers thread
   *                                         a local, and `freshenHofArrow` is exactly the caller
   *                                         that READS THE PARAMETER BACK, so a rebind there
   *                                         would have been the silent lost update
   *   codegen.ts  FnGen.childRenameMap      `.delete` has no rebinding spelling (fix 3) — the
   *                                         survivors are filtered into a fresh Map
   *
   * WHAT IS LEFT, and why it is not the same job. Almost every remaining entry writes to a
   * collection that is a PARAMETER of the function above it — `collectIdents(e, out)`,
   * `collectAssigned(e, direct, closure, …)`, `escapingWritesExpr(e, bound, out)`. Fixing
   * one means threading a return value through its whole mutually-recursive family (33 call
   * sites for `collectIdents` alone), because rebinding the parameter instead is the LOST
   * UPDATE this file's header warns about. That is a restructure, not a transcription, and
   * it belongs to a lane that takes one family at a time.
   *
   * The rest are blocked by a DIFFERENT class rather than by this one:
   *   modules.ts  moduleOrder     the collections are closure-captured locals written from
   *                               inside arrows, so a rebind is an escaping write (NT1031)
   *   checker.ts  alphaRenameShadows  `cur` is an ARRAY ELEMENT (`scopes[scopes.length-1]`),
   *                               so the write-back is an array mutation, not a collection one
   */
  const KNOWN: string[] = [
    "checker.ts addCaptured: closure.add(…)",
    "checker.ts alphaRenameShadows: cur.set(…)",
    "checker.ts alphaRenameShadows: cur.set(…)",
    "checker.ts alphaRenameShadows: used.add(…)",
    "checker.ts alphaRenameShadows: used.add(…)",
    "checker.ts checkDefiniteAssignment: seen.add(…)",
    "checker.ts collectAssigned: <ConditionalExpr>.add(…)",
    "checker.ts collectAssigned: <ConditionalExpr>.add(…)",
    "checker.ts collectIdents: out.add(…)",
    "checker.ts collectIdents: out.add(…)",
    "checker.ts collectIdents: out.add(…)",
    "checker.ts daReads: out.set(…)",
    "checker.ts daReads: out.set(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.add(…)",
    "checker.ts daStmt: flow.clear(…)",
    "checker.ts daStmt: flow.clear(…)",
    "checker.ts daStmt: flow.clear(…)",
    "checker.ts daStmt: flow.clear(…)",
    "checker.ts daStmt: flow.delete(…)",
    "checker.ts daStmt: tracked.set(…)",
    "checker.ts noteEscapingWrite: out.set(…)",
    // THE TWO THAT CANNOT BE FIXED IN THE SUBSET, and the reason is worth carrying: both are
  // ACCUMULATOR PARAMETERS of a `Map`. Rebinding is not the fix (a parameter is a borrow;
  // `sources = sources.set(…)` is invisible to the caller — NT1608), and the per-parameter
  // `//@@mutable` opt-in is ARRAY-ONLY — marking one is NT1023, "'@@mutable' on parameter
  // 'sources', which is not an array (it is 'Map<string,string>')". So there is NO spelling
  // that works today, and a self-hosted compiler would discover every module and record
  // NONE of them. Closing these needs either a Map/Set parameter opt-in or `moduleOrder`
  // restructured to RETURN its accumulators.
  "modules.ts moduleOrder: deps.set(…)",
    "modules.ts moduleOrder: sources.set(…)",
    "ownership.ts Analyzer.expr: sites.add(…)",
    "ownership.ts Analyzer.expr: state.set(…)",
    "ownership.ts Analyzer.expr: state.set(…)",
    "ownership.ts Analyzer.stmt: state.set(…)",
    "ownership.ts Analyzer.stmt: state.set(…)",
    "ownership.ts Analyzer.stmt: this.borrowBindings.delete(…)",
    "ownership.ts analyzeOwnership: idx.add(…)",
    "ownership.ts analyzeOwnership: linear.delete(…)",
    "ownership.ts analyzeOwnership: linear.delete(…)",
    "ownership.ts analyzeOwnership: mutable.setterProps.add(…)",
    "ownership.ts analyzeOwnership: mutable.setters.add(…)",
    "ownership.ts analyzeOwnership: mutableArgProps.set(…)",
    "ownership.ts analyzeOwnership: mutableArgs.set(…)",
    "ownership.ts analyzeOwnership: set.add(…)",
    "ownership.ts assignInto: dst.clear(…)",
    "ownership.ts assignInto: dst.set(…)",
    "ownership.ts closureDecls: out.set(…)",
    "ownership.ts closureDecls: out.set(…)",
    "ownership.ts scanMentions: out.add(…)",
    "ownership.ts scanMentions: seen.add(…)",
    "ownership.ts shadowedNames: count.set(…)",
    "ownership.ts shadowedNames: seen.add(…)",
  ];

  test("src/parser.ts is clear of the whole class", () => {
    // The three that lived in `Parser.resolveCycle` were MASKED behind `deferred.push`, so
    // the blocker metric scored their removal as free. This assertion is what holds them.
    expect(census().filter((s) => s.file === "parser.ts").map(show)).toEqual([]);
  });

  test("src/codegen.ts is clear of the whole class", () => {
    // Same argument as parser.ts, and the arithmetic is starker: FIVE of these seven sites
    // lived in ONE function (`collectBoundNames`), which the blocker metric counts once. It
    // scored the whole family at a single unit, and would score their RETURN the same way.
    expect(census().filter((s) => s.file === "codegen.ts").map(show)).toEqual([]);
  });

  test("the census is exactly the known, documented set", () => {
    expect(census().map(show).sort()).toEqual([...KNOWN].sort());
  });
});

/*
 * FIX #2, COMPILED. The header above describes three fixes; NT1606's `rejectParamRebind`
 * hint recommends the second one in as many words —
 *
 *     "accumulate into a LOCAL seeded from the parameter and RETURN it:
 *      `let acc = out; acc = acc.add(…); return acc;` — then rebind at the CALL SITE"
 *
 * — and nothing had ever run it. A hint is a promise that a spelling works, and this tree
 * shipped sixteen that did not. So the advice is compiled here, verbatim, with node as the
 * oracle: same stdout, same exit code, through the real binary.
 *
 * IT MATTERS THAT THE LOCAL IS WHAT MOVES. `out = out.add(n)` on the parameter itself is
 * refused (`rejectParamRebind`), and correctly: a parameter is a borrow, so under nativets
 * the caller never sees the new set. Seeding a LOCAL from it and returning that is a
 * different program — the caller rebinds from the RETURN, which reaches it in both
 * languages. The two halves are asserted together below, because the rule is only honest if
 * the refusal has somewhere to go.
 *
 * BOTH DIRECTIONS, deliberately. Under bun `.add` mutates and returns the receiver, so a
 * threading mistake is INVISIBLE there — the accumulator would come out right anyway. The
 * compiled binary is the only place the threading is load-bearing, which is why every case
 * here goes through `compileAndRun` and none through a bare `parse`.
 *
 * `src/ownership.ts`'s `collectLinear` is the self-hosting instance, and its shape is the
 * last case: a recursive walk that threads the accumulator through its own child calls.
 */
describe("fix #2 (RETURN the accumulator) is a spelling that actually compiles", () => {
  /** node is the oracle: same stdout, same exit code. */
  async function same(source: string): Promise<void> {
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  }

  test("the hint's spelling, verbatim: `let acc = out; acc = acc.add(…); return acc;`", async () => {
    await same(
      'function collect(names: string[], out: Set<string>): Set<string> {\n' +
      '  let acc = out;\n' +
      '  for (const n of names) acc = acc.add(n);\n' +
      '  return acc;\n' +
      '}\n' +
      'let seen = new Set<string>();\n' +
      'seen = collect(["a", "b"], seen);\n' +
      'seen = collect(["b", "c"], seen);\n' +
      'console.log([...seen].join(","));\n' +
      'console.log(seen.size);\n',
    );
  });

  test("the same for a `Map` accumulator", async () => {
    await same(
      'function collect(names: string[], out: Map<string, number>): Map<string, number> {\n' +
      '  let acc = out;\n' +
      '  for (const n of names) acc = acc.set(n, n.length);\n' +
      '  return acc;\n' +
      '}\n' +
      'let seen = new Map<string, number>();\n' +
      'seen = collect(["a", "bb"], seen);\n' +
      'seen = collect(["ccc"], seen);\n' +
      'console.log([...seen.keys()].join(","));\n' +
      'console.log(seen.size);\n',
    );
  });

  /* The refusal the hint is attached to. Asserted next to the fix so the pair cannot drift:
   * a rule whose recommended escape stops compiling is worse than no rule. */
  test("...while rebinding the PARAMETER itself is still refused", () => {
    let diag: { code: string; message: string } | undefined;
    try {
      emitIR(
        'function collect(names: string[], out: Set<string>): Set<string> {\n' +
        '  for (const n of names) out = out.add(n);\n' +
        '  return out;\n' +
        '}\n' +
        'console.log(collect(["a"], new Set<string>()).size);\n',
      );
    } catch (e) {
      diag = (e as { diag?: { code: string; message: string } }).diag;
    }
    expect(diag?.code).toBe("NT1606");
    expect(diag?.message).toContain("is a PARAMETER");
  });

  /* `collectLinear`'s shape: a RECURSIVE walk that threads the accumulator through its own
   * child calls as well as through its loop. This is the case a rebind gets wrong twice
   * over, and the one where a threading slip is invisible under bun. */
  test("the recursive shape: the accumulator threads through child calls too", async () => {
    await same(
      'type Node = { name: string; kids: Node[] };\n' +
      'function walk(nodes: Node[], out: Set<string>): Set<string> {\n' +
      '  let acc = out;\n' +
      '  for (const n of nodes) {\n' +
      '    acc = acc.add(n.name);\n' +
      '    acc = walk(n.kids, acc);\n' +
      '  }\n' +
      '  return acc;\n' +
      '}\n' +
      'const tree: Node[] = [\n' +
      '  { name: "a", kids: [{ name: "b", kids: [] }, { name: "c", kids: [{ name: "d", kids: [] }] }] },\n' +
      '  { name: "e", kids: [] },\n' +
      '];\n' +
      'let names = new Set<string>();\n' +
      'names = walk(tree, names);\n' +
      'console.log([...names].join(","));\n' +
      'console.log(names.size);\n',
    );
  });
});
