let s: number = 0;
for (let i: number = 0; i < 10; i++) {
  if (i === 5) {
    break;
  }
  s += i;
}
console.log(s);
