/*
 * BUILD PERFORMANCE — scratch-dir reaping and the content-addressed binary cache.
 *
 * Two subsystems, one concern: the toolchain half of the test loop. Neither may ever
 * change what a program PRINTS, so every test here is about identity of artifacts and
 * safety of the cache key — never about semantics.
 *
 * The cache is the dangerous one. A stale hit is a silent wrong answer, which this
 * project ranks as the worst available outcome ("reject, never miscompile"). The rule
 * the tests below pin is therefore one-directional: a cache MISS is always safe, so
 * every input that could change the produced bytes must change the key. Over-
 * invalidation costs a rebuild; under-invalidation costs correctness.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";
import {
  reapStaleScratchDirs, reapStaleCacheEntries, buildCacheKey, buildCacheStats, buildBinary,
  type BuildKeyInputs,
} from "../src/driver.ts";

describe("scratch-dir reaping", () => {
  /*
   * The `finally { rmSync }` in driver.ts/harness.ts cannot run when a run is KILLED,
   * which is routine for agent lanes and for a ^C in the test loop. That leak was
   * measured at 5,311 directories in one TMPDIR. Reaping them is only safe if the
   * reaper can never touch a dir belonging to a build that is still running, so the
   * age threshold is the whole safety argument: a build dir lives ~0.1s and a run dir
   * ~1s, so a dir untouched for hours cannot belong to a live run.
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

      const n = reapStaleScratchDirs({ dir: root, maxAgeMs: 3600_000 });

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
      const n = reapStaleScratchDirs({ dir: root, maxAgeMs: 3600_000, limit: 5 });
      expect(n).toBe(5);
      expect(readdirSync(root).length).toBe(7); // the backlog drains over later runs
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cache eviction", () => {
  /*
   * A cache with no bound is just the leak again in a tidier directory, so entries age
   * out. Eviction is safe in the direction that matters: dropping a live entry costs a
   * REBUILD, never a wrong answer, which is why a plain age rule is enough and no
   * reference counting is needed.
   */
  test("evicts entries past the age bound and keeps recent ones", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-evict-"));
    try {
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "obj"));
      const old = new Date(Date.now() - 30 * 24 * 3600_000);
      const write = (kind: string, name: string, aged: boolean) => {
        const p = join(root, kind, name);
        writeFileSync(p, "artifact");
        if (aged) utimesSync(p, old, old);
        return p;
      };
      const staleBin = write("bin", "aaa", true);
      const staleObj = write("obj", "bbb", true);
      const freshBin = write("bin", "ccc", false);

      const n = reapStaleCacheEntries({ dir: root, maxAgeMs: 24 * 3600_000 });

      expect(existsSync(staleBin)).toBe(false);
      expect(existsSync(staleObj)).toBe(false);
      expect(existsSync(freshBin)).toBe(true);
      expect(n).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is a no-op on a cache that does not exist yet", () => {
    expect(reapStaleCacheEntries({ dir: join(tmpdir(), "nativets-cache-absent-xyz") })).toBe(0);
  });
});

describe("build cache key", () => {
  /*
   * The key is the entire correctness argument for both caches, so it is tested as a
   * one-directional rule: EVERY input that can change the produced bytes must change
   * the key. A miss just rebuilds; a false hit is a silent wrong answer.
   */
  const base: BuildKeyInputs = {
    ir: "define i32 @main() { ret i32 0 }",
    sources: ["/* runtime.c */", "/* nt_pvec.c */"],
    flags: ["-target", "arm64-apple-ios18.0", "-DNT_PVEC"],
    cc: "clang version 17.0.0",
  };

  test("is stable for identical inputs", () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  /* Each of these is a real invalidation hazard the probe called out by name: a codegen
   * edit (ir), a runtime .c edit (sources), a target or feature-define change (flags),
   * and a toolchain upgrade (cc). */
  const mutations: Array<[string, BuildKeyInputs]> = [
    ["a codegen change (different IR)", { ...base, ir: base.ir + "\n; changed" }],
    ["a runtime source edit", { ...base, sources: ["/* runtime.c EDITED */", "/* nt_pvec.c */"] }],
    ["a runtime source APPEARING (conditional link)", { ...base, sources: [...base.sources, "/* nt_http.c */"] }],
    ["a different target", { ...base, flags: ["-target", "x86_64-pc-windows-msvc", "-DNT_PVEC"] }],
    ["a dropped feature define", { ...base, flags: ["-target", "arm64-apple-ios18.0"] }],
    ["a toolchain upgrade", { ...base, cc: "clang version 18.0.0" }],
  ];
  for (const [what, mutated] of mutations) {
    test(`changes on ${what}`, () => {
      expect(buildCacheKey(mutated)).not.toBe(buildCacheKey(base));
    });
  }

  /*
   * Injectivity. A key built by plain concatenation cannot distinguish ["ab","c"] from
   * ["a","bc"], so two DIFFERENT builds would share a key — exactly the false hit the
   * design forbids. The encoding must be unambiguous (length-prefixed), and this is the
   * cheapest place to prove it: a separator alone is not enough, since a separator can
   * occur inside IR text or a link flag.
   */
  test("cannot be confused by moving a boundary between fields", () => {
    const a = buildCacheKey({ ...base, sources: ["ab", "c"] });
    const b = buildCacheKey({ ...base, sources: ["a", "bc"] });
    expect(a).not.toBe(b);
  });

  test("cannot be confused by a separator appearing INSIDE a field", () => {
    const a = buildCacheKey({ ...base, flags: ["-DA\0-DB"] });
    const b = buildCacheKey({ ...base, flags: ["-DA", "-DB"] });
    expect(a).not.toBe(b);
  });
});

describe("binary cache, end to end", () => {
  /*
   * The scan cost this cache exists to dodge is not compilation. macOS scans every
   * newly-created Mach-O on its first execution; measured here, a fresh binary costs
   * ~1-2s to execute while the same file re-executed costs ~2ms. The verdict is cached
   * per INODE, not per path, so `buildBinary` HARDLINKS the cached artifact to the
   * caller's outPath: same inode, no rescan, and every existing caller keeps its
   * signature. (A copy would re-trigger the scan and throw the whole win away.)
   *
   * These tests assert IDENTITY OF BEHAVIOUR across a hit and a miss. A cache that
   * changed what a program printed would be the silent wrong answer the project ranks
   * worst, so "same output" is the property; the hit/miss counters are what prove the
   * two runs really did take different paths through the driver.
   */
  const uniq = () => `console.log("cache-probe ${Math.random()}");\n`;

  /*
   * These three tests deliberately build and then EXECUTE brand-new binaries, and a
   * first execution is exactly the ~1-2s system scan this cache exists to avoid — so
   * they cost seconds by construction, not by accident. They carry an explicit timeout
   * because bun's default is 5s: `bun test` picks up `--timeout 60000` from package.json,
   * but the per-file loop CLAUDE.md documents (`bun test test/foo.test.ts`) does not, and
   * a test that only passes when invoked one particular way is a trap for the next reader.
   */
  const SLOW = 60_000;

  function runBin(p: string): string {
    const r = spawnSync(p, [], { encoding: "utf8" });
    return `${r.status}|${r.stdout}`;
  }

  test("a repeat build HITS, and the hit behaves exactly like the miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-e2e-"));
    try {
      const source = uniq();
      const before = buildCacheStats();

      const a = join(dir, "a");
      await buildBinary(source, a, { target: "host" });
      const afterMiss = buildCacheStats();
      expect(afterMiss.misses).toBe(before.misses + 1);
      expect(afterMiss.hits).toBe(before.hits);

      const b = join(dir, "b");
      await buildBinary(source, b, { target: "host" });
      const afterHit = buildCacheStats();
      expect(afterHit.hits).toBe(before.hits + 1);
      expect(afterHit.misses).toBe(afterMiss.misses); // no second compile

      expect(runBin(b)).toBe(runBin(a));
      expect(runBin(a)).toContain("cache-probe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  test("a DIFFERENT program misses (the key is not accidentally constant)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-diff-"));
    try {
      const a = join(dir, "a");
      await buildBinary(uniq(), a, { target: "host" });
      const mid = buildCacheStats();
      const b = join(dir, "b");
      await buildBinary(uniq(), b, { target: "host" });
      expect(buildCacheStats().misses).toBe(mid.misses + 1);
      expect(runBin(a)).not.toBe(runBin(b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  /*
   * CACHE POISONING THROUGH A HARDLINK — the one way this design could have produced a
   * silent wrong answer.
   *
   * A cache entry and the build output that stored it are the SAME INODE (that is the
   * whole point). So if a later build writes to a path that is still a hardlink into the
   * cache, and the linker truncates the file IN PLACE instead of unlinking it first, the
   * new program's bytes land inside the old program's cache entry. Every later hit on
   * that key then silently runs the wrong binary.
   *
   * ld64 on macOS happens to unlink, so this does not fire here today — which is exactly
   * why it needs a test rather than a comment. The behaviour is linker- and
   * platform-specific, and this project builds on Linux CI too, so the driver removes
   * outPath before linking and this test pins that it stays removed.
   */
  test("a rebuild over a path that is a cache hardlink cannot poison the entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-poison-"));
    try {
      const srcA = uniq();
      const srcB = uniq();

      // 1. Build A. Storing it hardlinks `p` into the cache, so `p` IS the entry.
      const p = join(dir, "shared");
      await buildBinary(srcA, p, { target: "host" });
      const outA = runBin(p);

      // 2. Build B over that very path. A linker that truncates in place writes B's
      //    bytes straight into A's cache entry.
      await buildBinary(srcB, p, { target: "host" });
      expect(runBin(p)).not.toBe(outA);

      // 3. Ask for A again somewhere else. It must still be A.
      const q = join(dir, "again");
      await buildBinary(srcA, q, { target: "host" });
      expect(runBin(q)).toBe(outA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  /*
   * The explicit bypass. It exists so a suspected cache bug can be ruled out in ONE
   * command (`NATIVETS_NO_CACHE=1 bun test …`) rather than by reasoning — and it is
   * tested, because an escape hatch nobody exercises is one that has quietly stopped
   * working by the time you actually need it.
   */
  test("NATIVETS_NO_CACHE=1 bypasses the cache entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-off-"));
    const prev = process.env.NATIVETS_NO_CACHE;
    try {
      const source = uniq();
      const a = join(dir, "a");
      await buildBinary(source, a, { target: "host" }); // populate the cache first

      process.env.NATIVETS_NO_CACHE = "1";
      const before = buildCacheStats();
      const b = join(dir, "b");
      await buildBinary(source, b, { target: "host" });
      const after = buildCacheStats();
      expect(after.hits).toBe(before.hits); // would have HIT had the cache been live
      expect(after.misses).toBe(before.misses);
      expect(runBin(b)).toBe(runBin(a)); // and still produces the same program
    } finally {
      if (prev === undefined) delete process.env.NATIVETS_NO_CACHE;
      else process.env.NATIVETS_NO_CACHE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);
});
