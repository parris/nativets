// wc.ts — a `wc`-like tool for nativets (docs/examples.md, Host I/O tier).
//
// Reads ALL of stdin and prints newline, word, and character counts on one line:
//
//   $ printf 'hello world\nsecond line\n' | ./wc      ->  2 3 24
//
// Output shape (defined here, and matched byte-for-byte by the node oracle):
//
//   <lines> <words> <chars>
//
//   - lines  = number of newline ('\n') characters   (GNU wc's -l semantics:
//              a final line with no trailing newline is NOT counted as a line).
//   - words  = number of maximal runs of non-whitespace characters, where
//              whitespace is space, '\n', '\t', or '\r' (GNU wc's -w semantics).
//   - chars  = total number of characters read        (GNU wc's -c/-m for ASCII).
//
// It compiles + runs identically under `node` (via the harness stdin polyfill)
// and nativets, and cross-compiles to macOS / Linux / iOS / Android unchanged
// (the runtime host layer is libc-only). Written in the *current* immutable
// subset: no `.push` / `arr[i] = v` / `o.f = v` — the counts are plain numeric
// locals accumulated in a single `for` scan, so no heap data structures at all.

function isSpace(c: string): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r";
}

function countLines(s: string): number {
  let lines: number = 0;
  let i: number = 0;
  while (i < s.length) {
    if (s.charAt(i) === "\n") {
      lines = lines + 1;
    }
    i = i + 1;
  }
  return lines;
}

// Count maximal runs of non-whitespace. `inWord` tracks whether the previous
// character was part of a word, so each whitespace→non-whitespace transition
// starts (and counts) exactly one new word.
function countWords(s: string): number {
  let words: number = 0;
  let inWord: boolean = false;
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (isSpace(c)) {
      inWord = false;
    } else {
      if (!inWord) {
        words = words + 1;
      }
      inWord = true;
    }
    i = i + 1;
  }
  return words;
}

// --- Read all of stdin and report the three counts, space-separated. ---
const input: string = readStdin();
const lines: number = countLines(input);
const words: number = countWords(input);
const chars: number = input.length;
console.log(lines + " " + words + " " + chars);
