const xs: number[] = [3, 1, 4, 1, 5];
let sum: number = 0;
for (const x of xs) {
  sum += x;
}
xs.push(9);
console.log(sum, xs.length, xs.join("-"));
console.log(xs.includes(4), xs.indexOf(5), xs.pop());
const words: string[] = ["hi", "there"];
console.log(words[1], words.join(" "), words.length);
