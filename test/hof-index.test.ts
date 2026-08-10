/*
 * The INDEX parameter of an inlined HOF callback — `xs.forEach((x, i) => …)`.
 *
 * node passes `(element, index, array)` to `.map`/`.filter`/`.forEach`/`.find`/… and
 * `(acc, element, index, array)` to `.reduce`. We accepted only the shortest prefix of
 * each — `(elem)` and `(acc, elem)` — so every callback that reads its index was refused
 * with `NT2001 ".forEach callback takes (elem)"`. That refusal was SAFE (an unbound `i`
 * would read a slot nothing ever wrote), but it named a TYPE error on a program that is
 * valid TypeScript, and it blocked 17 of the compiler's own functions.
 *
 * The index needs no new machinery: these HOFs do not build closures, they INLINE the
 * arrow body into a loop, and that loop already keeps its counter in a `number` slot
 * (`hofLoop`'s `idx`, `genSearchHof`'s own `idx`). Binding the second parameter is a
 * second `store` from the slot the loop is already stepping.
 *
 * The THIRD parameter (the array itself) stays refused. Zero sites in `src/` use it, and
 * handing the body a second owner of the array the loop is walking is the aliasing this
 * file's neighbours already refuse — so it gets its own message that says which parameter
 * is the problem, rather than the old one that blamed all of them.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

/** `{code, message, hint}` for a program the FRONTEND refuses, or null if it compiles. */
function refusal(source: string): { code: string; message: string; hint?: string } | null {
  try {
    sourceToIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    if (!d) throw e;
    return d;
  }
}

describe("the index parameter is bound to the loop counter", () => {
  test(".forEach((x, i) => …)", async () => {
    const src = `
const xs: number[] = [10, 20, 30];
xs.forEach((x, i) => console.log(x + i));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("10\n21\n32\n");
  });

  test(".map((x, i) => …)", async () => {
    const src = `
const xs: string[] = ["a", "b", "c"];
console.log(xs.map((x, i) => \`\${i}:\${x}\`).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0:a,1:b,2:c\n");
  });

  /* The spelling `src/parser.ts` already recommends in an NT hint — "build a new array
   * without the element: `xs.filter((_, i) => i !== 0)`" — which did not compile until
   * now. A hint whose advice the compiler refuses is the failure test/foreach.test.ts
   * already caught once, so this is that hint's own case. */
  test(".filter((_, i) => …) — the spelling parser.ts's NT hint recommends", async () => {
    const src = `
const xs: number[] = [7, 8, 9];
console.log(xs.filter((_, i) => i !== 0).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("8,9\n");
  });

  test(".flatMap((x, i) => …)", async () => {
    const src = `
const xs: number[] = [1, 2, 3];
console.log(xs.flatMap((x, i) => [x, i]).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("1,0,2,1,3,2\n");
  });

  /* `.every((m, i) => …)` is the exact spelling `src/checker.ts` has a comment APOLOGIZING
   * for not being able to write ("an indexed loop rather than `.every((m, i) => …)`"). */
  test(".some / .every / .findIndex see the index", async () => {
    const src = `
const xs: number[] = [5, 6, 7];
console.log(xs.some((x, i) => x === i + 5));
console.log(xs.every((x, i) => x === i + 5));
console.log(xs.findIndex((x, i) => x - i === 5));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true\ntrue\n0\n");
  });

  /* `.findLast*` walks BACKWARDS, so its index counts DOWN — a forward counter here would
   * be a wrong answer node disagrees with rather than a crash. */
  test(".findLast / .findLastIndex count the index DOWN", async () => {
    const src = `
const xs: number[] = [4, 9, 4, 9];
console.log(xs.findLastIndex((x, i) => x === 4 && i < 3));
console.log(xs.findLast((x, i) => i % 2 === 0));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("2\n4\n");
  });

  /* `.reduce` is the one HOF whose index is NOT parameter 1: node passes
   * `(acc, element, index, array)`, so the index is parameter 2. Getting this wrong by
   * assuming "one rule covers all" would bind `elem` to the index. */
  test(".reduce((acc, x, i) => …) — the index is parameter TWO, not one", async () => {
    const src = `
const xs: number[] = [10, 20, 30];
console.log(xs.reduce((acc, x, i) => acc + x * i, 0));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("80\n"); // 10*0 + 20*1 + 30*2
  });
});

/*
 * The index is a callback-OWNED binding inlined into the enclosing function's single flat
 * frame, which is the exact situation `freshenHofArrow` exists for. Two callbacks both
 * naming their index `i` must get two slots, not one — sharing one would make the inner
 * loop's counter clobber the outer's and read as a wrong number rather than a crash.
 */
describe("each inlining gets its OWN index slot", () => {
  test("a NESTED .map inside a .map — the inner `i` must not clobber the outer one", async () => {
    const src = `
const rows: number[] = [1, 2];
const cols: number[] = [10, 20, 30];
console.log(rows.map((r, i) => cols.map((c, i2) => r * i + c * i2).join("|")).join(" / "));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0|20|60 / 2|22|62\n");
  });

  /* The same nesting with the inner index SHADOWING the outer by name — the harder case,
   * because the outer inlining's rename must stop at the inner arrow that re-binds `i`
   * (`childRenameMap`) and the inner inlining must then claim its own slot. A shared slot
   * here reads as an ordinary wrong number at exit 0, never a crash. */
  test("the inner index may SHADOW the outer one by name", async () => {
    const src = `
const rows: number[] = [1, 2];
const cols: number[] = [10, 20, 30];
console.log(rows.map((r, i) => cols.map((c, i) => r * i + c * i).join("|")).join(" / "));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0|21|62 / 0|22|64\n");
  });

  /* Two SIBLING callbacks reusing the name `i`, over arrays of different element types —
   * the collision `freshenHofArrow`'s own comment names ("addLocal's already-declared guard
   * keeps the FIRST type"). Both indices are numbers here, so a shared slot would not be a
   * type confusion — just the last write winning, which is why node is the judge. */
  test("two sibling callbacks may both call their index `i`", async () => {
    const src = `
const ns: number[] = [1, 2, 3];
const ss: string[] = ["a", "b"];
console.log(ns.map((n, i) => n * i).join(","));
console.log(ss.map((s, i) => \`\${s}\${i}\`).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0,2,6\na0,b1\n");
  });

  /* A BLOCK body, where the index is read after the body has declared locals of its own —
   * `prepHofLocals` runs between the index's `addLocal` and the loop. */
  test("a block-bodied callback reads the index alongside its own locals", async () => {
    const src = `
const xs: string[] = ["x", "y", "z"];
xs.forEach((s, i) => {
  const label: string = \`\${i}-\${s}\`;
  if (i === 1) { return; }
  console.log(label);
});
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0-x\n2-z\n");
  });
});

/*
 * The refusals that remain. The point of each test here is the MESSAGE, not the refusal:
 * the guard being replaced was safe and still misdescribed 17 sites, so a fix that swaps
 * one inaccurate sentence for another has not fixed anything.
 */
describe("the third parameter (the array) stays refused, and says so", () => {
  const WITH_ARRAY = `
const xs: number[] = [1, 2, 3];
xs.forEach((x, i, arr) => console.log(x + i + arr.length));
`;

  test("the message names the ARRAY parameter — not the index, and not the arity", () => {
    const d = refusal(WITH_ARRAY);
    expect(d?.code).toBe("NT1001");
    expect(d?.message).toContain("`array` parameter");
    // The old text ("callback takes (elem)") claimed the index was the problem. It is not,
    // it now compiles, and the new message must not still be blaming it.
    expect(d?.message).not.toContain("takes (elem)");
  });

  test("the hint's advice COMPILES and matches node", async () => {
    expect(refusal(WITH_ARRAY)?.hint).toContain("name the receiver outside the callback");
    const advised = `
const xs: number[] = [1, 2, 3];
xs.forEach((x, i) => console.log(x + i + xs.length));
`;
    const { ours, oracle } = await expectMatchesNode(advised);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
    expect(oracle.stdout).toBe("4\n6\n8\n");
  });
});

/* A callback SHORTER than the element (`xs.map(() => 1)`) was refused before this change
 * and still is. It gets its own message: the shared one told it to "drop the last
 * parameter" and lectured it about an `array` argument it had never written, which is the
 * very defect this lane came to remove, reappearing one arity over. */
describe("a callback that binds fewer than the leading parameters", () => {
  const TOO_FEW = `
const xs: number[] = [1, 2, 3];
console.log(xs.map(() => 1).join(","));
`;

  test("the message is about the MISSING element, not about the array", () => {
    const d = refusal(TOO_FEW);
    expect(d?.code).toBe("NT1001");
    expect(d?.message).toContain("declares 0 parameters");
    expect(d?.message).not.toContain("array");
  });

  test("the hint's advice COMPILES and matches node", async () => {
    expect(refusal(TOO_FEW)?.hint).toContain("(_elem)");
    const advised = `
const xs: number[] = [1, 2, 3];
console.log(xs.map((_elem) => 1).join(","));
`;
    const { ours, oracle } = await expectMatchesNode(advised);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(0);
    expect(oracle.stdout).toBe("1,1,1\n");
  });
});
