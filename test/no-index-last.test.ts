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
 * `codegen.ts`'s `typeofNameOf(members[members.length - 1]!)` (a general union has >= 2
 * members, and `typeofNameOf(undefined)` answers `"object"` rather than throwing — every
 * predicate inside `staticTypeofName` short-circuits on `typeof t === "string"`), `checker.ts`'s
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
import { preprocessForCoverage } from "../src/coverage-preprocess.ts";
import { linkProgram } from "../src/modules.ts";
import { check } from "../src/checker.ts";

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
  "checker.ts": 3,
  "codegen.ts": 6,
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
  "use `xs.at(-1)` (scalar elements only — `.at` on a heap element is NT1001; a STRING " +
  "receiver is fine and `src/lexer.ts`'s `source.at(st.i + 1)` proves it, in a module at " +
  "rung 3) or hoist `const n = xs.length` and test it. `xs[xs.length - 1]` reads index -1 " +
  "on an empty array, which node answers `undefined` and nativets PANICS on by design " +
  "(Stage 41).";

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

/*
 * ============================================================================
 * THE OTHER END OF THE ARRAY — `s[i]` where `i` can equal `s.length`
 * ============================================================================
 *
 * Everything above is about index -1: the read BELOW the array. This section is about the
 * read at index == LENGTH, which panics identically and which the lint above is
 * structurally blind to — the subscript is a cursor, not `xs.length - 1`, so no source
 * pattern names it.
 *
 * ---- Why it needs its own instrument: it was LIVE, and it was not one site ----
 * `test/sh6-fuzz.test.ts` found six of them across the three modules recorded at rung 3,
 * and the headline one is `pragmaName`:
 *
 *     let a = 0;
 *     while (a < body.length && isSpace(body[a]!)) a++;
 *     if (body[a] !== "@" || body[a + 1] !== "@") return "";     // a === body.length
 *
 * A bare `//` has an EMPTY body, so `body[0]` is out of range: `undefined !== "@"` under
 * node, a PANIC under nativets. 43 lines of `src/` are a bare `//`, five of them in
 * `src/lexer.ts`, so the self-compiled lexer could not lex the compiler's own source while
 * its SH6 row read rung 3. THREE of the six sites carried a `?? ""` the panic never
 * reached — a dead guard, and one tsc reads as live because `noUncheckedIndexedAccess`
 * types the read `T | undefined`. The same blindness the header above describes for -1.
 *
 * ---- The census, measured rather than counted by eye ----
 * `src/` holds 573 computed index reads. Instrumenting EVERY ONE of them — rewriting
 * `RECV[SUB]` into a recording helper, driven by the compiler's own lexer, with
 * byte-identical IR out of the instrumented compiler as the evidence the rewrite was
 * faithful — and then running lex + preprocess over all of `src/`, lex over all 492 `.ts`
 * files in the tree, and `sourceToIR` over 169 fixtures and examples, found 15 that
 * ACTUALLY read out of range on that workload:
 *
 *   7 STRING sites  — `pragmaName` x2 (the bare `//`), the three numeric-literal
 *                     continuation reads at end of file, `modules.ts`'s `t[j] === "{"`
 *   8 ARRAY sites   — `e.args[0]`, `args[1] ? …`, `args[i] ?? …`, `fn.params[0]?.name`:
 *                     argument lists that are simply SHORTER than the read, in
 *                     `checker.ts` (1), `codegen.ts` (6) and `ownership.ts` (1)
 *
 * The prefix sweep below and `test/sh6-fuzz.ts` then found SIXTEEN MORE that a
 * well-formed corpus can never reach — every end-of-input path in both scanners: a file
 * ending in `/`, in `"`, in `` ` ``, in `\`, in `$`, in `*`, an unterminated `/*`, an empty
 * file. 31 sites in 7 modules, all fixed, all with a `length` test that never FORMS the
 * index. Two lessons worth keeping: a real-workload census finds the sites that fire
 * TODAY and is blind to the error paths, and the error paths are where a compiler spends
 * its time being wrong.
 *
 * ---- What this test is, and what it is NOT ----
 * It is the FAST gate: pure bun, about a second, run on every suite. The SLOW authority is
 * `test/sh6-fuzz.test.ts`'s `corpus: "src"` differential, which compiles the modules and
 * compares them against bun over the compiler's own twelve files (~60 s). This one exists
 * because a class that took a 553-input spawn-based sweep to find should also have a gate
 * cheap enough that nobody is tempted to skip it.
 *
 * ---- The oracle change, and why the prototype trick works for strings too ----
 * `"abc"[5]` finds no own property and walks `String.prototype`, exactly as `xs[-1]` walks
 * `Array.prototype` above. A throwing getter at "0".."31" therefore makes every
 * out-of-range read at a SMALL index throw, which is nativets' semantics imported into bun
 * for the length of one test. An IN-RANGE read never consults the prototype, `.at(i)` is a
 * method call and is untouched, and `.length`/`.slice` are untouched.
 *
 * "Small index" is the limitation, and the fix for it is the corpus: reads are driven off
 * the END of the input, so TRUNCATING every input to 32 bytes puts every end-of-input
 * index inside the instrumented range. That is why the prefix sweep below exists and why
 * it is not merely lexing whole files.
 */
describe("src/ never depends on a string read at index == length", () => {
  const LIMIT = 32;
  const withOverrunFatal = (body: () => void): void => {
    for (let k = 0; k < LIMIT; k++) {
      Object.defineProperty(String.prototype, String(k), {
        configurable: true,
        get(this: string) {
          throw new RangeError(`string index out of bounds: the length is ${this.length} but the index is ${k}`);
        },
      });
    }
    try { body(); } finally {
      for (let k = 0; k < LIMIT; k++) delete (String.prototype as unknown as Record<string, unknown>)[String(k)];
    }
  };

  test("the oracle change is REAL — it fires on the banned shape and not on the fix", () => {
    withOverrunFatal(() => {
      const banned = (s: string): boolean => s[0] === "@";
      expect(() => banned("")).toThrow(RangeError);
      expect(banned("@x")).toBe(true);                  // an in-range read is untouched
      const guarded = (s: string): boolean => s.length > 0 && s[0] === "@";
      expect(guarded("")).toBe(false);
      expect("".at(0)).toBeUndefined();                 // `.at` is untouched
      expect("abc".slice(0, 2)).toBe("ab");             // `.slice` is untouched
      expect("".length).toBe(0);                        // `.length` is untouched
    });
  });

  /**
   * The whole compiler's own source, lexed and preprocessed. This is what the bare `//`
   * defect broke, and at index 0 the tripwire sees it directly.
   */
  test("lex + preprocessForCoverage over every src/*.ts", () => {
    const files = readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort();
    expect(files.length).toBeGreaterThan(10);
    withOverrunFatal(() => {
      for (const f of files) {
        const source = readFileSync(new URL(f, SRC), "utf8");
        [...lex(source)];
        preprocessForCoverage(source);
      }
    });
  });

  /**
   * EVERY PREFIX of a set of inputs chosen so that truncation lands mid-construct. This is
   * the part that reaches the run-off-the-end sites: an unterminated string, comment,
   * template or escape, and a numeric literal that ends the file. Each of the six sites
   * the fuzz lane minimized appears here as some prefix of some line.
   */
  test("every prefix (1..32 bytes) of inputs that end mid-construct", () => {
    const SOURCES = [
      '//\nconst a = 1;\n',                 // a bare line comment — pragmaName
      '// \t \nconst a = 1;\n',             // whitespace-only comment body — pragmaName
      '//@@mutable\nconst a = 1;\n',        // a real pragma, so the happy path is covered
      '/* unterminated comment',            // `advance` past the end
      'const s = "abc";\n',                 // truncates to an unterminated string at EOF
      "const s = 'a\\nb';\n",               // ...and truncates mid-ESCAPE
      'const t = `a${1 + 2}b`;\n',          // an unterminated template
      'const n = 1234.5e+6;\n',             // a numeric literal that ends the input
      'const h = 0xff + 1_0;\n',            // radix + separator, truncated
      '#!/usr/bin/env bun\nconst a = 1;\n', // a shebang, and the EMPTY file at prefix 0
    ];
    withOverrunFatal(() => {
      for (const src of SOURCES) {
        for (let n = 0; n <= Math.min(LIMIT, src.length); n++) {
          const head = src.slice(0, n);
          // A LexError is the CORRECT answer for a truncated input and must not be
          // confused with the bug. A RangeError is the bug, and it propagates.
          try { [...lex(head)]; } catch (e) { if (e instanceof RangeError) throw e; }
          try { preprocessForCoverage(head); } catch (e) { if (e instanceof RangeError) throw e; }
        }
      }
    });
  });
});

/*
 * ============================================================================
 * THE ARRAY HALF OF THE SAME END — a HOST CALL'S ARGUMENT LIST, read past its length
 * ============================================================================
 *
 * The census in the header above names this family and had no instrument:
 *
 *   8 ARRAY sites — `e.args[0]`, `args[1] ? …`, `args[i] ?? …`, `fn.params[0]?.name`:
 *                   argument lists that are simply SHORTER than the read
 *
 * The string half above got the `String.prototype` tripwire; the array half got nothing,
 * and it regressed. `Checker.checkHostCall` runs BEFORE `checkArgs` — see the host-FFI
 * branch of `Checker.type`, which calls them in that order — so ARITY IS NOT YET CHECKED
 * when the per-host option validators run. `spawnSync("ls")` therefore reached
 * `spawnMode`'s `args[2]` and `readFileSync(p)` reached `args[1]`, both out of range. Both
 * sites then tested the VALUE (`opts !== undefined`, `!enc`), which is node's answer and
 * not this compiler's: nativets panics on the read, so neither guard could ever run and a
 * self-hosted nativets would ABORT where it should print NT1028. Both are now length-first.
 *
 * ---- Why this needs a different instrument from the two above ----
 * The prototype trick cannot be reused at the POSITIVE end. `xs[-1]` is a read-only shape,
 * so a throwing getter on `Array.prototype["-1"]` is harmless; but a getter at
 * `Array.prototype["0"]` with no setter makes `xs.push(v)` on an EMPTY array an assignment
 * to a readonly property, and the compiler pushes onto empty arrays constantly. The
 * process-wide move breaks the subject rather than observing it.
 *
 * So this instrument is SCOPED instead of global: parse the program, then swap a call's
 * `args` array for a Proxy that panics out of range, exactly as Stage 41 does. `rmSync` is
 * in the table as the CONTROL — it has always tested `args.length === 2` first, so it must
 * stay green, which is what shows the tripwire is discriminating rather than firing on
 * everything.
 *
 * ---- CORRECTION: it was SCOPED TO HOST CALLS, and the whitelist WAS the blind spot ----
 * It armed only eleven `node:` builtin names, on the theory that `checkHostCall` running
 * before `checkArgs` was the root cause. That is not the root cause. The host-FFI branch is
 * one of many bespoke validators, and its ordering is not even the general shape of the
 * bug. The rule is simply READ `args[i]` ONLY AFTER PROVING `i < args.length`, and most
 * validators that break it never call `checkArgs` at all — so no reordering can reach them.
 * (Reordering was measured before being rejected: it fixes none of the sites below, and it
 * moves 28 of 195 host-call diagnostics, including turning `readFileSync(path)`'s NT1028 —
 * which tells you to write `readFileSync(path, "utf8")` — into a bare arity count.)
 *
 * Arming EVERY call, which the whitelist prevented, found five more sites, none a host call:
 *
 *   checker.ts  inferSearchHof    `const arrow = args[0]; if (!arrow || …)`   `xs.find()`
 *   checker.ts  inferForEach      the same shape                              `xs.forEach()`
 *   checker.ts  inferHof          the same shape                              `xs.map()`
 *   checker.ts  inferCall/Object  `exprLoc(e.args[0]) ?? e.loc`               `Object.assign()`
 *   checker.ts  inferCall/spawn   `this.typeArg(e.args[0]!, …)`, five lines
 *                                 above the arity check that guards it        `spawn()`
 *
 * Three of those guard on the TRUTHINESS of the value (`!arrow`). A truthiness guard raises
 * no diagnostic, so the self-host frontier metric cannot see it at all — grep for the READ,
 * never for the diagnostic. And `spawn()` did not need nativets' semantics to be wrong: it
 * crashed the compiler under bun with a raw `TypeError: undefined is not an object`, no NT
 * code, exit 1 — "reject, never miscompile" broken in the loudest way available.
 *
 * The instrument is GENERAL now: every `CallExpr`/`NewExpr` in the program is armed. A
 * whitelist can only re-confirm the theory that drew it up; this class is found by the
 * sweep that has no theory.
 */
describe("src/ never reads a call's argument list past its length", () => {
  const panicOutOfRange = (xs: unknown[]): unknown[] =>
    new Proxy(xs, {
      get(t, p, r) {
        if (typeof p === "string" && String(Number(p)) === p) {
          const i = Number(p);
          if (i < 0 || i >= (t as unknown[]).length)
            throw new RangeError(`index out of bounds: the length is ${(t as unknown[]).length} but the index is ${i}`);
        }
        return Reflect.get(t, p, r);
      },
    });

  /** Replace EVERY call's `args` with a panicking Proxy, in place. */
  const armCallArgs = (n: unknown, seen: Set<unknown> = new Set()): void => {
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { for (const v of n) armCallArgs(v, seen); return; }
    const o = n as Record<string, unknown>;
    if ((o["kind"] === "CallExpr" || o["kind"] === "NewExpr") && Array.isArray(o["args"])) {
      // Arm AFTER walking the children: the Proxy would panic on nothing here, but the
      // walk reads indices and there is no reason to route it through the tripwire.
      for (const v of o["args"] as unknown[]) armCallArgs(v, seen);
      for (const k of Object.keys(o)) if (k !== "args") armCallArgs(o[k], seen);
      o["args"] = panicOutOfRange(o["args"] as unknown[]);
      return;
    }
    for (const k of Object.keys(o)) armCallArgs(o[k], seen);
  };

  /**
   * `null` expects a clean check; an `NT` string expects that REFUSAL and not a panic.
   * The under-length calls must still produce their diagnostic — reaching it is the whole
   * point, and "it stopped panicking because it stopped checking" is the failure mode a
   * bare "did not throw RangeError" assertion would pass.
   */
  const CASES: [string, string, string | null][] = [
    ["spawnSync(cmd) — one arg, `args[2]` out of range",
     'import { spawnSync } from "node:child_process";\nconst r = spawnSync("ls");\nconsole.log(r.status);\n', "NT1028"],
    ["spawnSync(cmd, argv) — two args, `args[2]` == length",
     'import { spawnSync } from "node:child_process";\nconst r = spawnSync("ls", []);\nconsole.log(r.status);\n', "NT1028"],
    ["readFileSync(path) — one arg, `args[1]` out of range",
     'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("/etc/hosts").length);\n', "NT1028"],
    // CONTROL: length-guarded since it was written. Green here proves the tripwire is
    // selective — if this one failed, the instrument would be flagging every host call.
    ["rmSync(path) — one arg, the CONTROL (already length-guarded)",
     'import { rmSync } from "node:fs";\nrmSync("/tmp/nt-idxnull");\n', null],
    ["the well-formed spawnSync, three args",
     'import { spawnSync } from "node:child_process";\nconst r = spawnSync("ls", [], { encoding: "utf8" });\nconsole.log(r.status);\n', null],

    /* --- The five the HOST-ONLY whitelist could not see. None is a host call, so the
     * `checkArgs`/`checkHostCall` ordering is irrelevant to every one of them. --- */
    ["xs.find() — no callback, `args[0]` out of range (inferSearchHof)",
     "const xs: number[] = [1, 2];\nconsole.log(xs.find());\n", "NT1003"],
    ["xs.some() — the same site, a different method name",
     "const xs: number[] = [1, 2];\nconsole.log(xs.some());\n", "NT1003"],
    ["xs.forEach() — no callback (inferForEach)",
     "const xs: number[] = [1, 2];\nxs.forEach();\n", "NT1003"],
    ["xs.map() — no callback (inferHof)",
     "const xs: number[] = [1, 2];\nconsole.log(xs.map());\n", "NT1003"],
    ["xs.filter() — the same site, a different method name",
     "const xs: number[] = [1, 2];\nconsole.log(xs.filter());\n", "NT1003"],
    ["Object.assign() — no target, `exprLoc(e.args[0])` for the caret",
     "Object.assign();\n", "NT1606"],
    // The one that was ALREADY broken under bun: a raw TypeError, no NT code, exit 1.
    ["spawn() — the arity check sits five lines BELOW the read it guards",
     "spawn();\n", "NT2001"],

    /* CONTROLS for the five: the well-formed spellings, which must stay green both before
     * and after the fix. Without these the table cannot tell "stopped panicking" from
     * "stopped checking". */
    ["the well-formed xs.map, one inline arrow — CONTROL",
     "const xs: number[] = [1, 2];\nconsole.log(xs.map((x: number) => x + 1));\n", null],
    ["the well-formed xs.find, one inline arrow — CONTROL",
     "const xs: number[] = [1, 2];\nconsole.log(xs.find((x: number) => x > 1));\n", null],
    ["the well-formed xs.forEach, one inline arrow — CONTROL",
     "const xs: number[] = [1, 2];\nxs.forEach((x: number) => { console.log(x); });\n", null],
    ["the well-formed xs.reduce, callback AND initial value — CONTROL",
     "const xs: number[] = [1, 2];\nconsole.log(xs.reduce((a: number, b: number) => a + b, 0));\n", null],
    // `xs.forEach(go)` — a ONE-argument call, so nothing is out of range. It must keep the
    // NT1003 that test/foreach.test.ts pins, which is what shows the fix is a bounds fix
    // and not a rewrite of what these methods accept.
    ["xs.forEach(go) — point-free, in range, still NT1003 — CONTROL",
     "function go(x: number): void { console.log(x); }\nconst xs: number[] = [1, 2];\nxs.forEach(go);\n", "NT1003"],
    ["Object.assign(a, b) — in range, keeps its NT1606 — CONTROL",
     "const a = { x: 1 };\nconst b = { y: 2 };\nconsole.log(Object.assign(a, b));\n", "NT1606"],
  ];

  for (const [name, src, want] of CASES) {
    test(name, () => {
      const program = linkProgram(src, "/tmp/nt-idxnull-hostargs.ts");
      armCallArgs(program);
      let got: string | null = null;
      try { check(program); }
      catch (e) {
        // A RangeError is THE BUG and propagates. A diagnostic is a legitimate answer.
        if (e instanceof RangeError) throw e;
        const m = /NT\d{4}/.exec(String((e as Error).message));
        got = m ? m[0] : `unexpected: ${String((e as Error).message).slice(0, 60)}`;
      }
      expect([name, got]).toEqual([name, want]);
    });
  }

  test("the tripwire is REAL — it fires on the shape the fix replaced", () => {
    // The pre-fix spelling, run against the same Proxy: a value test on an out-of-range
    // read. Without this, a tripwire that silently armed nothing would pass every case.
    const args = panicOutOfRange([{ kind: "StringLiteral" }]);
    expect(() => (args as { kind: string }[])[2] !== undefined).toThrow(RangeError);
    // ...and the length-first spelling that replaced it never forms the index.
    expect(args.length < 3).toBe(true);
  });

  /*
   * `spawn()` needs NO instrument. Every other member of this class is latent — correct
   * under bun, a panic only once self-hosted — but this one dereferenced the `undefined`
   * that bun handed back (`typeArg`'s `a.kind`) and so crashed the COMPILER outright:
   *
   *   $ nativets run spawn.ts
   *   TypeError: undefined is not an object (evaluating 'a.kind')   ... exit 1
   *
   * A raw stack trace with no NT code is "reject, never miscompile" broken in the loudest
   * way available, and it survived because nothing calls `spawn` with zero arguments on
   * purpose. Asserted here WITHOUT the Proxy so a future edit cannot pass by disarming the
   * instrument, and the message is pinned because the fix is exactly "the arity check that
   * was already written five lines below now leads".
   */
  test("`spawn()` is a DIAGNOSTIC, not a compiler crash — no tripwire involved", () => {
    let msg = "";
    try { sourceToIR("spawn();\n", "/tmp/nt-arityorder-spawn0.ts"); }
    catch (e) { msg = String((e as Error).message); }
    expect(msg).toContain("NT2001");
    expect(msg).toContain("spawn(body, arg) takes two arguments");
    // The exact shape of the crash, named so it cannot come back wearing a passing test:
    // a bare TypeError carries no NT code, and `toContain("NT2001")` above is what fails.
    expect(msg).not.toContain("undefined is not an object");
  });
});
