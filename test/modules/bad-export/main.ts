// `absent` is not exported by lib.ts → NT1703, listing what IS exported.
import { absent } from "./lib.ts";

console.log(absent());
