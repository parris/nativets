// A string bound to a new name is a copy in spirit (value semantics): using the
// source after the alias is legal and both read the same characters. RC must not
// change this — no move errors, no freed-out-from-under aliasing.
function repeatJoin(word: string, n: number): string {
  let out: string = "";
  for (let i: number = 0; i < n; i = i + 1) {
    const t: string = word;      // alias
    out = out + t;               // use the alias
    out = out + word;            // use the source too
  }
  return out;
}

const a: string = "ab";
const b: string = a;             // alias a
const c: string = a + b;         // both still usable -> "abab"
console.log(c);
console.log(repeatJoin(c, 3));
console.log(a, b, c);
