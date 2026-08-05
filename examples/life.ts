// life.ts — Conway's Game of Life written in the nativets subset.
//
// A fixed-seed grid (a glider on a 10x10 board) is evolved for a fixed number of
// generations and each generation is printed as `#`/`.` rows, generations
// separated by a blank line. Everything is deterministic (hardcoded seed +
// generation count, no input), so it is fully node-differential: it prints the
// same bytes under plain `node` and under a compiled nativets binary.
//
// Written in the *current* nativets language subset (docs/examples.md C-a):
//   - The board is `number[][]` (0 = dead, 1 = alive). Arrays are IMMUTABLE
//     (Stage 29): there is no `.push` and no `grid[r][c] = v`. A generation step
//     READS the old grid and CONSTRUCTS a brand-new grid — the ideal shape for an
//     immutable model. Rows/grids are grown functionally with spread
//     (`acc = [...acc, x]`) into a reassigned local.
//   - Empty array literals `[]` are unsupported (element type can't be inferred),
//     so every accumulator is seeded with its real first element (column 0 / row
//     0) and the growth loop starts at index 1 — no sentinel needed.
//   - Array parameters are BORROWS: a function may read/index a grid it is given
//     but never return it; the fresh grid a step produces is owned and returned.
//     Nested cells are read INLINE (`grid[r][c]`) — binding an inner row to a
//     local would move a linear array out of the grid.
//   - No classes; just functions over `number[][]`.

// ---------------------------------------------------------------------------
// Board dimensions, seed, and how long to run — all compile-time constants.
// ---------------------------------------------------------------------------

const ROWS: number = 10;
const COLS: number = 10;
const GENERATIONS: number = 10;

// The seed: a classic "glider" in the top-left corner. Returns 1 for a live
// cell, 0 for dead. A glider walks one cell down-and-right every 4 generations.
//   .#.
//   ..#
//   ###
function seedCell(r: number, c: number): number {
  if (r === 0 && c === 1) return 1;
  if (r === 1 && c === 2) return 1;
  if (r === 2 && c === 0) return 1;
  if (r === 2 && c === 1) return 1;
  if (r === 2 && c === 2) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Immutable grid construction
// ---------------------------------------------------------------------------

// Build one seed row functionally: start with column 0, then spread each further
// column onto the accumulator.
function seedRow(r: number, cols: number): number[] {
  let row: number[] = [seedCell(r, 0)];
  let c: number = 1;
  while (c < cols) {
    row = [...row, seedCell(r, c)];
    c = c + 1;
  }
  return row;
}

// Build the initial grid as an owned `number[][]`, one fresh row at a time.
function makeSeedGrid(rows: number, cols: number): number[][] {
  let grid: number[][] = [seedRow(0, cols)];
  let r: number = 1;
  while (r < rows) {
    grid = [...grid, seedRow(r, cols)];
    r = r + 1;
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Evolution rules
// ---------------------------------------------------------------------------

// Count the live cells in the 8-neighborhood of (r, c). The board does NOT wrap;
// out-of-range neighbors simply don't count. `grid` is borrowed and read inline.
function liveNeighbors(
  grid: number[][],
  r: number,
  c: number,
  rows: number,
  cols: number
): number {
  let count: number = 0;
  let dr: number = -1;
  while (dr <= 1) {
    let dc: number = -1;
    while (dc <= 1) {
      if (dr !== 0 || dc !== 0) {
        const nr: number = r + dr;
        const nc: number = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          count = count + grid[nr][nc];
        }
      }
      dc = dc + 1;
    }
    dr = dr + 1;
  }
  return count;
}

// The rule for a single cell's next state (Conway's B3/S23):
//   - a live cell survives with 2 or 3 live neighbors, else dies;
//   - a dead cell is born with exactly 3 live neighbors.
function nextCell(
  grid: number[][],
  r: number,
  c: number,
  rows: number,
  cols: number
): number {
  const n: number = liveNeighbors(grid, r, c, rows, cols);
  if (grid[r][c] === 1) {
    if (n === 2 || n === 3) return 1;
    return 0;
  }
  if (n === 3) return 1;
  return 0;
}

// Compute one next-generation row (owned), reading the old grid immutably.
function stepRow(
  grid: number[][],
  r: number,
  rows: number,
  cols: number
): number[] {
  let row: number[] = [nextCell(grid, r, 0, rows, cols)];
  let c: number = 1;
  while (c < cols) {
    row = [...row, nextCell(grid, r, c, rows, cols)];
    c = c + 1;
  }
  return row;
}

// Advance the whole board one generation, returning a brand-new owned grid. The
// input grid is only ever read (borrowed), never mutated.
function step(grid: number[][], rows: number, cols: number): number[][] {
  let next: number[][] = [stepRow(grid, 0, rows, cols)];
  let r: number = 1;
  while (r < rows) {
    next = [...next, stepRow(grid, r, rows, cols)];
    r = r + 1;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Render the board to text: one line per row, `#` for live and `.` for dead,
// rows joined by newlines (no trailing newline — `console.log` adds one).
function render(grid: number[][], rows: number, cols: number): string {
  let out: string = "";
  let r: number = 0;
  while (r < rows) {
    let line: string = "";
    let c: number = 0;
    while (c < cols) {
      if (grid[r][c] === 1) {
        line = line + "#";
      } else {
        line = line + ".";
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

// ---------------------------------------------------------------------------
// Run it: print each generation, separated by a blank line.
// ---------------------------------------------------------------------------

let grid: number[][] = makeSeedGrid(ROWS, COLS);
let gen: number = 0;
while (gen < GENERATIONS) {
  console.log("Generation " + gen + ":");
  console.log(render(grid, ROWS, COLS));
  console.log("");
  grid = step(grid, ROWS, COLS);
  gen = gen + 1;
}
