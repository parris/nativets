// Empty `[]` takes its element type from context: a variable annotation, a return
// type, or an assignment target. Then it behaves as a normal (empty) array.
const a: number[] = [];
console.log(a.length);
for (const x of a) console.log("unreachable", x);

const s: string[] = [];
console.log([...s, "x", "y"].join("-"));

function makeEmpty(): number[] {
  return [];
}
console.log(makeEmpty().length);

let m: number[] = [1, 2];
m = [];
console.log(m.length);

const grown = [...a, 10, 20, 30];
console.log(grown.join(","));
console.log(grown.with(1, 99).join(","));
console.log(grown[0]);
