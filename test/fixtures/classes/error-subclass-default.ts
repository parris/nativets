class LexError extends Error {}

const a = new LexError("bad token");
const b = new LexError("unterminated string");
console.log(a.message);
console.log(b.message);
console.log(a.message === "bad token");
