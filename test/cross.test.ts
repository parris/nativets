/*
 * Cross-platform execution tests — the headline deliverable.
 *
 *   android : compile -> aarch64 ELF -> adb push -> RUN on emulator -> match node
 *   ios-sim : compile -> arm64 Mach-O -> simctl spawn -> RUN on simulator -> match node
 *   ios     : compile -> arm64 Mach-O device binary -> verify arch (can't run w/o device)
 *
 * Each device-execution test SKIPS gracefully when no emulator/simulator is up,
 * so the suite stays green in a headless CI; when a device is available it is a
 * hard correctness gate.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";
import { runWithNode } from "./harness.ts";

const ADB = join(homedir(), "Library/Android/sdk/platform-tools/adb");

// A program spanning arithmetic, recursion, strings, template literals, and a for loop.
const PROGRAM = `
function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
console.log("fact5=" + fact(5));
let t: number = 0;
for (let i: number = 1; i <= 3; i++) { t += i; }
console.log(t, t > 5, \`sum=\${t}\`);
`;

function androidDevice(): string | null {
  const r = spawnSync(ADB, ["devices"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").split("\n").find((l) => /\tdevice$/.test(l));
  return line ? line.split("\t")[0]! : null;
}

function bootedSim(): string | null {
  const r = spawnSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").split("\n").find((l) => l.includes("(Booted)"));
  const m = line?.match(/\(([0-9A-F-]{36})\)/);
  return m ? m[1]! : null;
}

const android = androidDevice();
const sim = bootedSim();

describe("cross-platform execution", () => {
  const oracle = runWithNode(PROGRAM).stdout;

  (android ? test : test.skip)("runs on Android emulator and matches node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xand-"));
    try {
      const bin = join(dir, "prog");
      await buildBinary(PROGRAM, bin, { target: "android" });
      const remote = "/data/local/tmp/nativets_cross";
      expect(spawnSync(ADB, ["push", bin, remote]).status).toBe(0);
      spawnSync(ADB, ["shell", "chmod", "755", remote]);
      const out = (spawnSync(ADB, ["shell", remote], { encoding: "utf8" }).stdout ?? "").replace(/\r/g, "");
      expect(out).toBe(oracle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  (sim ? test : test.skip)("runs on iOS simulator and matches node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xios-"));
    try {
      const bin = join(dir, "prog");
      await buildBinary(PROGRAM, bin, { target: "ios-sim" });
      const out = (spawnSync("xcrun", ["simctl", "spawn", sim!, bin], { encoding: "utf8" }).stdout ?? "").replace(/\r/g, "");
      expect(out).toBe(oracle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Needs Apple's iOS sysroot, so it is macOS-only: on the Linux CI runner there is no
  // `xcrun`/SDK and the link can't produce a Mach-O at all (see toolchain.test.ts).
  (process.platform === "darwin" ? test : test.skip)("produces a valid iOS-device arm64 Mach-O binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xiosd-"));
    try {
      const bin = join(dir, "prog");
      await buildBinary(PROGRAM, bin, { target: "ios" });
      const desc = spawnSync("file", [bin], { encoding: "utf8" }).stdout ?? "";
      expect(desc).toContain("Mach-O");
      expect(desc).toContain("arm64");
      expect(desc).toContain("executable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
