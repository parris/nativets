import { fromA } from "./a.ts";

export function fromB(): number {
  return 1;
}

export function viaA(): number {
  return fromA();
}
