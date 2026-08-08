/*
 * BLOCK-SCOPED drops: how the ownership pass hands a nested block's RAII free set
 * to codegen.
 *
 * The set used to ride on the statement list as an EXPANDO property, typed with an
 * intersection (`Stmt[] & { blockDrops?: string[] }`). That is the one intersection
 * type in the whole of `src/`, and it is what stopped the compiler compiling its own
 * `src/ast.ts` — an array with extra properties has no runtime representation here
 * (`NtArray` is a fixed 4-field struct). It is now a synthesized trailing `BlockDrops`
 * statement in the list itself, so the drop point is an ordinary node.
 *
 * The behavior that must not move is observed through `__arrLive()` (arrays allocated
 * − freed), because compiler-inserted frees are otherwise invisible in output.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAndRun, expectMatchesNode } from "./harness.ts";
import { parse } from "../src/parser.ts";

describe("block-scoped drops", () => {
  // The self-host site. `src/ast.ts` is part of the compiler's own source, so the
  // subset it is written in is a hard constraint (docs/self-hosting.md) — the same
  // rule the comment at src/ast.ts:512 states for `Partial<MemberExpr> & {…}`.
  //
  // Asserted on the SOURCE, not on a parse of the whole file: `src/ast.ts` still has
  // further blockers past this one (`ForStmt.init: VarDecl | Expr | null` is next), so
  // "it parses" would stay red for reasons that are not this lane's. What must hold is
  // that no intersection type remains anywhere in the compiler's own source.
  // Asserted through the real parser rather than by scanning text, so `&&`, a bitwise
  // `&` and the word "intersection" in a comment cannot be mistaken for one: the
  // refusal renders an intersection's arms joined with " & ".
  test("no file in src/ is blocked by an intersection type", () => {
    const dir = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      try {
        parse(readFileSync(join(dir, f), "utf8"));
      } catch (e) {
        // Every OTHER refusal is some other lane's frontier, not this one's.
        const msg = (e as Error).message;
        if (msg.includes(" & ")) offenders.push(`${f}: ${msg.split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The hazard the marker representation introduces, and the reason `setBlockDrops`
  // replaces instead of appending: `loop()` walks a loop body up to five times to reach
  // its move fixpoint. An appending setter leaves five markers on the body and frees the
  // same array five times — a DOUBLE FREE, not a leak: the process dies on a signal and
  // the buffered stdout dies with it (observed: no output, exit 255, against node's
  // "9\n" and exit 0). The old expando was idempotent for free, being an assignment.
  test("a linear local in a loop body is freed once per iteration, not once per fixpoint walk", async () => {
    const src = `
function f(): number {
  let total = 0;
  for (let i = 0; i < 3; i = i + 1) {
    const a: number[] = [1, 2, 3];
    total = total + a.length;
  }
  return total;
}
console.log(f());`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0); // a double free aborts; node cannot observe that for us

    // …and the frees actually happened: every array allocated in the body is gone.
    const r = await compileAndRun(`${src}\nconsole.log(__arrLive());`);
    expect(r.stdout).toBe("9\n0\n");
    expect(r.exitCode).toBe(0);
  });
});
