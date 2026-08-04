const x: number | undefined = undefined;
console.log(x ?? 10);
const y: number | undefined = 0;
console.log(y ?? 10);
console.log(0 ?? 5, 0 || 5);
console.log("" ?? "x", "" || "x");
const z: number | null = null;
console.log(z ?? -1);
