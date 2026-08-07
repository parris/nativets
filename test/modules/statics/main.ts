import { Sym } from "./sym.ts";

// A second class with the SAME static member names, declared locally: the two must not
// collide after mangling.
class Sym2 {
  static prefix = "local.";

  static of(name: string): string {
    return Sym2.prefix + name;
  }
}

console.log(Sym.of("count"));
console.log(Sym2.of("count"));
console.log(Sym.prefix + Sym2.prefix);
