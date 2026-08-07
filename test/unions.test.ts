/*
 * SH2 — discriminated (tagged) union types.
 *
 * `docs/self-hosting.md` calls this "the crux" of self-hosting: nativets' own AST
 * (`src/ast.ts` `Expr` / `Stmt`) IS a discriminated union, matched by
 * `switch (node.kind)`. Before this lane the ONLY unions the compiler accepted were
 * the two nullable shapes (`T | undefined`, `T | null`); everything else was NT1009.
 *
 * REPRESENTATION (see `src/ast.ts` — `isUnionTy`): a discriminated union value is
 * just the MEMBER OBJECT POINTER. There is no box: the tag already lives in the
 * value, as the discriminant field, and the union is only accepted when that field
 * sits at the SAME slot index in every member. So `s.kind` on an un-narrowed union
 * is an ordinary slot load, narrowing is a pure retype (zero runtime cost), and
 * every object mechanism — literals, slots, drop — is reused unchanged.
 *
 * node erases types, so every case here runs under plain `node` and node stays the
 * byte-for-byte oracle. Cases are borrowed from the TypeScript conformance suite;
 * each fixture cites the file it came from.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode, compileAndRunFile, runWithNodeFile } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "unions");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("discriminated unions (differential vs node)", () => {
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

/*
 * A union declared in one module and used in another. It needs a DIRECTORY (a
 * multi-module program is not one source string), so it sits beside the flat fixtures
 * rather than in the loop above. What it pins is the alias table crossing the module
 * boundary with its tags intact: the parser stores alias RHSs un-widened so a
 * `{ kind: "square" }` can still become a union member, and `export type`/`import type`
 * carry that same encoding through `src/modules.ts`.
 */
describe("a union crosses a module boundary (SH1 + SH2)", () => {
  const entry = join(DIR, "modular", "main.ts");
  test("matches node (differential)", async () => {
    const oracle = runWithNodeFile(entry);
    const ours = await compileAndRunFile(entry);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
  test("matches curated expected output", async () => {
    expect((await compileAndRunFile(entry)).stdout).toBe(readFileSync(`${entry}.expected`, "utf8"));
  });
});

/** Compile-only; returns the NT diagnostic code (or null when it compiles). */
function codeOf(source: string): string | null {
  try { sourceToIR(source); return null; }
  catch (e) { return e instanceof NTError ? e.diag.code : "NT9001"; }
}
/** Compile-only; returns the diagnostic message (empty when it compiles). */
function messageOf(source: string): string {
  try { sourceToIR(source); return ""; }
  catch (e) { return e instanceof NTError ? e.diag.message : String(e); }
}

const SHAPES = `interface Square { kind: "square"; size: number; }
interface Rectangle { kind: "rectangle"; width: number; height: number; }
interface Circle { kind: "circle"; radius: number; }
type Shape = Square | Rectangle | Circle;
`;

describe("narrowing is the ONLY way to a member's fields — the unsound reads are refused", () => {
  test("a member-specific field on an UN-narrowed union is refused, and says how to fix it", () => {
    const src = `${SHAPES}function f(s: Shape): number { return s.size; }\nconsole.log(f({ kind: "square", size: 1 }));\n`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("narrow it first");
    // ...while the DISCRIMINANT is readable without narrowing (it is in every member).
    expect(codeOf(`${SHAPES}function f(s: Shape): string { return s.kind; }\nconsole.log(f({ kind: "square", size: 1 }));\n`)).toBe(null);
  });

  test("narrowing does not leak past the arm it was proved in", () => {
    const leaks = `${SHAPES}function f(s: Shape): number {
  if (s.kind === "square") { return s.size; }
  return s.size; // NOT narrowed here
}
console.log(f({ kind: "square", size: 1 }));
`;
    expect(codeOf(leaks)).toBe("NT2001");
  });

  test("the ELSE arm of a tag test narrows to the REMAINING members, not to the tested one", () => {
    // Two members ⇒ the else arm is fully narrowed to the other one.
    const two = `interface A { kind: "a"; a: number; }
interface B { kind: "b"; b: number; }
type AB = A | B;
function f(x: AB): number { if (x.kind === "a") { return x.a; } else { return x.b; } }
console.log(f({ kind: "b", b: 7 }));
`;
    expect(codeOf(two)).toBe(null);
    // Three members ⇒ the else arm is a 2-member SUB-union, so a member field is still refused.
    const three = `${SHAPES}function f(s: Shape): number { if (s.kind === "square") { return s.size; } else { return s.width; } }
console.log(f({ kind: "square", size: 1 }));
`;
    expect(codeOf(three)).toBe("NT2001");
  });

  test("FALLTHROUGH cannot be narrowed to the last case's member — the classic unsoundness", () => {
    // Both bodies below are reachable with EITHER tag, so neither may read a member field.
    const shared = `${SHAPES}function f(s: Shape): number {
  switch (s.kind) {
    case "square":
    case "rectangle":
      return s.width; // reachable as a Square too
  }
  return 0;
}
console.log(f({ kind: "square", size: 1 }));
`;
    expect(codeOf(shared)).toBe("NT2001");

    const runsOn = `${SHAPES}function f(s: Shape): number {
  switch (s.kind) {
    case "square":
      s.kind;      // no break — falls into "rectangle"
    case "rectangle":
      return s.width;
  }
  return 0;
}
console.log(f({ kind: "square", size: 1 }));
`;
    expect(codeOf(runsOn)).toBe("NT2001");

    // ...and a `break` restores the narrowing, because nothing can fall in any more.
    const broken = `${SHAPES}function f(s: Shape): number {
  switch (s.kind) {
    case "square":
      break;
    case "rectangle":
      return s.width;
  }
  return 0;
}
console.log(f({ kind: "square", size: 1 }));
`;
    expect(codeOf(broken)).toBe(null);
  });
});

describe("exhaustiveness — a missing arm that would silently produce a value is diagnosed", () => {
  // The rule is deliberately exactly as wide as the DEFECT. Falling out of a switch is
  // ordinary JavaScript and node runs it fine; what node does NOT do is hand back a
  // number. Falling off the end of a `number` function returns `undefined` in node and
  // `0` here (a pre-existing, general divergence) — so the ONE shape that must be
  // covered is the switch that is the function's tail with every arm returning.
  const tail = (cases: string) => `${SHAPES}function area(s: Shape): number {
  switch (s.kind) {
${cases}
  }
}
console.log(area({ kind: "circle", radius: 2 }));
`;

  test("a tail switch missing a member is NT2001 and NAMES the missing tags", () => {
    const src = tail(`    case "square": return s.size * s.size;
    case "rectangle": return s.width * s.height;`);
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain(`"circle"`);
  });

  test("covering every member typechecks, and so does covering the rest with `default`", () => {
    expect(codeOf(tail(`    case "square": return s.size * s.size;
    case "rectangle": return s.width * s.height;
    case "circle": return s.radius;`))).toBe(null);
    expect(codeOf(tail(`    case "square": return s.size * s.size;
    default: return 0;`))).toBe(null);
  });

  test("empty-body FALLTHROUGH still counts as covering its tag", () => {
    expect(codeOf(tail(`    case "square":
    case "rectangle":
      return 4;
    case "circle": return s.radius;`))).toBe(null);
  });

  test("a switch that is NOT the tail needs no coverage — the next statement IS the fallback", () => {
    const withFallback = `${SHAPES}function area(s: Shape): number {
  switch (s.kind) {
    case "square": return s.size * s.size;
  }
  return 0;
}
console.log(area({ kind: "circle", radius: 2 }));
`;
    expect(codeOf(withFallback)).toBe(null);
    // ...nor does one whose arms deliberately fall out of the switch rather than return
    const notTotal = `${SHAPES}function show(s: Shape): void {
  switch (s.kind) {
    case "square": console.log("sq"); break;
  }
}
show({ kind: "circle", radius: 1 });
`;
    expect(codeOf(notTotal)).toBe(null);
  });
});

describe("a union is a LINEAR value — it is the member's object block, and is treated as one", () => {
  test("it is dropped exactly once (no leak, no double free)", async () => {
    // `__objLive()` is objects allocated − freed; the equivalent plain-record program
    // balances to 0, and so must this one. (Not node-differential: __objLive is ours.)
    const src = `interface A { kind: "a"; n: number; }
interface B { kind: "b"; s: string; }
type AB = A | B;
function tag(x: AB): string { return x.kind; }
function run(): void {
  const a: AB = { kind: "a", n: 1 };
  const b: AB = { kind: "b", s: "x" };
  console.log(tag(a) + tag(b));
}
run();
console.log(__objLive());
`;
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe("ab\n0\n");
    expect(ours.exitCode).toBe(0);
  });

  test("use after move is NT1601, exactly as for the record it is", () => {
    const src = `interface A { kind: "a"; n: number; }
interface B { kind: "b"; s: string; }
type AB = A | B;
function tag(x: AB): string { return x.kind; }
const a: AB = { kind: "a", n: 1 };
const b: AB = move(a);
console.log(tag(a));
`;
    expect(codeOf(src)).toBe("NT1601");
  });

  test("binding a union OUT of an array element is NT1605 — the Stage-28 rule, unchanged", () => {
    // A union element is linear, so `const n = nodes[i]` would move it out of the
    // array. Passing it by value (`f(nodes[i])`) borrows and is fine — see
    // test/unions/ast-shape.ts, which is written that way for exactly this reason.
    const shared = `interface A { kind: "a"; n: number; }
interface B { kind: "b"; s: string; }
type AB = A | B;
const xs: AB[] = [{ kind: "a", n: 1 }];
`;
    expect(codeOf(`${shared}const first: AB = xs[0];\nconsole.log(first.kind);\n`)).toBe("NT1605");
    expect(codeOf(`${shared}function tag(x: AB): string { return x.kind; }\nconsole.log(tag(xs[0]));\n`)).toBe(null);
  });
});

describe("a narrowing cannot be invalidated under our feet", () => {
  test("assigning THROUGH a narrowed binding is refused, and says why", () => {
    // node prints `undefined` for `s.size` on a Ci; we would read slot 1 as a number.
    // Tracking the invalidation properly (through loops and nested blocks) is real flow
    // analysis, so the conservative half of reject-don't-miscompile applies.
    const src = `interface Sq { kind: "sq"; size: number; }
interface Ci { kind: "ci"; radius: number; }
type Shape = Sq | Ci;
function f(): number {
  let s: Shape = { kind: "sq", size: 1 };
  if (s.kind === "sq") {
    s = { kind: "ci", radius: 9 };
    return s.size;
  }
  return 0;
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("NARROWED");
    // Reassigning OUTSIDE the arm is fine.
    expect(codeOf(src.replace(`  if (s.kind === "sq") {\n    s = { kind: "ci", radius: 9 };\n    return s.size;\n  }`,
      `  s = { kind: "ci", radius: 9 };\n  if (s.kind === "ci") { return s.radius; }`))).toBe(null);
  });
});

describe("RENDERING an un-narrowed union is refused, never rendered as nothing", () => {
  // Both renderers are generated from the static type. Before this lane a union
  // reached their silent fallbacks: `console.log` printed a bare newline (the
  // Stage-48 defect, off a raw pointer) and `JSON.stringify` printed the literal
  // `null` — measured, not assumed. Narrowed, both are byte-exact (test/unions/render.ts).
  const decl = `interface A { kind: "a"; n: number; }
interface B { kind: "b"; s: string; }
type AB = A | B;
`;
  test("at the ROOT", () => {
    expect(codeOf(`${decl}const x: AB = { kind: "a", n: 1 };\nconsole.log(x);\n`)).toBe("NT1025");
    expect(codeOf(`${decl}const x: AB = { kind: "a", n: 1 };\nconsole.log(JSON.stringify(x));\n`)).toBe("NT1025");
    expect(messageOf(`${decl}const x: AB = { kind: "a", n: 1 };\nconsole.log(x);\n`)).toContain("Narrow it first");
  });

  test("NESTED inside a rendered container — the renderers recurse, so the check does too", () => {
    expect(codeOf(`${decl}const xs: AB[] = [{ kind: "a", n: 1 }];\nconsole.log(xs);\n`)).toBe("NT1025");
    expect(codeOf(`${decl}const o: { v: AB } = { v: { kind: "a", n: 1 } };\nconsole.log(JSON.stringify(o));\n`)).toBe("NT1025");
  });

  test("...and a NARROWED one renders", () => {
    expect(codeOf(`${decl}function f(x: AB): void { if (x.kind === "a") { console.log(x); console.log(JSON.stringify(x)); } }\nf({ kind: "a", n: 1 });\n`)).toBe(null);
  });
});

describe("what a union may BE — refused, never guessed at", () => {
  test("a union of object types with no usable discriminant is NT1009, and says why", () => {
    // no shared field at all
    expect(codeOf(`type T = { a: number } | { b: string };\nconst x: T = { a: 1 };\nconsole.log(x);\n`)).toBe("NT1009");
    // a shared field, but not literal-typed — `kind: string` cannot tell members apart
    const notLiteral = `type T = { kind: string; a: number } | { kind: string; b: string };\nconst x: T = { kind: "p", a: 1 };\nconsole.log(x);\n`;
    expect(codeOf(notLiteral)).toBe("NT1009");
    expect(messageOf(notLiteral)).toContain("string-literal typed");
    // literal-typed, but the SAME literal in both members
    expect(codeOf(`type T = { kind: "a"; x: number } | { kind: "a"; y: number };\nconst v: T = { kind: "a", x: 1 };\nconsole.log(v);\n`)).toBe("NT1009");
  });

  test("the discriminant must sit at the SAME position in every member (the unboxed representation's price)", () => {
    const moved = `type T = { kind: "a"; n: number } | { n: number; kind: "b" };\nconst v: T = { kind: "a", n: 1 };\nconsole.log(v);\n`;
    expect(codeOf(moved)).toBe("NT1009");
    expect(messageOf(moved)).toContain("SAME position");
  });

  test("a SCALAR union is now REPRESENTED (the general-union lane); mixing an object arm in is not", () => {
    // Was NT1009 before this lane — a scalar union is now the `G<…>` tagged box.
    expect(codeOf(`const x: number | string = 1;\nconsole.log(x);\n`)).toBe(null);
    // A general union may only carry arms the BOX can hold and `typeof` can separate;
    // an object arm is neither, so this stays refused rather than half-represented.
    expect(codeOf(`type T = number | { kind: "a" };\nconst v: T = 1;\nconsole.log(v);\n`)).toBe("NT1009");
    // an INTERSECTION is unchanged (still refused)
    expect(codeOf(`type T = { a: number } & { b: number };\nconst v: T = { a: 1, b: 2 };\nconsole.log(v);\n`)).toBe("NT1009");
  });

  test("the two NULLABLE shapes are untouched — they are not general unions", () => {
    // (A bare `undefined` ARGUMENT is a separate, pre-existing gap — `'f' arg 0 expects
    //  ?Unumber, got undefined` — so these pass the nullable through a binding.)
    expect(codeOf(`function f(x: number | undefined): number { return x ?? 0; }\nconst u: number | undefined = undefined;\nconsole.log(f(u));\n`)).toBe(null);
    expect(codeOf(`function f(x: string | null): string { return x ?? "-"; }\nconst n: string | null = null;\nconsole.log(f(n));\n`)).toBe(null);
    // and a union of string literals still COLLAPSES to `string`, as it always did
    expect(codeOf(`type Dir = "n" | "s" | "e" | "w";\nconst d: Dir = "n";\nconsole.log(d.length);\n`)).toBe(null);
  });

  test("constructing a union member: the tag must be a literal the union actually has", () => {
    expect(codeOf(`${SHAPES}const s: Shape = { kind: "hexagon", sides: 6 };\nconsole.log(s.kind);\n`)).toBe("NT2001");
    // a tag that is not a literal expression cannot select a member
    expect(codeOf(`${SHAPES}const k = "square";\nconst s: Shape = { kind: k, size: 1 };\nconsole.log(s.kind);\n`)).toBe("NT2001");
    // the member's OWN fields are still checked against the member it selected
    expect(codeOf(`${SHAPES}const s: Shape = { kind: "square", size: "big" };\nconsole.log(s.kind);\n`)).toBe("NT2001");
  });
});

/*
 * GENERAL unions — arms that are NOT all object types, so there is no discriminant
 * field inside the value and `typeof` must be the discriminant instead.
 *
 * REPRESENTATION (`src/ast.ts` — `isGeneralUnionTy`): encoded `G<a|b>` with members
 * SORTED and de-duplicated, so `number | string` and `string | number` are the SAME
 * type. At runtime it is a 2-slot heap block [tag, value] — the A2 nullable box's
 * shape — where `tag` is the member's index in that canonical order and `value` is
 * the arm packed by the existing `toSlot`. Deliberately NOT `U<…>`: an object union
 * is the bare member pointer, so sharing the prefix would let 30-odd existing
 * `isUnionTy` sites apply unboxed-object logic to a boxed value.
 *
 * Cases here are DERIVED, not mined: there is no TypeScript conformance checkout on
 * this machine. `node` is still the oracle for every runtime-visible one.
 */
describe("GENERAL (non-object) unions — typeof is the discriminant", () => {
  test("1. a `number | string` binding holds either arm, and prints as node does", async () => {
    const src = `const a: number | string = 41;\nconst b: number | string = "hi";\nconsole.log(a);\nconsole.log(b);\n`;
    expect(codeOf(src)).toBe(null);
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  // Behaviors 2 and 3 of the plan are ONE test: the only way to observe that the
  // narrowing happened is to do something the arm allows and the union does not.
  test("2. `typeof x === \"number\"` narrows to the number arm, the else arm to string", async () => {
    const src = `let x: number | string = 41;
if (typeof x === "number") { console.log("n", x + 1); } else { console.log("s", x.toUpperCase()); }
x = "hi";
if (typeof x === "number") { console.log("n", x + 1); } else { console.log("s", x.toUpperCase()); }
`;
    expect(codeOf(src)).toBe(null);
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * `Array.isArray` is folded from the STATIC type — for every other type that is
   * exact. Admitting array arms made it reachable with a union operand, where the
   * static type says nothing and the fold silently answered `false` for an array.
   * That was a real silent wrong answer, found in this lane and fixed here: on a
   * general union it is a RUNTIME test of the box's tag.
   */
  test("3. `Array.isArray` on a union is a RUNTIME tag test, not a static fold", async () => {
    const src = `function f(v: number | number[]): boolean { return Array.isArray(v); }
console.log(f([1, 2, 3]));
console.log(f(7));
`;
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe("true\nfalse\n"); // the fold used to answer "false\nfalse\n"
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * Every operation that reads a union WITHOUT narrowing it. Each one below was
   * measured against node first: three of them silently produced a wrong answer
   * (they read the box's TAG, or the box POINTER, as if it were the value) and two
   * emitted invalid IR. None of them may do that, so all five are refused and the
   * hint says the one thing that fixes every case — narrow with `typeof` first.
   *
   * Implementing them is a genuine next rung (each is a tag dispatch, like the
   * printer already is); refusing is what this lane can be SURE of.
   */
  describe("an operation that would read the box as if it were the value is REFUSED", () => {
    const g = (body: string) => `function f(x: number | string): void { ${body} }\nf(1);\n`;
    test("truthiness — node says 0 and \"\" are falsy; the box pointer is always truthy", () => {
      expect(codeOf(g(`if (x) { console.log("t"); }`))).toBe("NT1009");
      expect(messageOf(g(`if (x) { console.log("t"); }`))).toContain("typeof");
    });
    test("=== between two unions — it compared TAGS, so 1 === 2 was true", () => {
      expect(codeOf(`function f(a: number | string, b: number | string): boolean { return a === b; }\nconsole.log(f(1, 2));\n`)).toBe("NT1009");
    });
    test("string concatenation and template literals", () => {
      expect(codeOf(g(`console.log("v=" + x);`))).toBe("NT1009");
      expect(codeOf(g("console.log(`v=${x}`);"))).toBe("NT1009");
    });
    test("JSON.stringify — it rendered the box as the literal `null`", () => {
      expect(codeOf(g(`console.log(JSON.stringify(x));`))).toBe("NT1009");
    });
    test("...and NARROWING first makes every one of them work", async () => {
      const src = `function f(x: number | string): void {
  if (typeof x === "number") { console.log(!!x, "v=" + x, \`t=\${x}\`, JSON.stringify(x)); }
  else { console.log(!!x, "v=" + x, \`t=\${x}\`, JSON.stringify(x)); }
}
f(0); f(1); f(""); f("a");
`;
      expect(codeOf(src)).toBe(null);
      const ours = await compileAndRun(src);
      const oracle = runWithNode(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  });
});
