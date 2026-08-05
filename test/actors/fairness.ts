// v1 reduction-counted preemption — the no-starvation anchor (research §3 test #9).
// A "hog" prints 1, then runs a long compute loop, then prints 2. A "tick" actor
// just prints 3. Under a COOPERATIVE-ONLY scheduler the hog (which never blocks in
// receive) would run to completion first → 1,2,3. With reduction-counted preemption
// the hog is forced to yield at a loop back-edge mid-compute, so the tick actor runs
// BEFORE the hog finishes → 1,3,2. Deterministic (single scheduler + fixed budget).
const hog = (x: number) => {
  console.log(1);
  let s = 0;
  for (let j = 0; j < 100000; j = j + 1) {
    s = s + 1;
  }
  console.log(2);
};
const tick = (x: number) => {
  console.log(3);
};
spawn(hog, 0);
spawn(tick, 0);
__drain();
