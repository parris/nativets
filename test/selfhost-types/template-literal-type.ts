// A bare template-literal type `${string}` parses and is CHECKED AS PLAIN `string` —
// we do not enforce the pattern (docs/divergences.md). Shape borrowed from the
// TypeScript conformance case `types/literal/templateLiteralTypes.ts` (`type T = ...`).
type Anything = `${string}`;

const a: Anything = "hello";
console.log(a);
console.log(a.length);
console.log(a.toUpperCase());
