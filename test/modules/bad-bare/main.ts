// There is no node_modules resolution: a bare specifier is NT1017.
import { readFileSync } from "node:fs";

console.log(typeof readFileSync);
