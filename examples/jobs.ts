// jobs.ts — a supervised job router whose protocol is a RECORD, not a number or a
// hand-packed string. This is what B3 v5 (structured messages) buys: the message is
// the data structure you'd actually design, and the reply address travels inside it.
//
//   * a TAGGED-UNION protocol — `{ op, id, prio, from }` in, `{ id, status, note }`
//     out — deep-copied on send, so a worker never aliases its client's heap;
//   * PRIORITY dispatch via a SELECTIVE receive on a FIELD of the record (`prio > 0`),
//     with the skipped jobs left in the mailbox in order (OTP's save queue);
//   * REPLY-TO inside the message (`from: self()`), so no name registry is needed for
//     the clients — the shape of real GenServer calls;
//   * CLIENTS that wait with a timeout, so a request to a worker that dies mid-flight
//     reports a timeout instead of hanging;
//   * SUPERVISION: the poison job kills the worker, the one_for_one supervisor restarts
//     it under the same registered name, and the crash record on stderr renders the
//     record that killed it (`{"op":"render",...}`) plus its shape.
//
// Not runnable under `node` (spawn/send/receive are nativets builtins); the cooperative
// scheduler makes its output byte-stable, so test/actors-msg.test.ts asserts it exactly.

type Job = { op: string; id: number; prio: number; from: number };
type Res = { id: number; status: number; note: string };

const NO_JOB: Job = { op: "", id: 0, prio: 0, from: 0 };
const NO_RES: Res = { id: 0, status: 0, note: "" };

function serve(j: Job): void {
  console.log("  jobs: " + (j.prio > 0 ? "! " : "  ") + j.op + "#" + j.id);
  if (j.op === "render") { __crash(9); } // the poison job: kills this worker
  send(j.from, { id: j.id, status: 200, note: j.op + " ok" });
}

// The worker loop: poll for a priority job first (`receiveMatch(pred, 0)` is Erlang's
// `after 0` — scan the mailbox, never block), otherwise take the next job in order.
const worker = (x: number): void => {
  while (true) {
    const hot: Job | undefined = receiveMatch((j: Job): boolean => j.prio > 0, 0);
    if (hot === undefined) {
      const j: Job = receive();
      serve(j);
    } else {
      serve(hot ?? NO_JOB);
    }
  }
};

// A client submits its job — stamping its own pid as the reply address — and waits for
// the reply, giving up after 50ms.
const client = (job: Job): void => {
  send(whereis("jobs"), { op: job.op, id: job.id, prio: job.prio, from: self() });
  const r: Res | undefined = receive(50);
  if (r === undefined) {
    console.log("job " + job.id + ": TIMEOUT");
  } else {
    const res: Res = r ?? NO_RES;
    console.log("job " + res.id + ": " + res.status + " " + res.note);
  }
};

supervise(
  [{ id: "jobs", start: (): number => spawn(worker, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 }
);
__drain();

// Three jobs pile up. The worker is parked in a plain receive, so it takes the first in
// arrival order (thumbnail) — then the priority poll runs against the rest of the mailbox
// and pulls the prio=1 job AHEAD of the index job that arrived before it, while `index`
// stays queued in order (the save queue) and is served next.
console.log("-- priority dispatch");
spawn(client, { op: "thumbnail", id: 1, prio: 0, from: 0 });
spawn(client, { op: "index", id: 2, prio: 0, from: 0 });
spawn(client, { op: "invoice", id: 3, prio: 1, from: 0 });
__drain();

// The poison job kills the worker: its client times out, the supervisor restarts it.
console.log("-- crash + restart");
spawn(client, { op: "render", id: 4, prio: 0, from: 0 });
__drain();

// The restarted worker serves under the same NAME (new pid, known-good state).
console.log("-- after restart");
spawn(client, { op: "thumbnail", id: 5, prio: 0, from: 0 });
__drain();
