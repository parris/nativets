class Greeter {
  name: string;
  count: number;
  constructor(name: string, count: number) {
    this.name = name;
    this.count = count;
  }
  greeting(): string {
    return "Hello, " + this.name;
  }
  shout(): string {
    return this.greeting() + "!";
  }
  banner(): string {
    return this.shout() + " (x" + this.count + ")";
  }
}

const g = new Greeter("world", 3);
console.log(g.name);
console.log(g.greeting());
console.log(g.shout());
console.log(g.banner());
console.log(g["count"]);
