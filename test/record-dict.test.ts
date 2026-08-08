/**
 * `Record<K, V>` is compiled as a `Map<K, V>` — and the diagnostic has to say so.
 *
 * In TypeScript `Record<K, V>` is an OBJECT type, and `{ n: "\n" }` initializes it fine
 * (verified: node runs `const o: Record<string,string> = {a:"1"}; console.log(o["a"])`
 * and prints `1`, exit 0). nativets erases `Record` to its `Map` type instead
 * (`src/parser.ts`, `parseGenericType`), because an object's field list here comes from
 * its TYPE and a `Record`'s key set is by definition not known statically.
 *
 * That mapping is defensible — see docs/divergences.md — but the ERROR it produced was
 * not: it reported `'ESCAPES' declared Map<string,string> but initialized with {…}` to a
 * user who never wrote `Map`. The type in the message was the compiler's erasure, not
 * anything in the source, which sends you looking for a `Map` that does not exist. That
 * is what this file pins.
 *
 * Cases are DERIVED from node probes quoted inline. No conformance suite was consulted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

describe("the Record-initialized-with-a-literal diagnostic names what was WRITTEN", () => {
  test("it says `Record`, the word in the source, not the erased `Map`", () => {
    const r = rejectionOf(`const o: Record<string, string> = { a: "1" };\nconsole.log(o["a"]);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("Record<string,string>");
  });

  test("the hint explains the mapping and names a real fix", () => {
    const r = rejectionOf(`const o: Record<string, string> = { a: "1" };\nconsole.log(o["a"]);\n`);
    // WHY: the erasure, stated once, where the user can see it.
    expect(r?.hint).toContain("Map");
    // The fix has to be actionable, not a restatement.
    expect(r?.hint).toContain(".set(");
  });

  test("a genuine `Map` annotation still reports `Map` — the two do not collapse", () => {
    const r = rejectionOf(`const o: Map<string, string> = { a: "1" };\nconsole.log(o.size);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("Map<string,string>");
    expect(r?.message).not.toContain("Record");
  });

  /**
   * The case that actually constrains the renderer. An ALIAS's written head (`Cell`) has
   * no relationship to its erasure (`{n:number}`) and there are no type arguments to
   * carry over, so substituting the head must be SKIPPED entirely — splicing it in
   * produces a mangled non-type. Found by checking the `Map` test above for vacuity: that
   * one survives the guard being removed, because `Map<…>` re-renders to itself.
   */
  test("an ALIAS annotation renders as its shape, not a spliced head", () => {
    const r = rejectionOf(`type Cell = { n: number };\nconst c: Cell = 1;\nconsole.log(c.n);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("{n:number}");
    expect(r?.message).not.toContain("Cell}");
    expect(r?.message).not.toContain("Cell{");
  });
});

describe("the compiler's own lexer no longer needs the Record pattern (route c)", () => {
  /**
   * `src/lexer.ts` stopped STANDALONE (parse + check, no link) on
   * `const ESCAPES: Record<string, string> = { … }`, read at `ESCAPES[e] ?? e` with a
   * VARIABLE key. Both halves are refused here, and neither can be fixed correctly:
   *
   *  - the literal cannot initialize a Map (this file's subject);
   *  - `o[e]` with a non-literal key cannot match node even in principle, because node's
   *    `o[k]` consults the PROTOTYPE CHAIN. Measured: on `{ n: "N" }`, node returns a
   *    FUNCTION for `o["toString"]`, `o["constructor"]` and `o["hasOwnProperty"]`, and an
   *    object for `o["__proto__"]` — and `o["toString"] ?? FALLBACK` takes the inherited
   *    function, not the fallback. nativets objects have no prototype chain (a literal-key
   *    `o.toString` is refused outright: "Property 'toString' does not exist"), so any
   *    own-keys-only lowering would answer `undefined` where node answers a function.
   *
   * So the pattern is replaced with a `switch`, which is what a hand-written lexer would
   * use anyway — no loss of clarity and no dependence on a construct we cannot compile.
   */
  function standaloneBlocker(rel: string): string {
    const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
    try {
      check(parse(src));
      return "CLEAN";
    } catch (e) {
      const d = (e as { diag?: { code: string; message: string } }).diag;
      return d ? `${d.code}: ${d.message}` : String(e);
    }
  }

  test("src/lexer.ts standalone is no longer stopped by the Record mismatch", () => {
    const b = standaloneBlocker("src/lexer.ts");
    expect(b).not.toContain("ESCAPES");
    expect(b).not.toContain("but initialized with");
  });

  test("src/lexer.ts declares no `Record<` ANNOTATION (comments may still mention it)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/lexer.ts"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
    expect(code.join("\n").includes("Record<")).toBe(false);
  });

  /**
   * The refactor must be BEHAVIOUR-PRESERVING, and the lexer is the component every other
   * test runs through, so it is asserted directly against node: each escape the table
   * carried, plus an unknown one (`\q` -> `q`), which was the `?? e` arm.
   *
   * `\0` is deliberately EXCLUDED, and not because the refactor changed it. nativets
   * strings are NUL-terminated, so an embedded NUL truncates: `"a\0b"` is length 1 here
   * and 3 in node — a silent wrong answer that reproduces identically at this lane's base
   * commit with no changes applied. It is reported separately; pinning it here would
   * either fail for an unrelated reason or, worse, cement the wrong value.
   */
  test("every escape still lexes exactly as node does (NUL excluded, see above)", async () => {
    const source = `const s = "a\\nb\\tc\\rd\\\\e\\"f\\'g\\qh";\nconsole.log(JSON.stringify(s));\nconsole.log(s.length);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0);
  });
});
