// v6 PROPERTY: the threads are REAL. Eight compute-bound actors (each burns far more than
// one reduction budget, so they are all runnable at once) are spawned before draining.
// Afterwards main reports how many schedulers actually ran an actor. Single-threaded that
// is necessarily 1; with N>1 scheduler threads the work is spread, which is the whole
// point of M:N — asserted as ">= 2", never as a particular assignment.
const hog = (id: number): void => {
  let s = 0;
  for (let j = 0; j < 200000; j = j + 1) {
    s = s + 1;
  }
  if (s < 0) console.log(id);   // keep the loop live; never printed
};
for (let i = 0; i < 8; i = i + 1) {
  spawn(hog, i);
}
__drain();
console.log("used>=2:" + (__schedUsed() >= 2));
console.log("used==1:" + (__schedUsed() === 1));
// Every spawn from `main` lands on scheduler 0's queue, so any scheduler other than 0
// that ran an actor must have WORK-STOLEN it. steals > 0 iff the work actually migrated.
console.log("stole:" + (__schedSteals() > 0));
