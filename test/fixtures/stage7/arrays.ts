const xs: number[] = [3, 1, 4, 1, 5];
let sum: number = 0;
for (const x of xs) {
  sum += x;
}
// Immutable model: build a NEW array instead of mutating (`[...xs, 9]`, not `xs.push(9)`).
const ys: number[] = [...xs, 9];
console.log(sum, ys.length, ys.join("-"));
console.log(ys.includes(4), ys.indexOf(5), xs.length); // xs unchanged: still length 5
const words: string[] = ["hi", "there"];
console.log(words[1], words.join(" "), words.length);
