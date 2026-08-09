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

import {
  mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, statSync,
  mkdirSync, renameSync, copyFileSync, linkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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

/*
 * Text scanning, spelled out — the same discipline as `src/lexer.ts`. nativets has no
 * `RegExp` (docs/divergences.md), so the compiler's own source may not use one; the
 * driver's toolchain probes and its conditional-link matching are string scans.
 * `test/no-regex.test.ts` pins each helper against the pattern it replaced — including
 * the conditional-link scans, whose failure mode is a runtime object silently missing
 * from the link line.
 */

/** `[A-Za-z0-9_]` — regex `\w`. Note it does NOT include `$`, so `\b` is exactly this. */
function isWordChar(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
}
/** ECMAScript `\s` — WhiteSpace + LineTerminator, by code unit. */
function isSpaceChar(c: string): boolean {
  const n = c.charCodeAt(0);
  if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32) return true;
  return (
    n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) ||
    n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f ||
    n === 0x3000 || n === 0xfeff
  );
}

/**
 * Index of the first `\bword\b` in `hay`, or -1 — `word` must start and end with word
 * characters (every caller's does), so the `\b`s reduce to "the neighbours are not `\w`".
 */
function wordIndex(hay: string, word: string): number {
  for (let i = 0; i + word.length <= hay.length; i++) {
    if (!hay.startsWith(word, i)) continue;
    const beforeOk = i === 0 || !isWordChar(hay[i - 1]!);
    const end = i + word.length;
    const afterOk = end === hay.length || !isWordChar(hay[end]!);
    if (beforeOk && afterOk) return i;
  }
  return -1;
}

/** `/\bword\b/.test(hay)`. */
function hasWord(hay: string, word: string): boolean { return wordIndex(hay, word) >= 0; }

/**
 * `/\bcall\b[^\n]*<prefix>/.test(ir)` for any of `prefixes` — does the IR CALL a runtime
 * symbol with one of these prefixes? Matched at the call site, never at the always-present
 * `declare` line, which is what makes each runtime object conditionally linked.
 *
 * `[^\n]*` cannot cross a line, so this is a per-line question; and a `call` later in a
 * line is followed by strictly less text than the first one, so only the first needs
 * checking.
 */
function irCallsAny(ir: string, prefixes: string[]): boolean {
  for (const line of ir.split("\n")) {
    const at = wordIndex(line, "call");
    if (at < 0) continue;
    const rest = line.slice(at + 4);
    for (const p of prefixes) if (rest.includes(p)) return true;
  }
  return false;
}

/**
 * `s.split(/\s+/)` for an ALREADY-TRIMMED, non-empty `s` — runs of whitespace separate
 * tokens and there are no empty entries. (On untrimmed input `split` would yield a leading
 * `""`; the one caller trims and checks non-empty first.)
 */
function splitWhitespace(s: string): string[] {
  // `[...out, tok]`, not `out.push(tok)`: arrays are immutable (Stage 29) and `.push` is
  // NT1606, so the push spelling would be a self-hosting blocker planted by the very lane
  // removing one. Token counts here are a handful of link flags.
  let out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpaceChar(s[i]!)) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isSpaceChar(s[i]!)) i++;
    out = [...out, s.slice(start, i)];
  }
  return out;
}

/** `^aarch64-linux-android\d+-clang$` — an NDK aarch64 clang, at any API level. */
function isAndroidClangName(f: string): boolean {
  const prefix = "aarch64-linux-android";
  const suffix = "-clang";
  if (!f.startsWith(prefix) || !f.endsWith(suffix)) return false;
  const api = f.slice(prefix.length, f.length - suffix.length);
  if (api.length === 0) return false; // `\d+` needs at least one digit
  for (let i = 0; i < api.length; i++) if (api[i]! < "0" || api[i]! > "9") return false;
  return true;
}

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
    // `hint` is carried through. Every NT16xx rule in the ownership pass builds one, and
    // dropping it here made all of them invisible — the pass said "hand out `c` itself
    // instead" and the CLI printed the bare refusal (test/ownership.test.ts).
    throw new NTError({ code: d.code, message: d.message, spans, hint: d.hint });
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
  const any = readdirSync(bin).filter((f) => isAndroidClangName(f)).sort();
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
  return r.status === 0 && hasWord(r.stdout ?? "", "wasm32");
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
    flags = splitWhitespace((pc.stdout as string).trim());
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

/* ============================================================
 * The build cache.
 *
 * Two caches share one key: a prebuilt runtime OBJECT (skips recompiling the 3,886-line
 * runtime.c on every build) and a content-addressed BINARY (skips the build entirely).
 * The binary cache is the large one, for a reason that is not about compilation at all:
 * macOS scans every newly-created Mach-O on its FIRST execution, and the scan result is
 * cached per FILE IDENTITY, not per content. Measured on this machine, with the suite
 * running: a fresh binary costs ~980ms to execute, the SAME file re-executed from a
 * later process costs ~2.2ms, and a byte-identical COPY at a fresh path costs ~750ms
 * again. So the cached artifact must be executed IN PLACE — copying it back to a
 * caller-chosen path would throw the entire win away.
 *
 * CORRECTNESS. A stale hit is a silent wrong answer, the worst outcome this project
 * recognises, so the key is one-directional by construction: everything that can change
 * the produced bytes is hashed, and anything unhashed must be incapable of changing
 * them. Over-invalidating costs a rebuild; under-invalidating costs correctness. When in
 * doubt this code hashes MORE.
 *
 * `NATIVETS_NO_CACHE=1` disables both caches, so a suspected cache bug can be ruled out
 * in one command.
 * ============================================================ */

/** Inputs that fully determine a build's output bytes. Every field is hashed. */
export interface BuildKeyInputs {
  /** The generated LLVM IR — covers the source AND the whole frontend that produced it. */
  ir: string;
  /** Text of every runtime .c/.h that this build links, so a runtime edit invalidates. */
  sources: string[];
  /** Every compile/link flag: target triple, sysroot, -static, feature defines, -l libs. */
  flags: string[];
  /** Identity of the C toolchain, so a clang upgrade does not serve objects it did not build. */
  cc: string;
}

/**
 * Hash a list of fields UNAMBIGUOUSLY. Length-prefixing is the load-bearing detail: with
 * a plain separator, `["ab","c"]` and `["a","bc"]` hash alike, and a separator byte can
 * legitimately occur inside IR text or a link flag. Prefixing each field with its length
 * makes the encoding injective, so distinct inputs cannot share a key by construction.
 */
function hashFields(fields: string[]): string {
  const h = createHash("sha256");
  h.update(`${fields.length}\n`);
  for (const f of fields) {
    h.update(`${f.length}\n`);
    h.update(f);
  }
  return h.digest("hex");
}

/** The cache key for a build. Distinct inputs give distinct keys (see `hashFields`). */
export function buildCacheKey(i: BuildKeyInputs): string {
  // The field list is itself length-prefixed, so a flag can never be confused for a
  // source and the section boundaries cannot drift.
  return hashFields([
    "nativets-build-cache-v1", // bump to invalidate every entry after a cache-format change
    i.ir,
    String(i.sources.length),
    ...i.sources,
    String(i.flags.length),
    ...i.flags,
    i.cc,
  ]);
}

/* ============================================================
 * Scratch-dir reaping.
 *
 * Every build and every harness run makes a `nativets-*` temp dir and removes it in a
 * `finally`. That `finally` cannot run when the process is KILLED, which is routine —
 * a ^C in the test loop, or an agent lane whose run is cancelled. The leak was measured
 * at 5,311 dirs (408 MB) in one TMPDIR, oldest five days.
 *
 * The safety argument is entirely the AGE THRESHOLD, because other builds are running
 * concurrently and deleting a live build's dir would break it in a way that looks like
 * a compiler bug. A build dir lives ~0.12s and a harness run dir ~1s, so a dir whose
 * mtime is hours old cannot belong to a live run — that is the "cannot show it is
 * stale, do not touch it" rule. We also require our own `nativets-` prefix, so a
 * foreign tool's scratch is never a candidate.
 * ============================================================ */

/** Default staleness cutoff: orders of magnitude beyond any real build (~0.12s) or run (~1s). */
const SCRATCH_MAX_AGE_MS = 6 * 3600_000;
/** Cap per process, so the first run after a large leak drains a slice instead of stalling. */
const SCRATCH_REAP_LIMIT = 400;

/** Default age bound for cached artifacts. Evicting one costs a rebuild, never a wrong answer. */
const CACHE_MAX_AGE_MS = 14 * 24 * 3600_000;
const CACHE_REAP_LIMIT = 2000;

/**
 * One age-based sweep, shared by both reapers: remove entries of `dir` that `keep`
 * selects, that are of the wanted kind, and whose mtime is older than `maxAge` — at most
 * `limit` of them. Never throws; a reaping failure must not fail a build.
 */
function sweep(
  dir: string, want: "dir" | "file", keep: (name: string) => boolean,
  maxAge: number, limit: number, now: number,
): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (removed >= limit) break;
    if (!keep(name)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if ((want === "dir") !== st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAge) continue; // too young to prove stale. Hands off.
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* vanished, or not ours to remove — either way, nothing to do */ }
  }
  return removed;
}

/**
 * Best-effort removal of abandoned `nativets-*` scratch dirs. Returns how many were
 * removed.
 */
export function reapStaleScratchDirs(
  opts: { dir?: string; maxAgeMs?: number; limit?: number; now?: number } = {},
): number {
  return sweep(
    opts.dir ?? tmpdir(),
    "dir",
    // Ours only. The trailing `-` matters: it keeps a file or dir literally named
    // `nativets` (say, the `bun run compile` output) out of the candidate set.
    (name) => name.startsWith("nativets-"),
    opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS,
    opts.limit ?? SCRATCH_REAP_LIMIT,
    opts.now ?? Date.now(),
  );
}

/**
 * Age out cached artifacts, so the cache cannot become the disk leak it was built to
 * replace. Entry mtimes are creation times (a hardlink does not touch them), so this is
 * "built more than `maxAgeMs` ago", not "unused" — a coarser rule than LRU, and the
 * right one here because the penalty for evicting a live entry is only a rebuild.
 */
export function reapStaleCacheEntries(
  opts: { dir?: string; maxAgeMs?: number; limit?: number; now?: number } = {},
): number {
  const root = opts.dir ?? cacheRoot();
  if (!root) return 0;
  const maxAge = opts.maxAgeMs ?? CACHE_MAX_AGE_MS;
  const limit = opts.limit ?? CACHE_REAP_LIMIT;
  const now = opts.now ?? Date.now();
  let removed = 0;
  for (const kind of ["bin", "obj"]) {
    removed += sweep(join(root, kind), "file", () => true, maxAge, limit - removed, now);
  }
  return removed;
}

/** Reap once per process, lazily, off the first build. Cheap (a readdir) and never fatal. */
let reaped = false;
function reapOnce(): void {
  if (reaped) return;
  reaped = true;
  try { reapStaleScratchDirs(); } catch { /* best effort, always */ }
  try { reapStaleCacheEntries(); } catch { /* best effort, always */ }
}

/* ------------------------------------------------------------
 * The link plan.
 *
 * Which runtime units and flags a program needs is decided from the IR ALONE, with no
 * disk access — that is what lets the cache key be computed before any work happens.
 * The conditional-link decisions below are exactly the ones that used to live inline in
 * `writeIR`; only the place they put their answers changed. Each still matches the CALL
 * site rather than the always-present `declare` line, which is what keeps a runtime
 * object out of a binary that does not use it.
 * ------------------------------------------------------------ */

/** One runtime translation unit or header: its filename in the build dir, and its text. */
interface RuntimeUnit { name: string; text: string }

interface LinkPlan {
  /** `.c` files to compile and link, in link order (runtime.c first, actor last). */
  units: RuntimeUnit[];
  /** `.h` files written alongside so the units' quote-includes resolve. Never on a command line. */
  headers: RuntimeUnit[];
  /** COMPILE-time defines. They change how the units compile, so they belong to an object's key. */
  defines: string[];
  /** LINK-time library flags. Appended after all objects, which satisfies GNU ld's ordering rule. */
  libs: string[];
  /** Whether the actor runtime is in the plan — the wasm gate needs this before building. */
  actor: boolean;
}

/** Decide the runtime units + flags for a program, from its IR. Pure apart from `raylibLinkFlags`. */
function planLink(ir: string): LinkPlan {
  const units: RuntimeUnit[] = [{ name: "runtime.c", text: runtimeSource }];
  const headers: RuntimeUnit[] = [];
  const defines: string[] = [];
  const libs: string[] = [];

  // B2 Map/Set: link the HAMT core + scalar-ABI wrappers only when used (codegen
  // emits nt_map_new/nt_set_new exactly then). libc-only, so it cross-links unchanged.
  // Match the CALL site, not the (always-present) `declare` line — collections are
  // reached through the nt_coll_*/nt_map_*_slot/nt_set_*_slot wrappers.
  if (irCallsAny(ir, ["@nt_coll_", "@nt_map_", "@nt_set_"])) {
    headers.push({ name: "nt_hamt.h", text: hamtHeader }); // quote-included by both .c files
    units.push({ name: "nt_hamt.c", text: hamtSource }, { name: "nt_mapset.c", text: mapsetSource });
  }
  // Persistent vector (B2 step 2): link nt_pvec.c + define NT_PVEC ONLY when the program
  // actually uses arrays — matched at a CALL site (`call … @nt_arr_*`), never the
  // always-present `declare`, exactly like the bytes/curl/gui lanes.
  if (irCallsAny(ir, ["@nt_arr_"])) {
    headers.push({ name: "nt_pvec.h", text: pvecHeader }); // quote-included by runtime.c + the .c
    units.push({ name: "nt_pvec.c", text: pvecSource });
    defines.push("-DNT_PVEC");
  }
  // Bytes (stdlib batch 2): link nt_bytes.c ONLY when a program uses Uint8Array /
  // TextEncoder / TextDecoder (codegen emits `call … @nt_bytes_*` exactly then).
  // libc-only, so it cross-links to every target unchanged.
  if (irCallsAny(ir, ["@nt_bytes_"])) {
    headers.push({ name: "nt_bytes.h", text: bytesHeader }); // quote-included by the .c
    units.push({ name: "nt_bytes.c", text: bytesSource });
  }
  // HTTP client (L-d): link nt_http.c + libcurl ONLY when a program calls httpGet/httpPost.
  // Host/Linux only — libcurl is present on macOS/Linux CI; the conditional link keeps every
  // other build (incl. the iOS/Android cross-builds) free of the curl dependency.
  // Match the CALL site, not the (always-present) `declare` line, so nt_http.c + libcurl
  // are pulled in ONLY when the program actually calls the builtin.
  // `fetch` lives in the same file, so its call site pulls in the same object + libcurl.
  if (ir.includes("call ptr @nt_http_post(") || ir.includes("call ptr @nt_http_get(") || ir.includes("call ptr @nt_fetch(")) {
    units.push({ name: "nt_http.c", text: httpSource });
    libs.push("-lcurl");
  }
  // GUI (north-star C-d): link nt_gui.c + raylib (+ macOS frameworks) ONLY when the program
  // actually CALLS a GUI builtin — matched at the call site (`call … @nt_gui_*`), never the
  // always-present `declare`, exactly like the curl lane. `raylibLinkFlags()` locates raylib
  // (pkg-config / Homebrew / /usr/local / /opt) or throws a clear BuildError. HOST-DESKTOP
  // ONLY: GUI programs are not cross-built (iOS/Android/wasm need platform UI bindings), so
  // non-GUI programs and every cross-build stay entirely raylib-free.
  if (irCallsAny(ir, ["@nt_gui_"])) {
    units.push({ name: "nt_gui.c", text: guiSource });
    // In the key as well as the link line: which raylib we linked is part of the artifact.
    libs.push(...raylibLinkFlags());
  }
  // Link the v0 actor runtime ONLY when the program uses actors (codegen emits the
  // nt_sched_init prologue exactly then). It relies on ucontext (makecontext/
  // swapcontext), which the Android NDK's Bionic does not declare at low API levels,
  // so pulling it into every non-actor binary would break the Android cross-build.
  const actor = ir.includes("call void @nt_sched_init()");
  if (actor) {
    headers.push({ name: "nt_actor.h", text: actorHeader }); // its header (quote-included)
    units.push({ name: "nt_actor.c", text: actorSource });
  }
  return { units, headers, defines, libs, actor };
}

/** Write the IR and a plan's sources into a fresh scratch dir. The disk half of `planLink`. */
function materialize(ir: string, plan: LinkPlan): { dir: string; ll: string; sources: string[] } {
  reapOnce();
  const dir = mkdtempSync(join(tmpdir(), "nativets-build-"));
  const ll = join(dir, "module.ll");
  writeFileSync(ll, ir);
  for (const h of plan.headers) writeFileSync(join(dir, h.name), h.text);
  const sources = plan.units.map((u) => {
    const p = join(dir, u.name);
    writeFileSync(p, u.text); // embedded runtime → self-contained executable
    return p;
  });
  return { dir, ll, sources };
}

function writeIR(source: string, entryPath?: string): { dir: string; ll: string } {
  const ir = sourceToIR(source, entryPath);
  return materialize(ir, planLink(ir));
}

function run(cc: string, args: string[]): void {
  const r = spawnSync(cc, args, { encoding: "utf8" });
  if (r.status !== 0) throw new BuildError(`${cc} failed (${r.status}):\n${r.stderr}`);
}

/* ------------------------------------------------------------
 * Cache storage.
 * ------------------------------------------------------------ */

/** The cache root, or `null` when caching is off. Read per call so a test can toggle it. */
function cacheRoot(): string | null {
  if (process.env.NATIVETS_NO_CACHE === "1") return null;
  const explicit = process.env.NATIVETS_CACHE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.length ? xdg : join(homedir(), ".cache"), "nativets");
}

let cacheHits = 0;
let cacheMisses = 0;
/** Cache hit/miss counters for this process. Lets a test assert a hit WITHOUT timing it. */
export function buildCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/**
 * Identity of a C toolchain: its path plus its own `--version` banner. In the key so a
 * clang upgrade cannot serve artifacts the old clang produced. Memoized per process —
 * it is a subprocess, and a cache hit must not pay for one per build.
 */
const ccIdentityCache = new Map<string, string>();
function ccIdentity(cc: string): string {
  const memo = ccIdentityCache.get(cc);
  if (memo !== undefined) return memo;
  const r = spawnSync(cc, ["--version"], { encoding: "utf8" });
  // A failed probe hashes as "unknown" for THIS cc string. That is safe: it is a
  // constant, so it can only ever over-share within one unidentifiable compiler, and
  // the compiler itself would fail the build a moment later anyway.
  const id = r.status === 0 ? `${cc}\n${r.stdout ?? ""}` : `${cc}\nunknown`;
  ccIdentityCache.set(cc, id);
  return id;
}

/**
 * Publish `src` into the cache at `key` atomically: link to a unique temp name in the
 * same directory, then rename over. Never throws — a cache that cannot be written must
 * degrade to no cache, not to a failed build.
 *
 * If an entry already exists we KEEP it rather than replacing it. The bytes are equal by
 * construction (same key), and the existing inode may already carry a system scan verdict
 * that replacing it would throw away.
 */
function cacheStore(root: string, kind: string, key: string, src: string): void {
  try {
    const dir = join(root, kind);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, key);
    if (existsSync(dest)) return;
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    // Hardlink rather than copy: same inode, so the cache entry and the build output
    // share the system's scan verdict instead of each paying for it.
    try { linkSync(src, tmp); } catch { copyFileSync(src, tmp); }
    try { renameSync(tmp, dest); } catch { rmSync(tmp, { force: true }); }
  } catch { /* cache is an optimisation; never fail a build for it */ }
}

/**
 * Materialise cache entry `key` at `outPath`. Returns false on any miss or doubt, so the
 * caller falls back to a real build — a miss is always safe, a false hit never is.
 *
 * HARDLINK, not copy. macOS caches its malware-scan verdict per INODE, so a hardlink to
 * an already-executed artifact runs in ~2ms while a byte-identical copy pays the full
 * ~1s scan again. That single fact is why this cache is worth having, so the copy path
 * below is a correctness fallback for a cross-device cache, not an equivalent choice.
 */
function cacheFetch(root: string, kind: string, key: string, outPath: string): boolean {
  try {
    const src = join(root, kind, key);
    // Confirm the entry is really there and non-empty rather than trusting an mtime: a
    // truncated artifact from a killed run must read as a miss.
    const st = statSync(src);
    if (!st.isFile() || st.size === 0) return false;
    rmSync(outPath, { force: true }); // linkSync will not overwrite
    try { linkSync(src, outPath); } catch { copyFileSync(src, outPath); }
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile one runtime unit to a cached object. The object's key covers its own text, every
 * header written beside it, the compile-time defines and target flags, and the compiler
 * identity — so a runtime `.c` edit (or a `-DNT_PVEC` flip, or a cross target) rebuilds it.
 * Returns the object path, or `null` to fall back to compiling the `.c` in the link step.
 */
function runtimeObject(
  root: string, unit: RuntimeUnit, plan: LinkPlan, cflags: string[], cc: string, srcPath: string, dir: string,
): string | null {
  const key = buildCacheKey({
    ir: `unit:${unit.name}`, // no IR involved: an object depends only on C inputs
    sources: [unit.text, ...plan.headers.map((h) => `${h.name}\n${h.text}`)],
    flags: cflags,
    cc: ccIdentity(cc),
  });
  const objDir = join(root, "obj");
  const dest = join(objDir, key);
  try {
    const st = statSync(dest);
    if (st.isFile() && st.size > 0) return dest;
  } catch { /* miss */ }
  const built = join(dir, `${unit.name}.o`);
  try {
    run(cc, [...cflags, "-c", srcPath, "-o", built]);
  } catch {
    return null; // let the ordinary link surface the real compiler error
  }
  cacheStore(root, "obj", key, built);
  return built;
}

export async function buildBinary(source: string, outPath: string, opts: BuildOpts = {}): Promise<void> {
  const target = opts.target ?? "host";
  const ir = sourceToIR(source, opts.entryPath);
  const plan = planLink(ir);
  // Actors need the ucontext-based cooperative scheduler (nt_actor.c); wasm32-wasi has no
  // ucontext, so gate here with a clear error instead of a cryptic link failure. Ordinary
  // (non-actor) programs link fine — the actor runtime is only pulled in when used.
  if (target === "wasm" && plan.actor) {
    throw new BuildError("the wasm (WASI) target does not support actors (spawn/send/receive): the actor runtime needs ucontext, which wasm32-wasi lacks");
  }
  const cc = ccFor(target);
  const { flags: staticFlags, warning } = resolveStatic(target, opts.static ?? false);
  // Before the cache lookup, not after: the `--static` fallback warning is part of what a
  // build TELLS you, so a cache hit must not silence it.
  if (warning) console.error(`warning: ${warning}`);
  const tflags = targetFlags(target);

  /*
   * The binary key. Every input that can change the produced bytes is here: the IR (which
   * subsumes the source AND the entire frontend that lowered it), the text of every runtime
   * unit and header linked in, every compile/link flag, and the compiler's identity. The
   * conditional-link SET is itself a pure function of the IR, so it needs no separate entry.
   *
   * Keying on the IR rather than the source is what makes this survive active compiler
   * development: a codegen edit changes the IR of the programs it affects and only those,
   * so the cache stays warm everywhere behaviour did not move.
   */
  const root = cacheRoot();
  const key = buildCacheKey({
    ir,
    sources: [
      ...plan.units.map((u) => `${u.name}\n${u.text}`),
      ...plan.headers.map((h) => `${h.name}\n${h.text}`),
    ],
    flags: [...tflags, ...staticFlags, ...plan.defines, ...plan.libs, target],
    cc: ccIdentity(cc),
  });
  if (root && cacheFetch(root, "bin", key, outPath)) {
    cacheHits++;
    return;
  }
  if (root) cacheMisses++;

  const { dir, ll, sources } = materialize(ir, plan);
  try {
    // Win 1: compile each runtime unit ONCE and reuse the object. runtime.c alone is 3,886
    // lines recompiled on every build today; the objects are keyed and invalidated exactly
    // like the binaries, so a runtime edit rebuilds them.
    const cflags = [...tflags, ...plan.defines];
    const objects = root
      ? sources.map((p, i) => runtimeObject(root, plan.units[i]!, plan, cflags, cc, p, dir) ?? p)
      : sources;
    // Defines still ride the link line when we fell back to compiling `.c` sources there.
    const compiledFromSource = objects.some((o) => o.endsWith(".c"));
    const extra = [...objects.slice(1), ...(compiledFromSource ? plan.defines : []), ...plan.libs];
    const { args } = linkArgv(target, { ll, rt: objects[0]!, actor: null, extra, out: outPath }, { static: opts.static });
    run(cc, args);
    if (root) cacheStore(root, "bin", key, outPath);
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
