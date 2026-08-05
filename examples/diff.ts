// diff.ts — a line-based text diff via Longest Common Subsequence, in the
// nativets subset. Given two multi-line strings it prints a unified-ish diff:
//
//     "  line"   an unchanged line (in both texts)
//     "- line"   a deletion       (only in the old text)
//     "+ line"   an addition      (only in the new text)
//
// It compiles + runs identically under plain `node` and under nativets
// (byte-for-byte), so `node` is the differential oracle. Inputs are hardcoded
// (no IO needed) and the algorithm is deterministic.
//
// ---------------------------------------------------------------------------
// Written in the *current* nativets language subset — arrays are IMMUTABLE:
// no `.push`, no `arr[i] = v`. The interesting part is the LCS dynamic-
// programming table, which we build WITHOUT in-place mutation:
//
//   * The table is a FLAT `number[]` of length (n+1)*(m+1), indexed as
//     `dp[i * w + j]` (row width `w = m + 1`) — a 2-D table without nested
//     arrays. `dp[i*w + j]` holds the LCS length of the suffixes `a[i..]`
//     and `b[j..]`.
//   * It is allocated by repeatedly rebuilding via spread (`dp = [...dp, 0]`)
//     — the immutable way to grow an array — until it holds (n+1)*(m+1) zeros.
//   * Each cell is filled with the copy-on-write `dp = dp.with(k, val)`
//     (ES2023 `Array.prototype.with`, the sanctioned immutable replacement for
//     `dp[k] = val`): it returns a NEW array with one slot changed, leaving the
//     old one untouched. We rebind `dp` to the fresh copy each step.
//
// Filling bottom-right → top-left lets the classic top-left backtrack emit the
// diff greedily. No heap value is ever moved out of an array (elements are only
// read by index), so the whole thing stays inside the linear/immutable subset.
// ---------------------------------------------------------------------------

// Compute the line diff of `oldText` vs `newText`, returning the annotated text
// (each output line prefixed with "  ", "- ", or "+ ", and newline-terminated).
function diff(oldText: string, newText: string): string {
  const a: string[] = oldText.split("\n");
  const b: string[] = newText.split("\n");
  const n: number = a.length;
  const m: number = b.length;
  const w: number = m + 1; // row width of the flattened (n+1)x(m+1) table

  // --- allocate the DP table as (n+1)*(m+1) zeros (immutable grow) ---
  let dp: number[] = [];
  let cells: number = (n + 1) * w;
  let t: number = 0;
  while (t < cells) {
    dp = [...dp, 0];
    t = t + 1;
  }

  // --- fill: dp[i*w+j] = LCS length of a[i..] and b[j..] ---
  // Row/col n and m stay zero (empty suffix). Work upward and leftward so each
  // cell only reads already-computed neighbors (down, right, down-right).
  let i: number = n - 1;
  while (i >= 0) {
    let j: number = m - 1;
    while (j >= 0) {
      let val: number = 0;
      if (a[i] === b[j]) {
        val = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down: number = dp[(i + 1) * w + j];
        const right: number = dp[i * w + (j + 1)];
        val = down >= right ? down : right;
      }
      dp = dp.with(i * w + j, val);
      j = j - 1;
    }
    i = i - 1;
  }

  // --- backtrack from the top-left to emit the diff ---
  // At (x,y): equal lines are unchanged; otherwise step in the direction the
  // table says preserves the longer common subsequence — down = deletion of
  // a[x], right = addition of b[y]. Ties favor deletion (deterministic).
  let out: string = "";
  let x: number = 0;
  let y: number = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) {
      out += "  " + a[x] + "\n";
      x = x + 1;
      y = y + 1;
    } else if (dp[(x + 1) * w + y] >= dp[x * w + (y + 1)]) {
      out += "- " + a[x] + "\n";
      x = x + 1;
    } else {
      out += "+ " + b[y] + "\n";
      y = y + 1;
    }
  }
  // Drain whatever remains: leftover old lines are deletions, new ones additions.
  while (x < n) {
    out += "- " + a[x] + "\n";
    x = x + 1;
  }
  while (y < m) {
    out += "+ " + b[y] + "\n";
    y = y + 1;
  }
  return out;
}

// Print a labeled diff section (header line + the diff body).
function show(label: string, oldText: string, newText: string): void {
  console.log("== " + label + " ==");
  const d: string = diff(oldText, newText);
  // `d` already ends in "\n"; print without console.log's extra newline by
  // trimming the trailing one, so each case's block is uniform.
  console.log(d.slice(0, d.length - 1));
}

// --- Four hardcoded scenarios: identical, insertion, deletion, mixed. ---

// 1) Identical texts → every line unchanged.
show("identical", "alpha\nbeta\ngamma", "alpha\nbeta\ngamma");

// 2) Pure insertion → a single added line, everything else unchanged.
show("insertion", "alpha\ngamma", "alpha\nbeta\ngamma");

// 3) Pure deletion → a single removed line, everything else unchanged.
show("deletion", "alpha\nbeta\ngamma", "alpha\ngamma");

// 4) Mixed edit → deletions, additions, and unchanged lines interleaved.
show("mixed", "apple\nbanana\ncherry\ndate", "apple\nblueberry\ncherry\ndate\nelderberry");
