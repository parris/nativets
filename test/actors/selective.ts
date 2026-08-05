// v4: SELECTIVE receive (OTP semantics). `receiveMatch(pred)` takes the first
// message satisfying `pred`; everything it skipped stays queued IN ORDER — Erlang's
// save queue, restored for the next receive. Here the mailbox is [1, 2, 200, 3]:
// the selective receive plucks 200 out of the middle, and the following plain
// receives still see 1, then 2, then 3 — original order, nothing lost or reordered.
const worker = (x: number): void => {
  const hi = receiveMatch((m: number): boolean => m >= 100);
  console.log(hi);            // 200 (matched out of the middle)
  console.log(receive());     // 1  \
  console.log(receive());     // 2   > save queue, in order
  console.log(receive());     // 3  /
};
const w = spawn(worker, 0);
send(w, 1);
send(w, 2);
send(w, 200);
send(w, 3);
__drain();
