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
// The v0 actor runtime (BEAM-style spawn/send/receive/self). Compiled + linked
// into EVERY binary (libc + ucontext only, so it cross-links unchanged). Its
// header is embedded alongside so the `#include "nt_actor.h"` resolves in temp.
import actorSource from "../runtime/nt_actor.c" with { type: "text" };
import actorHeader from "../runtime/nt_actor.h" with { type: "text" };
// The B2 immutable Map/Set core (Bagwell HAMT + small-flat) and its scalar-ABI
// wrappers. Linked ONLY when a program uses Map/Set (libc-only, so it would
// cross-link fine everywhere, but conditional keeps non-map binaries minimal).
import hamtSource from "../runtime/nt_hamt.c" with { type: "text" };
import hamtHeader from "../runtime/nt_hamt.h" with { type: "text" };
import mapsetSource from "../runtime/nt_mapset.c" with { type: "text" };

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

function writeIR(source: string): { dir: string; ll: string; rt: string; actor: string | null; extra: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "nativets-build-"));
  const ll = join(dir, "module.ll");
  const ir = sourceToIR(source);
  writeFileSync(ll, ir);
  const rt = join(dir, "runtime.c");
  writeFileSync(rt, runtimeSource); // embedded runtime → self-contained executable
  // B2 Map/Set: link the HAMT core + scalar-ABI wrappers only when used (codegen
  // emits nt_map_new/nt_set_new exactly then). libc-only, so it cross-links unchanged.
  const extra: string[] = [];
  if (ir.includes("@nt_map_new(") || ir.includes("@nt_set_new(")) {
    writeFileSync(join(dir, "nt_hamt.h"), hamtHeader); // quote-included by both .c files
    const hamt = join(dir, "nt_hamt.c");
    writeFileSync(hamt, hamtSource);
    const mapset = join(dir, "nt_mapset.c");
    writeFileSync(mapset, mapsetSource);
    extra.push(hamt, mapset);
  }
  // Link the v0 actor runtime ONLY when the program uses actors (codegen emits the
  // nt_sched_init prologue exactly then). It relies on ucontext (makecontext/
  // swapcontext), which the Android NDK's Bionic does not declare at low API levels,
  // so pulling it into every non-actor binary would break the Android cross-build.
  let actor: string | null = null;
  if (ir.includes("call void @nt_sched_init()")) {
    actor = join(dir, "nt_actor.c");
    writeFileSync(actor, actorSource);
    writeFileSync(join(dir, "nt_actor.h"), actorHeader); // its header (quote-included)
  }
  return { dir, ll, rt, actor, extra };
}

function run(cc: string, args: string[]): void {
  const r = spawnSync(cc, args, { encoding: "utf8" });
  if (r.status !== 0) throw new BuildError(`${cc} failed (${r.status}):\n${r.stderr}`);
}

export async function buildBinary(source: string, outPath: string, opts: { target?: Target } = {}): Promise<void> {
  const { cc, flags } = toolchainFor(opts.target ?? "host");
  const { dir, ll, rt, actor, extra } = writeIR(source);
  try {
    // -lm: libm is separate on Android NDK (fmod/floor/...); harmless on macOS/iOS.
    run(cc, [...flags, ll, rt, ...(actor ? [actor] : []), ...extra, "-lm", "-o", outPath]);
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
