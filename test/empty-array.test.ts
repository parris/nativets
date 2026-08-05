/*
 * Empty array literal `[]` — CONTEXTUAL element-type inference (closes the NT1001
 * "cannot infer element type" friction).
 *
 * A bare `[]` carries no element to infer from, so nativets takes the element type
 * from the surrounding CONTEXT: a binding annotation, a return type, a parameter
 * type, a class field annotation, an annotated object-literal field, the other arm
 * of a `?:`/`??`, or an assignment target. With NO context at all we still REJECT
 * (NT1001) rather than guess — but with a diagnostic that names the three fixes.
 *
 * These are node-differential where node can run them (node erases the annotations),
 * plus a few behavioral cases (class field inits are strip-only-rejected by node,
 * and `__arrLive()` is a nativets-only drop probe).
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Compile + run without node (node can't run the source), asserting exact stdout. */
async function expectOut(source: string, stdout: string): Promise<void> {
  const r = await compileAndRun(source);
  expect(r.stdout).toBe(stdout);
  expect(r.exitCode).toBe(0);
}

describe("empty array literal — contextual element type", () => {
  // 1. binding annotation
  test("a binding annotation supplies the element type", async () => {
    await expectNode(`
const xs: number[] = [];
console.log(xs.length);
for (const x of xs) console.log("unreachable", x);
`);
  });

  // 2. spread of a contextually-typed empty array
  test("an empty array spreads into a non-empty literal", async () => {
    await expectNode(`
const xs: string[] = [];
const ys = [...xs, "a"];
console.log(ys.join(","));
console.log(ys.length);
`);
  });

  // 3. return position
  test("a declared return type supplies the element type", async () => {
    await expectNode(`
function f(): number[] { return []; }
console.log(f().length);
function g(flag: boolean): string[] {
  if (flag) return ["a"];
  return [];
}
console.log(g(false).length, g(true).join("|"));
`);
  });

  // 4. argument position
  test("a parameter type supplies the element type at the call site", async () => {
    await expectNode(`
function g(xs: string[]): number { return xs.length; }
console.log(g([]));
console.log(g(["a", "b"]));
const h = (ns: number[]): number => ns.length;
console.log(h([]));
`);
  });

  // 5. class field initializer (node's strip-only mode can't run a field initializer
  // with a type annotation on a class, so this one is behavioral)
  test("a class field annotation supplies the element type", async () => {
    await expectOut(`
class Box {
  items: number[] = [];
  tags: string[] = [];
  count(): number { return this.items.length + this.tags.length; }
}
const b = new Box();
console.log(b.count());
`, "0\n");
  });

  // 6. `?? []` on a nullable array
  test("?? [] takes the element type from the nullable left operand", async () => {
    await expectNode(`
const absent: {xs?: number[]} = {};
console.log((absent.xs ?? []).length);
const present: {xs?: number[]} = { xs: [1, 2, 3] };
console.log((present.xs ?? []).length);
let maybe: string[] | undefined = undefined;
const fallback = maybe ?? [];
console.log(fallback.length);
const m = new Map<string, number[]>();
console.log((m.get("nope") ?? []).length);
`);
  });

  // 7. annotated object-literal field
  test("an annotated object type supplies the element type of a field", async () => {
    await expectNode(`
const o: {xs: number[], name: string} = { xs: [], name: "n" };
console.log(o.xs.length, o.name);
`);
  });

  // 8. ternary merge — one arm is []
  test("a conditional merges [] with the other arm's array type", async () => {
    await expectNode(`
function pick(flag: boolean): number[] { return flag ? [1, 2] : []; }
console.log(pick(true).join(","));
console.log(pick(false).length);
const empty = false ? ["a"] : [];
console.log(empty.length);
`);
  });

  // 9. array of objects / nested
  test("object-element and nested array element types come from context", async () => {
    await expectNode(`
const rows: {a: number}[] = [];
console.log(rows.length);
const grid: number[][] = [];
console.log(grid.length);
const grown = [...rows, {a: 1}];
console.log(grown.length, grown[0].a);
`);
  });

  // 10. no context at all — still rejected, but with a diagnostic that teaches
  test("a context-free [] is still rejected, with the three fixes named", () => {
    const src = `let xs = [];\nconsole.log(xs.length);`;
    let err: NTError | undefined;
    try {
      sourceToIR(src);
    } catch (e) {
      err = e as NTError;
    }
    expect(err).toBeInstanceOf(NTError);
    expect(err!.diag.code).toBe("NT1001");
    // The rendered form is what `nativets run` prints — message + `help:` line.
    const rendered = formatDiagnostic(err!.diag, src);
    expect(rendered).toContain("cannot infer the element type of an empty array literal");
    expect(rendered).toContain("annotate the binding");
    expect(rendered).toContain("annotate the return type");
    expect(rendered).toContain("non-empty literal");
  });

  // Interactions: an empty array is an ordinary linear value — dropped exactly once.
  test("an empty array is dropped exactly once (arrLive balances)", async () => {
    await expectOut(`
function f(): number {
  const a: number[] = [];
  const b = move(a);
  return b.length;
}
console.log(f());
console.log(__arrLive());
`, "0\n0\n");
  });

  test("JSON.stringify of an empty array matches node", async () => {
    await expectNode(`
const xs: number[] = [];
console.log(JSON.stringify(xs));
const o: {xs: string[]} = { xs: [] };
console.log(JSON.stringify(o));
`);
  });
});
