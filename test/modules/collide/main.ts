import { label as labelA, make as makeA } from "./alpha.ts";
import { label as labelB, make as makeB } from "./beta.ts";

const TAG = "main";

console.log(labelA(1), labelB(1));
console.log(makeA(2).show());
console.log(makeB(2).show());
console.log(TAG);
