/*
 * WebAssembly (WASI) build target.
 *
 *   wasm : compile -> wasm32-wasi module (out.wasm) -> arch-check via `file`
 *          -> (if a WASI runtime is present) RUN via wasmtime/wasmer -> match node
 *
 * The IR is target-triple-free, so a wasm build is "just another clang cross-target":
 *   <wasi-sdk>/bin/clang --target=wasm32-wasi --sysroot=<wasi-sdk>/share/wasi-sysroot \
 *     module.ll runtime.c -lm -o out.wasm
 * The libc-only runtime links against wasi-libc unchanged (termios/raw-mode is #if'd out
 * for __wasi__; actors need ucontext and are gated off — see the pure tests below).
 *
 * Like the iOS/Android cross tests, the arch-check SKIPS gracefully when no wasm toolchain
 * is installed and the RUN skips when no WASI runtime is up, so the suite stays green
 * headless; when the toolchain/runtime is present they are hard gates.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildBinary,
  resolveStatic,
  supportsStatic,
  wasmToolchainAvailable,
} from "../src/driver.ts";
import { runWithNode, runWithNodeIO } from "./harness.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nativets-wasm-"));
}

/** A WASI CLI runner (wasmtime or wasmer), or null when neither is installed. */
function wasmRuntime(): { name: string; run: (wasm: string, args: string[], stdin: string) => { stdout: string; status: number } } | null {
  const has = (cmd: string) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
  const exec = (cmd: string, argv: string[], stdin: string) => {
    const r = spawnSync(cmd, argv, { encoding: "utf8", input: stdin });
    return { stdout: r.stdout ?? "", status: r.status ?? -1 };
  };
  if (has("wasmtime")) return { name: "wasmtime", run: (w, a, i) => exec("wasmtime", ["run", w, ...a], i) };
  if (has("wasmer")) return { name: "wasmer", run: (w, a, i) => exec("wasmer", ["run", w, ...a], i) };
  return null;
}

const toolchain = wasmToolchainAvailable();
const runtime = wasmRuntime();

// ---- Pure plumbing: assert the wasm target is wired correctly WITHOUT a toolchain. ----
describe("wasm target plumbing", () => {
  test("wasm is not a static-capable target (wasm modules are self-contained)", () => {
    expect(supportsStatic("wasm")).toBe(false);
  });

  test("--static on wasm falls back with a warning (no -static)", () => {
    const s = resolveStatic("wasm", true);
    expect(s.flags).toEqual([]);
    expect(s.warning).toContain("wasm");
    expect(s.warning).toContain("not supported");
    // Not requested → never a flag, never a warning.
    expect(resolveStatic("wasm", false)).toEqual({ flags: [] });
  });

  test("actors are gated off wasm with a clear error (ucontext is absent in wasm32-wasi)", async () => {
    // Compiles to IR fine (Stage 22 actors), but the driver refuses to link it for wasm —
    // BEFORE invoking clang, so this holds even with no wasm toolchain installed.
    const ACTOR = [
      "const echo = (parent: number) => { const m = receive(); send(parent, m); };",
      "const me = self();",
      "const p = spawn(echo, me);",
      "send(p, 42);",
      "console.log(receive());",
    ].join("\n");
    await expect(buildBinary(ACTOR, join(tmp(), "a.wasm"), { target: "wasm" })).rejects.toThrow(/actor/i);
  });
});

// ---- Arch check: build a real .wasm and confirm `file` reports a WebAssembly module. ----
const COMPUTE = `
function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
const xs: number[] = [1, 2, 3, 4, 5];
let sum = 0;
for (const x of xs) { sum += x; }
console.log("fact5=" + fact(5), "sum=" + sum, \`n=\${xs.length}\`);
`;

describe("wasm build (arch check)", () => {
  (toolchain ? test : test.skip)("compiles a program to a wasm32-wasi module", async () => {
    const dir = tmp();
    try {
      const wasm = join(dir, "out.wasm");
      await buildBinary(COMPUTE, wasm, { target: "wasm" });
      const desc = spawnSync("file", [wasm], { encoding: "utf8" }).stdout;
      expect(desc).toContain("WebAssembly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- Execution: RUN the .wasm in a WASI runtime and match the node oracle. ----
describe("wasm execution (matches node)", () => {
  const gated = toolchain && runtime ? test : test.skip;

  gated("runs a compute program and matches node", async () => {
    const dir = tmp();
    try {
      const wasm = join(dir, "out.wasm");
      await buildBinary(COMPUTE, wasm, { target: "wasm" });
      const out = runtime!.run(wasm, [], "");
      expect(out.stdout).toBe(runWithNode(COMPUTE).stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  gated("passes argv through WASI and matches node", async () => {
    const SRC = `
const args = process.argv.slice(2);
let total = 0;
for (const a of args) { total = total + Number(a); }
console.log(total, args.length);
`;
    const dir = tmp();
    try {
      const wasm = join(dir, "out.wasm");
      await buildBinary(SRC, wasm, { target: "wasm" });
      const argv = ["3", "4", "5"];
      const out = runtime!.run(wasm, argv, "");
      expect(out.stdout).toBe(runWithNodeIO(SRC, { args: argv }).stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  gated("reads stdin via WASI and matches node", async () => {
    const SRC = `
const line = readLine();
console.log("you said: " + line);
`;
    const dir = tmp();
    try {
      const wasm = join(dir, "out.wasm");
      await buildBinary(SRC, wasm, { target: "wasm" });
      const stdin = "hello wasi\n";
      const out = runtime!.run(wasm, [], stdin);
      expect(out.stdout).toBe(runWithNodeIO(SRC, { stdin }).stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
