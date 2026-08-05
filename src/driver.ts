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
import { linkProgram } from "./modules.ts";
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
// The bytes value type (stdlib batch 2): Uint8Array + TextEncoder/TextDecoder (UTF-8).
// libc-only, so it cross-links unchanged; linked ONLY when a program uses one of the
// bytes builtins (codegen emits a `call … @nt_bytes_*` exactly then), like Map/Set.
import bytesSource from "../runtime/nt_bytes.c" with { type: "text" };
import bytesHeader from "../runtime/nt_bytes.h" with { type: "text" };
// The B2 step-2 persistent vector (32-way trie + tail): the structural-sharing backend
// for arrays past ~32 elements. libc-only. Unlike Map/Set/bytes/http it is reached from
// inside runtime.c (it sits behind the core nt_arr_* primitives), so the gate is a
// COMPILE-time one: nt_pvec.c + `-DNT_PVEC` are added only when a program uses arrays,
// and without them runtime.c compiles the pre-existing flat-only path. A missed gate is
// therefore a lost optimisation, never a link error. See docs/research/B2-vector-trie.md §4.3.
import pvecSource from "../runtime/nt_pvec.c" with { type: "text" };
import pvecHeader from "../runtime/nt_pvec.h" with { type: "text" };
// The HTTP(S) client primitive (networking tier, L-d), backed by libcurl. Linked (with
// `-lcurl`) ONLY when a program uses httpGet/httpPost — so non-HTTP programs and their
// iOS/Android cross-builds are unaffected. Networking is HOST/LINUX ONLY for now; iOS/
// Android need the platform HTTP stack (NSURLSession/OkHttp), a follow-on.
import httpSource from "../runtime/nt_http.c" with { type: "text" };
// The GUI primitive (north-star C-d), backed by raylib. Linked (with -lraylib + the platform
// frameworks raylib needs) ONLY when a program calls a GUI builtin (initWindow/drawRect/…) —
// so non-GUI programs and every cross-build stay raylib-free. HOST DESKTOP ONLY for now
// (macOS/Linux/Windows); a wasm/emscripten lane is a documented follow-on (see calc-gui.ts).
import guiSource from "../runtime/nt_gui.c" with { type: "text" };

export type Target = "host" | "ios" | "ios-sim" | "android" | "wasm" | "windows";

/**
 * Options for a native build. `static` produces a fully static binary (no dynamic
 * libc); `entryPath` is the entry file's path on disk — the anchor `import`
 * specifiers resolve against (SH1 modules). Omit it for a module-less source.
 */
export interface BuildOpts { target?: Target; static?: boolean; entryPath?: string }

const IOS_VERSION = "18.0";
const ANDROID_API = 24;

export class BuildError extends Error {}

export function sourceToIR(source: string, entryPath?: string): string {
  // SH1: resolve + merge the import graph into ONE Program (a no-op returning
  // `parse(source)` when the entry declares no imports), then compile as usual.
  const checked = check(linkProgram(source, entryPath));
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
export function ownershipCheck(source: string, entryPath?: string): OwnDiag[] {
  return analyzeOwnership(check(linkProgram(source, entryPath)));
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

/**
 * Candidate wasi-sdk roots, most-specific first: the `WASI_SDK_PATH` env override, then the
 * conventional install locations (a wasi-sdk tarball unpacked to /opt or $HOME, and the
 * Homebrew `wasi-sdk` keg). A wasi-sdk root holds `bin/clang` (a wasm-capable LLVM) and
 * `share/wasi-sysroot` (wasi-libc). Mirrors how `androidClang` hunts for the NDK.
 */
function wasiSdkRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.WASI_SDK_PATH;
  if (env) roots.push(env);
  roots.push(
    "/opt/wasi-sdk",
    join(homedir(), "wasi-sdk"),
    "/opt/homebrew/opt/wasi-sdk",
    "/usr/local/opt/wasi-sdk",
  );
  return roots;
}

/** Whether `cc` (a clang) has the WebAssembly backend — Apple's system clang does NOT. */
function clangSupportsWasm(cc: string): boolean {
  const r = spawnSync(cc, ["--print-targets"], { encoding: "utf8" });
  return r.status === 0 && /\bwasm32\b/.test(r.stdout ?? "");
}

/**
 * Locate the wasi-libc sysroot (`--sysroot`). Prefer a wasi-sdk's bundled sysroot, then a
 * standalone Homebrew `wasi-libc` keg. Throws a clear BuildError when none is present.
 */
export function wasiSysroot(): string {
  const cands: string[] = [];
  for (const r of wasiSdkRoots()) cands.push(join(r, "share", "wasi-sysroot"));
  cands.push(
    "/opt/homebrew/opt/wasi-libc/share/wasi-sysroot",
    "/usr/local/opt/wasi-libc/share/wasi-sysroot",
  );
  for (const c of cands) if (existsSync(c)) return c;
  throw new BuildError("wasi-sdk not found; set WASI_SDK_PATH (its share/wasi-sysroot is the wasi-libc sysroot)");
}

/**
 * A wasm-capable clang for the WASI target: a wasi-sdk's bundled `bin/clang`, else a Homebrew
 * LLVM clang, else the system `clang` iff it actually carries the WebAssembly backend (Apple's
 * does not). Throws a clear BuildError when nothing can target wasm.
 */
export function wasiClang(): string {
  const cands: string[] = [];
  for (const r of wasiSdkRoots()) cands.push(join(r, "bin", "clang"));
  cands.push("/opt/homebrew/opt/llvm/bin/clang", "/usr/local/opt/llvm/bin/clang");
  for (const c of cands) if (existsSync(c)) return c;
  if (clangSupportsWasm("clang")) return "clang";
  throw new BuildError("wasi-sdk not found; set WASI_SDK_PATH (or install a clang/LLVM with the wasm32 target)");
}

/** Whether this machine can build for wasm (a wasm-capable clang + a wasi sysroot). For tests. */
export function wasmToolchainAvailable(): boolean {
  try { wasiClang(); wasiSysroot(); return true; } catch { return false; }
}

/**
 * The frameworks raylib links against on macOS: its GLFW backend drives the Cocoa window +
 * the OpenGL/CoreVideo/IOKit stack. Appended on darwin even when pkg-config was used, since a
 * static libraylib.a does not carry these as recorded dependencies (harmless if duplicated).
 */
const RAYLIB_MAC_FRAMEWORKS = [
  "-framework", "CoreVideo", "-framework", "IOKit", "-framework", "Cocoa",
  "-framework", "GLUT", "-framework", "OpenGL",
];

/**
 * Locate raylib for a HOST GUI link and return the linker flags. Prefer `pkg-config --libs
 * raylib` (the canonical source of truth); otherwise hunt the conventional install roots
 * (Homebrew keg, /usr/local, /opt/local) for libraylib and pair -L/-lraylib. On macOS the
 * platform frameworks are always appended. Throws a clear BuildError when raylib is not
 * installed. GUI is HOST-DESKTOP ONLY (macOS/Linux/Windows) — see nt_gui.c / calc-gui.ts.
 */
export function raylibLinkFlags(): string[] {
  let flags: string[] | null = null;
  const pc = spawnSync("pkg-config", ["--libs", "raylib"], { encoding: "utf8" });
  if (pc.status === 0 && (pc.stdout ?? "").trim()) {
    flags = (pc.stdout as string).trim().split(/\s+/);
  } else {
    const libDirs = [
      "/opt/homebrew/lib", "/opt/homebrew/opt/raylib/lib",
      "/usr/local/lib", "/usr/local/opt/raylib/lib",
      "/opt/local/lib", "/usr/lib", "/usr/lib64",
    ];
    for (const d of libDirs) {
      if (existsSync(join(d, "libraylib.dylib")) || existsSync(join(d, "libraylib.a")) || existsSync(join(d, "libraylib.so"))) {
        flags = ["-L" + d, "-lraylib"];
        break;
      }
    }
  }
  if (!flags) {
    throw new BuildError(
      "raylib not found: install it (macOS: `brew install raylib`; Linux: your distro's `raylib` / `libraylib-dev`) — the GUI FFI (initWindow/drawRect/…) needs it. GUI is host-desktop only.",
    );
  }
  if (process.platform === "darwin") {
    for (const f of RAYLIB_MAC_FRAMEWORKS) if (!flags.includes(f)) flags.push(f);
  }
  return flags;
}

/** Whether this machine can link a GUI (raylib-backed) program. For tests / build-verify. */
export function raylibAvailable(): boolean {
  try { raylibLinkFlags(); return true; } catch { return false; }
}

interface Toolchain { cc: string; flags: string[] }

/** The C compiler to invoke for a target (the NDK wrapper resolves an Android clang; wasm needs a wasm-capable clang). */
function ccFor(target: Target): string {
  if (target === "android") return androidClang();
  if (target === "wasm") return wasiClang();
  return "clang";
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
    // wasm: the wasi-sdk clang is a generic LLVM (not target-baked, unlike the NDK wrapper),
    // so it needs both the triple and the wasi-libc sysroot. `wasiSysroot()` resolves it
    // (throwing a clear BuildError when absent) — analogous to iOS's `-isysroot` via xcrun.
    case "wasm": return ["--target=wasm32-wasi", "--sysroot", wasiSysroot()];
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
    // wasm modules are self-contained by construction; `-static` is not a wasi link concept.
    case "wasm": return false;
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
    warning: `--static: a fully static libc binary is not supported on the '${target}' target; producing the default binary instead`,
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

function writeIR(source: string, entryPath?: string): { dir: string; ll: string; rt: string; actor: string | null; extra: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "nativets-build-"));
  const ll = join(dir, "module.ll");
  const ir = sourceToIR(source, entryPath);
  writeFileSync(ll, ir);
  const rt = join(dir, "runtime.c");
  writeFileSync(rt, runtimeSource); // embedded runtime → self-contained executable
  // B2 Map/Set: link the HAMT core + scalar-ABI wrappers only when used (codegen
  // emits nt_map_new/nt_set_new exactly then). libc-only, so it cross-links unchanged.
  const extra: string[] = [];
  // Match the CALL site, not the (always-present) `declare` line — collections are
  // reached through the nt_coll_*/nt_map_*_slot/nt_set_*_slot wrappers.
  if (/\bcall\b[^\n]*@nt_(coll|map|set)_/.test(ir)) {
    writeFileSync(join(dir, "nt_hamt.h"), hamtHeader); // quote-included by both .c files
    const hamt = join(dir, "nt_hamt.c");
    writeFileSync(hamt, hamtSource);
    const mapset = join(dir, "nt_mapset.c");
    writeFileSync(mapset, mapsetSource);
    extra.push(hamt, mapset);
  }
  // Persistent vector (B2 step 2): link nt_pvec.c + define NT_PVEC ONLY when the program
  // actually uses arrays — matched at a CALL site (`call … @nt_arr_*`), never the
  // always-present `declare`, exactly like the bytes/curl/gui lanes. `-D` is position-
  // independent for clang, so it may ride in `extra` with the source files.
  if (/\bcall\b[^\n]*@nt_arr_/.test(ir)) {
    writeFileSync(join(dir, "nt_pvec.h"), pvecHeader); // quote-included by runtime.c + the .c
    const pvec = join(dir, "nt_pvec.c");
    writeFileSync(pvec, pvecSource);
    extra.push(pvec, "-DNT_PVEC");
  }
  // Bytes (stdlib batch 2): link nt_bytes.c ONLY when a program uses Uint8Array /
  // TextEncoder / TextDecoder (codegen emits `call … @nt_bytes_*` exactly then).
  // libc-only, so it cross-links to every target unchanged.
  if (/\bcall\b[^\n]*@nt_bytes_/.test(ir)) {
    writeFileSync(join(dir, "nt_bytes.h"), bytesHeader); // quote-included by the .c
    const bytes = join(dir, "nt_bytes.c");
    writeFileSync(bytes, bytesSource);
    extra.push(bytes);
  }
  // HTTP client (L-d): link nt_http.c + libcurl ONLY when a program calls httpGet/httpPost.
  // `-lcurl` follows nt_http.c in the link line (the .c references curl symbols), matching
  // the GNU-ld "library after the object that needs it" ordering. Host/Linux only — libcurl
  // is present on macOS/Linux CI; the conditional link keeps every other build (incl. the
  // iOS/Android cross-builds) free of the curl dependency.
  // Match the CALL site, not the (always-present) `declare` line, so nt_http.c + libcurl
  // are pulled in ONLY when the program actually calls the builtin.
  // `fetch` lives in the same file, so its call site pulls in the same object + libcurl.
  if (ir.includes("call ptr @nt_http_post(") || ir.includes("call ptr @nt_http_get(") || ir.includes("call ptr @nt_fetch(")) {
    const http = join(dir, "nt_http.c");
    writeFileSync(http, httpSource);
    extra.push(http, "-lcurl");
  }
  // GUI (north-star C-d): link nt_gui.c + raylib (+ macOS frameworks) ONLY when the program
  // actually CALLS a GUI builtin — matched at the call site (`call … @nt_gui_*`), never the
  // always-present `declare`, exactly like the curl lane. `raylibLinkFlags()` locates raylib
  // (pkg-config / Homebrew / /usr/local / /opt) or throws a clear BuildError. HOST-DESKTOP
  // ONLY: GUI programs are not cross-built (iOS/Android/wasm need platform UI bindings), so
  // non-GUI programs and every cross-build stay entirely raylib-free.
  if (/\bcall\b[^\n]*@nt_gui_/.test(ir)) {
    const gui = join(dir, "nt_gui.c");
    writeFileSync(gui, guiSource);
    extra.push(gui, ...raylibLinkFlags());
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
  const { dir, ll, rt, actor, extra } = writeIR(source, opts.entryPath);
  // Actors need the ucontext-based cooperative scheduler (nt_actor.c); wasm32-wasi has no
  // ucontext, so gate here with a clear error instead of a cryptic link failure. Ordinary
  // (non-actor) programs link fine — the actor runtime is only pulled in when used.
  if (target === "wasm" && actor) {
    rmSync(dir, { recursive: true, force: true });
    throw new BuildError("the wasm (WASI) target does not support actors (spawn/send/receive): the actor runtime needs ucontext, which wasm32-wasi lacks");
  }
  const cc = ccFor(target);
  try {
    const { args, warning } = linkArgv(target, { ll, rt, actor, extra, out: outPath }, { static: opts.static });
    if (warning) console.error(`warning: ${warning}`);
    run(cc, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildObject(source: string, outPath: string, target: Target, entryPath?: string): Promise<void> {
  const { cc, flags } = toolchainFor(target);
  const { dir, ll } = writeIR(source, entryPath);
  try {
    run(cc, [...flags, "-c", ll, "-o", outPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
