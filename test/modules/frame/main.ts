import { LEFT } from "./left.ts";
import { RIGHT } from "./right.ts";

// …and the entry reuses the same names once more, at yet another type.
for (const item of [true, false]) {
  console.log(item);
}
const tmp = LEFT + RIGHT;
console.log(tmp);
