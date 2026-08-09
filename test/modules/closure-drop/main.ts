/*
 * `add`'s closure env is allocated in a BLOCK and never escapes it, so the ownership pass
 * frees it at the block's exit and `__objLive()` reads 0 on the next line. It did — until
 * lib.ts was linked beside it and contributed an unrelated local also spelled `add`.
 *
 * The block matters: a top-level `const` is freed by the module's END drops, which run
 * after the last statement, so the counter could never see the difference.
 *
 * Not in the differential CASES list: `__objLive` is a nativets-only counter with no node
 * equivalent, so this one is asserted directly (see modules.test.ts).
 */
import { lib } from "./lib.ts";

const n: number = 3;
{
  const add = (x: number): number => x + n;
  console.log(add(4));
}
console.log(lib(1));
console.log(__objLive());
