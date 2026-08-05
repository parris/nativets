/*
 * A tiny stack-based bytecode VM.
 *
 * A program is a space-separated string of instructions; operands follow their
 * opcode ("PUSH 3"). We tokenize with `.split(" ")` and interpret over an IMMUTABLE
 * operand stack (`number[]`): push = `[...stack, v]`, pop = read `stack[len-1]` then
 * `stack.slice(0, len-1)`. The program counter is a plain mutable `number` local
 * (scalars are fine to reassign).
 *
 * Instruction set:
 *   PUSH n            push the literal n
 *   ADD SUB MUL DIV   pop b, pop a, push (a op b)
 *   DUP               duplicate top of stack        [a]      -> [a, a]
 *   SWAP              swap the top two              [a, b]   -> [b, a]
 *   ROT               rotate the top three          [a,b,c]  -> [b,c,a]
 *   PRINT             print top of stack (leaves it)
 *   JMP t             unconditional jump to token index t
 *   JZ t              pop; if it was 0, jump to token index t, else fall through
 *
 * Authored to run under plain `node` as the differential oracle. Three hardcoded
 * demo programs, deterministic output. Nothing mutates in place — every stack update
 * is a fresh array (`[...]` / `.slice`), matching the immutable-data subset.
 */

// Interpret one program (a token string) and return everything it PRINTs as a string.
function run(program: string): string {
  const toks: string[] = program.split(" ");
  let stack: number[] = [];
  let out = "";
  let pc = 0;

  while (pc < toks.length) {
    const op: string = toks[pc];

    if (op === "PUSH") {
      const v: number = parseFloat(toks[pc + 1]);
      stack = [...stack, v];
      pc += 2;
    } else if (op === "ADD" || op === "SUB" || op === "MUL" || op === "DIV") {
      const b: number = stack[stack.length - 1];
      const s1: number[] = stack.slice(0, stack.length - 1);
      const a: number = s1[s1.length - 1];
      const s2: number[] = s1.slice(0, s1.length - 1);
      let r = 0;
      if (op === "ADD") {
        r = a + b;
      } else if (op === "SUB") {
        r = a - b;
      } else if (op === "MUL") {
        r = a * b;
      } else {
        r = a / b;
      }
      stack = [...s2, r];
      pc += 1;
    } else if (op === "DUP") {
      const t: number = stack[stack.length - 1];
      stack = [...stack, t];
      pc += 1;
    } else if (op === "SWAP") {
      const b: number = stack[stack.length - 1];
      const s1: number[] = stack.slice(0, stack.length - 1);
      const a: number = s1[s1.length - 1];
      const s2: number[] = s1.slice(0, s1.length - 1);
      stack = [...s2, b, a];
      pc += 1;
    } else if (op === "ROT") {
      const c: number = stack[stack.length - 1];
      const b: number = stack[stack.length - 2];
      const a: number = stack[stack.length - 3];
      const rest: number[] = stack.slice(0, stack.length - 3);
      stack = [...rest, b, c, a];
      pc += 1;
    } else if (op === "PRINT") {
      const t: number = stack[stack.length - 1];
      out += t + "\n";
      pc += 1;
    } else if (op === "JMP") {
      pc = parseFloat(toks[pc + 1]);
    } else if (op === "JZ") {
      const t: number = stack[stack.length - 1];
      stack = stack.slice(0, stack.length - 1);
      if (t === 0) {
        pc = parseFloat(toks[pc + 1]);
      } else {
        pc += 2;
      }
    } else {
      // Unknown opcode: skip it (keeps the interpreter total).
      pc += 1;
    }
  }

  return out;
}

// Demo 1 — a straight-line arithmetic expression:  (3 + 4) * 5 - 6  =  29.
const prog1: string = "PUSH 3 PUSH 4 ADD PUSH 5 MUL PUSH 6 SUB PRINT";
console.log("prog1  (3+4)*5-6 =");
console.log(run(prog1));

// Demo 2 — DUP / SWAP semantics.  10 DUP ADD = 20 ; then 20 - (2 SWAP 20 -> 2) = 18.
//   PUSH 10 DUP ADD    -> stack [20], PRINT 20
//   PUSH 2 SWAP SUB    -> stack [20, 2] -> SWAP [2, 20] -> SUB (2 - 20) = -18, PRINT
const prog2: string = "PUSH 10 DUP ADD PRINT PUSH 2 SWAP SUB PRINT";
console.log("prog2  dup/add then swap/sub =");
console.log(run(prog2));

// Demo 3 — a real JMP/JZ LOOP computing factorial(5) = 120.
//   Stack invariant across the loop: [acc, n] (n on top). While n != 0: acc *= n; n -= 1.
//   Token indices (loop head = 4, loop exit = 17):
//     0:PUSH 1:1  2:PUSH 3:5           ; acc=1, n=5
//     4:DUP 5:JZ 6:17                  ; if n==0 -> exit (leaves [acc, 0])
//     7:DUP 8:PUSH 9:1 10:SUB          ; [acc, n, n-1]
//     11:SWAP 12:ROT 13:MUL 14:SWAP    ; -> [acc*n, n-1]
//     15:JMP 16:4                      ; loop
//     17:SWAP 18:PRINT                 ; expose acc under the leftover 0, print it
const prog3: string =
  "PUSH 1 PUSH 5 DUP JZ 17 DUP PUSH 1 SUB SWAP ROT MUL SWAP JMP 4 SWAP PRINT";
console.log("prog3  factorial(5) via a JMP/JZ loop =");
console.log(run(prog3));
