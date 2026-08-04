// v0 actor: spawn + send + receive. An echo actor bounces the message back to
// the parent, who prints it. Deterministic under the single cooperative scheduler.
const echo = (parent: number) => {
  const m = receive();
  send(parent, m);
};
const me = self();
const p = spawn(echo, me);
send(p, 42);
console.log(receive());
