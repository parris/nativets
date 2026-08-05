// Array-destructure elision holes `[, , x]` and `[, ...rest]`.
const nums: number[] = [10, 20, 30, 40, 50];
const [, , third] = nums;
console.log(third);

const words: string[] = ["a", "b", "c", "d"];
const [, second, ...rest] = words;
console.log(second);
console.log(rest.join("-"));
