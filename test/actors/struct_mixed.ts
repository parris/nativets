// The shape tag drives the SAVE QUEUE, not just the error path. Two different record
// types share one mailbox; a selective receive compiled for `{label:string}` matches only
// that shape — the `{kind,n}` records queued ahead of it are skipped and left in order for
// the plain receives that follow. Without the shape on the wire the predicate would be
// handed a `{kind,n}` block and would read `n` (a double) as a string pointer.

type A = { kind: string; n: number };
type B = { label: string };

const worker = (x: number): void => {
  const b: B = receiveMatch((m: B): boolean => true);
  console.log("B " + b.label);
  const a1: A = receive();
  console.log("A " + a1.kind + a1.n);
  const a2: A = receive();
  console.log("A " + a2.kind + a2.n);
};

const w = spawn(worker, 0);
send(w, { kind: "x", n: 1 });
send(w, { kind: "y", n: 2 });
send(w, { label: "hello" });
__drain();
