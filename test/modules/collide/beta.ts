const TAG = "beta";

export class Box {
  v: number;
  constructor(v: number) {
    this.v = v * 10;
  }
  show(): string {
    return `${TAG}:${this.v}`;
  }
}

export function label(n: number): string {
  return `${TAG}[${n}]`;
}

export function make(n: number): Box {
  return new Box(n);
}
