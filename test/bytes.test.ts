/*
 * stdlib batch 2 — bytes: Uint8Array + TextEncoder/TextDecoder (UTF-8).
 *
 * Web-standards infra that node/bun/V8 gave us and we now build natively. Backed by
 * runtime/nt_bytes.c (compact byte buffer, one byte per element). node is the oracle
 * for every operation below — construct, index read/write (JS ToUint8 wrap), .length,
 * for-of, and the encode/decode UTF-8 round trip (ASCII + multi-byte).
 *
 * DIVERGENCE (documented): `console.log(u8)` is REJECTED (NT1016), not printed — node's
 * size-dependent, column-grouped typed-array layout (7+ elements => multi-line) is not
 * cheap to match byte-for-byte and the length isn't statically known, so we reject rather
 * than miscompile the format. All other operations match node exactly. Fixtures therefore
 * never `console.log` a Uint8Array directly — they print its elements / length / decode.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile-only: return the NT code a source is rejected with, or null if it compiles. */
function rejectCode(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

describe("bytes: Uint8Array + TextEncoder/TextDecoder match node", () => {
  const CASES: { name: string; code: string }[] = [
    {
      name: "construct by length (zero-filled) + .length",
      code: `const a = new Uint8Array(4); console.log(a.length); console.log(a[0], a[3]);`,
    },
    {
      name: "construct from a number array literal",
      code: `const a = new Uint8Array([10, 20, 30]); console.log(a[0], a[1], a[2]); console.log(a.length);`,
    },
    {
      name: "index read/write with JS ToUint8 wrap (257->1, -1->255, 3.9->3, 256->0)",
      code: `const a = new Uint8Array(4); a[0] = 257; a[1] = -1; a[2] = 3.9; a[3] = 256; console.log(a[0], a[1], a[2], a[3]);`,
    },
    {
      name: "construct-from-array also wraps each element",
      code: `const a = new Uint8Array([256, 257, -1, 1000]); console.log(a[0], a[1], a[2], a[3]);`,
    },
    {
      name: "compound element assignment wraps too",
      code: `const a = new Uint8Array([200]); a[0] += 100; console.log(a[0]);`,
    },
    {
      name: "for-of sum over the bytes",
      code: `const a = new Uint8Array([10, 20, 30, 40]); let s = 0; for (const b of a) { s += b; } console.log(s);`,
    },
    {
      name: "TextEncoder/TextDecoder round-trip: ASCII",
      code: `const enc = new TextEncoder(); const bytes = enc.encode("hello world"); const dec = new TextDecoder(); console.log(bytes.length); console.log(dec.decode(bytes));`,
    },
    {
      name: "TextEncoder/TextDecoder round-trip: multi-byte (é, €)",
      code: `const bytes = new TextEncoder().encode("café €"); const back = new TextDecoder().decode(bytes); console.log(bytes.length); console.log(back); console.log(back === "café €");`,
    },
    {
      name: "encode exposes UTF-8 byte values (é = 0xC3 0xA9)",
      code: `const b = new TextEncoder().encode("é"); console.log(b.length, b[0], b[1]);`,
    },
    {
      name: "encode then iterate the UTF-8 bytes",
      code: `const b = new TextEncoder().encode("AB"); let s = ""; for (const x of b) { s += x + ","; } console.log(s);`,
    },
  ];

  for (const c of CASES) {
    test(c.name, async () => {
      const { ours, oracle } = await expectMatchesNode(c.code);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});

describe("bytes: console.log(Uint8Array) is rejected (NT1016), not miscompiled", () => {
  test("printing a Uint8Array is refused with a diagnostic", () => {
    expect(rejectCode(`const u = new Uint8Array([1, 2, 3]); console.log(u);`)).toBe("NT1016");
  });
  test("index read/for-of/length/decode still compile (the supported surface)", () => {
    expect(rejectCode(`const u = new Uint8Array([1, 2, 3]); console.log(u[0]); console.log(u.length); for (const x of u) console.log(x); console.log(new TextDecoder().decode(u));`)).toBeNull();
  });
});
