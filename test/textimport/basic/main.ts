// A `with { type: "text" }` import binds the file's contents as a compile-time
// string constant. node cannot run THIS file (it has no `text` import attribute),
// so `oracle.ts` next to it is the node-runnable twin that must print the same bytes.
import payload from "./payload.txt" with { type: "text" };

console.log(payload.length);
console.log(payload);
