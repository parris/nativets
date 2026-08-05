// Hex / binary / octal numeric literals and numeric separators. `src/codegen.ts`'s
// `encodeCString` is written with byte constants (`0x22`, `0x5c`, `0x20`, `0x7f`);
// the lexer read `0` and then `x22` as an identifier, so the whole function was
// "unparsed". (This is a DIFFERENT gap from the `\xHH` string escape, which already
// worked — see test/hex-escape.test.ts.)

function encodeByte(b: number): string {
  if (b === 0x22) return "\\22";
  if (b === 0x5c) return "\\5C";
  if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b);
  return "\\" + b.toString(16).toUpperCase();
}

console.log(encodeByte(0x22));
console.log(encodeByte(0x41));
console.log(encodeByte(0x09));

console.log(0x22, 0X1f, 0xdeadbeef);
console.log(0b1010, 0B1111_0000);
console.log(0o17, 0O777);
console.log(1_000_000 + 2_5);
console.log(0xff & 0x0f, 0xff >> 4);
