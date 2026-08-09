/*
 * Ambient declarations for bun's TEXT IMPORTS of the C runtime.
 *
 * `src/driver.ts` embeds `runtime/*.c` and `runtime/*.h` as strings so that a
 * `bun build --compile` single executable carries its own runtime:
 *
 *     import runtimeSource from "../runtime/runtime.c" with { type: "text" };
 *
 * bun resolves these at bundle time; tsc has no idea what a `.c` module is, and
 * `@types/bun` only declares the extensions bun ships loaders for by default
 * (`*.txt`, `*.svg`, …) — not `.c`/`.h`. Without these two declarations every one
 * of the twelve embeds is a TS2307 "cannot find module", which is a fact about the
 * type-checker's module map and NOT about the code.
 *
 * Deliberately in `types/` and NOT in `src/`: `test/selfhost-ratchet.test.ts` and
 * `test/no-regex.test.ts` both enumerate the compiler's modules as
 * `readdirSync(src).filter((f) => f.endsWith(".ts"))`, and `.d.ts` ends with `.ts`.
 * A declaration file dropped into `src/` would be measured as a thirteenth compiler
 * module and asked to compile itself.
 */

declare module "*.c" {
  const contents: string;
  export default contents;
}

declare module "*.h" {
  const contents: string;
  export default contents;
}
