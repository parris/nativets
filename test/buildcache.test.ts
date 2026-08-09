/*
 * BUILD PERFORMANCE — the harness build cache, scratch-dir reaping, and the invariant that
 * a failed build leaves nothing behind.
 *
 * The cache lives in `test/harness.ts`, not in `src/driver.ts`, and that placement is a
 * correctness decision rather than a tidiness one: the compiler's own source must stay
 * inside the subset it can compile, and a cache needs `node:crypto` plus
 * `mkdirSync`/`renameSync`/`statSync`/`linkSync`, none of which are in the host FFI. An
 * earlier draft put it in the driver and moved `driver.ts`'s blocker from NT2001-inherited
 * to NT1028-itself, reddening `test/selfhost-ratchet.test.ts`. See that file's header for
 * why a blocker planted by an unrelated lane is the exact hazard it exists to catch.
 *
 * Nothing here may change what a program PRINTS, so every test is about artifact identity
 * and key safety. The key rule is one-directional: a MISS is always safe, so every input
 * that can change the produced bytes must change the key. Over-invalidation costs a
 * rebuild; under-invalidation costs correctness.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary, raylibAvailable, wasmToolchainAvailable } from "../src/driver.ts";
import { compileAndRun, buildCacheStats, reapStale } from "./harness.ts";

/*
 * These tests build and then EXECUTE brand-new binaries, and a first execution is exactly
 * the ~1-2 s system scan the cache exists to avoid — so they cost seconds by construction.
 * The explicit timeout matters because bun's default is 5 s: `bun test` picks up
 * `--timeout 60000` from package.json, but the per-file loop CLAUDE.md documents
 * (`bun test test/foo.test.ts`) does not, and a test that only passes when invoked one
 * particular way is a trap for the next reader.
 */
const SLOW = 60_000;

describe("harness build cache", () => {
  const uniq = () => `console.log("cache-probe ${Math.random()}");\n`;

  test("a repeat build HITS, and the hit behaves exactly like the miss", async () => {
    const source = uniq();
    const before = buildCacheStats();

    const a = await compileAndRun(source);
    const afterMiss = buildCacheStats();
    expect(afterMiss.misses).toBe(before.misses + 1);
    expect(afterMiss.hits).toBe(before.hits);

    const b = await compileAndRun(source);
    const afterHit = buildCacheStats();
    expect(afterHit.hits).toBe(before.hits + 1);
    expect(afterHit.misses).toBe(afterMiss.misses); // no second compile

    // The property that actually matters: a hit is INDISTINGUISHABLE from a miss.
    expect(b.stdout).toBe(a.stdout);
    expect(b.exitCode).toBe(a.exitCode);
    expect(a.stdout).toContain("cache-probe");
  }, SLOW);

  test("a DIFFERENT program misses (the key is not accidentally constant)", async () => {
    const a = await compileAndRun(uniq());
    const mid = buildCacheStats();
    const b = await compileAndRun(uniq());
    expect(buildCacheStats().misses).toBe(mid.misses + 1);
    expect(a.stdout).not.toBe(b.stdout);
  }, SLOW);

  /*
   * Keying on the generated IR rather than the source text is what lets the cache survive
   * active compiler development. Two sources that differ only in whitespace and comments
   * lower to the SAME IR, so the second must hit — if this ever misses, the key has drifted
   * back to being source-shaped and the cache will go cold on every unrelated edit.
   */
  test("keys on the IR, not the source text", async () => {
    const tag = Math.random();
    const plain = `console.log("ir-key ${tag}");\n`;
    const dressed = `// a comment that cannot reach the IR\n\nconsole.log("ir-key ${tag}");\n`;
    await compileAndRun(plain);
    const mid = buildCacheStats();
    const out = await compileAndRun(dressed);
    expect(buildCacheStats().hits).toBe(mid.hits + 1);
    expect(out.stdout).toContain(`ir-key ${tag}`);
  }, SLOW);

  /*
   * The explicit bypass. It exists so a suspected cache bug can be ruled out in ONE command
   * (`NATIVETS_NO_CACHE=1 bun test …`) — and it is tested, because an escape hatch nobody
   * exercises is one that has quietly stopped working by the time you need it.
   */
  test("NATIVETS_NO_CACHE=1 bypasses the cache entirely", async () => {
    const source = uniq();
    const a = await compileAndRun(source); // populate

    const prev = process.env.NATIVETS_NO_CACHE;
    process.env.NATIVETS_NO_CACHE = "1";
    try {
      const before = buildCacheStats();
      const b = await compileAndRun(source);
      const after = buildCacheStats();
      expect(after.hits).toBe(before.hits); // would have HIT had the cache been live
      expect(after.misses).toBe(before.misses);
      expect(b.stdout).toBe(a.stdout); // and still produces the same program
    } finally {
      if (prev === undefined) delete process.env.NATIVETS_NO_CACHE;
      else process.env.NATIVETS_NO_CACHE = prev;
    }
  }, SLOW);
});

describe("a failed build leaves no scratch dir", () => {
  /*
   * The general shape of a leak that had accumulated thousands of directories, and the
   * reason it is stated as an invariant over ALL failures rather than as a fix to one call:
   * `writeIR` created its scratch dir and only THEN called `raylibLinkFlags()`, which throws
   * when raylib is absent — and `buildBinary` called `writeIR` outside its own
   * `try`/`finally`, so nothing removed it. raylib was merely the instance we could see.
   * `ccFor()` throws identically for a missing Android NDK or wasi-sdk, so the same leak was
   * waiting on every machine that cross-compiles without a full toolchain.
   *
   * Each arm is skipped where the toolchain happens to BE present, since a successful build
   * is not what this measures.
   */
  function buildDirCount(): number {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("nativets-build-")).length;
  }

  async function expectNoLeak(build: () => Promise<unknown>) {
    const before = buildDirCount();
    let threw = false;
    try { await build(); } catch { threw = true; }
    expect(threw).toBe(true); // the arm must actually FAIL, or it measures nothing
    expect(buildDirCount()).toBeLessThanOrEqual(before);
  }

  test.skipIf(raylibAvailable())("a GUI build without raylib", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noleak-gui-"));
    try {
      await expectNoLeak(() =>
        buildBinary('initWindow(240, 360, "x");\n', join(dir, "gui"), { target: "host" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SLOW);

  test.skipIf(wasmToolchainAvailable())("a wasm build without a wasi-sdk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noleak-wasm-"));
    try {
      await expectNoLeak(() =>
        buildBinary('console.log("x");\n', join(dir, "a.wasm"), { target: "wasm" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SLOW);

  test("a program the compiler REFUSES", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noleak-refuse-"));
    try {
      // A refusal throws out of the frontend, before any dir exists — pinned so a future
      // refactor cannot quietly move dir creation ahead of the compile.
      await expectNoLeak(() =>
        buildBinary("const re = /nope/;\n", join(dir, "bad"), { target: "host" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SLOW);
});

describe("reaping", () => {
  /*
   * The age threshold IS the safety argument: eight lanes build concurrently, so a young
   * dir may belong to a live build and must never be touched. Only dirs old enough that no
   * live run could own them are candidates.
   */
  test("reaps only OUR stale dirs — never a young one, never a foreign one", () => {
    const root = mkdtempSync(join(tmpdir(), "reap-test-"));
    try {
      const old = new Date(Date.now() - 48 * 3600_000);
      const mk = (name: string, aged: boolean) => {
        const d = join(root, name);
        mkdirSync(d);
        writeFileSync(join(d, "module.ll"), "x");
        if (aged) utimesSync(d, old, old);
        return d;
      };

      const staleBuild = mk("nativets-build-aaa", true);
      const staleRun = mk("nativets-run-bbb", true);
      const youngBuild = mk("nativets-build-ccc", false); // a live lane's build, mid-flight
      const staleForeign = mk("some-other-tool-ddd", true); // not ours: hands off
      const staleLookalike = mk("nativets", true); // prefix without the separator

      const n = reapStale({ dir: root, maxAgeMs: 3600_000 });

      expect(existsSync(staleBuild)).toBe(false);
      expect(existsSync(staleRun)).toBe(false);
      expect(existsSync(youngBuild)).toBe(true);
      expect(existsSync(staleForeign)).toBe(true);
      expect(existsSync(staleLookalike)).toBe(true);
      expect(n).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds its own work so the first run after a big leak cannot stall", () => {
    const root = mkdtempSync(join(tmpdir(), "reap-cap-"));
    try {
      const old = new Date(Date.now() - 48 * 3600_000);
      for (let i = 0; i < 12; i++) {
        const d = join(root, `nativets-build-${i}`);
        mkdirSync(d);
        utimesSync(d, old, old);
      }
      expect(reapStale({ dir: root, maxAgeMs: 3600_000, limit: 5 })).toBe(5);
      expect(readdirSync(root).length).toBe(7); // the backlog drains over later runs
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /* Cache entries are FILES, and age out on the same sweep so the cache cannot become the
   * disk leak it was built to replace. Evicting a live entry costs a rebuild, never a wrong
   * answer, which is why a plain age rule is sufficient and no reference counting is needed. */
  test("evicts stale cache entries, keeps recent ones", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-evict-"));
    try {
      const old = new Date(Date.now() - 30 * 24 * 3600_000);
      const write = (name: string, aged: boolean) => {
        const p = join(root, name);
        writeFileSync(p, "artifact");
        if (aged) utimesSync(p, old, old);
        return p;
      };
      const stale = write("aaaa", true);
      const fresh = write("bbbb", false);
      const n = reapStale({ dir: root, kind: "file", prefix: "", maxAgeMs: 24 * 3600_000 });
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(n).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is a no-op on a directory that does not exist", () => {
    expect(reapStale({ dir: join(tmpdir(), "nativets-absent-xyz-123") })).toBe(0);
  });
});
