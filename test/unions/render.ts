/*
 * SH2 — RENDERING a union.
 *
 * `console.log` and `JSON.stringify` are generated from the STATIC type, walking a
 * known field layout. A narrowed union has one, so both are byte-exact against node.
 * An UN-narrowed one does not, and each renderer's fallback is silent (a bare newline
 * / the literal `null`) — the Stage-48 defect class — so it is refused instead
 * (NT1025). The refusal half lives in test/unions.test.ts.
 *
 * Not borrowed: the TypeScript conformance suite does not run its cases, so it has
 * nothing to say about what they print.
 */

interface Ok {
  kind: "ok";
  value: number;
}

interface Err {
  kind: "err";
  message: string;
  code: number;
}

type Result = Ok | Err;

function report(r: Result): void {
  switch (r.kind) {
    case "ok":
      console.log(r);
      console.log(JSON.stringify(r));
      break;
    case "err":
      console.log(r);
      console.log(JSON.stringify(r));
      break;
  }
}

report({ kind: "ok", value: 42 });
report({ kind: "err", message: "boom", code: 3 });

// narrowed by elimination, then rendered
function line(r: Result): string {
  if (r.kind === "err") {
    return "E" + r.code + " " + r.message;
  }
  return "= " + r.value;
}

console.log(line({ kind: "ok", value: 7 }));
console.log(line({ kind: "err", message: "nope", code: 1 }));
