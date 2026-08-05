class Counter {
  count = 0;
  label: string = "hits";
  active = true;
  bump(): number { return this.count + 1; }
  describe(): string { return this.label + "=" + this.count + " active=" + this.active; }
}
const c = new Counter();
console.log(c.count);
console.log(c.label);
console.log(c.active);
console.log(c.bump());
console.log(c.describe());
