// The node-runnable twin of main.ts. Only the binding differs; every line below it
// is byte-identical, so node is the oracle for what the string IS and for what the
// string operations do with it.
import { readFileSync } from "node:fs";

const payload = readFileSync("./payload.txt", "utf8");

const n = payload.length;
console.log(n);
console.log(payload.charCodeAt(0));
console.log(payload.charCodeAt(n - 1));
console.log(payload.indexOf("backslash"));
console.log(payload.indexOf("DEL:"));
console.log(payload.startsWith("quote:"));
console.log(payload.endsWith("\n"));
console.log(payload.slice(0, 41));
console.log(payload.split("\n").length);

// Every byte, one at a time: a checksum that fails on a single mis-escaped or
// dropped character anywhere in the payload. Kept under 2^53 at every step so both
// sides compute it in exact IEEE-754 doubles.
let h = 0;
for (let i = 0; i < n; i++) h = (h * 31 + payload.charCodeAt(i)) % 1000000007;
console.log(h);

// And the payload itself, verbatim — the strongest form of the same assertion.
console.log(payload);
