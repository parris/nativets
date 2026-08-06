// A NON-entry module doing the host I/O. The linker merges every module into one
// Program, so the host builtins this module imported have to survive that merge.
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

export function describeFile(path: string): string {
  if (!existsSync(path)) return basename(path) + ": missing";
  return basename(path) + ": " + readFileSync(path, "utf8").trim().length + " chars";
}
