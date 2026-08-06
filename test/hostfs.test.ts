/*
 * SH4 — host FFI: `node:fs` / `node:child_process` (differential vs node).
 *
 * These are the primitives a SELF-HOSTED nativets needs: read a `.ts`, write a
 * `.ll`, stat a path, and spawn `clang`. Every case is ordinary TypeScript that
 * `node` runs, so node stays the oracle — the fixture takes the paths it touches
 * from `process.argv` so both sides operate on the same scratch directory.
 *
 * Backed by libc (`fopen`/`fread`/`fwrite`/`stat`/`posix_spawn`), so
 * `runtime/runtime.c` still cross-links unchanged for iOS/Android.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileAndRunIO, runWithNodeIO, emitIR, type IOInput } from "./harness.ts";
import { NTError } from "../src/diagnostics.ts";

/** The NT code a source is refused with, or null if it compiles. */
function rejects(src: string): string | null {
  try { emitIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "nativets-hostfs-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run `source` under node and under our compiled binary with identical argv. */
async function differential(source: string, io: IOInput = {}) {
  const oracle = runWithNodeIO(source, io);
  const ours = await compileAndRunIO(source, io);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours;
}

describe("node:fs — readFileSync", () => {
  test("reads a file as utf8 text", async () => {
    const dir = scratch();
    const file = join(dir, "greeting.txt");
    writeFileSync(file, "hello\nworld\n");
    await differential(
      `import { readFileSync } from "node:fs";
const path = process.argv[2];
const text = readFileSync(path, "utf8");
console.log(text.length);
console.log(text);
`,
      { args: [file] },
    );
  });

  test("a missing file throws catchably, with node's message", async () => {
    const dir = scratch();
    await differential(
      `import { readFileSync } from "node:fs";
try {
  const text = readFileSync(process.argv[2], "utf8");
  console.log("read " + text);
} catch (e) {
  console.log("caught: " + e.message);
}
`,
      { args: [join(dir, "does-not-exist.txt")] },
    );
  });

  test("an uncaught missing file exits non-zero", async () => {
    const dir = scratch();
    const ours = await compileAndRunIO(
      `import { readFileSync } from "node:fs";
console.log(readFileSync(process.argv[2], "utf8"));
`,
      { args: [join(dir, "nope.txt")] },
    );
    expect(ours.exitCode).not.toBe(0);
    expect(ours.stderr).toContain("ENOENT");
  });

  test("an `as` alias binds the same builtin", async () => {
    const dir = scratch();
    const file = join(dir, "aliased.txt");
    writeFileSync(file, "aliased\n");
    await differential(
      `import { readFileSync as slurp } from "node:fs";
console.log(slurp(process.argv[2], "utf8").trim());
`,
      { args: [file] },
    );
  });
});

describe("node:fs — writeFileSync", () => {
  test("writes a file, which readFileSync reads back", async () => {
    const dir = scratch();
    await differential(
      `import { readFileSync, writeFileSync } from "node:fs";
const out = process.argv[2];
writeFileSync(out, "line one\\nline two\\n");
console.log(readFileSync(out, "utf8"));
`,
      { args: [join(dir, "written.txt")] },
    );
  });

  test("overwrites (it truncates, it does not append)", async () => {
    const dir = scratch();
    const file = join(dir, "twice.txt");
    writeFileSync(file, "a much longer original body\n");
    await differential(
      `import { readFileSync, writeFileSync } from "node:fs";
const out = process.argv[2];
writeFileSync(out, "short\\n");
console.log(JSON.stringify(readFileSync(out, "utf8")));
`,
      { args: [file] },
    );
  });

  test("an unwritable path throws catchably, with node's message", async () => {
    const dir = scratch();
    await differential(
      `import { writeFileSync } from "node:fs";
try {
  writeFileSync(process.argv[2], "nope");
  console.log("wrote");
} catch (e) {
  console.log("caught: " + e.message);
}
`,
      { args: [join(dir, "no-such-dir", "f.txt")] },
    );
  });
});

describe("node:fs — existsSync", () => {
  test("true for a file, false for a missing path, true for a directory", async () => {
    const dir = scratch();
    const file = join(dir, "here.txt");
    writeFileSync(file, "x");
    await differential(
      `import { existsSync } from "node:fs";
console.log(existsSync(process.argv[2]));
console.log(existsSync(process.argv[3]));
console.log(existsSync(process.argv[4]));
`,
      { args: [file, join(dir, "absent.txt"), dir] },
    );
  });

  test("it does not throw — it reports, so it guards a read", async () => {
    const dir = scratch();
    await differential(
      `import { existsSync, readFileSync } from "node:fs";
const p = process.argv[2];
console.log(existsSync(p) ? readFileSync(p, "utf8") : "no such file");
`,
      { args: [join(dir, "guarded.txt")] },
    );
  });
});

describe("the host FFI surface is closed — outside it is NT1028, never half-implemented", () => {
  test("a `node:` module with no native implementation", () => {
    expect(rejects(`import { createHash } from "node:crypto";\nconsole.log(typeof createHash);\n`)).toBe("NT1028");
  });

  test("a member outside the implemented surface of an implemented module", () => {
    expect(rejects(`import { readFileSync, watch } from "node:fs";\nconsole.log(typeof watch);\n`)).toBe("NT1028");
  });

  test("readFileSync with no encoding (node returns a Buffer)", () => {
    expect(rejects(`import { readFileSync } from "node:fs";\nconsole.log(readFileSync("x").length);\n`)).toBe("NT1028");
  });

  test("readFileSync with a computed encoding", () => {
    expect(rejects(`import { readFileSync } from "node:fs";\nconst enc = "utf8";\nconsole.log(readFileSync("x", enc).length);\n`)).toBe("NT1028");
  });

  test("a host builtin is NOT ambient — the name is undefined without the import", () => {
    expect(rejects(`console.log(readFileSync("x", "utf8").length);\n`)).toBe("NT1003"); // unknown callee, as for any undefined name
  });

  test("…so a user function may still be named readFileSync", async () => {
    const src = `function readFileSync(p: string, enc: string): string { return p + ":" + enc; }
console.log(readFileSync("a", "utf8"));
`;
    const oracle = runWithNodeIO(src);
    const ours = await compileAndRunIO(src);
    expect(ours.stdout).toBe(oracle.stdout);
  });
});
