// v2: trapExit. A trapping actor that links a `bomb` does NOT die when the bomb
// crashes — the exit arrives as a message instead (carrying the dead pid, since v0
// messages are numbers). The trapper prints the notice, then keeps running and
// handles a follow-up message, proving it survived. main=0, trapper=1, bomb=2.
const bomb = (x: number): void => { const m = receive(); __crash(5); };
const trapper = (x: number): void => {
  trapExit(true);
  const bp = spawn(bomb, 0);
  register("bomb", bp);
  link(bp);
  const notice = receive();   // bomb crashes -> EXIT delivered as a message = bomb pid
  console.log(notice);        // 2
  const again = receive();    // still alive -> handle a follow-up ping
  console.log(again);         // 42
};
const tp = spawn(trapper, 0); register("trapper", tp);
__drain();
send(whereis("bomb"), 1);     // bomb crashes; trapper survives with an EXIT notice
__drain();
send(whereis("trapper"), 42); // trapper is alive -> prints 42
__drain();
