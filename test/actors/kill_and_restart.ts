// v3: the canonical OTP kill-and-assert-restart. A `counter` (0=inc, else report)
// is supervised one_for_one and auto-registered as "c". After two incs its state is
// 2; a brutal __kill fires an exit to the supervisor, which restarts the child to
// KNOWN-GOOD initial state (state 0) under a NEW pid. We print: the pre-crash pid,
// the post-restart pid (different), and the fresh state (0, not the pre-crash 2).
// Deterministic pids: main=0, supervisor=1, counter=2, restarted counter=3.
const counter = (state: number): void => {
  let s = state;
  while (true) {
    const m = receive();
    if (m === 0) { s = s + 1; } else { console.log(s); }
  }
};
const sup = supervise(
  [{ id: "c", start: (): number => spawn(counter, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 }
);
__drain();                    // supervisor starts the counter, registers "c"
send(whereis("c"), 0);        // inc
send(whereis("c"), 0);        // inc
__drain();                    // state == 2
console.log(whereis("c"));    // 2 (pre-crash pid)
__kill(whereis("c"));         // brutal kill -> supervisor restarts to known-good state
__drain();
console.log(whereis("c"));    // 3 (new pid, different)
send(whereis("c"), 1);        // report -> prints the fresh state
__drain();                    // 0 (reset, NOT the pre-crash 2)
