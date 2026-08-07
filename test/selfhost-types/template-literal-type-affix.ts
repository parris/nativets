// Template-literal types with a LEADING and/or TRAILING literal segment. All three
// erase to `string`, so a value that does NOT match the pattern still type-checks —
// that non-enforcement is the deliberate divergence (docs/divergences.md). Shapes after
// the TypeScript conformance `types/literal/templateLiteralTypes.ts` prefix/suffix cases.
type Prefixed = `user-${string}`;   // leading literal segment
type Suffixed = `${string}px`;      // trailing literal segment
type Both = `[${string}]`;          // both

const id: Prefixed = "user-42";
const width: Suffixed = "16px";
const tag: Both = "[main]";

console.log(id);
console.log(width);
console.log(tag);

// Not matching the pattern — accepted, because we check these as plain `string`.
const loose: Prefixed = "nothing-like-it";
console.log(loose);
console.log(id.length + width.length + tag.length + loose.length);
