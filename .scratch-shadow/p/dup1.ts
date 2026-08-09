function run(): number {
  const f = (k: number): number => k + 1;
  const f = (k: number): number => k + 20;
  return f(1);
}
console.log(run());
console.log(__objLive());
