const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
let sum = 0;
for (const p of pts) {
  sum += p.x + p.y;
  console.log(p.x, p.y);
}
console.log(sum);
