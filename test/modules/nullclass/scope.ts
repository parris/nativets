// A class-instance type wrapped in `| null` / `| undefined`, in a NON-ENTRY module.
//
// The Ty encoding writes the nullable constructors as the two-character sigils `?N` and
// `?U` immediately before the type they wrap, so a nullable class instance encodes as
// `?NScope{parent:?N@Scope}`. The linker's tag rewriter scanned an IDENTIFIER run and
// renamed it when a `{` followed — and an identifier run starting at the sigil's `N`
// reads `NScope`, which is in no rename table. So exactly the nullable ones kept this
// module's PRE-rename tag while every other position was renamed, and the two spellings
// lost against each other: `expects ?NScope{…}, got _m0_Scope{…}`.
//
// Written with an explicit field rather than a ctor PARAMETER PROPERTY only because node's
// strip-only mode refuses those — the oracle has to run this file.

export class Scope {
  private parent: Scope | null;
  constructor(parent: Scope | null = null) { this.parent = parent; }

  child(): Scope { return new Scope(this); }

  depth(): number {
    const p = this.parent;
    return p === null ? 0 : 1 + p.depth();
  }
}

// The `?U` half of the pair, in ordinary parameter and return position.
export class Box {
  label: string;
  constructor(label: string) { this.label = label; }
}

// `?U` in PARAMETER position — the half that fired first. Both return freshly built
// values: handing a parameter back out is a move out of a borrow (NT1604), a real and
// separate rule that would mask what this case is about.
export function pick(a: Box | undefined, b: Box): Box {
  return a === undefined ? new Box(b.label) : new Box(a.label);
}

// `?U` in RETURN position.
export function widen(b: Box): Box | undefined {
  return b.label === "" ? undefined : new Box(b.label);
}
