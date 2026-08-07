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

const HERE = dirname(fileURLToPath(import.meta.url));

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
  /** Compile `src` through the real CLI and capture what a user would see. */
  function cli(src: string): { out: string; code: number } {
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
  const THROWS: [string, string][] = [
    ["top-level throw", `console.log("before");\nthrow new Error("boom");\n`],
    ["function throws, no try anywhere", `function f(): number { throw new Error("boom"); }\nconsole.log(f());\n`],
    // The ordinary idiom: raise in the callee, handle at the call site.
    ["function throws, try at the CALL SITE", `function f(): number { throw new Error("boom"); }\ntry { console.log(f()); } catch (e) { console.log("caught"); }\n`],
    ["method throws, try at the call site", `class C { m(): number { throw new Error("b"); } }\ntry { console.log(new C().m()); } catch (e) { console.log("caught"); }\n`],
    ["rethrow from a catch block", `try { throw new Error("a"); } catch (e) { throw new Error("b"); }\n`],
    ["throw from an arrow", `const f = (): number => { throw new Error("b"); };\ntry { console.log(f()); } catch (e) { console.log("c"); }\n`],
    ["throw from a finally block", `try { console.log(1); } finally { throw new Error("b"); }\n`],
  ];
  for (const [name, src] of THROWS) {
    test(`NT1004, not a stack trace: ${name}`, () => {
      const { out, code } = cli(src);
      expectClean(out, code, "NT1004");
    });
  }

  // The same construct INSIDE a try in the same function still compiles — the refusal is
  // scoped to what codegen genuinely cannot lower, and did not swallow the working case.
  test("a throw inside a try in the same function still compiles", () => {
    const { out, code } = cli(`try { throw new Error("boom"); } catch (e) { console.log("caught"); }\n`);
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
