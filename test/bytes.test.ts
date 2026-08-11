/*
 * stdlib batch 2 — bytes: Uint8Array + TextEncoder/TextDecoder (UTF-8).
 *
 * Web-standards infra that node/bun/V8 gave us and we now build natively. Backed by
 * runtime/nt_bytes.c (compact byte buffer, one byte per element). node is the oracle
 * for every operation below — construct, index read/write (JS ToUint8 wrap), .length,
 * for-of, and the encode/decode UTF-8 round trip (ASCII + multi-byte).
 *
 * `console.log(u8)` was the one refusal here (NT1016 — node's size-dependent,
 * column-grouped typed-array layout). Stage 49 CLOSED it: that layout is the array
 * layout with the length folded into the opening brace, which the Stage-47 inspect
 * builder already owns, so a Uint8Array now prints exactly like node
 * (`Uint8Array(3) [ 1, 2, 3 ]`) — pinned in `test/console.test.ts`. The fixtures below
 * still print elements / length / decode, which is what they were written to cover.
 */

import { test, expect, describe } from "bun:test";

import { expectMatchesNode, compileAndRun } from "./harness.ts";
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

/*
 * THE LENGTH ARGUMENT, which is the one place this file's byte arithmetic was not done
 * in double space.
 *
 * `nt_bytes_new` did `int64_t n = (int64_t)nd` on the raw argument. For a non-finite or
 * out-of-range double that cast is UNDEFINED in C and the two hosts disagree in the worst
 * possible way — the same split `nt_to_integer_or_infinity` (runtime.c) was written for:
 * arm64 SATURATES to INT64_MAX, so `new Uint8Array(1e30)` tried to allocate it and aborted
 * out of memory; x86-64 yields INT64_MIN, which the old `if (n < 0) n = 0` guard turned
 * into a SILENT length-0 array. Same source, same program, answer decided by the host —
 * and the silent side is the architecture CI runs on.
 *
 * A negative length was wrong on BOTH hosts: node throws `RangeError: Invalid typed array
 * length: -1` and we returned an empty array, exit 0. The header even documented it
 * ("n<0 -> 0") as though it were a decision.
 *
 * `to_uint8` immediately above `nt_bytes_new` already does its arithmetic in double space
 * for exactly this reason, and says so. The length now goes the same way.
 *
 * We PANIC where node throws a catchable RangeError — the established choice for this
 * runtime (`nt_panic_repeat_count`, `nt_panic_str_len`), and documented in
 * docs/divergences.md. What matters here is that the answer is the same on every host.
 */
describe("bytes: an invalid Uint8Array length is refused, identically on every host", () => {
  test("a NEGATIVE length panics — it did not, it silently produced an empty array", async () => {
    const r = await compileAndRun(`const u = new Uint8Array(-1); console.log(u.length);`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("invalid typed array length");
    expect(r.exitCode).not.toBe(0);
  });

  test("a length past 2^53-1 panics rather than depending on the host's cast", async () => {
    for (const n of ["1e30", "Infinity"]) {
      const r = await compileAndRun(`const u = new Uint8Array(${n}); console.log(u.length);`);
      expect({ n, out: r.stdout }).toEqual({ n, out: "" });
      expect({ n, err: r.stderr.includes("invalid typed array length") }).toEqual({ n, err: true });
    }
  });

  /* The CONTROLS. These are the values the fix must not disturb, and each is node's
   * answer: NaN is 0 (ToIndex maps it), a fraction truncates, and 0 is legal. */
  test("NaN, a fraction and zero keep node's answers", async () => {
    const { ours, oracle } = await expectMatchesNode(
      `console.log(new Uint8Array(NaN).length, new Uint8Array(2.7).length, new Uint8Array(0).length);`,
    );
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

describe("bytes: console.log(Uint8Array) prints node's typed-array layout (Stage 49)", () => {
  test("printing a Uint8Array compiles — the old NT1016 refusal is closed", () => {
    expect(rejectCode(`const u = new Uint8Array([1, 2, 3]); console.log(u);`)).toBeNull();
  });
  test("index read/for-of/length/decode still compile (the supported surface)", () => {
    expect(rejectCode(`const u = new Uint8Array([1, 2, 3]); console.log(u[0]); console.log(u.length); for (const x of u) console.log(x); console.log(new TextDecoder().decode(u));`)).toBeNull();
  });
});
