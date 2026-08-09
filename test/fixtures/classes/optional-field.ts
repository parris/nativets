// An OPTIONAL class field (`s?: T`). The `?` used to be parsed and thrown away, so the
// field was typed `T` and an unassigned one read back as a zero slot — `(null)` for a
// string, `0` for a number — where node reads `undefined`. Assigned or not, the answer
// must be node's.
class M {
  v: number;
  s?: string;
  n?: number;
  constructor(v: number) { this.v = v; }
}
class Filled {
  s?: string;
  constructor(s: string) { this.s = s; }
}
const a = new M(1);
console.log(a.s);
console.log(typeof a.s);
console.log(a.n);
console.log(a);
const f = new Filled("here");
console.log(f.s);
console.log(f);
