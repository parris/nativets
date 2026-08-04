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
