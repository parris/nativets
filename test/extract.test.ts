/*
 * `Extract<T, U>` — the largest single self-hosting blocker bucket.
 *
 * WHAT IT WAS. `parseGenericType` mapped `Extract` into the "multi-arg utility types erase
 * to their first (subject) type argument" group alongside `Omit`/`Pick`/`Parameters`. So
 * `Extract<Expr, { kind: "ArrowFunction" }>` WAS the whole 30-member `Expr` union, and
 * every field read on such a parameter was refused by `unionCommonField`'s rule (a field is
 * readable off an un-narrowed union only when it sits at the same slot with the same
 * widened type in every member — `params` is in one member out of thirty). Measured over
 * the linked stage-1 program that was 31 of 136 `NT2001` blockers, the single biggest
 * bucket left, and NOT a narrowing gap: `tsc` sees the member and there is nothing to
 * narrow, because the parameter's declared type is already the member.
 *
 * WHY IT COULD NOT LAND EARLIER, which is the whole reason this file is separate from
 * test/unions.test.ts. `src/` casts INTO these types — `e as Extract<Expr, {kind:"…"}>` is
 * the most common `as` shape in this compiler's own source — and until `481c463` /
 * `619d085` `as` was an unchecked identity retype. Resolving `Extract` would have turned
 * every one of those into a union downcast that reinterprets one member's bytes at another
 * member's layout: the failure that printed `2.12e-314` for `undefined` three separate
 * times in this project. `as` is a CHECKED assertion now (tag load, compare, panic), so
 * the hole no longer widens with the bucket. The mutation proof for that lives in
 * test/as-cast.test.ts; what this file proves is that `Extract` SELECTS rather than
 * reinterprets, so no reinterpretation is involved in the resolution itself.
 *
 * THE RULE. `Extract<T, U>` distributes over `T`'s members and keeps the ones assignable
 * to `U` (TypeScript: `T extends U ? T : never`). A member survives when, for every field
 * of the pattern `U`, the member has a field of the SAME KEY whose type matches — exactly
 * for a string-literal pattern field (that is the tag test), by widened type otherwise.
 * Deliberately NOT slot-sensitive: `Extract` picks members out of a union, it never
 * reinterprets one member as another, so the layout question `objectLayoutFits` answers
 * for `as` does not arise here. One survivor gives the member (tags widened, exactly what
 * narrowing already produces via `unionMemberFor`); several give the narrowed union; none
 * is `never`, which this subset has no representation for and so refuses.
 *
 * SCOPED BY MEASUREMENT. A pattern whose field is NOT a single string literal —
 * `Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>`, which `src/` uses twice — keeps
 * the old erasure to `T`. A union of string-literal types collapses to `string` in
 * `parseTypeInner` long before `Extract` sees it, so the tag values are simply not there
 * to filter on. Erasing to `T` is the conservative direction (a WIDER union refuses more
 * field reads, never fewer), which is why it is a residue rather than a hole. Recorded in
 * docs/divergences.md.
 *
 * ORACLE. `Extract` is erased by node, so every fixture here runs unmodified under node
 * and the assertion is the ordinary stdout + exit-code equality.
 */
import { test, expect, describe } from "bun:test";

import { compileAndRun, emitIR, expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Assert the source is REFUSED with `code`, and that the message mentions `needle` — so a
 *  case cannot pass by being rejected for some unrelated reason. */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

const SHAPE = `type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number; label: string };
`;

describe("Extract<T, U> selects union members", () => {
  test("a single-tag pattern resolves to that member, and its OWN fields are readable", async () => {
    const src = `${SHAPE}
function area(s: Extract<Shape, { kind: "square" }>): number {
  return s.side * s.side;
}
console.log(area({ kind: "square", side: 3, label: "x" }));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("9\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * TWO survivors give the SUB-UNION, and the point of the fixture is what that buys: a
   * field readable off the sub-union that is NOT readable off the full one. `value` is at
   * slot 1 in all three members but `number` in two of them and `string` in the third, so
   * `unionCommonField` refuses it on `Node` — one slot, two ways to interpret the 64 bits,
   * which is the `2.1e-314` class. On `Extract<Node, {value: number}>` the surviving pair
   * agree, so the same read is a single `getelementptr` with one meaning. Nothing in the
   * union machinery had to change for that: `Extract` hands `unionCommonField` a smaller
   * member list and its existing rule answers differently. It also confirms the sub-union
   * is still DISCRIMINATED — the `switch` below narrows inside it — which holds by
   * construction, since a subset of members whose tag is at one index with distinct values
   * keeps both properties.
   */
  test("several survivors give the sub-union, and its common field becomes readable", async () => {
    const src = `type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "neg"; value: number };

function evaluate(n: Extract<Node, { value: number }>): number {
  const raw = n.value;
  switch (n.kind) {
    case "neg": return -raw;
    default: return raw;
  }
}
console.log(evaluate({ kind: "num", value: 7 }));
console.log(evaluate({ kind: "neg", value: 7 }));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("7\n-7\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * NO survivor is TypeScript's `never`, and it is REFUSED rather than erased back to `T`.
   * The erasure is the tempting answer because it is what the code did before and it is
   * always a WIDENING — but it is destructive in the sense NT1033/NT1035 already record.
   * A pattern that selects nothing is a misspelt tag, and answering `Extract<Shape,
   * {kind:"triangle"}>` with the whole `Shape` union turns that one typo into a scatter of
   * field-read refusals in the body below, each blaming a line that is correct.
   */
  test("a pattern that selects nothing is `never` — refused, not erased back to T", () => {
    expectRejected(
      `${SHAPE}
function area(s: Extract<Shape, { kind: "triangle" }>): number { return 1; }
console.log(area({ kind: "circle", r: 1 }));
`,
      "NT1036",
      "selects no member",
    );
  });

  /*
   * THE TWO FALLBACKS, pinned because they are what keeps this from being a widening of
   * the language rather than of one utility type. Neither is a special case in the code —
   * both fall out of `extractType`'s guard — and both answer with `T`, exactly as before.
   *
   * A non-union subject covers `Extract<number, number>` (which is `number` in TypeScript
   * too), an unresolved import, and a generic parameter. A non-object PATTERN covers
   * `Extract<T, string>`. In both cases the old erasure is the conservative direction: a
   * wider type refuses more field reads and permits fewer casts, so it can cost a blocker
   * but never a wrong answer.
   */
  test("a non-union subject and a non-object pattern keep the old erasure to T", async () => {
    const src = `type N = Extract<number, number>;
const a: N = 41;
function id(x: Extract<string, string>): string { return x; }
console.log(a + 1, id("ok"));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("42 ok\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * THE RESIDUE, pinned so it cannot drift silently. A pattern whose field is a UNION of
   * string literals has already lost them: `parseTypeInner` collapses `"circle" | "square"`
   * to `string` (that is what keeps `type Dir = "n" | "s"` a `string`), so by the time
   * `Extract` runs there is nothing to filter on. Every member then matches by widened type
   * and the answer is the whole union — the old erasure, reached by the rule rather than by
   * a special case, and the conservative direction. `src/` writes this shape twice
   * (`Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>`), so it stays supported-as-before
   * rather than refused: a parse-time refusal is fatal for the whole program.
   *
   * The observable consequence is that the reads still need a narrowing, which is what this
   * fixture asserts by DOING the narrowing rather than by asserting a refusal — the refusal
   * message would pin `unionCommonField`'s wording instead of this rule.
   */
  test("a literal-UNION pattern field keeps the erasure — the tags are gone before Extract runs", async () => {
    const src = `${SHAPE}
function describe1(s: Extract<Shape, { kind: "circle" | "square" }>): string {
  switch (s.kind) {
    case "circle": return "r=" + s.r;
    default: return "side=" + s.side;
  }
}
console.log(describe1({ kind: "circle", r: 2 }));
console.log(describe1({ kind: "square", side: 4, label: "q" }));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("r=2\nside=4\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/* ------------------------------------------------------------------ *
 * `e as Extract<T, {kind:"…"}>` — the composition this lane was GATED on.
 *
 * This is the shape `src/` actually writes (eleven times), and it is where resolving
 * `Extract` could have gone wrong rather than merely being refused. While `Extract` erased
 * to `T`, `e as Extract<Expr, {kind:"CallExpr"}>` was `e as Expr` on an `Expr` — an
 * identity retype that emitted nothing. Resolving `Extract` turns every one of them into a
 * union DOWNCAST, which is the direction that reinterprets one member's bytes at another
 * member's slot offsets. `as` became a checked assertion first (`481c463`), which is why
 * these tests can exist; what they add is that the `Extract` SPELLING gets the same
 * treatment as the inline one, byte for byte, rather than slipping past the check because
 * the annotation arrived through a different path.
 * ------------------------------------------------------------------ */
describe("Extract composed with `as` — the src/ idiom", () => {
  test("a CORRECT downcast through Extract works on a borrowed parameter", async () => {
    // A borrowed PARAMETER, not a local: this is the shape that forced the alias-vs-move
    // decision for `as`, because a move model would refuse it with NT1604 and so would
    // reject the very pattern `Extract` exists to serve.
    const src = `${SHAPE}
function area(s: Shape): number {
  const c = s as Extract<Shape, { kind: "square" }>;
  return c.side * c.side;
}
console.log(area({ kind: "square", side: 5, label: "q" }));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("25\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a WRONG downcast through Extract PANICS — it does not read the other member", async () => {
    // The corruption this lane could have re-opened: `label` is a `char *` at the slot
    // `side` occupies, so an unchecked retype returns the pointer as an IEEE-754 double.
    // node erases `as` and prints `NaN`; we panic, the divergence `as` already documents.
    const ours = await compileAndRun(`${SHAPE}
function area(s: Shape): number {
  const c = s as Extract<Shape, { kind: "square" }>;
  return c.side * c.side;
}
console.log(area({ kind: "circle", r: 1 }));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
    expect(ours.stdout).not.toContain("e-31");
  });

  /*
   * The two ROUTES to a member must agree. A value that arrives by narrowing
   * (`if (s.kind === "square")`) and a parameter declared `Extract<Shape, {kind:"square"}>`
   * have to be the same `Ty` — the encoding is a flat string and `===` on it IS type
   * equality, so two spellings of one type is the failure mode this project has hit four
   * times. `unionMemberFor` answers `widenLiteralTys(member)` for the narrowing route, and
   * `extractType` answers the same expression for this one, deliberately.
   *
   * MEASURED, and the honest result is that the widen is DEFENSIVE rather than
   * load-bearing: with `widenLiteralTys` removed from `extractType` this fixture still
   * prints `36 / 0`, test/unions + test/narrowing + test/as-cast stay green (193 tests) and
   * blocker-metric does not move, because the checker widens again at the parameter
   * boundary. It stays for the reason an unexercised widening never can — a second spelling
   * of one type costs nothing to prevent and is expensive to find later — but nobody should
   * believe this line is what makes the fixture pass.
   */
  test("a value narrowed by `switch` is accepted by an Extract-typed parameter", async () => {
    const src = `${SHAPE}
function area(x: Extract<Shape, { kind: "square" }>): number { return x.side * x.side; }
function dispatch(s: Shape): number {
  if (s.kind === "square") return area(s);
  return 0;
}
console.log(dispatch({ kind: "square", side: 6, label: "q" }));
console.log(dispatch({ kind: "circle", r: 1 }));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("36\n0\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the Extract spelling and the inline member spelling emit the SAME IR", () => {
    // The check must not depend on HOW the target type was written. `Extract<Shape,
    // {kind:"square"}>` resolves to the member with its tag widened, which is exactly what
    // `parseType` produces for the inline annotation — so if these two ever diverge, one of
    // the two paths has stopped going through the shared cast machinery.
    const body = (annot: string) => `${SHAPE}
function area(s: Shape): number {
  const c = s as ${annot};
  return c.side * c.side;
}
console.log(area({ kind: "square", side: 5, label: "q" }));
`;
    const viaExtract = emitIR(body(`Extract<Shape, { kind: "square" }>`));
    const viaInline = emitIR(body(`{ kind: "square"; side: number; label: string }`));
    expect(viaExtract).toContain("@nt_as_tag");
    expect(viaExtract).toBe(viaInline);
  });

  /*
   * THE ACTUAL src/ SHAPE, end to end: a RECURSIVE union (members hold `@Expr` back-edges),
   * a helper taking one member by `Extract`, and a dispatcher that `switch`es on the tag and
   * casts into it. That is `Checker.inferCall` / `FnGen.genCall` in miniature, and it is the
   * combination rather than any one piece that is worth pinning — a member of a recursive
   * union is NOT the fully expanded shape (`discriminatedUnion` expands references exactly
   * one level at the member boundary and leaves the ones below folded), so `Extract` has to
   * hand back a member with its back-edges still folded or the two spellings of `Expr`
   * diverge and every `===` on a `Ty` after it is wrong.
   */
  test("a recursive union: Extract selects a member whose fields point back at the union", async () => {
    const src = `type Node =
  | { kind: "lit"; value: number }
  | { kind: "add"; left: Node; right: Node }
  | { kind: "neg"; operand: Node };

function evalAdd(n: Extract<Node, { kind: "add" }>): number {
  return evalNode(n.left) + evalNode(n.right);
}
function evalNode(n: Node): number {
  switch (n.kind) {
    case "lit": return n.value;
    case "neg": return -evalNode(n.operand);
    default: return evalAdd(n as Extract<Node, { kind: "add" }>);
  }
}
const tree: Node = { kind: "add", left: { kind: "lit", value: 4 }, right: { kind: "neg", operand: { kind: "lit", value: 3 } } };
console.log(evalNode(tree));
`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(oracle.stdout).toBe("1\n");
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
