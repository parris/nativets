// sudoku.ts — a recursive-backtracking Sudoku solver in the nativets subset.
//
// A hardcoded 9x9 puzzle (0 = blank) is solved by depth-first backtracking and
// the completed grid is printed. Everything is deterministic (fixed puzzle, no
// input), so it is fully node-differential: identical bytes under plain `node`
// and under a compiled nativets binary.
//
// Written in the *current* nativets language subset (docs/examples.md C-a), and
// in particular it is a stress test for the IMMUTABLE data model:
//
//   - The board is `number[][]`. Arrays are IMMUTABLE (Stage 29): there is no
//     `.push` and no `board[r][c] = v`. Placing a digit produces a BRAND-NEW
//     board via nested ES2023 `.with`:
//         board.with(r, board[r].with(c, d))
//     The inner `.with` builds a fresh row with column `c` replaced; the outer
//     `.with` builds a fresh outer array with row `r` replaced. Both are shallow
//     copy-on-write, so a placement copies only two ~9-slot arrays and SHARES the
//     eight untouched rows with the parent board — cheap enough that naive
//     backtracking allocates modestly. The parent board is never mutated, which
//     is exactly what backtracking needs: on failure we simply drop the new board
//     and try the next digit; the old board is still intact.
//
//   - Array parameters are BORROWS: a function may read/index a board it is given
//     but may NEVER return it (that would move a linear value out of a borrow,
//     NT1604/E0507). So `solve` cannot `return board` even when the board it was
//     handed is already the finished solution. Instead the solved board is
//     rebuilt into a fresh OWNED grid by `copyBoard` before returning — see the
//     FAILURE-SIGNAL note below.
//
//   - Nested cells are read INLINE (`board[r][c]`); binding an inner row to a
//     local would move a linear array out of the outer array.
//
//   - Empty array literals `[]` are unsupported (element type can't be inferred),
//     so every accumulator is seeded with its real first element and the growth
//     loop starts at index 1 — no sentinel needed.
//
//   - No classes; just functions over `number[][]`.
//
// FAILURE SIGNAL (no `null`): a solver naturally wants to return "the solved
// board, or nothing". With no nullable/optional type in the current subset, and
// with array params being un-returnable borrows, the signal is encoded in the
// SHAPE of the returned board:
//   - SUCCESS -> an OWNED, fully rebuilt 9-row board (`copyBoard(board)`), so
//     `result.length === 9`.
//   - FAILURE -> a tiny sentinel board `[[-1]]`, whose `result.length === 1`.
// The caller distinguishes the two by outer length. Since the puzzle below has a
// solution, the top-level call always returns a 9-row board.

// ---------------------------------------------------------------------------
// The puzzle. 0 marks a blank cell. (A classic easy grid with a unique
// solution.)
// ---------------------------------------------------------------------------

function makePuzzle(): number[][] {
  return [
    [5, 3, 0, 0, 7, 0, 0, 0, 0],
    [6, 0, 0, 1, 9, 5, 0, 0, 0],
    [0, 9, 8, 0, 0, 0, 0, 6, 0],
    [8, 0, 0, 0, 6, 0, 0, 0, 3],
    [4, 0, 0, 8, 0, 3, 0, 0, 1],
    [7, 0, 0, 0, 2, 0, 0, 0, 6],
    [0, 6, 0, 0, 0, 0, 2, 8, 0],
    [0, 0, 0, 4, 1, 9, 0, 0, 5],
    [0, 0, 0, 0, 8, 0, 0, 7, 9],
  ];
}

// ---------------------------------------------------------------------------
// Reading the board (borrowed, read inline)
// ---------------------------------------------------------------------------

// Index of the first blank cell as `row * 9 + col`, or -1 if the board is full
// (i.e. solved). Row-major scan.
function firstEmpty(board: number[][]): number {
  let r: number = 0;
  while (r < 9) {
    let c: number = 0;
    while (c < 9) {
      if (board[r][c] === 0) return r * 9 + c;
      c = c + 1;
    }
    r = r + 1;
  }
  return -1;
}

// Is placing digit `d` at (r, c) legal? Checks the row, the column, and the 3x3
// box for an existing `d`. `board` is borrowed and read inline.
function isValid(board: number[][], r: number, c: number, d: number): boolean {
  let i: number = 0;
  while (i < 9) {
    if (board[r][i] === d) return false; // row conflict
    if (board[i][c] === d) return false; // column conflict
    i = i + 1;
  }
  const br: number = Math.floor(r / 3) * 3;
  const bc: number = Math.floor(c / 3) * 3;
  let rr: number = br;
  while (rr < br + 3) {
    let cc: number = bc;
    while (cc < bc + 3) {
      if (board[rr][cc] === d) return false; // box conflict
      cc = cc + 1;
    }
    rr = rr + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rebuild an owned copy of a (solved) board — used to hand a finished board back
// out of `solve`, since the borrowed param itself may not be returned.
// ---------------------------------------------------------------------------

function copyRow(board: number[][], r: number): number[] {
  let row: number[] = [board[r][0]];
  let c: number = 1;
  while (c < 9) {
    row = [...row, board[r][c]];
    c = c + 1;
  }
  return row;
}

function copyBoard(board: number[][]): number[][] {
  let g: number[][] = [copyRow(board, 0)];
  let r: number = 1;
  while (r < 9) {
    g = [...g, copyRow(board, r)];
    r = r + 1;
  }
  return g;
}

// ---------------------------------------------------------------------------
// The solver: depth-first backtracking over an immutable board.
// ---------------------------------------------------------------------------

// Returns the solved board (a fresh owned 9-row grid) on success, or the
// sentinel `[[-1]]` (a 1-row grid) on failure. See the FAILURE-SIGNAL note above.
function solve(board: number[][]): number[][] {
  const idx: number = firstEmpty(board);
  if (idx < 0) {
    // No blanks left: every placed digit was legal, so this is a solution.
    return copyBoard(board);
  }
  const r: number = Math.floor(idx / 3 / 3); // idx / 9, kept integral
  const c: number = idx - r * 9;
  let d: number = 1;
  while (d <= 9) {
    if (isValid(board, r, c, d)) {
      // Place `d` immutably: a brand-new board that shares the untouched rows.
      const next: number[][] = board.with(r, board[r].with(c, d));
      const res: number[][] = solve(next);
      if (res.length === 9) return res; // solved downstream — propagate it up
      // else: this digit led to a dead end; `res` (the sentinel) and `next` are
      // dropped, the original `board` is untouched, and we try the next digit.
    }
    d = d + 1;
  }
  // No digit fits here: signal failure so the caller backtracks.
  return [[-1]];
}

// ---------------------------------------------------------------------------
// Rendering: one line per row, cells separated by a single space (no trailing
// newline — `console.log` adds one). Cells are read inline.
// ---------------------------------------------------------------------------

function render(board: number[][]): string {
  let out: string = "";
  let r: number = 0;
  while (r < 9) {
    let line: string = "";
    let c: number = 0;
    while (c < 9) {
      if (c > 0) {
        line = line + " ";
      }
      line = line + board[r][c];
      c = c + 1;
    }
    if (r === 0) {
      out = line;
    } else {
      out = out + "\n" + line;
    }
    r = r + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run it: print the puzzle, solve it, print the solution.
// ---------------------------------------------------------------------------

const puzzle: number[][] = makePuzzle();
console.log("Puzzle:");
console.log(render(puzzle));
console.log("");

const solved: number[][] = solve(puzzle);
if (solved.length === 9) {
  console.log("Solved:");
  console.log(render(solved));
} else {
  console.log("No solution.");
}
