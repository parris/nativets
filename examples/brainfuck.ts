// brainfuck.ts — a complete Brainfuck INTERPRETER written in the nativets subset.
//
// Brainfuck is an eight-instruction Turing-complete language operating on a tape
// of byte cells and a movable data pointer:
//
//   >  move the data pointer right        <  move it left
//   +  increment the cell under it        -  decrement it (both wrap mod 256)
//   .  output the cell as a character     ,  input a character (no stdin → 0)
//   [  if cell == 0, jump past matching ] ]  if cell != 0, jump back to matching [
//
// It runs a hardcoded "Hello World!" program (and a second demo), or — if given a
// program on the command line — interprets that instead. It runs identically under
// plain `node` and under nativets (byte-for-byte), which is exactly why it is a
// good stress test for the CURRENT immutable-data subset (docs/examples.md):
//
//   - Arrays are IMMUTABLE (Stage 29): the tape can't be written with `tape[p] = v`.
//     Every cell write goes through `tape.with(p, v)` (ES2023 — real `node`), which
//     returns a FRESH tape that we reassign into the same `let`. So the entire
//     interpreter loop is a long chain of persistent array updates — a genuine
//     immutability workout — while index reads `tape[p]` stay in place.
//   - The data/instruction pointers and loop depth are scalar `let` locals, which
//     reassign freely; only the heap tape is linear/immutable.
//   - Empty array literals `[]` are unsupported (no element type to infer), so the
//     tape is seeded with a single `[0]` and grown to full size by functional spread.
//   - `String.fromCharCode` turns a cell value into its output character.

// The tape length. Brainfuck classically uses 30000 cells; a few hundred is ample
// for these demos and keeps the persistent-update copying cheap.
function makeTape(size: number): number[] {
  let tape: number[] = [0];
  let i: number = 1;
  while (i < size) {
    tape = [...tape, 0];
    i = i + 1;
  }
  return tape;
}

// Scan forward from `ip` (positioned on a `[`) to the index of its matching `]`.
function matchForward(prog: string, ip: number): number {
  let depth: number = 1;
  let p: number = ip;
  while (depth > 0) {
    p = p + 1;
    const c: string = prog.charAt(p);
    if (c === "[") {
      depth = depth + 1;
    } else if (c === "]") {
      depth = depth - 1;
    }
  }
  return p;
}

// Scan backward from `ip` (positioned on a `]`) to the index of its matching `[`.
function matchBack(prog: string, ip: number): number {
  let depth: number = 1;
  let p: number = ip;
  while (depth > 0) {
    p = p - 1;
    const c: string = prog.charAt(p);
    if (c === "]") {
      depth = depth + 1;
    } else if (c === "[") {
      depth = depth - 1;
    }
  }
  return p;
}

// Wrap a cell value into the 0..255 byte range (mod 256, JS-correct for negatives).
function wrap(v: number): number {
  return ((v % 256) + 256) % 256;
}

// Interpret a Brainfuck program and RETURN everything it writes with `.` as a string.
function run(prog: string): string {
  let tape: number[] = makeTape(256);
  let dp: number = 0; // data pointer
  let ip: number = 0; // instruction pointer
  let out: string = "";
  while (ip < prog.length) {
    const c: string = prog.charAt(ip);
    if (c === ">") {
      dp = dp + 1;
    } else if (c === "<") {
      dp = dp - 1;
    } else if (c === "+") {
      tape = tape.with(dp, wrap(tape[dp] + 1));
    } else if (c === "-") {
      tape = tape.with(dp, wrap(tape[dp] - 1));
    } else if (c === ".") {
      out = out + String.fromCharCode(tape[dp]);
    } else if (c === ",") {
      // No stdin wired up in the demo — an input cell reads as 0 (a common choice).
      tape = tape.with(dp, 0);
    } else if (c === "[") {
      if (tape[dp] === 0) {
        ip = matchForward(prog, ip);
      }
    } else if (c === "]") {
      if (tape[dp] !== 0) {
        ip = matchBack(prog, ip);
      }
    }
    // Any other character is a comment in Brainfuck — ignored.
    ip = ip + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demos: the canonical "Hello World!" program, plus a second that prints "Hi!\n"
// by multiplying up cell values in a loop and emitting each character.
// ---------------------------------------------------------------------------

const HELLO: string =
  "++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.";

// Prints "Hi!\n": build 72='H' via an 8*9 multiply loop, then step the same cell
// by +33 → 105='i', -72 → 33='!', -23 → 10=newline, emitting each.
const HI: string =
  "++++++++[>+++++++++<-]>.+++++++++++++++++++++++++++++++++.------------------------------------------------------------------------.-----------------------.";

const argv: string[] = process.argv.slice(2);
if (argv.length > 0) {
  // Interpret the program supplied on the command line.
  console.log(run(argv[0]));
} else {
  console.log(run(HELLO));
  console.log(run(HI));
}
