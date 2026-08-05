// Array.isArray (compile-time from static type) + Array.from(str) (string -> char array).
const nums: number[] = [1, 2, 3];
const strs: string[] = ["a", "b"];
console.log(Array.isArray(nums));     // true
console.log(Array.isArray(strs));     // true
console.log(Array.isArray(42));       // false
console.log(Array.isArray("hello"));  // false
console.log(Array.isArray(true));     // false

const chars = Array.from("hello");
console.log(chars.length);            // 5
console.log(chars.join("-"));         // "h-e-l-l-o"
console.log(chars[0], chars[4]);      // "h" "o"
console.log(Array.isArray(chars));    // true
console.log(Array.from("").length);   // 0

// code-point iteration: multibyte chars stay single elements
const emoji = Array.from("a☃b");
console.log(emoji.length);            // 3
console.log(emoji.join("|"));         // "a|☃|b"
