// The node-runnable twin of main.ts. `new URL("./data.txt", import.meta.url)` is
// exactly "relative to the importing file" — the resolution rule being asserted.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromLib } from "./lib/oracle.ts";

const banner = readFileSync(fileURLToPath(new URL("./data.txt", import.meta.url)), "utf8");

console.log(banner.trim());
console.log(fromLib().trim());
console.log(banner === fromLib());
