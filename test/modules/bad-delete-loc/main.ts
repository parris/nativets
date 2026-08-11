// A DECOY entry: `strip` in ./lib.ts is refused for its `delete`, on lib.ts LINE 5 —
// and line 5 HERE is a valid `const`. A span carrying no `file` is rendered against the
// entry source, so before the fix the caret underlined `const decoy2 = 2;` in this file
// and lib.ts was never named at all.
const decoy2 = 2;
import { strip } from "./lib.ts";
console.log(strip({ a: 7, b: 8 }), decoy2);
