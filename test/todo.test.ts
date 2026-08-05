/*
 * Immutable todo demo (examples/todo.ts) — reads a command stream from argv and
 * applies it to an immutable todo list, so it uses the Host I/O differential
 * harness (identical argv passed to `node` and to our compiled binary).
 *
 * Exercises the immutable array-of-record update pattern end-to-end: functional
 * spread append (`list = [...list, item]`), and `.map` rebuilding the whole list
 * into fresh records to "complete" a todo — never `.push` / `arr[i] = v` / `o.f = v`.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "todo.ts"), "utf8");

const cases: string[][] = [
  ["add", "buy milk", "add", "walk dog", "done", "0", "list"], // add x2 + complete one
  ["add", "a", "add", "b", "add", "c", "done", "1", "done", "2"], // complete two of three
  ["list"], // no todos -> just the header
  [], // no args at all
  ["add", "only one"], // a single todo, never completed
  ["add", "x", "done", "0", "add", "y", "done", "1", "add", "z"], // interleaved add/done
  ["done", "3"], // complete a non-existent id -> no-op
];

describe("examples/todo.ts (immutable, argv-driven)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
