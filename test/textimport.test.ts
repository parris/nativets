/*
 * Compile-time TEXT imports — `import s from "./f.c" with { type: "text" }`.
 *
 * The construct that embeds the C runtime into the compiler's own binary
 * (`src/driver.ts` has twelve of them, ~305KB of C source). Semantics are bun's: the
 * referenced file is read AT COMPILE TIME, relative to the importing file, and the
 * identifier is bound to a plain string constant. No runtime file I/O, no `node:fs`.
 *
 * ---- WHY NODE IS NOT THE ORACLE FOR THE IMPORT ITSELF ----
 * node implements only `with { type: "json" }`; there is no `text` attribute, so a
 * fixture using one cannot run under node at all (docs/divergences.md records this as
 * a deliberate divergence). The oracle is therefore split:
 *
 *   main.ts    — nativets: the text import. Compiled and RUN; its stdout is asserted.
 *   oracle.ts  — node: the same program with the same string obtained by readFileSync.
 *
 * Everything after the binding is identical source in both files, so node still decides
 * what the STRING is and what `.length`/indexing/comparison do with it. Only the import
 * FORM is nativets-only. Each test below says which half it is asserting.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRunFile } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";
import { coverage } from "../src/coverage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "textimport");

/** Run a case's node twin, from inside the case directory (so `./x` resolves). */
function oracle(caseName: string): { stdout: string; exitCode: number } {
  const dir = join(DIR, caseName);
  const p = spawnSync("node", [join(dir, "oracle.ts")], { encoding: "utf8", cwd: dir });
  expect(p.stderr ?? "").toBe(""); // the oracle itself must be clean
  return { stdout: p.stdout ?? "", exitCode: p.status ?? -1 };
}

describe("text imports (node-verified through the readFileSync twin)", () => {
  test("basic: the file's contents become a string constant", async () => {
    const ours = await compileAndRunFile(join(DIR, "basic", "main.ts"));
    const theirs = oracle("basic");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    // Pinned, so a change on BOTH sides can never pass silently.
    expect(ours.stdout).toBe("19\nhello, text import\n\n");
  });

  /*
   * The syntax was never the risk — the PAYLOAD is. A text import's bytes travel
   * through the AST as one string literal and land in the `.ll` as a `c"…"` constant,
   * where a mis-escaped byte or a wrong length is a silent wrong answer. This payload
   * is built to break that: quotes, backslashes (single, doubled, and C-escape text
   * that must NOT be interpreted), every control character except NUL, DEL, `%s`,
   * backticks, `${`, `c"hello\00"` (LLVM's own escape syntax), and a 4000-char line.
   *
   * Pure ASCII on purpose, so `.length`, `charCodeAt`, `indexOf` and comparison are
   * all node-verified here — the whole assertion is a node differential.
   */
  test("nasty: quotes, backslashes, control characters and a 4KB line survive byte-for-byte", async () => {
    const ours = await compileAndRunFile(join(DIR, "nasty", "main.ts"));
    const theirs = oracle("nasty");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    // The payload really did arrive whole (4432 bytes on disk), not truncated at the
    // first quote/backslash/control byte.
    const size = readFileSync(join(DIR, "nasty", "payload.txt")).length;
    expect(ours.stdout.startsWith(`${size}\n`)).toBe(true);
    expect(ours.stdout.endsWith(readFileSync(join(DIR, "nasty", "payload.txt"), "utf8") + "\n")).toBe(true);
  });

  /*
   * Non-ASCII bytes. A text import must be a UTF-8 pass-through: the emitted `.ll`
   * escapes every byte >= 0x7f numerically, and the length in the constant is a BYTE
   * count, so a multi-byte character is where an off-by-one shows up.
   *
   * node-verified, with one deliberate exception named in the fixture: nativets'
   * `String#length` is UTF-8 byte-oriented (docs/divergences.md §A.2), so the oracle
   * prints `Buffer.byteLength` for that line. The bytes themselves are compared
   * verbatim, which is what actually pins the encoding.
   */
  test("utf8: multi-byte characters pass through unchanged", async () => {
    const ours = await compileAndRunFile(join(DIR, "utf8", "main.ts"));
    const theirs = oracle("utf8");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    const raw = readFileSync(join(DIR, "utf8", "payload.txt"));
    expect(ours.stdout.startsWith(`${raw.length}\n${raw.length}\n`)).toBe(true);
    expect(ours.stdout.endsWith(raw.toString("utf8") + "\n")).toBe(true);
  });

  /*
   * The case the feature exists for: the twelve C files `src/driver.ts` embeds, ~305KB
   * in total with runtime/runtime.c alone at ~147KB. A silent truncation or a single
   * mis-escaped byte here would hand clang broken C, which is why this is asserted on
   * the real files and not on a stand-in.
   */
  test("runtime: all twelve embedded C files (~305KB) arrive byte-for-byte", async () => {
    const ours = await compileAndRunFile(join(DIR, "runtime", "main.ts"));
    const theirs = oracle("runtime");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    // Independently of the oracle: the concatenation really is every byte on disk.
    const files = [
      "runtime.c", "nt_actor.c", "nt_actor.h", "nt_hamt.c", "nt_hamt.h", "nt_mapset.c",
      "nt_bytes.c", "nt_bytes.h", "nt_pvec.c", "nt_pvec.h", "nt_http.c", "nt_gui.c",
    ];
    const raw = files.map((f) => readFileSync(join(HERE, "..", "runtime", f), "utf8"));
    expect(ours.stdout.endsWith(raw.map((s) => `${s}\n`).join(""))).toBe(true);
    const total = raw.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0);
    expect(total).toBeGreaterThan(300_000);
    expect(ours.stdout).toContain(`\n${total}\n`);
  }, 300_000);

  /*
   * A text import in a NON-entry module — the shape `src/driver.ts` actually has (the
   * entry is `src/cli.ts`). Two hazards: the specifier must resolve against the
   * IMPORTING file, not the entry, and the materialized const must be renamed with the
   * rest of that module's top level — here both modules bind `banner`.
   */
  test("nested: resolved relative to the importing module, and mangled like any binding", async () => {
    const ours = await compileAndRunFile(join(DIR, "nested", "main.ts"));
    const theirs = oracle("nested");
    expect(ours.stdout).toBe(theirs.stdout);
    expect(ours.exitCode).toBe(theirs.exitCode);
    expect(ours.stdout).toBe("root data\nlib data\nfalse\n");
  });
});

/* ============================================================
 * Reject, never miscompile — the refusals, each pinned to its NT code.
 * ============================================================ */

const scratch = mkdtempSync(join(tmpdir(), "nativets-textimport-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Compile-only; returns the NT code, or null when it compiled. `anchor` is the entry
 *  path the specifiers resolve against (the file itself need not exist). */
function codeOf(source: string, anchor = join(DIR, "basic", "main.ts")): string | null {
  try { sourceToIR(source, anchor); return null; }
  catch (e) { return e instanceof NTError ? e.diag.code : `threw ${String((e as Error).message).slice(0, 60)}`; }
}

describe("what is refused", () => {
  test('only `type: "text"` is implemented — `type: "json"` is NT1017, not silently text', () => {
    // node DOES implement `with { type: "json" }` (it binds the PARSED object, not the
    // source text). Treating it as text would be a silent wrong answer, so it is refused.
    expect(codeOf('import j from "./payload.txt" with { type: "json" };\nconsole.log(1);\n')).toBe("NT1017");
    expect(codeOf('import j from "./payload.txt" with { charset: "utf8" };\nconsole.log(1);\n')).toBe("NT1017");
    expect(codeOf('import j from "./payload.txt" with { type: "text", charset: "utf8" };\nconsole.log(1);\n')).toBe("NT1017");
  });

  test("a general default import is still NT1017 — the attribute is what makes this one work", () => {
    expect(codeOf('import x from "./other.ts";\nconsole.log(1);\n')).toBe("NT1017");
    expect(codeOf('import x, { y } from "./other.ts";\nconsole.log(1);\n')).toBe("NT1017");
    expect(codeOf('import * as ns from "./other.ts";\nconsole.log(1);\n')).toBe("NT1017");
  });

  test("an import attribute on a NAMED import is refused rather than ignored", () => {
    expect(codeOf('import { a } from "./other.ts" with { type: "json" };\nconsole.log(1);\n')).toBe("NT1017");
  });

  test("the specifier is a relative path, like every other one (no bare specifiers)", () => {
    expect(codeOf('import s from "runtime/runtime.c" with { type: "text" };\nconsole.log(s);\n')).toBe("NT1017");
  });

  test("an unreadable text file is NT1701, the same code as an unresolvable module", () => {
    expect(codeOf('import s from "./no-such-file.c" with { type: "text" };\nconsole.log(s);\n')).toBe("NT1701");
  });

  /*
   * The silent-truncation guard. nativets strings are NUL-terminated (`js_str_len` is
   * `strlen`), so a NUL byte inside an inlined file would cut the constant short at run
   * time while the `.ll` still carried every byte — a wrong answer with nothing to see.
   * Refused at compile time instead.
   */
  /*
   * `coverage` is the instrument the self-hosting gradient is read off, so it must not
   * invent a blocker. It reports statement by statement and never links — exactly why it
   * already links a program that declares imports ("otherwise every imported name would
   * look undefined"). A text import binds a name the same way, so it needs the same
   * treatment: without it, `coverage src/driver.ts` would report twelve phantom NT2001s.
   */
  test("`coverage` does not invent a blocker for a text-imported binding", () => {
    const entry = join(DIR, "basic", "main.ts");
    const report = coverage(readFileSync(entry, "utf8"), entry);
    expect({ compiles: report.compiles, blockers: report.blockers.map((b) => b.code) })
      .toEqual({ compiles: true, blockers: [] });
  });

  test("a NUL byte in the file is NT1704, not a silently truncated constant", () => {
    const bin = join(scratch, "with-nul.bin");
    const entry = join(scratch, "main.ts");
    const src = 'import s from "./with-nul.bin" with { type: "text" };\nconsole.log(s);\n';
    writeFileSync(bin, Buffer.from("before\u0000after\n", "utf8"));
    expect(codeOf(src, entry)).toBe("NT1704");
    // …and the same file WITHOUT the NUL compiles, so it is the byte that is refused.
    writeFileSync(bin, Buffer.from("beforeafter\n", "utf8"));
    expect(codeOf(src, entry)).toBe(null);
  });
});
