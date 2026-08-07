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

import { buildBinary, sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

async function run(source: string): Promise<{ stdout: string; status: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), "classes-"));
  try {
    const bin = join(dir, "p");
    await buildBinary(source, bin, { target: "host" });
    const r = spawnSync(bin, [], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
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

  // Field initializers combined with a parameter property. Node rejects the parameter
  // property (strip-only), so this too is behavioral. Pins the desugaring ORDER: parameter
  // properties, then field initializers (declaration order), then the constructor body.
  test("field initializers run after param-props and before the ctor body", async () => {
    const source = `
class Cart {
  items: number[] = [10, 20];
  total = 1;
  tag: string;
  constructor(private owner: string, tag: string) {
    this.tag = tag;
    this.total = this.total + 100;   // sees the field-initialized value (1) first
  }
  summary(): string {
    return this.owner + "/" + this.tag + " items=" + this.items.length + " total=" + this.total;
  }
}
const c = new Cart("alice", "vip");
console.log(c.summary());
`;
    const r = await run(source);
    expect(r.stdout).toBe("alice/vip items=2 total=101\n");
    expect(r.status).toBe(0);
  });

  // Field type inferred from a `new Map<…>()` initializer with no annotation (a self-host
  // shape, `private vars = new Map<string, number>()`). `.get` returns `number | undefined`
  // (node-correct), so present values are narrowed with `?? 0` before arithmetic.
  test("field type is inferred from a new Map<…>() initializer", async () => {
    const source = `
class Env {
  private vars = new Map<string, number>();
  private pos = 5;
  seed(): number {
    const v = this.vars.set("a", 1).set("b", 2);
    return (v.get("a") ?? 0) + (v.get("b") ?? 0) + this.pos;
  }
}
const e = new Env();
console.log(e.seed());
`;
    const r = await run(source);
    expect(r.stdout).toBe("8\n");
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

/*
 * `static` members. The happy paths are node-differential fixtures
 * (test/fixtures/classes/static-*.ts) — node runs static methods natively. What lives
 * here is the reject-don't-miscompile edge: a static and an instance method lower to the
 * SAME shape of name (`C.m`) and differ only in the receiver, so each must be reachable
 * exactly one way. Node throws a TypeError at RUNTIME for both mix-ups ("C.show is not a
 * function" / "p.make is not a function"), so it cannot be the oracle for a program we
 * reject at COMPILE time — we reject strictly earlier, which is the intended direction.
 */
describe("static members", () => {
  const CLS = `
class Point {
  x: number;
  constructor(x: number) { this.x = x; }
  static make(): Point { return new Point(1); }
  show(): string { return "x=" + this.x; }
}
const p = Point.make();
`;
  /** Compile far enough to hit parse+check; return the rejection message, else null. */
  function reject(src: string): string | null {
    try {
      sourceToIR(src);
      return null;
    } catch (e) {
      return e instanceof NTError ? `${e.code}: ${e.message}` : String(e);
    }
  }

  test("a STATIC method called through an instance is rejected, not miscompiled", () => {
    const msg = reject(`${CLS}console.log(p.make());\n`);
    expect(msg).toContain("'make' is a static method of Point");
    expect(msg).toContain("Point.make(");
  });

  test("an INSTANCE method called through the class name is rejected", () => {
    const msg = reject(`${CLS}console.log(Point.show(p));\n`);
    expect(msg).toContain("'show' is an instance method of Point");
  });
});
