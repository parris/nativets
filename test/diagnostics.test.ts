/*
 * Multi-span diagnostics — a use-after-move (NT1601) now renders rustc-style, pointing at
 * BOTH the offending use and the earlier move, with source lines + caret underlines, instead
 * of the old one-line "(moved at line X, used at line Y)" string.
 */

import { test, expect, describe } from "bun:test";
import { formatDiagnostic } from "../src/diagnostics.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

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
