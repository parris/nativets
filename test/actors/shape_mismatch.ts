// THE SHAPE TAG. Sender and receiver are typed INDEPENDENTLY, and a message rides in one
// 8-byte slot — so a coarse "it's an object" tag cannot tell two record types apart.
// Every structured message therefore carries its shape, and a receive compiled for a
// different shape stops with a diagnostic naming both, instead of reading the wrong slots.

const worker = (x: number): void => {
  const m: { a: number } = receive();
  console.log(m.a);
};

const w = spawn(worker, 0);
send(w, { b: "nope" });
__drain();
