/*
 * Ownership test harness — modeled on rustc's `compiletest` UI tests.
 *
 *   //@ check-pass         → the move checker must ACCEPT (zero diagnostics)
 *   //~ ERROR NT1601       → a diagnostic with that code must occur ON THIS LINE,
 *                            and there must be no unexpected diagnostics.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ownershipCheck, sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "ownership");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("ownership (linear move checker)", () => {
  for (const file of files) {
    const src = readFileSync(join(DIR, file), "utf8");
    const checkPass = /\/\/@\s*check-pass/.test(src);
    const expected: { line: number; code: string }[] = [];
    src.split("\n").forEach((l, i) => {
      const m = l.match(/\/\/~\s*ERROR\s+(NT\d+)/);
      if (m) expected.push({ line: i + 1, code: m[1]! });
    });

    test(file, () => {
      const diags = ownershipCheck(src);
      if (checkPass) {
        expect(diags).toEqual([]);
        return;
      }
      for (const e of expected) {
        const hits = diags.filter((d) => d.line === e.line && d.code === e.code);
        expect(hits.length, `expected ${e.code} on line ${e.line} of ${file}; got ${JSON.stringify(diags)}`).toBeGreaterThan(0);
      }
      // no unexpected diagnostics
      expect(diags.length).toBe(expected.length);
    });
  }
});

/*
 * The HINT has to survive the trip. Every NT16xx rule in `src/ownership.ts` builds one —
 * `OwnDiag.hint` — and it is the whole point of CLAUDE.md's "anything we can't compile
 * correctly gets an NT**** diagnostic WITH A HINT". `sourceToIR` constructed the thrown
 * `NTError` from the code, the message and the spans only, so not one of them ever reached
 * a reader: the pass said "hand out `c` itself instead" and the CLI printed the bare
 * refusal. A hint nobody can see is a hint that does not exist.
 */
describe("ownership diagnostics reach the user", () => {
  function thrown(src: string): NTError | null {
    try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e : null; }
  }

  test("an NT1604 alias hint survives into the thrown diagnostic", () => {
    const e = thrown(`
//@@mutable
type Cell = { n: number };
function leak(): Cell {
  const c: Cell = { n: 1 };
  const b = c;
  return b;
}
console.log(leak().n);
`);
    expect(e?.diag.code).toBe("NT1604");
    expect(e?.diag.hint).toContain("hand out `c` itself instead");
  });

  // The refusal this feature deliberately does NOT lift: a HAND-WRITTEN `this.f = p` in a
  // constructor body. Only a parameter PROPERTY is syntactically guaranteed to store, so
  // only it is inferred consuming; the hand-written store stays refused and must say what
  // to write instead.
  test("NT1604 on a constructor's hand-written field store names the parameter-property form", () => {
    const e = thrown(`
class Box {
  inner: {x:number};
  constructor(v: {x:number}) { this.inner = v; }
}
const b = new Box({x: 1});
console.log(b.inner.x);
`);
    expect(e?.diag.code).toBe("NT1604");
    expect(e?.diag.hint).toContain("PARAMETER PROPERTY");
    expect(e?.diag.hint).toContain("constructor(readonly v: T)");
  });
});
