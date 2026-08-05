// Minimal smoke program for the Windows CI job.
// Exercises arithmetic + string concatenation only (no POSIX runtime deps),
// so it can compile + run as a native Windows binary via `--target windows`.
// node stays the oracle: `node ci/smoke.ts` prints exactly the two lines below.
const a = 6;
const b = 7;
console.log("result=" + a * b);
console.log("hello " + "world");
