/*
 * THE `typeof` OPERATOR — a dispatch whose DEFAULT ARM leaked the internal type spelling.
 *
 * `typeof x` in JavaScript answers from a CLOSED set of eight strings, and only five of
 * them are reachable here: `"undefined"`, `"boolean"`, `"number"`, `"string"`, `"function"`
 * and `"object"` (`"bigint"` and `"symbol"` have no representation in this subset). Every
 * other value in the language — array, record, class instance, `Date`, `URL`, `Map`, `Set`,
 * `Uint8Array`, a tagged union, `null` — is `"object"`. There is no sixth answer.
 *
 * The lowering was written the other way round: it ENUMERATED the object-ish kinds it knew
 * about and let everything else fall through to `inner`, the raw `Ty` encoding. So a kind
 * nobody remembered to list did not fail — it printed the compiler's internal spelling as
 * if that were a JavaScript answer:
 *
 *     const s: Set<string> = new Set<string>(["a", "b"]);
 *     console.log(typeof s);      // node: "object"    nativets, before: "Set<string>"
 *
 * Exit 0, wrong stdout — the worst outcome this project recognises. And it is not cosmetic:
 * `typeof` is a BRANCH primitive, so `if (typeof s === "object")` took the `else` arm, and
 * `typeof x === "object"` is the standard JS spelling of "is this a reference?".
 *
 * SIX kinds were wrong, found by running a 30-kind differential probe against node rather
 * than by reading the code — `Uint8Array`, `TextEncoder`, `TextDecoder`, `Map<K,V>`,
 * `Set<T>` and a discriminated union (which printed its entire member list,
 * `U<{k:"a",v:number}|{k:"b",v:string}>`). `Response`/`Headers` and a nominal type
 * reference `@N` are the same shape and are pinned below too.
 *
 * THE FIX IS THE DIRECTION OF THE DISPATCH, not six more cases. `staticTypeofName`
 * (src/ast.ts) enumerates the FIVE non-object answers and defaults to `"object"`, which is
 * exhaustive by construction: a type kind added tomorrow is an object unless it is a
 * number, string, boolean, undefined or function, and those are closed. The two encodings
 * whose `typeof` is genuinely a RUNTIME fact — the nullable box and the general union —
 * answer `undefined` and are branched on at run time by the caller, and the two that have
 * no value form at all (`Dyn`, an unsubstituted `#T`) answer `undefined` too and reach an
 * internal error rather than a guess. Reject, never miscompile.
 *
 * Cases mined from node itself (the oracle) over the full type universe of `Ty` in
 * src/ast.ts, one fixture per encoding; test262 `language/expressions/typeof/*` is the
 * upstream basis for the closed answer set.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

/** Compile+run ours and assert stdout/exit match `node` on the same source. */
async function matchesNode(src: string): Promise<string> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("typeof answers from JS's closed set, never the internal type spelling", () => {
  /*
   * The reported case, verbatim. `Set` and `Map` are the two kinds a real program hits
   * first, and both printed their own encoding — including the type ARGUMENTS, which is
   * how obvious it is that this is not a JavaScript answer.
   */
  test("`typeof` a Map/Set is \"object\", not `Set<string>`/`Map<string,number>`", async () => {
    expect(
      await matchesNode(
        `const s: Set<string> = new Set<string>(["a", "b"]);\n` +
        `const m: Map<string, number> = new Map<string, number>().set("a", 1);\n` +
        `console.log(typeof s);\n` +
        `console.log(typeof m);\n`,
      ),
    ).toBe("object\nobject\n");
  });

  /*
   * The reason it is not cosmetic: `typeof` is a BRANCH primitive. Before the fix the
   * comparison against "object" was false, so this took the `else` arm on both.
   */
  test("`typeof s === \"object\"` takes the SAME arm as node", async () => {
    expect(
      await matchesNode(
        `const s: Set<string> = new Set<string>(["a"]);\n` +
        `if (typeof s === "object") { console.log("ref"); } else { console.log("prim"); }\n` +
        `const m: Map<string, number> = new Map<string, number>();\n` +
        `console.log(typeof m === "object" ? "ref2" : "prim2");\n`,
      ),
    ).toBe("ref\nref2\n");
  });

  /*
   * The other four kinds the probe caught. The bytes handles are three separate reserved
   * type names, so each one was its own missing case — which is exactly why enumerating
   * the object side is the wrong direction.
   */
  test("`typeof` the bytes handles is \"object\"", async () => {
    expect(
      await matchesNode(
        `const b = new Uint8Array(4);\n` +
        `const e = new TextEncoder();\n` +
        `const d = new TextDecoder();\n` +
        `console.log(typeof b, typeof e, typeof d);\n`,
      ),
    ).toBe("object object object\n");
  });

  /*
   * The worst printer of the set: a discriminated union has no value box, so `inner` was
   * the whole `U<…>` member list and `typeof u` printed a type signature.
   */
  test("`typeof` a discriminated union is \"object\", not its member list", async () => {
    expect(
      await matchesNode(
        `type A = { k: "a"; v: number };\n` +
        `type B = { k: "b"; v: string };\n` +
        `const u: A | B = { k: "a", v: 1 };\n` +
        `console.log(typeof u);\n`,
      ),
    ).toBe("object\n");
  });

  /*
   * A nominal back-edge (`@N`): the value's own static type is the expanded object shape
   * almost everywhere, but a field carrying one is the reference itself.
   */
  test("`typeof` a recursive node read out of a field is \"object\"", async () => {
    expect(
      await matchesNode(
        `type N = { v: number; next: N | undefined };\n` +
        `const leaf: N = { v: 2, next: undefined };\n` +
        `const head: N = { v: 1, next: leaf };\n` +
        `const nx = head.next;\n` +
        `console.log(typeof head, typeof nx);\n`,
      ),
    ).toBe("object object\n");
  });

  /*
   * THE REGRESSION GUARD, and the reason the fix is a direction rather than six cases:
   * every kind that was ALREADY right must stay right. This is the probe's full passing
   * column, one program, differential against node.
   */
  test("every other value kind keeps the answer it already had", async () => {
    expect(
      await matchesNode(
        `const n = 1;\n` +
        `const s = "a";\n` +
        `const b = true;\n` +
        `const u = undefined;\n` +
        `const z: number[] | null = null;\n` +
        `const arr = [1, 2];\n` +
        `const rec = { a: 1 };\n` +
        `const fn = (x: number): number => x;\n` +
        `const dt = new Date(0);\n` +
        `const ur = new URL("https://e.com/");\n` +
        `const sp = new URLSearchParams("a=1");\n` +
        `const er = new Error("boom");\n` +
        `const lit: "a" = "a";\n` +
        `console.log(typeof n, typeof s, typeof b, typeof u, typeof z);\n` +
        `console.log(typeof arr, typeof rec, typeof fn, typeof lit);\n` +
        `console.log(typeof dt, typeof ur, typeof sp, typeof er);\n`,
      ),
    ).toBe(
      "number string boolean undefined object\n" +
      "object object function string\n" +
      "object object object object\n",
    );
  });

  /*
   * A class instance is `Tag{…}`, which `isObjectTy` already matched — pinned separately
   * because it is the kind most likely to be re-encoded later.
   */
  test("`typeof` a class instance is \"object\"", async () => {
    expect(
      await matchesNode(
        `class C { a: number; constructor(a: number) { this.a = a; } }\n` +
        `const c = new C(1);\n` +
        `console.log(typeof c);\n`,
      ),
    ).toBe("object\n");
  });

  /*
   * The two encodings whose `typeof` is a RUNTIME fact must keep branching at run time —
   * they are not served by the static table and a regression here would be silent.
   */
  test("the nullable box still decides `typeof` at run time", async () => {
    expect(
      await matchesNode(
        `function g(b: boolean): string | undefined { return b ? "a" : undefined; }\n` +
        `function h(b: boolean): number[] | null { return b ? [1] : null; }\n` +
        `console.log(typeof g(true), typeof g(false));\n` +
        `console.log(typeof h(true), typeof h(false));\n`,
      ),
    ).toBe("string undefined\nobject object\n");
  });

  /*
   * THE THIRD COPY OF THE SAME DEFECT, through a door neither the report nor the first
   * probe went through. `genTypeofNullable` computes the PRESENT arm's name with its own
   * inline chain, so `Set<string> | undefined` holding a set answered `"Set<string>"` —
   * measured on the pre-fix tree via `git archive`, not assumed. The first probe missed it
   * because the only nullables it tried were `string | undefined` and `number[] | null`,
   * whose bases happen to be kinds the old chain DID enumerate: a probe that only samples
   * the arms already covered proves nothing about the default arm. Both sites now ask
   * `staticTypeofName`, so there is one rule and one copy of it.
   */
  test("the PRESENT arm of a nullable box does not leak the base's spelling either", async () => {
    expect(
      await matchesNode(
        `function gs(b: boolean): Set<string> | undefined { return b ? new Set<string>(["a"]) : undefined; }\n` +
        `function gm(b: boolean): Map<string, number> | undefined { return b ? new Map<string, number>() : undefined; }\n` +
        `function gb(b: boolean): Uint8Array | undefined { return b ? new Uint8Array(2) : undefined; }\n` +
        `function gd(b: boolean): Date | undefined { return b ? new Date(0) : undefined; }\n` +
        `console.log(typeof gs(true), typeof gm(true), typeof gb(true), typeof gd(true));\n` +
        `console.log(typeof gs(false), typeof gm(false), typeof gb(false), typeof gd(false));\n`,
      ),
    ).toBe("object object object object\nundefined undefined undefined undefined\n");
  });

  /*
   * A generic is monomorphized, so `typeof v` inside it is resolved per specialization —
   * including at an object-shaped type argument, which is the arm the old default arm
   * would have answered `Set<string>` for.
   */
  test("`typeof` inside a generic answers per specialization", async () => {
    expect(
      await matchesNode(
        `function kindOf<T>(v: T): string { return typeof v; }\n` +
        `console.log(kindOf<number>(1));\n` +
        `console.log(kindOf<string>("a"));\n` +
        `console.log(kindOf<number[]>([1]));\n`,
      ),
    ).toBe("number\nstring\nobject\n");
  });
});
