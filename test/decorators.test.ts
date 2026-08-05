/*
 * Decorators — two sigils, two mechanisms (see docs/decorators.md).
 *
 *   @@name   a COMPILE-TIME attribute the checker reads (Rust `#[derive]`-shaped).
 *            Zero runtime footprint: it changes how the class is CHECKED/COMPILED.
 *   @name    a real RUNTIME wrapper (Python-shaped), on a class or a method: an
 *            ordinary user function that takes the thing being decorated and
 *            returns the replacement.
 *
 * ORACLES.
 *  - `@@mutable` classes: node-differential. An `@@mutable` class is EXACTLY a plain
 *    TS class, so the oracle is the same source with the attribute line stripped
 *    (`runWithNodeAttrs`).
 *  - `@wrapper` decorators: node-differential against the hand-written explicit
 *    wrapper application (the desugaring itself), since node's own decorator
 *    proposal has different semantics.
 *  - The ORDINARY (undecorated) copy-on-write class has NO node desugaring — TS
 *    classes mutate — so it is a BEHAVIORAL test with exact expected stdout, like
 *    test/actors.test.ts. Documented in docs/divergences.md.
 */
import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNodeAttrs } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

/** Compile-only: return the NT code of the rejection, or "" when it compiled. */
function rejectCode(source: string): string {
  try {
    sourceToIR(source);
    return "";
  } catch (e) {
    return (e as { diag?: { code?: string } }).diag?.code ?? `THREW:${(e as Error).message}`;
  }
}

/** Assert our binary matches node on the attribute-stripped source. */
async function expectMatchesStripped(source: string): Promise<string> {
  const oracle = runWithNodeAttrs(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

/* ------------------------------------------ 5. ownership: exclusive access rule */

/*
 * Decision 3's safety story. `@@mutable` reintroduces real mutation, so the linear model
 * has to keep it single-owner. The rule, in one line: ONLY THE OWNER MAY MUTATE, and a
 * borrow may never escape its owner.
 *
 *   - `const b = a` is an ALIAS (a borrow), not a move — that is what makes "every alias
 *     observes it" expressible at all. Ownership never leaves the original binding, so
 *     the value is dropped exactly once and aliasing can never double-free.
 *   - Calling a SETTER through anything we cannot prove we own — an alias, a by-borrow
 *     parameter, a `for-of` element — is NT1607 (≈ rustc E0596).
 *   - A borrow that would outlive its owner (returning an alias, or returning a method
 *     result, which IS the receiver) is the existing NT1604 (≈ E0507).
 */
const COUNTER = `
@@mutable
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
`;

describe("@@mutable ownership: only the owner may mutate", () => {
  test("the OWNER may mutate, and an alias may READ", async () => {
    const r = await compileAndRun(`${COUNTER}
const a = new Counter();
const b = a;
a.bump();
console.log(b.get());
`);
    expect(r.stdout).toBe("1\n");
  });

  test("mutating through an ALIAS is rejected (NT1607)", () => {
    expect(rejectCode(`${COUNTER}
const a = new Counter();
const b = a;
b.bump();
console.log(a.get());
`)).toBe("NT1607");
  });

  test("mutating through a PARAMETER is rejected (NT1607) — a param is a borrow", () => {
    expect(rejectCode(`${COUNTER}
function tick(c: Counter): number { c.bump(); return c.get(); }
const a = new Counter();
console.log(tick(a));
`)).toBe("NT1607");
  });

  test("reading through a parameter is fine", async () => {
    const r = await compileAndRun(`${COUNTER}
function peek(c: Counter): number { return c.get(); }
const a = new Counter();
a.bump();
console.log(peek(a));
`);
    expect(r.stdout).toBe("1\n");
  });

  test("returning an ALIAS out of its owner's scope is rejected (NT1604)", () => {
    expect(rejectCode(`${COUNTER}
function make(): Counter {
  const a = new Counter();
  const b = a;
  return b;
}
console.log(make().get());
`)).toBe("NT1604");
  });

  test("returning a METHOD RESULT is rejected (NT1604) — it is the receiver, a borrow", () => {
    expect(rejectCode(`${COUNTER}
function make(): Counter {
  const a = new Counter();
  return a.bump();
}
console.log(make().get());
`)).toBe("NT1604");
  });

  test("an aliased @@mutable instance is still dropped exactly once", async () => {
    const r = await compileAndRun(`${COUNTER}
function scope(): number {
  const a = new Counter();
  const b = a;
  a.bump();
  return b.get();
}
console.log(scope());
console.log(__objLive());
`);
    // 1 from the counter's mutation; 0 live objects afterwards = freed exactly once.
    expect(r.stdout).toBe("1\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

/* ------------------------------------- 4. ordinary class = copy-on-write setter */

/*
 * An ORDINARY (undecorated) class is IMMUTABLE: a field-assigning method produces a NEW
 * instance and leaves the original alone. TypeScript classes mutate, so there is no
 * mechanical desugaring to hand node — these are BEHAVIORAL tests with exact expected
 * stdout (the test/actors.test.ts contract). Documented in docs/divergences.md.
 */
describe("ordinary class: a field-assigning method copy-on-writes", () => {
  test("the receiver is unchanged; the method hands back the new instance", async () => {
    const r = await compileAndRun(`
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a.bump();
const c = b.bump();
console.log(a.get(), b.get(), c.get());
`);
    expect(r.stdout).toBe("0 1 2\n");
    expect(r.exitCode).toBe(0);
  });

  test("the implicit return (Decision 2) also yields the new instance", async () => {
    const r = await compileAndRun(`
class Point {
  x: number = 0;
  y: number = 0;
  moveTo(nx: number, ny: number) { this.x = nx; this.y = ny; }
  show(): string { return this.x + "," + this.y; }
}
const p = new Point();
const q = p.moveTo(3, 4);
console.log(p.show());
console.log(q.show());
`);
    expect(r.stdout).toBe("0,0\n3,4\n");
    expect(r.exitCode).toBe(0);
  });

  test("a setter that throws the copy away is rejected, never miscompiled", () => {
    expect(rejectCode(`
class Counter {
  private pos: number = 0;
  bump(): number { this.pos++; return this.pos; }
  get(): number { return this.pos; }
}
console.log(new Counter().bump());
`)).toBe("NT1023");
  });
});

/* ------------------------------------------------------------------ 1. syntax */

describe("decorator syntax", () => {
  test("`@@mutable` before a class parses and is a no-op for a read-only class", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  get(): number { return this.pos; }
}
const a = new Counter();
console.log(a.get());
`);
    expect(out).toBe("0\n");
  });

  test("an unknown `@@attribute` is REJECTED, never silently ignored", () => {
    expect(rejectCode(`
@@frobnicate
class C {
  x: number = 1;
  get(): number { return this.x; }
}
console.log(new C().get());
`)).toBe("NT1023");
  });

  test("`@@mutable`: a setter mutates in place and every alias observes it", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;
a.bump();
console.log(b.get());
a.bump().bump();
console.log(b.get());
`);
    expect(out).toBe("1\n3\n");
  });

  // Decision 2: a method that assigns a field but does not return gets an IMPLICIT
  // return. The MUTATION half is node-differential (node's classes mutate too); the
  // implicit return itself is a divergence (node returns `undefined`), so chaining off
  // a return-less setter is pinned behaviorally below.
  test("`@@mutable`: a setter with no `return` still mutates (differential)", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  bump() { this.pos++; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;
a.bump();
a.bump();
console.log(b.get());
`);
    expect(out).toBe("2\n");
  });

  test("`@@mutable`: the implicit return is `this`, so a return-less setter chains", async () => {
    const r = await compileAndRun(`
@@mutable
class Counter {
  private pos: number = 0;
  bump() { this.pos++; }
  get(): number { return this.pos; }
}
const a = new Counter();
a.bump().bump().bump();
console.log(a.get());
`);
    expect(r.stdout).toBe("3\n");
    expect(r.exitCode).toBe(0);
  });

  test("`@@mutable` on a non-class is rejected", () => {
    expect(rejectCode(`
@@mutable
function f(): number { return 1; }
console.log(f());
`)).toBe("NT1023");
  });
});
