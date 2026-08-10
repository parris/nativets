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
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";
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

  /**
   * A NULLISH guard composes with a TAG narrowing (`E | undefined`) — the behavior the
   * `narrow-nullable.ts` fixture runs against node. What is pinned HERE is the other
   * half: widening a narrowing makes strictly MORE programs compile, so what must not
   * move is the set of programs still REFUSED. See docs/divergences.md.
   */
  describe("a nullish guard leaves something the TAG narrowing can narrow", () => {
    const E = `interface A { kind: "A"; left: number }
interface B { kind: "B"; right: number }
type E = A | B;
function mkA(n: number): E { return { kind: "A", left: n }; }
function optA(n: number, on: boolean): E | undefined { return on ? mkA(n) : undefined; }
`;
    // `optA` BUILDS its value in the arm. It used to be `opt(e: E, on)` returning
    // `on ? e : undefined` — returning a parameter, i.e. moving out of a borrow, which
    // only compiled because a `?:` arm discarded the caller's `consume`. See the note in
    // test/unions/narrow-nullable.ts; the nullish-then-tag narrowing pinned here is
    // unchanged, only the plumbing that produces the `E | undefined` is.
    const f = (body: string) => `${E}function f(e: E | undefined): number { ${body} }\nconsole.log(f(optA(7, true)));\n`;

    test("the guarded-then-narrowed read compiles", () => {
      expect(codeOf(f(`if (!e) return -1; if (e.kind === "A") return e.left; return 0;`))).toBe(null);
      expect(codeOf(f(`if (e === undefined) return -1; switch (e.kind) { case "A": return e.left; } return 0;`))).toBe(null);
      expect(codeOf(f(`if (e !== undefined && e.kind === "A") return e.left; return 0;`))).toBe(null);
    });

    test("...and the reads that were never proved are STILL refused", () => {
      // guarded, but not narrowed — the member's field is not there yet
      expect(codeOf(f(`if (!e) return -1; return e.left;`))).toBe("NT2001");
      // narrowed, but to the OTHER member
      expect(codeOf(f(`if (!e) return -1; if (e.kind === "A") return e.right; return 0;`))).toBe("NT2001");
      // narrowed by ELIMINATION to B, so `.left` is still absent
      expect(codeOf(f(`if (!e) return -1; if (e.kind === "A") { return e.left; } return e.left;`))).toBe("NT2001");
      // read BEFORE the guard
      expect(messageOf(f(`const n = e.left; if (!e) return -1; return n;`))).toContain("possibly undefined");
      // no guard at all
      expect(messageOf(f(`if (e.kind === "A") return e.left; return 0;`))).toContain("possibly undefined");
      // assigned between the proof and the use — the fact is dropped, so is the narrowing
      expect(messageOf(`${E}function f(e: E | undefined, o: E): number { if (!e) return -1; e = o; if (e.kind === "A") return e.left; return 0; }\nconsole.log(f(optA(7, true), mkA(1)));\n`))
        .toContain("possibly undefined");
    });

    test("the DISCRIMINANT alone is readable after only the nullish guard", () => {
      expect(codeOf(`${E}function f(e: E | undefined): string { if (!e) return "none"; return e.kind; }\nconsole.log(f(optA(7, true)));\n`)).toBe(null);
    });
  });

  /**
   * The hint must never prescribe what the program already does. Three shapes reach the
   * "does not exist on a union" message with a tag test ALREADY written, and each one now
   * names its own real cause — and prescribes a workaround that compiles.
   */
  describe("the union field diagnostic says something TRUE about this receiver", () => {
    const E = `interface A { kind: "A"; left: number }
interface B { kind: "B"; right: number }
type E = A | B;
interface Box { inner: E }
function mkA(n: number): E { return { kind: "A", left: n }; }
function mkBox(): Box { return { inner: mkA(7) }; }
`;
    /*
     * This case USED to assert `narrowing tracks a plain NAME, and 'o.inner' is a path`.
     * A dotted path narrows now (see "narrowing a dotted PATH receiver" below), so that
     * sentence became the untruthful one and the shape it described compiles. What is
     * left to assert is the inverse: the hint is GONE because the program works.
     */
    test("a receiver that is a stable PATH is narrowed, not lectured about names", () => {
      const ok = `${E}function f(o: Box): number { if (o.inner.kind === "A") return o.inner.left; return 0; }\nconsole.log(f(mkBox()));\n`;
      expect(codeOf(ok)).toBe(null);
      // ...and the `const` binding the old hint prescribed still works, unchanged
      expect(codeOf(`${E}function f(o: Box): number { const v: E = o.inner; if (v.kind === "A") return v.left; return 0; }\nconsole.log(f(mkBox()));\n`)).toBe(null);
    });

    test("a receiver that is NOT a stable path is told exactly that", () => {
      // A CALL step is not a stable name for a value — the two calls need not even return
      // the same object — so `accessPath` declines it and no tag test can ever narrow it.
      // The `const` prescription is the true advice here, and it compiles.
      const bad = `${E}function f(): number { if (mkBox().inner.kind === "A") return mkBox().inner.left; return 0; }\nconsole.log(f());\n`;
      expect(messageOf(bad)).toContain("narrowing needs a STABLE access path");
      expect(codeOf(`${E}function f(): number { const v: E = mkBox().inner; if (v.kind === "A") return v.left; return 0; }\nconsole.log(f());\n`)).toBe(null);
    });

    test("a receiver already narrowed to a SUB-union is told there are several members left", () => {
      const bad = `${E}function f(e: E): number { switch (e.kind) { case "A": case "B": return e.left; } }\nconsole.log(f(mkA(7)));\n`;
      expect(messageOf(bad)).toContain("MORE THAN ONE member");
      expect(codeOf(`${E}function f(e: E): number { switch (e.kind) { case "A": return e.left; case "B": return e.right; } }\nconsole.log(f(mkA(7)));\n`)).toBe(null);
    });

    test("a plain never-narrowed name still gets the plain advice, spelled with ITS name", () => {
      const bad = `${E}function f(e: E): number { return e.left; }\nconsole.log(f(mkA(7)));\n`;
      expect(messageOf(bad)).toContain("narrow it first");
      expect(messageOf(bad)).toContain('if (e.kind === "A")');
    });
  });

  /**
   * A field in EVERY surviving member, at the SAME slot, with the SAME type, reads
   * without narrowing further — the `test/unions/shared-field.ts` fixture runs the
   * accepting side against node. What is pinned HERE is the boundary, because widening a
   * read makes strictly MORE programs compile and the only thing that can go wrong is
   * accepting one that resolves to the wrong slot.
   *
   * Both refusals below were proved by MUTATION, not by argument. With the slot check
   * deleted from `unionCommonField`, the first program prints `111` (the `other` field)
   * where node prints `222`. With the type check deleted, the second prints
   * `2.1254528236e-314` — a string pointer bit-cast to a double — where node prints
   * `hello`. Each guard is one `if` away from a silent wrong answer, so each has a test.
   */
  describe("a SHARED field is readable, and only when one constant offset can read it", () => {
    test("same slot, same type, every surviving member ⇒ the read compiles", () => {
      const ok = `interface Num { kind: "Num"; value: number }
interface Bin { kind: "Bin"; left: number; right: number }
interface Log { kind: "Log"; left: number; right: number }
type Node = Num | Bin | Log;
function f(n: Node): number { switch (n.kind) { case "Num": return n.value; case "Bin": case "Log": return n.left; } }
console.log(f({ kind: "Bin", left: 1, right: 2 }));
`;
      expect(codeOf(ok)).toBe(null);
    });

    test("present in both members but at DIFFERENT slots ⇒ still refused", () => {
      const bad = `interface A { kind: "A"; n: number; other: number }
interface B { kind: "B"; other: number; n: number }
interface C { kind: "C"; z: number }
type U = A | B | C;
function f(u: U): number { if (u.kind === "C") return -1; return u.n; }
console.log(f({ kind: "B", other: 111, n: 222 }));
`;
      expect(codeOf(bad)).toBe("NT2001");
      expect(messageOf(bad)).toContain("MORE THAN ONE member");
    });

    test("same slot but DIFFERENT types ⇒ still refused (this is the type confusion)", () => {
      const bad = `interface A { kind: "A"; v: number }
interface B { kind: "B"; v: string }
interface C { kind: "C"; z: number }
type U = A | B | C;
function f(u: U): void { if (u.kind === "C") return; console.log(u.v); }
f({ kind: "B", v: "hello" });
`;
      // Reads `u.v` with NO cast on purpose. This fixture used to launder it through
      // `as unknown as string`, which NT1035 now refuses FIRST (the ambient-erasure lane) —
      // so the test still went red-to-green while never reaching the slot/type rule it is
      // named for. A refusal arriving from the wrong door is not evidence for this rule.
      expect(codeOf(bad)).toBe("NT2001");
    });

    test("absent from ONE surviving member ⇒ still refused, whatever the others agree on", () => {
      const bad = `interface A { kind: "A"; v: number }
interface B { kind: "B"; v: number }
interface C { kind: "C"; z: number }
type U = A | B | C;
function f(u: U): number { return u.v; }
console.log(f({ kind: "C", z: 1 }));
`;
      expect(codeOf(bad)).toBe("NT2001");
    });
  });

  /**
   * FIXED — `as` no longer reinterprets a union value at another member's layout.
   *
   * This was pinned here as a KNOWN DEFECT: `Checker.type`'s `AsExpr` case was
   * `{ this.type(e.expr, scope); return e.ty; }`, an identity retype with no check, and
   * codegen handed the same pointer back under the new type. tsc ACCEPTS a
   * union-to-member downcast (the member is a subtype), so nothing anywhere refused it —
   * and where tsc's unsoundness costs an `undefined`, ours cost a slot read at the wrong
   * offset. The fixture below returned `3`, the `square` arm's `side`, read through the
   * `circle` arm's `r`.
   *
   * The fix is the CHECKED cast the old note called for, not a refusal — `src/` itself
   * downcasts in twenty-odd places, including every `as Extract<Expr, {kind:"…"}>`. A
   * `U<…>` value IS the member pointer with the tag inside it, so codegen emits
   * `nt_as_tag` to test that tag at the discriminant's slot and PANIC on a mismatch,
   * the way `dyn as T` (`genDynNarrow`) and `!` (`nt_nonnull`) already do. Only the
   * NARROWING direction pays for it; widening a member to its union is still free.
   *
   * The panic is a deliberate divergence (node erases `as` and answers `undefined`) and
   * is recorded in docs/divergences.md. test/as-cast.test.ts is the full spec.
   */
  test("an `as` downcast to the WRONG union member panics, and never reads the wrong slot", async () => {
    const src = `type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number; label: string };
function bad(s: Shape): number {
  const c = s as { kind: "circle"; r: number };
  return c.r;
}
console.log(bad({ kind: "square", side: 3, label: "hi" }));
`;
    // node erases the cast, so `c.r` is genuinely absent: `undefined`.
    expect(runWithNode(src).stdout).toBe("undefined\n");
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe("");                       // never the old `3`
    expect(ours.stderr).toContain("type assertion failed");
  });

  test("an `as` downcast to the RIGHT union member still works", async () => {
    const src = `type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number; label: string };
function ok(s: Shape): number {
  const c = s as { kind: "circle"; r: number };
  return c.r;
}
console.log(ok({ kind: "circle", r: 3 }));
`;
    expect((await compileAndRun(src)).stdout).toBe(runWithNode(src).stdout);
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

  /**
   * A BRACED case body — `case "x": { … return …; }` — is the shape `src/` writes 181
   * times (counted with our own parser, not grep), because a `case` that needs a local
   * needs a block to declare it in. The terminator then sits inside the block, and the
   * old fallthrough test read only the KIND of the case body's last statement, saw a
   * `BlockStmt`, and concluded "falls through" — so the NEXT case was narrowed to both
   * tags and its member read refused. node runs all of these; every one is a FALSE
   * refusal, never a miscompile (codegen already terminates the block correctly).
   *
   * ORACLE. The TypeScript conformance suite is not on disk, so these are derived, not
   * mined — but every shape below was run through `tsc --strict` as the same
   * `case X: … case "rectangle": return s.width;` program, and tsc's verdict (does the
   * second arm see `Rectangle` alone, or `Rectangle | Square`?) agrees with ours on all
   * twelve, the six that end and the six that fall through. The `switch`-with-`break`
   * one below is the case that separates a correct implementation from a plausible one.
   */
  describe("a case body that DIVERGES inside a block does not fall through", () => {
    const sw = (cases: string) => `${SHAPES}function f(s: Shape): number {
  switch (s.kind) {
${cases}
  }
  return -1;
}
console.log(f({ kind: "square", size: 1 }));
`;
    test("a braced body ending in `return` does not carry its tag into the next case", () => {
      expect(codeOf(sw(`    case "square": { const n = s.size; return n; }
    case "rectangle": return s.width;`))).toBe(null);
    });

    test("...and `throw`, `break` and `continue` end a braced body just as `return` does", () => {
      expect(codeOf(sw(`    case "square": { const n = s.size; throw "" + n; }
    case "rectangle": return s.width;`))).toBe(null);
      expect(codeOf(sw(`    case "square": { const n = s.size; console.log(n); break; }
    case "rectangle": return s.width;`))).toBe(null);
      // `continue` leaves the switch too — it jumps to the enclosing loop's head.
      expect(codeOf(`${SHAPES}function f(xs: Shape[]): number {
  let total = 0;
  for (const s of xs) {
    switch (s.kind) {
      case "square": { continue; }
      case "rectangle": total = total + s.width;
    }
  }
  return total;
}
console.log(f([{ kind: "rectangle", width: 2, height: 3 }]));
`)).toBe(null);
    });

    test("nesting the block deeper does not hide the terminator", () => {
      expect(codeOf(sw(`    case "square": { { const n = s.size; return n; } }
    case "rectangle": return s.width;`))).toBe(null);
    });

    test("an if/else that returns on BOTH arms ends the body; only ONE arm does not", () => {
      expect(codeOf(sw(`    case "square": { if (s.size > 0) { return 1; } else { return 2; } }
    case "rectangle": return s.width;`))).toBe(null);
      // Only the `then` arm returns, so the body can reach its end and fall through.
      expect(codeOf(sw(`    case "square": { if (s.size > 0) { return 1; } }
    case "rectangle": return s.width;`))).toBe("NT2001");
    });

    test("a `try` ends the body only when every way out of it does", () => {
      expect(codeOf(sw(`    case "square": { try { return s.size; } finally { console.log("f"); } }
    case "rectangle": return s.width;`))).toBe(null);
      // The handler falls out of the try, so the body falls through.
      expect(codeOf(sw(`    case "square": { try { return s.size; } catch (e) { console.log("c"); } }
    case "rectangle": return s.width;`))).toBe("NT2001");
    });

    /*
     * THE UNSOUNDNESS THIS FIX HAD TO AVOID. A `break` belonging to an INNER switch
     * leaves that switch, not the case body — so the body still falls through. Reusing
     * the definite-assignment walk only became safe once its own `break`/diverge
     * conflation was fixed (test/definite-assignment.test.ts case 11b); before that,
     * this program would have been accepted and `s.width` read off a Square.
     */
    test("a `break` belonging to an INNER switch does not end the outer case body", () => {
      expect(codeOf(sw(`    case "square": { switch (s.size) { default: break; } }
    case "rectangle": return s.width;`))).toBe("NT2001");
    });

    test("a braced body with a side effect and no terminator still falls through", () => {
      expect(codeOf(sw(`    case "square": { const n = s.size; console.log(n); }
    case "rectangle": return s.width;`))).toBe("NT2001");
      // ...and an EMPTY braced body is the plain fallthrough it looks like
      expect(codeOf(sw(`    case "square": { }
    case "rectangle": return s.width;`))).toBe("NT2001");
    });

    /* The whole point is that these RUN, and run the way node runs them. */
    test("the widened narrowing agrees with node at runtime", async () => {
      const src = `${SHAPES}function area(s: Shape): number {
  switch (s.kind) {
    case "square": { const n = s.size; return n * n; }
    case "rectangle": { const w = s.width; return w * s.height; }
    case "circle": return s.radius;
  }
}
console.log(area({ kind: "square", size: 3 }));
console.log(area({ kind: "rectangle", width: 2, height: 5 }));
console.log(area({ kind: "circle", radius: 7 }));
`;
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
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
    // It now refuses at the READ rather than at the assignment, and the sentence that
    // says why moved with it. `narrowNameInto` declines to narrow a name the region
    // reassigns (the same filter a dotted path takes), instead of narrowing it CONST and
    // erroring on the assignment — because the const form also refused the region that
    // reassigns and never reads a narrowed field, which is `while (n.kind === "x") { …;
    // n = next(); }` and used to compile. Refused either way; this is the message.
    expect(messageOf(src)).toContain("'s' is assigned between it and this read");
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

  /*
   * FLATTENING — `A | (B | C)` is `A | B | C`, so a nested `U<…>` arm contributes its
   * MEMBERS. What matters here is that it widens what is ACCEPTED without weakening the
   * invariant: `unionDiscriminant` still has to prove the tag sits at the same slot index
   * across every SPLICED member, which a nested union guarantees only among its own.
   * `test/unions/flatten-nested.ts` is the runtime half (node-differential).
   */
  test("flattening does not launder a union that would otherwise be refused", () => {
    // The nested arm is fine on its own, and the OUTER arm collides with one of its tags.
    const dupTag = `type Inner = { kind: "a"; x: number } | { kind: "b"; y: number };\n` +
      `type T = { kind: "a"; z: number } | Inner;\nconst v: T = { kind: "b", y: 1 };\nconsole.log(v.kind);\n`;
    expect(codeOf(dupTag)).toBe("NT1009");
    // The nested arm's tag is at slot 0; the outer arm puts it at slot 1.
    const moved = `type Inner = { kind: "a"; x: number } | { kind: "b"; y: number };\n` +
      `type T = { n: number; kind: "c" } | Inner;\nconst v: T = { kind: "a", x: 1 };\nconsole.log(v.kind);\n`;
    expect(codeOf(moved)).toBe("NT1009");
    expect(messageOf(moved)).toContain("SAME position");
    // A nested arm cannot smuggle a NON-object member in either.
    expect(codeOf(`type Inner = { kind: "a" } | { kind: "b" };\ntype T = number | Inner;\nconst v: T = 1;\nconsole.log(v);\n`)).toBe("NT1009");
  });

  test("the nullish HOIST takes exactly one arm — `| null | undefined` is still refused", () => {
    const two = `type A = { kind: "a"; x: number };\ntype B = { kind: "b"; y: number };\n`;
    // one nullish arm among three: hoisted into the existing `?N` encoding
    expect(codeOf(`${two}function f(v: A | B | null): number { return v === null ? 0 : 1; }\nconst n: A | B | null = null;\nconsole.log(f(n));\n`)).toBe(null);
    // ...and `?U` for the undefined arm
    expect(codeOf(`${two}function f(v: A | B | undefined): number { return v === undefined ? 0 : 1; }\nconst n: A | B | undefined = undefined;\nconsole.log(f(n));\n`)).toBe(null);
    // BOTH nullish arms: `?U`/`?N` spells one, so this is refused rather than losing one
    expect(codeOf(`${two}const v: A | B | null | undefined = null;\nconsole.log(v === null);\n`)).toBe("NT1009");
    // a nullish arm does NOT rescue a union that has no discriminant of its own
    expect(codeOf(`const v: { a: number } | { b: number } | null = null;\nconsole.log(v === null);\n`)).toBe("NT1009");
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

/*
 * SH — narrowing a DOTTED PATH, not only a plain name.
 *
 * `if (e.callee.kind === "MemberExpr") { e.callee.property }` is the shape the
 * compiler's own passes are written in (`src/ast.ts` `freshArray`, and 198 further
 * sites across checker/codegen/ownership/parser/ast). Before this it was refused:
 * tag narrowing shadow-DECLARED a name, and `e.callee` has no name to shadow.
 *
 * Reference: TypeScript `tests/cases/compiler/discriminantPropertyCheck.ts` — the
 * conformance file for exactly this (narrowing `foo.kind` where `foo` is itself a
 * property read), and the one `src/checker.ts` already cites for the NULLISH half
 * of path narrowing.
 *
 * SOUNDNESS. A path is narrowable only while it is STABLE between the proof and the
 * use. The rules are the ones the nullish path facts already run under, unchanged:
 * every object along the path must be immutable (no `@@mutable`, no `this`), no `?.`
 * or computed link, and the ROOT NAME must not be assigned in the guard, in the
 * narrowed region, or inside any arrow anywhere in the program. Anything else keeps
 * its NT2001. The refusals below are the load-bearing half of this block.
 */
describe("narrowing a dotted PATH receiver", () => {
  const BOX = `interface A { kind: "A"; left: number }
interface B { kind: "B"; right: string }
type E = A | B;
interface Box { name: string; inner: E }
function mkA(n: number): E { return { kind: "A", left: n }; }
function mkB(s: string): E { return { kind: "B", right: s }; }
`;
  /** Wrap a body that takes a `Box`, and run it against both members. */
  const prog = (body: string) => `${BOX}function f(o: Box): string { ${body} }
console.log(f({ name: "p", inner: mkA(7) }));
console.log(f({ name: "q", inner: mkB("hi") }));
`;


  /** Compile + run the two-member program and assert node agrees byte-for-byte. */
  const expectMatches = async (src: string) => {
    expect(codeOf(src)).toBe(null);
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  };

  test("the ELSE arm of a path tag test narrows to the remaining member", async () => {
    await expectMatches(prog(`if (o.inner.kind === "B") { return "s" + o.inner.right; } return "n" + o.inner.left;`));
  });

  test("a path tag test as an `&&` operand narrows the RIGHT operand", async () => {
    // `src/ast.ts` `freshArray` is written in exactly this shape: an outer tag test on a
    // NAME proves the receiver, and the `&&` right operand then tests a PATH off it.
    await expectMatches(prog(`if (o.inner.kind === "A" && o.inner.left > 3) { return "big"; } return "other";`));
  });

  test("an early-exit guard on a path narrows the REST of the block", async () => {
    await expectMatches(prog(`if (o.inner.kind === "B") return "s" + o.inner.right;
  return "n" + o.inner.left;`));
  });

  test("`switch` on a path discriminant narrows each arm", async () => {
    await expectMatches(prog(`switch (o.inner.kind) { case "A": return "n" + o.inner.left; case "B": return "s" + o.inner.right; }`));
  });

  test("a TWO-STEP path narrows (the compiler's own `e.callee.kind` shape)", async () => {
    const src = `interface Id { kind: "Id"; name: string }
interface Mem { kind: "Mem"; property: string }
type Callee = Id | Mem;
interface Call { kind: "Call"; callee: Callee }
interface Lit { kind: "Lit"; value: number }
type Node = Call | Lit;
function show(e: Node): string {
  if (e.kind === "Call" && e.callee.kind === "Mem") { return "." + e.callee.property; }
  return "other";
}
console.log(show({ kind: "Call", callee: { kind: "Mem", property: "push" } }));
console.log(show({ kind: "Call", callee: { kind: "Id", name: "f" } }));
console.log(show({ kind: "Lit", value: 1 }));
`;
    await expectMatches(src);
  });

  /* ---- the REFUSALS. Each one is a shape where the path is NOT provably stable
   * between the proof and the read, and each was verified by MUTATION: removing the
   * corresponding guard from `narrowPathInto`/`accessPath` makes the program compile and
   * print a wrong answer, not merely a different one. The `o = …` case below prints
   * `n2.1622591016e-314` without the filter — a string pointer read as a double — where
   * node prints `nundefined`. ---- */

  test("REFUSED: the root is REASSIGNED between the proof and the read", () => {
    const src = `${BOX}function f(): string {
  let o: Box = { name: "p", inner: mkA(1) };
  if (o.inner.kind === "A") { o = { name: "q", inner: mkB("boom") }; return "n" + o.inner.left; }
  return "s";
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("'o' is assigned between it and this read");
  });

  test("REFUSED: the root is assigned inside an ARROW anywhere in the program", () => {
    // `closureAssigned`: the arrow may run at any time, so no region scan can bound it.
    // It is refused, but as NT1031 — a write to a captured binding is refused OUTRIGHT
    // and gets there first, so `closureAssigned` is the second lock on this door rather
    // than the first. Asserted as "refused", not as a code, so this case keeps testing
    // the property (never narrowed) if the capture rule is ever widened.
    const src = `${BOX}function f(): string {
  let o: Box = { name: "p", inner: mkA(1) };
  const later = (): void => { o = { name: "q", inner: mkB("boom") }; };
  if (o.inner.kind === "A") { later(); return "n" + o.inner.left; }
  return "s";
}
console.log(f());
`;
    expect(codeOf(src)).not.toBe(null);
  });

  test("REFUSED: an INLINE callback (`map`) writes the root — the one arrow that may", () => {
    // A `map`/`filter`/`reduce` callback runs inline in the enclosing frame, so NT1031
    // deliberately permits the write (see its hint). That makes this the shape where
    // `closureAssigned` is the ONLY thing standing between the proof and a wrong slot.
    const src = `${BOX}function f(): string {
  let o: Box = { name: "p", inner: mkA(1) };
  if (o.inner.kind === "A") {
    const n = [1].map((x: number): number => { o = { name: "q", inner: mkB("boom") }; return x; });
    return "n" + o.inner.left + n.length;
  }
  return "s";
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  test("REFUSED: a `@@mutable` receiver, whose field can be rewritten in place", () => {
    // The aliased-mutation attribute. `g.swap()` rewrites the very field the tag test
    // proved, through a second handle on the same object — so the proof is void.
    const src = `${BOX}@@mutable
class Holder {
  inner: E = mkA(1);
  swap(): Holder { this.inner = mkB("boom"); return this; }
}
function f(h: Holder, g: Holder): string {
  if (h.inner.kind === "A") { g.swap(); return "n" + h.inner.left; }
  return "s";
}
const h = new Holder();
console.log(f(h, h));
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("STABLE access path");
  });

  test("REFUSED: an assignment in the LOOP BODY, so the back-edge cannot see a stale proof", () => {
    const src = `${BOX}function f(): string {
  let o: Box = { name: "p", inner: mkA(1) };
  while (true) {
    if (o.inner.kind === "A") { o = { name: "q", inner: mkB("boom") }; return "n" + o.inner.left; }
    return "s";
  }
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  test("REFUSED: an OPTIONAL link (`?.`), whose result is a fresh nullable", () => {
    const src = `${BOX}interface Outer { b?: Box }
function f(x: Outer): string {
  if (x.b?.inner.kind === "A") { return "n"; }
  return "s";
}
console.log(f({}));
`;
    expect(codeOf(src)).not.toBe(null);
  });

  test("the narrowing does not leak PAST the arm it was proved in", () => {
    const src = prog(`if (o.inner.kind === "A") { return "n" + o.inner.left; } return "n" + o.inner.left;`);
    expect(codeOf(src)).toBe("NT2001");
  });

  test("a tag test on `o.inner` narrows `o.inner` in the arm", async () => {
    const src = prog(`if (o.inner.kind === "A") { return "n" + o.inner.left; } return "s" + o.inner.right;`);
    expect(codeOf(src)).toBe(null);
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * A TAG TEST IN A TERNARY CONDITION — the fifth call site of the one tag-narrowing rule.
 *
 * `if`, `switch`, and the `&&`/`||` short circuit all routed their condition through
 * `Checker.narrowTagsWith`; `ConditionalExpr` was the one conditional form that never
 * did. It already had the NULLISH half (`factsFor`, so `x !== undefined ? x.f : …`
 * worked), which is why the gap read as a nullable problem and is not one: a tag test
 * failed to narrow a ternary whether or not a nullable was anywhere in sight.
 *
 *     function f(e: E): number { return e.kind === "A" ? e.left : 0; }   // NT2001
 *     function g(e: E): number { if (e.kind === "A") return e.left; return 0; }  // fine
 *
 * Two spellings of one program, one accepted — an arbitrary difference in surface
 * syntax, not a soundness line. 54 of the 454 ternaries in `src/` have a tag test in
 * the condition (counted with the compiler's own parser; a line-based grep undercounts
 * the multi-line spellings).
 *
 * The arms take SEPARATE fact frames and SEPARATE child scopes: the consequent is
 * proved the tested tag, the alternate the remaining members. The REFUSALS below are
 * the point of the lane — widening what compiles is where an unsound read gets in —
 * and the path one is verified by MUTATION exactly as the block above is: passing an
 * empty `blocked` set to `narrowTagsWith` makes `neg4` compile and print
 * `2.126700047e-314`, the string pointer `"zzzz"` read as a double, where node prints
 * `undefined`.
 */
describe("a tag test in a `?:` CONDITION narrows both arms", () => {
  const E = `interface A { kind: "A"; left: number }
interface B { kind: "B"; text: string }
type E = A | B;
`;
  /** Run a `?:` body against both members and assert node agrees byte-for-byte. */
  const expectMatches = async (src: string) => {
    expect(codeOf(src)).toBe(null);
    const ours = await compileAndRun(src);
    const oracle = runWithNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  };
  const prog = (body: string) => `${E}function f(e: E): string { return ${body}; }
console.log(f({ kind: "A", left: 7 }));
console.log(f({ kind: "B", text: "hi" }));
`;

  test("the CONSEQUENT gets the tested member (the reported program)", async () => {
    await expectMatches(prog(`e.kind === "A" ? "n" + e.left : "-"`));
  });

  test("the ALTERNATE gets the remaining members — both arms narrow, differently", async () => {
    await expectMatches(prog(`e.kind === "A" ? "n" + e.left : "s" + e.text`));
  });

  test("a NEGATED test swaps which arm gets which", async () => {
    await expectMatches(prog(`e.kind !== "A" ? "s" + e.text : "n" + e.left`));
  });

  test("a NESTED ternary narrows over a three-member union", async () => {
    const src = `interface A { kind: "A"; left: number }
interface B { kind: "B"; text: string }
interface C { kind: "C"; on: boolean }
type E = A | B | C;
function f(e: E): string {
  return e.kind === "A" ? "n" + e.left : e.kind === "B" ? "s" + e.text : "f" + e.on;
}
console.log(f({ kind: "A", left: 7 }));
console.log(f({ kind: "B", text: "hi" }));
console.log(f({ kind: "C", on: true }));
`;
    await expectMatches(src);
  });

  test("a tag test as an `&&` operand of the condition narrows the consequent", async () => {
    await expectMatches(prog(`e.kind === "A" && e.left > 3 ? "big" : "other"`));
  });

  test("a STRING field reads as a string — the wrong slot would print garbage", async () => {
    await expectMatches(prog(`e.kind === "B" ? e.text.toUpperCase() : "NONE"`));
  });

  test("a dotted PATH condition narrows, under the same stability rules", async () => {
    const src = `${E}interface Box { inner: E }
function f(o: Box): string { return o.inner.kind === "A" ? "n" + o.inner.left : "s" + o.inner.text; }
console.log(f({ inner: { kind: "A", left: 7 } }));
console.log(f({ inner: { kind: "B", text: "hi" } }));
`;
    await expectMatches(src);
  });

  test("nullish and tag narrowing COMPOSE in one `?:` condition, in that order", async () => {
    const src = `${E}function f(e: E | undefined): string {
  return e !== undefined && e.kind === "A" ? "n" + e.left : "none";
}
console.log(f({ kind: "A", left: 5 }));
console.log(f({ kind: "B", text: "q" }));
console.log(f(undefined));
`;
    await expectMatches(src);
  });

  /*
   * THE JOIN REGRESSION this lane caused and had to fix. Narrowing makes an arm MORE
   * PRECISE, and that is a way for a widening to REMOVE programs instead of adding them:
   * `e.kind === "A" ? e : f` typed both arms as the whole union before, and joined
   * trivially; narrowed, the arms are the A member and the union, which `joinTernary`
   * (deliberately narrow — only a nullish literal joins with a present arm) reads as two
   * unrelated object types. `e.kind === "A" ? e : e` is worse: `restrictUnion` widens the
   * tag literal away, so nothing downstream can tell the two members share a union.
   * Both compiled on the base tree and were verified to fail with the naive wiring, which
   * is why `ConditionalExpr` falls back to the UN-NARROWED typing when the join fails.
   */
  /*
   * The join is read through the RESULT (`(…).kind`) rather than RETURNED, which is the
   * same spelling the sibling test below uses and it is load bearing. `return e.kind ===
   * "A" ? e : f` moves a parameter out of the function — one allocation, two owners — and
   * under ASan it is an "attempting double-free" that prints NOTHING where node prints
   * `A`/`B`. It compiled only because `Ownership.expr` hard-coded `consume: false` on both
   * arms of a `?:` and so could not see the move; `return e` alone was already NT1604.
   * Reading a field BORROWS, so what this test is actually about — that the join still
   * produces a union whose discriminant is readable — is pinned unchanged.
   */
  test("an arm that is the RECEIVER ITSELF still joins with the union", async () => {
    const src = `${E}function pick(e: E, f: E): string { return (e.kind === "A" ? e : f).kind; }
console.log(pick({ kind: "A", left: 1 }, { kind: "B", text: "x" }));
console.log(pick({ kind: "B", text: "y" }, { kind: "B", text: "x" }));
`;
    await expectMatches(src);
  });

  test("both arms narrowed to DIFFERENT members of one union still join", async () => {
    const src = `${E}function tag(e: E): string { return (e.kind === "A" ? e : e).kind; }
console.log(tag({ kind: "A", left: 1 }));
console.log(tag({ kind: "B", text: "z" }));
`;
    await expectMatches(src);
  });

  /* ---- the REFUSALS ---- */

  test("REFUSED: the WRONG member's field inside an arm", () => {
    const src = prog(`e.kind === "A" ? e.text : "-"`);
    expect(codeOf(src)).toBe("NT2001");
    // Narrowed, and narrowed CORRECTLY: the receiver is the A member here, not the union.
    expect(messageOf(src)).toContain("Property 'text' does not exist on {kind:string,left:number}");
  });

  test("REFUSED: the narrowing does not leak OUTSIDE the ternary", () => {
    const src = `${E}function f(e: E): number { return (e.kind === "A" ? 1 : 2) + e.left; }
console.log(f({ kind: "A", left: 1 }));
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("narrow it first");
  });

  test("REFUSED: the receiver is REASSIGNED inside the arm", () => {
    const src = `${E}function f(): number {
  let e: E = { kind: "A", left: 1 };
  return e.kind === "A" ? ((e = { kind: "B", text: "x" }), e.left) : 0;
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
    // Refused at the READ, not at the assignment — see the note on "assigning THROUGH a
    // narrowed binding" above for why `narrowNameInto` declines rather than shadowing.
    expect(messageOf(src)).toContain("'e' is assigned between it and this read");
  });

  test("REFUSED: a PATH condition whose ROOT is reassigned inside the arm", () => {
    // The mutation case. Without `unstableNames` this compiles and prints a string
    // pointer as a double; node prints `undefined`.
    const src = `${E}interface Box { inner: E }
function f(): number {
  let o: Box = { inner: { kind: "A", left: 1 } };
  return o.inner.kind === "A" ? ((o = { inner: { kind: "B", text: "zzzz" } }), o.inner.left) : 0;
}
console.log(f());
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("'o' is assigned between it and this read");
  });
});

/*
 * DISJUNCTION NARROWING — `if (e.kind === "A" || e.kind === "B")`.
 *
 * WHY THIS IS A NARROWING LANE AND NOT A LAYOUT ONE. The compiler's own headline
 * self-hosting blocker reads
 *
 *     [NT2001] Property 'expr' does not exist on <26-member union> — 'e' is narrowed
 *     here to MORE THAN ONE member, so only the shared tag 'kind' is readable
 *
 * at `src/ast.ts`'s `exprText`, on the line
 *
 *     if (e.kind === "AsExpr" || e.kind === "SatisfiesExpr") return exprText(e.expr);
 *
 * and it was read as evidence that the same-slot rule in `unionCommonField` is too
 * narrow. It is not. A census of every union-field refusal the checker reaches while
 * checking the linked stage-1 program (15 sites) showed the receiver there arriving
 * with all 26 members still live: the `||` proved NOTHING, so the read was tested
 * against the whole union rather than against `{AsExpr, SatisfiesExpr}`. Both of those
 * members carry `expr` at slot 1 with type `Expr`, so `unionCommonField` accepts the
 * read the instant the narrowing is right. The layout rule was never the blocker.
 *
 * `narrowTagsInto` handled the CONJUNCTION polarities only — `&&` when true, `||` when
 * false (De Morgan) — and returned `false` for the other two, which is sound but
 * vacuous. The two missing polarities are the DISJUNCTION: `a || b` when true, and
 * `!(a && b)`. What a disjunction proves is the UNION of what its arms prove, and the
 * multi-tag sub-union that produces is not a new representation — `switch` with
 * fall-through `case`s (`case "A": case "B":`) has produced exactly it since SH2.
 *
 * SOUNDNESS, and it is the whole rule: a disjunction proves something only when EVERY
 * arm constrains the SAME access path. `a.kind === "A" || b.kind === "B"` proves
 * nothing about `a` (the `b` arm may be the true one and `a` may be any member), and
 * keeping one arm's constraint is a wrong-slot read. The two REFUSED tests below are
 * mutation tests for exactly that, and for the union-vs-first-arm error.
 */
describe("a disjunction of tag tests narrows to the SUB-UNION of its arms", () => {
  const AB = `interface A { kind: "A"; expr: string; n: number }
interface B { kind: "B"; expr: string; z: boolean }
interface C { kind: "C"; other: number }
type U = A | B | C;
`;

  test("`||` of two tag tests makes the SHARED field readable in the arm", async () => {
    const src = `${AB}function f(u: U): string {
  if (u.kind === "A" || u.kind === "B") return u.expr;
  return "c" + String(u.other);
}
console.log(f({ kind: "A", expr: "aa", n: 1 }));
console.log(f({ kind: "B", expr: "bb", z: true }));
console.log(f({ kind: "C", other: 7 }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * MUTATION 1 — the union, not the first arm.
   *
   * `disjunctTags` merges both arms' tag sets. Returning only the LEFT arm's set instead
   * (`return l;` in place of the merge) narrows `u` to `A` alone, and the program below
   * then BUILDS CLEAN and the binary dies with SIGSEGV (exit 139) where node prints `hi`
   * at exit 0 — `u` is a `B`, whose slot 1 is the double `pad`, loaded as `A`'s `v`
   * string pointer. Merging keeps `{A, B}`, on which `v` sits at slot 1 in one member
   * and slot 2 in the other, so `unionCommonField` refuses the read. The refusal below
   * is the evidence that the sub-union really is the UNION of the arms.
   */
  test("REFUSED: the sub-union's shared field must still agree on a slot", () => {
    const src = `interface A { kind: "A"; v: string; pad: number }
interface B { kind: "B"; pad: number; v: string }
interface C { kind: "C"; other: number }
type U = A | B | C;
function f(u: U): string {
  if (u.kind === "A" || u.kind === "B") return u.v;
  return "c";
}
console.log(f({ kind: "B", pad: 1, v: "hi" }));
`;
    expect(codeOf(src)).toBe("NT2001");
    expect(messageOf(src)).toContain("MORE THAN ONE member");
  });

  /*
   * MUTATION 2 — every arm must constrain the SAME path.
   *
   * Dropping the `l.p.binding !== r.p.binding || l.p.path !== r.p.path` guard makes the
   * program below compile and print `2.156035505e-314` AT EXIT 0 where node prints
   * `hello` — the sixth appearance of that exact shape (a string pointer loaded as a
   * double) in this project's history. The `b` arm is the true one and proves nothing
   * whatsoever about `a`, which is a `B`.
   *
   * The same mutant on the `string`-valued spelling of this fixture SIGSEGVs instead
   * (a double loaded as a pointer), which is only the same defect pointing the other
   * way; the printable direction is kept here because a silent wrong answer at exit 0
   * is the outcome this project ranks worst and a test should pin the worst one.
   */
  test("REFUSED: a disjunction over two DIFFERENT receivers proves nothing", () => {
    const src = `interface A { kind: "A"; v: number }
interface B { kind: "B"; v: string }
type U = A | B;
function f(a: U, b: U): number {
  if (a.kind === "A" || b.kind === "A") return a.v;
  return -1;
}
console.log(f({ kind: "B", v: "hello" }, { kind: "A", v: 3 }));
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  /* An arm that proves nothing makes the WHOLE disjunction prove nothing — it does not
   * merely contribute no tags. `u.kind === "A" || flag` is true for every member when
   * `flag` is, so keeping the `A` from the left arm is mutation 2 wearing a disguise. */
  test("REFUSED: one non-tag arm sinks the whole disjunction", () => {
    const src = `interface A { kind: "A"; v: number }
interface B { kind: "B"; v: string }
type U = A | B;
function f(u: U, flag: boolean): number {
  if (u.kind === "A" || flag) return u.v;
  return -1;
}
console.log(f({ kind: "B", v: "hello" }, true));
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  test("three arms merge, and the ELSE arm still sees the complement", async () => {
    const src = `interface A { kind: "A"; v: string; a: number }
interface B { kind: "B"; v: string; b: number }
interface C { kind: "C"; v: string; c: number }
interface D { kind: "D"; d: number }
type U = A | B | C | D;
function f(u: U): string {
  if (u.kind === "A" || u.kind === "B" || u.kind === "C") return u.v;
  return "d" + String(u.d);
}
console.log(f({ kind: "A", v: "a", a: 1 }));
console.log(f({ kind: "B", v: "b", b: 2 }));
console.log(f({ kind: "C", v: "c", c: 3 }));
console.log(f({ kind: "D", d: 4 }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /* The OTHER missing polarity. `!(a && b)` is `!a || !b`, so the `if` arm of a negated
   * conjunction is a disjunction and goes down the same path. */
  test("a negated conjunction narrows as the disjunction it is", async () => {
    const src = `interface A { kind: "A"; v: string; a: number }
interface B { kind: "B"; v: string; b: number }
interface C { kind: "C"; other: number }
type U = A | B | C;
function f(u: U): string {
  if (!(u.kind !== "A" && u.kind !== "B")) return u.v;
  return "c";
}
console.log(f({ kind: "A", v: "aa", a: 1 }));
console.log(f({ kind: "B", v: "bb", b: 2 }));
console.log(f({ kind: "C", other: 9 }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /* A disjunction nested under a conjunction reads against what the conjuncts before it
   * already proved — the sequential rule `narrowTagsInto` documents, unchanged. */
  test("a disjunction inside a conjunction composes with it", async () => {
    const src = `interface A { kind: "A"; v: string; a: number }
interface B { kind: "B"; v: string; b: number }
interface C { kind: "C"; other: number }
type U = A | B | C;
function f(u: U): string {
  if (u.kind !== "C" && (u.kind === "A" || u.kind === "B")) return u.v;
  return "c";
}
console.log(f({ kind: "A", v: "aa", a: 1 }));
console.log(f({ kind: "B", v: "bb", b: 2 }));
console.log(f({ kind: "C", other: 9 }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * PRE-EXISTING BUG, found by widening onto it and reproduced on the BASE tree without
   * any of this lane's changes — `switch (o.inner.kind) { case "A": case "B": … }` is
   * enough, and has been since SH2.
   *
   *     InternalError: internal compiler error: .v is not at one slot in every member
   *     of U<{kind:"A",…}|{kind:"B",…}|{kind:"C",…}>
   *
   * The checker and codegen disagreed about the type of a narrowed dotted PATH. The
   * checker types `o.inner` through `narrowedPath`, so `fieldOnBase` sees the two-member
   * SUB-union and `unionCommonField` accepts `.v` at slot 1. Codegen re-derives the base
   * type from the FIELD (`fieldType(Box, "inner")`), which is the full three-member
   * union, and `narrowRead` — which exists precisely to apply the checker's narrowing at
   * the read — handled a nullable and a general (boxed) union but had no arm for a plain
   * discriminated one. So it handed the un-narrowed type back and the `unionCommonField`
   * assertion one frame up fired.
   *
   * That assertion is the reason this was a loud crash rather than a wrong slot, and it
   * is why it stayed hidden: it fires in CODEGEN, and every self-hosting instrument in
   * the tree (`blocker-metric`, `coverage`, `self-host-coverage`) runs the CHECKER only
   * and stops there — the metric's own header says so under "THE CHECKER ONLY". A defect
   * that lives strictly downstream of the checker is invisible to all of them.
   *
   * The retype is FREE and needs no tag test: a discriminated union value IS the member
   * pointer (see `src/ast.ts` `isUnionTy`), so narrowing changes only the layout the
   * slots are read with. `narrowRead`'s own nullable arm already did exactly this for
   * the union INSIDE a box (`isUnionTy(base) && e.ty !== base ? e.ty : base`); the bare
   * case was simply missing.
   */
  test("a dotted PATH narrowed to a sub-union by a `switch` no longer crashes codegen", async () => {
    const src = `interface A { kind: "A"; v: string; a: number }
interface B { kind: "B"; v: string; b: number }
interface C { kind: "C"; other: number }
type U = A | B | C;
interface Box { inner: U }
function f(o: Box): string {
  switch (o.inner.kind) {
    case "A": case "B": return o.inner.v;
    default: return "c";
  }
}
console.log(f({ inner: { kind: "A", v: "aa", a: 1 } }));
console.log(f({ inner: { kind: "B", v: "bb", b: 2 } }));
console.log(f({ inner: { kind: "C", other: 9 } }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /* A disjunction over a dotted PATH takes the `NarrowFact` road, not the shadow-binding
   * one, and so inherits the stability rules `narrowPathInto` already enforces. */
  test("a disjunction narrows a dotted PATH too", async () => {
    const src = `interface A { kind: "A"; v: string; a: number }
interface B { kind: "B"; v: string; b: number }
interface C { kind: "C"; other: number }
type U = A | B | C;
interface Box { inner: U }
function f(o: Box): string {
  if (o.inner.kind === "A" || o.inner.kind === "B") return o.inner.v;
  return "c";
}
console.log(f({ inner: { kind: "A", v: "aa", a: 1 } }));
console.log(f({ inner: { kind: "B", v: "bb", b: 2 } }));
console.log(f({ inner: { kind: "C", other: 9 } }));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * The `?:` UN-NARROWED FALLBACK MUST NOT POISON THE AST.
 *
 * `Checker.type`'s `ConditionalExpr` types the arms in their NARROWED scopes, and when the
 * join fails it re-types them un-narrowed and takes that instead. But `this.type` WRITES
 * the type it computes onto the AST nodes, and codegen reads them back — so the fallback is
 * a MUTATION, not a query. On `x.kind === "Neg" ? x.inner : x` it retypes the receiver `x`
 * to the un-narrowed union and only THEN throws on `.inner` (unreadable there), and the
 * `catch` swallows the throw but not the damage.
 *
 * This is LATENT, not live: every path that reaches the damaged state also re-throws, so
 * codegen never sees the AST. It becomes a wrong answer the moment any widening rescues the
 * join after that point — `lane-unionfit` measured exactly that, an `InternalError` from
 * codegen ("not at one slot in every member") instead of a refusal, and had to place its
 * widening BEFORE the fallback to avoid it. Ordering is the right habit but a fragile
 * guarantee, so the fallback now restores the narrowed typing when it does not take.
 *
 * Asserted on the AST rather than through a compiled program precisely BECAUSE the defect
 * is unreachable today: there is no source text that can observe it yet, and a test that
 * waits for one is a test that arrives after the regression.
 *
 * THE SOURCE HAS NO CONTEXTUAL TYPE, and that is now load bearing rather than incidental.
 * This case was originally written at a `return` inside `function f(x: E): E`, where the
 * declared return type is a hint — and the contextual-union rule below rescues exactly
 * that join, so the fallback is never reached and the arms are never re-typed. Binding to
 * an un-annotated `const` instead leaves `hint` undefined, which is still a live path (a
 * `?:` in an intermediate binding, an argument to an untyped position) and the only one
 * that reaches the fallback at all. If a later lane makes THIS shape join too, the
 * fallback becomes genuinely dead and should be deleted rather than re-propped.
 */
describe("the `?:` un-narrowed fallback restores the AST when it does not take", () => {
  const SRC = `interface Neg { kind: "Neg"; inner: E }
interface Lit { kind: "Lit"; v: number }
type E = Neg | Lit;
function f(x: E): string { const y = x.kind === "Neg" ? x.inner : x; return y.kind; }
console.log(f({ kind: "Lit", v: 1 }));
`;

  /** The `ty` the checker left on the CONSEQUENT's receiver (`x` in `x.inner`). */
  function consequentReceiverTy(src: string): { refused: string | null; ty: unknown } {
    const prog = parse(src);
    let refused: string | null = null;
    try { check(prog); } catch (e) { refused = e instanceof NTError ? e.diag.code : "THREW"; }
    let cond: Record<string, unknown> | null = null;
    const seen = new Set<unknown>();
    const walk = (n: unknown): void => {
      if (n === null || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      const o = n as Record<string, unknown>;
      if (o.kind === "ConditionalExpr" && cond === null) cond = o;
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(prog);
    const con = (cond as Record<string, unknown> | null)?.consequent as Record<string, unknown> | undefined;
    return { refused, ty: (con?.object as Record<string, unknown> | undefined)?.ty };
  }

  test("a fallback that throws leaves the NARROWED type on the arm, not the union", () => {
    const { refused, ty } = consequentReceiverTy(SRC);
    // The program itself is still refused — this test widens nothing.
    expect(refused).toBe("NT2001");
    // `x` inside `x.inner` must still carry the narrowed Neg member. Before the restore it
    // held the whole union, which is the state codegen reports as
    // "not at one slot in every member".
    expect(String(ty)).toContain("inner");
    expect(String(ty)).not.toContain("U<");
  });
});

/*
 * THE CONTEXTUAL-UNION `?:` JOIN — the last of the three ternary blockers on the stage-1
 * frontier, and the one that stalled `src/ast.ts`'s `walkStmtChildren`:
 *
 *     init: s.init === null ? null
 *         : s.init.kind === "VarDecl" ? (fs(s.init) as VarDecl) : fe(s.init),
 *
 * where `ForStmt.init` is declared `VarDecl | Expr | null`. NOTE WHAT THE ARMS ARE. This is
 * NOT "a union member joined with its own union", the shape a CALL already accepts through
 * `fitsParam` — NEITHER ARM IS THE UNION. One arm is a MEMBER (`VarDecl`), the other is a
 * SUB-UNION (`Expr`, itself two members), and the union they both belong to is the CONTEXT:
 * the declared type of the place the `?:` is written into. `joinTernary` is a free function
 * over the two ARM types alone, so this answer is not derivable from its inputs at all — a
 * widening that only inspects the arms cannot close it, and one that tried was measured
 * closing zero blockers.
 *
 * Nor is it recoverable by synthesizing `U<a|b>` from the arms: an arm's type arrives with
 * its tag already WIDENED (`{kind:string,name:string}`), and a union needs the string-
 * LITERAL tags to have a discriminant at all. The contextual type is the only place that
 * literal spelling still exists, which is why the rule reads the hint rather than the arms.
 *
 * SOUND for the reason `fitsParam`'s union arm and `genAsCast`'s case (3) already rely on:
 * THERE IS NO BOX. A `U<…>` value is the member object pointer, codegen's `coerce` is the
 * identity for member -> union, and membership is decided by `assignable`'s union arm,
 * which is IDENTITY against `unionWidenedMembers` and never the structural-object rule — so
 * a record that merely LOOKS like a member stays refused (`over-accept` below).
 */
describe("a `?:` whose arms are members of ONE CONTEXTUAL union joins to that union", () => {
  // Minimized from `src/ast.ts` `walkStmtChildren`, `case "ForStmt"`. The two arms are a
  // MEMBER and a SUB-UNION of the field's declared union; node runs it unchanged.
  test("a member arm and a sub-union arm, written into a declared union field", async () => {
    const src = `interface NumLit { kind: "NumLit"; value: number }
interface StrLit { kind: "StrLit"; text: string }
type Expr = NumLit | StrLit;
interface VarDecl { kind: "VarDecl"; name: string }
interface ForStmt { kind: "ForStmt"; init: VarDecl | Expr | null; label: string }
type Stmt = VarDecl | ForStmt;
function fe(x: Expr): Expr { return x.kind === "NumLit" ? { kind: "NumLit", value: x.value + 1 } : { kind: "StrLit", text: x.text }; }
function fs(x: Stmt): Stmt { return x.kind === "VarDecl" ? { kind: "VarDecl", name: x.name } : { kind: "ForStmt", init: null, label: x.label }; }
function walk(s: Stmt): Stmt {
  if (s.kind === "VarDecl") return { kind: "VarDecl", name: s.name };
  return { kind: "ForStmt", label: s.label,
    init: s.init === null ? null : s.init.kind === "VarDecl" ? (fs(s.init) as VarDecl) : fe(s.init) };
}
function show(s: Stmt): string {
  if (s.kind === "VarDecl") return "decl";
  return s.init === null ? "null" : s.init.kind;
}
console.log(show(walk({ kind: "ForStmt", label: "L1", init: null })));
console.log(show(walk({ kind: "ForStmt", label: "L2", init: { kind: "VarDecl", name: "i" } })));
console.log(show(walk({ kind: "ForStmt", label: "L3", init: { kind: "NumLit", value: 7 } })));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * ...AND THROUGH A RECURSIVE BACK-EDGE, which is the only spelling the compiler's own AST
   * actually uses. Minimized from `src/parser.ts` `parsePatternParam`:
   *
   *     init: rest ? { kind: "CallExpr", … } : { kind: "IndexExpr", … }
   *
   * Both arms are object LITERALS retyped to members of `Expr`. But `Declarator.init` is
   * declared `Expr | undefined` and `Expr` is RECURSIVE, so the hint arrives as `?U@Expr` —
   * a nominal back-edge, not a `U<…>`. Non-recursive `Expr` in the same shape already joined
   * by the rule above; the identical program with one self-referential field did not, which
   * is a difference in how the type is SPELLED and not in what it is. `assignable` already
   * treats `@N` and its shape as one type (the equirecursive fold/unfold rule at its top),
   * so the hint is unfolded to match. `unfold` is the widening one and it deliberately does
   * NOT descend into a `U<…>`, so the members keep the string-literal tags the discriminant
   * is proved from.
   */
  test("the contextual union reached through a recursive `@N` back-edge", async () => {
    const src = `interface CallExpr { kind: "CallExpr"; callee: string; args: Expr[] }
interface IndexExpr { kind: "IndexExpr"; index: number; of: Expr[] }
type Expr = CallExpr | IndexExpr;
interface Declarator { name: string; init?: Expr }
function build(rest: boolean, name: string): Declarator[] {
  //@@mutable
  let decls: Declarator[] = [];
  decls.push({
    name,
    init: rest ? { kind: "CallExpr", callee: "slice", args: [] } : { kind: "IndexExpr", index: 0, of: [] },
  });
  return decls;
}
function tag(ds: Declarator[]): string {
  const d = ds[0].init;
  return d === undefined ? "none" : d.kind;
}
console.log(tag(build(true, "x")));
console.log(tag(build(false, "y")));
`;
    expect(codeOf(src)).toBe(null);
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  /*
   * THE OVER-ACCEPT GATE, and it carries the whole soundness argument for the rule above.
   * `Decoy` has the same field NAMES as member `A` but in the opposite SLOT ORDER, so it is
   * structurally "compatible" and layout-incompatible at the same time. Reading the union's
   * discriminant off one loads the number 999 out of slot 0 and reinterprets it as a string
   * pointer.
   *
   * MEASURED, not asserted. Replacing `assignable(h, …)` in the rule above with a structural
   * object test COMPILES both programs below, and they fail in the two ways this project
   * keeps a list of:
   *
   *   - slot 0 holds a NUMBER (`Decoy.n`): the binary exits 255 having printed NOTHING —
   *     no stdout, no stderr — where node prints "Decoy" then "after" at exit 0;
   *   - slot 0 holds a STRING (`Decoy.payload`): no trap at all. It prints "WRONG" and
   *     exits 0, where node prints "Decoy". The silent wrong answer, which is worse.
   *
   * So `assignable`'s union arm being IDENTITY against `unionWidenedMembers` rather than the
   * structural-object rule is load bearing, and these two tests are what keep it that way.
   */
  test("REFUSED: an arm that merely LOOKS like a member (same fields, different slots)", () => {
    const src = `interface A { kind: "A"; n: number }
interface B { kind: "B"; s: string }
type U = A | B;
interface Decoy { n: number; kind: "Decoy" }
function pick(flag: boolean): string {
  const d: Decoy = { n: 999, kind: "Decoy" };
  const a: A = { kind: "A", n: 1 };
  const r: U = flag ? d : a;
  return r.kind;
}
console.log(pick(true));
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  test("REFUSED: ...and the decoy whose slot 0 is a STRING, which would not even trap", () => {
    const src = `interface A { kind: "A"; n: number }
interface B { kind: "B"; s: string }
type U = A | B;
interface Decoy { payload: string; kind: "Decoy" }
function pick(flag: boolean): string {
  const d: Decoy = { payload: "WRONG", kind: "Decoy" };
  const a: A = { kind: "A", n: 1 };
  const r: U = flag ? d : a;
  return r.kind;
}
console.log(pick(true));
`;
    expect(codeOf(src)).toBe("NT2001");
  });

  /*
   * A GENERAL union (`G<…>`) is a BOX, not a bare pointer, so an arm joined into one needs
   * a `coerceGeneralUnion` the ternary's own `coerce` would apply to `e.ty` — but the ARMS
   * are coerced to `e.ty` individually and a sub-union arm has no single tag. Kept out of
   * the rule by `isUnionTy` alone; pinned so a later "and general unions too" does not slip
   * in without its own boxing story.
   */
  test("REFUSED: the contextual union is a GENERAL (boxed) union", () => {
    const src = `type G = number | string;
function pick(flag: boolean): G {
  const g: G = flag ? [1] : 2;
  return g;
}
console.log(pick(true));
`;
    expect(codeOf(src)).not.toBe(null);
  });
});
