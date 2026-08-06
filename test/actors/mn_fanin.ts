// v6 PROPERTY: fan-in under M:N. Four senders each post 50 numbered messages to one
// collector. Nothing about the INTERLEAVING is asserted — only the two things the actor
// model actually promises: every message arrives exactly once (count + sum), and messages
// from ONE sender arrive in the order that sender sent them (per-pair FIFO). The collector
// checks the ordering itself by tracking the last seq seen per sender, so the assertion
// holds under any schedule the runtime picks.
type Item = { from: number; seq: number };

const collector = (n: number): void => {
  let last = [0, 0, 0, 0, 0];   // last seq seen per sender (senders are 1..4)
  let got = 0;
  let sum = 0;
  let ordered = 1;
  while (got < n) {
    const m: Item = receive();
    if (m.seq !== last[m.from] + 1) { ordered = 0; }
    last = last.with(m.from, m.seq);
    sum = sum + m.seq;
    got = got + 1;
  }
  console.log("count=" + got);
  console.log("sum=" + sum);
  console.log("ordered=" + ordered);
};

const c = spawn(collector, 200);
const sender = (id: number): void => {
  for (let i = 1; i <= 50; i = i + 1) {
    send(c, { from: id, seq: i });
  }
};
for (let s = 1; s <= 4; s = s + 1) {
  spawn(sender, s);
}
__drain();
