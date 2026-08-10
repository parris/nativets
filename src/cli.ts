#!/usr/bin/env bun
/*
 * nativets CLI
 *   nativets build <file.ts> [-o out] [--target host|ios|ios-sim|android|wasm|windows]
 *   nativets run   <file.ts>
 *   nativets emit  <file.ts>            print LLVM IR to stdout
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceToIR, buildBinary, BuildError, type Target } from "./driver.ts";
import { coverage, renderCoverage } from "./coverage.ts";
import { NTError, formatDiagnostic, type Diagnostic, type SourceFile } from "./diagnostics.ts";

/**
 * Run a compile action, printing NT diagnostics cleanly instead of a stack trace.
 *
 * Callers that hand this an ASYNC action must write `async () => await f(…)`, not
 * `() => f(…)`. The two are the same program under node — `guard` awaits whatever the
 * callback returns either way, and a rejection reaches the `catch` below identically —
 * but the second is an un-awaited call to an async function, which is NT1020 here.
 * That refusal is a DELIBERATE over-rejection (docs/divergences.md): knowing that a
 * promise threaded through un-awaited is awaited further up is a taint analysis over
 * promise values, so the rule is the same everywhere and `await` at the inner call site
 * is the fix it prescribes. It was stage-1's own first blocker.
 */
/**
 * The text of every file a diagnostic points into.
 *
 * `linkProgram` merges the import graph into ONE Program while each module keeps its OWN
 * line numbers, so rendering everything against the entry source — which is all this file
 * used to have — printed an imported module's line number over the entry file's text. The
 * caret then underlined unrelated, valid code and the real file was never named.
 *
 * The spans say which files they mean, so we read exactly those. Reading here rather than
 * plumbing a source map out of the linker keeps `src/modules.ts` unchanged and works for
 * every producer, including the ones that run before linking. An unreadable file is
 * skipped, not fatal: `formatDiagnostic` then prints the `-->` locator with no frame,
 * which is honest about what we know.
 */
function diagSources(diag: Diagnostic, entryFile: string, entryText: string): SourceFile[] {
  let out: SourceFile[] = [{ file: entryFile, text: entryText }];
  const spans = diag.spans;
  if (spans === undefined) return out;
  for (const s of spans) {
    const f = s.file;
    if (f === undefined) continue;
    if (out.some((x) => x.file === f)) continue;
    try {
      out = [...out, { file: f, text: readFileSync(f, "utf8") }];
    } catch {
      // Unreadable (deleted, or a synthetic path): the locator still names it.
    }
  }
  return out;
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Render multi-span diagnostics against the source (rustc-style caret underlines) —
    // each span against ITS OWN file, so a cross-module error quotes the module it is in.
    //
    // `file!`: `guard` is DECLARED above the `if (!cmd || !file) usage()` guard but only
    // ever CALLED below it, and `usage()` returns `never` — so `file` is a string by the
    // time this line can run. TypeScript cannot see that (the closure predates the
    // narrowing), and `?? ""` would quietly key the entry source under a path no span can
    // ever name, which is the kind of silent mismatch this whole lane is about.
    if (e instanceof NTError) { console.error(formatDiagnostic(e.diag, source, diagSources(e.diag, file!, source))); process.exit(1); }
    // Toolchain/link failures (missing raylib/curl/SDK, cross-target limits) — a clear one-liner.
    if (e instanceof BuildError) { console.error(`build error: ${e.message}`); process.exit(1); }
    throw e;
  }
}

function usage(): never {
  console.error("usage: nativets <build|run|emit|coverage> <file.ts> [-o out] [--target host|ios|ios-sim|android|wasm|windows] [--static]");
  process.exit(2);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const [, , cmd, file, ...rest] = process.argv;
if (!cmd || !file) usage();

// The entry file's path anchors `import "./x.ts"` resolution (SH1 modules).
let source: string;
try {
  source = readFileSync(file, "utf8");
} catch {
  console.error(`error: cannot read '${file}'`);
  process.exit(1);
}

if (cmd === "emit") {
  process.stdout.write(await guard(() => sourceToIR(source, file)));
  process.exit(0);
}

if (cmd === "coverage") {
  const report = coverage(source, file);
  console.log(renderCoverage(source, report));
  process.exit(report.compiles ? 0 : 1);
}

if (cmd === "build") {
  // `.replace(/\.ts$/, "")` — the suffix, without a RegExp (nativets has none).
  const base = basename(file);
  const out = getFlag(rest, "-o") ?? (base.endsWith(".ts") ? base.slice(0, -3) : base);
  const target = (getFlag(rest, "--target") ?? "host") as Target;
  const isStatic = hasFlag(rest, "--static");
  await guard(async () => await buildBinary(source, out, { target, static: isStatic, entryPath: file }));
  console.error(`wrote ${out}`);
  process.exit(0);
}

if (cmd === "run") {
  const dir = mkdtempSync(join(tmpdir(), "nativets-cli-"));
  try {
    const bin = join(dir, "prog");
    await guard(async () => await buildBinary(source, bin, { target: "host", entryPath: file }));
    // Forward CLI args after the source file to the program as process.argv[2..]
    // (a leading `--` separator is dropped): `nativets run chat.ts -- --key $KEY`.
    const fwd = rest[0] === "--" ? rest.slice(1) : rest;
    const r = spawnSync(bin, fwd, { stdio: "inherit" });
    process.exit(r.status ?? -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

usage();
