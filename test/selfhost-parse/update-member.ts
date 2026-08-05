// `++`/`--` on a MEMBER or INDEX target. `UpdateExpr` only modelled an identifier, so
// `this.pos++` (src/parser.ts) and `b.count++` (src/coverage.ts) were unparseable.
//
// Mutability is decided exactly as for a plain assignment (Stage 29): a `Uint8Array`
// element is writable, and `this.f` is writable while the constructor is building the
// instance. `o.f++` on an ordinary (immutable) object is NT1606 — asserted in
// test/selfhost-parse.test.ts, not here, since node would happily run it.

const u = new Uint8Array(4);
u[0] = 10;
u[1] = 250;

console.log(u[0]++, u[0]);   // postfix yields the OLD value
console.log(++u[0], u[0]);   // prefix yields the NEW value
console.log(u[0]--, u[0]);
console.log(--u[0], u[0]);
u[1]++;
u[1]++;
console.log(u[1]);           // 250 + 2, wrapped to a byte by ToUint8

// The index expression is evaluated once, and only once.
let calls = 0;
function idx(): number { calls = calls + 1; return 2; }
u[idx()]++;
console.log(u[2], calls);

class Counter {
  private n: number;
  constructor(start: number) {
    this.n = start;
    this.n++;          // writable while the constructor builds the instance
    this.n++;
  }
  get(): number { return this.n; }
}
console.log(new Counter(40).get());
