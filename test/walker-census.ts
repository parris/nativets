/*
 * THE REFLECTIVE-WALKER CENSUS — an instrument, not a gate. `bun run test/walker-census.ts`
 *
 * A function taking `unknown` and recursing with `Object.values(node)` cannot be compiled
 * by this subset: `for (const x of node)` over `unknown` is NT1011, and after NT1002 was
 * cleared these became the single shared blocker of SIX modules (checker, codegen,
 * ownership, cli, coverage, driver all stop at `daReads`).
 *
 * They are reflective ON PURPOSE — `daReads`'s own comment says a hand-written switch
 * "would go stale, and a read missed HERE is a miscompile". That reasoning has an answer:
 * `walkExprChildren`/`walkStmtChildren` in src/ast.ts are typed, exhaustive, and CANNOT go
 * stale, because they have no `default:` arm and a missing case is a tsc error at the
 * function's return type. Retyping a walker onto them keeps the guarantee and changes the
 * mechanism.
 *
 * Two things make it more than a mechanical rewrite, and both are worth knowing before
 * starting: those walkers REBUILD every node (they are transformers, so traversal-only use
 * allocates a tree per visit), and an accumulator threaded through them cannot be a
 * captured `Map` — `Map.set` is PERSISTENT here and returns a new map, so the discarded
 * spelling silently does nothing (docs/divergences.md §A).
 */
import { readFileSync, readdirSync } from "node:fs";
const SRC = new URL("../src/", import.meta.url).pathname;
let total = 0;
for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort()) {
  const lines = readFileSync(`${SRC}/${f}`, "utf8").split("\n");
  const hits: string[] = [];
  lines.forEach((l, i) => {
    if (/^(export )?function \w+\([^)]*: unknown/.test(l) || /^\s*(const|private) \w+ = \([^)]*: unknown/.test(l)) {
      hits.push(`${i + 1}: ${l.trim().slice(0, 70)}`);
    }
  });
  if (hits.length) { console.log(`${f} — ${hits.length}`); for (const h of hits) console.log(`    ${h}`); total += hits.length; }
}
console.log(`\nTOTAL ${total} functions taking an \`unknown\` parameter`);
