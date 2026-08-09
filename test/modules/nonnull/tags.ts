/*
 * The `!` non-null assertion in a NON-ENTRY module. `ModuleGen.expr` (src/modules.ts)
 * had no `NonNullExpr` case, so `x!` fell through to the LITERAL default and nothing
 * under a `!` was ever alpha-renamed. Every name below is module-level and reached
 * through a `!`, which is precisely the shape that broke: a module-level `const`
 * (`'table' is not defined`) and a call (`NT1003 call to 'fields' — unknown callee`).
 *
 * Found at src/ast.ts:404 (`unionTagValues`), which is why seven of the twelve
 * compiler modules reported an ast.ts blocker they did not own.
 */
export const table: string[] = ["p", "q"];

export function fields(t: string): string[] { return [t + "!", t + "?"]; }

/** `!` on a CALL result, inside an arrow. */
export function firsts(xs: string[]): string[] { return xs.map((m) => fields(m)[0]!); }

/** `!` on a module-level CONST, inside an arrow. */
export function tagged(xs: string[]): string[] { return xs.map((m) => m + table[0]!); }

/** `!` at statement level, no arrow in sight — the bug was never arrow-specific. */
export function head(t: string): string { return fields(t)[1]!; }
