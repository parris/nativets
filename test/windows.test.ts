/*
 * Windows x86-64 (PE) build target.
 *
 * Two gates, each degrading gracefully like test/toolchain.test.ts + test/cross.test.ts:
 *
 *   1. OBJECT arch-check (runs anywhere clang has the x86-64 backend — i.e. everywhere):
 *      our target-triple-free IR compiles to an `amd64 COFF object` for
 *      `x86_64-pc-windows-msvc`. This proves the target plumbing (driver `targetFlags`)
 *      end to end without needing a Windows SDK or a linker — the object never links
 *      runtime.c, so no MSVC/UCRT headers are required.
 *
 *   2. FULL PE executable (skips unless a Windows-capable toolchain is present): links
 *      the runtime into a real `.exe`. This needs the Windows SDK headers (stdio/…) +
 *      lld-link, which live on a Windows runner (or a mingw/llvm-mingw sysroot). We probe
 *      for it by attempting the build; on a box without it (this macOS host: no SDK, no
 *      lld-link) the test SKIPs with a clear message. The produced `.exe` is only RUN when
 *      we are actually on Windows (or wine is trivially available); otherwise arch-check only.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildObject, buildBinary } from "../src/driver.ts";

const PROG = `const a = [1, 2, 3];\nlet s = 0;\nfor (const x of a) s += x;\nconsole.log("sum=" + s);\n`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nativets-win-"));
}

function fileDesc(path: string): string {
  return spawnSync("file", [path], { encoding: "utf8" }).stdout ?? "";
}

/** Does this box have a clang x86-64 backend (needed even to emit a COFF object)? */
function hasX86Backend(): boolean {
  const r = spawnSync("clang", ["--print-targets"], { encoding: "utf8" });
  return (r.stdout ?? "").includes("x86-64");
}

describe("windows target", () => {
  test("compiles our LLVM IR to a Windows x86-64 COFF object", async () => {
    if (!hasX86Backend()) {
      console.warn("SKIP: clang has no x86-64 backend; cannot emit a Windows object");
      return;
    }
    const dir = tmp();
    try {
      const obj = join(dir, "prog.obj");
      await buildObject(PROG, obj, "windows");
      const desc = fileDesc(obj);
      // e.g. "Intel amd64 COFF object file, not stripped, ..."
      expect(desc).toContain("COFF");
      expect(desc).toContain("amd64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("links a full Windows PE executable when a Windows-capable toolchain is present", async () => {
    const dir = tmp();
    try {
      const exe = join(dir, "prog.exe");
      try {
        await buildBinary(PROG, exe, { target: "windows" });
      } catch (e) {
        // No Windows SDK headers / no lld-link on this host (the macOS/Linux dev + CI case):
        // the plumbing is proven by the object test above; the PE is built on a Windows runner.
        console.warn(`SKIP: no Windows-capable clang toolchain to link a PE (${(e as Error).message.split("\n")[0]})`);
        return;
      }
      const desc = fileDesc(exe);
      // e.g. "PE32+ executable (console) x86-64, for MS Windows"
      expect(desc).toContain("PE32+");
      expect(desc.includes("x86-64") || desc.includes("MS Windows")).toBe(true);

      // Only RUN it where we can: on Windows natively, or via wine if it happens to be around.
      const onWindows = process.platform === "win32";
      const wine = !onWindows && spawnSync("which", ["wine"], { encoding: "utf8" }).status === 0;
      if (onWindows || wine) {
        const r = onWindows
          ? spawnSync(exe, [], { encoding: "utf8" })
          : spawnSync("wine", [exe], { encoding: "utf8" });
        expect(r.status).toBe(0);
        expect((r.stdout ?? "").trim()).toBe("sum=6");
      } else {
        console.warn("SKIP-RUN: PE built + arch-checked; not on Windows and no wine to execute it");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
