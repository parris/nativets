const grid = [[1, 2], [3, 4]];
console.log(JSON.stringify(grid, null, 2));
const empty: number[] = [];
const mix = { rows: [{ v: 1 }, { v: 2 }], empty };
console.log(JSON.stringify(mix, null, 3));
