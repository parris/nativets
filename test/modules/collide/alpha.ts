// Deliberately uses the SAME names as beta.ts (and as main.ts): the linker renames
// each module's top-level bindings so they cannot collide in the one LLVM module.
const TAG = "alpha";

export class Box {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
  show(): string {
    return `${TAG}:${this.v}`;
  }
}

export function label(n: number): string {
  return `${TAG}(${n})`;
}

export function make(n: number): Box {
  return new Box(n);
}
