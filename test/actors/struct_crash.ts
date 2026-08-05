// v5: the crash record names a STRUCTURED triggering message. The runtime has no types,
// so codegen hands it a per-shape renderer (the JSON.stringify walk) that is called only
// while printing the record — so "which message killed it" stays readable for records.
// One record per crash: dead pid + id, reason, the message, and the restart decision.

type Cmd = { op: string; id: number };

const worker = (x: number): void => {
  while (true) {
    const cmd: Cmd = receive();
    if (cmd.op === "boom") { __crash(7); } else { console.log(cmd.op + "/" + cmd.id); }
  }
};

const sup = supervise(
  [{ id: "w", start: (): number => spawn(worker, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 }
);
__drain();
send(whereis("w"), { op: "boom", id: 42 }); // crash -> record -> restart
__drain();
send(whereis("w"), { op: "ok", id: 1 });    // the restarted worker answers
__drain();
