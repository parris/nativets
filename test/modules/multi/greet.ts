import { PREFIX } from "./lib/shared.ts";

console.log("[greet] init");

export function greet(who: string): string {
  return PREFIX + "hi " + who;
}
