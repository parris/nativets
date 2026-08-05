/*
 * `--static` flag plumbing — assert the correct clang link args are produced per target,
 * WITHOUT a full link. A fully static Linux/Android binary can't be linked on a macOS CI
 * box (no static libc there, and the Android link needs an NDK), so — mirroring the
 * target-flag smoke tests in toolchain.test.ts — we test the pure arg builder instead:
 * `-static` must reach clang for Linux-family targets and be refused (with a warning +
 * dynamic fallback) for Apple targets.
 */

import { test, expect, describe } from "bun:test";
import { linkArgv, resolveStatic, supportsStatic, type Target } from "../src/driver.ts";

const FILES = { ll: "/tmp/module.ll", rt: "/tmp/runtime.c", actor: null, extra: [], out: "/tmp/prog" };

describe("--static flag plumbing", () => {
  test("android is a static-capable target; iOS is not", () => {
    expect(supportsStatic("android")).toBe(true);
    expect(supportsStatic("ios")).toBe(false);
    expect(supportsStatic("ios-sim")).toBe(false);
    // host is Apple (no static libc) only on macOS; a Linux host can link static.
    expect(supportsStatic("host")).toBe(process.platform !== "darwin");
  });

  test("resolveStatic emits -static only for capable targets", () => {
    expect(resolveStatic("android", true).flags).toEqual(["-static"]);
    expect(resolveStatic("android", true).warning).toBeUndefined();

    const ios = resolveStatic("ios", true);
    expect(ios.flags).toEqual([]);
    expect(ios.warning).toContain("--static");
    expect(ios.warning).toContain("not supported");

    // Not requested → never a flag, never a warning, regardless of target.
    expect(resolveStatic("android", false)).toEqual({ flags: [] });
    expect(resolveStatic("ios", false)).toEqual({ flags: [] });
  });

  test("--static on Android puts -static into the clang argv (before -lm/-o)", () => {
    const { args, warning } = linkArgv("android", FILES, { static: true });
    expect(warning).toBeUndefined();
    expect(args).toContain("-static");
    // the runtime + module inputs are present, and the static flag precedes -lm/-o.
    expect(args).toContain("/tmp/module.ll");
    expect(args).toContain("/tmp/runtime.c");
    expect(args.indexOf("-static")).toBeLessThan(args.indexOf("-lm"));
    expect(args.indexOf("-lm")).toBeLessThan(args.indexOf("-o"));
    expect(args[args.length - 1]).toBe("/tmp/prog");
  });

  test("no --static → no -static flag (default dynamic single-file binary)", () => {
    const { args, warning } = linkArgv("android", FILES, {});
    expect(warning).toBeUndefined();
    expect(args).not.toContain("-static");
    expect(args).toContain("-lm");
  });

  test("--static on an Apple target falls back to dynamic with a warning (no -static)", () => {
    for (const t of ["ios", "ios-sim"] as Target[]) {
      const { args, warning } = linkArgv(t, FILES, { static: true });
      expect(args).not.toContain("-static");
      expect(warning).toBeDefined();
      expect(warning).toContain(t);
    }
  });

  test("extra runtime inputs (actor/mapset) are still linked with --static", () => {
    const { args } = linkArgv(
      "android",
      { ...FILES, actor: "/tmp/nt_actor.c", extra: ["/tmp/nt_hamt.c", "/tmp/nt_mapset.c"] },
      { static: true },
    );
    expect(args).toContain("/tmp/nt_actor.c");
    expect(args).toContain("/tmp/nt_hamt.c");
    expect(args).toContain("/tmp/nt_mapset.c");
    expect(args).toContain("-static");
  });
});
