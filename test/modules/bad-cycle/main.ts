// a.ts ⇄ b.ts — a cycle. We name it and refuse (NT1702) rather than hang.
import { fromA } from "./a.ts";

console.log(fromA());
