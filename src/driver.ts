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
import { NTError, type DiagSpan } from "./diagnostics.ts";
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

export type Target = "host" | "ios" | "ios-sim" | "android" | "windows";

/** Options for a native build. `static` produces a fully static binary (no dynamic libc). */
export interface BuildOpts { target?: Target; static?: boolean }

const IOS_VERSION = "18.0";
const ANDROID_API = 24;

export class BuildError extends Error {}

export function sourceToIR(source: string): string {
  const checked = check(parse(source));
  const own = analyzeOwnership(checked);
  if (own.length) {
    const d = own[0]!;
    // Multi-span diagnostic (rustc-style): a use-after-move points at BOTH the use and the
    // earlier move; the single-line-location codes point at just their one line. The primary
    // caret is the offending use/move; the secondary "-" underline is the move that caused it.
    const spans: DiagSpan[] = [
      { line: d.line, label: d.movedAt ? "value used here after move" : "occurs here", primary: true },
    ];
    if (d.movedAt) spans.push({ line: d.movedAt, label: "value moved here" });
    throw new NTError({ code: d.code, message: d.message, spans });
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

/** The C compiler to invoke for a target (the NDK wrapper resolves an Android clang). */
function ccFor(target: Target): string {
  return target === "android" ? androidClang() : "clang";
}

/**
 * The `-target`/`-isysroot` flags for a target — pure and NDK-independent (the Android
 * NDK clang wrapper bakes in its own target triple, so it needs no `-target` flag). Kept
 * separate from `ccFor` so link-arg construction is testable without an NDK on the box.
 */
function targetFlags(target: Target): string[] {
  switch (target) {
    case "host": return [];
    case "ios": return ["-target", `arm64-apple-ios${IOS_VERSION}`, "-isysroot", sdkPath("iphoneos")];
    case "ios-sim": return ["-target", `arm64-apple-ios${IOS_VERSION}-simulator`, "-isysroot", sdkPath("iphonesimulator")];
    case "android": return [];
    // Windows x86-64 PE via clang's MSVC/UCRT target. IR carries no triple, so clang stamps
    // this in. Header-free IR compiles to a COFF object on any host (the local arch check);
    // LINKING a full .exe needs the Windows SDK + lld-link, so it links natively on a Windows
    // runner (or a mingw sysroot). No -isysroot: the Windows SDK is discovered by clang itself.
    case "windows": return ["-target", "x86_64-pc-windows-msvc"];
  }
}

function toolchainFor(target: Target): Toolchain {
  return { cc: ccFor(target), flags: targetFlags(target) };
}

/**
 * Whether a target can produce a *fully* static binary (no dynamic libc dependency).
 * Apple platforms ship no static libc archive (`crt0.o` static linking is unsupported),
 * so macOS/iOS keep the default single-file *dynamic*-libc binary; Linux-family targets
 * (Android, and a Linux host) support `-static`.
 */
export function supportsStatic(target: Target): boolean {
  switch (target) {
    case "android": return true;
    case "ios":
    case "ios-sim": return false;
    // Windows links dynamically against the UCRT/MSVCRT (no fully-static libc archive in the
    // default toolchain), so `--static` falls back to the dynamic default there, like Apple.
    case "windows": return false;
    // `host` is Apple only when we're building on macOS; on a Linux host it's a Linux ELF.
    case "host": return process.platform !== "darwin";
  }
}

/**
 * Resolve the link-mode flags for a `--static` request. Returns `-static` when the target
 * supports it, otherwise no flag plus a warning (we fall back to the dynamic default rather
 * than failing the build). Pure — the unit-test surface for the `--static` plumbing.
 */
export function resolveStatic(target: Target, requested: boolean): { flags: string[]; warning?: string } {
  if (!requested) return { flags: [] };
  if (supportsStatic(target)) return { flags: ["-static"] };
  return {
    flags: [],
    warning: `--static: a fully static libc binary is not supported on the '${target}' (Apple) target; producing the default dynamic-libc binary instead`,
  };
}

/**
 * Build the clang link argv for a program (everything after the compiler name). Pure and
 * NDK-independent, so a test can assert the flags produced for a target + `--static` without
 * a Linux box or an installed NDK. `buildBinary` pairs it with `ccFor` to actually link.
 */
export function linkArgv(
  target: Target,
  files: { ll: string; rt: string; actor?: string | null; extra?: string[]; out: string },
  opts: { static?: boolean } = {},
): { args: string[]; warning?: string } {
  const { flags: staticFlags, warning } = resolveStatic(target, opts.static ?? false);
  const args = [
    ...targetFlags(target),
    files.ll,
    files.rt,
    ...(files.actor ? [files.actor] : []),
    ...(files.extra ?? []),
    ...staticFlags,
    // -lm: libm is separate on Android NDK (fmod/floor/...); harmless on macOS/iOS. Windows
    // folds the math functions into the UCRT/MSVCRT (no separate m.lib), so omit it there —
    // lld-link would otherwise fail resolving a nonexistent `m.lib`.
    ...(target === "windows" ? [] : ["-lm"]),
    "-o",
    files.out,
  ];
  return { args, warning };
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

export async function buildBinary(source: string, outPath: string, opts: BuildOpts = {}): Promise<void> {
  const target = opts.target ?? "host";
  const cc = ccFor(target);
  const { dir, ll, rt, actor, extra } = writeIR(source);
  try {
    const { args, warning } = linkArgv(target, { ll, rt, actor, extra, out: outPath }, { static: opts.static });
    if (warning) console.error(`warning: ${warning}`);
    run(cc, args);
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
