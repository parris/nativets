import { eraseOne, mapAll } from "./types.ts";

console.log(mapAll(["#T", "string", "#U"], eraseOne).join(","));
