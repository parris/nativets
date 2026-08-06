/*
 * The local Linux lane — a smoke test for the CONTAINER itself.
 *
 * This is an OPT-IN tool, never a gate: it skips when docker is absent, when the
 * daemon is down, or when the image has not been built (`scripts/docker-test.sh`
 * builds it on first use). Same discipline as test/cross.test.ts, which skips
 * without a booted simulator/emulator — the suite stays green headless.
 *
 * What it proves when it does run: a container built from docker/Dockerfile can
 * compile and RUN a nativets program on Linux and match node — i.e. the lane is
 * actually usable, not just buildable.
 */

import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = process.env.NATIVETS_DOCKER_IMAGE ?? "nativets-linux:dev";

/** docker installed, daemon up, and the image already built (we never build here). */
function dockerReady(): boolean {
  const info = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (info.error || info.status !== 0) return false;
  return spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;
}

const ready = dockerReady();

describe("linux container lane", () => {
  (ready ? test : test.skip)("compiles and runs ci/smoke.ts inside the Linux image", () => {
    const r = spawnSync(
      join(ROOT, "scripts/docker-test.sh"),
      ["--run", "bun", "run", "src/cli.ts", "run", "ci/smoke.ts"],
      { encoding: "utf8", timeout: 300_000, cwd: ROOT },
    );
    expect(r.status).toBe(0);
    // Same oracle as the Windows CI job's smoke step (node prints exactly this).
    expect(r.stdout).toBe("result=42\nhello world\n");
  }, 300_000);

  (ready ? test : test.skip)("the container is a Linux box with the toolchain the runtime needs", () => {
    const r = spawnSync(
      "docker",
      ["run", "--rm", IMAGE, "bash", "-lc", "uname -s; clang --version | head -1; node --version; bun --version"],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Linux");
    expect(r.stdout).toContain("clang version");
  }, 120_000);
});
