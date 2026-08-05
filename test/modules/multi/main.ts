import { banner, double, triple } from "./lib/util.ts";
import { greet } from "./greet.ts";

console.log("[main] init");
console.log(banner("report"));
console.log(double(21), triple(7));
console.log(greet("world"));
