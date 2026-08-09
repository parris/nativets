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
import type { Diagnostic } from "../src/diagnostics.ts";

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
      // `e.diag.code`, not `e.code`: `NTError` has no `code` field (src/diagnostics.ts
      // carries it on `.diag`), so this rendered "undefined: [NT1015] …" for every case
      // below. The assertions all match on message text, so nothing failed — the code
      // half of the label was simply never there. tsc TS2339; see tsconfig.src.json.
      return e instanceof NTError ? `${e.diag.code}: ${e.message}` : String(e);
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
  // A `C.f` READ is rewritten to the module-level `const C.f` a static field lowers to,
  // and that rewrite is name-based, so a binding that SHADOWS the class name would make it
  // read the wrong thing (node prints 99 here, and we printed 4 — a silent wrong answer,
  // the one outcome the project refuses). Rejected instead.
  test("a binding that shadows a class with static fields is rejected, not miscompiled", () => {
    const msg = reject(`
class Sym {
  static width = 4;
}
function widthOf(Sym: { width: number }): number {
  return Sym.width;
}
console.log(widthOf({ width: 99 }));
`);
    expect(msg).toContain("shadows class 'Sym'");
  });
  // Assignment to a static field. It lowers to a module-level `const`, and nothing in this
  // language reassigns one, so this is a refusal — but it must say THAT, not "'Sym' is not
  // defined", which reads as if the class did not exist. (Node prints 9.)
  test("assigning a static field is refused by name, not as an undefined identifier", () => {
    const msg = reject(`
class Sym {
  static width = 4;
}
Sym.width = 9;
console.log(Sym.width);
`);
    expect(msg).toContain("Sym.width");
    expect(msg).not.toContain("'Sym' is not defined");
  });
});

/*
 * ACCESSORS (`get` / `set`). Deliberately REFUSED, not deferred-by-accident.
 *
 * A getter would make `o.x` sometimes a slot load and sometimes a CALL, and three things
 * downstream assume it is always a slot: the checker's dotted-path narrowing (a fact about
 * `d.spans` is sound only because an undecorated object's field cannot change), linearity
 * (a field read of an object is `NT1605`, a call result is an owned or borrowed value), and
 * codegen's member lowering. That is four stages of work with a real silent-wrong-answer
 * surface, and the CONSTRUCT CENSUS over all twelve `src/*.ts` — counting the construct, not
 * the first blocker, per docs/self-hosting.md's standing correction — finds exactly **one**
 * getter and **zero** setters in the compiler's entire source. So the refusal stands and the
 * one site is rewritten as the method it already is.
 *
 * What has to be true for that to be an honest refusal: the hint must name a rewrite, and
 * the rewrite it names must COMPILE. (docs/self-hosting.md: "advice a diagnostic gives has
 * to compile.")
 */
describe("get / set accessors are refused with a rewrite that compiles", () => {
  // NOTE: the diagnostic lives on `e.diag`. `NTError` has no `.code`/`.hint` of its own —
  // the `${e.code}` in the "static members" helper above renders `undefined` and passes
  // only because its assertions look at the message half.
  function reject(src: string): Diagnostic {
    try {
      sourceToIR(src);
      throw new Error("expected a rejection");
    } catch (e) {
      if (!(e instanceof NTError)) throw e;
      return e.diag;
    }
  }

  test("a `get` accessor is NT1015 and the hint names the method rewrite", () => {
    const e = reject(`
class B {
  private n: number = 0;
  private get doubled(): number { return this.n * 2; }
  show(): number { return this.doubled; }
}
console.log(new B().show());
`);
    expect(e.code).toBe("NT1015");
    expect(e.message).toContain("'get'");
    expect(e.hint).toContain("method");
    expect(e.hint).toContain("()");
  });

  test("a `set` accessor is NT1015 with the same hint", () => {
    const e = reject(`
class B {
  private n: number = 0;
  set v(x: number) { this.n = x; }
}
console.log(1);
`);
    expect(e.code).toBe("NT1015");
    expect(e.hint).toContain("method");
  });

  // The rewrite the hint prescribes, compiled and run. This is the exact shape of
  // `src/codegen.ts`'s sole getter (`private get terminated()` → `private isTerminated()`),
  // and node is the oracle for the value.
  test("the prescribed rewrite compiles and runs (node prints 84)", async () => {
    const r = await run(`
class B {
  private n: number = 42;
  private doubled(): number { return this.n * 2; }
  show(): number { return this.doubled(); }
}
console.log(new B().show());
`);
    expect(r.stdout).toBe("84\n");
    expect(r.status).toBe(0);
  });
});

/*
 * CONSUMING PARAMETERS. A constructor parameter property stores its argument into a slot
 * that outlives the call, so the parameter cannot be a borrow — the caller would still
 * drop the value while the object held a pointer to it. It is a MOVE: rustc's
 * `fn new(d: D) -> Self` against `fn new(d: &D)`, and every `new C(v)` site gives `v` up.
 *
 * These are behavioural, not node-differential, for the same reason as the block above:
 * node's strip-only mode rejects parameter properties outright. The values are checked
 * against a hand-desugared twin run under node, and `__objLive()` / `__arrLive()` carry
 * the memory evidence node cannot.
 */
describe("consuming parameters (constructor parameter properties)", () => {
  // The exact shape that gave EXIT 255 when the NT1604 refusal was suppressed without the
  // move (docs/self-hosting.md): the object escapes the scope that built its field, so a
  // borrow leaves two owners and the value is freed twice. With the move there is one
  // owner. Node's twin prints `[NT1] boom`.
  test("a value moved into a parameter property survives its builder's scope", async () => {
    const r = await run(`
class E {
  constructor(readonly d: {code: string, message: string}) {}
}
function make(c: string, m: string): E {
  const v: {code: string, message: string} = { code: c, message: m };
  return new E(v);
}
function show(): string {
  const e = make("NT1", "boom");
  return "[" + e.d.code + "] " + e.d.message;
}
console.log(show());
`);
    expect(r.stdout).toBe("[NT1] boom\n");
    expect(r.status).toBe(0); // 255 was the double free
  });

  // The object itself is dropped EXACTLY ONCE — `__objLive()` is 0 for it, over 200
  // iterations so a double free would have to be luckier than once. (The array field is a
  // separate, PRE-EXISTING matter: `nt_obj_free` is shallow, so an aggregate reached
  // through a field is never freed. `__arrLive()` records that honestly rather than
  // hiding it; it reads the same on the already-legal `this.xs = [..]` spelling.)
  test("the constructed object is freed exactly once (200 iterations)", async () => {
    const r = await run(`
class Sized {
  n: number;
  constructor(readonly xs: number[]) { this.n = xs.length; }
}
function loop(k: number): number {
  let total = 0;
  for (let i = 0; i < k; i++) {
    const a: number[] = [1, 2, 3];
    const s = new Sized(a);
    total = total + s.n;
  }
  return total;
}
console.log(loop(200));
console.log(__objLive());
console.log(__arrLive());
`);
    expect(r.stdout).toBe("600\n0\n200\n"); // 200 Sized objects freed; the moved arrays are the shallow-free leak
    expect(r.status).toBe(0);
  });

  // MAY-move: the drop flag. `v` is moved on one path and not the other, so the scope must
  // still drop it where it was not moved and must NOT drop it where it was. Node's twin
  // prints 5 then 0.
  test("a value moved on only ONE path is dropped on the other, and never twice", async () => {
    const r = await run(`
class Box { constructor(readonly inner: {x:number}) {} }
function g(flag: boolean): number {
  const v: {x:number} = { x: 5 };
  if (flag) {
    const b = new Box(v);
    return b.inner.x;
  }
  return 0;
}
console.log(g(true));
console.log(g(false));
`);
    expect(r.stdout).toBe("5\n0\n");
    expect(r.status).toBe(0);
  });
});
