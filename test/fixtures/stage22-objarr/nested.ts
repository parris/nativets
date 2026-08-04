const rows = [
  { pos: { x: 1, y: 2 }, tags: [10, 20] },
  { pos: { x: 3, y: 4 }, tags: [30, 40, 50] },
];
console.log(rows[0].pos.x, rows[0].pos.y);
console.log(rows[1].pos.x, rows[1].tags[2]);
console.log(rows[0].tags.length, rows[1].tags.length);
for (const r of rows) {
  console.log(r.pos.x + r.pos.y, r.tags[0]);
}
