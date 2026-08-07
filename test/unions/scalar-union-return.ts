function pick(b: boolean): number | string {
  if (b) return 7;
  return "seven";
}
console.log(pick(true));
console.log(pick(false));
const r: number | string = pick(false);
if (typeof r === "string") console.log(r.toUpperCase());
