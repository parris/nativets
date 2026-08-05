// report.ts — presentation. Imports the domain (a class, used as a TYPE here)
// and the money formatter, and keeps its own module-level layout constants.

import { Item } from "./model.ts";
import { money } from "./lib/money.ts";

// Module-level constants: private to this module, visible to its functions.
const WIDTH = 22;
const RULE = "----------------------------------";

export function heading(title: string): string {
  return title + "\n" + RULE;
}

export function line(item: Item): string {
  return item.label().padStart(WIDTH) + "  x" + item.qty + "  " + money(item.total());
}

export function subtotal(items: Item[], category: string): number {
  let sum = 0;
  for (const it of items) {
    if (it.category === category) sum = sum + it.total();
  }
  return sum;
}
