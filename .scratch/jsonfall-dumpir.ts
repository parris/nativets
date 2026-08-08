// Dump every fixture's IR to a directory, so the base and the lane can be diffed
// per fixture instead of reading a 129-line snapshot failure list.
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sourceToIR } from "../src/driver.ts";

const ROOT = join(import.meta.dir, "..", "test", "fixtures");
const OUT = process.argv[2]!;
mkdirSync(OUT, { recursive: true });

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

for (const f of collect(ROOT)) {
  const name = relative(ROOT, f).replace(/\//g, "__");
  let ir: string;
  try { ir = sourceToIR(readFileSync(f, "utf8")); } catch (e) { ir = `THREW: ${String(e)}`; }
  writeFileSync(join(OUT, name + ".ll"), ir);
}
console.log("done");
