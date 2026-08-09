/*
 * The escaping-counter idiom (test/fixtures/stage11/counter.ts), in its own module.
 * `t` lives ONLY in the closure — nothing in THIS module mentions it again — so the
 * by-value capture IS the variable and NT1031 must allow the write.
 */
export function makeCounter(): () => number {
  let t = 0;
  return () => { t = t + 1; return t; };
}
