// Heavy heap-string creation, aliasing and concatenation in a loop. Reference
// counting must be INVISIBLE here: the output must match node byte-for-byte
// regardless of when strings are retained/released/freed.
function label(i: number): string {
  const base: string = "row-" + i;      // heap concat, owned
  const up: string = base.toUpperCase(); // heap method, owned
  const alias: string = up;              // value-semantics alias (both usable)
  return alias.slice(0, 5) + "|" + base;
}

let acc: string = "";
for (let i: number = 0; i < 8; i = i + 1) {
  const s: string = label(i);
  acc = acc + s + "\n";
}
console.log(acc);
console.log(acc.length);
