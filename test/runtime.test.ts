/*
 * The C-level runtime unit tests, built and run by `bun test`.
 *
 * WHY THIS FILE EXISTS. `test/runtime/*.c` drive runtime modules directly, below any
 * TypeScript surface — the persistent vector, the HAMT, the actor scheduler. They were
 * written to be run by hand (each carries a `clang ...` line in its header comment), and
 * three of the five were built by NOTHING in the suite. Both of the rots that produced
 * cost real debugging time:
 *
 *   - `actor_test.c` stopped compiling when `nt_num_to_buf` was added to runtime.c and
 *     used by nt_actor.c. Nobody noticed, because nobody built it — and it is the
 *     strongest canary for the scheduler-reinit crash that later reached CI.
 *   - `pvec_test.c` stopped linking when the M:N lane added the `nt_rt_lock` hook that
 *     nt_pvec.c calls through. Same reason.
 *
 * A test that is not run is not a test. Building these here makes link rot a red suite
 * instead of a discovery months later. Each case asserts the binary BUILDS (empty stderr,
 * status 0), RUNS to a clean exit, and reports zero failures in its own output.
 *
 * Not included here: poll_test.c and mn_rc_race_test.c, which need scheduler-thread and
 * sanitizer environments and are driven by test/actors-mn.test.ts instead.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A C test: its source, any extra translation units it must link, and the token its
 *  output ends with when everything passed. */
const C_TESTS = [
  { name: "actor_test.c — v0 actor behaviours (spawn/send/receive/self)", src: "test/runtime/actor_test.c", link: [] as string[], ok: "passed" },
  { name: "hamt_test.c — the persistent hash map behind Map/Set", src: "test/runtime/hamt_test.c", link: [] as string[], ok: "0 failures" },
  { name: "pvec_test.c — the persistent vector trie behind arrays", src: "test/runtime/pvec_test.c", link: ["runtime/nt_pvec.c"], ok: "0 failures" },
  { name: "collinplace_test.c — the in-place Map/Set update behind a `@@mutable` binding", src: "test/runtime/collinplace_test.c", link: ["runtime/nt_hamt.c", "runtime/runtime.c"], ok: "0 failures" },
];

describe("C runtime unit tests (built + run, so they cannot silently rot)", () => {
  for (const t of C_TESTS) {
    test(t.name, () => {
      const dir = mkdtempSync(join(tmpdir(), "nativets-crt-"));
      try {
        const bin = join(dir, "t");
        const build = spawnSync(
          "clang",
          ["-O0", "-g", join(ROOT, t.src), ...t.link.map((f) => join(ROOT, f)), "-o", bin],
          { encoding: "utf8" },
        );
        // An undefined symbol here means a runtime module grew a dependency this test's
        // stub list doesn't carry — fix the stubs, don't delete the test.
        expect(build.stderr).toBe("");
        expect(build.status).toBe(0);

        const run = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(t.ok);
        expect(run.stdout).not.toContain("FAIL");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
