// v4: STRING messages. Both the spawn argument and sent messages can be strings;
// the message type comes from the body's parameter type / the declared type of the
// binding (`const greeting: string = receive()`), and the runtime checks the kind so
// a mismatch is a hard error rather than a reinterpreted pointer.
// Selective receive works over strings too — routing on a text tag, which is what
// makes actors usable for anything real.
const worker = (name: string): void => {
  const greeting: string = receive();
  console.log(greeting + ", " + name);
  // take the "job:" message first, even though "noise" arrived before it
  const job = receiveMatch((m: string): boolean => m.slice(0, 4) === "job:");
  console.log(job);
  const rest: string = receive(); // "noise" is still queued (save queue)
  console.log(rest);
};
const w = spawn(worker, "world");
send(w, "hello");
send(w, "noise");
send(w, "job:compile");
__drain();
