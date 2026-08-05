// A barrel module: re-export some of core's surface (renaming one), and add its own.
export { inc, dec as down, ORIGIN } from "./core.ts";

function twice(n: number): number {
  return n * 2;
}

export { twice };
