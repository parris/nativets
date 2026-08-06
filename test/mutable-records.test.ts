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
  test("NT1607 — assigning a field through a by-borrow PARAMETER", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
function tick(c: Cell): number { c.n = c.n + 1; return c.n; }
const c: Cell = { n: 1 };
console.log(tick(c));
`);
    expect(r?.code).toBe("NT1607");
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

  test("NT1607 — assigning a field of a `for-of` element", () => {
    const r = rejectionOf(`
@@mutable
type Cell = { n: number };
const cells: Cell[] = [{ n: 1 }, { n: 2 }];
for (const c of cells) { c.n = 0; }
console.log(cells[0].n);
`);
    expect(r?.code).toBe("NT1607");
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
