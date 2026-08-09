/*
 * An unrelated module whose functions happen to use the name `t` — as a parameter here,
 * as a local below. Neither can be reached by the counter's closure in counter.ts: they
 * are different bindings that merely spell the same word.
 */
export interface Tok { kind: string; value: string }

export function isPunct(t: Tok | undefined, v: string): boolean {
  return !!t && t.kind === "punct" && t.value === v;
}

export function widest(toks: Tok[]): number {
  let t = 0;
  for (const tok of toks) if (tok.value.length > t) t = tok.value.length;
  return t;
}
