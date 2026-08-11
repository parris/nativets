// base64.ts — a base64 encode/decode CLI built on the stdlib `btoa`/`atob` globals.
//
//   nativets run examples/base64.ts -- encode hello        ->  aGVsbG8=
//   nativets run examples/base64.ts -- decode aGVsbG8=      ->  hello
//   ./base64 encode "nativets"                              ->  bmF0aXZldHM=
//
// INPUT comes from `process.argv` (Host I/O FFI); the transform is the stdlib
// `btoa(s)` / `atob(s)` pair (node has both as globals, so it is the oracle).
// ASCII input only — not because the pair is limited to it (btoa/atob implement
// the BINARY-STRING contract, so U+0000..U+00FF encodes and `atob` round-trips
// it), but because `decode` prints whatever bytes it is given and a CLI arg is
// the untrusted end. Compiles + runs identically under `node` and nativets and
// cross-compiles to macOS / Linux / iOS / Android unchanged (libc-only runtime).
// Written in the immutable subset: no mutation, no classes — just argv slicing,
// the two globals, string methods, and `if` / ternary.

const args: string[] = process.argv.slice(2);
const mode: string = args.length > 0 ? args[0] : "";
const input: string = args.length > 1 ? args[1] : "";

if (mode === "encode") {
  console.log(btoa(input));
} else if (mode === "decode") {
  console.log(atob(input));
} else {
  console.log("usage: base64 <encode|decode> <text>");
}
