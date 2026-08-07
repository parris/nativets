// The node-runnable twin of main.ts: same string, obtained the way node can obtain
// it. Everything AFTER the binding is identical source, so node stays the oracle for
// what the string IS — only the import form itself is nativets-only.
import { readFileSync } from "node:fs";

const payload = readFileSync("./payload.txt", "utf8");

console.log(payload.length);
console.log(payload);
