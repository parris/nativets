/*
 * A module that does one thing: DECLARE the name `add` — as a local of its own function,
 * where nothing outside this file can reach it. It exists to be linked next to a main.ts
 * whose top-level closure happens to share the spelling.
 */
export function lib(k: number): number {
  let add = 0;
  add = add + k;
  return add;
}
