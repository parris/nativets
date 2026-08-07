// The node-runnable twin of main.ts. Only the twelve bindings differ (readFileSync
// instead of the text import), plus the `.length` column, which is UTF-8 bytes under
// nativets and UTF-16 units under node — see the note in main.ts.
import { readFileSync } from "node:fs";

const R = "../../../runtime/";
const read = (n: string) => readFileSync(R + n, "utf8");

const runtimeSource = read("runtime.c");
const actorSource = read("nt_actor.c");
const actorHeader = read("nt_actor.h");
const hamtSource = read("nt_hamt.c");
const hamtHeader = read("nt_hamt.h");
const mapsetSource = read("nt_mapset.c");
const bytesSource = read("nt_bytes.c");
const bytesHeader = read("nt_bytes.h");
const pvecSource = read("nt_pvec.c");
const pvecHeader = read("nt_pvec.h");
const httpSource = read("nt_http.c");
const guiSource = read("nt_gui.c");

const all: string[] = [
  runtimeSource, actorSource, actorHeader, hamtSource, hamtHeader, mapsetSource,
  bytesSource, bytesHeader, pvecSource, pvecHeader, httpSource, guiSource,
];

let total = 0;
for (const s of all) {
  const bytes = new TextEncoder().encode(s);
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) % 1000000007;
  console.log(Buffer.byteLength(s, "utf8"), bytes.length, h);
  total = total + bytes.length;
}
console.log(total);

console.log(runtimeSource.startsWith("/*"));
console.log(runtimeSource.indexOf("double js_str_len(const char *s)") > 0);

for (const s of all) console.log(s);
