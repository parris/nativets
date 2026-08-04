const data = { user: { id: 7, name: "Ada", tags: ["x", "y", "z"] } };
console.log(data.user.id, data.user.name);
console.log(data.user.tags[2], data.user.tags.length);

function sum(...nums: number[]): number {
  let t: number = 0;
  for (const n of nums) t += n;
  return t;
}
console.log(sum(1, 2, 3), sum(), sum(10, 20, 30, 40));
