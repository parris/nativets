// vigenere.ts — a Vigenère cipher CLI (Caesar is the degenerate 1-char-key case).
//
//   nativets run examples/vigenere.ts -- encode LEMON "Attack at dawn!"
//                                                     ->  Lxfopv ef rnhr!
//   nativets run examples/vigenere.ts -- decode LEMON "Lxfopv ef rnhr!"
//                                                     ->  Attack at dawn!
//   nativets run examples/vigenere.ts -- encode k "abc"   (Caesar, shift 10)
//   ./vigenere                                      ->  the hardcoded demo
//
// INPUT is `process.argv.slice(2)` = [mode, key, text]; mode is encode|decode.
// Case is preserved and non-letters pass through unchanged (and do NOT advance
// the running key position — the classic Vigenère convention). node is the
// differential oracle, so the same argv goes to `node` and to the compiled
// binary and stdout must match byte-for-byte.
//
// Char handling: `charCodeAt`/`String.fromCharCode` are not in the accepted
// subset (NT1002), so letters are mapped through two alphabet strings via
// `indexOf` (letter -> 0..25) and `charAt` (0..25 -> letter) with modular
// index arithmetic. Written in the immutable subset: the result is built with
// string `+=` (no array mutation) — just argv slicing, string methods, a `for`
// loop, and `if`/ternary.

function crypt(mode: string, key: string, text: string): string {
  const UP: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LO: string = "abcdefghijklmnopqrstuvwxyz";
  const enc: boolean = mode === "encode";
  const klow: string = key.toLowerCase();
  const kl: number = klow.length;
  let out: string = "";
  let ki: number = 0;
  for (let i: number = 0; i < text.length; i++) {
    const ch: string = text.charAt(i);
    const ui: number = UP.indexOf(ch);
    const li: number = LO.indexOf(ch);
    if (ui >= 0) {
      const shift: number = kl > 0 ? LO.indexOf(klow.charAt(ki % kl)) : 0;
      const ni: number = enc ? (ui + shift) % 26 : (ui - shift + 26) % 26;
      out += UP.charAt(ni);
      ki = ki + 1;
    } else if (li >= 0) {
      const shift: number = kl > 0 ? LO.indexOf(klow.charAt(ki % kl)) : 0;
      const ni: number = enc ? (li + shift) % 26 : (li - shift + 26) % 26;
      out += LO.charAt(ni);
      ki = ki + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const args: string[] = process.argv.slice(2);
if (args.length === 0) {
  const demoKey: string = "LEMON";
  const secret: string = crypt("encode", demoKey, "Attack at dawn!");
  console.log(secret);
  console.log(crypt("decode", demoKey, secret));
} else {
  const mode: string = args[0];
  const key: string = args.length > 1 ? args[1] : "";
  const text: string = args.length > 2 ? args[2] : "";
  if (mode === "encode" || mode === "decode") {
    console.log(crypt(mode, key, text));
  } else {
    console.log("usage: vigenere <encode|decode> <key> <text>");
  }
}
