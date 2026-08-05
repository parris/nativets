// A structured SPAWN argument — the actor's initial state — is deep-copied like any
// message, so a child never starts out aliasing its parent's heap.

type Conf = { name: string; limit: number };

const worker = (c: Conf): void => {
  console.log(c.name + " up to " + c.limit);
  const m: Conf = receive();
  console.log(m.name + " up to " + m.limit);
};

const w = spawn(worker, { name: "w1", limit: 3 });
send(w, { name: "w2", limit: 9 });
__drain();
