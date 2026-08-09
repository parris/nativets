import { makeCounter } from "./counter.ts";
import { isPunct, widest } from "./tokens.ts";

const next = makeCounter();
console.log(next());
console.log(next());
console.log(next());

console.log(isPunct({ kind: "punct", value: "+" }, "+"));
console.log(isPunct(undefined, "+"));
console.log(widest([{ kind: "ident", value: "abc" }, { kind: "punct", value: "+" }]));
