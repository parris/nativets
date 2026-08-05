// Optional param `x?: T` erases to a nullable `T | undefined` with an implicit
// undefined default, so it can be omitted or passed a nullable value.
function label(prefix: string, suffix?: string): string {
  return prefix + (suffix ?? "!");
}
console.log(label("a"));           // omitted -> "a!"
const s: string | undefined = "x";
console.log(label("b", s));        // nullable arg -> "bx"

function scale(n: number, factor?: number): number {
  return n * (factor ?? 2);
}
console.log(scale(5));             // omitted -> 10
const f: number | undefined = 3;
console.log(scale(5, f));          // -> 15
