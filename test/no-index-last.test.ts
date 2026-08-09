/*
 * ============================================================================
 * THE CLASS tsc STRUCTURALLY CANNOT FIND — `xs[xs.length - 1]`
 * ============================================================================
 *
 * This file was a section of test/tsc.test.ts and is now its own, for the reason
 * test/no-regex.test.ts is its own: it is a LINT over `src/` plus the behaviour evidence
 * behind the lint, and the behaviour half drives the entire compiler pipeline, which has
 * nothing to do with the tsc gate. tsc.test.ts keeps a pointer here. ONE canonical copy.
 *
 * ---- The class ----
 * test/tsc.test.ts rests on tsc finding dead comparisons for us: TS2367, "these types
 * have no overlap", is what found the `scanExternalNames` hole. This class is the one it
 * can never report, and the reason is not an oversight in tsc — it is the two type
 * systems disagreeing about what an out-of-range read IS.
 *
 *   const last = list[list.length - 1];
 *   if (last !== undefined && last.kind === "BlockDrops") { … }
 *   list.push(…);
 *
 * On an empty list, node evaluates `list[-1]` to `undefined`, the guard is false, and the
 * push path runs. nativets PANICS on the read (Stage 41, docs/divergences.md):
 *
 *   const xs: number[] = []; console.log(xs[xs.length - 1]);
 *   node      -> undefined, exit 0
 *   nativets  -> panic: index out of bounds: the length is 0 but the index is -1, exit 255
 *
 * So the guard is not merely dead under nativets — control never reaches it.
 *
 * AND `noUncheckedIndexedAccess: true` is exactly what hides it. That setting types
 * `list[i]` as `Stmt | undefined`, so to tsc the `!== undefined` test is meaningful and
 * LIVE — the very option that makes tsc SAFE about indexing is what blinds it to the
 * nativets-specific deadness. Every place the two systems disagree about whether an
 * operation yields a value or a panic is a place tsc cannot help, and this project should
 * expect more of them, not fewer.
 *
 * The self-host ratchets cannot see it either: they stop most modules long before
 * codegen, and the three modules at rung 3 run drivers that never take these paths. So
 * the class needs its own instrument, which is this file.
 *
 * ---- The rule ----
 *   BANNED   `const last = xs[xs.length - 1];  if (last !== undefined) …`
 *            The author is depending on node's `undefined`, which nativets never
 *            produces. Rewrite as a `length > 0` test that never forms index -1, or as
 *            `xs.at(-1)`.
 *   COUNTED  `const top = xs[xs.length - 1]!;`
 *            The `!` records the author ASSERTING the array is non-empty. Ratcheted in
 *            `ASSERTED` below: may shrink, never grow.
 *
 * ---- CORRECTION: `!` marks INTENT, not safety ----
 * The rule above previously justified the `!` bucket with "if that assertion is wrong
 * both runtimes fail loudly — node throws on the deref, nativets panics on the read — so
 * it is not the silent-wrong-answer class." That is only true when the value is
 * DEREFERENCED, and the counterexample was inside the table it was defending:
 *
 *   src/parser.ts  `this.returnsAsyncFnStack[this.returnsAsyncFnStack.length - 1]! === true`
 *
 * There is no deref. node evaluates `undefined === true` to `false` and throws NOTHING,
 * while nativets panics — precisely the silent-divergence shape, wearing a `!`. It is
 * reachable: a top-level `return x;` gets there with the stack empty. It is correct today
 * only because a separate `length > 0 &&` guard was added in front of it — the guard, not
 * the `!`, is what fixed it, and the line is still counted here.
 *
 * Three more of the entries below are likewise safe for reasons unrelated to their `!`:
 * `codegen.ts`'s `typeofTagOf(members[members.length - 1]!)` (a general union has >= 2
 * members, and `typeofTagOf(undefined)` would not throw either), `checker.ts`'s
 * `scopes[scopes.length - 1]!` (`pushScope` appends before it returns), and `driver.ts`'s
 * `versions[versions.length - 1]!` (an NDK directory that EXISTS but is empty is a real
 * configuration; node then fails inside `join`, not on a deref, where every other
 * missing-toolchain path in that file raises a `BuildError`). So read `ASSERTED` as "a
 * claim someone made", never as "checked".
 *
 * ---- What this scan can and cannot see ----
 * It is TOKEN-based, like test/no-regex.test.ts's regex scan and for the same reason: a
 * character scan hits the identical shape written inside a STRING, and one exists — in
 * `checker.ts`'s own `.pop` diagnostic hint ("use `arr[arr.length - 1]` for the last
 * element"), which is advice about the USER's array and must not be flagged.
 *
 * It is deliberately WIDER than the `. length - 1 ]` token run this file used to match,
 * on three axes, each of which was a real blind spot rather than a hypothetical one:
 *
 *   1. it RECURSES INTO TEMPLATE SUBSTITUTIONS. The lexer emits a template as ONE token
 *      whose value is raw inner text, so a one-level scan cannot see inside — the exact
 *      hiding place test/no-regex.test.ts's header records as having concealed a regex
 *      for the life of the project. `src/codegen.ts` writes its branch targets as
 *      `` `br label %${this.loops[this.loops.length - 1]!.brk}` ``, so this tree holds
 *      TWO such sites, and the narrower scan counted `codegen.ts` at 6 where it is 8.
 *   2. it accepts any `- N`, not the literal `1`. `xs[xs.length - 2]` panics identically.
 *   3. it counts `.length` at bracket-DEPTH 0 rather than adjacent to the `]`, so
 *      `patterns[Math.min(i, patterns.length - 1)]` is a hit. That one was LIVE in
 *      `src/checker.ts` and is fixed with this file; see the behaviour suite below, and
 *      the three programs there that reached it.
 *
 * What it still cannot see: bind the length to a variable first — `const n = xs.length; …
 * xs[n - 1]` — and it is blind. That is not hypothetical either; it is the exact shape
 * `setBlockDrops` (src/ast.ts) has after its fix, and it is the sanctioned rewrite. The
 * general case needs dataflow this file does not have, which is why the behaviour suite
 * at the bottom exists: it does not read the source at all.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

import { lex } from "../src/lexer.ts";
import { sourceToIR } from "../src/driver.ts";

const SRC = new URL("../src/", import.meta.url);

/**
 * Sites written `xs[xs.length - N]` WITHOUT a `!`. A RATCHET, and this one must stay
 * EMPTY: every entry is a guard nativets can never reach.
 */
const UNASSERTED: Record<string, number> = {}; // EMPTY — keep it that way.

/**
 * Sites written `xs[xs.length - N]!` — the author asserting non-emptiness, which is a
 * claim and not a check (see the correction in the header). May shrink, never grow; a
 * file that reaches zero is DELETED rather than set to 0.
 *
 * `codegen.ts` is 8, not the 6 the narrower scan reported: two of them live inside
 * template substitutions.
 */
const ASSERTED: Record<string, number> = {
  "checker.ts": 4,
  "codegen.ts": 8,
  "driver.ts": 1,
  "lexer.ts": 2,
  "parser.ts": 2,
};

export interface LengthIndexHit { line: number; asserted: boolean; inTemplate: boolean }

/**
 * A `[` opens an INDEX only after something that can end an expression. After an
 * operator, `(`, `,` or one of these keywords it opens an ARRAY LITERAL — which is why
 * `frames = [...frames.slice(0, frames.length - 1), top + 1]` in src/lexer.ts is not a
 * hit: `.slice(0, -1)` is total and never panics. Same previous-token rule the lexer's
 * own `regexCanStart` uses to tell a regex from a division.
 */
const ARRAY_LITERAL_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/** Every index expression in `source` whose SUBSCRIPT mentions `.length`. */
export function lengthIndexReads(source: string): LengthIndexHit[] {
  const out: LengthIndexHit[] = [];
  // `base` maps a line inside a template's raw value back to a line of the FILE — a
  // template's value starts on the template token's own line, so line 1 of the value is
  // line `t.line` of the file. Without it every hit inside a substitution reported line
  // 1, and a lint that names the wrong line is the `classifyParseFailure` mistake
  // docs/self-hosting.md already records once.
  const walk = (text: string, depth: number, base: number): void => {
    let toks;
    try { toks = [...lex(text)]; } catch { return; } // a substitution alone need not lex
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.type === "template") { walk(t.value, depth + 1, base + t.line - 1); continue; }
      if (!(t.type === "punct" && t.value === "[")) continue;
      const prev = i > 0 ? toks[i - 1]! : undefined;
      if (!prev) continue;
      const opensIndex =
        prev.type === "num" || prev.type === "str" || prev.type === "template" ||
        (prev.type === "ident" && !ARRAY_LITERAL_AFTER_KEYWORD.has(prev.value)) ||
        (prev.type === "punct" && (prev.value === ")" || prev.value === "]" || prev.value === "!"));
      if (!opensIndex) continue;
      // Scan the subscript. Only `[`/`]` change the depth: a `.length` inside an inner
      // INDEX belongs to that inner read, while one inside parentheses is still part of
      // THIS subscript — which is what makes `patterns[Math.min(i, patterns.length - 1)]`
      // a hit.
      let d = 0;
      let hit = false;
      let close = -1;
      for (let j = i + 1; j < toks.length; j++) {
        const u = toks[j]!;
        if (u.type === "eof") break;
        if (u.type === "punct" && u.value === "[") { d++; continue; }
        if (u.type === "punct" && u.value === "]") { if (d === 0) { close = j; break; } d--; continue; }
        if (d === 0 && u.type === "ident" && u.value === "length" &&
            toks[j - 1]?.type === "punct" && toks[j - 1]?.value === ".") hit = true;
      }
      if (!hit || close < 0) continue;
      const after = toks[close + 1];
      out.push({
        line: base + t.line - 1,
        asserted: after?.type === "punct" && after.value === "!",
        inTemplate: depth > 0,
      });
    }
  };
  walk(source, 0, 1);
  return out;
}

export const FIX =
  "use `xs.at(-1)` (scalar elements only — `.at` on a heap element is NT1001) or hoist " +
  "`const n = xs.length` and test it. `xs[xs.length - 1]` reads index -1 on an empty " +
  "array, which node answers `undefined` and nativets PANICS on by design (Stage 41).";

describe("src/ never depends on an out-of-range read returning `undefined`", () => {
  function scanSrc(): { unasserted: Record<string, number>; asserted: Record<string, number>; where: string[] } {
    const unasserted: Record<string, number> = {}, asserted: Record<string, number> = {};
    const where: string[] = [];
    for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort()) {
      const source = readFileSync(new URL(f, SRC), "utf8");
      const lines = source.split("\n");
      for (const hit of lengthIndexReads(source)) {
        const bucket = hit.asserted ? asserted : unasserted;
        bucket[f] = (bucket[f] ?? 0) + 1;
        if (!hit.asserted) {
          where.push(`${f}:${hit.line}${hit.inTemplate ? " (in a template substitution)" : ""}` +
            `  ${(lines[hit.line - 1] ?? "").trim()}\n  = ${FIX}`);
        }
      }
    }
    return { unasserted, asserted, where };
  }

  test("no `xs[xs.length - N]` without a `!` — that guard can never run", () => {
    const { unasserted, where } = scanSrc();
    // `where` is asserted alongside the tally so a failure names the LINES and the fix,
    // not just a count: the repair is per-site and a bare number sends the reader back
    // to the scan.
    expect({ unasserted, where }).toEqual({ unasserted: UNASSERTED, where: [] });
  });

  test("the asserted sites are a ratchet that may only shrink", () => {
    expect(scanSrc().asserted).toEqual(ASSERTED);
  });

  /* The scan must be able to FAIL. These are the shapes `src/` actually contained. */
  test("it tells the two forms apart — plain, `!`, dotted, `this.`", () => {
    for (const [line, want] of [
      ["const a = xs[xs.length - 1];", false],
      ["const a = xs[xs.length - 1]!;", true],
      ["const last = fn.body[fn.body.length - 1];", false],          // a dotted receiver
      ["const h = this.tryHandlers[this.tryHandlers.length - 1]!;", true], // a `this.` field
    ] as const) {
      expect([line, lengthIndexReads(line).map((h) => h.asserted)]).toEqual([line, [want]]);
    }
  });

  /*
   * The three axes on which this scan is wider than the `. length - 1 ]` run it replaced.
   * Each was a real miss in this tree, not a hypothetical one.
   */
  test("WIDER 1 — it sees inside a TEMPLATE SUBSTITUTION (codegen.ts hid two there)", () => {
    const real = "this.terminate(`br label %${this.loops[this.loops.length - 1]!.brk}`);";
    expect(lengthIndexReads(real)).toEqual([{ line: 1, asserted: true, inTemplate: true }]);
    // nested one level deeper still
    expect(lengthIndexReads("const a = `${`${xs[xs.length - 1]}`}`;")).toHaveLength(1);
  });

  test("WIDER 2 — any `- N`, not just the literal 1", () => {
    // The previous scan asserted `xs[xs.length - 2]` was NOT a hit. It panics identically.
    expect(lengthIndexReads("const a = xs[xs.length - 2];")).toHaveLength(1);
    expect(lengthIndexReads("const a = xs[xs.length - 1];")).toHaveLength(1);
  });

  test("WIDER 3 — `.length` anywhere at depth 0 in the subscript, e.g. under Math.min", () => {
    // src/checker.ts held this one LIVE and unasserted; the narrower run could not
    // match it because the token after `1` is `)`, not `]`.
    expect(lengthIndexReads("const pat = patterns[Math.min(i, patterns.length - 1)];"))
      .toEqual([{ line: 1, asserted: false, inTemplate: false }]);
  });

  test("no false positives: the sanctioned spellings, a slice, a comment, a hint STRING", () => {
    for (const ok of [
      "const last = xs.at(-1);",                                       // spelling 1
      "const n = xs.length; if (n > 0) { const last = xs[n - 1]!; }",  // spelling 2 (ast.ts)
      // an ARRAY LITERAL holding a slice — src/lexer.ts. `.slice(0, -1)` never panics.
      "frames = [...frames.slice(0, frames.length - 1), top + 1];",
      "const shorter = xs.slice(0, xs.length - 1);",
      // checker.ts's `.pop` hint contains this text verbatim. One `str` token, no hit.
      'throw e("use `arr[arr.length - 1]` for the last element");',
      "// xs[xs.length - 1] was the old spelling\nconst n = 1;",
      "/* was xs[xs.length - 1] */ const x = 1;",
      "const a = xs.length - 1;",
      "const m = ys[i];",
      "return [xs.length - 1];",                                       // an array literal
    ]) {
      expect([ok, lengthIndexReads(ok).length]).toEqual([ok, 0]);
    }
  });

  test("a `.length` in an INNER index belongs to the inner read — one hit, not two", () => {
    expect(lengthIndexReads("const inner = xs[ys[ys.length - 1]!]!;")).toHaveLength(1);
  });
});

/*
 * `.at(-1)` is the better spelling and is NOT universally available. Measured rather than
 * assumed, because a lane told to "just use `.at(-1)`" would plant an NT1001 in a rung-3
 * module: `src/lexer.ts`'s receiver is a `Token[]` and `src/checker.ts`'s is a `Stmt[]`.
 */
describe("the two sanctioned spellings, against the real pipeline", () => {
  test("`.at(-1)` compiles for scalar element types", () => {
    for (const t of ["number", "string", "boolean"]) {
      expect(() => sourceToIR(`const xs: ${t}[] = [];\nconsole.log(xs.at(-1));\n`)).not.toThrow();
    }
  });

  test("`.at` on an array of OBJECTS is NT1001 — which is why the hoist spelling exists", () => {
    expect(() => sourceToIR("type P = { a: number };\nconst ps: P[] = [];\nconsole.log(ps.at(-1) === undefined);\n"))
      .toThrow(/NT1001/);
  });
});

/*
 * ============================================================================
 * BEHAVIOUR — with node's `undefined` taken away
 * ============================================================================
 *
 * A plain assertion here is GREEN ON THE BROKEN CODE, because node's answer for the
 * out-of-range read is `undefined` — precisely the answer the code must not depend on.
 * When the oracle's correct answer coincides with the bug's, you have to change the
 * oracle.
 *
 * ---- Why the Proxy is not enough, since that is what the next person will reach for ----
 * test/block-drops.test.ts wraps ONE array in a `Proxy` whose `get` throws out of range.
 * That works there because the array is a PARAMETER the test can hand in. It cannot work
 * here: the arrays are `Checker`'s and `FnGen`'s own fields and locals, built deep inside
 * a compile, and there is no seam to inject a proxy through.
 *
 * A `"-1"` accessor on `Array.prototype` is the whole-process version of the same move.
 * `xs[-1]` on an array with no own `-1` key walks the prototype chain, so defining a
 * throwing getter there makes EVERY out-of-range `-1` read in the process throw — which
 * is exactly nativets' semantics, imported into bun for the length of one test. It is
 * surgical: an in-range read never consults the prototype, `.at(-1)` is a method call and
 * is untouched, and a negative `.slice` is untouched. Installed and removed around each
 * case so it cannot leak into another test file sharing the process.
 *
 * This suite reads no source, so unlike the lint above it is blind to nothing — it is the
 * backstop for the hoisted-length shape the scan cannot decide.
 */
describe("compiling does not read index -1", () => {
  const withMinusOneFatal = (body: () => void): void => {
    Object.defineProperty(Array.prototype, "-1", {
      configurable: true,
      get(this: unknown[]) {
        throw new RangeError(`index out of bounds: the length is ${this.length} but the index is -1`);
      },
    });
    try { body(); } finally { delete (Array.prototype as unknown as Record<string, unknown>)["-1"]; }
  };

  test("the oracle change is REAL — it fails on the banned shape and not on the fix", () => {
    withMinusOneFatal(() => {
      const banned = (b: unknown[]): boolean => b[b.length - 1] !== undefined;
      expect(() => banned([])).toThrow(RangeError);
      expect(banned([1])).toBe(true);                       // an in-range read is untouched
      const hoisted = (b: unknown[]): boolean => { const n = b.length; return n > 0 && b[n - 1] !== undefined; };
      expect(hoisted([])).toBe(false);
      expect(hoisted([1])).toBe(true);
      expect([].at(-1)).toBeUndefined();                    // `.at(-1)` is untouched
      expect([1, 2, 3].slice(0, -1)).toEqual([1, 2]);       // a negative slice is untouched
    });
  });

  /*
   * Each program reached a DIFFERENT site with an empty array. Measured by planting a
   * tripwire at all 18 census sites and running them, not by reading the code.
   */
  const U = 'type A = { k: "a"; n: number };\ntype B = { k: "b"; s: string };\ntype U = A | B;\n';
  const PROGRAMS: [string, string][] = [
    ["an EMPTY program", ""],
    ["an empty function body with a return type", "function f(): number {}\nconsole.log(1);\n"],
    ["an empty block", "if (1 > 0) {}\nconsole.log(1);\n"],
    ["an empty `case` in a tail switch", U + 'function f(u: U): number { switch (u.k) { case "a": return 1; case "b": } }\nconsole.log(f({ k: "a", n: 1 }));\n'],
    ["a `throw` outside any `try`", 'throw "boom";\n'],
    // `existsSync` cannot fail and so emits no exception check; the difference matters.
    ["a failable host call outside any `try`", 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("/etc/hosts", "utf8").length > 0);\n'],
    ["a top-level `return x;`", "const a = 1;\nreturn a;\n"],
    ["a file whose FIRST character opens a regex", '/abc/.test("a");\n'],
    // The three that reach checker.ts's generic-instantiation clamp with ZERO parameter
    // patterns. All three are REFUSED programs, and that is the point: a self-hosted
    // compiler would abort here instead of printing the diagnostic.
    ["a zero-parameter generic, type argument explicit", "function f<T>(): number { return 1; }\nconsole.log(f<number>(1));\n"],
    ["a zero-parameter generic, type argument inferred", "function f<T>(): number { return 1; }\nconsole.log(f(1));\n"],
    ["a zero-parameter generic METHOD", "class C { m<T>(): number { return 1; } }\nconsole.log(new C().m<number>(1));\n"],
  ];

  for (const [name, src] of PROGRAMS) {
    test(name, () => {
      withMinusOneFatal(() => {
        // Several of these are legitimate REFUSALS (NT1027, NT1013, NT2001). A refusal
        // is fine; a RangeError is the bug. Discriminate on the error, never on whether
        // it threw — that distinction is the whole test.
        try { sourceToIR(src, "/tmp/nt-index-last-probe.ts"); }
        catch (e) {
          if (e instanceof RangeError) throw e;
          expect(String((e as Error).message)).toMatch(/NT\d{4}/);
        }
      });
    });
  }
});
