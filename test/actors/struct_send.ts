// B3 v5 — a STRUCTURED message: an object record travels from one actor to another.
// The receiver's binding annotation is the message type; the value is deep-copied on
// send, so the receiver owns a private object and never aliases the sender's heap.

const worker = (x: number): void => {
  const m: { kind: string; n: number } = receive();
  console.log(m.kind + " " + m.n);
};

const w = spawn(worker, 0);
send(w, { kind: "work", n: 42 });
__drain();
