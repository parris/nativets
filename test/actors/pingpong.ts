// v0 actors: a two-actor ping/pong. The pinger sends its pid to the ponger, which
// prints (100) and replies; the pinger receives the reply and prints (200). The
// blocking receive() parks each actor until a message wakes it — exercising the
// BLOCKED->RUNNABLE wakeup edge in both directions. (Numbers stand in for tags:
// v0 messages are numbers.)
const ponger = (x: number) => {
  const from = receive();
  console.log(100);
  send(from, 1);
};
const pinger = (pongPid: number) => {
  send(pongPid, self());
  const ack = receive();
  console.log(200);
};
const pp = spawn(ponger, 0);
spawn(pinger, pp);
__drain();
