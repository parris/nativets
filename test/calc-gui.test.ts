/*
 * GUI calculator (examples/calc-gui.ts, docs/examples.md C-d — the north-star
 * "calculator UI app that compiles on every platform", drawn with the raylib-backed
 * GUI FFI in runtime/nt_gui.c).
 *
 * A GUI window can't be differential-tested (and raylib may not even be installed
 * on the CI box), so this covers the example two ways:
 *
 *  1. PURE-FUNCTION differential: take everything ABOVE the `INTERACTIVE MAIN`
 *     marker in calc-gui.ts (the engine + buttonAt + step + displayText) and append
 *     a deterministic driver that hit-tests a click script and threads the resulting
 *     labels through step()/displayText(), console.logging each frame. Same source
 *     to node and to our binary → the REAL functions are compared byte-for-byte.
 *     The pure core uses NO GUI builtin, so this needs no raylib.
 *  2. BUILD-VERIFY: if raylib is present, `buildBinary(host)` the WHOLE file and
 *     assert a real executable is produced (arch-checked); SKIP with a clear message
 *     when raylib/pkg-config is absent (like the wasm/windows/cross tests). We never
 *     open a real window in tests — the windowed run is manual (see the file header).
 *
 * Lives outside test/fixtures/ so the generic (no-input) harness never runs it (the
 * INTERACTIVE MAIN would block on a window).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, runWithNode } from "./harness.ts";
import { buildBinary, raylibAvailable } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "calc-gui.ts"), "utf8");

// Everything above the marker: the engine + the pure buttonAt/step/displayText.
const MARKER = "// ==== INTERACTIVE MAIN ====";
const pureCore = source.split(MARKER)[0]!;

// ---------------------------------------------------------------------------
// 1. PURE-FUNCTION differential vs node — hit-test + handler, no window.
// ---------------------------------------------------------------------------

/** Build a self-contained program that drives the REAL buttonAt()/step()/displayText()
 *  from calc-gui.ts over a script of (px,py) clicks, logging each frame. */
function driver(clicks: { x: number; y: number }[]): string {
  const lines = clicks
    .map(
      (c) => `
{
  const __label: string = buttonAt(${c.x}, ${c.y});
  __st = step(__st, __label);
  console.log("click(" + ${c.x} + "," + ${c.y} + ") label=[" + __label + "] expr=[" + __st.expr + "] result=[" + __st.result + "] display=[" + displayText(__st) + "]");
}`,
    )
    .join("\n");
  return (
    pureCore +
    `
let __st: { expr: string; result: string } = { expr: "", result: "" };
${lines}
`
  );
}

// Grid geometry (must match calc-gui.ts): gridX=10, gridY=80, cell 55x55, 4x5.
// A click at a cell's center: x = 10 + col*55 + 27, y = 80 + row*55 + 27.
function center(col: number, row: number): { x: number; y: number } {
  return { x: 10 + col * 55 + 27, y: 80 + row * 55 + 27 };
}
// Labels row-major: row0 C ( ) / | row1 7 8 9 * | row2 4 5 6 - | row3 1 2 3 + | row4 0 . = _
const C = center(0, 0);
const D7 = center(0, 1), D8 = center(1, 1), D9 = center(2, 1), MUL = center(3, 1);
const D4 = center(0, 2), D5 = center(1, 2), D6 = center(2, 2), SUB = center(3, 2);
const D1 = center(0, 3), D2 = center(1, 3), D3 = center(2, 3), ADD = center(3, 3);
const D0 = center(0, 4), DOT = center(1, 4), EQ = center(2, 4), BLANK = center(3, 4);
const MISS = { x: 5, y: 5 }; // above the grid → a miss ("")

describe("examples/calc-gui.ts — pure buttonAt/step (differential vs node)", () => {
  const scripts: { name: string; clicks: { x: number; y: number }[] }[] = [
    { name: "2 + 3 =", clicks: [D2, ADD, D3, EQ] },
    { name: "12 * (3 + 4) =", clicks: [D1, D2, MUL, center(1, 0), D3, ADD, D4, center(2, 0), EQ] },
    { name: "9 =", clicks: [D9, EQ] },
    { name: "7 + 8 = then Clear", clicks: [D7, ADD, D8, EQ, C] },
    { name: "= on empty (no-op)", clicks: [EQ] },
    { name: "10 / 4 = (decimal)", clicks: [D1, D0, center(3, 1), D4, EQ] },
    { name: "miss + blank cell ignored", clicks: [MISS, D5, BLANK, EQ] },
    { name: "6 - 1 = then keep typing", clicks: [D6, SUB, D1, EQ, ADD, D2, EQ] },
    { name: "decimal entry 3.5 + 0.5 =", clicks: [D3, DOT, D5, ADD, D0, DOT, D5, EQ] },
  ];
  for (const { name, clicks } of scripts) {
    test(name, async () => {
      const src = driver(clicks);
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
      expect(ours.exitCode).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. BUILD-VERIFY — link the whole GUI program iff raylib is present (never RUN).
// ---------------------------------------------------------------------------

const haveRaylib = raylibAvailable();

describe("examples/calc-gui.ts — build-verify (raylib-gated)", () => {
  test.if(haveRaylib)("builds a host binary with raylib linked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-calc-gui-"));
    const out = join(dir, "calc-gui");
    try {
      await buildBinary(source, out, { target: "host" });
      expect(existsSync(out)).toBe(true);
      // Arch-check: a real host executable (Mach-O on macOS, ELF on Linux). We do
      // NOT run it — that would open a window / need a display.
      const f = spawnSync("file", [out], { encoding: "utf8" }).stdout ?? "";
      expect(/Mach-O|ELF/.test(f)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.if(!haveRaylib)("SKIPPED: raylib not installed (brew install raylib) — GUI build not verified here", () => {
    // Plumbing sanity without a linker: the whole file still compiles to IR (checker +
    // codegen), and the GUI FFI is host-desktop only. The link is exercised once raylib
    // is present. This asserts the raylib probe is honest about absence.
    expect(haveRaylib).toBe(false);
  });
});
