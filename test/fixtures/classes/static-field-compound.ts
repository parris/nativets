// A static field holding a COMPOUND value — an object and an array, not just a scalar.
// A static is module-level storage, so the value is built once where the class is declared
// and every read reaches that same heap value; this pins the slot layout of both, read from
// top level and from inside a static method.
//
// (An initializer whose type cannot be inferred still needs an annotation — that limit is
// `inferFieldTy`, shared with instance fields, not something static changes.)
class Cfg {
  static opts: { width: number; tag: string } = { width: 80, tag: "x" };
  static arr: number[] = [1, 2, 3];

  static describe(): string {
    return `${Cfg.opts.tag}:${Cfg.opts.width}/${Cfg.arr[0]}${Cfg.arr[1]}${Cfg.arr[2]}`;
  }
}

console.log(Cfg.opts.width);
console.log(Cfg.opts.tag);
console.log(Cfg.arr[2]);
console.log(Cfg.arr.length);
console.log(Cfg.describe());
