// A LINEAR field read off a BORROWED receiver is an ALIAS, and HANDING IT OUT is E0507.
//
// It used to be neither — nothing recorded the binding at all, so it became an ordinary
// linear local and scope exit freed storage the receiver still points at:
//
//   type Box = { lines: string[] };
//   function probe(o: Box): string { const b = o.lines; return b.join("|"); }
//   const o: Box = { lines: ["a", "b"] };
//   probe(o);
//   console.log(o.lines.join("|"));   // node "a|b";  we printed an EMPTY LINE, at exit 0
//
// The same shape through a `@@mutable` class field SEGFAULTED (exit 139). The fix is the
// alias mechanism `collectAliases` already had for `@@mutable` handles and `.reverse()`,
// which is why the READS below are accepted — refusing them would reject a shape this
// compiler's own source is full of — and only the ESCAPES are NT1604.
type Box = { lines: string[] };

function readThroughParamField(o: Box): number {
  const b = o.lines;      // legal: an alias, dropped by nobody here
  return b.length;
}

function escapeParamField(o: Box): string[] {
  const b = o.lines;
  return b; //~ ERROR NT1604
}

class Holder {
  lines: string[] = ["a", "b"];
  readThroughThisField(): number {
    const b = this.lines; // legal: `this` is the caller's, and `b` only names its field
    return b.length;
  }
  escapeThisField(): string[] {
    const b = this.lines;
    return b; //~ ERROR NT1604
  }
}

// The THIRD borrowed receiver: a `for-of` element over a linear element type. The array
// owns the element for the loop's extent, so its field is borrowed exactly as `this`'s is.
// This one SEGFAULTED (exit 139) rather than printing a wrong answer.
type Tok = { parts: string[] };

function readThroughElementField(toks: Tok[]): number {
  let n = 0;
  for (const t of toks) {
    const b = t.parts;    // legal: an alias of the element the array still owns
    n = n + b.length;
  }
  return n;
}

function escapeElementField(toks: Tok[]): string[] {
  for (const t of toks) {
    const b = t.parts;
    return b; //~ ERROR NT1604
  }
  return [];
}

const h = new Holder();
console.log(readThroughParamField({ lines: ["a"] }), h.readThroughThisField(), escapeParamField({ lines: [] }).length, h.escapeThisField().length);
console.log(readThroughElementField([{ parts: ["a"] }]), escapeElementField([]).length);
