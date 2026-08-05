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
// Written in the nativets immutable subset — leaning on the freshly-landed
// generic `Map<string, number>`:
//   - counting uses `map.has(k)` + `map.set(k, (map.get(k) ?? 0) + 1)`; the map
//     is PERSISTENT so `.set` returns a NEW handle and we reassign (`counts = …`).
//   - the `?? 0` makes counting correct whether `.get` returns 0-on-miss or
//     undefined-on-miss (defensive against either Map#get semantics).
//   - no `.push` / `arr[i] = v`: the distinct-word list grows via spread
//     (`[...distinct, w]`), and we select the top-N with a manual selection scan
//     (no `.sort` comparator in the subset), marking chosen words in a `Set`.
//   - alphabetical tie-breaking can't use string `<` (the checker requires
//     numeric relational operands), so `strLess` compares char ranks looked up
//     in an alphabet string via `.indexOf` — identical under node, so the oracle
//     is well-defined.
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

// Lexicographic "a < b" using char ranks (the subset forbids string `<`). Equal
// prefixes fall back to the shorter string being "less".
function strLess(a: string, b: string): boolean {
  const la: number = a.length;
  const lb: number = b.length;
  let i: number = 0;
  while (i < la && i < lb) {
    const ca: number = charRank(a.charAt(i));
    const cb: number = charRank(b.charAt(i));
    if (ca < cb) {
      return true;
    }
    if (ca > cb) {
      return false;
    }
    i = i + 1;
  }
  return la < lb;
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
let distinct: string[] = [];
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
      if (!counts.has(cur)) {
        distinct = [...distinct, cur];
      }
      counts = counts.set(cur, (counts.get(cur) ?? 0) + 1);
      total = total + 1;
      cur = "";
    }
  }
  i = i + 1;
}

// --- Report the top-N by count (desc), ties alphabetical. Selection scan. ---
let limit: number = TOP_N;
if (distinct.length < TOP_N) {
  limit = distinct.length;
}

let used = new Set<string>();
let printed: number = 0;
while (printed < limit) {
  let bestWord: string = "";
  let bestCount: number = 0;
  let found: boolean = false;
  for (const w of distinct) {
    if (used.has(w)) {
      continue;
    }
    const c: number = counts.get(w) ?? 0;
    if (!found || c > bestCount || (c === bestCount && strLess(w, bestWord))) {
      bestWord = w;
      bestCount = c;
      found = true;
    }
  }
  console.log(bestWord + ": " + bestCount);
  used = used.add(bestWord);
  printed = printed + 1;
}
console.log("total: " + total);
