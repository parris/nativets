// TAGGED-UNION MESSAGES — how every real actor program dispatches. One record type per
// protocol with a `kind` discriminator; the actor is a state machine over its mailbox.

type Cmd = { kind: string; n: number };

const adder = (x: number): void => {
  let total = 0;
  while (true) {
    const m: Cmd = receive();
    if (m.kind === "add") {
      total = total + m.n;
    } else if (m.kind === "print") {
      console.log("total=" + total);
    } else {
      console.log("done");
      return;
    }
  }
};

const w = spawn(adder, 0);
send(w, { kind: "add", n: 3 });
send(w, { kind: "add", n: 4 });
send(w, { kind: "print", n: 0 });
send(w, { kind: "stop", n: 0 });
__drain();
