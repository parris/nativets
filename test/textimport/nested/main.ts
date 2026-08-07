// A text import in a NON-entry module. Two things are being pinned:
//   1. the specifier resolves relative to the IMPORTING file, so `./data.txt` means a
//      different file in main.ts than it does in lib/embed.ts;
//   2. both modules bind the same local name (`banner`), so the linker's per-module
//      rename has to cover the materialized const like any other top-level binding.
import banner from "./data.txt" with { type: "text" };
import { fromLib } from "./lib/embed.ts";

console.log(banner.trim());
console.log(fromLib().trim());
console.log(banner === fromLib());
