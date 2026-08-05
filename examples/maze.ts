// maze.ts — a shortest-path MAZE SOLVER (breadth-first search) written in the
// nativets subset.
//
// A hardcoded ASCII maze (`#` wall, `.` open, `S` start, `E` end) is solved with
// BFS to find the length of the shortest path from `S` to `E`, and the maze is
// re-rendered with that path marked by `*`. Everything is deterministic (the maze
// is a compile-time constant, no input), so it is fully node-differential: it
// prints the same bytes under plain `node` and under a compiled nativets binary.
//
// Written in the *current* nativets language subset (docs/examples.md C-a) — and
// BFS is a good stress test for it, because the two mutable data structures BFS
// classically uses (a queue and a visited grid) both have to be expressed
// IMMUTABLY here:
//   - The QUEUE is a `number[]` that is never mutated in place (no `.push`): a new
//     entry is appended by FUNCTIONAL SPREAD into a reassigned local
//     (`queue = [...queue, code]`), and dequeuing just advances a `head` index
//     (the array is only ever read/grown, never shrunk). Each cell is encoded as a
//     single number `r * COLS + c` so the queue stays a flat `number[]` (no nested
//     linear arrays to move out of).
//   - VISITED, DISTANCE and PARENT are PERSISTENT Map/Set keyed by the `"r,c"`
//     string of a cell. `.add`/`.set` return a BRAND-NEW handle (the nativets
//     divergence: Map/Set are immutable) and we reassign the local to it
//     (`visited = visited.add(key)`), so there is no in-place mutation anywhere.
//   - Empty array literals `[]` are unsupported (element type can't be inferred),
//     so every array is seeded with a real first element (`[startCode]`,
//     `[endKey]`) — no sentinel needed.
//   - Grid cells are read INLINE (`maze[r].charAt(c)`); strings are shared/Copy so
//     indexing a `string[]` row and calling a method on it is a borrow, not a move.
//   - No classes; just a top-level BFS over module-level constants.

// ---------------------------------------------------------------------------
// The maze (a compile-time constant). `#` wall, `.` open, `S` start, `E` end.
// Every row is the same width; dimensions are derived, not hardcoded twice.
// ---------------------------------------------------------------------------

const maze: string[] = [
  "#########",
  "#S..#..E#",
  "#.#.#.#.#",
  "#.#...#.#",
  "#.#.#.#.#",
  "#...#...#",
  "#########",
];

const ROWS: number = maze.length;
const COLS: number = maze[0].length;

// Four-neighborhood steps (up, down, left, right). Read by index (a borrow).
const DR: number[] = [-1, 1, 0, 0];
const DC: number[] = [0, 0, -1, 1];

// ---------------------------------------------------------------------------
// Locate S and E. A cell is encoded as the single number `r * COLS + c` so the
// BFS queue can be a flat `number[]`; the `"r,c"` string is the Map/Set key.
// ---------------------------------------------------------------------------

let startCode: number = -1;
let endCode: number = -1;
let sr: number = 0;
while (sr < ROWS) {
  let sc: number = 0;
  while (sc < COLS) {
    const ch: string = maze[sr].charAt(sc);
    if (ch === "S") {
      startCode = sr * COLS + sc;
    }
    if (ch === "E") {
      endCode = sr * COLS + sc;
    }
    sc = sc + 1;
  }
  sr = sr + 1;
}

const startKey: string = Math.floor(startCode / COLS) + "," + (startCode - Math.floor(startCode / COLS) * COLS);
const endKey: string = Math.floor(endCode / COLS) + "," + (endCode - Math.floor(endCode / COLS) * COLS);

// ---------------------------------------------------------------------------
// BFS. The queue is an immutable `number[]` grown by spread and consumed by a
// moving `head` index; visited/dist/parent are persistent (immutable) Map/Set
// reassigned on every update — no in-place mutation of any structure.
// ---------------------------------------------------------------------------

let queue: number[] = [startCode]; // real first element — never an empty literal
let head: number = 0;

let visited = new Set<string>().add(startKey);
let dist = new Map<string, number>().set(startKey, 0);
// parent maps a cell's "r,c" key -> the CODE of the cell we reached it from
// (Map values are numbers in this subset, so we store the parent's code, not its
// key string). The start cell has no parent, encoded as -1.
let parent = new Map<string, number>().set(startKey, -1);

while (head < queue.length) {
  const code: number = queue[head];
  head = head + 1;

  const cr: number = Math.floor(code / COLS);
  const cc: number = code - cr * COLS;
  const key: string = cr + "," + cc;

  if (code === endCode) {
    // Reached the end; its recorded distance is the shortest-path length.
    head = queue.length; // stop the search (no early `break` needed)
  } else {
    // Expand the four neighbors immutably.
    let d: number = 0;
    while (d < 4) {
      const nr: number = cr + DR[d];
      const nc: number = cc + DC[d];
      if (
        nr >= 0 &&
        nr < ROWS &&
        nc >= 0 &&
        nc < COLS &&
        maze[nr].charAt(nc) !== "#"
      ) {
        const nkey: string = nr + "," + nc;
        if (!visited.has(nkey)) {
          visited = visited.add(nkey);
          dist = dist.set(nkey, dist.get(key) + 1);
          parent = parent.set(nkey, code); // reached nkey from cell `code`
          queue = [...queue, nr * COLS + nc]; // functional enqueue (no .push)
        }
      }
      d = d + 1;
    }
  }
}

const answer: number = dist.get(endKey);

// ---------------------------------------------------------------------------
// Reconstruct the path by walking `parent` back from E to S, collecting the
// cells into a persistent Set so the renderer can mark them.
// ---------------------------------------------------------------------------

let pathSet = new Set<string>().add(endKey);
let pc: number = parent.get(endKey); // code of end's parent (-1 if end is start)
while (pc >= 0) {
  const pr: number = Math.floor(pc / COLS);
  const pcol: number = pc - pr * COLS;
  const pkey: string = pr + "," + pcol;
  pathSet = pathSet.add(pkey);
  pc = parent.get(pkey);
}

// ---------------------------------------------------------------------------
// Render: the maze with the shortest path drawn as `*` (S/E kept as themselves).
// ---------------------------------------------------------------------------

let out: string = "";
let r: number = 0;
while (r < ROWS) {
  let line: string = "";
  let c: number = 0;
  while (c < COLS) {
    const ch: string = maze[r].charAt(c);
    const key: string = r + "," + c;
    if (ch === "S" || ch === "E") {
      line = line + ch;
    } else if (pathSet.has(key)) {
      line = line + "*";
    } else {
      line = line + ch;
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

console.log("shortest path: " + answer);
console.log(out);
