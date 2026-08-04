function makeCounter() {
  let count = 0;
  return () => {
    count++;
    return count;
  };
}
const c = makeCounter();
console.log(c(), c(), c());
const d = makeCounter();
console.log(d(), c());
