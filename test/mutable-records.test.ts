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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAndRun, compileAndRunFile, runWithNode, runWithNodeAttrs, runWithNodeFile, stripAttributes } from "./harness.ts";
import { emitIR } from "./harness.ts";

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

  test("an ARRAY of the recursive type never reaches the cycle rule — NT1001 is nearer", () => {
    // The reachability scan DOES see through `[]` (`@Node[]` mentions `@Node`), but an
    // array of a recursive type is refused by a NEARER, pre-existing gate: the heap value
    // model has no representation for one. Pinned so that a later lane implementing
    // `@Node[]` finds out here that the cycle rule now has to carry that shape.
    const r = rejectionOf(`
//@@mutable
interface Node { n: number; kids: Node[] }
const a: Node = { n: 1, kids: [] };
a.kids = [];
console.log(a.n);
`);
    expect(r?.code).toBe("NT1001");
    expect(r?.message).toContain("@Node");
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
  test("`recursiveMutableError` is NOT a decoy — the CLASS spelling is still refused", () => {
    // Piece 2 split the RECORD case only. A class's mutation goes through `this.f = v`
    // inside a method, where the receiver is not a binding this rule can reason about, so
    // the declaration-level refusal stays and the diagnostic stays reachable.
    const r = rejectionOf(`
//@@mutable
class Node {
  n: number = 0;
  next: Node | null = null;
  bump(): Node { this.n++; return this; }
}
const a = new Node();
console.log(a.bump().n);
`);
    expect(r?.code).toBe("NT1030");
    expect(r?.message).toContain("'@@mutable class Node' is RECURSIVE");
  });
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
