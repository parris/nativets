// A deliberately hostile — but pure-ASCII — payload: quotes, backslashes, every
// control character except NUL, DEL, printf specifiers, backticks and `${`, plus a
// 4000-character line. Pure ASCII on purpose, so `.length`, indexing and comparison
// are all node-exact here (they are UTF-8 byte-oriented, which only differs from
// node above U+007F — see the utf8/ case).
//
// Everything below the import is identical in oracle.ts, so node decides all of it.
import payload from "./payload.txt" with { type: "text" };

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
