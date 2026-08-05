// Mutable module-level state + a module-level ARRAY, both read (and written) from
// this module's functions. Note `counter`: ESM imports are LIVE bindings, so the
// importer sees the value AFTER bump() ran — a whole-program link gets this for
// free, since there is exactly one cell.
export let counter = 0;
export const NAMES: string[] = ["a", "b", "c"];

export function bump(): number {
  counter = counter + 1;
  return counter;
}

export function joined(sep: string): string {
  return NAMES.join(sep);
}

// A HOF whose inlined callback closes over BOTH module-level bindings.
export function mapped(): string {
  const ups = NAMES.map((s: string): string => s.toUpperCase() + counter);
  return ups.join("|");
}
