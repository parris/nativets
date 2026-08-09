const h = (): number => 100;
{
  const f = (): number => q() + 1;
  const q = (): number => 5;
  console.log(f());
}
console.log(h());
