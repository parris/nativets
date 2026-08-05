// A namespace import has no static member set to lower → NT1017.
import * as lib from "./lib.ts";

console.log(lib.x);
