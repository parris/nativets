// A template-literal type is an ordinary type ATOM, so it is legal everywhere a type
// is: parameter and return annotations, an object-type field, an array element, a
// generic type argument, and an `as` assertion. Every position erases to `string`.

// parameter + return annotation, written inline (no alias in between)
function label(prefix: `${string}:`, rest: string): `${string}` {
  return prefix + rest;
}

// object-type field, and an array of template-literal type
type Entry = { key: `k-${string}`; values: `${number}`[] };

function describe(e: Entry): string {
  return e.key + "=" + e.values.join(",");
}

// generic type argument
const paths: Array<`/${string}`> = ["/usr", "/bin"];

console.log(label("name:", "parris"));
console.log(describe({ key: "k-1", values: ["10", "20"] }));
console.log(paths.join(" "));

// `as` assertion in value position
const raw = "count:7";
console.log((raw as `${string}:${number}`).length);
