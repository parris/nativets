const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
const shifted = pts.map((p) => ({ x: p.x + 10, y: p.y }));
console.log(shifted[0].x, shifted[1].x, shifted[2].x);

const big = pts.filter((p) => p.x >= 3);
console.log(big.length);
for (const p of big) console.log(p.x, p.y);

const sums = pts.map((p) => p.x + p.y);
console.log(sums[0], sums[1], sums[2]);
