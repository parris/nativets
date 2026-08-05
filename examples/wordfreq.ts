// wordfreq.ts — a word-frequency counter for nativets (Host I/O tier).
//
// Reads text from stdin (via the Host I/O `readStdin` builtin); if stdin is
// empty/whitespace it falls back to a hardcoded default paragraph. It lowercases
// the text, splits it into words on any non-alphanumeric character, counts each
// word's occurrences in an immutable `Map<string, number>`, and prints the top-N
// words as `word: count` lines (ties broken alphabetically for determinism),
// followed by `total: <n>`.
//
//   $ printf 'the cat the dog the' | ./wordfreq
//   the: 3
//   cat: 1
//   dog: 1
//   total: 5
//
// Written in the nativets immutable subset — leaning on the collections API:
//   - counting uses `map.set(k, (map.get(k) ?? 0) + 1)`; the map is PERSISTENT,
//     so `.set` returns a NEW handle and we reassign (`counts = …`).
//   - `[...counts.keys()]` is the distinct-word list, in INSERTION (first-seen)
//     order — node guarantees that order and so do we, so no parallel array has
//     to be maintained by hand.
//   - ranking is one `.toSorted(cmp)` (the ES2023 COPYING sort — non-mutating in
//     node too, so the oracle is exact) with a comparator that captures the map:
//     count descending, ties alphabetical via plain string `<`.
//
// It compiles + runs identically under `node` (via the harness stdin polyfill)
// and nativets, and cross-compiles unchanged (libc-only runtime).

// How many top words to report.
const TOP_N: number = 5;

// A char's alphabetical/numeric rank is its index in this table. A char is a
// "word character" iff it appears (rank >= 0); everything else (space,
// punctuation, symbols) is a separator. Text is lowercased first, so uppercase
// letters fold into a–z. (The table is inlined here because a function body in
// the current subset can't reference a module-level const.)
function charRank(c: string): number {
  return "abcdefghijklmnopqrstuvwxyz0123456789".indexOf(c);
}

// --- Read input (stdin, or the default paragraph when stdin is empty). ---
const DEFAULT: string =
  "The quick brown fox jumps over the lazy dog. " +
  "The dog barks, and the quick fox jumps again and again over the lazy dog.";

const raw: string = readStdin();
let source: string = raw;
if (raw.trim().length === 0) {
  source = DEFAULT;
}
const text: string = source.toLowerCase();

// --- Single scan: split into words, count into the Map, track distinct + total. ---
let counts = new Map<string, number>();
let total: number = 0;
let cur: string = "";
let i: number = 0;
const n: number = text.length;
// `i === n` is a final flush iteration (sentinel separator) so the last word,
// if the text doesn't end on a separator, is still committed.
while (i <= n) {
  const ch: string = i < n ? text.charAt(i) : " ";
  if (charRank(ch) >= 0) {
    cur = cur + ch;
  } else {
    if (cur.length > 0) {
      counts = counts.set(cur, (counts.get(cur) ?? 0) + 1);
      total = total + 1;
      cur = "";
    }
  }
  i = i + 1;
}

// --- Report the top-N by count (desc), ties alphabetical. ---
// `counts.keys()` is insertion-ordered (first-seen), and `.toSorted` is stable,
// so the comparator alone fixes the output order.
const words: string[] = [...counts.keys()];
const ranked: string[] = words.toSorted((a: string, b: string) => {
  const ca: number = counts.get(a) ?? 0;
  const cb: number = counts.get(b) ?? 0;
  if (ca !== cb) {
    return cb - ca;
  }
  return a < b ? -1 : (a > b ? 1 : 0);
});

let limit: number = TOP_N;
if (ranked.length < TOP_N) {
  limit = ranked.length;
}
let printed: number = 0;
for (const w of ranked) {
  if (printed >= limit) {
    break;
  }
  console.log(w + ": " + (counts.get(w) ?? 0));
  printed = printed + 1;
}
console.log("total: " + total);
