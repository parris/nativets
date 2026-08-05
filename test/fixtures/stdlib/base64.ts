// btoa / atob — base64 encode/decode (node has both as globals). Deterministic.
console.log(btoa("hello"));
console.log(btoa("Man"));
console.log(btoa("Ma"));
console.log(btoa("M"));
console.log(btoa(""));
console.log(atob("aGVsbG8="));
console.log(atob("TWFu"));
console.log(atob("TWE="));
console.log(atob("TQ=="));
console.log(atob(btoa("round trip through base64!")));
const encoded: string = btoa("nativets");
console.log(encoded, encoded.length, atob(encoded));
