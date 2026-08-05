import { fromB } from "./b.ts";

export function fromA(): number {
  return fromB() + 1;
}
