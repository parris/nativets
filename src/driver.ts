/*
 * Compiler driver: public API + toolchain glue.
 *
 *   sourceToIR(source)                 source -> LLVM IR text
 *   buildBinary(source, out, {target}) -> fully linked native executable
 *   buildObject(source, out, target)   -> object file (IR only; arch check)
 *
 * The IR carries no target triple, so clang stamps in whatever `-target` we
 * pass. Cross targets link the SAME runtime/runtime.c (libc-only, so it builds
 * for macOS/iOS/Android unchanged).
 */

import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parse } from "./parser.ts";
import { check } from "./checker.ts";
import { codegen } from "./codegen.ts";
import { analyzeOwnership, type OwnDiag } from "./ownership.ts";
import { NTError } from "./diagnostics.ts";
// Embed the C runtime as text so a `bun build --compile` single executable is
// self-contained (no runtime/runtime.c on disk needed at run time).
import runtimeSource from "../runtime/runtime.c" with { type: "text" };

export type Target = "host" | "ios" | "ios-sim" | "android";

const IOS_VERSION = "18.0";
const ANDROID_API = 24;

export class BuildError extends Error {}

export function sourceToIR(source: string): string {
  const checked = check(parse(source));
  const own = analyzeOwnership(checked);
  if (own.length) {
    const d = own[0]!;
    throw new NTError({ code: d.code, message: `${d.message}${d.movedAt ? ` (moved at line ${d.movedAt}, used at line ${d.line})` : ` (line ${d.line})`}` });
  }
  return codegen(checked);
}

/** Ownership diagnostics for a source (for tests / the coverage of the move checker). */
export function ownershipCheck(source: string): OwnDiag[] {
  return analyzeOwnership(check(parse(source)));
}

function sdkPath(sdk: string): string {
  return (spawnSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).stdout ?? "").trim();
}

/** Locate the NDK clang wrapper for aarch64 Android. */
export function androidClang(): string {
  const ndkBase = join(homedir(), "Library/Android/sdk/ndk");
  if (!existsSync(ndkBase)) throw new BuildError("Android NDK not found");
  const versions = readdirSync(ndkBase).sort();
  const ndk = versions[versions.length - 1]!;
  const bin = join(ndkBase, ndk, "toolchains/llvm/prebuilt/darwin-x86_64/bin");
  const wanted = `aarch64-linux-android${ANDROID_API}-clang`;
  if (existsSync(join(bin, wanted))) return join(bin, wanted);
  const any = readdirSync(bin).filter((f) => /^aarch64-linux-android\d+-clang$/.test(f)).sort();
  if (!any.length) throw new BuildError("No aarch64 Android clang in NDK");
  return join(bin, any[0]!);
}

interface Toolchain { cc: string; flags: string[] }

function toolchainFor(target: Target): Toolchain {
  switch (target) {
    case "host": return { cc: "clang", flags: [] };
    case "ios": return { cc: "clang", flags: ["-target", `arm64-apple-ios${IOS_VERSION}`, "-isysroot", sdkPath("iphoneos")] };
    case "ios-sim": return { cc: "clang", flags: ["-target", `arm64-apple-ios${IOS_VERSION}-simulator`, "-isysroot", sdkPath("iphonesimulator")] };
    case "android": return { cc: androidClang(), flags: [] };
  }
}

function writeIR(source: string): { dir: string; ll: string; rt: string } {
  const dir = mkdtempSync(join(tmpdir(), "nativets-build-"));
  const ll = join(dir, "module.ll");
  writeFileSync(ll, sourceToIR(source));
  const rt = join(dir, "runtime.c");
  writeFileSync(rt, runtimeSource); // embedded runtime → self-contained executable
  return { dir, ll, rt };
}

function run(cc: string, args: string[]): void {
  const r = spawnSync(cc, args, { encoding: "utf8" });
  if (r.status !== 0) throw new BuildError(`${cc} failed (${r.status}):\n${r.stderr}`);
}

export async function buildBinary(source: string, outPath: string, opts: { target?: Target } = {}): Promise<void> {
  const { cc, flags } = toolchainFor(opts.target ?? "host");
  const { dir, ll, rt } = writeIR(source);
  try {
    // -lm: libm is separate on Android NDK (fmod/floor/...); harmless on macOS/iOS.
    run(cc, [...flags, ll, rt, "-lm", "-o", outPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildObject(source: string, outPath: string, target: Target): Promise<void> {
  const { cc, flags } = toolchainFor(target);
  const { dir, ll } = writeIR(source);
  try {
    run(cc, [...flags, "-c", ll, "-o", outPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
