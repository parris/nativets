class Box {
  private value: number;
  public tag: string;
  readonly label: string;
  constructor(value: number, tag: string, label: string) {
    this.value = value;
    this.tag = tag;
    this.label = label;
  }
  get(): number {
    return this.value;
  }
  describe(): string {
    return this.label + "[" + this.tag + "]=" + this.value;
  }
}

const b = new Box(42, "vip", "answer");
console.log(b.get());
console.log(b.tag);
console.log(b.describe());
