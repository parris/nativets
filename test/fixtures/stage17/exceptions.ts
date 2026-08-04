function risky(n: number): string {
  try {
    if (n < 0) throw new Error("neg");
    return "ok " + n;
  } catch (e) {
    return "caught: " + (e as Error).message;
  } finally {
    console.log("cleanup");
  }
}
console.log(risky(5));
console.log(risky(-1));

try {
  throw "boom";
} catch (e) {
  console.log("got", e);
}
console.log("after");
