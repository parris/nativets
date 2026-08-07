// A class whose statics are used from ANOTHER module. Both lower to module-level names
// (`Sym.of` / `Sym.prefix`) that the linker mangles per module, so this pins that a
// cross-module static call and static-field read still find their one definition.
export class Sym {
  static prefix = "@nt.g.";

  static of(name: string): string {
    return Sym.prefix + name;
  }
}
