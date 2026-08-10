/*
 * `.find` / `.findLast` OVER AN ARRAY WHOSE ELEMENT IS ALREADY `T | undefined`.
 *
 * WHY THIS IS THE ONE CASE THAT OPENS. `.map` CONSTRUCTS a fresh array that owns its
 * elements; `.at`/`.find` hand back a BORROW of an element the receiver still owns —
 * the refusal's own text ("a heap element would alias its owner") is accurate for
 * `.find` even though it was a red herring for `.map`. So the general widening is not
 * this lane's, and the plain-object element stays refused.
 *
 * `(T | undefined)[]` is different in KIND, not in degree: a nullable is already a heap
 * `[tag, value]` box, and node's `.find` cannot distinguish "found `undefined`" from
 * "found nothing" — both are `undefined`. So the answer on the HIT path is the element
 * box itself and on the MISS path a fresh `undefined` box, and the result type is the
 * element type unchanged. Nothing is allocated on the hit path and nothing is rewrapped,
 * which is why this arm needs no new ownership rule beyond the borrow one below.
 *
 * TWO BUGS THIS PINS, both found by mutation (remove the guard, watch it corrupt):
 *
 *  1. DOUBLE BOXING. `genSearchHof` boxed the element slot unconditionally, so a
 *     `(?ULoc)[]` element — itself a `[tag,value]` pointer — came back as a box
 *     containing a box while the static type said one level. Reading `.line` off it
 *     loaded the inner box's TAG and bitcast it to a double:
 *         node `r 7 14`   nativets `r 1e-323 2.1326037835e-314`   exit 0 on both sides.
 *     That is the exact shape of the compiler's own first blocker,
 *     `e.exprs.map(exprLoc).find(l => l !== undefined)` in src/ast.ts.
 *
 *  2. THE LOST NULLISH ARM. `makeNullable("undefined", el)` computes `baseTy(el)` first,
 *     so on a `(T | null)[]` it rewrapped `?N` as `?U` and the null arm vanished from
 *     the static type. node CAN tell those apart (`x === null` vs `x === undefined`) and
 *     the one-arm `?N`/`?U` encoding cannot carry `T | null | undefined`, so that case is
 *     REFUSED rather than collapsed — the refusal is the honest answer, not a gap.
 *
 * The BORROW rule is the third leg: the hit path hands back a pointer the array still
 * owns, so binding it as an owner (`const h: Loc = hit`) would give the value two owners
 * and free it twice. That is rustc E0507 and we already spell it NT1604 for a `for-of`
 * element over a linear array; this makes `.find` say the same thing.
 *
 * node is the oracle for stdout AND exit code on every runtime case — asserted
 * separately and deliberately, because a double free here presents as a NONZERO exit
 * with CORRECT stdout and this project has shipped exactly that.
 */

import { test, expect, describe } from "bun:test";
import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** stdout AND exit code, both against node. */
async function sameAsNode(src: string) {
  const { ours, oracle } = await expectMatchesNode(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours;
}

/** Refused with `code`, and the message mentions `needle` — so a case meant to pin one
 *  boundary cannot pass by being rejected for some unrelated reason. */
function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic((err as NTError).diag);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

const LOC = `interface Loc { line: number; col: number }
function locOf(n: number): Loc | undefined { return n === 0 ? undefined : { line: n, col: n * 2 }; }
`;

describe(".find over (T | undefined)[]", () => {
  test("the compiler's own blocker shape: .map(...).find(l => l !== undefined)", async () => {
    await sameAsNode(`${LOC}
function first(ns: number[]): Loc | undefined {
  return ns.map((n) => locOf(n)).find((l) => l !== undefined);
}
const r = first([0, 0, 7, 9]);
if (r !== undefined) console.log("r", r.line, r.col);
console.log(first([0, 0]));`);
  });

  test("the found element stays readable, and so does the array it came from", async () => {
    await sameAsNode(`${LOC}
const xs: (Loc | undefined)[] = [undefined, { line: 3, col: 4 }];
const hit = xs.find((l) => l !== undefined);
if (hit !== undefined) console.log("hit", hit.line, hit.col);
console.log("still", xs[1]!.line, xs[1]!.col);
console.log(xs.find((l) => l !== undefined && l.line === 99));`);
  });

  test("moving the found element out is NT1604 — it is a borrow, not a handoff", () => {
    expectRejected(`${LOC}
function run(): void {
  const xs: (Loc | undefined)[] = [undefined, { line: 3, col: 4 }];
  const hit = xs.find((l) => l !== undefined);
  if (hit !== undefined) {
    const h: Loc = hit;
    console.log(h.line);
  }
  console.log(xs[1]!.line);
}
run();`, "NT1604", "borrowed");
  });

  /* The other escape route, and a DIFFERENT consuming position in the ownership pass:
   * an array literal element moves (`ArrayLiteral`), where the case above moves at the
   * declaration (`VarDecl`). node runs this; we refuse it, which is the acceptable
   * direction — the array would hold a pointer its owner frees. */
  test("storing the found element into a container is NT1604 as well", () => {
    expectRejected(`${LOC}
function run(): void {
  const xs: (Loc | undefined)[] = [undefined, { line: 3, col: 4 }];
  const hit = xs.find((l) => l !== undefined);
  const box: (Loc | undefined)[] = [hit];
  if (box[0] !== undefined) console.log(box[0]!.line);
}
run();`, "NT1604", "borrowed");
  });

  test(".findLast gets the same arm, iterating backwards like node", async () => {
    await sameAsNode(`${LOC}
const xs: (Loc | undefined)[] = [{ line: 1, col: 2 }, undefined, { line: 3, col: 4 }];
const last = xs.findLast((l) => l !== undefined);
if (last !== undefined) console.log("last", last.line, last.col);`);
  });

  /*
   * The `@@mutable` accumulator reaches `.find` through the PERSISTENT-VECTOR path
   * (`a->pv`), which `nt_arr_get` reads differently from a flat block — and the loop runs
   * the hit path 100 times, which is where a per-call allocation or a double free would
   * show up as drift rather than as one wrong line.
   */
  test("a built-up accumulator, searched in a loop, stays byte-exact", async () => {
    await sameAsNode(`interface Loc { line: number; col: number }
function build(n: number): (Loc | undefined)[] {
  //@@mutable
  const out: (Loc | undefined)[] = [];
  for (let i = 0; i < n; i++) out.push(i % 3 === 0 ? undefined : { line: i, col: i * 2 });
  return out;
}
const xs = build(40);
const hit = xs.find((l) => l !== undefined && l.line > 30);
if (hit !== undefined) console.log("hit", hit.line, hit.col);
const last = xs.findLast((l) => l !== undefined);
if (last !== undefined) console.log("last", last.line, last.col);
console.log(xs.find((l) => l !== undefined && l.line > 999));
let seen = 0;
for (let k = 0; k < 100; k++) {
  const h = xs.find((l) => l !== undefined && l.line === k);
  if (h !== undefined) seen = seen + h.col;
}
console.log("seen", seen);`);
  });

  test("a nullable SCALAR element needs no borrow rule — it is a boxed copy", async () => {
    await sameAsNode(`
const ns: (number | undefined)[] = [undefined, 7, 9];
const hit = ns.find((n) => n !== undefined);
console.log(hit);
const n: number = hit === undefined ? -1 : hit;
console.log(n, ns[1]);`);
  });
});

describe(".find boundaries that stay refused", () => {
  // THE ARMED TRAP, disarmed. `makeNullable("undefined", "?Nstring")` computes
  // `baseTy` first and answers `?Ustring`, so the null arm vanished with no diagnostic.
  // node tells `null` and `undefined` apart here, so a collapse is a wrong answer.
  test("(T | null)[] is refused because the result needs TWO nullish arms", () => {
    expectRejected(`
const xs: (string | null)[] = ["a", null];
console.log(xs.find((s) => s === null));`, "NT1001", "one nullish arm, not two");
  });

  test("a plain object element is still refused — that one really would alias", () => {
    expectRejected(`interface Loc { line: number; col: number }
const xs: Loc[] = [{ line: 1, col: 2 }];
console.log(xs.find((l) => l.line === 1));`, "NT1001", "alias its owner");
  });

  /*
   * THE HINT IS COMPILED, not just asserted. Two lanes independently found `NT1606`'s
   * hint instructing users to write a silent wrong answer, and one recommended spelling
   * WAS a use-after-free. The trap here is specific and easy to fall into: the obvious
   * rewrite `const hit = xs[i]!` is NT1605 (binding an element is a second owner), so
   * the hint has to say READ THROUGH the index — which is the spelling `fieldType` in
   * src/ast.ts already uses for exactly this reason.
   */
  test("the refusal's own hint compiles and matches node", async () => {
    await sameAsNode(`interface Loc { line: number; col: number }
const xs: Loc[] = [{ line: 1, col: 2 }, { line: 3, col: 4 }];
const i = xs.findIndex((l) => l.line === 3);
if (i >= 0) console.log(xs[i]!.col);
console.log(xs.findIndex((l) => l.line === 99));`);
  });
});
