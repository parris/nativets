/*
 * Toolchain smoke tests — guard the ENVIRONMENT, not our compiler.
 * These are intentionally independent of src/ so they pass even before the
 * compiler exists: they prove clang can consume LLVM IR and cross-compile to
 * the iOS/Android architectures we target.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE_LL = join(HERE, "assets", "smoke.ll");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nativets-tc-"));
}

describe("toolchain", () => {
  test("clang consumes our LLVM IR and the binary runs (exit 0)", () => {
    const dir = tmp();
    try {
      const bin = join(dir, "smoke");
      const build = spawnSync("clang", [SMOKE_LL, "-o", bin], { encoding: "utf8" });
      expect(build.status).toBe(0);
      const run = spawnSync(bin, [], { encoding: "utf8" });
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cross-compiles LLVM IR to an iOS arm64 object", () => {
    const dir = tmp();
    try {
      const sdk = spawnSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"], {
        encoding: "utf8",
      }).stdout.trim();
      const ll = join(dir, "t.ll");
      writeFileSync(ll, "define i32 @main() {\nentry:\n  ret i32 0\n}\n");
      const obj = join(dir, "t.o");
      const r = spawnSync(
        "clang",
        ["-target", "arm64-apple-ios18.0", "-isysroot", sdk, "-c", ll, "-o", obj],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      const desc = spawnSync("file", [obj], { encoding: "utf8" }).stdout;
      expect(desc).toContain("arm64");
      expect(desc).toContain("Mach-O");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cross-compiles LLVM IR to an Android aarch64 object", () => {
    const dir = tmp();
    try {
      const ll = join(dir, "t.ll");
      writeFileSync(ll, "define i32 @main() {\nentry:\n  ret i32 0\n}\n");
      const obj = join(dir, "t.o");
      const r = spawnSync(
        "clang",
        ["-target", "aarch64-linux-android21", "-c", ll, "-o", obj],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      const desc = spawnSync("file", [obj], { encoding: "utf8" }).stdout;
      expect(desc).toContain("aarch64");
      expect(desc).toContain("ELF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
