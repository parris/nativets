/*
 * THE PENDING EXCEPTION CARRIES AN OBJECT, BY MOVE.
 *
 * Cross-frame `throw` (test/cross-frame-throw.test.ts) rides the runtime's pending-
 * exception slot, and that slot was ONE `const char *`. So a raise could only cross a
 * frame carrying a `string`, or the single-field `{message:string}` that `new Error(m)`
 * is in this subset and `emitExcCheck` rebuilt by boxing the message. Anything richer —
 * and `src/` throws `NTError{message,name,diag:{…}}` at 145 sites — was NT1004.
 *
 * FLATTENING WAS MEASURED AND DEAD. A previous lane priced four payload rules against the
 * linked stage-1 tree: today's rule clears 7 of the 129 NT1004 seed functions, N flat
 * scalar fields clears 20, and a DEEP recursive flatten clears 20 as well — literally
 * zero more, because `NTError.diag` carries `spans?: DiagSpan[]`, an optional ARRAY that
 * no flattening carries. Moving the whole object by POINTER clears 82.
 *
 * THE OWNERSHIP STORY, which is the entire correctness argument:
 *
 *   raise   `nt_exc_raise_obj` TAKES the pointer. The raising frame must NOT drop it, so
 *           the thrown name is subtracted from `ThrowStmt.drops` (ownership.ts).
 *   catch   `nt_exc_take_object` returns it AND NULLS THE SLOT, so the catch binding
 *           becomes the one owner and the handler's existing drop set frees it.
 *   clear   `nt_exc_clear` frees only what nobody took — `catch { }` with no binding.
 *   abort   uncaught → `exit(1)`, nothing to free.
 *   re-raise a raise while one is already pending CLEARS first; that silently leaked.
 *
 * Exactly one owner and exactly one free, and NOTHING IS COPIED — so a nested `diag` is
 * never walked and sharing can never double-free. The `const char *` fast path stays:
 * the runtime itself raises strings (`JSON.parse`, `fs`) and cannot build a typed object.
 *
 * node is the oracle for stdout AND the exit code. The leak probes are SCALED — a
 * fixture whose frame exits proves nothing about a leak proportional to work.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Emit with `NATIVETS_ASAN` forced on (restoring it), then build under ASan+UBSan and run.
 *  Copied in shape from test/asan-instrumentation.test.ts, which is where the reason lives:
 *  ASan only rewrites `define`s carrying `sanitize_address`, and without it a
 *  heap-use-after-free READ is invisible — exit 0 with stale bytes, the exact failure this
 *  lane is most able to introduce. A double free is caught either way (inside `free()`). */
function runUnderAsan(source: string, tag: string): { status: number | null; stdout: string; stderr: string } {
  const prev = process.env["NATIVETS_ASAN"];
  process.env["NATIVETS_ASAN"] = "1";
  let ll = "";
  try { ll = emitIR(source); } finally {
    if (prev === undefined) delete process.env["NATIVETS_ASAN"];
    else process.env["NATIVETS_ASAN"] = prev;
  }
  // Assert the attribute is PRESENT rather than assuming it — an uninstrumented binary
  // that "reports nothing" is not evidence of anything.
  expect(ll).toContain("attributes #99 = { sanitize_address }");
  for (const d of ll.split("\n").filter((l) => l.startsWith("define "))) expect(d.endsWith("#99 {")).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), `nativets-excmove-${tag}-`));
  try {
    const llPath = join(dir, "module.ll");
    writeFileSync(llPath, ll);
    const bin = join(dir, "prog");
    const built = spawnSync("clang", [
      "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
      llPath, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
    ], { encoding: "utf8" });
    expect(built.stderr.includes("error:")).toBe(false);
    expect(built.status).toBe(0);
    const run = spawnSync(bin, [], {
      encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function differential(src: string): Promise<void> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("a raise carries an object across a frame", () => {
  // THE self-hosting shape: `lex` raises a record with more than one field, `tokenize`
  // handles it. The try block also throws the same type itself, so the catch binding's
  // type is inferred today — the checker half is the next describe block.
  test("two fields — one more than the boxed-message shape could hold", async () => {
    await differential([
      `function lex(s: string): number {`,
      `  if (s === "bad") throw { message: "LexError: bad", code: 7 };`,
      `  return s.length;`,
      `}`,
      `function tokenize(s: string): number {`,
      `  try {`,
      `    if (s === "x") throw { message: "direct", code: 1 };`,
      `    return lex(s);`,
      `  } catch (e) {`,
      `    console.log("caught:", e.message, e.code);`,
      `    return -1;`,
      `  }`,
      `}`,
      `console.log(tokenize("ok"));`,
      `console.log(tokenize("bad"));`,
      `console.log(tokenize("x"));`,
      ``,
    ].join("\n"));
  });
});

/*
 * THE CHECKER HALF, and without it the runtime half above is unreachable in real code.
 *
 * `inferThrowType` typed the catch binding from the try block's OWN `throw`s. So the PLAIN
 * idiom — the one `src/parser.ts::tokenize` is written in —
 *
 *     try { return lex(s) } catch (e) { e.message }
 *
 * left the binding at the `"string"` default, and `scanEscaping` rule 3 requires the
 * binding to equal the raised type, so an object payload was unreachable no matter what
 * the slot could hold. The rule now also asks what the block's CALLEES raise.
 */
describe("the catch binding takes its type from what the block's callees raise", () => {
  test("the plain idiom: the try block has no throw of its own", async () => {
    await differential([
      `function lex(s: string): number {`,
      `  if (s === "bad") throw new Error("LexError: bad " + s);`,
      `  return s.length;`,
      `}`,
      `function tokenize(s: string): number {`,
      `  try { return lex(s); } catch (e) { console.log("caught:", e.message); return -1; }`,
      `}`,
      `console.log(tokenize("ok"));`,
      `console.log(tokenize("bad"));`,
      ``,
    ].join("\n"));
  });

  // The stage-1 shape verbatim: a CLASS instance, three fields, one of them a nested
  // record with an ARRAY in it — the `NTError{message,name,diag:{code,spans}}` that made
  // flattening worth exactly zero. The catch binding's type comes from `lex`, which the
  // block never mentions except by calling it.
  test("a class instance with a nested record and an array inside it", async () => {
    await differential([
      `class NTError {`,
      `  message: string;`,
      `  name: string;`,
      `  diag: { code: string, spans: number[] };`,
      `  constructor(m: string, c: string, n: number) {`,
      `    this.message = m; this.name = "NTError"; this.diag = { code: c, spans: [n, n - 1] };`,
      `  }`,
      `}`,
      `function lex(n: number): number {`,
      `  if (n < 0) throw new NTError("bad input", "NT9001", n);`,
      `  return n * 2;`,
      `}`,
      `function run(n: number): number {`,
      `  try { return lex(n); } catch (e) { console.log(e.name, e.message, e.diag.code, e.diag.spans.length); return -1; }`,
      `}`,
      `console.log(run(4));`,
      `console.log(run(-3));`,
      ``,
    ].join("\n"));
  });
});

/*
 * THE OWNERSHIP PROOF. Leaks and double frees are SILENT on macOS (LeakSanitizer is
 * Linux-only), and a fixture that ends at 0 because its frame exited proves nothing about
 * a leak proportional to work. Every probe here runs a LOOP, and each is asserted at TWO
 * scales — the numbers must be IDENTICAL, not merely small.
 */
describe("exactly one owner, exactly one free", () => {
  const raiseLoop = (n: number, handler: string): string => [
    `class E { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }`,
    `function lex(n: number): number {`,
    `  if (n % 2 === 0) throw new E("boom", n);`,
    `  return n;`,
    `}`,
    `function run(n: number): number {`,
    `  try { return lex(n); } ${handler}`,
    `}`,
    `let acc = 0;`,
    `for (let i = 0; i < ${n}; i++) acc = acc + run(i);`,
    `console.log(acc);`,
    `console.log(__objLive(), __strLive());`,
    ``,
  ].join("\n");

  // The BINDING takes the object (`nt_exc_take_object` NULLs the slot) and the handler's
  // own drop set frees it. 200 raises and 2000 raises must both settle at zero.
  test("the catch binding is the owner: no growth at 10x the scale", async () => {
    const small = await compileAndRun(raiseLoop(200, `catch (e) { return e.code; }`));
    const large = await compileAndRun(raiseLoop(2000, `catch (e) { return e.code; }`));
    expect(small.stdout.split("\n")[1]).toBe("0 0");
    expect(large.stdout.split("\n")[1]).toBe("0 0");
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
  });

  // `catch { }` with NO binding takes nothing, so the object would be dropped on the floor
  // — this is the one path where `nt_exc_clear` has to free it, and the only way to tell
  // is that the count does not grow with the loop.
  test("catch with no binding: nt_exc_clear frees what nobody took", async () => {
    const small = await compileAndRun(raiseLoop(200, `catch { return -1; }`));
    const large = await compileAndRun(raiseLoop(2000, `catch { return -1; }`));
    expect(small.stdout.split("\n")[1]).toBe("0 0");
    expect(large.stdout.split("\n")[1]).toBe("0 0");
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
  });

  // The raising frame must NOT free what it just handed over. `throw err` on a NAMED local
  // is the shape where it would: `ownedInScope` lists it, and `ThrowStmt.drops` subtracts
  // it. Were the subtraction missing, the handler would read a freed block — invisible in
  // stdout on macOS, which is why this one runs under ASAN as well, below.
  test("a thrown NAMED local is moved out of the raising frame's drop set", async () => {
    const src = (n: number): string => [
      `class E { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }`,
      `function lex(n: number): number {`,
      `  const err = new E("named", n);`,
      `  if (n % 2 === 0) throw err;`,
      `  return n;`,
      `}`,
      `function run(n: number): number {`,
      // The sentinel `throw` is what types the binding: `throw err` on an IDENTIFIER is a
      // shape `raisedNewTy` cannot type without the callee's own scope, so rule 2 says
      // "cannot say" and the block has to name the type itself. The MOVE under test is
      // `lex`'s, either way.
      `  try { if (n === -7) throw new E("never", 0); return lex(n); }`,
      `  catch (e) { return e.code + e.message.length; }`,
      `}`,
      `let acc = 0;`,
      `for (let i = 0; i < ${n}; i++) acc = acc + run(i);`,
      `console.log(acc);`,
      `console.log(__objLive(), __strLive());`,
      ``,
    ].join("\n");
    const small = await compileAndRun(src(100));
    const large = await compileAndRun(src(1000));
    expect(small.stdout.split("\n")[1]).toBe("0 0");
    expect(large.stdout.split("\n")[1]).toBe("0 0");
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
  });
});

/*
 * ASAN, on the generated code. The counters above prove there is no LEAK; they cannot see
 * the opposite fault. A pointer moved onto the pending slot and ALSO freed by the raising
 * frame is a use-after-free the handler reads and a double free `nt_exc_clear` commits,
 * and on macOS both are silent (LeakSanitizer is Linux-only, so `-fsanitize=address`
 * catches these two and nothing about leaks).
 */
describe("ASan: the move is not a second owner", () => {
  const PROG = `
class E {
  message: string;
  code: number;
  constructor(m: string, c: number) { this.message = m; this.code = c; }
}
function lex(n: number): number {
  const err = new E("boom", n);
  if (n % 2 === 0) throw err;
  return n;
}
function run(n: number): number {
  try { if (n === -7) throw new E("never", 0); return lex(n); }
  catch (e) { return e.code + e.message.length; }
}
let acc = 0;
for (let i = 0; i < 200; i++) acc = acc + run(i);
console.log(acc);
console.log(__objLive(), __strLive());`;

  test("200 moved payloads, read in the handler, are clean under ASan", () => {
    const r = runUnderAsan(PROG, "move");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.stderr).not.toContain("heap-use-after-free");
    expect(r.stderr).not.toContain("double-free");
    expect(r.status).toBe(0);
    // node prints 20300 for the same program, verified by running it (the `__objLive`
    // line is ours alone). The differential describe blocks above are the general oracle;
    // this one hard-codes because the ASan path builds its own binary by hand.
    expect(r.stdout).toBe("20300\n0 0\n");
  });

  // The catch-less handler is where `nt_exc_clear` does the freeing instead. Same program,
  // the other owner.
  test("catch with no binding is clean under ASan too", () => {
    const r = runUnderAsan(PROG.replace("catch (e) { return e.code + e.message.length; }", "catch { return -1; }"), "clear");
    expect(r.stderr).not.toContain("AddressSanitizer");
    expect(r.status).toBe(0);
  });
});

/*
 * THE REFUSALS, and each one's HINT COMPILED against node. A diagnostic that recommends a
 * fix which does not work is worse than one that says nothing, and thirteen of those were
 * found in this tree in a single day.
 */
describe("a block that can raise two shapes is refused, not guessed", () => {
  const TWO_SHAPES = [
    `class A { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }`,
    `function alpha(n: number): number { if (n < 0) throw new A("a", n); return n; }`,
    `function beta(n: number): number { if (n > 9) throw new Error("b"); return n; }`,
    `function run(n: number): number {`,
    `  try { return alpha(n) + beta(n); } catch (e) { return -1; }`,
    `}`,
    `console.log(run(1), run(-1), run(11));`,
    ``,
  ].join("\n");

  // node's `catch` parameter is `any`; ours has exactly one type. Two callees raising two
  // shapes is a union this compiler cannot represent — so it says which two, rather than
  // picking one and storing the other raw into a slot of the wrong shape.
  test("two callees raising different types name both, and refuse", () => {
    expect(() => emitIR(TWO_SHAPES)).toThrow(/can raise both A\{message:string,code:number\} \(from `alpha`\) and \{message:string\} \(from `beta`\)/);
  });

  test("the hint's first fix compiles: split them into separate `try` blocks", async () => {
    await differential([
      `class A { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }`,
      `function alpha(n: number): number { if (n < 0) throw new A("a", n); return n; }`,
      `function beta(n: number): number { if (n > 9) throw new Error("b"); return n; }`,
      `function run(n: number): number {`,
      `  let a = 0;`,
      `  try { a = alpha(n); } catch (e) { return -1; }`,
      `  try { return a + beta(n); } catch (e) { return -1; }`,
      `}`,
      `console.log(run(1), run(-1), run(11));`,
      ``,
    ].join("\n"));
  });

  test("the hint's second fix compiles: make both throw the same type", async () => {
    await differential([
      `class A { message: string; code: number; constructor(m: string, c: number) { this.message = m; this.code = c; } }`,
      `function alpha(n: number): number { if (n < 0) throw new A("a", n); return n; }`,
      `function beta(n: number): number { if (n > 9) throw new A("b", n); return n; }`,
      `function run(n: number): number {`,
      `  try { return alpha(n) + beta(n); } catch (e) { return -1; }`,
      `}`,
      `console.log(run(1), run(-1), run(11));`,
      ``,
    ].join("\n"));
  });
});

/*
 * THE ONE PAYLOAD THE MOVE DOES NOT WIDEN, and the reason it must stay refused: a HOST
 * call's raise really is one `const char *`. `JSON.parse` and `fs` have a message and no
 * typed object to hand over, so a handler binding a richer record has nothing to receive —
 * the case that used to store NOTHING and branch anyway, leaving the binding at whatever
 * its uninitialised alloca held.
 */
describe("a host call still cannot deliver a rich object", () => {
  const HOST_IN_RICH_TRY = [
    `import { readFileSync } from "node:fs";`,
    `function run(p: string): number {`,
    `  try {`,
    `    if (p === "") throw { message: "empty", code: 1 };`,
    `    return readFileSync(p, "utf8").length;`,
    `  } catch (e) {`,
    `    return e.code;`,
    `  }`,
    `}`,
    `console.log(run(""));`,
    ``,
  ].join("\n");

  test("refused, and the message names the binding type it cannot rebuild", () => {
    expect(() => emitIR(HOST_IN_RICH_TRY)).toThrow(/`catch \(e\)` is \{message:string,code:number\}/);
  });

  // The hint's fix, compiled: an inner `try` whose `catch` binds `{message:string}` — the
  // shape a runtime message CAN be boxed into — leaves the outer handler for the record.
  test("the hint's fix compiles: an inner try binding {message:string}", async () => {
    await differential([
      `import { readFileSync } from "node:fs";`,
      `function run(p: string): number {`,
      `  try {`,
      `    if (p === "") throw { message: "empty", code: 1 };`,
      `    try { return readFileSync(p, "utf8").length; }`,
      `    catch (e) { console.log("io:", e.message.length > 0); return -2; }`,
      `  } catch (e) {`,
      `    return e.code;`,
      `  }`,
      `}`,
      `console.log(run(""));`,
      `console.log(run("no-such-file-xyz"));`,
      ``,
    ].join("\n"));
  });
});
