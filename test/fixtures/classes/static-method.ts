// `static` methods. A static method has no receiver — it is a namespaced top-level
// function — so `C.m(...)` calls it with no `this`. Node runs these natively, so this
// fixture is a true differential test.
class Sym {
  static globalSym(name: string): string {
    return `@nt.g.${name}`;
  }
}

console.log(Sym.globalSym("count"));
