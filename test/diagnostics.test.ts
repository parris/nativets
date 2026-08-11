/*
 * Multi-span diagnostics — a use-after-move (NT1601) now renders rustc-style, pointing at
 * BOTH the offending use and the earlier move, with source lines + caret underlines, instead
 * of the old one-line "(moved at line X, used at line Y)" string.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { formatDiagnostic, NYI, internalError } from "../src/diagnostics.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";
import { parseExpressionFrom } from "../src/parser.ts";
import { exprLoc } from "../src/ast.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Compile `src` through the real CLI and capture exactly what a user would see. */
function cliEmit(src: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "ntcodes-"));
  try {
    const f = join(dir, "case.ts");
    writeFileSync(f, src);
    const r = spawnSync("bun", ["run", join(HERE, "..", "src", "cli.ts"), "emit", f], {
      encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * The NT code space is the project's public taxonomy: `coverage` groups blockers BY code,
 * and docs/divergences.md indexes by code. Two features sharing one code silently corrupts
 * both. This actually happened — two parallel lanes each minted NT1021 (actor message types
 * and `instanceof`), on different lines, so git merged them without a conflict and neither
 * branch could see it. `instanceof` was renumbered to NT1022; this guard makes the next
 * collision a test failure instead of a merge that looks clean.
 */
describe("NT code space", () => {
  test("every NYI entry has a UNIQUE code", () => {
    const byCode = new Map<string, string[]>();
    for (const [name, spec] of Object.entries(NYI)) {
      byCode.set(spec.code, [...(byCode.get(spec.code) ?? []), name]);
    }
    const collisions = [...byCode].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });
});

describe("multi-span diagnostics", () => {
  test("formatDiagnostic renders primary + secondary spans against the source", () => {
    const source = "const a = [1, 2, 3];\nconst b = a;\nconsole.log(a.length);\n";
    const out = formatDiagnostic(
      {
        code: "NT1601",
        message: "use of moved value: `a`",
        spans: [
          { line: 3, label: "value used here after move", primary: true },
          { line: 2, label: "value moved here" },
        ],
      },
      source,
    );
    expect(out).toContain("error[NT1601]: use of moved value: `a`");
    // both source lines appear, each on its own numbered gutter line
    expect(out).toContain("3 | console.log(a.length);");
    expect(out).toContain("2 | const b = a;");
    // primary uses ^ carets, secondary uses - underline
    expect(out).toContain("^ value used here after move");
    expect(out).toContain("- value moved here");
  });

  test("falls back to the compact single-line form without spans or source", () => {
    const compact = formatDiagnostic({ code: "NT2001", message: "boom" });
    expect(compact).toBe("error[NT2001]: boom");
    // spans but no source → still compact (can't draw carets without the text)
    const noSrc = formatDiagnostic({ code: "NT1601", message: "x", spans: [{ line: 1, label: "here", primary: true }] });
    expect(noSrc).toBe("error[NT1601]: x");
  });

  test("a hint is rendered as a help line", () => {
    const out = formatDiagnostic({ code: "NT1003", message: "closures", hint: "need env" });
    expect(out).toContain("= help: need env");
  });

  test("end-to-end: sourceToIR throws an NT1601 carrying move + use spans", () => {
    const source = "const a: number[] = [1, 2, 3];\nconst b = a;\nconsole.log(a.length);\n";
    let err: NTError | undefined;
    try { sourceToIR(source); } catch (e) { if (e instanceof NTError) err = e; }
    expect(err).toBeDefined();
    expect(err!.diag.code).toBe("NT1601");
    const spans = err!.diag.spans!;
    expect(spans.length).toBe(2);
    // the use (line 3) is primary; the move (line 2) is the secondary context span
    expect(spans.find((s) => s.primary)!.line).toBe(3);
    expect(spans.find((s) => !s.primary)!.line).toBe(2);
    // and it renders with both source lines
    const rendered = formatDiagnostic(err!.diag, source);
    expect(rendered).toContain("const b = a;");
    expect(rendered).toContain("console.log(a.length);");
  });
});

/*
 * No INTERNAL error may reach the user (CLAUDE.md's prime directive: "anything we can't
 * compile correctly gets an NT**** diagnostic with a hint").
 *
 * src/cli.ts's `guard` renders an NTError and exits 1; anything else propagates to Bun and
 * prints a raw stack trace naming our own source files. So the contract is checked where
 * the user stands — through the CLI — and the load-bearing assertion is the ABSENCE of a
 * stack trace, not just the presence of a code.
 *
 * These are all REFUSALS, so node is not the oracle: node runs every one of these programs.
 * What is asserted is the shape of the refusal and a nonzero exit.
 */
describe("no internal error reaches the user", () => {
  /** The shape every refusal must have: a code, a hint, a nonzero exit, NO stack trace. */
  function expectClean(out: string, code: number, ntCode: string): void {
    expect(out).toContain(`error[${ntCode}]`);
    expect(out).toContain("= help:");
    expect(code).not.toBe(0);
    // The regression that matters: an internal throw prints a Bun stack trace whose frames
    // name our source files. None of those may appear.
    expect(out).not.toContain("    at ");
    expect(out).not.toContain("src/codegen.ts:");
  }

  // `throw` outside a `try` IN THE SAME FUNCTION. Every one of these is ordinary
  // TypeScript that node runs; all of them reached `codegen.ts` line 1323's
  // `throw new Error("throw outside a try (unsupported)")`.
  //
  // What survives here is the half that genuinely needs cross-frame propagation: the
  // throw is in a CALLEE and the `try` is at the call site, so the exception has to
  // leave a frame. The other half — a throw NOBODY can catch — now compiles and is
  // node-differential in test/uncaught-throw.test.ts (it is just `exit 1`).
  //
  // TWO OF THE FOUR MOVED OUT, to the block below: `try { f() } catch (e)` where `f`
  // raises an object now COMPILES. The blocker was never the payload alone — the catch
  // binding took its type from the try block's OWN throws, so the plain idiom bound
  // `"string"` and `scanEscaping` rule 3 rejected the raise. `inferThrowType` asks the
  // block's callees too, and the object crosses the frame by MOVE (test/exc-move.test.ts).
  const THROWS: [string, string][] = [
    // A LIFTED arrow's throw runs in a frame the escape scan is not describing (rule 4).
    ["throw from an arrow", `const f = (): number => { throw new Error("b"); };\ntry { console.log(f()); } catch (e) { console.log("c"); }\n`],
  ];
  for (const [name, src] of THROWS) {
    test(`NT1004, not a stack trace: ${name}`, () => {
      const { out, code } = cliEmit(src);
      expectClean(out, code, "NT1004");
    });
  }

  // THE TWO THAT NOW COMPILE. node is the oracle again for these — it always ran them —
  // and both were verified against it: "caught" / exit 0, and "c" / exit 0.
  const NOW_COMPILES: [string, string][] = [
    ["function throws, try at the CALL SITE", `function f(): number { throw new Error("boom"); }\ntry { console.log(f()); } catch (e) { console.log("caught"); }\n`],
    ["rethrow from a callee's catch block", `function f(): number { try { throw new Error("a"); } catch (e) { throw new Error("b"); } }\ntry { console.log(f()); } catch (e) { console.log("c"); }\n`],
    // THE THIRD TO MOVE. `calleesOf` used to resolve only IDENTIFIER callees — a method
    // resolves by PROPERTY name, and every same-named method in the program would have to
    // agree — so the binding stayed untyped and the raise could not cross. It resolves
    // methods by UNANIMITY now (`.<prop>` matched by suffix against the linked names), so
    // this is node's "caught" / exit 0, verified.
    ["method throws, try at the call site", `class C { m(): number { throw new Error("b"); } }\ntry { console.log(new C().m()); } catch (e) { console.log("caught"); }\n`],
  ];
  for (const [name, src] of NOW_COMPILES) {
    test(`no longer NT1004 — the object crosses the frame: ${name}`, () => {
      const { out, code } = cliEmit(src);
      expect(code).toBe(0);
      expect(out).not.toContain("error[");
    });
  }

  // The same construct INSIDE a try in the same function still compiles — the refusal is
  // scoped to what codegen genuinely cannot lower, and did not swallow the working case.
  test("a throw inside a try in the same function still compiles", () => {
    const { out, code } = cliEmit(`try { throw new Error("boom"); } catch (e) { console.log("caught"); }\n`);
    expect(code).toBe(0);
    expect(out).not.toContain("error[");
  });
});

/*
 * The other side of the split. These sites are NOT user-reachable constructs: each one
 * means the frontend accepted something codegen cannot lower, so an NT code would be a
 * lie — it would hand the user a workaround for OUR bug. They keep their stack trace on
 * purpose (it is the bug-report artifact); what is pinned here is that the message says
 * whose defect it is, and that it never claims to be an NT diagnostic.
 */
describe("broken compiler invariants are labelled as OUR bug, not an NT code", () => {
  test("InternalError names the defect as ours and asks for a report", () => {
    const e = internalError("no lowering for array method .frobnicate");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InternalError");
    expect(e.message).toContain("internal compiler error:");
    expect(e.message).toContain("no lowering for array method .frobnicate");
    expect(e.message).toContain("bug in nativets, not in your program");
    expect(e.message).toContain("report");
    // Never an NT code: `coverage` groups blockers by code, and a compiler defect is not
    // a language feature anyone can burn down.
    expect(e.message).not.toContain("error[NT");
    expect(e).not.toBeInstanceOf(NTError);
  });

  // src/codegen.ts must route EVERY internal failure through it — a bare `throw new
  // Error` there is what printed a raw Bun stack trace with no explanation at all.
  test("src/codegen.ts contains no bare `throw new Error`", () => {
    const src = readFileSync(join(HERE, "..", "src", "codegen.ts"), "utf8");
    expect(src).not.toContain("throw new Error(");
  });
});

/*
 * The lexer's own errors. `LexError` is a plain `Error` subclass (it must stay one: it
 * lives in the compiler's OWN source, and `extends Error` is the only inheritance nativets
 * compiles), so every lexical failure used to reach the user as a raw Bun stack trace
 * naming src/lexer.ts — the same contract violation as codegen's, in a module reached by
 * something as ordinary as a missing closing quote.
 *
 * node rejects all of these too (SyntaxError), so they are syntax errors, not deferred
 * features: NT0001, the code every other parse failure already uses.
 */
describe("lexical errors are NT0001, not a stack trace", () => {
  const LEXICAL: [string, string][] = [
    ["unterminated string", 'const s = "unterminated;\nconsole.log(s);\n'],
    ["unterminated template", "const s = `unterminated;\nconsole.log(s);\n"],
    ["invalid \\x escape", 'const s = "\\xZZ";\nconsole.log(s);\n'],
    ["unexpected character", "const a = 1 # 2;\nconsole.log(a);\n"],
  ];
  for (const [name, src] of LEXICAL) {
    test(`NT0001, not a stack trace: ${name}`, () => {
      const { out, code } = cliEmit(src);
      expect(out).toContain("error[NT0001]");
      expect(code).not.toBe(0);
      expect(out).not.toContain("    at ");
      expect(out).not.toContain("src/lexer.ts:");
    });
  }
});

/*
 * `exprLoc` (src/ast.ts) — the descent that gives a diagnostic its SPAN.
 *
 * Most `Expr` nodes carry no `loc` of their own, so `exprLoc` descends to the first
 * child that does. The `UnaryExpr` arm read `e.argument` — an ESTree field name; the
 * interface has `operand` — so it was `exprLoc(undefined)` and returned `undefined` for
 * EVERY unary expression, silently. The error text was unchanged, which is why nothing
 * caught it: only the `at L:C` suffix and the source frame vanished, and only for
 * operands under a `-`/`!`/`+`/`~`.
 *
 * Found by tsc (TS2339, "property 'argument' does not exist on type 'UnaryExpr'") the
 * first time this project was semantically type-checked — see tsconfig.src.json.
 *
 * The differential oracle cannot see this: node accepts none of these programs, so the
 * contract is asserted directly, and against a CONTROL — the identical program without
 * the unary — so a future change that drops the location from both still fails.
 */
describe("diagnostic spans reach through a unary expression", () => {
  const emit = (src: string): string => {
    try { sourceToIR(src); return "(compiled)"; } catch (e) { return (e as Error).message; }
  };
  const FN = "function f(s: string): void { console.log(s); }\nconst n: number = 5;\n";

  test("`f(-n)` locates the argument, exactly as `f(n)` does", () => {
    // The control first: without the unary, the span has always been there — at the
    // identifier, column 3.
    expect(emit(`${FN}f(n);\n`)).toContain("at 3:3");
    // ...and with it. This was the bug: same error text, NO location at all. The column
    // is 4, not 3, and that is the contract: `exprLoc` descends to the first child that
    // carries a location, which is the operand `n` — not the `-` in front of it.
    expect(emit(`${FN}f(-n);\n`)).toContain("at 3:4");
  });

  test("every unary operator descends, not just `-`", () => {
    for (const src of [`${FN}f(-n);\n`, `${FN}f(+n);\n`, `${FN}f(~n);\n`, `${FN}f(!n);\n`]) {
      expect([src, emit(src).includes("at 3:4")]).toEqual([src, true]);
    }
  });

  // A unary whose operand has no location either must still report the error — the
  // descent returns `undefined` and the caller falls back, as it did before.
  test("a unary over an unlocated operand still produces the diagnostic", () => {
    expect(emit(`${FN}f(-1);\n`)).toContain("expects string, got number");
  });
});

/*
 * `exprLoc` PER NODE KIND — the table that pins the descent for all 30 `Expr` members.
 *
 * WHY A TABLE, and why now. `exprLoc` used to open with
 *
 *     const own = (e as { loc?: Loc }).loc;
 *
 * a cast that is fine under `bun` (property access is dynamic, so it really did read
 * `loc`) and a MISCOMPILE once nativets compiles nativets. `loc` sits at slot 0 of the
 * asserted shape `{loc?: Loc}`, and slot 0 of every `Expr` member is `kind` — so compiled,
 * this hands a STRING POINTER back as a `?ULoc` box, for all 30 members, including the 7
 * that genuinely carry a `loc`. The checked-`as` work made it a refusal (NT2001) instead
 * of a silent wrong answer, which is what surfaced it.
 *
 * The replacement dispatches on the tag. That is a bigger edit than it looks — `exprLoc`
 * computes EVERY diagnostic's span, so a dropped arm degrades every error message in the
 * compiler and nothing else in the suite would notice. Exactly SEVEN members declare
 * `loc` (Identifier, MemberExpr, IndexExpr, IndexAssign, NonNullExpr, InExpr, CallExpr —
 * confirmed against the parser's own resolved `Expr` type, not by reading the file), and
 * two of those already had a structural arm that must remain their fallback.
 *
 * So every kind is pinned here, with its exact line:column, as a CHARACTERIZATION: these
 * values were captured from the pre-fix compiler and must survive it unchanged. The
 * literal-only rows at the bottom are the controls — they prove the descent still bottoms
 * out at `undefined` rather than inventing a position.
 */
describe("exprLoc pins a location for every Expr kind", () => {
  const at = (src: string): string => {
    const e = parseExpressionFrom(src);
    const l = exprLoc(e);
    return `${e.kind} ${l ? `${l.line}:${l.col}` : "undefined"}`;
  };

  // [source, expected `kind line:col`] — captured from the compiler before the tag-dispatch
  // rewrite, so any drift is a behaviour change and fails here.
  const PINS: [string, string][] = [
    // --- the 7 that carry their own `loc` -------------------------------------
    ["x", "Identifier 1:1"],
    ["o.f", "MemberExpr 1:2"],
    ["a[i]", "IndexExpr 1:2"],
    ["a[i] = y", "IndexAssign 1:2"],
    ["x!", "NonNullExpr 1:2"],
    ['"k" in o', "InExpr 1:5"],
    ["f(x)", "CallExpr 1:2"],
    // --- structural descent: no `loc` of their own ----------------------------
    ["x + y", "BinaryExpr 1:1"],
    ["x && y", "LogicalExpr 1:1"],
    ["-x", "UnaryExpr 1:2"], // `operand`, NOT `argument` — see the unary block above
    ["x as string", "AsExpr 1:1"],
    ["x satisfies string", "SatisfiesExpr 1:1"],
    ["o.f = y", "FieldAssign 1:1"], // located by its RECEIVER `o`, not by `o.f`
    ["x = y", "AssignExpr 1:5"], // target is a bare string; the value is the only child
    ["o.f++", "UpdateExpr 1:2"],
    ["a[i]++", "UpdateExpr 1:2"],
    ["x ? y : z", "ConditionalExpr 1:1"],
    // 1:5 is `x`'s real column in `` `a${x}b` `` (1 backtick, 2 a, 3 $, 4 {, 5 x). This
    // pin was captured as `1:1` — a substitution was lexed as its own one-line source, so
    // every node in one carried a FRAGMENT-relative position, and 1:1 was the fragment's
    // origin rather than anything in the file. That is a WRONG position, not a missing
    // one: NT2001 on `` `${b.missing}` `` printed the file's first line under the caret.
    // `parseExpressionFrom` now takes the fragment's origin and rebases its tokens, which
    // is the fix test/string-coercion.test.ts asked for by name ("until the fragment
    // offset is threaded") while working around it with no location at all.
    ["`a${x}b`", "TemplateLiteral 1:5"],
    ["[x, y]", "ArrayLiteral 1:2"],
    ["{ a: x }", "ObjectLiteral 1:6"],
    // --- no `loc`, and no arm: genuinely unlocatable ---------------------------
    ["1", "NumberLiteral undefined"],
    ["true", "BooleanLiteral undefined"],
    ['"s"', "StringLiteral undefined"],
    ["undefined", "UndefinedLiteral undefined"],
    ["null", "NullLiteral undefined"],
    ["(x, y)", "SequenceExpr undefined"],
    ["typeof x", "TypeofExpr undefined"],
    ["(a) => a", "ArrowFunction undefined"],
    ["new C(x)", "NewExpr undefined"],
    ["x instanceof C", "InstanceOfExpr undefined"],
    // --- controls: a descent over literal-only children invents nothing --------
    ["1 + 2", "BinaryExpr undefined"],
    ["[1, 2]", "ArrayLiteral undefined"],
    ["1 ? 2 : 3", "ConditionalExpr undefined"],
  ];

  for (const [src, want] of PINS) {
    test(`\`${src}\` → ${want}`, () => {
      expect([src, at(src)]).toEqual([src, want]);
    });
  }

  /*
   * A PRE-EXISTING BUG, pinned as-is rather than fixed here — fixing it is a behaviour
   * change and this lane's contract is that behaviour does not move.
   *
   * `case "UpdateExpr": return exprLoc(e.targetExpr);` — but `targetExpr` is set ONLY for
   * the member/index forms. The interface says so itself: "`target` names the local for
   * the (overwhelmingly common) identifier case", and that case leaves `targetExpr`
   * undefined. So a plain `x++` / `x--` is `exprLoc(undefined)` and reports NO location,
   * while `o.f++` and `a[i]++` (directly above) report one.
   *
   * That is the SAME defect, in the same function, as the `e.argument`-vs-`e.operand` bug
   * the block above memorialises: an arm reading a field that is not populated on the path
   * that matters. It survived that fix because both are silent — the error text is
   * identical and only the `at L:C` suffix goes missing.
   */
  test("KNOWN BUG: a plain `x++` reports no location, unlike `o.f++`", () => {
    expect(at("x++")).toBe("UpdateExpr undefined");
    expect(at("o.f++")).toBe("UpdateExpr 1:2"); // the contrast that makes it a bug
  });
});

/*
 * NT1606 — the most-hit refusal in the tree — used to render with NO LOCATION AT ALL.
 *
 *     error[NT1606]: arrays are immutable: `.push` would mutate the array in place
 *       = help: build a new array instead: …
 *
 * No line, no column, no gutter, no caret, and no name for the receiver, while every
 * sibling in its own band (NT1601/NT1603/NT1604/NT1607) rendered a full rustc-style
 * band. Two self-hosting lanes independently reported it, and BOTH had to patch the
 * compiler to print the receiver and the line before they could find the one blocking
 * site — one of them bisected a 442-line file by hand. That is precisely the work a
 * diagnostic exists to prevent.
 *
 * The bar is set SIDE BY SIDE against NT1601 rather than by asserting on a substring:
 * the two are rendered from the same source and their shapes compared, so a future
 * change that quietly drops NT1606's span fails here even if the message survives.
 *
 * THE TRAP (test/narrowing.test.ts hit it): `formatDiagnostic` takes a `Diagnostic`, not
 * an `NTError`. Handed the error itself it renders `error[undefined]` and SILENTLY DROPS
 * THE HINT — and a test asserting the code still passes, because `NTError.message`
 * embeds `[NT1606]`. So everything below goes through `.diag`, and every case asserts the
 * hint is present, which is the assertion that catches that class.
 */
describe("NT1606 carries a source location", () => {
  /** Compile and render exactly what the CLI would print. Via `.diag` — see the trap above. */
  function render(src: string): string {
    try {
      sourceToIR(src);
      return "(compiled)";
    } catch (e) {
      if (!(e instanceof NTError)) throw e;
      return formatDiagnostic(e.diag, src);
    }
  }

  test("`.push` renders the same band as NT1601 does — gutter, line, caret, hint", () => {
    const push = "const xs: number[] = [];\nxs.push(2);\n";
    const out = render(push);
    // The head names the receiver, not a bare `.push`, and says where.
    expect(out).toContain("error[NT1606]: arrays are immutable: `xs.push` would mutate the array in place at 2:1");
    // ...and the band itself: gutter bar, numbered source line, caret, hint.
    expect(out).toContain("  2 | xs.push(2);");
    expect(out).toContain("^^^^^^^^^^^ mutated here");
    expect(out).toContain("= help: build a new array instead");

    // Side by side with the band NT1606 was missing. Same source shape, same skeleton.
    const move = "const a: number[] = [1, 2];\nconst b = a;\nconsole.log(a.length);\n";
    const skeleton = (s: string): string[] =>
      s.split("\n").map((l) => (l.includes("error[") ? "HEAD" : l.includes("= help:") ? "HELP" : l.trim() === "|" ? "BAR" : l.includes("|") ? "FRAME" : "OTHER"));
    expect(skeleton(out).slice(0, 4)).toEqual(skeleton(render(move)).slice(0, 4));
  });
  /*
   * The rest of node's in-place array mutators. They are ONE table because the defect was
   * one: every arm of the `switch (method)` in `inferArrayMethod` built its `mutationError`
   * with a bare `.<method>` and no position, so the location was missing from all of them
   * and fixing only the reported one (`.push`) would have left the next lane in exactly the
   * same place. `.sort` is included even though it is rejected on its own line above the
   * switch (a FRESH receiver is allowed to sort), because that is the arm a self-hosting
   * lane hits second.
   */
  const MUTATORS: [string, string][] = [
    ["pop", "xs.pop();"],
    ["sort", "xs.sort();"],
    ["fill", "xs.fill(0);"],
    ["splice", "xs.splice(0, 1);"],
    ["shift", "xs.shift();"],
    ["unshift", "xs.unshift(1);"],
    ["copyWithin", "xs.copyWithin(0, 1);"],
  ];
  for (const [method, call] of MUTATORS) {
    test(`\`.${method}\` names its receiver and points at the line`, () => {
      const out = render(`const xs: number[] = [1, 2];\n${call}\n`);
      expect(out).toContain(`\`xs.${method}\``);
      expect(out).toContain("at 2:1");
      expect(out).toContain(`  2 | ${call}`);
      expect(out).toContain("mutated here");
      expect(out).toContain("= help:");
    });
  }
  /*
   * The ASSIGNMENT forms. These are the ones `exprLoc` could not have located even if the
   * call site had asked it to: `FieldAssign`, `AssignExpr` and `UpdateExpr` carry no `loc`
   * of their own AND had no arm in `exprLoc`'s switch, so `exprLoc(fieldAssign)` was
   * `undefined` while `exprLoc(fieldAssign.object)` gave a real position. The arms are added
   * in src/ast.ts (a `FieldAssign` is located by its RECEIVER, which is where the statement
   * starts and what a reader scans for); the call sites below then get a band like any other.
   */
  const ASSIGNS: [string, string, string, string][] = [
    ["field assign", "const o = { n: 1 };", "o.n = 2;", "`o.n = v`"],
    ["element assign", "const xs: number[] = [1, 2];", "xs[0] = 9;", "`xs[i] = v`"],
    ["field update", "const o = { n: 1 };", "o.n++;", "`o.n++`"],
    ["element update", "const xs: number[] = [1, 2];", "xs[0]++;", "`xs[i]++`"],
  ];
  for (const [name, decl, stmt, named] of ASSIGNS) {
    test(`${name} points at the receiver and names it`, () => {
      const out = render(`${decl}\n${stmt}\n`);
      expect(out).toContain("error[NT1606]");
      expect(out).toContain(named);
      expect(out).toContain("at 2:1");
      expect(out).toContain(`  2 | ${stmt}`);
      expect(out).toContain("mutated here");
      expect(out).toContain("= help:");
    });
  }
  /*
   * The `Map`/`Set` variants — and the point of retiring the workaround they were built on.
   *
   * These three producers already WANTED a location badly enough to hand-append one into
   * the message TEXT (`… at 412:97`, assembled from `exprLoc(subject)` at the call site).
   * That gave the compact form a position and the rendered form nothing: no `spans`, so
   * `formatDiagnostic` fell through to the one-line branch and never drew a frame. The
   * suffix now comes from `mutationError`'s `at` parameter, which produces the SAME text
   * and the source frame as well — so what is asserted here is both halves at once, and
   * the hand-appended spelling is gone from src/checker.ts (see the guard below).
   */
  test("`Map`/`Set` discarded mutator gets a frame, not just an appended `at L:C`", () => {
    const out = render('const m = new Map<string, number>();\nm.set("a", 1);\n');
    expect(out).toContain("error[NT1606]");
    expect(out).toContain("`Map` is persistent");
    expect(out).toContain("at 2:1");
    expect(out).toContain('  2 | m.set("a", 1);');
    expect(out).toContain("mutated here");
    expect(out).toContain("= help:");
  });

  test("a vacuous `Map` truthiness test gets a frame too", () => {
    const out = render('const m = new Map<string, number>();\nif (m) { console.log(1); }\n');
    expect(out).toContain("error[NT1606]");
    expect(out).toContain("ALWAYS true");
    expect(out).toContain("at 2:5");
    expect(out).toContain("  2 | if (m) { console.log(1); }");
    expect(out).toContain("mutated here");
    expect(out).toContain("= help:");
  });

  test("`Object.assign` points at the target it would mutate", () => {
    const out = render("const a = { x: 1 };\nconst b = { y: 2 };\nconst c = Object.assign(a, b);\nconsole.log(c.x);\n");
    expect(out).toContain("error[NT1606]: Object.assign mutates its target object at 3:25");
    expect(out).toContain("  3 | const c = Object.assign(a, b);");
    expect(out).toContain("mutated here");
    expect(out).toContain("= help:");
  });

  /*
   * The guard that keeps the workaround retired. A producer that assembles `at L:C` into
   * the message itself gets the suffix but NOT the frame — which is exactly the defect
   * this describe block exists to close, and it was reached for once already.
   */
  test("no NT1606 producer hand-appends its position into the message", () => {
    // Scoped to `mutationError(` argument lists, not to the file: other producers append
    // `at L:C` for reasons of their own (src/parser.ts's NT1017 module refusals name the
    // `import` keyword's position), and this lane does not speak for them.
    const offenders: string[] = [];
    for (const f of ["checker.ts", "parser.ts", "modules.ts"]) {
      const src = readFileSync(join(HERE, "..", "src", f), "utf8");
      let i = src.indexOf("mutationError(");
      while (i >= 0) {
        let depth = 0, j = i + "mutationError".length;
        for (; j < src.length; j++) {
          if (src[j] === "(") depth++;
          else if (src[j] === ")") { depth--; if (depth === 0) break; }
        }
        const call = src.slice(i, j + 1);
        if (call.includes(".line}:$")) offenders.push(`${f}: ${call.slice(0, 90)}…`);
        i = src.indexOf("mutationError(", j);
      }
    }
    expect(offenders).toEqual([]);
  });
  /*
   * The LAST two producers, and the only ones where a location was genuinely NOT available:
   * the static-field write-back in src/parser.ts and src/modules.ts is raised from a
   * callback `resolveStaticFieldReads` invokes with a NAME and nothing else, so neither
   * caller had anything to pass. The AST node IS in hand at the callback's throw site in
   * src/ast.ts (`e.object` is the class Identifier), so the callback is widened to carry
   * its position out — which is the difference between "somewhere in this program a static
   * field is assigned" and a jump to the line, and both spellings of it (single file, and
   * through the module linker) are covered.
   */
  test("assignment to a static field points at the class", () => {
    const src = "class C {\n  static n = 1;\n  static get(): number { return C.n; }\n}\nC.n = 2;\nconsole.log(C.get());\n";
    const out = render(src);
    expect(out).toContain("error[NT1606]: assignment to the static field 'C.n' at 5:1");
    expect(out).toContain("  5 | C.n = 2;");
    expect(out).toContain("mutated here");
    expect(out).toContain("= help:");
  });
});

/*
 * A diagnostic must render the source of the file the error is IN.
 *
 * `linkProgram` merges the whole import graph into one `Program`, but each module is
 * parsed on its own, so a `loc` produced inside an imported module carries THAT module's
 * line number. src/cli.ts then rendered every diagnostic against a single `source` — the
 * ENTRY file it read at startup — so a cross-module error printed the imported module's
 * line NUMBER against the entry file's TEXT, and never named the real file:
 *
 *     error[NT2001]: return type string does not match declared number at 4:64
 *       4 | const innocentMainLine4 = "perfectly fine code on main line 4";
 *         | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ returned here
 *
 * The caret underlines correct, unrelated code in a file that has no error in it. That is
 * strictly worse than no frame at all: a frame is read as evidence, so the reader is sent
 * to the wrong file with an authoritative-looking pointer. It was actively corrupting
 * triage — one underlying blocker surfaced quoting three different entry-file lines and
 * was nearly recorded as three separate blockers.
 *
 * node is NOT the oracle here (this is our own diagnostic output). The oracle is: does the
 * text under the caret come from the file and line the error is actually in? So the
 * fixture makes the two files disagree at the same line number, and the assertions pin
 * BOTH halves — the right text is shown, and the entry file's same-numbered line is not.
 */
describe("a diagnostic renders the file the error is in", () => {
  /** Write a module graph to a temp dir and compile the entry through the real CLI. */
  function cliMulti(files: Record<string, string>, entry: string): { out: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), "ntdiagloc-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const r = spawnSync("bun", ["run", join(HERE, "..", "src", "cli.ts"), "emit", join(dir, entry)], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
      });
      return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The error is on lib.ts:4. main.ts:4 is a different, perfectly valid line — so if the
  // renderer reaches for the entry source, the assertions below can tell.
  const LIB = [
    "// lib line 1",
    "// lib line 2",
    "// lib line 3",
    "export function boom(): number { const s: string = \"x\"; return s; }",
    "",
  ].join("\n");
  const MAIN = [
    "import { boom } from \"./lib.ts\";",
    "const a = 1;",
    "const b = 2;",
    "const innocentMainLine4 = \"perfectly fine code on main line 4\";",
    "console.log(boom(), a, b, innocentMainLine4);",
    "",
  ].join("\n");

  test("the caret underlines the IMPORTED module's line, not the entry file's", () => {
    const { out, code } = cliMulti({ "lib.ts": LIB, "main.ts": MAIN }, "main.ts");
    expect(code).toBe(1);
    expect(out).toContain("error[NT2001]");
    // The frame shows the line the error is actually on...
    expect(out).toContain("export function boom(): number");
    // ...and NOT the entry file's same-numbered line, which is valid code.
    expect(out).not.toContain("perfectly fine code on main line 4");
  });

  test("the frame names the file the error is in", () => {
    const { out } = cliMulti({ "lib.ts": LIB, "main.ts": MAIN }, "main.ts");
    // rustc's `--> file:line:col` locator. Without it the reader has a line number and no
    // way to know which of the program's files it indexes.
    expect(out).toContain("--> ");
    expect(out).toContain("lib.ts:4:");
    // and it must name lib.ts, not the entry.
    const locator = out.split("\n").find((l) => l.includes("--> "))!;
    expect(locator).toContain("lib.ts");
    expect(locator).not.toContain("main.ts");
  });

  test("a big type mismatch names the DIFFERENCE instead of dumping both types", () => {
    // The two types here are ~390 characters and differ by exactly two: `?U`. Dumped in
    // full, twice, the signal is 0.5% of the message — and that is the small version of
    // the real one, where the same union is printed twice at ~2,700 characters each and
    // the whole difference is a `?N` prefix. It is not a cosmetic complaint: an agent
    // sent to minimize that blocker read the message, looked straight at the `, got`
    // clause, and reported that the message "never states the type it actually got".
    // A diagnostic nobody can read is one nobody acts on.
    const big = [
      "interface Big {",
      ...Array.from({ length: 30 }, (_, i) => `  f${String(i + 1).padStart(2, "0")}: number;`),
      "}",
      "function pick(xs: Big[]): Big | undefined { if (xs.length > 0) return xs[0]; return undefined; }",
      "function collect(src: Big[]): number {",
      "  //@@mutable",
      "  let acc: Big[] = [];",
      "  const got = pick(src);",
      "  acc.push(got);",
      "  return acc.length;",
      "}",
      "console.log(collect([]));",
      "",
    ].join("\n");
    const { out } = cliMulti({ "big.ts": big }, "big.ts");
    expect(out).toContain("error[NT2001]");
    // The expected type is still named — eliding it entirely would hide the `?U` too,
    // which is the mistake truncation would have made.
    expect(out).toContain("f01:number");
    // ...but the SAME type is not dumped a second time. One occurrence, not two.
    const dumps = out.split("f30:number").length - 1;
    expect(dumps).toBe(1);
    // and the difference is stated in words.
    expect(out).toContain("?U");
    expect(out.length).toBeLessThan(600);
  });

  test("a SHORT type mismatch is left exactly as it was", () => {
    // The elision is gated on size on purpose: every ordinary mismatch — including the one
    // recorded in test/selfhost-ratchet.baseline.json, whose two types are 68 characters —
    // must render byte-identically, so this lane changes no message anyone is reading.
    const src = ["function f(): number {", "  const s: string = \"x\";", "  return s;", "}", "console.log(f());", ""].join("\n");
    const { out } = cliMulti({ "short.ts": src }, "short.ts");
    expect(out).toContain("error[NT2001]: return type string does not match declared number");
    expect(out).not.toContain("the SAME type");
  });

  test("a single-file program still renders its own frame, unchanged", () => {
    const bad = ["const a = 1;", "const xs: number[] = [];", "xs.push(a);", ""].join("\n");
    const { out, code } = cliMulti({ "solo.ts": bad }, "solo.ts");
    expect(code).toBe(1);
    expect(out).toContain("error[NT1606]");
    expect(out).toContain("  3 | xs.push(a);");
    expect(out).toContain("mutated here");
  });
});
