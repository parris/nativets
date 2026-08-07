// MULTIPLE interpolations in one template-literal type, including a `${number}`
// placeholder and adjacent placeholders with no literal text between them. Each still
// erases to `string` — the placeholder's own type is dropped along with the pattern.
type Dashed = `${string}-${string}`;
type Size = `${number}x${number}`;
type Adjacent = `${string}${string}`;
type Braced = `{${string}:${string}}`;   // the `{${string}}` family, two holes deep

const d: Dashed = "left-right";
const s: Size = "1920x1080";
const a: Adjacent = "concatenated";
const b: Braced = "{k:v}";

console.log(d, s, a, b);
console.log(d.split("-").length);
console.log(s.indexOf("x"));
