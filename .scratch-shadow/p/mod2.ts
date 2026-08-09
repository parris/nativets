import { shared, use } from "./mod1.ts";
console.log(shared);
console.log(use());
{ const shared: number = 7; console.log(shared); }
console.log(shared);
