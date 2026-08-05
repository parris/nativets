// Binding patterns in PARAMETER position — `([k, v]) => …` / `({ name, age }) => …`.
// Destructuring existed only as a DECLARATION desugaring (Stage 15); the same
// desugaring now runs for parameters, which is what `src/ownership.ts`'s
// `[...s].map(([k, v]) => …)` needs.

const pairs: number[][] = [[1, 2], [3, 4], [5, 6]];
console.log(pairs.map(([a, b]) => a + b).join(","));
console.log(pairs.map(([, b]) => b).join(","));        // elision hole
console.log(pairs.map(([a, ...rest]) => a + rest.length).join(","));

const people = [{ name: "ada", age: 36 }, { name: "alan", age: 41 }];
console.log(people.map(({ name, age }) => name + ":" + age).join(" "));
console.log(people.map(({ name: who }) => who).join(" "));
console.log(people.filter(({ age }) => age > 40).length);

// A block-bodied arrow, and a pattern alongside an ordinary parameter.
const label = (n: number, [a, b]: number[]): string => {
  const total = a + b;
  return n + "/" + total;
};
console.log(label(1, [10, 20]));

// Function declarations take patterns too.
function sum([a, b]: number[]): number {
  return a + b;
}
function greet({ name }: { name: string }): string {
  return "hi " + name;
}
console.log(sum([3, 4]));
console.log(greet({ name: "ada" }));

// Nothing captured by the desugaring leaks: the pattern's own names are ordinary locals.
const k = "outer";
console.log(people.map(({ name: k }) => k).join(","), k);
