// v4: the crash record names the TRIGGERING MESSAGE. A supervised worker takes
// string commands; "boom" makes it crash. The supervisor emits ONE record carrying
// the dead pid + id, the reason, the message that triggered it (printed as a string
// now that messages can be strings), and the restart decision. stdout stays clean —
// records go to stderr — and the restarted worker answers the next command.
const worker = (x: number): void => {
  while (true) {
    const cmd: string = receive();
    if (cmd === "boom") { __crash(7); } else { console.log(cmd); }
  }
};
const sup = supervise(
  [{ id: "w", start: (): number => spawn(worker, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 }
);
__drain();
send(whereis("w"), "boom");   // crash -> record -> restart
__drain();
send(whereis("w"), "ok");     // the restarted worker answers
__drain();
