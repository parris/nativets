// v6: how many OS scheduler threads is this program running on? `__schedulers()` is a
// debug builtin (like __arrLive) that reports the resolved NATIVETS_SCHED_THREADS —
// 1 (the deterministic default) unless the env var asks for more.
const worker = (x: number) => {
  console.log(__schedulers());
};
spawn(worker, 0);
__drain();
