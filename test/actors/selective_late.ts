// v4: the match arrives AFTER the scan is exhausted. The actor scans [1, 2], finds
// nothing, and blocks; a second actor then sends 9. On wake it resumes scanning at
// the first message it has NOT examined (index 2) — BEAM's save-queue restart — so
// the late message is found immediately and 1, 2 are still queued in order.
const waiter = (x: number): void => {
  const m = receiveMatch((v: number): boolean => v === 9);
  console.log(m);           // 9 (arrived while blocked)
  console.log(receive());   // 1
  console.log(receive());   // 2
};
const feeder = (target: number): void => { send(target, 9); };
const w = spawn(waiter, 0);
send(w, 1);
send(w, 2);
__drain();                  // w scans [1,2], no match, blocks
spawn(feeder, w);
__drain();                  // feeder sends 9 -> w wakes and rescans from index 2
