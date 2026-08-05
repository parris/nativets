// v1 reduction-counted preemption — two long compute loops INTERLEAVE.
// Two identical "hog" actors each print id*10 + i for i in 0..2, doing a compute
// burst (bigger than one reduction budget) BEFORE each print. Cooperative-only,
// the first-spawned hog would print its whole block (10,11,12) before the second
// (20,21,22). With preemption they are forced to yield mid-burst and the scheduler
// round-robins them, so the two streams interleave. Deterministic under the single
// fixed-budget scheduler (the exact interleave is a pure function of the program).
const hog = (id: number) => {
  let i = 0;
  while (i < 3) {
    let s = 0;
    for (let j = 0; j < 6000; j = j + 1) {
      s = s + 1;
    }
    console.log(id * 10 + i);
    i = i + 1;
  }
};
spawn(hog, 1);
spawn(hog, 2);
__drain();
