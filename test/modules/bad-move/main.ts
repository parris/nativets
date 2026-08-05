// The move checker runs over the LINKED program, so it sees uses that cross a
// module boundary: `nums` is moved on line 6 and then borrowed by an imported
// function on line 7 → NT1601 (use of moved value), exactly as in one file.
import { keep } from "./store.ts";

const nums: number[] = [1, 2, 3];
const owned: number[] = move(nums);
console.log(keep(nums));
console.log(owned.length);
