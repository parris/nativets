// v2: exit-signal propagation over a link. `setup` links a `bomb`; when the bomb
// crashes abnormally, `setup` (NOT trapping) dies too. A second worker that is NOT
// linked survives. Pinging both afterwards prints only the survivor's line, proving
// the linked actor died from propagation. Deterministic under the single scheduler.
const worker = (x: number): void => { const m = receive(); console.log(m); };
const bomb = (x: number): void => { const m = receive(); __crash(1); };
const setup = (x: number): void => {
  const bp = spawn(bomb, 0);
  register("bomb", bp);
  link(bp);                 // link this actor to the bomb
  const m = receive();      // reached only if still alive
  console.log(m);
};
const lp = spawn(setup, 0); register("linked", lp);
const wp = spawn(worker, 0); register("survivor", wp);
__drain();
send(whereis("bomb"), 1);   // bomb crashes -> `linked` dies via propagation
__drain();
send(whereis("linked"), 100);    // dead: dropped
send(whereis("survivor"), 200);  // alive: prints 200
__drain();
