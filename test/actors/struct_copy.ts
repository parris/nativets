// DEEP COPY ON SEND — isolation, the whole point of the actor model.
//
// `fire` builds a record, sends it, and RETURNS: the record is an ordinary owned linear
// value, so it is freed (nt_obj_free) at that scope exit — before the receiver has run.
// If the message aliased the sender's heap the receiver would read freed memory, and the
// live-object delta across `fire` would be 0; the type-driven deep copy makes the message
// its own value, so exactly ONE object (the private copy) outlives the sender's scope.

const worker = (x: number): void => {
  const m: { tag: string; n: number } = receive();
  console.log(m.tag + ":" + m.n);
};

function fire(w: number): void {
  const req = { tag: "own", n: 5 };
  send(w, req);
} // `req` dropped HERE

function clobber(): number {
  const junk = { tag: "xxxxxxxx", n: 999 }; // reuses the block `req` just released
  return junk.n;
}

const w = spawn(worker, 0);
const before = __objLive();
fire(w);
console.log(__objLive() - before); // 1 — only the private copy outlives the sender
console.log(clobber());
__drain();
