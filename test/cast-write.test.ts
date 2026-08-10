/*
 * ASSIGNING through a duck-typed `as` window — the WRITE half of the shape
 * test/as-cast.test.ts pins for reads.
 *
 * `lane-exprloc` found that `(e as { loc?: Loc }).loc` was broken for ALL 30 `Expr`
 * members, the seven that genuinely carry a `loc` included, because the cast never
 * consulted member layout: `loc` is slot 0 of the asserted shape and slot 0 of every
 * `Expr` member is `kind`. A bad READ yields a wrong value. A bad WRITE is strictly
 * worse — it corrupts the DISCRIMINANT, and narrowing on the discriminant is how the
 * whole checker reads unions, so every later `switch (e.kind)` in the program takes the
 * wrong arm. `src/` had three such writes:
 *
 *   checker.ts   `(e.callee as { name: string }).name = mangled`        (retarget)
 *   checker.ts   `(e.callee as { property: string }).property = …`      (retarget)
 *   ownership.ts `(site as { nullOnMove?: boolean }).nullOnMove = true` (analyzeOwnership)
 *
 * `name` is at slot 1 of `Identifier`, `property` at slot 2 of `MemberExpr`, and
 * `nullOnMove` at slot 4 of `Identifier` — every one of them asserted to a ONE-FIELD
 * window, i.e. onto slot 0, i.e. onto `kind`.
 *
 * WHAT ACTUALLY HELD THE LINE, and why it is not something to rely on: the target of an
 * `as` window is an untagged structural record, and an untagged record is IMMUTABLE, so
 * `NT1606` refuses every write through one — including the write the cast rule itself
 * would have allowed. That is a real guarantee and it is pinned below, because it is the
 * only reason these three were refusals rather than live corruption. But it is INCIDENTAL:
 * it is the mutability rule catching a LAYOUT bug, and `@@mutable` records exist precisely
 * to relax it. The three sites are rewritten to tag dispatch — `lane-exprloc`'s pattern —
 * so that when mutation is permitted the store lands on the right slot instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileAndRun, emitIR, expectMatchesNode } from "./harness.ts";

const REPO = resolve(import.meta.dir, "..");

/* ------------------------------------------------------------------ *
 * 1. THE COMPILER RULE. A write through a duck-typed window is refused, whether or not
 *    the window's layout happens to fit. Both halves matter: the mis-slotted one is the
 *    corruption, and the WELL-slotted one is what shows the guarantee is the mutability
 *    rule rather than the cast rule.
 * ------------------------------------------------------------------ */
describe("writing through a duck-typed `as` window", () => {
  test("a MIS-SLOTTED window is refused — the store would land on the discriminant", () => {
    // `name` is slot 1 of the `id` member; the window puts it at slot 0, which is `kind`.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function setName(e: Node, s: string): void { (e as { name: string }).name = s; }
const n: Node = { kind: "id", name: "f" };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toMatch(/NT2001|NT1606/);
  });

  test("even a WELL-slotted window is refused — an `as` target is an untagged record", () => {
    // `{kind,name}` really is slots 0,1 of the `id` member, so the CAST rule accepts it
    // (as-cast.test.ts pins the matching read as legal and free). The write is still
    // refused, by the immutability rule — that is the line that actually held.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function setName(e: Node, s: string): void { (e as { kind: string; name: string }).name = s; }
const n: Node = { kind: "id", name: "f" };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT1606");
  });

  test("...and `@@mutable` on the members does not open it either", () => {
    // The window TYPE is the plain record `{kind:string,name:string}`, and mutability is
    // NOMINAL (docs/decorators.md — a `@@mutable` record compiles to a TAGGED object
    // type). So the cast lands on an untagged type and the receiver's own mutability
    // cannot travel through it. Worth pinning: it is what makes the refusal permanent
    // rather than a thing `@@mutable` quietly turns off.
    let err: unknown;
    try {
      emitIR(`
//@@mutable
type Ident = { kind: "id"; name: string };
//@@mutable
type Num = { kind: "num"; value: number };
type Node = Ident | Num;
function setName(e: Node, s: string): void { (e as { kind: string; name: string }).name = s; }
const n: Node = { kind: "num", value: 42 };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT1606");
  });

  test("a READ through the same mis-slotted window is refused as before", async () => {
    // The read rule is as-cast.test.ts's; asserted here only so the write tests above
    // cannot start passing for the wrong reason if that rule ever moves.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function nameOf(e: Node): string { return (e as { name: string }).name; }
console.log(nameOf({ kind: "id", name: "f" }));
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
    await Promise.resolve();
  });
});

/* ------------------------------------------------------------------ *
 * 2. THE REPLACEMENT. Tag dispatch reads and writes the REAL field, and the tag test
 *    itself costs nothing. Reading is legal today; the write still needs `@@mutable`,
 *    which is the honest state of affairs and is pinned as such.
 * ------------------------------------------------------------------ */
describe("tag dispatch is the sound spelling", () => {
  test("narrowing on the discriminant reaches the field at its real slot", async () => {
    await expectMatchesNode(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
type Node = Ident | Member;
function label(e: Node): string {
  if (e.kind === "Ident") return e.name;
  return e.property;
}
console.log(label({ kind: "Ident", name: "f" }));
console.log(label({ kind: "Member", object: "o", property: "m" }));
`);
  });

  test("narrowing through a DOTTED path works too — `retarget`'s actual shape", async () => {
    // `retarget` never holds its receiver in a local: it reaches it as `e.callee`.
    await expectMatchesNode(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
type Call = { kind: "Call"; callee: Ident | Member };
function calleeName(e: Call): string {
  if (e.callee.kind === "Ident") return e.callee.name;
  return e.callee.property;
}
console.log(calleeName({ kind: "Call", callee: { kind: "Ident", name: "f" } }));
console.log(calleeName({ kind: "Call", callee: { kind: "Member", object: "o", property: "m" } }));
`);
  });

  test("the tag test emits no assertion check at all", () => {
    const ir = emitIR(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
function label(e: Ident | Member): string {
  if (e.kind === "Ident") return e.name;
  return e.property;
}
console.log(label({ kind: "Ident", name: "f" }));
`);
    expect(ir).not.toContain("call void @nt_as_tag");
  });

  test("a `@@mutable` receiver narrowed by its tag CAN be written in place", async () => {
    // The end state the rewrite is aiming at: once the record carries the attribute, the
    // narrowed store lands on the real slot and the discriminant survives.
    const ours = await compileAndRun(`
//@@mutable
type Cell = { kind: "Cell"; name: string };
const c: Cell = { kind: "Cell", name: "f" };
c.name = "f$number";
console.log(c.kind);
console.log(c.name);
`);
    expect(ours.stdout).toBe("Cell\nf$number\n");
    expect(ours.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. `src/` STAYS OUT OF THE SHAPE. The source guard, in the same spirit as the comment
 *    block on `exprLoc`: the pattern reads as harmless and was re-added twice.
 *
 *    Only WRITES are policed. A duck-typed READ is a judgement call the checked-`as`
 *    rule already adjudicates per site (`retainedReceiver`'s window is legitimate), but a
 *    one-field write window has no legitimate use — the field is on slot 0 by
 *    construction, and slot 0 is the tag.
 * ------------------------------------------------------------------ */
describe("src/ does not assign through a duck-typed cast window", () => {
  const FILES = ["src/checker.ts", "src/ownership.ts", "src/codegen.ts", "src/parser.ts", "src/ast.ts", "src/modules.ts", "src/driver.ts"];

  test("no `(x as { … }).f = …` anywhere in src/", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const lines = readFileSync(resolve(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        // `(… as { … }).field =` but not `==`/`=>`, and not inside a comment.
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\bas\s*\{[^}]*\}\s*\)\s*(\??\.)\s*[A-Za-z_$][\w$]*\s*(=[^=>]|\+\+|--|\+=)/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. THE BEHAVIOUR PIN for `retarget`, which is what the rewrite actually risks.
 *
 *    `retarget` points a call at its SPECIALIZATION by rewriting the callee — the whole
 *    `name` for a function call, the `property` tail for a method call. Getting it wrong
 *    changes a MANGLED SYMBOL, which is silent: the program can still print the right
 *    answer while every call site was retargeted to a different name, and what breaks is
 *    whole-program LINKING — which the blocker metric structurally cannot see, since it
 *    reports checker blockers only.
 *
 *    So the pin is on the SYMBOLS, not on stdout: every specialization defined must be
 *    called and every call resolved. Captured from the pre-fix compiler and passing
 *    against it before `src/` was touched, so it is a before/after that can fail.
 * ------------------------------------------------------------------ */
const GENERICS = `
function idf<T>(x: T): T { return x; }
function pair<T>(x: T, y: T): string { return \`\${x}|\${y}\`; }
function firstOf<T>(xs: T[]): T { return xs[0]!; }
class Box {
  v: number = 0;
  tag<T>(x: T): string { return \`tag:\${x}\`; }
  two<T>(x: T, y: number): string { return \`two:\${x}:\${y}\`; }
}
console.log(idf(7));
console.log(idf("s"));
console.log(idf(true));
console.log(pair(1, 2));
console.log(pair("a", "b"));
console.log(pair(false, true));
console.log(firstOf([10, 20, 30]));
console.log(firstOf(["x", "y"]));
console.log(firstOf([true, false]));
console.log(idf<number>(42));
console.log(idf<string>("explicit"));
const b = new Box();
console.log(b.tag(1));
console.log(b.tag("z"));
console.log(b.tag(true));
console.log(b.two(9, 3));
console.log(b.two("w", 4));
function outer<T>(x: T): string { return pair(x, x); }
console.log(outer(3));
console.log(outer("n"));
`;

/** Mangled symbols (`$` never occurs in a source identifier here) defined and called. */
function specSymbols(ir: string): { defines: string[]; calls: string[] } {
  const defines = [...new Set([...ir.matchAll(/^define [^@]*@"?([A-Za-z0-9_$.]+)"?/gm)].map((m) => m[1]!))];
  const calls = [...new Set([...ir.matchAll(/call [^@]*@"?([A-Za-z0-9_$.]+)"?/g)].map((m) => m[1]!))];
  return {
    defines: defines.filter((s) => s.includes("$")).sort(),
    calls: calls.filter((s) => s.includes("$")).sort(),
  };
}

describe("retarget: the specialization a call site is pointed at", () => {
  // Captured from the compiler BEFORE this lane touched src/, and passing against it.
  const EXPECTED = [
    "Box.tag$boolean", "Box.tag$number", "Box.tag$string",
    "Box.two$number", "Box.two$string",
    "firstOf$boolean", "firstOf$number", "firstOf$string",
    "idf$boolean", "idf$number", "idf$string",
    "outer$number", "outer$string",
    "pair$boolean", "pair$number", "pair$string",
  ];

  test("both retarget paths select exactly these 16 symbols", () => {
    const { defines } = specSymbols(emitIR(GENERICS));
    // `Box.*` are the MemberExpr path (property tail rewritten); the rest are the
    // Identifier path (whole name replaced). Both must be exercised or the pin is half a
    // pin — the two branches of `retarget` are separate code.
    expect(defines.filter((s) => s.startsWith("Box."))).toHaveLength(5);
    expect(defines).toEqual(EXPECTED);
  });

  test("every specialization is called and every call resolved", () => {
    // A call site that was NOT retargeted leaves the template name behind, so its
    // specialization is defined and never called — a dangling symbol the linker would
    // drop silently rather than a compile error.
    const { defines, calls } = specSymbols(emitIR(GENERICS));
    expect(calls.filter((s) => !defines.includes(s))).toEqual([]);
    expect(defines.filter((s) => !calls.includes(s))).toEqual([]);
  });

  test("and the program still agrees with node", async () => {
    await expectMatchesNode(GENERICS);
  });
});
