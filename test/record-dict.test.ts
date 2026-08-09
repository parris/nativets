/**
 * `Record<K, V>` is compiled as a `Map<K, V>` — and the diagnostic has to say so.
 *
 * In TypeScript `Record<K, V>` is an OBJECT type, and `{ n: "\n" }` initializes it fine
 * (verified: node runs `const o: Record<string,string> = {a:"1"}; console.log(o["a"])`
 * and prints `1`, exit 0). nativets erases `Record` to its `Map` type instead
 * (`src/parser.ts`, `parseGenericType`), because an object's field list here comes from
 * its TYPE and a `Record`'s key set is by definition not known statically.
 *
 * That mapping is defensible — see docs/divergences.md — but the ERROR it produced was
 * not: it reported `'ESCAPES' declared Map<string,string> but initialized with {…}` to a
 * user who never wrote `Map`. The type in the message was the compiler's erasure, not
 * anything in the source, which sends you looking for a `Map` that does not exist. That
 * is what this file pins.
 *
 * Cases are DERIVED from node probes quoted inline. No conformance suite was consulted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";
import { parse } from "../src/parser.ts";
import { check } from "../src/checker.ts";

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

describe("the Record-initialized-with-a-literal diagnostic names what was WRITTEN", () => {
  test("it says `Record`, the word in the source, not the erased `Map`", () => {
    const r = rejectionOf(`const o: Record<string, string> = { a: "1" };\nconsole.log(o["a"]);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("Record<string,string>");
  });

  test("the hint explains the mapping and names a real fix", () => {
    const r = rejectionOf(`const o: Record<string, string> = { a: "1" };\nconsole.log(o["a"]);\n`);
    // WHY: the erasure, stated once, where the user can see it.
    expect(r?.hint).toContain("Map");
    // The fix has to be actionable, not a restatement.
    expect(r?.hint).toContain(".set(");
  });

  test("a genuine `Map` annotation still reports `Map` — the two do not collapse", () => {
    const r = rejectionOf(`const o: Map<string, string> = { a: "1" };\nconsole.log(o.size);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("Map<string,string>");
    expect(r?.message).not.toContain("Record");
  });

  /**
   * The case that actually constrains the renderer. An ALIAS's written head (`Cell`) has
   * no relationship to its erasure (`{n:number}`) and there are no type arguments to
   * carry over, so substituting the head must be SKIPPED entirely — splicing it in
   * produces a mangled non-type. Found by checking the `Map` test above for vacuity: that
   * one survives the guard being removed, because `Map<…>` re-renders to itself.
   */
  test("an ALIAS annotation renders as its shape, not a spliced head", () => {
    const r = rejectionOf(`type Cell = { n: number };\nconst c: Cell = 1;\nconsole.log(c.n);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain("{n:number}");
    expect(r?.message).not.toContain("Cell}");
    expect(r?.message).not.toContain("Cell{");
  });
});

describe("the compiler's own lexer no longer needs the Record pattern (route c)", () => {
  /**
   * `src/lexer.ts` stopped STANDALONE (parse + check, no link) on
   * `const ESCAPES: Record<string, string> = { … }`, read at `ESCAPES[e] ?? e` with a
   * VARIABLE key. Both halves are refused here, and neither can be fixed correctly:
   *
   *  - the literal cannot initialize a Map (this file's subject);
   *  - `o[e]` with a non-literal key cannot match node even in principle, because node's
   *    `o[k]` consults the PROTOTYPE CHAIN. Measured: on `{ n: "N" }`, node returns a
   *    FUNCTION for `o["toString"]`, `o["constructor"]` and `o["hasOwnProperty"]`, and an
   *    object for `o["__proto__"]` — and `o["toString"] ?? FALLBACK` takes the inherited
   *    function, not the fallback. nativets objects have no prototype chain (a literal-key
   *    `o.toString` is refused outright: "Property 'toString' does not exist"), so any
   *    own-keys-only lowering would answer `undefined` where node answers a function.
   *
   * So the pattern is replaced with a `switch`, which is what a hand-written lexer would
   * use anyway — no loss of clarity and no dependence on a construct we cannot compile.
   */
  function standaloneBlocker(rel: string): string {
    const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
    try {
      check(parse(src));
      return "CLEAN";
    } catch (e) {
      const d = (e as { diag?: { code: string; message: string } }).diag;
      return d ? `${d.code}: ${d.message}` : String(e);
    }
  }

  test("src/lexer.ts standalone is no longer stopped by the Record mismatch", () => {
    const b = standaloneBlocker("src/lexer.ts");
    expect(b).not.toContain("ESCAPES");
    expect(b).not.toContain("but initialized with");
  });

  test("src/lexer.ts declares no `Record<` ANNOTATION (comments may still mention it)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/lexer.ts"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
    expect(code.join("\n").includes("Record<")).toBe(false);
  });

  /**
   * The refactor must be BEHAVIOUR-PRESERVING, and the lexer is the component every other
   * test runs through, so it is asserted directly against node: each escape the table
   * carried, plus an unknown one (`\q` -> `q`), which was the `?? e` arm.
   *
   * `\0` is deliberately EXCLUDED, and not because the refactor changed it. nativets
   * strings are NUL-terminated, so an embedded NUL truncates: `"a\0b"` is length 1 here
   * and 3 in node — a silent wrong answer that reproduces identically at this lane's base
   * commit with no changes applied. It is reported separately; pinning it here would
   * either fail for an unrelated reason or, worse, cement the wrong value.
   */
  test("every escape still lexes exactly as node does (NUL excluded, see above)", async () => {
    const source = `const s = "a\\nb\\tc\\rd\\\\e\\"f\\'g\\qh";\nconsole.log(JSON.stringify(s));\nconsole.log(s.length);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout.length).toBeGreaterThan(0);
  });
});

/**
 * Lift a top-level `const`/`export const` declaration VERBATIM out of a real compiler
 * module, so a test asserts the thing that ships rather than a copy of it. Read with
 * `readFileSync`, never shell `grep` (project memory: the shimmed grep on some setups
 * silently misses matches, which would make every assertion below vacuous).
 */
export function liftDecl(rel: string, name: string): string {
  const src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const at = src.indexOf(`export const ${name}`) >= 0
    ? src.indexOf(`export const ${name}`)
    : src.indexOf(`const ${name}`);
  if (at < 0) throw new Error(`${rel} no longer declares ${name}`);
  let end = at, depth = 0, seen = false;
  for (; end < src.length; end++) {
    const c = src[end]!;
    if (c === "(" || c === "[" || c === "{") { depth++; seen = true; }
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0 && seen) { end++; break; }
  }
  return src.slice(at, end).replace("export const", "const");
}

/**
 * THE DICTIONARY TABLES OF THE COMPILER'S OWN SOURCE.
 *
 * `Record<K, V>` declared but initialized with an object literal was the first blocker
 * for EIGHT of the twelve modules — `src/ast.ts`'s `HOST_MODULES`, inherited through the
 * link by parser, checker, codegen, coverage, ownership, driver and modules.
 *
 * The census (all twelve `src/*.ts`, `readFileSync`, not grep) found **eleven** such
 * declarations in four files, and the decisive fact is how every one of them is READ:
 *
 *   NUMBER_CONSTS[e.property]   MATH_METHODS[m]        STRING_METHODS[e.callee.property]
 *   HOST_FUNCS[e.callee.name]   GLOBAL_FUNCS[name]     FCMP[op] / `op in FCMP`
 *   ARITH[bare] / `in`          BITFN[bare] / `in`     MATH_FN1[method]
 *   HOST_MODULES[mod] / Object.keys(HOST_MODULES)      BIN[t.value]
 *
 * **Every single one indexes with a VARIABLE key.** So the "annotate the exact shape"
 * escape hatch the diagnostic offers does not apply to a single table here: an object
 * indexed by a non-literal key is its own refusal, and correctly so — node's `o[k]`
 * consults the PROTOTYPE CHAIN, so an own-keys-only lowering answers `undefined` where
 * node answers a function. (`{ [k: string]: V }` does not even parse — NT0001.)
 *
 * These tables ARE dictionaries with runtime keys. `Record<K, V>` was the honest TYPE
 * all along; the object literal was the wrong CONSTRUCTOR. The fix is the one the
 * diagnostic's own hint prescribes — `new Map<K, V>().set(…)`, read with `.get`/`.has` —
 * and it is free under bun, because `Map.prototype.set` returns its receiver (ES2024
 * 24.1.3.9 step 8) and the Map constructor builds the entries form by calling `set` once
 * per entry (24.1.1.1 step 8).
 *
 * It is not observationally null under node, and that is the POINT: see the
 * `Number.constructor` bug pinned at the bottom of this file.
 */
describe("the compiler's own dictionary tables are Maps, not Record-shaped literals", () => {
  /*
   * The self-hosting gate, in the shape `collections.test.ts` established for
   * `DATE_GETTERS`: the REAL table is lifted out of `src/ast.ts`, so the day someone
   * writes the object-literal form back into it this goes red rather than the frontier
   * silently regressing. The ORACLE is node running the `Record` spelling of the same
   * table, so the rewrite is asserted observationally null on every key that EXISTS.
   */
  test("src/ast.ts's real HOST_MODULES compiles, and equals node's Record form", async () => {
    const decl = liftDecl("src/ast.ts", "HOST_MODULES");
    // Exactly the two reads `src/parser.ts` bindHostImport performs.
    const driver = `
const mod = "node:path";
const members = HOST_MODULES.get(mod);
console.log(members === undefined ? "none" : members.join(", "));
console.log(HOST_MODULES.get("node:zlib") === undefined);
console.log([...HOST_MODULES.keys()].map((m) => \`'\${m}'\`).join(", "));`;
    const oracleDriver = `
const mod = "node:path";
const members = HOST_MODULES[mod];
console.log(members === undefined ? "none" : members.join(", "));
console.log(HOST_MODULES["node:zlib"] === undefined);
console.log(Object.keys(HOST_MODULES).map((m) => \`'\${m}'\`).join(", "));`;
    const oracle = runWithNode(`const HOST_MODULES: Record<string, string[]> = {
  "node:fs": ["readFileSync", "writeFileSync", "existsSync", "mkdtempSync", "readdirSync", "rmSync"],
  "node:path": ["join", "dirname", "basename", "resolve", "relative"],
  "node:os": ["tmpdir", "homedir"],
  "node:url": ["fileURLToPath"],
  "node:child_process": ["spawnSync"],
};${oracleDriver}`);
    const ours = await compileAndRun(decl + driver);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout.split("\n")[0]).toBe("join, dirname, basename, resolve, relative");
  });

  /*
   * PRE-EXISTING BUG — a SILENT WRONG ANSWER in the shipped compiler, and the reason the
   * `Record`-literal idiom is not merely un-self-hostable but wrong.
   *
   * `src/checker.ts` typed `Number.<p>` with `if (NUMBER_CONSTS[e.property] === undefined)
   * throw nyi(...)`, and `src/codegen.ts` folded it with `const c = NUMBER_CONSTS[e.property];
   * if (c !== undefined) return llvmDouble(c)`. `NUMBER_CONSTS` was a plain OBJECT, so
   * `NUMBER_CONSTS["constructor"]` is `Object.prototype.constructor` — a FUNCTION, hence
   * `!== undefined`. The checker admitted the member as `number` and codegen handed a
   * Function to `llvmDouble`:
   *
   *     console.log(Number.constructor)   node: [Function: Function]   nativets: NaN, exit 0
   *
   * Measured at this lane's base commit for `constructor`, `toString`, `valueOf`,
   * `hasOwnProperty`, `isPrototypeOf` and `__proto__` — six inherited names, six NaNs, exit
   * 0 on both sides, which is precisely the class CLAUDE.md calls the worst outcome
   * available. A `Map` has no prototype chain to fall through, so `.get` answers `undefined`
   * and the existing refusal fires. The fix is the rewrite, not a special case.
   */
  const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"];
  for (const p of INHERITED) {
    test(`Number.${p} is REFUSED, not folded to NaN (node returns a function)`, () => {
      const r = rejectionOf(`console.log(Number.${p});\n`);
      expect(r).not.toBeNull();
      // Whatever the code, it must be a REFUSAL — never a compiled program printing NaN.
      expect(r!.message).toContain(p);
    });
  }

  test("the constants NUMBER_CONSTS really holds still equal node's, exactly", async () => {
    const source = `console.log(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.EPSILON);
console.log(Number.MAX_VALUE, Number.MIN_VALUE, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN);`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout.split("\n")[0]).toBe("9007199254740991 -9007199254740991 2.220446049250313e-16");
  });

  /*
   * `src/parser.ts`'s BIN — the precedence table, and the one whose value type has
   * OPTIONAL fields, which is what turned up the `.set` reshape gap below. Lifted
   * verbatim; the oracle is node on the `Record` spelling of the same table, driven
   * through the three reads `parseBinary` performs (two literal-key, one variable-key).
   */
  test("src/parser.ts's real BIN table compiles, and equals node's Record form", async () => {
    const iface = `interface Op { prec: number; right?: boolean; logical?: boolean; }\n`;
    const decl = liftDecl("src/parser.ts", "BIN");
    const driver = `
console.log(BIN.get("<")!.prec, BIN.get("**")!.right === undefined, BIN.get("**")!.prec);
for (const t of ["+", "&&", "??", "**", "nope"]) {
  const info = BIN.get(t);
  if (!info || info.prec < 4) console.log(t, "break");
  else console.log(t, info.prec, info.right ? "R" : "L", info.logical ? "logical" : "binary");
}`;
    // The ORACLE is the `Record` spelling of the same table, written out — so this asserts
    // the rewrite is observationally null on every key that exists, and goes red if anyone
    // changes the real table without changing it here.
    const oracleDriver = driver
      .replace(/BIN\.get\("([^"]+)"\)!/g, `BIN["$1"]!`)
      .replace("BIN.get(t)", "BIN[t]");
    const oracle = runWithNode(`${iface}const BIN: Record<string, Op> = {
  "**": { prec: 14, right: true },
  "*": { prec: 13 }, "/": { prec: 13 }, "%": { prec: 13 },
  "+": { prec: 12 }, "-": { prec: 12 },
  "<<": { prec: 11 }, ">>": { prec: 11 }, ">>>": { prec: 11 },
  "<": { prec: 10 }, "<=": { prec: 10 }, ">": { prec: 10 }, ">=": { prec: 10 },
  "===": { prec: 9 }, "!==": { prec: 9 }, "==": { prec: 9 }, "!=": { prec: 9 },
  "&": { prec: 8 }, "^": { prec: 7 }, "|": { prec: 6 },
  "&&": { prec: 5, logical: true }, "||": { prec: 4, logical: true },
  "??": { prec: 3, logical: true },
};${oracleDriver}`);
    const ours = await compileAndRun(iface + decl + driver);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout.split("\n")[0]).toBe("10 false 14");
  });

  /*
   * `src/codegen.ts`'s four opcode tables — the densest cluster of the construct in one
   * file, and the one that also used `op in FCMP`. `in` over a Map is FALSE in node (it
   * tests the Map OBJECT's properties, never its entries — see the `in` lane), so the
   * rewrite has to move to `.has`, which is what the `in` refusal's own hint prescribes.
   */
  test("src/codegen.ts's real FCMP / ARITH / BITFN / MATH_FN1 equal node's Record form", async () => {
    const decls = ["FCMP", "ARITH", "BITFN", "MATH_FN1"].map((n) => liftDecl("src/codegen.ts", n)).join("\n");
    const driver = `
for (const op of ["<", "===", "!=", "+", "%", "&", ">>>", "**"]) {
  console.log(op, FCMP.has(op), BITFN.has(op), ARITH.has(op));
  if (FCMP.has(op)) console.log("  fcmp", FCMP.get(op));
  if (BITFN.has(op)) console.log("  call", BITFN.get(op));
  if (ARITH.has(op)) console.log("  arith", ARITH.get(op));
}
for (const m of ["floor", "abs", "round", "pow"]) {
  const fn = MATH_FN1.get(m);
  console.log(m, fn === undefined ? "none" : fn);
}`;
    const oracleDriver = driver
      .replace(/(FCMP|BITFN|ARITH)\.has\(op\)/g, "op in $1")
      .replace(/(FCMP|BITFN|ARITH)\.get\(op\)/g, "$1[op]")
      .replace("MATH_FN1.get(m)", "MATH_FN1[m]");
    const oracle = runWithNode(`const FCMP: Record<string, string> = {
  "<": "olt", "<=": "ole", ">": "ogt", ">=": "oge", "===": "oeq", "==": "oeq", "!==": "une", "!=": "une",
};
const ARITH: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "%": "frem" };
const BITFN: Record<string, string> = {
  "&": "js_bit_and", "|": "js_bit_or", "^": "js_bit_xor", "<<": "js_shl", ">>": "js_shr", ">>>": "js_ushr",
};
const MATH_FN1: Record<string, string> = {
  floor: "floor", ceil: "ceil", sqrt: "sqrt", trunc: "trunc", abs: "fabs", round: "js_math_round",
};${oracleDriver}`);
    const ours = await compileAndRun(decls + driver);
    expect(ours.exitCode).toBe(0);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(oracle.stdout.split("\n")[0]).toBe("< true false false");
  });

  /*
   * The whole-tree lint, and the point of the census: this construct is not "the first
   * blocker of eight modules", it is ELEVEN declarations in four files, and a first-blocker
   * table can never say that (docs/self-hosting.md's standing correction). Counted with
   * `readFileSync`, not shell `grep`.
   */
  test("no `src/*.ts` declares a Record ANNOTATION any more (casts and prose excepted)", () => {
    const dir = new URL("../src/", import.meta.url);
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
      lines.forEach((l, i) => {
        const t = l.trimStart();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        // An ANNOTATION or an alias — `x: Record<…>` / `type T = Record<…>`. Deliberately
        // NOT `x as Record<string, unknown>`, a type ASSERTION over an AST node that never
        // reaches a `Ty` and never allocates (5 sites, ast.ts and codegen.ts); and not the
        // word inside `dictHint`'s own message, which has to keep saying `Record`.
        if ((/:\s*Record</.test(l) || /=\s*Record</.test(l)) && !/\bas\s+Record</.test(l))
          offenders.push(`${f}:${i + 1}: ${t}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * A GAP the rewrite above walked straight into: `.set` would not take an object literal
 * that a `const` declaration accepts one line earlier.
 *
 *   interface Op { prec: number; right?: boolean }
 *   const a: Op = { prec: 1 };                                     // fine, always has been
 *   new Map<string, Op>().set("a", { prec: 1, right: true });      // NT2001
 *       .set value expects {prec:number,right:?Uboolean}, got {prec:number,right:boolean}
 *
 * `inferMapMethod` compared the value type by IDENTITY (`argTys[1] !== v`), which is the
 * same bare test `src/checker.ts` already replaced with `fitsArg` at the named-call site
 * for the same reason: identity has no optional-field arm, no nullable arm and no literal
 * reshape. So an optional field is fatal whether it is OMITTED (`logical` absent) or
 * PRESENT (`right: true` is `boolean`, the slot is `?Uboolean`).
 *
 * That is not a `Map` opinion, it is a missing branch — and it made the sanctioned
 * `.set`-chain idiom unavailable for exactly the tables whose value type has an optional
 * field, i.e. `src/parser.ts`'s `BIN`. Fixed with `fitsArg`, which reshapes the literal
 * into the declared slot layout and refuses anything it cannot rebuild (a variable, a call
 * result), because accepting those on the predicate alone is the dereference-a-double bug
 * `test/optional-props.test.ts` pins.
 */
describe("Map.set takes an object literal the declaration path already took", () => {
  test("an omitted optional field, and a present one, both reshape", async () => {
    const source = `interface Op { prec: number; right?: boolean; logical?: boolean }
const BIN = new Map<string, Op>()
  .set("**", { prec: 14, right: true })
  .set("*", { prec: 13 })
  .set("&&", { prec: 5, logical: true });
const k = "**";
const info = BIN.get(k);
if (!info || info.prec < 1) console.log("break");
else console.log(info.prec, info.right === undefined, info.logical === undefined);
console.log(BIN.get("*")!.right === undefined, BIN.get("&&")!.logical === undefined);
console.log(BIN.get("&&")!.logical ? "logical" : "binary");`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("14 false true\ntrue false\nlogical\n");
  });

  /*
   * The other half of the same gap: the value type must be the CONTEXT the argument is
   * typed in, not just the thing it is compared against afterwards. `inferMapMethod` typed
   * every argument with `this.type(a, scope)` and no context, so an empty array literal in
   * a field — `{ min: 0, max: 0, argTys: [], ret: "string" }`, which is four rows of
   * `src/checker.ts`'s STRING_METHODS — was `NT1001 cannot infer the element type`, while
   * `const s: Sig = { min: 0, argTys: [] }` had always worked. Every other argument site in
   * the checker already routes through `typeArg` for exactly this reason.
   */
  test("an empty array literal in a `.set` value gets its element type from the value type", async () => {
    const source = `type Ty = string;
interface Sig { min: number; max: number; argTys: Ty[]; ret: Ty }
const M = new Map<string, Sig>()
  .set("trim", { min: 0, max: 0, argTys: [], ret: "string" })
  .set("slice", { min: 1, max: 2, argTys: ["number", "number"], ret: "string" });
const k = "trim";
const sig = M.get(k);
if (!sig) console.log("none");
else console.log(sig.min, sig.max, sig.argTys.length, sig.ret);
console.log(M.get("slice")!.argTys.join(","));`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("0 0 0 string\nnumber,number\n");
  });

  /*
   * `Set.add` deliberately does NOT get the same branch, and this is why: a Set element
   * here is `string | number`, so there is no object literal with a slot layout to
   * rebuild. Pinned so the asymmetry reads as a measured boundary rather than an
   * oversight — the day object elements land, this test is the reminder.
   */
  test("a Set of objects is refused outright, so `.add` has no literal to reshape", () => {
    const r = rejectionOf(`interface P { x: number; tag?: string }
const s = new Set<P>().add({ x: 1 });
console.log(s.size);\n`);
    expect(r?.code).toBe("NT1014");
    expect(r?.message).toContain("Set of");
  });

  /*
   * The boundary that keeps the fix honest. A NON-literal of a merely structurally
   * compatible type has a layout already fixed by its own declaration and nothing to
   * rewrite, so it stays refused — widening past `fitsArg` is the memory bug, not the
   * feature (src/checker.ts `fitsArg`).
   */
  test("a non-literal of a different layout is still REFUSED, not silently accepted", () => {
    const r = rejectionOf(`interface Op { prec: number; right?: boolean }
const bare = { prec: 1, right: true };
const m = new Map<string, Op>().set("a", bare);
console.log(m.size);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain(".set value expects");
  });

  test("a genuinely wrong value type is still REFUSED", () => {
    const r = rejectionOf(`const m = new Map<string, number>().set("a", "one");\nconsole.log(m.size);\n`);
    expect(r?.code).toBe("NT2001");
    expect(r?.message).toContain(".set value expects number, got string");
  });
});
