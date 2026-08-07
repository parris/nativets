import { one } from "./lib.ts";

// No `await`: under node this prints `Promise { 1 }`, because the value IS a promise.
// nativets erased the `async`, so it would print `1` — a silent wrong answer. The
// floating-async guard must reach ACROSS the module boundary and refuse (NT1020).
console.log(one());
