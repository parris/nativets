// Mirrors the shape of the one real `src/` site this lane unblocks: src/ast.ts exports
// `eraseTypeParams`, src/parser.ts imports it and passes it BY NAME to `mapTypesDeepExpr`
// (src/parser.ts:3359). After linking, the imported name is an ordinary top-level function
// declaration — which is exactly the thing that could not be referenced as a value.
export function eraseOne(t: string): string { return t.startsWith("#") ? "number" : t; }

export function mapAll(xs: string[], f: (t: string) => string): string[] {
  return xs.map((x) => f(x));
}
