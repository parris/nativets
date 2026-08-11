/*
 * AMBIENT TYPE NAMES that used to ERASE to `number` (`NT1035`).
 *
 * `AMBIENT_TYPES` (src/parser.ts) is the set of names TypeScript's own lib declares, so a
 * program may use one without declaring or importing it. It exists so NT2003 ("Cannot find
 * name") can tell "you never declared this" from "this is a global you never have to
 * declare" — and its escape returned control to `resolveNamed`'s last line, which answers
 * `number`. So every name in the set that nothing else claimed became `number`: not just
 * `any`/`unknown`/`never`, but `Function`, `Iterable`, `Generator`, `symbol`, `bigint`,
 * and a BARE `Map`/`Set`/`Promise`/`Record` written without type arguments — 56 of the 62
 * names in the set at the time this was written.
 *
 * Why that is worse than a bad message. `number` is a REAL type, so the erasure is
 * DESTRUCTIVE in exactly the sense `refuseUnknownName` and `NT1033` already document: once
 * `resolveNamed` answers `number` the spelling is gone and no later pass can tell the
 * result from a `number` the user wrote. Three distinct failures came out of it:
 *
 *   - A MISATTRIBUTED diagnostic. `function f(x: unknown): string` was rejected as
 *     "'f' arg 0 expects number, got string" — naming a type the source never contains.
 *   - clang's error, verbatim. `const a = s as unknown` emitted
 *     "'%t1' defined with type 'ptr' but expected 'double'": the erasure reached codegen.
 *   - A SILENT WRONG ANSWER. `a as any[]` re-typed a `string[]` as a `number[]`, and
 *     because BOTH are `ptr` at the LLVM level the verifier had nothing to object to. node
 *     prints `x`; nativets produced no output and exited 255. That is the case this file
 *     exists for — the other two are loud.
 *
 * The refusal lives in the PARSER for the reason NT1033's comment gives: the parser is the
 * last pass that still holds the SPELLING.
 *
 * SCOPE. Only the erasing FALLBACK is refused. A name that resolves honestly is untouched
 * (`Date`, `Error`, `Uint8Array`, `Response`, `Headers`, `URL`, `TextEncoder`), and so is
 * every APPLIED generic that `parseGenericType` maps to a real shape (`Map<K,V>`,
 * `Set<T>`, `Array<T>`, `Partial<T>`, `Record<K,V>`, `Promise<T>`, …). Those are guarded
 * below, because a refusal that swallowed them would be far worse than the erasure.
 *
 * THE RESIDUE. Three names — `unknown`, `never`, `object` — still erase in an ANNOTATION,
 * because src/ uses all three and none has an honest rewrite yet: `never` is a divergent
 * return and the exhaustiveness witness src/ast.ts calls load-bearing, and `unknown` /
 * `object` are the parameter and identity-set types of the reflective AST walks in
 * checker.ts / ownership.ts / codegen.ts. Removing them needs a FEATURE (a bottom type;
 * an opaque unusable `Ty`), not a deletion — see `ERASURE_STILL_ALLOWED` in src/parser.ts.
 * They are refused in an ASSERTION regardless — but that sentence used to end "which is
 * the only position where the erasure was ever a wrong answer rather than a confusing
 * refusal", and that was not true. The refusal is keyed on the ambient NAME, and a body
 * can adopt the erased type one indirection later without naming one:
 *
 *     function asStr(e: unknown): string { return e as string; }
 *     console.log(asStr(42));
 *
 * `e` is a `number` here, the assertion mentions no ambient type, and failure mode 2 above
 * came back verbatim — clang's "'%t0' defined with type 'double' but expected 'ptr'".
 * That is closed in `Checker.type`'s `AsExpr` case rather than here (an assertion across
 * the scalar/reference boundary is NT2001 whatever produced the operand's type), and it is
 * pinned by test/as-cast.test.ts section 3b.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/**
 * Assert the source is REFUSED with the given code, and that the message mentions
 * `needle` — so a case meant to prove "this name cannot be resolved" cannot pass by
 * being rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("ambient type names no longer erase to `number`", () => {
  /*
   * THE SILENT ONE, and the reason this is NT1035 rather than a better message on NT2001.
   * `a as any[]` erases to `number[]`. Both it and `string[]` are `ptr`, so nothing in the
   * pipeline objected: the checker saw a `number[]`, codegen emitted a `double` load
   * against a slot holding a string pointer, and clang's verifier — which caught the
   * scalar version of this bug (`s as unknown`) — had two matching `ptr`s and passed it.
   * node prints "x" then 2; nativets printed nothing at all and exited 255.
   */
  test("`as any[]` no longer launders a string[] into a number[]", () => {
    expectRejected(`
const a: string[] = ["x", "y"];
const b = a as any[];
console.log(b[0]);
`, "NT1035", "any");
  });

  /* `as never` — the assertion form, refused like every other name. */
  test("`as never` is refused", () => {
    expectRejected(`
const s: string = "hello";
const a = s as never;
console.log(a);
`, "NT1035", "never");
  });

  /*
   * THE CLANG ONE. `s as unknown` erased to `number`, and the erasure survived all the way
   * into codegen: the user's error was LLVM's, "'%t1' defined with type 'ptr' but expected
   * 'double'", naming a temporary that does not exist in the source.
   *
   * `unknown` is one of the three names still allowed to erase in an ANNOTATION
   * (`ERASURE_STILL_ALLOWED` — src/ has no rewrite for it yet). In an ASSERTION it is
   * refused like every other name, because that is the position where the erased type is
   * ADOPTED rather than checked.
   */
  test("`as unknown` no longer reaches codegen", () => {
    expectRejected(`
const s: string = "hello";
const a = s as unknown;
console.log(typeof a);
`, "NT1035", "unknown");
  });

  /* The array form of the same laundering, and the reason the residue cannot simply exempt
   * `unknown` everywhere: `unknown[]` erases to `number[]` exactly as `any[]` does. */
  test("`as unknown[]` is refused too", () => {
    expectRejected(`
const a: string[] = ["x"];
const b = a as unknown[];
console.log(b[0]);
`, "NT1035", "unknown");
  });

  /* `bigint` erasing to a double is the erasure at its most dangerous: node's `2n ** 70n`
   * is exact and a double's is not, so the wrong answer would have been silent AND numeric. */
  test("`bigint` and `symbol` are refused rather than erased to a double", () => {
    expectRejected(`
function f(x: bigint): number { return 1; }
console.log(f(1n));
`, "NT1035", "bigint");
    expectRejected(`
function f(x: symbol): number { return 1; }
console.log(f(Symbol("a")));
`, "NT1035", "symbol");
  });

  /*
   * A lib type that is neither a keyword nor a container — the long tail of the set, and
   * the half the original report did not cover. `Function`, `Iterable`, `Generator`,
   * `ArrayBuffer`, `globalThis` and ~40 more all erased the same way.
   */
  test("an unmodelled lib type is refused", () => {
    expectRejected(`
function f(x: Function): number { return 1; }
console.log(f(() => 1));
`, "NT1035", "Function");
    expectRejected(`
function f(x: Iterable<number>): number { return 1; }
console.log(f([1]));
`, "NT1035", "Iterable");
  });

  /*
   * A BARE container. This is the case where the refusal can say exactly what to type, so
   * the hint is asserted too — `Map` alone has no element type, and the erasure meant a
   * `Map` annotation quietly said `number`.
   */
  test("a bare `Map` is refused, and the hint names the fix", () => {
    let err: NTError | undefined;
    try {
      sourceToIR(`function f(m: Map): number { return 1; }\nconsole.log(f(new Map()));\n`);
    } catch (e) { err = e as NTError; }
    expect(err!.diag.code).toBe("NT1035");
    expect(err!.diag.hint).toContain("Map<string, number>");
  });
});

/*
 * THE RESIDUE, pinned so it cannot grow and so its cost is visible.
 *
 * `unknown`, `never` and `object` still erase in an ANNOTATION. That is not a judgement
 * that they are fine — it is that src/ uses all three and none has an honest rewrite that
 * does not cost more than it saves (see `ERASURE_STILL_ALLOWED` in src/parser.ts). These
 * cases assert TODAY'S behavior, and each names the feature that would close it. When one
 * lands, the matching case moves up into the refusal block above.
 */
describe("the erasure residue (3 names, annotation position only)", () => {
  /*
   * THE ORIGINAL REPORT'S HEADLINE, still open. `fail` is well-typed under `tsc --strict`;
   * nativets rejects it naming `number`, a type the source never contains. Closing it
   * needs a BOTTOM type: assignable to everything, inhabited by nothing, and a return type
   * that excuses the missing `return`. That is a checker feature, not a parser refusal —
   * and refusing `never` instead would mean deleting the exhaustiveness witnesses in
   * src/ast.ts, which are load-bearing (`default: { const impossible: never = e; … }`).
   */
  test("`never` in return position still erases — needs a bottom type", () => {
    let err: NTError | undefined;
    try {
      sourceToIR(`
function fail(m: string): never { throw new Error(m); }
function g(): string { return fail("x"); }
console.log(g());
`);
    } catch (e) { err = e as NTError; }
    // Still the misattributed NT2001, and still naming `number` — a word the source does
    // not contain. Pinned, not endorsed: this is the case a bottom type closes.
    expect(err!.diag.code).toBe("NT2001");
    expect(err!.diag.message).toContain("number");
  });

  /* Needs either an opaque unusable `Ty`, or reflective walks the subset can express. */
  test("`unknown` and `object` still erase in an annotation", () => {
    for (const src of [
      `function f(x: unknown): number { return 1; }\nconsole.log(f(1));`,
      `function f(x: object): number { return 1; }\nconsole.log(f({ a: 1 }));`,
    ]) {
      let err: NTError | undefined;
      try { sourceToIR(src); } catch (e) { err = e as NTError; }
      expect(err?.diag.code).not.toBe("NT1035");
    }
  });

  /* The residue is exactly three names and must not grow — every other ambient name is
   * refused in annotation position too. */
  test("the residue does not extend to any other ambient name", () => {
    for (const n of ["any", "symbol", "bigint", "Function", "Iterable", "globalThis", "Map"]) {
      expectRejected(`function f(x: ${n}): number { return 1; }\nconsole.log(f(1));`, "NT1035", n);
    }
  });
});

/*
 * INLINE IMPORT TYPES — `import("./mod").Name` in type position.
 *
 * A RESOLUTION failure rather than an erasure one, but it ends at the same line.
 * `parseImportType` DROPS the module path, adds the bare name to `externalNames` — which
 * is the escape that suppresses NT2003 — and resolves it. When the name is not already in
 * scope under that spelling, that lands on the `number` fallback, so the annotation
 * silently means `number` and the module path the user wrote is never consulted.
 *
 * Live in this tree at src/coverage.ts:167, `new Map<string, import("./ast.ts").Ty>()`:
 * `Ty` is a structural type STRING, and the map's value type quietly became `number`.
 */
describe("inline import types do not erase", () => {
  test("an unresolvable `import(...).T` is refused, naming the module", () => {
    expectRejected(`
function f(x: import("./other.ts").Thing): number { return 1; }
console.log(f("s"));
`, "NT1035", "Thing");
  });

  /*
   * The resolvable half must keep working: when the file ALSO imports the name, the alias
   * is in scope and `import("./m").T` means exactly what `T` means. Refusing that would be
   * a false refusal — the module path is redundant there, not unresolvable.
   */
  test("an `import(...).T` whose name is in scope still resolves", async () => {
    const source = `
type Thing = { n: number };
function f(x: import("./self.ts").Thing): number { return x.n; }
console.log(f({ n: 7 }));
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * THE OTHER HALF OF THE CHANGE, and the more important half to keep green: a refusal that
 * swallowed these would be far worse than the erasure it replaced. Only `resolveNamed`'s
 * erasing FALLBACK is refused, so every name some earlier arm claims must still compile.
 */
describe("names that resolve honestly are untouched", () => {
  /* Claimed by `parseGenericType`, which maps each to a real shape. A bare `Map` is
   * refused above; `Map<string, number>` never reaches `resolveNamed` at all. */
  test("applied generics still resolve", async () => {
    const source = `
const m: Map<string, number> = new Map().set("a", 1);
const s: Set<string> = new Set(["x"]);
const a: Array<number> = [1, 2];
const r: Record<string, number> = new Map().set("b", 2);
const p: Partial<{ a: number }> = { a: 3 };
console.log(m.get("a"), s.has("x"), a[1], r.get("b"), p.a);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /* Claimed by their own arms in `resolveNamed`, above the fallback. */
  test("the modelled ambient types still resolve", async () => {
    const source = `
const b: Uint8Array = new TextEncoder().encode("hi");
const u: URL = new URL("https://example.com/p");
console.log(b.length, u.pathname);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * SPECULATION SAFETY, the trap `refuseUnknownName` documents. `tryCallTypeArgs` parses
   * `<…>` after a primary as a type-argument list and BACKTRACKS on any throw, so a
   * comparison whose right operand happens to spell an ambient name resolves that name
   * speculatively and lands on the new refusal. The throw is what tells the speculation
   * this was not a type, so this must still compile.
   */
  test("the refusal does not leak into a speculative type-argument parse", async () => {
    const source = `
const Set = 3;
const object = 5;
console.log(Set < object, object < Set);
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * `unknown`/`any`/`never` are ordinary identifiers in VALUE position — JavaScript, not
   * TypeScript. The refusal keys on a name, so a guard that leaked out of type position
   * would break plain JS.
   */
  test("the names are still usable as ordinary identifiers", async () => {
    const source = `
const unknown = 1;
const never = 2;
function object(n: number): number { return n + 1; }
console.log(unknown + never, object(unknown));
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * A GENERIC DECLARATION'S OWN TYPE PARAMETERS — `type Box<T> = { v: T }`.
 *
 * The same erasure as the ambient half, from a different source. `skipGenerics`
 * (src/parser.ts) collects a generic declaration's `<T>` names so `refuseUnknownName` will
 * not report NT2003 on them: `T` IS declared, right there in the angle brackets. But the
 * escape returned control to `resolveNamed`'s last line, so `T` in the body answered
 * `number` — and every instantiation of the alias silently became the `number` shape,
 * whatever type argument was written.
 *
 * It reproduces all THREE failures this file's header lists for the ambient half:
 *
 *   - A MISATTRIBUTED diagnostic. `type Arr<T> = T[]; const a: Arr<string> = ["x"]` is
 *     rejected "'a' declared number[] but initialized with string[]" — naming a type the
 *     source never contains, and refusing a program node accepts.
 *   - clang's error, verbatim. `type W<T> = T; const v = s as W<string>; v + 1` emitted
 *     "'%t1' defined with type 'ptr' but expected 'double'". The erasure reached CODEGEN:
 *     nothing in the checker noticed that a string had been retyped to a double.
 *   - A misdirected method refusal — `s as Id<string>` then `.toUpperCase()` reports
 *     "number method 'toUpperCase' is not supported yet" about a value that is a string.
 *
 * Refused as NT1013 (`GENERIC`, "generics need monomorphization"), which is what the gap
 * actually is: a generic type alias needs the type argument SUBSTITUTED, and nothing in
 * this subset does that yet. The refusal costs src/ nothing — the compiler's own source
 * declares zero generic `type`/`interface` aliases, and zero of the 871 fallback
 * resolutions in a linked `src/cli.ts` parse come from this source.
 */
describe("a generic type alias's own parameters no longer erase to `number`", () => {
  /* The misattributed diagnostic: a program node runs, refused for the wrong reason. */
  test("an applied generic alias is refused, not silently retyped to number", () => {
    expectRejected(`type Arr<T> = T[];\nconst a: Arr<string> = ["x"];\nconsole.log(a[0]);\n`, "NT1013", "type parameter 'T'");
  });

  /*
   * THE ONE THAT PROVES IT IS NOT JUST A BAD MESSAGE. In an ASSERTION the named type is
   * ADOPTED rather than checked, so the erasure retyped a `string` to a `double` and
   * NOTHING in the checker objected — it reached clang, which rejected the module with
   * "'%t1' defined with type 'ptr' but expected 'double'". Same escape as `s as unknown`
   * in the ambient half. A build error is the lucky outcome: the two `ptr` case (`a as
   * any[]`) is what LLVM cannot catch, and that one printed nothing and exited 255.
   */
  test("a generic alias in an assertion is refused before it reaches codegen", () => {
    expectRejected(`type W<T> = T;\nconst s = "5";\nconst v = s as W<string>;\nconsole.log(v + 1);\n`, "NT1013", "type parameter 'T'");
  });

  /*
   * THE OVER-REFUSAL GUARD, and the reason the check keys on `genericParamNames` rather
   * than on "there is a `<` after the name". A generic FUNCTION's parameters live in
   * `typeParamScopes` and are monomorphized for real, so they must be untouched — this is
   * the one generic form the subset genuinely supports.
   */
  test("a generic FUNCTION is untouched by the refusal", async () => {
    const source = `
function first<T>(xs: T[]): T { return xs[0]; }
console.log(first<string>(["a", "b"]), first<number>([1, 2]));
`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
