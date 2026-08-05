import { label, scaleAll, SCALE } from "./lib.ts";

function firstOf<T>(xs: T[]): T { return xs[0]; }

const nums: number[] = [7, 8, 9];
const strs: string[] = ["a", "b"];
console.log(label(firstOf(nums)));    // T = number
console.log(label(firstOf(strs)));    // T = string
console.log(scaleAll(nums).join(","), SCALE);
