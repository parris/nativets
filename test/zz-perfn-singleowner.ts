#!/usr/bin/env bun
// Per-FUNCTION blocker dump: `fn<TAB>code` sorted. Diff two of these, never the total.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { linkProgram, choosePrefixBase, moduleGraph } from "../src/modules.ts";
import { check, type FnBlocker } from "../src/checker.ts";

const root = resolve(process.argv[2]!);
const entry = resolve(root, "src/cli.ts");
const source = readFileSync(entry, "utf8");
const graph = moduleGraph(source, entry);
const base = choosePrefixBase(graph.map((p) => (p === entry ? source : readFileSync(p, "utf8"))));
const blockers: FnBlocker[] = [];
try { check(linkProgram(source, entry), blockers); } catch { /* expected */ }
// strip the link prefix so names are comparable across trees
const strip = (n: string) => n.split(base).join("m");
const lines = blockers.map((b) => `${strip(b.fn)}\t${b.code}`).sort();
console.log(`#FAILING\t${blockers.length}`);
for (const l of lines) console.log(l);
