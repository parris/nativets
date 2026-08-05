// roman-modular/main.ts — examples/roman.ts, split across real modules.
//
// Same program, same byte-for-byte output (its `.expected` is identical to
// examples/roman.ts.expected) — but now it is three files wired with `import` /
// `export`, which nativets links into ONE native binary (self-hosting SH1):
//
//   main.ts ──▶ encode.ts   (toRoman + the module-level VALUES/SYMBOLS tables)
//          └──▶ decode.ts   (fromRoman; its `romanValue` helper stays private)
//
// Run it exactly like any other example — the entry file's path is what
// `./encode.ts` resolves against, for `node` and for us alike:
//
//   node examples/roman-modular/main.ts
//   bun run src/cli.ts run examples/roman-modular/main.ts

import { toRoman } from "./encode.ts";
import { fromRoman } from "./decode.ts";

const nums: number[] = [4, 9, 40, 58, 90, 49, 1994, 2024, 3888, 3999];

for (const n of nums) {
  const r: string = toRoman(n);
  const back: number = fromRoman(r);
  console.log(n + " -> " + r + " -> " + back);
}
