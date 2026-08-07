/*
 * Parameter defaults, and the SCOPE they are typed in.
 *
 * `src/ownership.ts` was blocked by `[NT2001] 'NO_MUTABLE' is not defined` on
 *     constructor(..., private mutable: MutableInfo = NO_MUTABLE, ...)
 * naming a `const` declared 84 lines above it (src/ownership.ts:68). Not a missing
 * feature — the signature pass typed EVERY default against a builtins-only scope, so no
 * identifier in a default could resolve: not a module const, not a `let`, not a preceding
 * parameter. Only calls resolved, because those go through the function table.
 *
 * The working half is a node-differential fixture
 * (test/fixtures/selfhost-scan/param-default-scope.ts). What is pinned HERE is the
 * BOUNDARY — the shapes that must keep being refused, and why. Cases are hand-derived
 * from the blocker, not taken from a reference suite; there is no TypeScript checkout or
 * test262 on this machine to mine.
 */

import { test, expect, describe } from "bun:test";

import { sourceToIR } from "../src/driver.ts";

describe("a parameter default is typed in the MODULE scope", () => {
  test("a default may name a module-level const", () => {
    expect(() => sourceToIR("const D = 7;\nfunction f(n: number = D): number { return n; }\nconsole.log(f());"))
      .not.toThrow();
  });

  /*
   * `function f(a, b = a)` is ordinary JavaScript — node evaluates the parameter list left
   * to right and prints 3 for `f(3)` (verified, exit 0). We REFUSE it deliberately:
   * codegen materializes defaults BEFORE the parameter allocas are stored, so accepting it
   * emits a load from an undefined `%a.addr` and clang rejects the module. A first draft of
   * the fix did exactly that:
   *     error: use of undefined value '%start.addr'
   * so this pin is what keeps a future widening of the scope honest — reject, never
   * miscompile. It was already GREEN before the fix (the builtins-only scope refused every
   * identifier, including this one); its value is as a regression guard, and it is
   * non-vacuous — declaring the parameters before typing the defaults makes it fail.
   */
  test("a default may NOT name a parameter to its left — refused, not miscompiled", () => {
    expect(() => sourceToIR("function f(a: number, b: number = a): number { return b; }\nconsole.log(f(3));"))
      .toThrow(/'a' is not defined/);
  });

  // Refused by the same rule, and must STAY refused however the one above is fixed:
  // node throws `ReferenceError: Cannot access 'a' before initialization` (TDZ), verified.
  test("a default may NOT name itself", () => {
    expect(() => sourceToIR("function f(a: number = a): number { return a; }\nconsole.log(f());"))
      .toThrow(/'a' is not defined/);
  });
});
