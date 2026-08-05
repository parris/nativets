// tictactoe.ts — a tic-tac-toe MINIMAX engine written in the nativets subset.
//
// The board is a flat `string[]` of 9 cells ("X", "O", or " "). A perfect player
// is built from classic minimax RECURSION over IMMUTABLE boards: to try a move we
// don't mutate the board, we build a brand-new one with `board.with(i, mark)`
// (ES2023 copy-on-write) and recurse into it; backtracking is simply dropping that
// new board when the call returns. Everything is deterministic — a hardcoded
// analysis position plus a full self-play game (X vs O, BOTH playing minimax) —
// so it prints the same bytes under plain `node` and a compiled nativets binary.
//
// Written in the *current* nativets language subset (docs/examples.md C-a):
//   - Arrays are IMMUTABLE (Stage 29): no `.push` and no `board[i] = v`. A move is
//     `board.with(i, mark)`, which returns a FRESH board and leaves the argument
//     untouched — the ideal shape for a minimax search tree.
//   - Array parameters are BORROWS: minimax/winner/render only ever READ the board
//     they are handed (indexing it inline). The fresh board that `.with` returns is
//     owned locally, passed by borrow into the recursive call, then dropped.
//   - Empty array literals `[]` are unsupported (element type can't be inferred),
//     so the initial board is a full 9-element literal of blanks.
//   - Top-level `const`s are NOT in scope inside function bodies (functions see
//     only builtins + their params/locals), so the marks "X"/"O"/" " are written
//     as inline literals throughout rather than as shared named constants.
//   - No classes; just functions over `string[]`, `Math.max`/`Math.min`, `if`,
//     C-style `for`, `while`, and recursion.

// ---------------------------------------------------------------------------
// The opponent. X maximizes the score, O minimizes it.
// ---------------------------------------------------------------------------

function other(p: string): string {
  if (p === "X") return "O";
  return "X";
}

// ---------------------------------------------------------------------------
// Win detection (reads the borrowed board inline)
// ---------------------------------------------------------------------------

// If cells a, b, c hold the same non-blank mark, return that mark; else " ".
function lineWinner(board: string[], a: number, b: number, c: number): string {
  if (board[a] !== " " && board[a] === board[b] && board[b] === board[c]) {
    return board[a];
  }
  return " ";
}

// The winning mark ("X"/"O") if the board is won, else " ". Checks the 3 rows,
// 3 columns, and 2 diagonals.
function winner(board: string[]): string {
  let w: string = lineWinner(board, 0, 1, 2);
  if (w !== " ") return w;
  w = lineWinner(board, 3, 4, 5);
  if (w !== " ") return w;
  w = lineWinner(board, 6, 7, 8);
  if (w !== " ") return w;
  w = lineWinner(board, 0, 3, 6);
  if (w !== " ") return w;
  w = lineWinner(board, 1, 4, 7);
  if (w !== " ") return w;
  w = lineWinner(board, 2, 5, 8);
  if (w !== " ") return w;
  w = lineWinner(board, 0, 4, 8);
  if (w !== " ") return w;
  w = lineWinner(board, 2, 4, 6);
  if (w !== " ") return w;
  return " ";
}

// How many cells are still blank.
function blanks(board: string[]): number {
  let n: number = 0;
  for (let i: number = 0; i < 9; i = i + 1) {
    if (board[i] === " ") n = n + 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Minimax over immutable boards
// ---------------------------------------------------------------------------

// Score a position from X's point of view, with `player` to move. A quicker win
// scores higher (10 - depth) and a quicker loss lower (depth - 10), so the engine
// prefers to win fast and lose slow; a draw is 0. For each empty cell we build a
// NEW board with `.with` and recurse — the search tree is a tree of fresh boards.
function minimax(board: string[], player: string, depth: number): number {
  const w: string = winner(board);
  if (w === "X") return 10 - depth;
  if (w === "O") return depth - 10;
  if (blanks(board) === 0) return 0; // full board, no winner => draw

  if (player === "X") {
    // Maximizing player.
    let best: number = -1000;
    for (let i: number = 0; i < 9; i = i + 1) {
      if (board[i] === " ") {
        const next: string[] = board.with(i, "X");
        const s: number = minimax(next, "O", depth + 1);
        best = Math.max(best, s);
      }
    }
    return best;
  }

  // Minimizing player.
  let best: number = 1000;
  for (let i: number = 0; i < 9; i = i + 1) {
    if (board[i] === " ") {
      const next: string[] = board.with(i, "O");
      const s: number = minimax(next, "X", depth + 1);
      best = Math.min(best, s);
    }
  }
  return best;
}

// The index of the best move for `player`, or -1 if the board is terminal/full.
// Ties go to the lowest index (strict comparison), so play is fully deterministic.
function bestMove(board: string[], player: string): number {
  let bestIdx: number = -1;
  if (player === "X") {
    let bestScore: number = -1000;
    for (let i: number = 0; i < 9; i = i + 1) {
      if (board[i] === " ") {
        const next: string[] = board.with(i, "X");
        const s: number = minimax(next, "O", 1);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }
  let bestScore: number = 1000;
  for (let i: number = 0; i < 9; i = i + 1) {
    if (board[i] === " ") {
      const next: string[] = board.with(i, "O");
      const s: number = minimax(next, "X", 1);
      if (s < bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Render the 3x3 board as three "a|b|c" rows separated by a "-+-+-" rule.
function render(board: string[]): string {
  let out: string = "";
  for (let r: number = 0; r < 3; r = r + 1) {
    let line: string = "";
    for (let c: number = 0; c < 3; c = c + 1) {
      line = line + board[r * 3 + c];
      if (c < 2) line = line + "|";
    }
    if (r === 0) {
      out = line;
    } else {
      out = out + "\n-+-+-\n" + line;
    }
  }
  return out;
}

// A short human name for a cell index, e.g. index 5 -> "r1c2" (row, col).
function cellName(i: number): string {
  const r: number = Math.floor(i / 3);
  const c: number = i % 3;
  return "r" + r + "c" + c;
}

// ---------------------------------------------------------------------------
// Demo 1: analyze a hardcoded position — find the optimal move.
// ---------------------------------------------------------------------------

// A position with X to move and an immediate winning move available:
//   X | O | X
//   O | X |
//     |   | O
// X holds cells 2 and 4; playing cell 6 completes the 2-4-6 diagonal.
const position: string[] = ["X", "O", "X", "O", "X", " ", " ", " ", "O"];

console.log("Analysis position (X to move):");
console.log(render(position));
const move: number = bestMove(position, "X");
console.log("Best move for X: " + cellName(move) + " (index " + move + ")");
console.log("");

// ---------------------------------------------------------------------------
// Demo 2: a full self-play game — X vs O, both playing perfect minimax.
// Two perfect players always draw; this prints every move and the final board.
// ---------------------------------------------------------------------------

console.log("Self-play game (X and O both minimax):");
let board: string[] = [
  " ", " ", " ",
  " ", " ", " ",
  " ", " ", " ",
];
let player: string = "X";
let ply: number = 1;
while (winner(board) === " " && blanks(board) > 0) {
  const idx: number = bestMove(board, player);
  console.log("Move " + ply + ": " + player + " -> " + cellName(idx));
  board = board.with(idx, player);
  player = other(player);
  ply = ply + 1;
}

console.log("");
console.log("Final board:");
console.log(render(board));

const result: string = winner(board);
if (result === " ") {
  console.log("Result: draw");
} else {
  console.log("Result: " + result + " wins");
}
