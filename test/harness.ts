/*
 * Test harness for nativets.
 *
 * Exposes the primitives the four test types are built on:
 *   - emitIR(source)            -> LLVM IR text (for snapshot tests)
 *   - compileAndRun(source)     -> run our native binary, capture stdout/exit
 *   - runWithNode(source)       -> the differential ORACLE
 *   - crossObjectArch(source,t) -> cross-compile to object, report its arch
 *
 * Everything shells out through src/driver.ts, the compiler's public API.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { sourceToIR, buildBinary, buildObject, type Target } from "../src/driver.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `nativets-${prefix}-`));
}

/** Lower source to LLVM IR text. Pure; no toolchain invoked. */
export function emitIR(source: string): string {
  return sourceToIR(source);
}

/** Compile `source` to a host binary and run it. */
export async function compileAndRun(source: string): Promise<RunResult> {
  const dir = scratch("run");
  try {
    const bin = join(dir, "prog");
    await buildBinary(source, bin, { target: "host" });
    const proc = spawnSync(bin, [], { encoding: "utf8" });
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      exitCode: proc.status ?? -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The oracle: run the same source under node and capture its output. */
export function runWithNode(source: string): RunResult {
  const dir = scratch("oracle");
  try {
    const file = join(dir, "case.ts");
    writeFileSync(file, source);
    const proc = spawnSync("node", [file], { encoding: "utf8" });
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      exitCode: proc.status ?? -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Cross-compile to an object file and return `file`'s description of its arch. */
export async function crossObjectArch(source: string, target: Target): Promise<string> {
  const dir = scratch("cross");
  try {
    const obj = join(dir, "out.o");
    await buildObject(source, obj, target);
    const proc = spawnSync("file", [obj], { encoding: "utf8" });
    return (proc.stdout ?? "").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert our binary matches the node oracle for a piece of source. */
export async function expectMatchesNode(source: string): Promise<{
  ours: RunResult;
  oracle: RunResult;
}> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  return { ours, oracle };
}

/* ============================================================
 * Host I/O differential harness — feeds the SAME argv + stdin + env to BOTH
 * `node file.ts <args>` and our compiled `./binary <args>`, so a fixture that
 * reads input can be differential-tested against node.
 *
 * process.argv / process.env / process.exit are native to node, so no shim is
 * needed for them. node has no synchronous readLine()/readStdin(), so for the
 * ORACLE run only we prepend a tiny polyfill that reads fd 0 once and serves it
 * from a shared cursor — byte-for-byte identical to the runtime's stdin FFI.
 * ============================================================ */

/** Declared inputs a Host-I/O fixture is run with (identical on both sides). */
export interface IOInput { args?: string[]; stdin?: string; env?: Record<string, string>; }

/** node-only polyfill for the stdin builtins (ESM — the repo is `"type":"module"`,
 * so `require` is unavailable; use a top-level import). The file is a `.ts` so node
 * strips type annotations, matching `runWithNode` — real typed programs work. */
const STDIN_POLYFILL = [
  'import { readFileSync as __rfs } from "node:fs";',
  ";(function () {",
  "  let __buf = null, __pos = 0;",
  '  function __load() { if (__buf === null) { try { __buf = __rfs(0, "utf8"); } catch (e) { __buf = ""; } } }',
  "  globalThis.readStdin = function () { __load(); const r = __buf.slice(__pos); __pos = __buf.length; return r; };",
  "  globalThis.readLine = function () {",
  "    __load();",
  '    if (__pos >= __buf.length) return "";',
  "    const nl = __buf.indexOf(String.fromCharCode(10), __pos);",
  "    if (nl < 0) { const r = __buf.slice(__pos); __pos = __buf.length; return r; }",
  "    const r = __buf.slice(__pos, nl); __pos = nl + 1; return r;",
  "  };",
  "})();",
  "",
].join("\n");

/** The oracle for a Host-I/O fixture: node with the polyfill, same argv/stdin/env. */
export function runWithNodeIO(source: string, io: IOInput = {}): RunResult {
  const dir = scratch("oracle-io");
  try {
    const file = join(dir, "case.ts"); // .ts so node strips type annotations (like runWithNode)
    writeFileSync(file, STDIN_POLYFILL + source);
    const proc = spawnSync("node", [file, ...(io.args ?? [])], {
      encoding: "utf8",
      input: io.stdin ?? "",
      env: { ...process.env, ...(io.env ?? {}) },
    });
    return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile a Host-I/O fixture and run the binary with the same argv/stdin/env. */
export async function compileAndRunIO(source: string, io: IOInput = {}): Promise<RunResult> {
  const dir = scratch("run-io");
  try {
    const bin = join(dir, "prog");
    await buildBinary(source, bin, { target: "host" });
    const proc = spawnSync(bin, io.args ?? [], {
      encoding: "utf8",
      input: io.stdin ?? "",
      env: { ...process.env, ...(io.env ?? {}) },
    });
    return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
