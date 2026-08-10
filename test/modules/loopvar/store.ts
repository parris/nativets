// Every loop binding below DELIBERATELY shares a name with a top-level binding of this
// same module. The linker alpha-renames a non-entry module's top-level names UNIFORMLY —
// declarations and uses, at every depth — so a loop binding it renames in one place and
// not the other stops referring to itself and starts referring to the module const.
//
// `v` is the one that was broken: `ForOfStmt.name2`, the VALUE binding of
// `for (const [k, v] of map)`, was the only binding the renamer never visited. The reads
// of `v` in the body were renamed to the module's mangled `v` — this `999` — so the loop
// printed the const on every iteration instead of the map's values, with exit 0.
export const v = 999;
export const k = 888;
export const item = 777;
export const key = 666;

export function entries(): string {
  const m = new Map<string, number>().set("a", 1).set("b", 2);
  let out = "";
  for (const [k, v] of m) out = `${out}${k}=${v};`;
  return `${out}consts=${k},${v}`;
}

export function values(): string {
  let out = "";
  for (const item of [10, 20, 30]) out = `${out}${item};`;
  return `${out}const=${item}`;
}

export function keys(): string {
  const o = { alpha: 1, beta: 2 };
  let out = "";
  for (const key in o) out = `${out}${key};`;
  return `${out}const=${key}`;
}
