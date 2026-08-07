export async function fetchOne(): Promise<number> {
  return 1;
}

// An exported `async function` that itself AWAITS: another exported async function
// from this module, and a plain already-resolved value (`await 41` is 41 under node
// too). Both are identity here, because nativets ran `fetchOne` to completion.
export async function bump(n: number): Promise<number> {
  const base = await fetchOne();
  return base + (await n);
}
