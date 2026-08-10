import { entries, values, keys, v } from "./store.ts";

// The entry module's names are NOT mangled, so the bug needs the loops to live in an
// imported module — which is why this is a two-file case rather than a flat fixture.
console.log(entries());
console.log(values());
console.log(keys());
console.log(v);
