import { Scope, Box as LibBox, pick, widen, describeIt } from "./scope.ts";

const root = new Scope();
const kid = root.child();
const grandkid = kid.child();
console.log(root.depth(), kid.depth(), grandkid.depth());

const b = new LibBox("hi");
console.log(pick(undefined, b).label);
console.log(pick(new LibBox("a"), b).label);
console.log(widen(b)?.label);
console.log(widen(new LibBox(""))?.label);

// A COLLISION, on the model of the `rectypes` case: the ENTRY module declares its own
// `Box` with the same name and the same single field, differing only in its METHOD. The
// entry is not alpha-renamed, so its tag is the bare `Box` — precisely the spelling a
// stale `?UBox{label:string}` from scope.ts resolves to, and method resolution reads that
// tag. So this pins that the fix RENAMES the tag rather than merely permitting the
// mismatch: get it wrong and `describeIt` dispatches to the entry's method.
//
// Pre-fix this could not be a wrong answer, only a refusal — the call site compares a
// correctly-renamed argument against the stale parameter and never matches, so the
// diagnostic fires before dispatch can go wrong. That is why the bug was a FALSE REFUSAL
// class and the fix strictly widens what compiles.
class Box {
  label: string;
  constructor(label: string) { this.label = label; }
  describe(): string { return "ENTRY:" + this.label; }
}

console.log(new Box("m").describe());
console.log(describeIt(new LibBox("x")));
console.log(describeIt(undefined));
