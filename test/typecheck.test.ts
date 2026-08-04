/*
 * Runtime-typecheck corpus — the `dyn as T` validator's FAILURE paths.
 *
 * These are a DELIBERATE divergence from node (see docs/divergences.md): `as T` is
 * erased by tsc/node (zero runtime validation), so node prints garbage where our
 * generated validator throws. They therefore can't be gated by the node oracle —
 * like test/ownership/, the contract is asserted by fiat: each program MUST throw
 * (uncaught runtime TypeError → non-zero exit, empty stdout). Semantics mined from
 * io-ts/zod (docs/research/A1-runtime-typecheck.md).
 *
 * The mirror success paths ARE node-differential and live in test/fixtures/stage20/.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";

// Each case: a program whose `as T` narrowing must throw at runtime on a bad shape.
const MUST_THROW: { name: string; code: string }[] = [
  { name: "primitive: string payload as number", code: `const n = JSON.parse("\\"hi\\"") as number; console.log(n);` },
  { name: "primitive: number payload as string", code: `const s = JSON.parse("5") as string; console.log(s);` },
  { name: "primitive: number payload as boolean (no 1->true coercion)", code: `const b = JSON.parse("1") as boolean; console.log(b);` },
  { name: "primitive: null as number", code: `const n = JSON.parse("null") as number; console.log(n);` },
  { name: "object: missing required field", code: `const p = JSON.parse('{"x":1}') as { x: number; y: number }; console.log(p.y);` },
  { name: "object: wrong-typed field", code: `const p = JSON.parse('{"x":"nope","y":2}') as { x: number; y: number }; console.log(p.x);` },
  { name: "object: second field wrong (per-field walk)", code: `const p = JSON.parse('{"x":1,"y":true}') as { x: number; y: number }; console.log(p.y);` },
  { name: "nested: bad inner field", code: `const c = JSON.parse('{"center":{"x":0,"y":"no"},"r":5}') as { center: { x: number; y: number }; r: number }; console.log(c.r);` },
  { name: "wrong kind: array payload as object", code: `const p = JSON.parse('[1,2]') as { x: number }; console.log(p.x);` },
  { name: "wrong kind: object payload as array", code: `const a = JSON.parse('{"x":1}') as number[]; console.log(a.length);` },
  { name: "array: one bad element", code: `const a = JSON.parse('[1,2,"x",4]') as number[]; console.log(a[0]);` },
  { name: "array-of-object: bad element field", code: `const a = JSON.parse('[{"x":1,"y":2},{"x":3}]') as { x: number; y: number }[]; console.log(a[1].x);` },
];

describe("runtime typecheck (dyn as T) — must throw on bad shape", () => {
  for (const c of MUST_THROW) {
    test(c.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tc-"));
      try {
        const bin = join(dir, "p");
        await buildBinary(c.code, bin, { target: "host" }); // must COMPILE (validation is runtime)
        const r = spawnSync(bin, [], { encoding: "utf8" });
        expect(r.stdout).toBe("");          // threw before printing
        expect(r.status).not.toBe(0);       // uncaught runtime TypeError → non-zero exit
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
