// The closing edge. It binds no value: node erases the whole statement.
import type { Cell } from "./main.ts";

export function widen(c: Cell): number {
  return c.n + 1;
}
