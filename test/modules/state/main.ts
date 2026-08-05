import { bump, joined, mapped, counter, NAMES } from "./state.ts";

console.log(bump(), bump(), bump());
console.log(joined("-"));
console.log(mapped());
console.log(NAMES.length);
console.log(counter); // 3, not 0 — an imported binding is live, not a copy
