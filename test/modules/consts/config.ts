// Module-level bindings: an exported const is readable BOTH from the importing
// module's top level and from inside this module's own functions (the classic
// "a module's functions close over its module scope" requirement).
export const GREETING: string = "hello";
export const LIMIT: number = 3;

const SUFFIX = "!"; // private to this module

export function shout(name: string): string {
  return GREETING + ", " + name + SUFFIX;
}

export function underLimit(n: number): boolean {
  return n < LIMIT;
}
