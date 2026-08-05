// model.ts — the domain: an `Item` class and the catalogue it lives in.
//
// An exported CLASS crosses the module boundary as both a value (`new Item(…)`)
// and a type (`function f(i: Item)`), and an exported `type` is erased entirely.

export type Category = "tool" | "food" | "book";

export class Item {
  name: string;
  category: string;
  qty: number;
  unitPrice: number;

  constructor(name: string, category: string, qty: number, unitPrice: number) {
    this.name = name;
    this.category = category;
    this.qty = qty;
    this.unitPrice = unitPrice;
  }

  total(): number {
    return this.qty * this.unitPrice;
  }

  label(): string {
    return `${this.name} (${this.category})`;
  }
}

export function catalogue(): Item[] {
  return [
    new Item("hammer", "tool", 3, 12.5),
    new Item("wrench", "tool", 1, 19),
    new Item("beans", "food", 12, 1.25),
    new Item("rice", "food", 4, 3.5),
    new Item("SICP", "book", 2, 45),
  ];
}
