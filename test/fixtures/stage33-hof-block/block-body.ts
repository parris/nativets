// Block-body arrows in .map/.filter/.reduce: the statements run per element and the
// `return` yields the element result (map value / filter boolean / reduce accumulator).
const nums: number[] = [1, 2, 3, 4, 5];

// map: intermediate const + return
const mapped = nums.map((n) => {
  const d = n * 2;
  return d + 1;
});
console.log(mapped.join(","));

// filter: an early guard then a predicate
const kept = nums.filter((n) => {
  if (n < 2) return false;
  return n % 2 === 1;
});
console.log(kept.join(","));

// reduce: a block with an intermediate
const total = nums.reduce((sum, n) => {
  const step = sum + n;
  return step;
}, 0);
console.log(total);

// block-body map producing strings + a capture
const factor = 10;
const labels = nums.map((n) => {
  const scaled = n * factor;
  const even = n % 2 === 0;
  return even ? scaled + "e" : scaled + "o";
});
console.log(labels.join(" "));

// string-accumulator reduce with a block
const words: string[] = ["a", "bb", "ccc"];
const glued = words.reduce((acc, w) => {
  const piece = acc + w + "-";
  return piece;
}, "");
console.log(glued);
