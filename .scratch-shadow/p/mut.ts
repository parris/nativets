const g = (): number => 100;
{
  const f = (): number => g() + 1;
  const g = (): number => 5;
  console.log(f());
}
console.log(g());
