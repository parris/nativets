// v4: receive(ms) — an Erlang `after`-style timeout. The result is `T | undefined`
// (A2 nullable), so a timeout is observably DISTINCT from any real message value —
// never a sentinel number. Two actors, one fed and one starved:
//   b has a message waiting  -> receives 7 in time
//   a never gets one         -> its timeout fires and it prints -1
// Timeouts run on a VIRTUAL clock: no wall-clock sleeping, and a timeout can only
// fire when the whole system is idle (nothing runnable could still send), which is
// what keeps this schedule deterministic. main=0, a=1, b=2.
const waiter = (x: number): void => {
  const m: number | undefined = receive(50);
  if (m === undefined) { console.log(-1); } else { console.log(m); }
};
const a = spawn(waiter, 0);
const b = spawn(waiter, 0);
send(b, 7);
__drain();
