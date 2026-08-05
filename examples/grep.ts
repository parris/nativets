// grep.ts — a mini-grep for nativets (Host I/O FFI).
//
// Reads a search substring from process.argv[2] and lines from stdin, then prints
// every line that contains the substring, each prefixed with its 1-based line
// number (like `grep -n`):
//
//   printf 'foo\nbar\nfoobar\n' | nativets run examples/grep.ts -- foo
//     1:foo
//     3:foobar
//
// It compiles + runs identically under `node` and nativets, and cross-compiles to
// macOS / Linux / iOS / Android unchanged (the runtime host layer is libc-only).
// Written in the immutable subset: no `.push` / `arr[i] = v` — matches are printed
// as they are found with `console.log`, so nothing is accumulated. Input comes from
// `process.argv.slice(2)` (CLI args) and `readLine()` looped until "" (EOF).

// The needle is the first user argument (argv[2]); empty when none was given, in
// which case every line matches (a bare substring of "" is contained in anything).
const args: string[] = process.argv.slice(2);
const needle: string = args.length > 0 ? args[0] : "";

let lineNo: number = 0;
let line: string = readLine();
while (line !== "") {
  lineNo = lineNo + 1;
  if (needle.length === 0 || line.includes(needle)) {
    console.log(`${lineNo}:${line}`);
  }
  line = readLine();
}
