/*
 * How DEEP is the self-hosting frontier? `bun run test/frontier-depth.ts`.
 *
 * Every other instrument here reports the FIRST blocker — per module (sh6,
 * selfhost-ratchet) or per function-then-aborting (the plain `check`). That is what a
 * compile actually hits, and it is the right thing to ratchet on, but it says nothing
 * about how many more are behind it. Measured 2026-08-11: fifteen blockers were cleared
 * in one session and the FIRST-blocker view moved every time, while the DEPTH stayed
 * flat — because there were 88 of them.
 *
 * This runs `check` in measurement mode over the LINKED program (so a module is judged
 * with its dependencies, as a real build sees it) and groups by NORMALIZED message, which
 * is what turns "88 problems" into "33 shapes, and three of them are most of it".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { linkProgram } from "../src/modules.ts";
import { check, type FnBlocker } from "../src/checker.ts";

// How many DISTINCT function-level blockers remain in the linked stage-1 program?
// The rung probe shows only the FIRST; this shows the whole set behind it.
const entry = resolve(new URL("../src/cli.ts", import.meta.url).pathname);
const blockers: FnBlocker[] = [];
try { check(linkProgram(readFileSync(entry, "utf8"), entry), blockers, true); } catch { /* expected */ }

const byModule = new Map<string, number>();
const byCode = new Map<string, number>();
for (const b of blockers) {
  const m = b.fn.match(/^_nts?\d*_m\d+_/) ? b.fn.split("_").slice(0, 3).join("_") : "entry";
  byModule.set(m, (byModule.get(m) ?? 0) + 1);
  byCode.set(b.code, (byCode.get(b.code) ?? 0) + 1);
}
console.log("function-level blockers in the LINKED program:", blockers.length);
console.log("\nby code:");
for (const [c, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);

/* …and by SHAPE, which is the number that matters: a bucket of 23 identical refusals is
 * one decision, not 23 tasks. Normalization mirrors `test/blocker-metric.ts::shapeOf`. */
const shapeOf = (m: string): string =>
  m.replace(/'[^']*'/g, "'X'").replace(/`[^`]*`/g, "`X`").replace(/\{[^}]*\}/g, "{…}")
   .replace(/@?_nts?\d*_m\d+_\w+/g, "T").replace(/at \d+:\d+/, "at L:C")
   .replace(/U<[^>]*>/g, "U<…>").slice(0, 92);
const byShape = new Map<string, number>();
for (const b of blockers) {
  const k = `${b.code} ${shapeOf(b.message)}`;
  byShape.set(k, (byShape.get(k) ?? 0) + 1);
}
console.log("\nby shape (top 12):");
let shown = 0;
for (const [k, n] of [...byShape].sort((a, b) => b[1] - a[1])) {
  if (shown++ >= 12) break;
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log(`\n${byShape.size} distinct shapes across ${blockers.length} blockers`);
