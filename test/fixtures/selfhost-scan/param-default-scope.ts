// A parameter DEFAULT is an expression, and it is evaluated at call time in the scope
// that encloses the function — so it can name a module-level binding, exactly like the
// function's body can.
//
// WHY THIS FIXTURE EXISTS. `src/ownership.ts` declares
//     const NO_MUTABLE: MutableInfo = { ... };
//     class Analyzer { constructor(..., private mutable: MutableInfo = NO_MUTABLE, ...) }
// and that one line was ownership.ts's self-hosting blocker: the checker reported
// `[NT2001] 'NO_MUTABLE' is not defined` for a const declared 84 lines above it. The
// signature pass typed every default against a fresh BUILTINS-ONLY scope, so no
// identifier in a default could ever resolve. It was invisible until now because the
// other four defaults in that same constructor are `[]` and `new Map()` — self-contained
// expressions that need no scope to type — so `NO_MUTABLE` was the only one that looked.
//
// The parameter-property form (`private mutable: T = X`) is a nativets extension that
// node's strip-only mode refuses, so the shape is distilled here to the plain-parameter
// form that node runs, which is the same code path in the checker.

const DEFAULT_N = 7;
const DEFAULT_S = "fallback";

// The blocker's exact shape: an ANNOTATED parameter whose default is a bare identifier.
function withNum(n: number = DEFAULT_N): number {
  return n * 2;
}

function withStr(s: string = DEFAULT_S): string {
  return s.toUpperCase();
}

// An expression default, not just a bare identifier.
function offset(n: number = DEFAULT_N + 1): number {
  return n;
}

// NOT covered here: a default that reads the parameters to its LEFT
// (`function span(start, end = start + 1)`). That is ordinary JavaScript and node runs
// it, but codegen materializes defaults before the parameter allocas are stored, so it
// emits a load from an undefined `%start.addr`. It is still REJECTED by the checker —
// pinned as a refusal in test/bootstrap.test.ts — rather than miscompiled.

// The same rule inside a class constructor, which is where ownership.ts hit it.
class Box {
  n: number;
  constructor(n: number = DEFAULT_N) {
    this.n = n;
  }
  get(): number {
    return this.n;
  }
}

console.log(withNum(), withNum(1));
console.log(withStr(), withStr("given"));
console.log(offset(), offset(0));
console.log(new Box().get(), new Box(1).get());
