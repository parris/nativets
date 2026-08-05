// matrix.ts — matrix multiplication (plus transpose and an identity check)
// written in the nativets subset.
//
// Two hardcoded `number[][]` matrices are multiplied, the product is printed as a
// space-separated grid, and two extra demonstrations follow: the transpose of the
// left matrix, and multiplying the left matrix by an identity matrix (which must
// reproduce it exactly). Everything is deterministic (hardcoded inputs, no I/O),
// so it is fully node-differential: identical bytes under plain `node` and under a
// compiled nativets binary.
//
// Language subset notes (matches examples/life.ts):
//   - Matrices are `number[][]`. Arrays are IMMUTABLE: no `.push`, no
//     `grid[i][j] = v`. Result rows/grids are grown functionally with spread
//     accumulation (`acc = [...acc, x]`) into a reassigned local, each accumulator
//     SEEDED with its real first element so no empty-literal inference is needed.
//   - Input cells are read INLINE (`a[i][k]`, `b[k][j]`): binding an inner row to a
//     local would move a linear array out of the matrix. Matrix parameters are
//     BORROWS — a function reads a matrix it is given but never returns it; the
//     fresh matrix it builds is owned and returned.
//   - No classes; just functions over `number[]` / `number[][]`.

// ---------------------------------------------------------------------------
// The two operands — hardcoded. A is 2x3, B is 3x2, so the product A*B is 2x2.
// ---------------------------------------------------------------------------

const A: number[][] = [
  [1, 2, 3],
  [4, 5, 6],
];

const B: number[][] = [
  [7, 8],
  [9, 10],
  [11, 12],
];

const A_ROWS: number = 2;
const A_COLS: number = 3;
const B_COLS: number = 2;

// ---------------------------------------------------------------------------
// Multiplication
// ---------------------------------------------------------------------------

// The dot product of row `i` of `a` with column `j` of `b`, summed over the shared
// inner dimension `m` in a scalar accumulator. Both matrices are read inline.
function dot(
  a: number[][],
  b: number[][],
  i: number,
  j: number,
  m: number
): number {
  let sum: number = 0;
  let k: number = 0;
  while (k < m) {
    sum = sum + a[i][k] * b[k][j];
    k = k + 1;
  }
  return sum;
}

// One product row (owned): the dot products of row `i` against every column of `b`.
function mulRow(
  a: number[][],
  b: number[][],
  i: number,
  m: number,
  p: number
): number[] {
  let row: number[] = [dot(a, b, i, 0, m)];
  let j: number = 1;
  while (j < p) {
    row = [...row, dot(a, b, i, j, m)];
    j = j + 1;
  }
  return row;
}

// Full product C = A*B as a fresh owned `number[][]`, one product row at a time.
// `a` is n x m, `b` is m x p, so the result is n x p.
function multiply(
  a: number[][],
  b: number[][],
  n: number,
  m: number,
  p: number
): number[][] {
  let result: number[][] = [mulRow(a, b, 0, m, p)];
  let i: number = 1;
  while (i < n) {
    result = [...result, mulRow(a, b, i, m, p)];
    i = i + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transpose
// ---------------------------------------------------------------------------

// Column `j` of `a` becomes row `j` of the transpose: cell (j, i) = a[i][j].
function transposeRow(a: number[][], j: number, n: number): number[] {
  let row: number[] = [a[0][j]];
  let i: number = 1;
  while (i < n) {
    row = [...row, a[i][j]];
    i = i + 1;
  }
  return row;
}

// Transpose of an n x m matrix as a fresh owned m x n matrix.
function transpose(a: number[][], n: number, m: number): number[][] {
  let result: number[][] = [transposeRow(a, 0, n)];
  let j: number = 1;
  while (j < m) {
    result = [...result, transposeRow(a, j, n)];
    j = j + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Identity matrix
// ---------------------------------------------------------------------------

// Row `r` of the n x n identity: 1 on the diagonal (column r), 0 elsewhere.
function identityRow(r: number, n: number): number[] {
  let row: number[] = [r === 0 ? 1 : 0];
  let c: number = 1;
  while (c < n) {
    row = [...row, r === c ? 1 : 0];
    c = c + 1;
  }
  return row;
}

// The n x n identity matrix as a fresh owned `number[][]`.
function identity(n: number): number[][] {
  let result: number[][] = [identityRow(0, n)];
  let r: number = 1;
  while (r < n) {
    result = [...result, identityRow(r, n)];
    r = r + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Render a matrix to text: one line per row, cells space-separated, rows joined by
// newlines (no trailing newline — `console.log` adds one). `m` is borrowed/read.
function render(m: number[][], rows: number, cols: number): string {
  let out: string = "";
  let r: number = 0;
  while (r < rows) {
    let line: string = "";
    let c: number = 0;
    while (c < cols) {
      if (c === 0) {
        line = line + m[r][c];
      } else {
        line = line + " " + m[r][c];
      }
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

// Are two same-shaped matrices cell-for-cell equal? Used for the identity check.
function equalMatrix(
  x: number[][],
  y: number[][],
  rows: number,
  cols: number
): boolean {
  let r: number = 0;
  while (r < rows) {
    let c: number = 0;
    while (c < cols) {
      if (x[r][c] !== y[r][c]) {
        return false;
      }
      c = c + 1;
    }
    r = r + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Run it.
// ---------------------------------------------------------------------------

console.log("A (" + A_ROWS + "x" + A_COLS + "):");
console.log(render(A, A_ROWS, A_COLS));
console.log("");

console.log("B (" + A_COLS + "x" + B_COLS + "):");
console.log(render(B, A_COLS, B_COLS));
console.log("");

const C: number[][] = multiply(A, B, A_ROWS, A_COLS, B_COLS);
console.log("A * B (" + A_ROWS + "x" + B_COLS + "):");
console.log(render(C, A_ROWS, B_COLS));
console.log("");

const AT: number[][] = transpose(A, A_ROWS, A_COLS);
console.log("transpose(A) (" + A_COLS + "x" + A_ROWS + "):");
console.log(render(AT, A_COLS, A_ROWS));
console.log("");

const I: number[][] = identity(A_COLS);
const AI: number[][] = multiply(A, I, A_ROWS, A_COLS, A_COLS);
console.log("A * I (" + A_ROWS + "x" + A_COLS + "):");
console.log(render(AI, A_ROWS, A_COLS));
console.log("");

console.log("A * I === A: " + equalMatrix(AI, A, A_ROWS, A_COLS));
