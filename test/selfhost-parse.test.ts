/*
 * Self-hosting — the `NT0001` parse tail.
 *
 * After Stage 36 cleared `NT1013`, the top blocker in `nativets coverage src/*.ts`
 * was `NT0001` ("unparsed statement") ×11 — which is not one feature but a handful
 * of small, concrete gaps, each extracted from a real statement in the compiler's
 * own source:
 *
 *   1. `(expr as T)` in a ternary arm misread as an arrow parameter list  (`ast.ts`)
 *   2. nested template literals — a `` ` `` inside a `${…}` substitution   (`ast.ts`, `codegen.ts`)
 *   3. hex / binary / octal numeric literals (`0x22`)                      (`codegen.ts`)
 *   4. postfix `++`/`--` on a member or index target (`this.pos++`)        (`parser.ts`, `coverage.ts`)
 *   5. `instanceof`                                                        (`cli.ts`)
 *   6. binding patterns in parameters (`([k, v]) => …`)                    (`ownership.ts`)
 *   7. a parenthesized type (`(() => Scope) | null`)                       (`checker.ts`)
 *
 * Each fixture below is an ordinary node-runnable program built from the real
 * statement that failed, so node stays the oracle. Kept out of `test/fixtures/**`
 * so no IR snapshot is minted — differential + curated-expected is the gate.
 *
 * Constructs we deliberately do NOT support get a precise NT code instead of a
 * guess; those are asserted in the rejection block at the bottom.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "selfhost-parse");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("NT0001 burn-down (parse + run, differential vs node)", () => {
  for (const name of files) {
    const source = readFileSync(join(DIR, name), "utf8");
    describe(name, () => {
      test("matches node (differential)", async () => {
        const oracle = runWithNode(source);
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });

      test("matches curated expected output", async () => {
        const expected = readFileSync(join(DIR, `${name}.expected`), "utf8");
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(expected);
        expect(ours.exitCode).toBe(0);
      });
    });
  }
});

/** Compile-only; returns the NT diagnostic code (or null when it compiles). */
function codeOf(source: string): string | null {
  try { sourceToIR(source); return null; }
  catch (e) { return e instanceof NTError ? e.diag.code : "NT9001"; }
}

describe("what parses is not what is ALLOWED — precise codes, never a guess", () => {
  test("`o.f++` on an immutable object is NT1606, like `o.f = v`", () => {
    expect(codeOf(`const o = { count: 1 }; o.count++; console.log(o.count);`)).toBe("NT1606");
    expect(codeOf(`const o = { count: 1 }; ++o.count; console.log(o.count);`)).toBe("NT1606");
    // Same verdict as the plain assignment it desugars to — consistency is the point.
    expect(codeOf(`const o = { count: 1 }; o.count = 2;`)).toBe("NT1606");
  });

  test("`this.f++` in a METHOD is allowed as of Stage 45 — but the copy must be handed back", () => {
    // This rule CHANGED. It used to be a flat NT1606 ("only the constructor may write
    // fields"). Stage 45 (decorators) made a field-assigning method legal in two flavors:
    // an ordinary class rebinds `this` to a fresh copy and returns it (copy-on-write), and
    // an `@@mutable` class mutates in place. What is still refused is a setter that would
    // THROW THE COPY AWAY — it would look like a mutation and do nothing.
    const returnsInstance = `class C {\n  private n = 0;\n  bump(): C { this.n++; return this; }\n  get(): number { return this.n; }\n}\nconsole.log(new C().bump().get());\n`;
    expect(codeOf(returnsInstance)).toBe(null);

    const discardsTheCopy = `class C {\n  private n = 0;\n  bump(): number { this.n++; return this.n; }\n}\nconsole.log(new C().bump());\n`;
    expect(codeOf(discardsTheCopy)).toBe("NT1023");

    // ...and the ordinary class really is copy-on-write: the receiver is unchanged.
    const mutable = `@@mutable\nclass M {\n  private n = 0;\n  bump(): M { this.n++; return this; }\n  get(): number { return this.n; }\n}\nconst a = new M();\na.bump();\nconsole.log(a.get());\n`;
    expect(codeOf(mutable)).toBe(null);
  });

  test("`arr[i]++` on an immutable array is NT1606, like `arr[i] = v`", () => {
    expect(codeOf(`const a: number[] = [1, 2]; a[0]++;`)).toBe("NT1606");
    expect(codeOf(`const a: number[] = [1, 2]; a[0] = 9;`)).toBe("NT1606");
  });

  test("`instanceof Error` is NT1022 — nativets models Error structurally, so it cannot decide", () => {
    // `new Error(m)` IS `{message:string}` here (Stage 18), so an Error and a plain
    // record carrying a `message` are the same static type. Answering would be a guess.
    expect(codeOf(`const e = new Error("x"); console.log(e instanceof Error);`)).toBe("NT1022");
    // The suggested discriminant check does compile.
    expect(codeOf(`class E { code: string; constructor(c: string) { this.code = c; } }\nconst e = new E("NT1"); console.log(e.code === "NT1");`)).toBe(null);
  });

  test("`delete o.k` is NT1606 — it is a mutation, named as one instead of 'unparsed'", () => {
    // src/checker.ts's `delete spec.typeParams`. Objects are immutable (Stage 29), so
    // removing a key in place cannot mean what node means; the hint is the rebuild.
    expect(codeOf(`const o = { a: 1, b: 2 }; delete o.a; console.log(o.b);`)).toBe("NT1606");
    expect(codeOf(`const o = { a: 1, b: 2 }; delete o["a"]; console.log(o.b);`)).toBe("NT1606");
  });

  /*
   * `instanceof` is a CONSTANT FOLD, not a runtime test: the checker decides it from the
   * operand's static type and codegen emits `true`/`false`. That is exact only while the
   * static type names ONE thing — the premise the five branches in `InstanceOfExpr` were
   * written against ("a value's static type IS its exact class").
   *
   * A NULLABLE or UNION operand breaks the premise, and it broke it SILENTLY: the arms
   * were applied to the WHOLE type spelling, and every one of them answers `false` on a
   * compound spelling for structural reasons rather than semantic ones. `classTag` reads
   * the tag of `?UDog{…}` as `?UDog`, which is not an identifier, so it answered
   * `undefined`; `isArrayTy` excludes nullables by construction (`!isNullableTy(t)`); and
   * `isMapTy`/`isSetTy`/`isBytesTy` anchor on a prefix that `?U` displaces. So
   *
   *     const d: Dog | undefined = new Dog("rex");  d instanceof Dog    // node: TRUE
   *     const a: number[] | string = [1, 2];        a instanceof Array  // node: TRUE
   *
   * both printed `false` at exit 0 — wrong stdout, invisible to any check that does not
   * diff against node.
   *
   * The rule now decides PER ARM. Where the arms agree the fold is still exact and still
   * happens; where they disagree the answer depends on which arm the value holds at run
   * time, which one compile-time boolean cannot carry, so it is refused.
   */
  test("`instanceof` whose arms DISAGREE is NT1022, never a silent `false`", () => {
    const DOG = `class Dog { name: string; constructor(n: string) { this.name = n; } }\n`;
    expect(codeOf(`${DOG}const d: Dog | undefined = new Dog("rex");\nconsole.log(d instanceof Dog);\n`)).toBe("NT1022");
    expect(codeOf(`${DOG}const d: Dog | null = new Dog("rex");\nconsole.log(d instanceof Dog);\n`)).toBe("NT1022");
    // The built-in arms fold through the same premise and were wrong the same way.
    expect(codeOf(`const a: number[] | undefined = [1, 2];\nconsole.log(a instanceof Array);\n`)).toBe("NT1022");
    expect(codeOf(`const m: Map<string, number> | undefined = new Map<string, number>();\nconsole.log(m instanceof Map);\n`)).toBe("NT1022");
    expect(codeOf(`const s: Set<number> | undefined = new Set<number>();\nconsole.log(s instanceof Set);\n`)).toBe("NT1022");
    expect(codeOf(`const b: Uint8Array | undefined = new Uint8Array(2);\nconsole.log(b instanceof Uint8Array);\n`)).toBe("NT1022");
    // A GENERAL union: one arm is an Array and one is not. Same wrong `false` before.
    expect(codeOf(`function pick(f: boolean): number[] | string { if (f) return [1]; return "hi"; }\nconst a: number[] | string = pick(true);\nconsole.log(a instanceof Array);\n`)).toBe("NT1022");

    // MUTATION GUARDS. The fold must survive wherever the arms AGREE — widen the refusal
    // to "compound operand" and each of these fails.
    expect(codeOf(`${DOG}const d: Dog = new Dog("rex");\nconsole.log(d instanceof Dog);\n`)).toBe(null);
    // Every arm of a nullable NON-array is a non-array: still a decided, compiled `false`.
    expect(codeOf(`const s: string | undefined = "hi";\nconsole.log(s instanceof Map);\n`)).toBe(null);
    // Every arm of a record union is a plain object: `instanceof Array` is a real `false`.
    expect(codeOf(`type A = { kind: "a"; n: number };\ntype B = { kind: "b"; s: string };\nfunction f(x: A | B): void { console.log(x instanceof Array); }\nf({ kind: "a", n: 1 });\n`)).toBe(null);
  });

  test("the arms that still fold answer what node answers", async () => {
    const folds = `type A = { kind: "a"; n: number };
type B = { kind: "b"; s: string };
function f(x: A | B): void { console.log(x instanceof Array); }
f({ kind: "a", n: 1 });
f({ kind: "b", s: "z" });
const s: string | undefined = "hi";
console.log(s instanceof Map);
`;
    const oracle = runWithNode(folds);
    const ours = await compileAndRun(folds);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("false\nfalse\nfalse\n");
  });

  test("the NT1022 nullable hint names a rewrite that compiles AND matches node", async () => {
    const rewritten = `class Dog { name: string; constructor(n: string) { this.name = n; } }
function show(flag: boolean): void {
  const d: Dog | undefined = flag ? new Dog("rex") : undefined;
  console.log(d !== undefined);
}
show(true);
show(false);
`;
    expect(codeOf(rewritten)).toBe(null);
    const oracle = runWithNode(rewritten);
    const ours = await compileAndRun(rewritten);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("true\nfalse\n");
  });

  test("`instanceof` against a non-class / computed right operand is NT1022, not a guess", () => {
    expect(codeOf(`const x = 1; console.log(x instanceof Object);`)).toBe("NT1022");
    expect(codeOf(`const x = 1; const C = 2; console.log(x instanceof 3);`)).toBe("NT1022");
    expect(codeOf(`const x = 1; console.log(x instanceof Function);`)).toBe("NT1022");
  });
});
