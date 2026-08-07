// Non-ASCII payload: em dash, accents, CJK, an astral emoji (a surrogate pair in
// UTF-16, four bytes in UTF-8), a combining sequence and a zero-width space.
//
// One line here is deliberately NOT identical to oracle.ts: nativets' `String#length`
// is UTF-8 BYTE-oriented and node's is UTF-16 code units (a long-standing documented
// divergence, docs/divergences.md §A.2). So the oracle prints the quantity that means
// the same thing — `Buffer.byteLength(payload, "utf8")` — which node-verifies that the
// import produced exactly the file's bytes. Everything else is byte-identical source.
import payload from "./payload.txt" with { type: "text" };

console.log(payload.length); // UTF-8 bytes here; Buffer.byteLength in the oracle
const bytes = new TextEncoder().encode(payload);
console.log(bytes.length);

let h = 0;
for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) % 1000000007;
console.log(h);

console.log(payload);
