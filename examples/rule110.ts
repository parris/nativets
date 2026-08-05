// rule110.ts — an elementary cellular automaton (Wolfram Rule 110) in the
// nativets subset.
//
// Rule 110 is the famous Turing-complete elementary CA. Each cell's next state
// is a function of its 3-cell neighborhood (left, self, right). The eight
// possible neighborhoods are numbered 0..7 by their bits (left<<2 | self<<1 |
// right); the *rule number* is a bitmask whose bit `p` gives the next state for
// neighborhood `p`. So the whole update is a single bitwise lookup:
//
//     next = (RULE >> neighborhood) & 1
//
// The rule is configurable — change the `RULE` constant below (110 is the
// classic; 30, 90, 184 are other well-known elementary rules). Starting from a
// single live cell at the right edge and evolving downward prints the classic
// self-similar / fractal triangle.
//
// Everything is deterministic (compile-time width / generations / rule, no IO),
// so it is fully node-differential: identical bytes under plain `node` and under
// a compiled nativets binary.
//
// Written in the *current* nativets language subset (see examples/life.ts):
//   - A generation is an IMMUTABLE `boolean[]` (Stage 29): no `.push`, no
//     `row[i] = v`. Each next generation READS the borrowed previous row and is
//     CONSTRUCTED fresh via spread accumulation (`row = [...row, cell]`) — the
//     ideal shape for an immutable model.
//   - Empty array literals `[]` are unsupported (element type can't be inferred),
//     so every accumulator is seeded with its real first element (column 0) and
//     the growth loop starts at index 1.
//   - Array parameters are BORROWS: `step`/`render` read the row they're given
//     but never return it; the fresh row `step` builds is owned and returned. The
//     driver reassigns `row = step(row, …)`, dropping the old generation.
//   - Booleans feed the bitwise rule lookup by mapping each neighbor cell to its
//     bit weight (4 / 2 / 1) via a `?:`; the neighborhood index then indexes the
//     rule number with `>>` and `&`.

// ---------------------------------------------------------------------------
// Configuration — all compile-time constants.
// ---------------------------------------------------------------------------

const WIDTH: number = 63;        // cells per generation
const GENERATIONS: number = 32;  // number of rows to print
const RULE: number = 110;        // the elementary rule number (try 30, 90, 184)

// ---------------------------------------------------------------------------
// Seeding: a single live cell at the right edge.
// ---------------------------------------------------------------------------

// The initial state of column `i`: alive only in the rightmost cell.
function seedCell(i: number, width: number): boolean {
  return i === width - 1;
}

// Build the seed generation functionally: start with column 0, then spread each
// further column onto the accumulator.
function seedRow(width: number): boolean[] {
  let row: boolean[] = [seedCell(0, width)];
  let i: number = 1;
  while (i < width) {
    row = [...row, seedCell(i, width)];
    i = i + 1;
  }
  return row;
}

// ---------------------------------------------------------------------------
// The rule: a single bitwise lookup on the 3-cell neighborhood.
// ---------------------------------------------------------------------------

// The next state of cell `i`, reading the borrowed previous row. Cells beyond
// the edges are treated as dead (0). The neighborhood (left, self, right) is
// packed into an index 0..7, which selects a bit of the rule number.
function nextCell(prev: boolean[], i: number, width: number, rule: number): boolean {
  let left: number = 0;
  if (i - 1 >= 0) {
    if (prev[i - 1]) {
      left = 4;
    }
  }
  let self: number = 0;
  if (prev[i]) {
    self = 2;
  }
  let right: number = 0;
  if (i + 1 < width) {
    if (prev[i + 1]) {
      right = 1;
    }
  }
  const neighborhood: number = left + self + right;
  const bit: number = (rule >> neighborhood) & 1;
  return bit === 1;
}

// Advance one generation, returning a brand-new owned row. The previous row is
// only ever read (borrowed), never mutated.
function step(prev: boolean[], width: number, rule: number): boolean[] {
  let row: boolean[] = [nextCell(prev, 0, width, rule)];
  let i: number = 1;
  while (i < width) {
    row = [...row, nextCell(prev, i, width, rule)];
    i = i + 1;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Rendering: one line per generation, `#` for live and `.` for dead.
// ---------------------------------------------------------------------------

function render(row: boolean[], width: number): string {
  let out: string = "";
  let i: number = 0;
  while (i < width) {
    if (row[i]) {
      out += "#";
    } else {
      out += ".";
    }
    i = i + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run it: print each generation as a row, forming the fractal triangle.
// ---------------------------------------------------------------------------

console.log("Rule " + RULE + ":");
let row: boolean[] = seedRow(WIDTH);
let gen: number = 0;
while (gen < GENERATIONS) {
  console.log(render(row, WIDTH));
  row = step(row, WIDTH, RULE);
  gen = gen + 1;
}
