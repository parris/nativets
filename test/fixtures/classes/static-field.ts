// A static field is module-level storage under a class-qualified name: it is read as
// `C.f`, and its initializer runs where the class is DECLARED (TS/JS static-field order).
class Sym {
  static prefix = "@nt.g.";
  static width = 4;

  static of(name: string): string {
    return Sym.prefix + name;
  }
}

console.log(Sym.prefix);
console.log(Sym.width);
console.log(Sym.of("count"));

// Read from an ordinary function, and from an instance method of another class.
function label(n: string): string {
  return Sym.of(n) + ":" + Sym.width;
}

class Emitter {
  n: number;
  constructor(n: number) { this.n = n; }
  emit(): string { return label("slot" + this.n); }
}

console.log(label("total"));
console.log(new Emitter(7).emit());
