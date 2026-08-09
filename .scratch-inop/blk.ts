import { readFileSync } from "node:fs";
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";
const rel = process.argv[2]!;
const src = readFileSync(rel, "utf8");
try { check(parse(src)); console.log("CLEAN standalone"); }
catch (e: any) { const d = e.diag; console.log(d ? `${d.code}: ${d.message}` : String(e.message).split("\n")[0]); }
