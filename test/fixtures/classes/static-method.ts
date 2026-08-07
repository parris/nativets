// `static` methods. A static method has no receiver — it is a namespaced top-level
// function — so `C.m(...)` calls it with no `this`. Node runs these natively, so this
// fixture is a true differential test.
class Sym {
  static globalSym(name: string): string {
    return `@nt.g.${name}`;
  }
}

console.log(Sym.globalSym("count"));

// Real work: several parameters, locals, a loop and a branch — a static method is an
// ordinary function body, it just has no receiver.
class Fmt {
  static pad(s: string, width: number, fill: string): string {
    let out = s;
    while (out.length < width) out = fill + out;
    return out;
  }
}

console.log(Fmt.pad("7", 3, "0"));
console.log(Fmt.pad("abcd", 3, "0"));
console.log(Fmt.pad("", 4, "-"));

// A static may call another static on its own class through the class name — including
// itself, recursively. Function declarations hoist, so the callee may be declared later.
class Ir {
  static indent(depth: number): string {
    if (depth <= 0) return "";
    return "  " + Ir.indent(depth - 1);
  }
  static line(depth: number, text: string): string {
    return Ir.indent(depth) + text;
  }
}

console.log(Ir.line(0, "define i32 @main() {"));
console.log(Ir.line(1, "ret i32 0"));
console.log(Ir.line(3, "; deep"));
