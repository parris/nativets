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

import {
  mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync,
  mkdirSync, renameSync, linkSync, copyFileSync, statSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { sourceToIR, buildBinary, buildObject, type Target } from "../src/driver.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `nativets-${prefix}-`));
}

/* ============================================================
 * THE BUILD CACHE.
 *
 * It lives here, in the harness, and NOT in `src/driver.ts` — deliberately. The compiler's
 * own source must stay inside the subset it can compile (docs/self-hosting.md), and a cache
 * needs `node:crypto` plus `mkdirSync`/`renameSync`/`statSync`/`linkSync`, none of which are
 * in the host FFI (`HOST_FUNCS`, src/checker.ts). An earlier draft put it in the driver and
 * moved `driver.ts`'s blocker from NT2001-inherited to NT1028-itself, reddening the
 * self-hosting ratchet. `test/` is outside that surface, so here the imports are free.
 *
 * WHAT IT IS ACTUALLY DODGING — not compilation. macOS scans every newly-created Mach-O on
 * its FIRST execution, and caches the verdict per INODE. Measured on this machine:
 *
 *     build a binary                        148 ms
 *     first execution of a fresh binary    2049 ms
 *     the same file, re-executed              2.1 ms
 *     a HARDLINK to it, at a new path         2.1 ms
 *     a byte-identical COPY, new path      2100 ms
 *
 * So the cached artifact is HARDLINKED to the scratch path we then execute. A copy would
 * pay the scan again and win nothing — the hardlink is the whole mechanism, not an
 * optimisation detail. Per compiled-and-run test: 2197 ms -> 87 ms.
 *
 * WHY A FALSE HIT IS IMPOSSIBLE. A stale artifact would be a silent wrong answer, which
 * this project ranks as the worst outcome available, so the key is one-directional: a MISS
 * is always safe, therefore everything that can change the produced bytes is hashed, and
 * when in doubt we hash MORE.
 *
 *   - the generated IR, not the .ts source. That is what makes the cache survive active
 *     compiler development: a codegen edit changes the IR of the programs it affects and
 *     only those, so the cache stays warm exactly where behaviour did not move.
 *   - EVERY file in runtime/, DISCOVERED by readdir rather than listed. A hardcoded list
 *     would silently fail to invalidate when a lane adds a new runtime .c — the cache would
 *     then serve binaries built against the old runtime. Discovery also over-invalidates
 *     (editing nt_gui.c rebuilds everything), which is the safe direction.
 *   - the target, and the C toolchain's own `--version`.
 *
 * `NATIVETS_NO_CACHE=1` disables it entirely, so a suspected cache bug can be ruled out in
 * one command rather than by argument.
 * ============================================================ */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(HERE, "..", "runtime");

/** The cache root, or `null` when caching is off. Read per call so a test can toggle it. */
function cacheRoot(): string | null {
  if (process.env.NATIVETS_NO_CACHE === "1") return null;
  const explicit = process.env.NATIVETS_CACHE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.length ? xdg : join(process.env.HOME ?? tmpdir(), ".cache"), "nativets");
}

/**
 * Hash a list of fields UNAMBIGUOUSLY. Length-prefixing is the load-bearing detail: under
 * plain concatenation `["ab","c"]` and `["a","bc"]` hash alike, and a separator byte can
 * legitimately occur inside IR text. Prefixing each field with its length makes the
 * encoding injective, so two different builds cannot collide onto one key by construction.
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

/** Digest of the WHOLE runtime tree, discovered. Memoized: the files cannot change mid-run. */
let runtimeDigestMemo: string | null = null;
function runtimeDigest(): string {
  if (runtimeDigestMemo !== null) return runtimeDigestMemo;
  const names = readdirSync(RUNTIME_DIR).sort(); // sorted: a stable key across filesystems
  const parts: string[] = [];
  for (const n of names) parts.push(n, readFileSync(join(RUNTIME_DIR, n), "utf8"));
  if (!names.length) throw new Error("runtime/ is empty — the cache key would not cover the runtime");
  runtimeDigestMemo = hashFields(parts);
  return runtimeDigestMemo;
}

/** Identity of the C toolchain, so a clang upgrade cannot serve artifacts the old one built. */
let ccIdentityMemo: string | null = null;
function ccIdentity(): string {
  if (ccIdentityMemo !== null) return ccIdentityMemo;
  const r = spawnSync("clang", ["--version"], { encoding: "utf8" });
  ccIdentityMemo = r.status === 0 ? (r.stdout ?? "") : "unknown";
  return ccIdentityMemo;
}

let cacheHits = 0;
let cacheMisses = 0;
/** Hit/miss counters, so a test can assert a cache hit WITHOUT timing it. */
export function buildCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/** The key for one artifact. `kind` separates binaries from cross-compiled objects. */
function cacheKey(kind: string, ir: string, target: Target): string {
  return hashFields(["nativets-harness-cache-v1", kind, ir, runtimeDigest(), target, ccIdentity()]);
}

/**
 * Materialise entry `key` at `dest`. Returns false on any miss OR ANY DOUBT, so the caller
 * falls back to a real build — a miss is always safe, a false hit never is.
 *
 * HARDLINK, not copy: see the measurements above. The copy path is a correctness fallback
 * for a cache on another filesystem, not an equivalent choice.
 */
function cacheFetch(root: string, key: string, dest: string): boolean {
  try {
    const src = join(root, key);
    // Confirm the entry is really present and non-empty rather than trusting an mtime: a
    // truncated artifact left by a killed run must read as a MISS.
    const st = statSync(src);
    if (!st.isFile() || st.size === 0) return false;
    rmSync(dest, { force: true }); // linkSync will not overwrite
    try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish `src` into the cache at `key`, atomically: link to a unique temp name in the same
 * directory, then rename over it. Eight lanes build concurrently, so a half-written file
 * must never be visible at the final path — rename is what guarantees that.
 *
 * An existing entry is KEPT rather than replaced: the bytes are equal by construction, and
 * the existing inode may already carry a scan verdict that replacing it would discard.
 * Never throws — a cache that cannot be written degrades to no cache, not to a failed build.
 */
function cacheStore(root: string, key: string, src: string): void {
  try {
    mkdirSync(root, { recursive: true });
    const dest = join(root, key);
    if (existsSync(dest)) return;
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try { linkSync(src, tmp); } catch { copyFileSync(src, tmp); }
    try { renameSync(tmp, dest); } catch { rmSync(tmp, { force: true }); }
  } catch { /* an optimisation; never fail a test for it */ }
}

/**
 * Build `source` to `dest`, reusing a cached artifact when the key matches.
 *
 * The IR is computed here so the key can be known before any work happens; on a miss
 * `buildBinary` recomputes it, which costs ~0.6 ms and keeps the driver's public API
 * untouched. A refusal throws out of `sourceToIR` exactly as it would have from
 * `buildBinary`, so tests asserting a refusal are unaffected.
 */
async function cachedBuildBinary(source: string, dest: string, entryPath?: string): Promise<void> {
  reapOnce();
  const root = cacheRoot();
  if (!root) { await buildBinary(source, dest, { target: "host", entryPath }); return; }
  const key = cacheKey("bin-host", sourceToIR(source, entryPath), "host");
  if (cacheFetch(root, key, dest)) { cacheHits++; return; }
  cacheMisses++;
  await buildBinary(source, dest, { target: "host", entryPath });
  cacheStore(root, key, dest);
}

/* ------------------------------------------------------------
 * Scratch-dir reaping.
 *
 * Every build and every harness run makes a `nativets-*` temp dir and removes it in a
 * `finally`. That `finally` cannot run when the process is KILLED, which is routine — a ^C
 * in the test loop, or an agent lane whose run is cancelled. Thousands of abandoned dirs
 * had accumulated in one TMPDIR.
 *
 * The safety argument is entirely the AGE THRESHOLD, because other lanes are building
 * concurrently and deleting a live build's dir would look exactly like a compiler bug. A
 * build dir lives ~0.12 s and a run dir ~1 s, so a dir untouched for hours cannot belong to
 * a live run. We also require our own `nativets-` prefix, so no foreign scratch is ever a
 * candidate. Cleanup therefore LAGS by design, and that is the correct trade.
 * ------------------------------------------------------------ */

const SCRATCH_MAX_AGE_MS = 6 * 3600_000;
const SCRATCH_REAP_LIMIT = 400; // bounded, so the first run after a big leak cannot stall
const CACHE_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Remove abandoned scratch dirs / stale cache entries older than `maxAgeMs`. Never throws. */
export function reapStale(
  opts: { dir?: string; maxAgeMs?: number; limit?: number; now?: number; kind?: "dir" | "file"; prefix?: string } = {},
): number {
  const dir = opts.dir ?? tmpdir();
  const maxAge = opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const limit = opts.limit ?? SCRATCH_REAP_LIMIT;
  const now = opts.now ?? Date.now();
  const wantDir = (opts.kind ?? "dir") === "dir";
  // The trailing `-` matters: it keeps a file or dir literally named `nativets` (the
  // `bun run compile` output) out of the candidate set.
  const prefix = opts.prefix ?? "nativets-";
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (removed >= limit) break;
    if (!name.startsWith(prefix)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (wantDir !== st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAge) continue; // too young to PROVE stale. Hands off.
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* vanished, or not ours to remove — either way, nothing to do */ }
  }
  return removed;
}

/** Reap once per process, lazily. Cheap (a readdir) and never fatal. */
let reaped = false;
function reapOnce(): void {
  if (reaped) return;
  reaped = true;
  try { reapStale(); } catch { /* best effort, always */ }
  // Age out cached artifacts too, so the cache cannot become the leak it replaced.
  // Evicting a live entry costs a rebuild, never a wrong answer, so a plain age rule is enough.
  try {
    const root = cacheRoot();
    if (root) reapStale({ dir: root, kind: "file", prefix: "", maxAgeMs: CACHE_MAX_AGE_MS, limit: 2000 });
  } catch { /* best effort, always */ }
}

/**
 * Every compiled program we RUN is bounded. A test program that spins — a scheduler
 * bug, a probe loop over a corrupted table, a deadlock — otherwise hangs the whole
 * suite, and worse: when the parent is killed the child survives, so an orphan sits
 * at 100% CPU indefinitely. That happened (an actors-v4 binary found at 99% CPU after
 * 87 minutes, long after its run had been abandoned), and it degrades every other
 * test sharing the machine. SIGKILL because a spinning program may not honor SIGTERM.
 *
 * Generous on purpose: this bounds the RUN only (the build is separate), so no honest
 * fixture comes close. A timeout here should be read as "the program hung", not "the
 * machine was busy".
 */
export const RUN_TIMEOUT_MS = 60_000;
const BOUNDED = { timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL" } as const;

/** Lower source to LLVM IR text. Pure; no toolchain invoked. */
export function emitIR(source: string): string {
  return sourceToIR(source);
}

/**
 * Emit IR for a build that is about to pass `-fsanitize=address`.
 *
 * USE THIS, NOT `emitIR`, ANYWHERE THE RESULT IS COMPILED UNDER ASAN. AddressSanitizer is
 * an LLVM pass that only rewrites functions carrying the `sanitize_address` attribute, and
 * clang stamps that attribute on code it compiles from SOURCE — so a plain `emitIR` build
 * instruments `runtime/*.c` and not one instruction nativets generated. The result is a gate
 * that catches a double free (detected inside `free()`, which does not care who called it)
 * but is BLIND to a heap-use-after-free, because that needs a poison check on the read and
 * the read is in uninstrumented code. A stale read returning garbage at exit 0 is the
 * silent-wrong-answer class, and it was the one fault the sanitizer lane could not see.
 *
 * See src/codegen.ts (`asanOn`) and test/asan-instrumentation.test.ts.
 */
export function emitIRAsan(source: string): string {
  const prev = process.env["NATIVETS_ASAN"];
  process.env["NATIVETS_ASAN"] = "1";
  try {
    return sourceToIR(source);
  } finally {
    if (prev === undefined) delete process.env["NATIVETS_ASAN"];
    else process.env["NATIVETS_ASAN"] = prev;
  }
}

/** Compile `source` to a host binary and run it. */
export async function compileAndRun(source: string): Promise<RunResult> {
  const dir = scratch("run");
  try {
    const bin = join(dir, "prog");
    await cachedBuildBinary(source, bin);
    const proc = spawnSync(bin, [], { encoding: "utf8", ...BOUNDED });
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

/* ============================================================
 * Modules (SH1) — a multi-module program cannot be a single `source` string: the
 * entry file's PATH is what `import "./util.ts"` resolves against. These two run the
 * same entry file through node and through nativets, so the differential oracle is
 * unchanged (node resolves `./x.ts` imports natively).
 * ============================================================ */

/** Compile a multi-module entry FILE to a host binary and run it. */
export async function compileAndRunFile(entryPath: string, args: string[] = []): Promise<RunResult> {
  const dir = scratch("run-mod");
  try {
    const bin = join(dir, "prog");
    await cachedBuildBinary(readFileSync(entryPath, "utf8"), bin, entryPath);
    const proc = spawnSync(bin, args, { encoding: "utf8", ...BOUNDED });
    return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The oracle for a multi-module program: `node entry.ts` in its own directory. */
export function runWithNodeFile(entryPath: string, args: string[] = []): RunResult {
  const proc = spawnSync("node", [entryPath, ...args], { encoding: "utf8" });
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 };
}

/** Cross-compile to an object file and return `file`'s description of its arch. */
export async function crossObjectArch(source: string, target: Target): Promise<string> {
  const dir = scratch("cross");
  try {
    const obj = join(dir, "out.o");
    // Cached on the SAME key shape as a binary but with the target and a distinct kind, so
    // an object for `ios` can never be handed to an `android` build.
    reapOnce();
    const root = cacheRoot();
    if (!root) {
      await buildObject(source, obj, target);
    } else {
      const key = cacheKey("obj", sourceToIR(source), target);
      if (cacheFetch(root, key, obj)) {
        cacheHits++;
      } else {
        cacheMisses++;
        await buildObject(source, obj, target);
        cacheStore(root, key, obj);
      }
    }
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
  // readKey: next single char from the shared cursor ("" at EOF), mirroring the
  // runtime's non-tty degrade path (one byte at a time). rawMode is a no-op for
  // piped stdin (not a tty), matching the runtime.
  "  globalThis.readKey = function () {",
  "    __load();",
  '    if (__pos >= __buf.length) return "";',
  "    const r = __buf.slice(__pos, __pos + 1); __pos += 1; return r;",
  "  };",
  "  globalThis.rawMode = function () {};",
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

/* ============================================================
 * stdlib: URL — no harness of its own any more.
 *
 * A `URL_POLYFILL` oracle used to live here: before classes existed the WHATWG
 * URL API was exposed as functional builtins (`urlProtocol(u)`, …), which node
 * does not have, so the ORACLE run got a prelude defining them in terms of
 * `new URL(...)`. stdlib Batch 3 made `new URL(u)` a real class, so a URL fixture
 * is now ordinary TypeScript and `runWithNode` is the oracle DIRECTLY.
 * ============================================================ */

/* ============================================================
 * Decorators — differential harness. `@@name` is a nativets COMPILE-TIME attribute
 * (`#[derive]`-shaped), which is not valid TypeScript, so node cannot parse it. But an
 * `@@mutable` class IS exactly a plain TS class (node's classes are mutable), so the
 * oracle is the same source with the attribute lines mechanically stripped — the same
 * "polyfill the oracle" trick as URL_POLYFILL above.
 *
 * Runtime `@wrapper` decorators are NOT stripped here: their node oracle is the
 * hand-written explicit wrapper application (see test/decorators.test.ts), because
 * node's own decorator semantics differ from ours (see docs/decorators.md).
 * ============================================================ */

/** Strip `@@attribute` lines — the mechanical desugaring that makes node the oracle. */
export function stripAttributes(source: string): string {
  return source
    .split("\n")
    .filter((l) => !/^\s*@@[A-Za-z_$][A-Za-z0-9_$]*\s*$/.test(l))
    .join("\n");
}

/** The oracle for an `@@attribute` fixture: node on the attribute-stripped source. */
export function runWithNodeAttrs(source: string): RunResult {
  return runWithNode(stripAttributes(source));
}

/** Compile a Host-I/O fixture and run the binary with the same argv/stdin/env. */
export async function compileAndRunIO(source: string, io: IOInput = {}): Promise<RunResult> {
  const dir = scratch("run-io");
  try {
    const bin = join(dir, "prog");
    await cachedBuildBinary(source, bin);
    const proc = spawnSync(bin, io.args ?? [], {
      encoding: "utf8",
      input: io.stdin ?? "",
      env: { ...process.env, ...(io.env ?? {}) },
      ...BOUNDED,
    });
    return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
