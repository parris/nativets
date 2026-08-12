/*
 * NT1004 EXPOSURE, COUNTED — how many `throw`s in src/ sit outside a `try` in their own
 * frame. An instrument, not a gate: run it, read it, decide with it.
 *
 * `bun run test/throw-census.ts`
 *
 * IT IS AN UPPER BOUND. A throw outside a `try` is still legal when EVERY call site of its
 * function catches — it may cross exactly one frame. `lexer.ts`'s five sit in `lex`, whose
 * only caller wraps it in a `try`, so this counts them and codegen does not. The true
 * blocker count needs the call-site analysis codegen's escape scan already does.
 *
 * ASKED OF THE PARSER, deliberately. The first version of this count used brace depth and
 * was wrong: a lexer's own source is full of braces inside string literals, and it put a
 * third of `lexer.ts`'s throws in the wrong frames — which made an 8-site job look like an
 * 11-site one across three functions when three of those needed no work at all.
 *
 * What it said the first time it was run over the whole tree: 557 throws across 148 frames,
 * 398 of them in `checker.ts`. That is the argument for fixing NT1004 in codegen (let an
 * exception cross more than one frame) rather than funnelling by hand — see
 * docs/self-hosting.md.
 */
import { parse } from "../src/parser.ts";
import { readFileSync, readdirSync } from "node:fs";

let grandTotal = 0, grandFrames = 0;
const rows: string[] = [];
for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((n) => n.endsWith(".ts")).sort()) {
  let prog;
  try { prog = parse(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), { file: f }); }
  catch { rows.push(`  ${f.padEnd(24)} (unparseable)`); continue; }
  const byFrame = new Map<string, number>();
  let inTryCount = 0;
  function walk(n: any, frame: string, inTry: boolean): void {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x, frame, inTry); return; }
    if (n.kind === "FuncDecl") { for (const k of Object.keys(n)) walk(n[k], n.name, false); return; }
    if (n.kind === "ArrowFunction") { for (const k of Object.keys(n)) walk(n[k], `${frame} > (arrow)`, false); return; }
    if (n.kind === "TryStmt") { walk(n.block, frame, true); walk(n.handler, frame, false); walk(n.finalizer, frame, false); return; }
    if (n.kind === "ThrowStmt") {
      if (inTry) inTryCount++;
      else byFrame.set(frame, (byFrame.get(frame) ?? 0) + 1);
      return;
    }
    for (const k of Object.keys(n)) walk(n[k], frame, inTry);
  }
  walk(prog.body, "(module top level)", false);
  const tot = [...byFrame.values()].reduce((a, b) => a + b, 0);
  grandTotal += tot; grandFrames += byFrame.size;
  rows.push(`  ${f.padEnd(24)} ${String(tot).padStart(4)} throws needing a caller-catch, in ${String(byFrame.size).padStart(3)} frames   (${inTryCount} already inside a try)`);
}
for (const r of rows) console.log(r);
console.log(`\nTOTAL ${grandTotal} throws across ${grandFrames} frames`);
