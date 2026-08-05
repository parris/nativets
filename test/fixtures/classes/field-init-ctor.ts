class Cart {
  items: number[] = [1, 2];
  total = 0;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
    this.total = this.total + 10;
  }
  summary(): string {
    return this.tag + ": items=" + this.items.length + " total=" + this.total;
  }
}
const c = new Cart("vip");
console.log(c.summary());
console.log(c.items.length);
console.log(c.total);
console.log(c.items[0] + c.items[1]);
