/*
 * SINGLE OWNER — src/ must not depend on bun's mutating `Map.set`/`Set.add`.
 *
 * THE BUG THIS EXISTS TO CATCH. `Map.prototype.set` returns the RECEIVER under node
 * (test262 `built-ins/Map/prototype/set/returns-this.js`), so it mutates and every holder
 * of the map sees the update. A nativets `Map` is PERSISTENT: `.set` answers a NEW map and
 * leaves the receiver alone (docs/divergences.md §A). Both compile, both exit 0, and they
 * print different things:
 *
 *     let m = new Map<string, number>();
 *     const alias = m;
 *     m = m.set("a", 1);
 *     console.log(alias.size, m.size);   // node: `1 1`   nativets: `0 1`
 *
 * (Measured, both at exit 0.)
 *
 * So a collection that is handed to SOMEONE ELSE and is LATER rebound through `.set`/
 * `.add`/`.delete` means two different things in the two engines. `src/` runs under bun at
 * stage 0, which is why no other instrument in this tree can see it: the suite is green
 * BECAUSE of bun. It would miscompile the moment this compiler compiles itself.
 *
 * WHY THE CHECKER CANNOT DO THIS INSTEAD, and why the rule lives in a test. NT1606's rule
 * is "the persistent result is DISCARDED" (`rejectDiscardedMutator`) — a guaranteed no-op
 * in every execution, so it has no false-positive direction. Here the result is KEPT and
 * assigned; the question is whether anyone ELSE still holds the old collection, which is
 * an ALIASING question. Discarded-result and aliasing are orthogonal, and only aliasing
 * matters for self-hosted correctness. Chasing aliases through calls, fields and returns
 * is exactly the unsound direction `rejectDiscardedMutator` documents itself as refusing
 * to take, so this stays a source-level lint over a tree we control rather than a
 * diagnostic over programs we do not.
 *
 * WHAT COUNTS AS AN ESCAPE — deliberately only the RETAINING ones, because the first cut
 * of this flagged every bare call argument and two of its three hits were the CORRECT
 * idiom:
 *   - `out = f(…, out)`             thread-and-return: the callee's answer is rebound, so
 *                                   there is never a second live handle.
 *   - `checkRefs(fn, defs, refs)`   a read-only callee that keeps nothing.
 *   - `new Map(x)` / `new Set(x)`   COPY constructors — a fresh collection, no handle kept.
 * What is left is the shape that actually bites: `new C(X)`, `o.f = X`, `{ f: X }` and
 * `const y = X`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "../src/parser.ts";

const SRC = resolve(import.meta.dir, "..", "src");
const MUTATORS = new Set(["set", "add", "delete"]);

interface Ev { kind: "escape" | "rebind"; name: string; how: string }
export interface Finding { scope: "local" | "field"; file: string; where: string; name: string; escape: string; rebind: string }

/** `this.f` → `"this.f"`, `x` → `"x"`, anything else → `undefined` (not a tracked path). */
function pathOf(e: unknown): string | undefined {
  const n = e as Record<string, unknown> | null;
  if (!n || typeof n !== "object") return undefined;
  if (n.kind === "Identifier") return n.name as string;
  if (n.kind === "MemberExpr") {
    const o = n.object as Record<string, unknown> | undefined;
    if (o?.kind === "Identifier" && o.name === "this") return `this.${String(n.property)}`;
  }
  return undefined;
}

/** Depth-first in source order, recording retaining escapes and self-rebinds. */
function scan(node: unknown, out: Ev[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) scan(x, out); return; }
  const n = node as Record<string, unknown>;
  const kind = n.kind as string | undefined;

  if (kind === "AssignExpr" && n.op === "=" && typeof n.target === "string") {
    const v = n.value as Record<string, unknown> | undefined;
    if (v?.kind === "CallExpr") {
      const c = v.callee as Record<string, unknown> | undefined;
      if (c?.kind === "MemberExpr" && MUTATORS.has(c.property as string) && pathOf(c.object) === n.target) {
        scan(v.args, out);
        out.push({ kind: "rebind", name: n.target, how: `${n.target} = ${n.target}.${String(c.property)}(…)` });
        return;
      }
      scan(v, out); // `X = f(…, X, …)` — thread-and-return, not a lasting second handle
      return;
    }
  }

  if (kind === "FieldAssign") {
    const self = pathOf(n.object) === "this" ? `this.${String(n.field)}` : undefined;
    const v = n.value as Record<string, unknown> | undefined;
    if (self !== undefined && v?.kind === "CallExpr") {
      const c = v.callee as Record<string, unknown> | undefined;
      if (c?.kind === "MemberExpr" && MUTATORS.has(c.property as string) && pathOf(c.object) === self) {
        scan(v.args, out);
        out.push({ kind: "rebind", name: self, how: `${self} = ${self}.${String(c.property)}(…)` });
        return;
      }
    }
    const src = pathOf(n.value);
    if (src !== undefined) {
      out.push({ kind: "escape", name: src, how: `stored into \`${String(pathOf(n.object) ?? "?")}.${String(n.field)}\`` });
      scan(n.object, out);
      return;
    }
  }

  if (kind === "NewExpr") {
    const callee = String(n.callee);
    // The one `new` that keeps no handle: a copy constructor reads its argument once.
    if (callee === "Map" || callee === "Set") { scan(n.args, out); return; }
    for (const a of (n.args as unknown[]) ?? []) {
      const p = pathOf(a);
      if (p !== undefined) out.push({ kind: "escape", name: p, how: `captured by \`new ${callee}(…)\`` });
      else scan(a, out);
    }
    return;
  }

  if (kind === "ObjectLiteral") {
    for (const pr of (n.props as unknown[]) ?? []) {
      const p = pr as Record<string, unknown>;
      const src = pathOf(p?.value);
      if (src !== undefined) out.push({ kind: "escape", name: src, how: `put in an object literal (\`${String(p.key)}\`)` });
      else scan(pr, out);
    }
    return;
  }

  if (kind === "VarDecl") {
    for (const d of (n.decls as unknown[]) ?? []) {
      const dd = d as Record<string, unknown>;
      const src = pathOf(dd?.init);
      if (src !== undefined) out.push({ kind: "escape", name: src, how: `aliased by \`${String(dd.name)}\`` });
      else scan(dd?.init, out);
    }
    return;
  }

  for (const k of Object.keys(n)) {
    if (k === "ty" || k === "loc" || k === "annot" || k === "returnAnnot") continue;
    scan(n[k], out);
  }
}

/**
 * Pair escapes with rebinds. `ordered` is the difference between the two frames:
 * a LOCAL is only at risk when the escape happens BEFORE the rebind (`check`'s
 * `importedFrom` is filled and only THEN handed to the Checker, which is correct and must
 * not be flagged), while a FIELD's escape and rebind routinely sit in different methods,
 * so any pairing counts.
 */
function pair(evs: Ev[], ordered: boolean): { name: string; escape: string; rebind: string }[] {
  const escaped = new Map<string, string>();
  const rebinds = new Map<string, string>();
  const seen = new Set<string>();
  const hits: { name: string; escape: string; rebind: string }[] = [];
  for (const e of evs) {
    if (e.kind === "escape") {
      if (!escaped.has(e.name)) escaped.set(e.name, e.how);
      if (!ordered && rebinds.has(e.name) && !seen.has(e.name)) {
        seen.add(e.name);
        hits.push({ name: e.name, escape: e.how, rebind: rebinds.get(e.name)! });
      }
    } else {
      if (!rebinds.has(e.name)) rebinds.set(e.name, e.how);
      if (escaped.has(e.name) && !seen.has(e.name)) {
        seen.add(e.name);
        hits.push({ name: e.name, escape: escaped.get(e.name)!, rebind: e.how });
      }
    }
  }
  return hits;
}

export function aliasedRebinds(): Finding[] {
  const out: Finding[] = [];
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
  for (const file of files) {
    const path = resolve(SRC, file);
    const prog = parse(readFileSync(path, "utf8"), { file: path });
    const top: unknown[] = [];
    const perFn: { name: string; body: unknown }[] = [];
    const byClass = new Map<string, unknown[]>();
    for (const s of prog.body as unknown as Record<string, unknown>[]) {
      if (s.kind !== "FuncDecl") { top.push(s); continue; }
      const name = String(s.name);
      perFn.push({ name, body: s.body ?? s.stmts });
      const dot = name.indexOf(".");
      if (dot > 0) {
        const cls = name.slice(0, dot);
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls)!.push(s.body ?? s.stmts);
      }
    }
    perFn.push({ name: "(top level)", body: top });

    for (const fr of perFn) {
      const evs: Ev[] = [];
      scan(fr.body, evs);
      for (const h of pair(evs, true)) {
        if (h.name.startsWith("this.")) continue; // covered module-wide below
        out.push({ scope: "local", file, where: fr.name, ...h });
      }
    }
    for (const [cls, bodies] of byClass) {
      const evs: Ev[] = [];
      scan(bodies, evs);
      for (const h of pair(evs, false)) {
        if (!h.name.startsWith("this.")) continue;
        out.push({ scope: "field", file, where: `class ${cls}`, ...h });
      }
    }
  }
  return out;
}

const show = (f: Finding): string => `${f.file} ${f.where}: \`${f.name}\` — ${f.escape}, then ${f.rebind}`;

describe("single-owner collections in src/", () => {
  /*
   * The instrument has to be shown to WORK before its zero means anything — this repo's
   * oldest failure mode is a measurement that quietly covers nothing (16 syntax errors made
   * tsc report zero TYPE errors for the life of the project; see test/tsc.test.ts).
   */
  test("the detector fires on the shape it exists to catch", () => {
    const evs: Ev[] = [];
    scan(parse(`
      class Holder { constructor(public t: Map<string, number>) {} }
      function go(): number {
        let m = new Map<string, number>();
        const h = new Holder(m);
        m = m.set("a", 1);
        return h.t.size;
      }
    `).body, evs);
    const hits = pair(evs, true);
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe("m");
  });

  test("the detector does NOT fire on the correct idioms", () => {
    const evs: Ev[] = [];
    scan(parse(`
      class Holder { constructor(public t: Map<string, number>) {} }
      function thread(xs: string[], acc: Set<string>): Set<string> {
        let out = acc;
        for (const x of xs) out = out.add(x);
        return out;
      }
      function fillThenHand(): number {
        let m = new Map<string, number>();
        m = m.set("a", 1);          // filled FIRST…
        const h = new Holder(m);    // …and only then handed over — correct
        return h.t.size;
      }
      function copied(s: Set<string>): number {
        let t = new Set(s);         // a COPY constructor keeps no handle
        t = t.add("x");
        return t.size;
      }
    `).body, evs);
    expect(pair(evs, true)).toEqual([]);
  });

  /*
   * THE CENSUS. Every remaining site, named — a correct partial with an honest count beats
   * a silent sweep, and an empty list here would be a lie by omission.
   *
   * All three are `Parser` fields deliberately SHARED with a sub-parser ("Shared by
   * reference so a tag the sub-parser discovers is carried back too", `hoistTypeDecls`),
   * and that carry-back is exactly what a persistent rebind severs. They are LATENT rather
   * than live: `Parser.hoistTypeDecls` (NT2001) and `Parser.resolveCycle` (NT1606) are both
   * refused by the checker today for unrelated reasons, so nothing compiles them at all —
   * but each goes silently wrong the day its function unblocks. src/parser.ts is another
   * lane's file; this list is the handoff, not a licence to leave them.
   */
  const KNOWN = [
    "parser.ts class Parser: `this.cycleNames` — stored into `sub.cycleNames`, then this.cycleNames = this.cycleNames.add(…)",
    "parser.ts class Parser: `this.recTypes` — stored into `sub.recTypes`, then this.recTypes = this.recTypes.set(…)",
    "parser.ts class Parser: `this.mutableRecords` — stored into `sub.mutableRecords`, then this.mutableRecords = this.mutableRecords.add(…)",
  ];

  test("no LOCAL is handed to a retaining holder and then rebound", () => {
    // The one that mattered: `check` built its signature table into a LOCAL, handed it to
    // `new Checker(…)`, and then rebound the local — leaving `Checker.functions` EMPTY for
    // the whole check under this compiler's own semantics, so no call in any program would
    // resolve. Fixed by giving the table ONE owner (the Checker).
    expect(aliasedRebinds().filter((f) => f.scope === "local").map(show)).toEqual([]);
  });

  test("the FIELD census is exactly the known, documented set", () => {
    expect(aliasedRebinds().filter((f) => f.scope === "field").map(show).sort()).toEqual([...KNOWN].sort());
  });
});
