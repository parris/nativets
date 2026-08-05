// inventory/main.ts — a small multi-module app: a stock report.
//
//   main.ts ──▶ report.ts ──▶ model.ts        (the Item class)
//          │             └──▶ lib/money.ts    (formatting)   ┐ diamond:
//          ├──▶ model.ts                                     │ each module is
//          └──▶ lib/money.ts                                 ┘ loaded ONCE
//
// nativets links the whole graph into ONE native binary (self-hosting SH1) and
// prints exactly what `node examples/inventory/main.ts` prints:
//
//   node examples/inventory/main.ts
//   bun run src/cli.ts run examples/inventory/main.ts

import { catalogue, type Category } from "./model.ts";
import { heading, line, subtotal } from "./report.ts";
import { money } from "./lib/money.ts";

const items = catalogue();

console.log(heading("INVENTORY"));
for (const it of items) console.log(line(it));

const groups: Category[] = ["tool", "food", "book"];
console.log("");
console.log(heading("BY CATEGORY"));
let grand = 0;
for (const g of groups) {
  const s = subtotal(items, g);
  grand = grand + s;
  console.log(g.padStart(8) + "  " + money(s));
}
console.log("");
console.log("grand total: " + money(grand));
