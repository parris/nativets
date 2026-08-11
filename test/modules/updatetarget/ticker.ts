// A non-entry module whose top-level `let` is driven by the UPDATE forms (`x++`, `++x`,
// `x--`), not by an assignment. The binding is deliberately named `counter` — the same
// name the ENTRY declares — so a missed rename does not merely look wrong, it silently
// reads and writes the entry's cell instead of this module's.
export let counter = 0;

export function bumpTwice(): number {
  counter++;
  ++counter;
  return counter;
}

export function backOne(): number {
  counter--;
  return counter;
}

export function current(): number {
  return counter;
}
