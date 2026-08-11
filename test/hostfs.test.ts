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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, compileAndRunFile, runWithNodeFile, emitIR, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
import { NTError } from "../src/diagnostics.ts";

/** The NT code a source is refused with, or null if it compiles. */
function rejects(src: string): string | null {
  try { emitIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

/** The whole diagnostic a source is refused with, for the cases that assert its HINT. */
function refusal(src: string): { code: string; message: string; hint?: string } | null {
  try { emitIR(src); return null; } catch (e) {
    if (!(e instanceof NTError)) throw e;
    return { code: e.diag.code, message: e.diag.message, hint: e.diag.hint };
  }
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

/*
 * The point of the whole milestone: a self-hosted nativets has to RUN `clang`.
 * `spawnSync` is the node API the driver already uses, so the shape below is the
 * shape src/driver.ts calls — status + captured stdout/stderr, `encoding: "utf8"`.
 */
describe("node:child_process — spawnSync", () => {
  test("captures stdout and a zero status", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("echo", ["hello", "world"], { encoding: "utf8" });
console.log(r.status);
console.log(JSON.stringify(r.stdout));
console.log(JSON.stringify(r.stderr));
`,
    );
  });

  test("reports a non-zero exit status", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("sh", ["-c", "exit 3"], { encoding: "utf8" });
console.log(r.status);
`,
    );
  });

  test("captures stderr separately from stdout", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("sh", ["-c", "echo out; echo err 1>&2"], { encoding: "utf8" });
console.log(JSON.stringify(r.stdout));
console.log(JSON.stringify(r.stderr));
console.log(r.status);
`,
    );
  });

  test("arguments are passed through verbatim — no shell, so no word splitting", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("echo", ["a b", "c*d", "$HOME"], { encoding: "utf8" });
console.log(JSON.stringify(r.stdout));
`,
    );
  });

  test("the real thing: compile and run a C program through clang", async () => {
    const dir = scratch();
    const src = join(dir, "hi.c");
    const bin = join(dir, "hi");
    writeFileSync(src, '#include <stdio.h>\nint main(void){puts("from clang");return 0;}\n');
    await differential(
      `import { spawnSync } from "node:child_process";
const build = spawnSync("clang", [process.argv[2], "-o", process.argv[3]], { encoding: "utf8" });
console.log("build status " + build.status);
const run = spawnSync(process.argv[3], [], { encoding: "utf8" });
console.log(run.stdout.trim());
`,
      { args: [src, bin] },
    );
  });
});

/*
 * node:fs, the rest of the surface src/driver.ts and src/cli.ts use: a scratch
 * directory, a listing, and a recursive remove. `mkdtempSync` returns a RANDOM
 * suffix, so the fixture prints derived facts (prefix kept, six characters added,
 * the directory exists) — identical on both sides, so node is still the oracle.
 */
describe("node:fs — mkdtempSync / readdirSync / rmSync", () => {
  test("mkdtempSync creates a real directory named after its prefix", async () => {
    const dir = scratch();
    await differential(
      `import { mkdtempSync, existsSync } from "node:fs";
const prefix = process.argv[2];
const d = mkdtempSync(prefix);
console.log(d.startsWith(prefix));
console.log(d.length - prefix.length);
console.log(existsSync(d));
`,
      { args: [join(dir, "scratch-")] },
    );
  });

  test("readdirSync lists the entries of a directory", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "b.ts"), "");
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "c.txt"), "");
    await differential(
      `import { readdirSync } from "node:fs";
const names = readdirSync(process.argv[2]);
console.log(names.length);
console.log(names.toSorted().join(","));
`,
      { args: [dir] },
    );
  });

  test("readdirSync of a missing directory throws, with node's message", async () => {
    const dir = scratch();
    await differential(
      `import { readdirSync } from "node:fs";
try {
  console.log(readdirSync(process.argv[2]).length);
} catch (e) {
  console.log("caught: " + e.message);
}
`,
      { args: [join(dir, "nope")] },
    );
  });

  // The fixture CREATES what it removes: `differential` runs node first, so a file
  // written by the test would already be gone by the time our binary runs.
  test("rmSync removes a file", async () => {
    const dir = scratch();
    await differential(
      `import { rmSync, writeFileSync, existsSync } from "node:fs";
const p = process.argv[2];
writeFileSync(p, "x");
console.log(existsSync(p));
rmSync(p);
console.log(existsSync(p));
`,
      { args: [join(dir, "doomed.txt")] },
    );
  });

  test("rmSync removes a tree recursively, and force ignores a missing path", async () => {
    const dir = scratch();
    await differential(
      `import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
const d = mkdtempSync(process.argv[2]);
writeFileSync(d + "/one.txt", "a");
writeFileSync(d + "/two.txt", "b");
console.log(existsSync(d + "/one.txt"));
rmSync(d, { recursive: true, force: true });
console.log(existsSync(d));
rmSync(d, { recursive: true, force: true }); // already gone: force says nothing
console.log("done");
`,
      { args: [join(dir, "tree-")] },
    );
  });

  test("the driver's own shape: scratch dir → write → read back → remove", async () => {
    const dir = scratch();
    await differential(
      `import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const d = mkdtempSync(process.argv[2]);
const ll = join(d, "out.ll");
writeFileSync(ll, "; ModuleID = 'nativets'\\n");
console.log(readFileSync(ll, "utf8").trim());
rmSync(d, { recursive: true, force: true });
console.log(existsSync(ll));
`,
      { args: [join(dir, "build-")] },
    );
  });
});

/*
 * node:path — pure string algorithms, ported from node's own lib/path.js (posix),
 * so node is the oracle directly. The cases below are node's danger zones: `..`
 * above the root, empty and trailing segments, and a relative path whose common
 * prefix is not a whole segment.
 */
describe("node:path", () => {
  test("join", async () => {
    await differential(
      `import { join } from "node:path";
console.log(join("a", "b"));
console.log(join("/a/", "/b/"));
console.log(join("a", "..", "b"));
console.log(join("a", "b", "..", "..", "..", "c"));
console.log(join("", "b"));
console.log(join("a", ""));
console.log(join(".", "b"));
console.log(join("/", "x"));
console.log(join("a/b", "../c"));
console.log(join("a", "b/"));
console.log(join("a/./b"));
console.log(join("/a//b/../c"));
`,
    );
  });

  test("dirname and basename", async () => {
    await differential(
      `import { dirname, basename } from "node:path";
console.log(dirname("/a/b/c.ts"));
console.log(dirname("a/b"));
console.log(dirname("a"));
console.log(dirname("/a"));
console.log(dirname("/"));
console.log(dirname(""));
console.log(dirname("/a/b/"));
console.log(basename("/a/b/c.ts"));
console.log(basename("c.ts"));
console.log(basename("/a/b/"));
console.log(basename("/"));
console.log(JSON.stringify(basename("")));
`,
    );
  });

  test("resolve is absolute, against the working directory", async () => {
    await differential(
      `import { resolve } from "node:path";
console.log(resolve("/a/b", "c"));
console.log(resolve("/a/b", "/c"));
console.log(resolve("/a/b/c", "../d"));
console.log(resolve("/a", ""));
console.log(resolve("/a/./b/"));
`,
    );
  });

  test("relative", async () => {
    await differential(
      `import { relative } from "node:path";
console.log(JSON.stringify(relative("/a/b/c", "/a/b/c")));
console.log(relative("/a/b/c", "/a/b/d"));
console.log(relative("/a/b", "/a/b/c/d"));
console.log(relative("/a/b/c/d", "/a/b"));
console.log(relative("/a/bb", "/a/b"));
console.log(relative("/", "/a/b"));
`,
    );
  });

  test("the driver's own shape: dirname of a module + join of a relative import", async () => {
    await differential(
      `import { dirname, join, relative } from "node:path";
const entry = "/proj/src/cli.ts";
const dir = dirname(entry);
console.log(join(dir, "./parser.ts"));
console.log(join(dir, "../runtime/runtime.c"));
console.log(relative("/proj", join(dir, "./checker.ts")));
`,
    );
  });
});

/*
 * node:os and node:url — the last two the compiler's own source imports. Both
 * return machine-specific paths, so the fixtures print DERIVED facts (absolute,
 * exists, a scratch path built from them) that are identical on both sides.
 */
describe("node:os — tmpdir / homedir", () => {
  test("both are absolute directories that exist", async () => {
    await differential(
      `import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
const t = tmpdir();
const h = homedir();
console.log(t.startsWith("/"), existsSync(t));
console.log(h.startsWith("/"), existsSync(h));
`,
    );
  });

  test("the driver's own shape: a scratch directory under tmpdir", async () => {
    await differential(
      `import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
const d = mkdtempSync(join(tmpdir(), "nativets-sh4-"));
console.log(existsSync(d));
rmSync(d, { recursive: true, force: true });
console.log(existsSync(d));
`,
    );
  });
});

describe("node:url — fileURLToPath", () => {
  test("a file: URL becomes a filesystem path", async () => {
    await differential(
      `import { fileURLToPath } from "node:url";
console.log(fileURLToPath("file:///a/b/c.ts"));
console.log(fileURLToPath("file:///a/b%20c/d.ts"));
console.log(fileURLToPath("file:///"));
`,
    );
  });

  test("a non-file URL throws, catchably", async () => {
    await differential(
      `import { fileURLToPath } from "node:url";
try {
  console.log(fileURLToPath("https://example.com/a"));
} catch (e) {
  console.log("caught");
}
`,
    );
  });
});

describe("spawnSync: the documented divergence + the closed options surface", () => {
  /*
   * node reports a spawn FAILURE as `status: null` plus an `.error` property. A
   * `number` cannot hold null, and typing status as `number | null` would break the
   * idiomatic `r.status !== 0` the compiler's own driver is written with — so a
   * failure to spawn (and death by signal) is -1. See docs/divergences.md. This
   * case is therefore BEHAVIORAL, not differential: node prints `null`, we print -1.
   */
  test("a command that does not exist is status -1 (node: null), and does not throw", async () => {
    const ours = await compileAndRunIO(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("nativets-no-such-command", [], { encoding: "utf8" });
console.log(r.status);
console.log("still running");
`,
    );
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("-1\nstill running\n");
  });

  test("the argument array is BORROWED, not consumed — it is usable afterwards", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const args = ["one", "two"];
const r = spawnSync("echo", args, { encoding: "utf8" });
console.log(r.stdout.trim());
console.log(args.length + " " + args[0]);
`,
    );
  });

  /*
   * `{ stdio: "inherit" }` — the second options shape, and the one `nativets run`
   * is written with: the child gets OUR fds, so its output is not captured at all
   * and node's result carries `stdout: null` / `stderr: null`. Typed as a result
   * with ONLY `status`, so reading `.stdout` is a type error rather than an empty
   * string that silently pretends the child printed nothing.
   *
   * Ordering is deterministic on POSIX: node's stdout is SYNCHRONOUS to a pipe on
   * Linux/macOS, and our runtime flushes before it forks.
   */
  test("`{ stdio: \"inherit\" }` — the child writes straight to our stdout", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
console.log("parent before");
const r = spawnSync("sh", ["-c", "echo from the child; echo child stderr 1>&2"], { stdio: "inherit" });
console.log("parent after, status " + r.status);
`,
    );
  });

  test("`{ stdio: \"inherit\" }` propagates a non-zero exit status", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("sh", ["-c", "exit 5"], { stdio: "inherit" });
console.log("status " + r.status);
`,
    );
  });

  /*
   * The SAME -1 convention as the captured form. The captured form can tell "execvp
   * never ran" from a real exit 127 by looking at the (empty) output; an inherited
   * child's output went straight to our fds, so there is nothing to look at — which is
   * why the child reports the failure over a close-on-exec pipe instead of guessing.
   */
  test("`{ stdio: \"inherit\" }`: a command that does not exist is status -1, not 127", async () => {
    const ours = await compileAndRunIO(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("nativets-no-such-command", [], { stdio: "inherit" });
console.log(r.status);
console.log("still running");
`,
    );
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("-1\nstill running\n");
  });

  test("`{ stdio: \"inherit\" }`: a REAL exit 127 is still 127", async () => {
    await differential(
      `import { spawnSync } from "node:child_process";
const r = spawnSync("sh", ["-c", "exit 127"], { stdio: "inherit" });
console.log("status " + r.status);
`,
    );
  });

  test("reading `.stdout` off an inherited spawn is refused (node: null)", () => {
    expect(rejects(`import { spawnSync } from "node:child_process";\nconst r = spawnSync("echo", ["x"], { stdio: "inherit" });\nconsole.log(r.stdout);\n`)).toBe("NT2001");
  });

  test("a stdio mode other than the literal \"inherit\" is refused", () => {
    expect(rejects(`import { spawnSync } from "node:child_process";\nconst r = spawnSync("echo", ["x"], { stdio: "pipe" });\nconsole.log(r.status);\n`)).toBe("NT1028");
  });

  test("spawnSync without the options object is refused (node yields Buffers)", () => {
    expect(rejects(`import { spawnSync } from "node:child_process";\nconst r = spawnSync("echo", ["x"]);\nconsole.log(r.status);\n`)).toBe("NT1028");
  });

  test("an option that would change behaviour is refused, not ignored", () => {
    expect(rejects(`import { spawnSync } from "node:child_process";\nconst r = spawnSync("echo", ["x"], { encoding: "utf8", cwd: "/tmp" });\nconsole.log(r.status);\n`)).toBe("NT1028");
  });
});

/*
 * The linker (SH1) merges every module into ONE Program, so a host builtin imported
 * by a NON-entry module has to survive that merge — which is exactly the shape the
 * compiler's own source has (src/modules.ts imports node:fs, src/cli.ts is the entry).
 */
describe("host imports survive the module linker", () => {
  test("a non-entry module's node: imports work after the merge", async () => {
    const dir = scratch();
    const entry = join(HERE, "hostfs", "host-modules", "main.ts");
    const oracle = runWithNodeFile(entry, [dir]);
    const ours = await compileAndRunFile(entry, [dir]);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
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

  /*
   * The AMBIENT half of the same surface. NT1028's catalog hint already names exactly
   * what exists here — "the ambient `process.argv`/`process.env`/`process.exit`/
   * `process.stdout.write`" — and `process.stdout.foo` was already refused with it. But
   * `process.platform` (a member READ) and `process.cwd()` (a CALL) went out as bare
   * NT2001 `typeError`s: no hint, no location, and in the TYPE band rather than the
   * FEATURE band.
   *
   * That last part is not cosmetic. `src/coverage.ts` counts only the NT1xxx band into
   * its blocker histogram, deliberately — an NT2xxx is a user's type error, not a
   * missing feature — so an unimplemented host builtin filed as NT2001 was STRUCTURALLY
   * invisible to the burn-down that is supposed to find it. `src/driver.ts` reads
   * `process.platform` twice and `src/modules.ts` calls `process.cwd()` once, so the
   * compiler's own three sites were the ones being hidden.
   *
   * The hint is verified TRUTHFUL by the four members it names, each of which has a
   * differential case against node already: `process.argv` (test/hostio echo-argv,
   * sum-argv), `process.env` + `process.exit` (env-exit), `process.stdout.write`
   * (stdout-write).
   */
  test("an ambient `process.*` member outside the surface is NT1028, not a bare type error", () => {
    const d = refusal(`console.log(process.platform);\n`)!;
    expect(d.code).toBe("NT1028");
    expect(d.message).toContain("process.platform");
    expect(d.hint ?? "").toContain("process.argv");
  });

  test("an ambient `process.*` CALL outside the surface is NT1028 too", () => {
    const d = refusal(`console.log(process.cwd());\n`)!;
    expect(d.code).toBe("NT1028");
    expect(d.message).toContain("process.cwd()");
    expect(d.hint ?? "").toContain("process.stdout.write");
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
