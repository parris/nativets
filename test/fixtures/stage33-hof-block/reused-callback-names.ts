// Two HOF callbacks in the SAME enclosing function reuse a parameter name (`acc`) at
// DIFFERENT types (number vs string). Inlined into one flat frame, they must each get
// their own correctly-typed slot — else the second `acc` (a string ptr) is read as a
// double and prints garbage (regression guard for the HOF-inlining name collision).
const nums: number[] = [1, 2, 3, 4];
const words: string[] = ["a", "bb", "ccc"];

const numSum = nums.reduce((acc, n) => acc + n, 0);
const strCat = words.reduce((acc, w) => acc + w, "");
console.log(numSum);
console.log(strCat);

// Reused block-body local `r`, different types across two maps.
const inc = nums.map((n) => { const r = n + 1; return r; });
const bang = words.map((w) => { const r = w + "!"; return r; });
console.log(inc.join(","));
console.log(bang.join(","));

// Reused name as a callback param AND an enclosing capture in a sibling callback.
const scaled = nums.map((numSum2) => numSum2 * numSum);
console.log(scaled.join(","));
