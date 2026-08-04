// v2: monitor. A watcher monitors a target; when the target exits (normally, by
// returning), the watcher receives a DOWN notification (carrying the target pid).
// Monitors are unidirectional and fire on ANY exit, including a normal one.
// main=0, watcher=1, target=2.
const target = (x: number): void => { const m = receive(); }; // returns -> normal exit
const watcher = (x: number): void => {
  const tp = spawn(target, 0);
  register("target", tp);
  monitor(tp);
  send(tp, 1);              // target receives, then returns -> normal exit
  const down = receive();   // DOWN delivered = target pid
  console.log(down);        // 2
};
spawn(watcher, 0);
__drain();
