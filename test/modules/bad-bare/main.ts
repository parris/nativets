// There is no node_modules resolution: a bare specifier is NT1017.
// (A `node:` specifier is DIFFERENT — those name compiler builtins, see SH4/NT1028.)
import { chunk } from "lodash";

console.log(typeof chunk);
