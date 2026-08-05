/*
 * TUI calculator (examples/calc-tui.ts, docs/examples.md C-c).
 *
 * A TUI is hard to differential-test directly, so the logic is factored into two
 * PURE functions — render(state) and step(state, key) — and tested two ways:
 *
 *  1. PURE-FUNCTION differential: take everything ABOVE the `INTERACTIVE MAIN`
 *     marker in calc-tui.ts (the engine + step + render) and append a
 *     deterministic driver that threads a keystroke string through step()/render()
 *     and console.logs each frame. Same source to node and to our binary → the
 *     real functions are compared byte-for-byte.
 *  2. END-TO-END: feed a fixed keystroke SCRIPT via piped stdin to the WHOLE
 *     program on both sides. Piped stdin isn't a tty, so readKey degrades to
 *     byte-reads and rawMode is a no-op — deterministic and node-differential.
 *
 * Lives outside test/fixtures/ so the generic (no-input) harness never runs it.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode, compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "calc-tui.ts"), "utf8");

// Everything above the marker: the engine + the pure render/step/hint functions.
const MARKER = "// ==== INTERACTIVE MAIN ====";
const pureCore = source.split(MARKER)[0]!;

/** Build a self-contained program that drives the REAL step()/render() from
 *  calc-tui.ts over a keystroke string, logging each frame + final state. */
function driver(keys: string): string {
  const lit = JSON.stringify(keys);
  return (
    pureCore +
    `
let __st: { expr: string; result: string; done: boolean } = { expr: "", result: "", done: false };
const __keys: string = ${lit};
let __i: number = 0;
while (__i < __keys.length) {
  __st = step(__st, __keys.charAt(__i));
  console.log("frame[" + __st.expr + "|" + __st.result + "|" + __st.done + "]=" + render(__st));
  __i = __i + 1;
}
console.log("hint=" + hintLine());
`
  );
}

describe("examples/calc-tui.ts — pure render/step (differential vs node)", () => {
  const scripts: string[] = [
    "2+3=",          // basic eval
    "12*(3+4)=",     // precedence + parens
    "9=",            // single number
    "2+3=cq",        // eval, clear, quit
    "1+1=xyz",       // unknown keys ignored (letters other than c/q)
    "10/4=",         // decimal result
    "-(2+3)=",       // unary minus + parens
    "5=q",           // quit sets done
  ];
  for (const keys of scripts) {
    test(`keys: ${JSON.stringify(keys)}`, async () => {
      const src = driver(keys);
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
      expect(ours.exitCode).toBe(0);
    });
  }
});

describe("examples/calc-tui.ts — end-to-end piped keystroke script (differential vs node)", () => {
  const stdins: string[] = [
    "2+3=q\n",       // the canonical script
    "12*(3+4)=q\n",  // precedence
    "1+2=c9=q\n",    // eval, clear, eval again, quit
    "7",             // EOF mid-entry (no quit) — loop breaks on empty readKey
    "",              // immediate EOF
  ];
  for (const stdin of stdins) {
    test(`stdin: ${JSON.stringify(stdin)}`, async () => {
      const oracle = runWithNodeIO(source, { stdin });
      const ours = await compileAndRunIO(source, { stdin });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
