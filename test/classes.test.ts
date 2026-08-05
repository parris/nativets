/*
 * Parameter properties (`constructor(private x: T)`) — behavioral tests, NOT
 * node-differential: node's strip-only TypeScript mode rejects parameter properties
 * ("TypeScript parameter property is not supported in strip-only mode"), so node cannot
 * be the oracle here. Instead we compile our binary and assert exact stdout — the same
 * contract as test/actors.test.ts. The desugaring (field + `this.x = x`) is verified
 * against the semantics TS defines; the value-shaped output pins it.
 *
 * (Field access modifiers and `class X extends Error` ARE node-runnable and live as
 * ordinary node-differential fixtures under test/fixtures/classes/.)
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";

async function run(source: string): Promise<{ stdout: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "classes-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(source, bin, { target: "host" });
    const r = spawnSync(bin, [], { encoding: "utf8" });
    return { stdout: r.stdout, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parameter properties", () => {
  test("private / readonly / public param properties become fields", async () => {
    const source = `
class Point {
  constructor(private x: number, readonly y: number, public label: string) {}
  sum(): number { return this.x + this.y; }
  show(): string { return this.label + ": " + this.x + "," + this.y; }
}
const p = new Point(3, 4, "p");
console.log(p.sum());
console.log(p.y);
console.log(p.label);
console.log(p.show());
`;
    const r = await run(source);
    expect(r.stdout).toBe("7\n4\np\np: 3,4\n");
    expect(r.status).toBe(0);
  });

  test("parameter property combined with extends Error + super (NTError shape)", async () => {
    const source = `
class CodedError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
  describe(): string { return this.message + " (" + this.code + ")"; }
}
const e = new CodedError(42, "bad input");
console.log(e.message);
console.log(e.code);
console.log(e.describe());
`;
    const r = await run(source);
    expect(r.stdout).toBe("bad input\n42\nbad input (42)\n");
    expect(r.status).toBe(0);
  });
});
