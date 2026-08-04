const nums: number[] = [1, 2, 3, 4, 5];
console.log(nums.map((x) => x * 2).join(","));
console.log(nums.filter((x) => x % 2 === 1).join(","));
console.log(nums.reduce((acc, x) => acc + x, 0));
const factor: number = 3;
console.log(nums.map((x) => x * factor).join(","));
console.log([1, 2, 3, 4].map((x) => x * x).reduce((a, b) => a + b, 0));
