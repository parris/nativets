// v4: actor messages are STATICALLY typed but travel through one 8-byte slot, so a
// receive compiled for `number` must never reinterpret a string pointer as a double.
// The sender's kind rides with the message and the receive checks it: on a mismatch
// the program fails loudly with a diagnostic (reject-don't-miscompile), instead of
// printing garbage. Here the receive has no annotation, so it defaults to number,
// while the sender sends a string.
const worker = (x: number): void => {
  console.log(receive());   // inferred `number` — but a string arrives
};
const w = spawn(worker, 0);
send(w, "surprise");
__drain();
