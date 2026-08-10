/*
 * READING AND ASSIGNING through a duck-typed `as` window — the half of the shape
 * test/as-cast.test.ts does not pin, and the `src/` sites that were in it.
 *
 * `lane-exprloc` found that `(e as { loc?: Loc }).loc` was broken for ALL 30 `Expr`
 * members, the seven that genuinely carry a `loc` included, because the cast never
 * consulted member layout: `loc` is slot 0 of the asserted shape and slot 0 of every
 * `Expr` member is `kind`. A bad READ yields a wrong value. A bad WRITE is strictly
 * worse — it corrupts the DISCRIMINANT, and narrowing on the discriminant is how the
 * whole checker reads unions, so every later `switch (e.kind)` in the program takes the
 * wrong arm. `src/` had three such writes:
 *
 *   checker.ts   `(e.callee as { name: string }).name = mangled`        (retarget)
 *   checker.ts   `(e.callee as { property: string }).property = …`      (retarget)
 *   ownership.ts `(site as { nullOnMove?: boolean }).nullOnMove = true` (analyzeOwnership)
 *
 * `name` is at slot 1 of `Identifier`, `property` at slot 2 of `MemberExpr`, and
 * `nullOnMove` at slot 4 of `Identifier` — every one of them asserted to a ONE-FIELD
 * window, i.e. onto slot 0, i.e. onto `kind`.
 *
 * WHAT ACTUALLY HELD THE LINE, and why it is not something to rely on: the target of an
 * `as` window is an untagged structural record, and an untagged record is IMMUTABLE, so
 * `NT1606` refuses every write through one — including the write the cast rule itself
 * would have allowed. That is a real guarantee and it is pinned below, because it is the
 * only reason these three were refusals rather than live corruption. But it is INCIDENTAL:
 * it is the mutability rule catching a LAYOUT bug, and `@@mutable` records exist precisely
 * to relax it. The three sites are rewritten to tag dispatch — `lane-exprloc`'s pattern —
 * so that when mutation is permitted the store lands on the right slot instead.
 *
 * THE READS IN THE SAME FAMILY, found by the same census and fixed in the same way. Each
 * one names its field at slot 0 while the member carries it elsewhere; each is listed with
 * what was ACTUALLY holding it, because in three of the four that protection was
 * incidental rather than a layout rule:
 *
 *   ownership.ts  `(e.callee as { object: Expr }).object`      object@1 of MemberExpr
 *   codegen.ts    `(x as { elements: Expr[] }).elements` (×2)  elements@1 of ArrayLiteral
 *   checker.ts    `(x as { value: string }).value`             value@1 of StringLiteral
 *   checker.ts    `(lit as { ty?: Ty }).ty`                    ty@1..5, all 30 members
 *
 * The ownership one is the one that mattered. Every other site in this family produces a
 * wrong VALUE; that one handed the `kind` string pointer to the pass that decides what
 * gets FREED, on the `.reverse()` path whose whole job is "the result IS the receiver, do
 * not drop it twice". Its protection was the cast rule alone, and it was MASKED behind an
 * earlier NT1606 in the same function, so nothing reported it.
 *
 * `guardFacts`'s `ty` read is the widest: `ty` is at five different slots across the 30
 * members, so no shared read exists at all, and compiled it compared a kind string against
 * "undefined"/"null" — silently dropping EVERY nullish narrowing in the compiler.
 *
 * TWO WINDOWS ARE DELIBERATELY LEFT, and both are pinned below so they are not "fixed"
 * into something worse: `ownership.ts`'s `{kind?: unknown}` guard and `checker.ts`'s
 * `{kind, value}` in `.flat` both name `kind` FIRST, which is the rule — a window is a
 * PREFIX read, and slot 0 of every AST node is the discriminant.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileAndRun, emitIR, expectMatchesNode } from "./harness.ts";

const REPO = resolve(import.meta.dir, "..");

/* ------------------------------------------------------------------ *
 * 1. THE COMPILER RULE. A write through a duck-typed window is refused, whether or not
 *    the window's layout happens to fit. Both halves matter: the mis-slotted one is the
 *    corruption, and the WELL-slotted one is what shows the guarantee is the mutability
 *    rule rather than the cast rule.
 * ------------------------------------------------------------------ */
describe("writing through a duck-typed `as` window", () => {
  test("a MIS-SLOTTED window is refused — the store would land on the discriminant", () => {
    // `name` is slot 1 of the `id` member; the window puts it at slot 0, which is `kind`.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function setName(e: Node, s: string): void { (e as { name: string }).name = s; }
const n: Node = { kind: "id", name: "f" };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toMatch(/NT2001|NT1606/);
  });

  test("even a WELL-slotted window is refused — an `as` target is an untagged record", () => {
    // `{kind,name}` really is slots 0,1 of the `id` member, so the CAST rule accepts it
    // (as-cast.test.ts pins the matching read as legal and free). The write is still
    // refused, by the immutability rule — that is the line that actually held.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function setName(e: Node, s: string): void { (e as { kind: string; name: string }).name = s; }
const n: Node = { kind: "id", name: "f" };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT1606");
  });

  test("...and `@@mutable` on the members does not open it either", () => {
    // The window TYPE is the plain record `{kind:string,name:string}`, and mutability is
    // NOMINAL (docs/decorators.md — a `@@mutable` record compiles to a TAGGED object
    // type). So the cast lands on an untagged type and the receiver's own mutability
    // cannot travel through it. Worth pinning: it is what makes the refusal permanent
    // rather than a thing `@@mutable` quietly turns off.
    let err: unknown;
    try {
      emitIR(`
//@@mutable
type Ident = { kind: "id"; name: string };
//@@mutable
type Num = { kind: "num"; value: number };
type Node = Ident | Num;
function setName(e: Node, s: string): void { (e as { kind: string; name: string }).name = s; }
const n: Node = { kind: "num", value: 42 };
setName(n, "g");
console.log(n.kind);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT1606");
  });

  test("a READ through the same mis-slotted window is refused as before", async () => {
    // The read rule is as-cast.test.ts's; asserted here only so the write tests above
    // cannot start passing for the wrong reason if that rule ever moves.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function nameOf(e: Node): string { return (e as { name: string }).name; }
console.log(nameOf({ kind: "id", name: "f" }));
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
    await Promise.resolve();
  });
});

/* ------------------------------------------------------------------ *
 * 2. THE REPLACEMENT. Tag dispatch reads and writes the REAL field, and the tag test
 *    itself costs nothing. Reading is legal today; the write still needs `@@mutable`,
 *    which is the honest state of affairs and is pinned as such.
 * ------------------------------------------------------------------ */
describe("tag dispatch is the sound spelling", () => {
  test("narrowing on the discriminant reaches the field at its real slot", async () => {
    await expectMatchesNode(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
type Node = Ident | Member;
function label(e: Node): string {
  if (e.kind === "Ident") return e.name;
  return e.property;
}
console.log(label({ kind: "Ident", name: "f" }));
console.log(label({ kind: "Member", object: "o", property: "m" }));
`);
  });

  test("narrowing through a DOTTED path works too — `retarget`'s actual shape", async () => {
    // `retarget` never holds its receiver in a local: it reaches it as `e.callee`.
    await expectMatchesNode(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
type Call = { kind: "Call"; callee: Ident | Member };
function calleeName(e: Call): string {
  if (e.callee.kind === "Ident") return e.callee.name;
  return e.callee.property;
}
console.log(calleeName({ kind: "Call", callee: { kind: "Ident", name: "f" } }));
console.log(calleeName({ kind: "Call", callee: { kind: "Member", object: "o", property: "m" } }));
`);
  });

  test("the tag test emits no assertion check at all", () => {
    const ir = emitIR(`
type Ident = { kind: "Ident"; name: string };
type Member = { kind: "Member"; object: string; property: string };
function label(e: Ident | Member): string {
  if (e.kind === "Ident") return e.name;
  return e.property;
}
console.log(label({ kind: "Ident", name: "f" }));
`);
    expect(ir).not.toContain("call void @nt_as_tag");
  });

  test("a `@@mutable` receiver narrowed by its tag CAN be written in place", async () => {
    // The end state the rewrite is aiming at: once the record carries the attribute, the
    // narrowed store lands on the real slot and the discriminant survives.
    const ours = await compileAndRun(`
//@@mutable
type Cell = { kind: "Cell"; name: string };
const c: Cell = { kind: "Cell", name: "f" };
c.name = "f$number";
console.log(c.kind);
console.log(c.name);
`);
    expect(ours.stdout).toBe("Cell\nf$number\n");
    expect(ours.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. `src/` STAYS OUT OF THE SHAPE. The source guard, in the same spirit as the comment
 *    block on `exprLoc`: the pattern reads as harmless and was re-added twice.
 *
 *    Only WRITES are policed. A duck-typed READ is a judgement call the checked-`as`
 *    rule already adjudicates per site (`retainedReceiver`'s window is legitimate), but a
 *    one-field write window has no legitimate use — the field is on slot 0 by
 *    construction, and slot 0 is the tag.
 * ------------------------------------------------------------------ */
describe("src/ does not assign through a duck-typed cast window", () => {
  const FILES = ["src/checker.ts", "src/ownership.ts", "src/codegen.ts", "src/parser.ts", "src/ast.ts", "src/modules.ts", "src/driver.ts"];

  test("no `(x as { … }).f = …` anywhere in src/", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const lines = readFileSync(resolve(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        // `(… as { … }).field =` but not `==`/`=>`, and not inside a comment.
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\bas\s*\{[^}]*\}\s*\)\s*(\??\.)\s*[A-Za-z_$][\w$]*\s*(=[^=>]|\+\+|--|\+=)/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /*
   * THE GENERAL RULE, which covers the reads too and is the one worth stating: an `as`
   * window is a PREFIX read of the operand's layout, and slot 0 of every `Expr`/`Stmt`
   * member is `kind`. So a window onto an AST node must name `kind` FIRST. Any other
   * leading field is, by construction, a read of the discriminant under another name.
   *
   * This is what the whole family had in common, and stating it as a rule rather than as
   * five fixed sites is the point: `retainedReceiver` was repaired with a comment
   * explaining the reasoning, and the sibling site 700 lines below it was still missed.
   */
  const ALLOWED: { file: string; first: string; why: string }[] = [
    {
      file: "src/parser.ts", first: "message",
      why: "the operand is a CAUGHT value, not an AST node; the checker models Error "
        + "structurally as `{message:string}`, so `message` really is slot 0. (It is "
        + "still refused today, on the OPTIONALITY rather than the slot: `message?: "
        + "string` widens to `?Ustring` where the modelled Error has it required.)",
    },
  ];

  /** A line with every string/template literal blanked, so prose about casts is not code. */
  function withoutStrings(line: string): string {
    return line
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  }

  test("every `as { … }` window onto a DISCRIMINATED node names `kind` first", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const lines = readFileSync(resolve(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const code = withoutStrings(line);
        // `as { … }[]` is excluded: an ARRAY cast asserts the ELEMENT type of a
        // homogeneous record list (`Param[]`, the `{name, ty}` capture list), which has no
        // discriminant at all — `name` genuinely is slot 0 of those. The rule here is about
        // windows onto a tagged union member, where slot 0 is always `kind`.
        for (const m of code.matchAll(/\bas\s*\{([^{}]*)\}(\s*\[\s*\])?/g)) {
          if (m[2]) continue;
          const first = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(m[1]!);
          if (!first) continue;
          if (first[1] === "kind") continue;
          if (ALLOWED.some((a) => a.file === f && a.first === first[1])) continue;
          offenders.push(`${f}:${i + 1}  window starts with '${first[1]}', not 'kind'  — ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the guard would still catch the shape it was written for", () => {
    // A guard that cannot fail is worthless, and the string-blanking and array carve-out
    // above are both places one could silently stop matching. These are the five real
    // sites, verbatim, as they were before the rewrite.
    const BEFORE = [
      `    if (recvOffset === 0) { (e.callee as { name: string }).name = mangled; return; }`,
      `    (e.callee as { property: string }).property = mangled.slice(1);`,
      `    for (const site of sites) (site as { nullOnMove?: boolean }).nullOnMove = true;`,
      `          this.expr((e.callee as { object: Expr }).object, state, consume);`,
      `        const pairs = (e.args[0] as { elements: Expr[] }).elements;`,
      `          const lt = (lit as { ty?: Ty }).ty;`,
    ];
    for (const line of BEFORE) {
      const code = withoutStrings(line);
      const hits = [...code.matchAll(/\bas\s*\{([^{}]*)\}(\s*\[\s*\])?/g)]
        .filter((m) => !m[2])
        .map((m) => /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(m[1]!)?.[1])
        .filter((n) => n !== undefined && n !== "kind");
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3b. `exprTy` replaced the widest window of the family, so its exhaustiveness is the
 *     thing that has to hold. It is asserted from the SOURCE rather than by a `never`
 *     default: that idiom (`walkExprChildren`'s) is itself an NT2001 blocker in this
 *     compiler's own subset, because `never` erases to `number` — copying it into a new
 *     function measurably added one to the frontier, so it was backed out.
 * ------------------------------------------------------------------ */
describe("exprTy covers every Expr member", () => {
  const ast = readFileSync(resolve(REPO, "src/ast.ts"), "utf8");

  function exprMembers(): string[] {
    const union = /export type Expr =\s*([\s\S]*?);/.exec(ast)![1]!;
    return [...union.matchAll(/\|\s*(\w+)/g)].map((m) => m[1]!);
  }

  function exprTyArms(): string[] {
    const body = /export function exprTy\(e: Expr\): Ty \| undefined \{([\s\S]*?)\n\}/.exec(ast)![1]!;
    return [...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]!);
  }

  test("all 30 members are declared, and every one has an arm", () => {
    const members = exprMembers();
    expect(members.length).toBe(30);
    // The union names INTERFACES; the arms name the `kind` STRING. They coincide for every
    // member today, and the map below is what would catch it if one ever stopped.
    const kinds = members.map((n) => {
      const decl = new RegExp(`export interface ${n}\\s*\\{[\\s\\S]*?kind:\\s*"(\\w+)"`).exec(ast);
      return decl![1]!;
    });
    const arms = exprTyArms();
    expect([...arms].sort()).toEqual([...kinds].sort());
  });

  test("`ty` is NOT at one shared slot — which is why a window could not work", () => {
    // The claim the accessor exists for. If this ever collapses to a single slot, a plain
    // `unionCommonField` read would become legal and this whole function unnecessary.
    const slots = new Set<number>();
    for (const n of exprMembers()) {
      const decl = new RegExp(`export interface ${n}\\s*\\{([\\s\\S]*?)\\n\\}|export interface ${n}\\s*\\{([^\\n]*?)\\}`).exec(ast)!;
      const body = (decl[1] ?? decl[2]!).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const fields: string[] = [];
      for (const f of body.matchAll(/(\w+)\s*\??\s*:/g)) if (!fields.includes(f[1]!)) fields.push(f[1]!);
      expect(fields[0]).toBe("kind");          // slot 0 is the discriminant, in every member
      expect(fields).toContain("ty");
      slots.add(fields.indexOf("ty"));
    }
    expect(slots.size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. THE BEHAVIOUR PIN for `retarget`, which is what the rewrite actually risks.
 *
 *    `retarget` points a call at its SPECIALIZATION by rewriting the callee — the whole
 *    `name` for a function call, the `property` tail for a method call. Getting it wrong
 *    changes a MANGLED SYMBOL, which is silent: the program can still print the right
 *    answer while every call site was retargeted to a different name, and what breaks is
 *    whole-program LINKING — which the blocker metric structurally cannot see, since it
 *    reports checker blockers only.
 *
 *    So the pin is on the SYMBOLS, not on stdout: every specialization defined must be
 *    called and every call resolved. Captured from the pre-fix compiler and passing
 *    against it before `src/` was touched, so it is a before/after that can fail.
 * ------------------------------------------------------------------ */
const GENERICS = `
function idf<T>(x: T): T { return x; }
function pair<T>(x: T, y: T): string { return \`\${x}|\${y}\`; }
function firstOf<T>(xs: T[]): T { return xs[0]!; }
class Box {
  v: number = 0;
  tag<T>(x: T): string { return \`tag:\${x}\`; }
  two<T>(x: T, y: number): string { return \`two:\${x}:\${y}\`; }
}
console.log(idf(7));
console.log(idf("s"));
console.log(idf(true));
console.log(pair(1, 2));
console.log(pair("a", "b"));
console.log(pair(false, true));
console.log(firstOf([10, 20, 30]));
console.log(firstOf(["x", "y"]));
console.log(firstOf([true, false]));
console.log(idf<number>(42));
console.log(idf<string>("explicit"));
const b = new Box();
console.log(b.tag(1));
console.log(b.tag("z"));
console.log(b.tag(true));
console.log(b.two(9, 3));
console.log(b.two("w", 4));
function outer<T>(x: T): string { return pair(x, x); }
console.log(outer(3));
console.log(outer("n"));
`;

/** Mangled symbols (`$` never occurs in a source identifier here) defined and called. */
function specSymbols(ir: string): { defines: string[]; calls: string[] } {
  const defines = [...new Set([...ir.matchAll(/^define [^@]*@"?([A-Za-z0-9_$.]+)"?/gm)].map((m) => m[1]!))];
  const calls = [...new Set([...ir.matchAll(/call [^@]*@"?([A-Za-z0-9_$.]+)"?/g)].map((m) => m[1]!))];
  return {
    defines: defines.filter((s) => s.includes("$")).sort(),
    calls: calls.filter((s) => s.includes("$")).sort(),
  };
}

describe("retarget: the specialization a call site is pointed at", () => {
  // Captured from the compiler BEFORE this lane touched src/, and passing against it.
  const EXPECTED = [
    "Box.tag$boolean", "Box.tag$number", "Box.tag$string",
    "Box.two$number", "Box.two$string",
    "firstOf$boolean", "firstOf$number", "firstOf$string",
    "idf$boolean", "idf$number", "idf$string",
    "outer$number", "outer$string",
    "pair$boolean", "pair$number", "pair$string",
  ];

  test("both retarget paths select exactly these 16 symbols", () => {
    const { defines } = specSymbols(emitIR(GENERICS));
    // `Box.*` are the MemberExpr path (property tail rewritten); the rest are the
    // Identifier path (whole name replaced). Both must be exercised or the pin is half a
    // pin — the two branches of `retarget` are separate code.
    expect(defines.filter((s) => s.startsWith("Box."))).toHaveLength(5);
    expect(defines).toEqual(EXPECTED);
  });

  test("every specialization is called and every call resolved", () => {
    // A call site that was NOT retargeted leaves the template name behind, so its
    // specialization is defined and never called — a dangling symbol the linker would
    // drop silently rather than a compile error.
    const { defines, calls } = specSymbols(emitIR(GENERICS));
    expect(calls.filter((s) => !defines.includes(s))).toEqual([]);
    expect(defines.filter((s) => !calls.includes(s))).toEqual([]);
  });

  test("and the program still agrees with node", async () => {
    await expectMatchesNode(GENERICS);
  });
});

/* ------------------------------------------------------------------ *
 * 5. THE BEHAVIOUR PIN for the ownership read, where the failure mode is a FREE.
 *
 *    `.reverse()` is the only member of RETAINS_RECEIVER, so it is the sole path through
 *    `(e.callee as { object: Expr }).object`. That expression decides whether the receiver
 *    is CONSUMED or left owned — get it wrong and the program double-frees or leaks, and
 *    both of those print the right answer first. So stdout is not the pin: the drop calls
 *    are. Captured from the pre-fix compiler and passing against it.
 * ------------------------------------------------------------------ */
const REVERSE = `
function consumeIt(): number[] {
  const a = [3, 1, 2];
  return a.reverse();
}
function borrowIt(): number {
  const b = [5, 4, 6];
  const r = b.reverse();
  return r[0]! + b[0]!;
}
function chained(): number {
  const c = [9, 8, 7];
  return c.map((x: number): number => x * 2).reverse()[0]!;
}
function nested(): number {
  const d = [1, 2, 3];
  const e = d.reverse().reverse();
  return e[0]!;
}
function inArray(): number {
  const f = [2, 1];
  const g = [f.reverse()];
  return g[0]![0]!;
}
console.log(consumeIt().join(","));
console.log(borrowIt());
console.log(chained());
console.log(nested());
console.log(inArray());
`;

/** Free calls per emitted function — the drop schedule, which stdout cannot see. */
function freesByFunction(ir: string): Record<string, number> {
  const out: Record<string, number> = {};
  let cur: string | null = null;
  for (const line of ir.split("\n")) {
    const d = /^define [^@]*@"?([A-Za-z0-9_$.]+)"?/.exec(line);
    if (d) { cur = d[1]!; continue; }
    if (cur === null) continue;
    for (const _ of line.matchAll(/@(nt_obj_free|nt_arr_free|nt_free|nt_str_free)\b/g)) {
      out[cur] = (out[cur] ?? 0) + 1;
    }
  }
  return out;
}

describe("RETAINS_RECEIVER: who drops the array `.reverse()` hands back", () => {
  test("the drop schedule is exactly what it was before the rewrite", () => {
    const frees = freesByFunction(emitIR(REVERSE));
    // `consumeIt` RETURNS the array, so the caller owns it and the function must not drop
    // it — its absence here is the whole guarantee. The other four each own one array and
    // drop it exactly once. A double free shows up as a 2; a leak as a missing entry.
    expect(frees["consumeIt"]).toBeUndefined();
    expect(frees).toMatchObject({ borrowIt: 1, chained: 1, nested: 1, inArray: 1 });
  });

  test("and it still agrees with node", async () => {
    await expectMatchesNode(REVERSE);
  });

  test("`.reverse()` in a consuming position does not double-free at runtime", async () => {
    // The behaviour the drop schedule above is a proxy for, run for real.
    const ours = await compileAndRun(REVERSE);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe("2,1,3\n12\n14\n1\n1\n");
  });
});

/* ------------------------------------------------------------------ *
 * 6. `Object.fromEntries` — the only path through the two codegen `{elements}` windows and
 *    the checker's `{value}` one. All three read a literal entry list, and all three were
 *    reading `kind` instead: compiled, every KEY would have been the string
 *    "StringLiteral" and the entry list would have been indexed off a string pointer.
 * ------------------------------------------------------------------ */
describe("Object.fromEntries reads the literal, not the tag", () => {
  test("keys and values survive, at several widths", async () => {
    await expectMatchesNode(`
const a = Object.fromEntries([["x", 1], ["y", 2]]);
console.log(a.x, a.y);
const b = Object.fromEntries([["name", "nativets"], ["ok", true]]);
console.log(b.name, b.ok);
const c = Object.fromEntries([["only", 42]]);
console.log(c.only);
const d = Object.fromEntries([["n", 1], ["s", "two"], ["b", false]]);
console.log(d.n, d.s, d.b);
`);
  });

  test("a non-literal argument is still refused, not miscompiled", () => {
    let err: unknown;
    try {
      emitIR(`
const pairs: string[][] = [["a", "b"]];
const o = Object.fromEntries(pairs);
console.log(o);
`);
    } catch (e) { err = e; }
    expect(String(err)).toMatch(/NT1002|NT2001/);
  });
});

/* ------------------------------------------------------------------ *
 * 7. NULLISH NARROWING — what `guardFacts`'s `ty` read decides.
 *
 *    Compiled, that read returned the `kind` string for all 30 members, so `lt` was never
 *    "undefined" or "null" and the narrowing NEVER FIRED. The `x.length` below would each
 *    have become a "possibly undefined" refusal in a self-compiled nativets.
 *
 *    Case D is why the fix is `exprTy` and not a tag test for the two nullish literals:
 *    the operand does not have to BE the literal.
 * ------------------------------------------------------------------ */
describe("`!== undefined` / `!== null` narrowing, both operand orders", () => {
  test("literal, reversed, null, and a binding whose type is `undefined`", async () => {
    // Order-independence is TypeScript's own
    // `nullOrUndefinedTypeGuardIsOrderIndependent.ts`; case D is the one a literal-only
    // tag test would have silently dropped.
    await expectMatchesNode(`
function lenA(x: string | undefined): number { if (x !== undefined) return x.length; return -1; }
function lenB(x: string | undefined): number { if (undefined !== x) return x.length; return -1; }
function lenC(x: string | null): number { if (x !== null) return x.length; return -1; }
const u = undefined;
function lenD(x: string | undefined): number { if (x !== u) return x.length; return -1; }
console.log(lenA("abc"), lenA(undefined));
console.log(lenB("abcd"), lenB(undefined));
console.log(lenC("ab"), lenC(null));
console.log(lenD("abcde"), lenD(undefined));
`);
  });
});
