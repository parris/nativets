// SELECTIVE receive over a tagged union: take the priority message out of the middle of
// the mailbox and leave everything queued ahead of it in place, in order — OTP's save
// queue, restored for the next receive by construction (here: the two plain receives).

type Cmd = { kind: string; n: number };

const worker = (x: number): void => {
  const hot: Cmd = receiveMatch((m: Cmd): boolean => m.kind === "urgent");
  console.log(hot.kind + " " + hot.n);
  const a: Cmd = receive();
  console.log(a.kind + " " + a.n);
  const b: Cmd = receive();
  console.log(b.kind + " " + b.n);
};

const w = spawn(worker, 0);
send(w, { kind: "normal", n: 1 });
send(w, { kind: "normal", n: 2 });
send(w, { kind: "urgent", n: 9 });
__drain();
