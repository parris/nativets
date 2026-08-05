// Imported by BOTH ./util.ts and ../greet.ts (a diamond). Its top-level statement
// must run EXACTLY ONCE — the linker loads every module once, in dependency order.
console.log("[shared] init");

export const PREFIX = ">> ";

export function stars(n: number): string {
  return "*".repeat(n);
}
