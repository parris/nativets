// v4: a selective receive that NEVER matches must still time out (Erlang's
// `receive Pattern -> ... after N -> ...`), and — critically — the messages it
// scanned past are NOT consumed: they are still queued afterwards, in order.
const picky = (x: number): void => {
  const m: number | undefined = receiveMatch((v: number): boolean => v === 42, 50);
  if (m === undefined) { console.log(-1); } else { console.log(m); }
  console.log(receive());   // 7 — scanned but not matched, so still in the mailbox
  console.log(receive());   // 8
};
const p = spawn(picky, 0);
send(p, 7);
send(p, 8);
__drain();
