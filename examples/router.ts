// router.ts — a tiny supervised request router, in actors.
//
// The shape you'd actually build with BEAM-style concurrency, in ~60 lines of
// ordinary TypeScript compiled to a native binary with no runtime:
//
//   * a supervised HANDLER (registered "api") that serves string requests and is
//     restarted by a one_for_one supervisor when a bad request kills it;
//   * PRIORITY dispatch via a SELECTIVE receive — a "!"-tagged request is served
//     before anything already queued ahead of it, and the skipped requests stay in
//     the mailbox in order (OTP's save queue);
//   * CLIENTS that wait for their reply with a TIMEOUT, so a request to a handler
//     that dies mid-flight reports a timeout instead of hanging forever;
//   * addressing by NAME (register/whereis), so a restarted handler keeps serving
//     under the same name even though its pid changed.
//
// Protocol (all messages are strings): a request is "<client> <path>", optionally
// prefixed with "!" for priority; a reply is "200 <path>". The path "/boom" makes
// the handler crash — the supervisor restarts it and the crash record on stderr
// names the offending message.
//
// Not runnable under `node` (spawn/send/receive are nativets builtins); the
// cooperative scheduler makes its output byte-stable, so test/actors-v4.test.ts
// asserts it exactly.

function serve(req: string): void {
  const urgent = req.slice(0, 1) === "!";
  const line = urgent ? req.slice(1) : req;
  const parts = line.split(" ");
  const who = parts[0];
  const path = parts[1];
  console.log("  api: " + (urgent ? "! " : "  ") + path);
  if (path === "/boom") { __crash(7); }
  send(whereis(who), "200 " + path);
}

// The handler loop: poll for a priority request first (`receiveMatch(pred, 0)` is
// Erlang's `after 0` — check the mailbox, never block), otherwise take the next
// request in arrival order.
const handler = (x: number): void => {
  while (true) {
    const urgent: string | undefined = receiveMatch((m: string): boolean => m.slice(0, 1) === "!", 0);
    if (urgent === undefined) {
      const req: string = receive();
      serve(req);
    } else {
      serve(urgent ?? "");
    }
  }
};

// A client sends its request line and waits for a reply, giving up after 50ms.
const client = (req: string): void => {
  send(whereis("api"), req);
  const reply: string | undefined = receive(50);
  const line = req.slice(0, 1) === "!" ? req.slice(1) : req;
  const name = line.split(" ")[0];
  if (reply === undefined) { console.log(name + ": TIMEOUT"); }
  else { console.log(name + ": " + (reply ?? "")); }
};

const ask = (name: string, req: string): void => { register(name, spawn(client, req)); };

supervise(
  [{ id: "api", start: (): number => spawn(handler, 0), restart: "permanent" }],
  { strategy: "one_for_one", maxRestarts: 5, maxSeconds: 5 }
);
__drain();

// Three requests pile up. The handler is parked in a plain receive, so it takes the
// first one in arrival order (/users) — then the priority poll runs against the rest
// of the mailbox and pulls /health AHEAD of the /stats that arrived before it, while
// /stats stays queued in order (the save queue) and is served next.
console.log("-- priority dispatch");
ask("c1", "c1 /users");
ask("c2", "c2 /stats");
ask("c3", "!c3 /health");
__drain();

// A request that kills the handler: its client times out, the supervisor restarts.
console.log("-- crash + restart");
ask("c4", "c4 /boom");
__drain();

// The restarted handler serves under the same NAME (new pid, known-good state).
console.log("-- after restart");
ask("c5", "c5 /users");
__drain();
