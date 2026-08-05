// v4: DEEP COPY on send — the receiver must never alias the sender's string.
// `build` mints a fresh heap string, sends it, and returns; its local is refcounted
// (Stage 30) and released at scope exit, so the sender's buffer is FREED before the
// receiver ever runs. If send aliased instead of copying, the receiver would read
// freed memory; with the copy it prints the message intact.
const printer = (x: number): void => {
  const m: string = receive();
  console.log(m);
};
const build = (p: number, n: number): void => {
  const tmp = "msg-" + n;      // fresh heap string, dropped when build() returns
  send(p, tmp);
};
const p = spawn(printer, 0);
build(p, 1);
__drain();
