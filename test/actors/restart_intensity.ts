// v3: restart-intensity escalation. maxRestarts:1 within maxSeconds:5. The first
// kill is restarted (new pid); a SECOND kill within the window exceeds intensity,
// so the supervisor itself exits :shutdown and does NOT restart the child. We prove
// escalation by observing that the registered pid is UNCHANGED after the second kill
// (no new child) and a later message to it is dropped (the child stayed dead).
// Deterministic pids: main=0, supervisor=1, worker=2, restart#1 worker=3.
const worker = (state: number): void => {
  let s = state;
  while (true) { const m = receive(); if (m === 1) { console.log(s); } }
};
const sup = supervise(
  [{ id: "w", start: (): number => spawn(worker, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 1, maxSeconds: 5 }
);
__drain();
console.log(whereis("w"));         // 2
__kill(whereis("w")); __drain();   // restart #1 -> new pid
console.log(whereis("w"));         // 3
__kill(whereis("w")); __drain();   // exceeds intensity -> supervisor exits, no restart
console.log(whereis("w"));         // 3 (UNCHANGED -> escalated, no new child)
send(whereis("w"), 1); __drain();  // pid 3 is dead -> dropped, no output
console.log(999);                  // sentinel: reached the end
