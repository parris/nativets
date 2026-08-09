function run(): number {
  const a: number = 2;
  { const b: number = 30; const g = (): number => b + 1; return g(); }
}
console.log(run());
