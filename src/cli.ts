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
import { NTError, formatDiagnostic } from "./diagnostics.ts";

/** Run a compile action, printing NT diagnostics cleanly instead of a stack trace. */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Render multi-span diagnostics against the source (rustc-style caret underlines).
    if (e instanceof NTError) { console.error(formatDiagnostic(e.diag, source)); process.exit(1); }
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
  const out = getFlag(rest, "-o") ?? basename(file).replace(/\.ts$/, "");
  const target = (getFlag(rest, "--target") ?? "host") as Target;
  const isStatic = hasFlag(rest, "--static");
  await guard(() => buildBinary(source, out, { target, static: isStatic, entryPath: file }));
  console.error(`wrote ${out}`);
  process.exit(0);
}

if (cmd === "run") {
  const dir = mkdtempSync(join(tmpdir(), "nativets-cli-"));
  try {
    const bin = join(dir, "prog");
    await guard(() => buildBinary(source, bin, { target: "host", entryPath: file }));
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
