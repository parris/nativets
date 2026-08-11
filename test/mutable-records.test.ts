/*
 * `@@mutable` on RECORDS — and the `//@@mutable` comment-pragma spelling.
 *
 * Two things live here, both extensions of Stage 45 (`docs/decorators.md`):
 *
 *  1. **`//@@mutable` — the pragma spelling of the same attribute.** `@@mutable` is not
 *     valid TypeScript, so a source file carrying it cannot also be run by `tsc`/`bun`.
 *     That is fatal for the ONE program that must satisfy both toolchains at once: the
 *     compiler's own source, which bun runs today and nativets must compile tomorrow.
 *     A line comment whose entire content is `@@name` lexes to exactly the same tokens
 *     as the bare sigil, so the attribute is invisible to TypeScript and load-bearing to
 *     nativets. node is the oracle DIRECTLY here — the pragma IS a comment to node.
 *
 *  2. **`@@mutable` on a `type`/`interface` declaration** — records that may be assigned
 *     in place, under the SAME ownership rule `@@mutable` classes established: mutation
 *     needs an owned receiver, and a mutable-record borrow may not escape.
 *
 * A `@@mutable` record is a plain TS object, so the oracle is the same source with the
 * attribute stripped (`runWithNodeAttrs`), exactly as for `@@mutable` classes.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAndRun, compileAndRunFile, runWithNode, runWithNodeAttrs, runWithNodeFile, stripAttributes } from "./harness.ts";
import { emitIR, emitIRAsan } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Compile-only: return the diagnostic code a source is rejected with (or null). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** Both sides must agree, and the program must actually print something. */
async function expectMatches(source: string, oracle: { stdout: string; exitCode: number }) {
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  expect(ours.stdout.length).toBeGreaterThan(0);
}

describe("the `//@@mutable` pragma — one source, two toolchains", () => {
  test("a pragma-decorated class behaves exactly like the sigil form (node is the oracle DIRECTLY)", async () => {
    const source = `
//@@mutable
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;
a.bump();
a.bump();
console.log(b.get());
`;
    // The pragma is a COMMENT to node — no stripping needed, which is the whole point.
    await expectMatches(source, runWithNode(source));
  });

  test("the pragma and the sigil produce byte-identical IR", () => {
    const body = `
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
a.bump();
console.log(a.get());
`;
    expect(emitIR("//@@mutable\n" + body)).toBe(emitIR("@@mutable\n" + body));
  });

  test("an unknown pragma is still NT1023, never a comment", () => {
    const r = rejectionOf("//@@mutabel\nclass C { x: number = 1; }\nconsole.log(1);\n");
    expect(r?.code).toBe("NT1023");
  });

  test("an ordinary comment that merely MENTIONS @@mutable stays a comment", async () => {
    const source = `
// the @@mutable attribute is documented in docs/decorators.md
const x: number = 1;
console.log(x);
`;
    await expectMatches(source, runWithNode(source));
  });
});

describe("`@@mutable` on a record type", () => {
  test("a field of a mutable record can be assigned in place", async () => {
    const source = `
@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = 41;
c.n = c.n + 1;
console.log(c.n);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("every handle observes the mutation (the point of `@@mutable`)", async () => {
    const source = `
@@mutable
type Cell = { n: number; tag: string };
const c: Cell = { n: 1, tag: "a" };
const alias = c;
c.n = 7;
c.tag = "b";
console.log(alias.n, alias.tag);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("`o.f++` / compound assignment on a mutable record", async () => {
    const source = `
@@mutable
type Cell = { n: number; s: string };
const c: Cell = { n: 1, s: "x" };
c.n++;
c.n += 10;
c.s += "y";
console.log(c.n, c.s);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("an `interface` can carry the attribute too", async () => {
    const source = `
@@mutable
interface Node2 { kind: string; depth: number }
const n: Node2 = { kind: "root", depth: 0 };
n.depth = 3;
n.kind = "leaf";
console.log(n.kind, n.depth);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("the pragma spelling works on a record too (node runs it unchanged)", async () => {
    const source = `
//@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = 99;
console.log(c.n);
`;
    await expectMatches(source, runWithNode(source));
  });

  test("mutation through a helper that OWNS the record (a factory + local mutation)", async () => {
    const source = `
@@mutable
type Acc = { total: number };
function sum(xs: number[]): number {
  const a: Acc = { total: 0 };
  for (const x of xs) { a.total = a.total + x; }
  return a.total;
}
console.log(sum([1, 2, 3, 4]));
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("a mutable record nested in an ordinary structure still reads back", async () => {
    const source = `
@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = 5;
console.log(JSON.stringify(c));
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });
});

describe("undecorated records stay immutable (Stage 29 is unchanged)", () => {
  test("`o.f = v` on a plain record is still NT1606, with the spread hint", () => {
    const r = rejectionOf(`
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = 2;
console.log(c.n);
`);
    expect(r?.code).toBe("NT1606");
    expect(r?.hint).toContain("{ ...o, f: v }");
  });

  test("`o.f++` on a plain record is still NT1606", () => {
    const r = rejectionOf(`
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n++;
console.log(c.n);
`);
    expect(r?.code).toBe("NT1606");
  });

  test("a plain object literal binding is still immutable", () => {
    const r = rejectionOf(`const o = { a: 1 };\no.a = 2;\nconsole.log(o.a);\n`);
    expect(r?.code).toBe("NT1606");
  });

  test("mutability is NOMINAL: a structurally identical undecorated type is NOT mutable", () => {
    // `Cell` and `Frozen` have the same shape. If mutability were carried by the SHAPE
    // the compiler could not tell them apart and `f.n = 2` would silently compile.
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
type Frozen = { n: number };
const f: Frozen = { n: 1 };
f.n = 2;
console.log(f.n);
`);
    expect(r?.code).toBe("NT1606");
  });
});

describe("ownership: only the owner may mutate a record (same rule as `@@mutable` classes)", () => {
  // WAS NT1607, now ACCEPTED — see "NT1607's parameter / for-of arm" below. The opt-in is
  // NOMINAL and therefore part of the signature, so `tick(c: Cell)` announces "may mutate"
  // at the call site, which is what the arm existed to keep visible.
  test("a by-borrow PARAMETER of a mutable record is ACCEPTED (piece 3)", async () => {
    const source = `
@@mutable
type Cell = { n: number };
function tick(c: Cell): number { c.n = c.n + 1; return c.n; }
const c: Cell = { n: 1 };
console.log(tick(c));
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("NT1607 — assigning a field through an ALIAS", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
const b = c;
b.n = 5;
console.log(c.n);
`);
    expect(r?.code).toBe("NT1607");
  });

  // WAS NT1607, now ACCEPTED — same arm. The element is still a BORROW (the array owns it
  // and frees it), so the three obligations are unchanged; only exclusivity is given up.
  test("a `for-of` element of a mutable record is ACCEPTED (piece 3)", async () => {
    const source = `
@@mutable
type Cell = { n: number };
const cells: Cell[] = [{ n: 1 }, { n: 2 }];
for (const c of cells) { c.n = 0; }
console.log(cells[0].n);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("NT1607 — assigning a field of a CONTAINER ELEMENT", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
const cells: Cell[] = [{ n: 1 }];
cells[0].n = 9;
console.log(cells[0].n);
`);
    expect(r?.code).toBe("NT1607");
  });

  test("NT1604 — a mutable-record ALIAS may not escape its owner", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
function leak(): Cell {
  const c: Cell = { n: 1 };
  const b = c;
  return b;
}
console.log(leak().n);
`);
    expect(r?.code).toBe("NT1604");
  });

  test("an aliased mutable record is still dropped exactly once (no double free)", async () => {
    // Behavioral (node has no `__objLive`): the ownership pass makes `const b = c` a
    // BORROW, so the record has exactly one owner and is freed exactly once.
    const r = await compileAndRun(`
@@mutable
type Cell = { n: number };
function scope(): number {
  const c: Cell = { n: 1 };
  const b = c;
  c.n = 7;
  return b.n;
}
console.log(scope());
console.log(__objLive());
`);
    expect(r.stdout).toBe("7\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("NT1602 — reassigning an owner that is still aliased", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
let c: Cell = { n: 1 };
const b = c;
c = { n: 2 };
console.log(b.n);
`);
    expect(r?.code).toBe("NT1602");
  });

  test("check-pass: reading through any handle is always fine", async () => {
    const source = `
@@mutable
type Cell = { n: number };
function read(c: Cell): number { return c.n; }
const c: Cell = { n: 1 };
c.n = 4;
const b = c;
console.log(read(c), read(b), b.n);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });
});

describe("`delete o.k`", () => {
  test("still refused on a mutable record — a record's shape is its TYPE", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number; s: string };
const c: Cell = { n: 1, s: "x" };
delete c.s;
console.log(c.n);
`);
    expect(r?.code).toBe("NT1606");
    // The hint must name the mutable-record situation, not just repeat the generic advice.
    expect(r?.hint).toContain("optional");
  });
});

describe("across modules — the shape self-hosting needs", () => {
  /** Write a module graph to a temp dir and run it both ways. */
  async function runGraph(files: Record<string, string>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "nts-mutrec-"));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      const entry = join(dir, "main.ts");
      const ours = await compileAndRunFile(entry);
      // The oracle needs the attribute stripped; write a parallel node-runnable copy.
      const ndir = mkdtempSync(join(tmpdir(), "nts-mutrec-node-"));
      try {
        for (const [name, text] of Object.entries(files)) writeFileSync(join(ndir, name), stripAttributes(text));
        const oracle = runWithNodeFile(join(ndir, "main.ts"));
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
        expect(ours.stdout.length).toBeGreaterThan(0);
      } finally { rmSync(ndir, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("a `@@mutable` record declared in one module is mutated in another", async () => {
    // This is EXACTLY the compiler's own shape: the record types live in `ast.ts` and the
    // in-place field writes live in `checker.ts` / `ownership.ts`. The attribute has to
    // survive the module linker (which renames a non-entry module's tags) for that to work.
    await runGraph({
      "ast.ts": `
@@mutable
export interface Sig { ret: string; arity: number }
export function makeSig(): Sig { return { ret: "?", arity: 0 }; }
`,
      "main.ts": `
import { makeSig } from "./ast.ts";
import type { Sig } from "./ast.ts";
const s: Sig = makeSig();
s.ret = "number";
s.arity = 2;
console.log(s.ret, s.arity);
`,
    });
  });

  test("two modules may each declare their own `Cell` (tags are renamed per module)", async () => {
    await runGraph({
      "a.ts": `
@@mutable
export type Cell = { v: number };
export function mk(): Cell { const c: Cell = { v: 1 }; c.v = 10; return c; }
`,
      "b.ts": `
@@mutable
export type Cell = { v: string };
export function mk2(): Cell { const c: Cell = { v: "x" }; c.v = "yy"; return c; }
`,
      "main.ts": `
import { mk } from "./a.ts";
import { mk2 } from "./b.ts";
console.log(mk().v, mk2().v);
`,
    });
  });
});

describe("the mechanical desugaring the oracle relies on", () => {
  test("`stripAttributes` leaves a pragma alone (it is already valid TS)", () => {
    expect(stripAttributes("//@@mutable\ntype C = { n: number };\n")).toBe("//@@mutable\ntype C = { n: number };\n");
  });

  test("`stripAttributes` removes the sigil form ahead of a type", () => {
    expect(stripAttributes("@@mutable\ntype C = { n: number };\n")).toBe("type C = { n: number };\n");
  });
});

/*
 * PIECE 1 — a `@@mutable` record may be a DISCRIMINATED-UNION member.
 *
 * `discriminatedUnion` required `classTag(a) === undefined` of every arm. That clause
 * dates to SH2 behavior 1, when the only `classTag` carrier was a CLASS instance — and
 * it is VACUOUS for that subject: a class field annotation goes through `parseType`,
 * which WIDENS a string-literal type, so a class instance can never carry the
 * literal-typed discriminant `unionDiscriminant` demands. Removed outright, a union of
 * two classes still fails one step later with "not string-literal typed".
 *
 * Its only LIVE effect was to block a `@@mutable` RECORD, which did not exist when it
 * was written. Record fields go through `parseTypeInner`, which KEEPS literal types, so
 * a tagged record is a perfectly good member: there is no box (SH2), a union value IS
 * the member's object block, and a tagged block has the same slots as an untagged one.
 *
 * The relaxation is narrow on purpose — a tag is admitted only when it names a
 * `@@mutable` record. A CLASS-tagged arm keeps the byte-identical general-union refusal
 * it has today rather than falling through to a different message.
 */
describe("a `@@mutable` record as a discriminated-union member (piece 1)", () => {
  test("one tagged member: the union declares, narrows and runs", async () => {
    const source = `
//@@mutable
interface Num { kind: "Num"; n: number }
interface Str { kind: "Str"; s: string }
type E = Num | Str;
const e: E = { kind: "Num", n: 41 };
if (e.kind === "Num") console.log("num", e.n); else console.log("str", e.s);
`;
    await expectMatches(source, await runWithNode(source));
  });

  test("a tagged member of a RECURSIVE union — the hoist has to SHARE the tag set", async () => {
    // The case piece 1 nearly shipped broken, and the one that matters: src/ast.ts's `Expr`
    // and `Stmt` are RECURSIVE unions, so they are resolved by `hoistTypeDecls`, which
    // re-parses each declaration in a FRESH sub-Parser. That sub-parser has never seen the
    // `//@@mutable` on some OTHER declaration in the file, so `discriminatedUnion` asked an
    // EMPTY `mutableRecords` whether the tagged arm was a record, said no, and fell back to
    // the general-union refusal — which stalls the whole cycle:
    //
    //   NT1030 recursive type 'Expr' ... NOTE ... what is left is not recursion but
    //   [NT1009] general union type 'Num{kind:string,n:number} | @Neg'
    //
    // A NON-recursive union never goes through the hoist, so the test above passes either
    // way. The set is now shared by reference, exactly as `recTypes` already was.
    const source = `
//@@mutable
interface Num { kind: "Num"; n: number }
interface Neg { kind: "Neg"; operand: Expr }
type Expr = Num | Neg;
const e: Expr = { kind: "Num", n: 1 };
console.log(e.kind);
`;
    await expectMatches(source, await runWithNode(source));
  });
});

/*
 * PIECE 2 — a `@@mutable` RECURSIVE record, split at the FIELD.
 *
 * `@@mutable` + recursive used to be refused at the DECLARATION (`recursiveMutableError`).
 * The reason was never memory safety — it is that in-place mutation of a self-containing
 * value can close a CYCLE, and every walk here assumes a tree. VERIFIED, not taken on
 * faith, with the declaration refusal neutered:
 *
 *     const a: Node = { n: 1, next: null };
 *     const alias = a;                        // an ALIAS survives the move below
 *     a.next = a;                             // owned receiver, so nothing refuses it
 *     console.log(alias);
 *     node     -> `<ref *1> { n: 1, next: [Circular *1] }`
 *     nativets -> `Node { n: 1, next: Node { n: 1, next: [Node] } }`, exit 0
 *
 * Depth-limited, so NOT a hang — but a silent wrong answer, which is worse than a
 * refusal. (`JSON.stringify` and `structuredClone` of a recursive type are already
 * refused, NT1005 / NT1002, so `console.log` is the whole exposure.) Note the obvious
 * spellings are ALREADY blocked by the value side — `x.next = y` with `y` a parameter is
 * NT1604, and with `y` an owned local it MOVES `y` — and the ALIAS route above defeats
 * both, which is exactly why a rule was needed rather than an argument.
 *
 * So the declaration is allowed and the refusal moves to the ASSIGNMENT of a
 * CYCLE-CAPABLE field: one whose type can type-reach the receiver's own tag.
 */
describe("a `@@mutable` RECURSIVE record — split at the field (piece 2)", () => {
  test("a NON-recursive field of a recursive `@@mutable` record may be assigned", async () => {
    const source = `
//@@mutable
interface Node { n: number; label: string; next: Node | null }
const a: Node = { n: 1, label: "a", next: null };
a.n = 41;
a.label = "seen";
console.log(a.n, a.label);
`;
    await expectMatches(source, await runWithNode(source));
  });
});

describe("the cycle rule — which field of a recursive `@@mutable` record is refused", () => {
  test("assigning the RECURSIVE field is refused (this is the write that closes a cycle)", () => {
    const r = rejectionOf(`
//@@mutable
interface Node { n: number; next: Node | null }
const a: Node = { n: 1, next: null };
const b: Node = { n: 2, next: null };
a.next = b;
console.log(a.n);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'next' of '@@mutable Node' is a RECURSIVE field");
  });

  test("an ARRAY of the recursive type IS the cycle rule now, and it names the array type", () => {
    // This test used to assert `NT1001 arrays of @Node` and said so as a PIN: the
    // reachability scan already saw through `[]` (`@Node[]` mentions `@Node`), but an array
    // of a recursive type was refused by a nearer, unrelated gate — `arrayElementOk` had no
    // `@N` arm — and it asked the lane that implemented `@Node[]` to come back here and
    // check that the cycle rule carried the shape. It does: with the element arm added
    // (a back-edge is one pointer slot like every other object element), the NEARER gate is
    // gone and the refusal is the RIGHT one, naming `@Node[]` as the cycle-capable type.
    const r = rejectionOf(`
//@@mutable
interface Node { n: number; kids: Node[] }
const a: Node = { n: 1, kids: [] };
a.kids = [];
console.log(a.n);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'kids' of '@@mutable Node' is a RECURSIVE field");
    expect(r?.message).toContain("'@Node[]'"); // the ARRAY type, not the element
  });

  test("reachability is TRANSITIVE and MUTUAL — B never names A, but reaches it", () => {
    // `A.b: B` and `B.a: A | null`. Writing `x.b` can close an A -> B -> A cycle, so it is
    // refused even though `B` is not spelled anywhere in `A`'s own recursion.
    const r = rejectionOf(`
//@@mutable
interface A { tag: string; b: B }
//@@mutable
interface B { n: number; a: A | null }
const y: B = { n: 2, a: null };
const x: A = { tag: "x", b: y };
x.b = { n: 3, a: null };
console.log(x.tag);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'b' of '@@mutable A'");
  });

  test("a NON-recursive `@@mutable` record is completely unaffected (the fixpoint is empty)", async () => {
    const source = `
//@@mutable
interface Cell { n: number }
const c: Cell = { n: 1 };
c.n = 41;
console.log(c.n);
`;
    await expectMatches(source, await runWithNode(source));
  });

  test("mutating a recursive record adds NO leak and NO double free (counts match the control)", async () => {
    // Measured against a CONTROL rather than against zero. A record with a NULLABLE field
    // already leaks one block without any mutation at all — the `?N` tag/value box is an
    // allocation and drop is SHALLOW (the standing Phase-C `array/object ELEMENTS` item in
    // ROADMAP.md, reproducible on an undecorated `interface P { q: number | null }`). So
    // zero is the wrong bar here; "identical to not mutating" is the right one, and it is
    // the statement that actually rules out a double free or a new leak.
    const body = (mutate: string) => `
//@@mutable
interface Node { n: number; label: string; next: Node | null }
function scope(): string {
  const a: Node = { n: 1, label: "a", next: null };
  const alias = a;
${mutate}
  return alias.label;
}
console.log(scope());
console.log(__objLive(), __arrLive());
`;
    const control = await compileAndRun(body(""));
    const mutated = await compileAndRun(body(`  a.label = "mutated";\n  a.n = 7;`));
    expect(control.stdout).toBe("a\n1 0\n");
    expect(mutated.stdout).toBe("mutated\n1 0\n"); // same counts, mutation observed via the alias
    expect(mutated.exitCode).toBe(0);
    expect(control.exitCode).toBe(0);
  });
});

/*
 * PIECE 4 — the CLASS spelling, split at the FIELD as well.
 *
 * Piece 2 split the RECORD case and left the class declaration refused wholesale, on the
 * stated ground that "a class's mutation goes through `this.f = v` inside a method, where
 * the receiver is not a binding this rule can reason about". That reason does not survive
 * contact with the code: `checkCycleCapableField` is a TYPE-level rule — it takes the
 * receiver's type, the field name and the field's type, and asks whether the field can
 * type-reach the receiver's own tag. `this` has a perfectly good type (the class's own
 * instance shape, `classTag`-tagged), so the rule reads it exactly as it reads `a.next`.
 * Nothing about it needs a binding. The only thing standing between the two spellings was
 * the `!e.viaThis` guard on the call site.
 *
 * MEASURED with the declaration refusal neutered, not argued:
 *   - `//@@mutable class S { vars = new Map(); parent: S | null = null;
 *      declare(k, v) { this.vars = this.vars.set(k, v) } }` — compiles, runs, and matches
 *     node exactly. Nothing about it can close a cycle: `parent` is never written.
 *   - `//@@mutable class N { next: N | null = null; loop() { this.next = this } }` —
 *     compiles and prints `N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }`
 *     where node prints `<ref *1> N { v: 7, next: [Circular *1] }`. The corruption is
 *     real, so SOMETHING has to refuse — but only that one write.
 *
 * THE CONSTRUCTOR IS NOT THE SAME QUESTION, and it cannot simply inherit the rule. A
 * field initializer (`next: N | null = null`) and a parameter property
 * (`constructor(private parent: S | null = null)`) both DESUGAR into `this.<field> = v`
 * in the constructor body, and both write the recursive field. Refusing those would put
 * the declaration back where it was under a different code — vacuous.
 *
 * They are also genuinely safe, and for a reason, not by luck: a constructor writes into
 * a FRESH block that nothing else can reach yet, so the assigned value cannot already
 * point at it. The one escape is naming the fresh block itself, and `this` is the only
 * name it has — VERIFIED both ways:
 *   - `constructor() { this.next = this }` under a neutered guard produced the same
 *     unfolded nesting as the method spelling, so the guard is NECESSARY;
 *   - `constructor() { const t = this; this.next = t }` is already NT1604 ("cannot move
 *     out of `t`: it is borrowed"), so the aliased spelling cannot reach the hole.
 * So the constructor carve-out is "unless the value mentions `this`", which is a
 * syntactic scan of one expression tree — no fixpoint, nothing to diverge.
 *
 * UNDECORATED classes are untouched, deliberately. Their setter COPIES the instance
 * (Stage 29), so `this.next = this` there stores the ORIGINAL into a copy and no cycle
 * exists; `RmPlain2` above returns `7 false` on both sides. The new rule fires only when
 * the receiver is `@@mutable`, which is exactly when the write lands in place.
 */
describe("a `@@mutable` RECURSIVE class — split at the field (piece 4)", () => {
  test("a recursive `@@mutable` class DECLARES, and a NON-recursive field mutates in place", async () => {
    // `Scope` in src/checker.ts, in miniature: `parent` makes it recursive and is never
    // written after construction; everything the methods touch is a non-recursive field.
    const source = `
//@@mutable
class Scope {
  n: number = 0;
  label: string = "root";
  parent: Scope | null = null;
  bump(): void { this.n++; }
  rename(s: string): void { this.label = s; }
}
const s = new Scope();
s.bump();
s.bump();
s.rename("inner");
console.log(s.n, s.label, s.parent === null);
`;
    await expectMatches(source, runWithNode(source));
  });

  test("`this.next = this` in a METHOD is refused — the write that actually closes the cycle", () => {
    // The mutation proof for the whole lane. With the old declaration refusal removed and
    // nothing put in its place, this exact program compiled and printed
    //   RmNode { v: 7, next: RmNode { v: 7, next: RmNode { v: 7, next: [RmNode] } } }
    // where node prints `<ref *1> RmNode { v: 7, next: [Circular *1] }` — exit 0 on both
    // sides, so a silent wrong answer. The refusal is now the RECORD's, at the field.
    const r = rejectionOf(`
//@@mutable
class Node {
  v: number = 7;
  next: Node | null = null;
  loop(): void { this.next = this; }
}
const a = new Node();
a.loop();
console.log(a.v);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'next' of '@@mutable Node' is a RECURSIVE field");
  });

  test("`this.next = this` in the CONSTRUCTOR is refused too — the carve-out is not a hole", () => {
    // A constructor is exempt because it writes into a block nothing else can reach. That
    // stops being true the moment the value NAMES the block, and this spelling produced
    // the identical unfolded nesting under a neutered guard. Same code, same message.
    const r = rejectionOf(`
//@@mutable
class Node {
  v: number = 1;
  next: Node | null = null;
  constructor() { this.v = 7; this.next = this; }
}
const a = new Node();
console.log(a.v);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'next' of '@@mutable Node' is a RECURSIVE field");
  });

  test("a PARAMETER PROPERTY of the recursive type still constructs — `Scope`'s own spelling", async () => {
    // `constructor(private parent: Scope | null = null)` desugars to a constructor write of
    // the RECURSIVE field. If the carve-out did not exist this would be refused, the class
    // would be undeclarable, and the split would be vacuous — the failure mode this lane
    // was warned about by name. `child()` builds the chain, which is a TREE: children point
    // up, nothing points down.
    const source = `
//@@mutable
class Scope {
  n: number = 0;
  parent: Scope | null;
  constructor(parent: Scope | null = null) { this.parent = parent; }
  bump(): void { this.n++; }
}
const root = new Scope();
root.bump();
const kid = new Scope(root);
console.log(kid.n, kid.parent === null, root.n);
`;
    await expectMatches(source, runWithNode(source));
  });

  test("an UNDECORATED recursive class is untouched — its setter copies, so there is no cycle", async () => {
    // The reason the new rule is gated on `@@mutable` rather than applied to every
    // `this.f = v`. An ordinary class's field-assigning method copy-on-writes (Stage 29),
    // so `this.next = this` puts the ORIGINAL inside a fresh copy — a tree, one level deep.
    const source = `
class Plain {
  v: number = 7;
  next: Plain | null = null;
  loop(): Plain { this.next = this; return this; }
}
const a = new Plain();
const b = a.loop();
console.log(b.v, b.next === null);
`;
    await expectMatches(source, runWithNode(source));
  });

  test("mutating a recursive `@@mutable` CLASS adds no leak and no double free (vs the control)", async () => {
    // The same bar the record case set, for the same reason: a recursive class has a
    // nullable field, and a `?N` tag/value box is an allocation that shallow drop never
    // frees, so ZERO is the wrong number to measure against. "Identical to not mutating"
    // is the statement that rules out a double free or a NEW leak, and it is the one that
    // matters — the ownership line is that a leak is acceptable and a use-after-free is
    // not. A chain is built and dropped here, so both the parent link and the mutation
    // are in scope of the count.
    const body = (mutate: string) => `
//@@mutable
class Node {
  n: number = 0;
  label: string = "a";
  parent: Node | null;
  constructor(parent: Node | null = null) { this.parent = parent; }
}
function scope(): string {
  const root = new Node();
  const alias = root;
${mutate}
  return alias.label;
}
console.log(scope());
console.log(__objLive(), __arrLive());
`;
    const control = await compileAndRun(body(""));
    const mutated = await compileAndRun(body(`  root.label = "mutated";\n  root.n = 7;`));
    expect(control.exitCode).toBe(0);
    expect(mutated.exitCode).toBe(0);
    // Same counts on both sides: the mutation allocated nothing and freed nothing extra.
    expect(mutated.stdout.split("\n")[1]).toBe(control.stdout.split("\n")[1]);
    expect(control.stdout.split("\n")[0]).toBe("a");
    expect(mutated.stdout.split("\n")[0]).toBe("mutated"); // observed through the alias
  });

  /*
   * The sanitizer gate. `__objLive()` above answers the LEAK half; this one answers the
   * half that is not negotiable — a use-after-free or a double free. It is built through
   * `emitIRAsan`, NOT `emitIR`, and that distinction is the whole point: ASan only rewrites
   * functions carrying `sanitize_address`, and until that attribute was emitted a plain
   * build instrumented `runtime/*.c` and not one instruction nativets generated — catching
   * double frees but BLIND to a stale read. The parent chain here is built, mutated and
   * dropped 200 times, so every drop path this lane newly admits is exercised.
   */
  test("ASan + UBSan: a recursive `@@mutable` class churns with no double free or stale read", () => {
    const CHURN = `
//@@mutable
class Node {
  n: number = 0;
  label: string = "a";
  parent: Node | null;
  constructor(parent: Node | null = null) { this.parent = parent; }
  bump(): void { this.n++; }
  rename(s: string): void { this.label = s; }
}
function chain(i: number): number {
  const root = new Node();
  root.bump();
  root.rename("root");
  const kid = new Node(root);
  kid.bump();
  kid.rename("kid");
  return kid.n + kid.label.length + (i % 2);
}
let n = 0;
for (let i = 0; i < 200; i = i + 1) { n = n + chain(i); }
console.log(n);
console.log(__arrLive());`;
    const dir = mkdtempSync(join(tmpdir(), "nativets-recmutasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIRAsan(CHURN));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        ll, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      const run = spawnSync(bin, [], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      expect(run.stderr).not.toContain("AddressSanitizer");
      expect(run.stderr).not.toContain("runtime error");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("900\n0\n"); // node agrees on 900
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/*
 * PIECE 3 — NT1607's PARAMETER / `for-of` arm is dropped for a `@@mutable` RECORD.
 *
 * The opt-in travels with the NOMINAL type, which is part of the signature, so the
 * calling convention stays visible at the call site — that is the objection that killed
 * inferring it. `function tick(c: Cell)` says "may mutate" in its own type.
 *
 * SOUNDNESS, which is better than it looks. The three obligations all already held:
 *   - a borrow never FREES, so the caller still drops exactly once (no double free);
 *   - the assigned VALUE is consumed — storing a value the callee owns into the caller's
 *     block MOVES it, which is the rule `.push` needed for the same reason;
 *   - the OVERWRITTEN value is leaked, not freed, which is required — dropping it would
 *     free something an alias may still hold.
 * What is lost is EXCLUSIVITY, which docs/decorators.md Decision 3 already disclaims
 * ("every alias observes the mutation"). An ALIAS receiver is still refused, and so is
 * any receiver that is not a binding at all.
 */
describe("NT1607's parameter / for-of arm, dropped for a `@@mutable` record (piece 3)", () => {
  test("a by-borrow PARAMETER of a `@@mutable` record may be mutated in place", async () => {
    const source = `
//@@mutable
interface Cell { n: number; tag: string }
function tick(c: Cell): void { c.n = c.n + 1; }
function retag(c: Cell): void { c.tag = "seen-" + c.tag; }
const a: Cell = { n: 1, tag: "a" };
tick(a);
tick(a);
retag(a);
console.log(a.n, a.tag);
`;
    await expectMatches(source, await runWithNode(source));
  });

  test("a `for-of` ELEMENT of a `@@mutable` record may be mutated in place", async () => {
    const source = `
//@@mutable
interface Cell { n: number }
const xs: Cell[] = [{ n: 1 }, { n: 2 }, { n: 3 }];
for (const c of xs) { c.n = c.n * 10; }
console.log(xs[0].n, xs[1].n, xs[2].n);
`;
    await expectMatches(source, await runWithNode(source));
  });

  test("an ALIAS receiver is STILL NT1607 — the arm dropped is borrow-by-signature, not aliasing", () => {
    const r = rejectionOf(`
//@@mutable
interface Cell { n: number }
const a: Cell = { n: 1 };
const b = a;
b.n = 7;
console.log(a.n);
`);
    expect(r?.code).toBe("NT1607");
  });

  test("an undecorated record parameter is untouched — still NT1606 at the TYPE gate", () => {
    const r = rejectionOf(`
interface Cell { n: number }
function tick(c: Cell): void { c.n = c.n + 1; }
const a: Cell = { n: 1 };
tick(a);
console.log(a.n);
`);
    expect(r?.code).toBe("NT1606");
  });

  test("a `@@mutable` CLASS parameter is untouched — still NT1607", () => {
    const r = rejectionOf(`
//@@mutable
class Counter { pos: number = 0; bump(): Counter { this.pos++; return this; } get(): number { return this.pos; } }
function tick(c: Counter): void { c.bump(); }
const a = new Counter();
tick(a);
console.log(a.get());
`);
    expect(r?.code).toBe("NT1607");
  });

  test("mutating through a parameter leaks nothing and frees nothing twice", async () => {
    const r = await compileAndRun(`
//@@mutable
interface Cell { n: number; tag: string }
function tick(c: Cell): void { c.n = c.n + 1; }
function scope(): number {
  const a: Cell = { n: 1, tag: "a" };
  tick(a); tick(a); tick(a);
  return a.n;
}
console.log(scope());
console.log(__objLive(), __arrLive());
`);
    expect(r.stdout).toBe("4\n0 0\n");
    expect(r.exitCode).toBe(0);
  });
});

/*
 * PRE-EXISTING BUG, found in this lane's blast radius and fixed here.
 *
 * A `@@mutable` record is compiled to the TAGGED object type `Cell{n:number}` — the same
 * encoding a class instance uses — which is what makes mutability nominal. `genInspectObject`
 * folds that tag into the opening brace, which is exactly right for a CLASS (node really
 * does print `Counter { pos: 0 }`) and WRONG for a record, which node prints untagged.
 *
 *   node:      { n: 1 }            nativets (before): Cell { n: 1 }        exit 0 on both
 *
 * A silent wrong answer on a plain, non-recursive, fully supported feature — and pieces 1-3
 * multiply it, since tagging the ~48 AST interfaces would make every `console.log` of an AST
 * node wrong. `program.mutableRecords` already distinguishes the two carriers.
 *
 * BOTH SIDES are asserted here, because the fix would otherwise read as a regression: a real
 * class must KEEP its prefix.
 */
describe("console.log of a tagged value: a record is untagged, a class is not", () => {
  test("a `@@mutable` record prints untagged and a class keeps its name (node is the oracle)", async () => {
    const source = `
//@@mutable
interface Cell { n: number }
class Counter { pos: number = 0; get(): number { return this.pos; } }
const c: Cell = { n: 1 };
const k = new Counter();
console.log(c);
console.log(k);
console.log({ inner: c });
const xs: Cell[] = [{ n: 2 }, { n: 3 }];
console.log(xs);
`;
    await expectMatches(source, await runWithNode(source));
  });

  test("the DEPTH cut-off follows the same split — `[Object]` for a record, `[Cls]` for a class", async () => {
    // node cuts at depth 2 and names the constructor there. A record has none.
    const source = `
//@@mutable
interface L4 { v: number }
interface L3 { d: L4 }
interface L2 { c: L3 }
interface L1 { b: L2 }
class C4 { v: number = 9; get(): number { return this.v; } }
interface K3 { d: C4 }
interface K2 { c: K3 }
interface K1 { b: K2 }
const r: L1 = { b: { c: { d: { v: 1 } } } };
const k: K1 = { b: { c: { d: new C4() } } };
console.log(r);
console.log(k);
`;
    await expectMatches(source, await runWithNode(source));
  });
});

/*
 * THE HINT ON A UNION RECEIVER — `e.f = v` where `e` is a DISCRIMINATED UNION.
 *
 * This is the shape the compiler's own source is built out of: `Renamer.expr`,
 * `Checker.type`, `Checker.retypeLiteral` and five others all write `e.ty = v` on an
 * `Expr`, and `Expr` is a ~30-member union. It is also where NT1606's hint went wrong,
 * and the defect is the LOOP rather than any single sentence:
 *
 *   1. undecorated union  -> NT1606, "declare the record `@@mutable`";
 *   2. do exactly that    -> NT1606 AGAIN, and the `@@mutable` sentence silently
 *                            DISAPPEARS, because the hint picks its branch on
 *                            `isObjectTy(ot)` and a TAGGED union is not an object type.
 *                            What is left is the bare spread advice;
 *   3. do the spread      -> NT2001, "an object literal for A{…} | B{…} must set 'kind'
 *                            to one of the literals" — the advice cannot be written at
 *                            all once the members are tagged.
 *
 * So the user is walked from a working program to a dead end, and told "objects are
 * immutable" about two records they just declared mutable. Meanwhile the spelling that
 * DOES work — narrow on the discriminant, then assign — is never mentioned anywhere.
 *
 * The REFUSAL itself is correct and stays: a union-typed receiver has no single slot
 * layout, so there is no store to emit until the member is known. Only the hint moves.
 * Every case below was run through nativets AND node before being written down.
 */
describe("a SHARED field of a `@@mutable` union stores in place", () => {
  const UNION = `
//@@mutable
interface NumLit { kind: "Num"; ty?: string }
//@@mutable
interface StrLit { kind: "Str"; ty?: string }
type E = NumLit | StrLit;
`;

  /*
   * THE REFUSAL THIS BLOCK USED TO PIN IS GONE, and its own premise is what gave it away:
   * "a union-typed receiver has no single slot layout, so there is no store to emit until
   * the member is known". That is false for a field EVERY member shares — `ty` is at index
   * 1 in both members above — and the refusal's own message said as much, in the
   * parenthetical it used to carry: "the READ is: `unionCommonField` proves a shared field
   * sits at one constant slot in every member, and `e.f` on an un-narrowed union compiles
   * today". A store to that same slot is well-defined for exactly the same reason.
   *
   * So the store is emitted now, gated on `unionCommonField` — which answers `undefined`
   * unless the field is at the SAME index with the SAME widened type in every member. The
   * cases that genuinely have no single slot are still refused, below.
   *
   * This is the shape the compiler's own source is built out of (`e.ty = v` on an `Expr`,
   * `arrow.isAsync = v`, `operand.awaited = v`), and it held 23 self-hosting blockers.
   */
  test("the shared field stores, and every handle observes it — node is the oracle", async () => {
    const src = `${UNION}
function annotate(e: E): void { e.ty = "number"; }
const a: E = { kind: "Num" };
annotate(a);
console.log(a.ty ?? "none");
`;
    await expectMatches(src, runWithNode(src));
  });

  test("...across BOTH members, through a function boundary and an array", async () => {
    const src = `${UNION}
function mkN(): E { return { kind: "Num" }; }
function mkS(): E { return { kind: "Str" }; }
function stamp(x: E): void { x.ty = "stamped"; }
const xs: E[] = [mkN(), mkS()];
for (const x of xs) { stamp(x); }
let out = "";
for (const x of xs) { out += x.kind + ":" + (x.ty ?? "none") + " "; }
console.log(out.trim());
`;
    await expectMatches(src, runWithNode(src));
  });

  /* THE THREE GUARDS, each a case where there really is no one slot — or no permission. */
  test("a field at a DIFFERENT slot in each member is still refused", () => {
    const r = rejectionOf(`
//@@mutable
interface A { kind: "A"; left: number; ty?: string }
//@@mutable
interface B { kind: "B"; ty?: string; right: string }
type E2 = A | B;
function f(e: E2): void { e.ty = "x"; }
console.log(1);
`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("union");
  });

  test("a field ABSENT from one member is still refused", () => {
    const r = rejectionOf(`
//@@mutable
interface A { kind: "A"; ty?: string }
//@@mutable
interface B { kind: "B"; right: string }
type E2 = A | B;
function f(e: E2): void { e.ty = "x"; }
console.log(1);
`);
    expect(r?.code).toBe("NT1606");
  });

  test("an UNDECORATED union is still `objects are immutable` — Stage 29 stands", () => {
    const r = rejectionOf(`
interface A { kind: "A"; ty?: string }
interface B { kind: "B"; ty?: string }
type E2 = A | B;
function f(e: E2): void { e.ty = "x"; }
console.log(1);
`);
    expect(r?.code).toBe("NT1606");
    expect(r?.message).toContain("objects are immutable");
  });
});

/*
 * THE SHAPE `src/ast.ts` NEEDED: a persistent-`Set` accumulator threaded down a shared
 * tree walk, through a parameter, mutated inside a CAPTURING arrow.
 *
 * This is the pattern behind `collectBindingNames`, and it is the one that took `ast.ts`
 * to zero blockers. Every other accumulator answer in the tree is "return the new value
 * and rebind at the call site", and it is structurally unavailable here: the walk goes
 * through `walkExprChildren`/`walkStmtChildren`, whose callbacks are `(x: Expr) => Expr`
 * and `(y: Stmt) => Stmt`, so there is no channel to return a set on. `out.add(name)` on
 * a bare `Set<string>` parameter is the shape that fits, and it is both refused (NT1606)
 * and WRONG — `Set` is persistent here, so the append is discarded.
 *
 * Three claims, each measured rather than reasoned about, because the surrounding lore
 * had it that a collector parameter could not be mutated at all:
 *   1. a `@@mutable` RECORD parameter CAN carry it, even when a nested arrow captures it;
 *   2. a `@@mutable` CLASS in the same position CANNOT — `checkOwnedReceiver`'s signature
 *      arm is restricted to `mutable.records`, so the setter call is NT1607. This is the
 *      distinction, and it is invisible to the blocker metric (which never runs the
 *      ownership pass), so it needs a real compile to stay true;
 *   3. node agrees with us on the ANSWER, which is the only thing that finally matters.
 */
describe("a persistent-Set accumulator threaded through a walker (src/ast.ts's shape)", () => {
  const WALKER = `
interface Node { kind: string; name: string; kids: Node[] }
const tree: Node[] = [
  { kind: "decl", name: "a", kids: [{ kind: "decl", name: "b", kids: [] }] },
  { kind: "expr", name: "z", kids: [{ kind: "decl", name: "c", kids: [] }] },
];
`;

  test("a `@@mutable` RECORD carries it — through a parameter AND a capturing arrow", async () => {
    const source = `${WALKER}
//@@mutable
interface BoundNames { names: Set<string> }
function walkKids(n: Node, f: (x: Node) => Node): Node {
  return { ...n, kids: n.kids.map((x: Node): Node => f(x)) };
}
function bind(n: Node, out: BoundNames): Node {
  if (n.kind === "decl") out.names = out.names.add(n.name);
  return walkKids(n, (x: Node): Node => bind(x, out));
}
function collect(list: Node[]): Set<string> {
  const out: BoundNames = { names: new Set<string>() };
  for (const n of list) bind(n, out);
  return out.names;
}
const got = collect(tree);
console.log(got.has("a"), got.has("b"), got.has("c"), got.has("z"), got.size);
`;
    await expectMatches(source, await runWithNodeAttrs(source));
  });

  test("the bare `Set` parameter it replaced is NT1606 — and would have been a no-op", () => {
    const r = rejectionOf(`${WALKER}
function walkKids(n: Node, f: (x: Node) => Node): Node {
  return { ...n, kids: n.kids.map((x: Node): Node => f(x)) };
}
function bind(n: Node, out: Set<string>): Node {
  if (n.kind === "decl") out.add(n.name);
  return walkKids(n, (x: Node): Node => bind(x, out));
}
const out = new Set<string>();
for (const n of tree) bind(n, out);
console.log(out.size);
`);
    expect(r?.code).toBe("NT1606");
    // Refusing it is not pedantry: node prints 3 and a `.add`-discarding lowering would
    // print 0, which is the silent-wrong-answer class this whole rule exists to close.
    expect(r?.message ?? "").toContain("persistent");
  });

  test("a `@@mutable` CLASS in the same position is NT1607 — the record spelling is load-bearing", () => {
    const r = rejectionOf(`${WALKER}
//@@mutable
class BoundNames {
  names: Set<string> = new Set<string>();
  note(n: string): void { this.names = this.names.add(n); }
}
function walkKids(n: Node, f: (x: Node) => Node): Node {
  return { ...n, kids: n.kids.map((x: Node): Node => f(x)) };
}
function bind(n: Node, out: BoundNames): Node {
  if (n.kind === "decl") out.note(n.name);
  return walkKids(n, (x: Node): Node => bind(x, out));
}
const out = new BoundNames();
for (const n of tree) bind(n, out);
console.log(out.names.size);
`);
    // A class's write is a SETTER CALL on a borrowed receiver; a record's is a field
    // store named in the signature. Only the second has the signature arm.
    expect(r?.code).toBe("NT1607");
  });
});

/*
 * `@@mutable` IS NOMINAL — and the diagnostic that never said so.
 *
 * `isMutableTy` reads a TAG, so `Cell{n:number}` and `{n:number}` are different types
 * even though their fields are identical. An existing untagged value therefore does not
 * flow into a `Cell` position:
 *
 *     //@@mutable
 *     interface Cell { n: number }
 *     const c = { n: 1 };
 *     bump(c);   // error[NT2001]: 'bump' arg 0 expects Cell{n:number}, got {n:number}
 *
 * Two types that print four characters apart, and no hint at all. The reader has just
 * been told by NT1606 to "declare the record `@@mutable`", has done exactly that, and
 * lands here with nothing to go on — the walked-in-a-circle shape
 * `allUnionMembersMutable` was written for, one step further along.
 *
 * The fix is real and small: tag the value where it is CREATED. A literal takes the tag
 * from its CONTEXT, so annotating the binding (or passing the literal straight in) is all
 * it needs. Both spellings are COMPILED against node below rather than asserted, because
 * a hint that does not build is worse than no hint.
 */
describe("@@mutable is nominal — the tag mismatch explains itself", () => {
  const NOMINAL_MISMATCH = `
//@@mutable
interface Cell { n: number }
function bump(c: Cell): void { c.n = c.n + 1; }
const c = { n: 1 };
bump(c);
console.log(c.n);
`;

  test("an untagged value in a `@@mutable` position is refused WITH a hint", () => {
    const r = rejectionOf(NOMINAL_MISMATCH);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.message).toContain("expects Cell{n:number}, got {n:number}");
    const hint = r!.hint ?? "";
    expect(hint).toContain("NOMINAL");
    expect(hint).toContain("const c: Cell =");
  });

  test("the hint's annotate-the-binding spelling compiles and matches node", async () => {
    const source = `
//@@mutable
interface Cell { n: number }
function bump(c: Cell): void { c.n = c.n + 1; }
const c: Cell = { n: 1 };
bump(c);
console.log(c.n);
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("the hint's pass-the-literal-straight-in spelling compiles and matches node", async () => {
    const source = `
//@@mutable
interface Cell { n: number }
function bump(c: Cell): void { c.n = c.n + 1; console.log(c.n); }
bump({ n: 1 });
`;
    await expectMatches(source, runWithNodeAttrs(source));
  });

  test("the same hint reaches the DECLARATION position", () => {
    const r = rejectionOf(`
//@@mutable
interface Cell { n: number }
const u = { n: 1 };
const c: Cell = u;
console.log(c.n);
`);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.hint ?? "").toContain("NOMINAL");
  });

  // The mutation guard on the hint's CONDITION. Two records that differ in their FIELDS
  // do not have a tag problem, and telling that author to add an annotation would send
  // them to write one that changes nothing. Drop the same-body test from `tagHint` and
  // this fails.
  test("a genuine shape mismatch does NOT get the tag hint", () => {
    const r = rejectionOf(`
//@@mutable
interface Cell { n: number }
function bump(c: Cell): void { c.n = c.n + 1; }
const c = { m: 1 };
bump(c);
`);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.hint ?? "").not.toContain("NOMINAL");
  });
});
