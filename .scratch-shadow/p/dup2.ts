function run(f: (k: number) => number): number {
  const f = (k: number): number => k + 20;
  return f(1);
}
console.log(run((k: number): number => k + 1));
console.log(__objLive());
