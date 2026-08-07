// The node-runnable twin of main.ts. See the note there: the FIRST printed line is the
// one deliberate difference — nativets' `String#length` counts UTF-8 bytes, so node
// must print `Buffer.byteLength(payload, "utf8")` for the two to mean the same thing.
import { readFileSync } from "node:fs";

const payload = readFileSync("./payload.txt", "utf8");

console.log(Buffer.byteLength(payload, "utf8")); // == payload.length under nativets
const bytes = new TextEncoder().encode(payload);
console.log(bytes.length);

let h = 0;
for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) % 1000000007;
console.log(h);

console.log(payload);
