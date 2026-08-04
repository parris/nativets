let s: number = 0;
for (let i: number = 0; i < 6; i++) {
  if (i % 2 === 0) {
    continue;
  }
  s += i;
}
console.log(s);
