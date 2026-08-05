import { sum, biggest, describe } from "./stats.ts";

const nums: number[] = [3, 1, 4, 1, 5, 9, 2, 6];

console.log(sum(nums));
console.log(biggest(nums));
console.log(describe(nums));
console.log(nums.length); // still owned here — the calls above only borrowed it
