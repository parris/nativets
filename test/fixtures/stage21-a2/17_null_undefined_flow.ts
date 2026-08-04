const a: { c: number } | null = null;
const b: { c: number } | undefined = undefined;
console.log(a?.c, b?.c);
console.log(a?.c ?? 1, b?.c ?? 2);
