import { one } from "./lib.ts";

// The exported-async-function case is pinned by bad-async-floating. This is the ARROW
// spelling of the same export: node prints `Promise { 1 }`, so erasing it to `1` would
// be a silent wrong answer. The export table has to publish arrow async-ness too.
console.log(one());
