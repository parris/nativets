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

  test("`@@mutable` on a non-class is rejected", () => {
    expect(rejectCode(`
@@mutable
function f(): number { return 1; }
console.log(f());
`)).toBe("NT1023");
  });
});
