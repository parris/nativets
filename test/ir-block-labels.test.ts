/*
 * BLOCK-LABEL RESOLUTION on the emitted module.
 *
 * `sourceToIR` is check -> analyzeOwnership -> codegen: it returns TEXT, and clang never
 * runs. So `emit` exited 0 on a module clang then rejected — a `try`/`finally` with no
 * `catch` emitted `br label %catchN` naming a block it never defined, and the compiler
 * reported success. That source is refused now (NT1004), but nothing stopped the next
 * one: "emit exits 0" cannot distinguish valid IR from invalid, and it is the gate this
 * project reads as "reaches IR".
 *
 * `verifyBlockLabels` closes exactly that hole and nothing else — every `label %X` inside
 * a `define` must name a block defined in the SAME `define`. It is a compiler-bug check,
 * so it raises `InternalError`, never an `NT****` code: an NT code tells the reader to
 * rewrite their program, and there is nothing here for them to rewrite.
 *
 * The failing side is pinned against clang: the module in the first test is the one
 * codegen really produced with the NT1004 refusal disabled, and `clang -x ir -c` rejects
 * it with `error: use of undefined value '%catch1'` — the same label, the same verdict.
 */

import { test, expect, describe } from "bun:test";
import { verifyBlockLabels } from "../src/codegen.ts";
import { InternalError } from "../src/diagnostics.ts";
import { sourceToIR } from "../src/driver.ts";

describe("verifyBlockLabels fires", () => {
  // The historical shape, byte for byte. Hand-written, because the source that produced
  // it is now refused by NT1004 — the labels are the ones codegen actually emitted.
  test("a `br` to an undefined block is an InternalError", () => {
    const ir = [
      "; ModuleID = 'nativets'",
      "define double @f(double %n) {",
      "entry:",
      "  br label %L0",
      "L0:",
      "  br label %catch1",
      "endtry2:",
      "  ret double 0.0",
      "}",
    ].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow(InternalError);
    expect(() => verifyBlockLabels(ir)).toThrow("catch1");
    // It names the function, so the report says WHERE.
    expect(() => verifyBlockLabels(ir)).toThrow("@f");
  });

  // Either arm of a conditional branch, not just the first.
  test("the false arm of a `br i1` is checked too", () => {
    const ir = [
      "define void @g() {",
      "entry:",
      "  br i1 true, label %then1, label %ghost",
      "then1:",
      "  ret void",
      "}",
    ].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow("ghost");
  });

  // Block labels are scoped to their `define` — `this.lbl` resets per function, so `L0`
  // exists in every one of them. A cross-function branch must not resolve.
  test("a label defined in ANOTHER function does not resolve", () => {
    const ir = [
      "define void @a() {",
      "entry:",
      "  br label %shared9",
      "shared9:",
      "  ret void",
      "}",
      "define void @b() {",
      "entry:",
      "  br label %shared9",
      "}",
    ].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow("@b");
    expect(() => verifyBlockLabels(ir)).toThrow("shared9");
  });

  // The check must not go quiet on a body it failed to find the end of.
  test("an unterminated body still has its references checked", () => {
    const ir = ["define void @c() {", "entry:", "  br label %ghost"].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow("ghost");
  });

  // A `phi` incoming block and `blockaddress` name blocks without the `label` keyword,
  // so `labelRefs` cannot see them. Codegen emits neither; if it ever does, the check
  // must say it is not checking them rather than wave the module through.
  test("a `phi` is refused as an unchecked block-reference form", () => {
    const ir = [
      "define double @p() {",
      "entry:",
      "  br label %L0",
      "L0:",
      "  %t0 = phi double [ 0.0, %entry ], [ 1.0, %nowhere ]",
      "  ret double %t0",
      "}",
    ].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow(InternalError);
    expect(() => verifyBlockLabels(ir)).toThrow("phi");
  });

  test("a `blockaddress` is refused as an unchecked block-reference form", () => {
    const ir = [
      "define ptr @q() {",
      "entry:",
      "  ret ptr blockaddress(@q, %entry)",
      "}",
    ].join("\n");
    expect(() => verifyBlockLabels(ir)).toThrow("blockaddress");
  });
});

describe("verifyBlockLabels does not fire spuriously", () => {
  // Every block-producing construct in one program: if / else, while, do/while, for,
  // for-of, switch, ternary, && / ||, ?? , optional chain, try/catch, labelled break.
  test("a program using every branching construct emits and verifies", () => {
    const src = `
class Item { constructor(public label: string) {} }
function all(n: number, s: string | null, items: Item[]): string {
  let out = "";
  if (n > 0) { out = out + "p"; } else if (n < 0) { out = out + "n"; } else { out = out + "z"; }
  let i = 0;
  while (i < n) { out = out + "w"; i = i + 1; }
  do { out = out + "d"; i = i - 1; } while (i > 0);
  for (let k = 0; k < 2; k++) { if (k === 1) continue; out = out + "f"; }
  for (const it of items) { out = out + it.label; }
  switch (n) { case 0: out = out + "a"; break; case 1: out = out + "b"; break; default: out = out + "c"; }
  out = out + (n > 1 ? "t" : "e");
  const label = s ?? "none";
  out = out + label;
  if (n > 0 && n < 10) out = out + "&";
  if (n < 0 || n > 100) out = out + "|";
  try { if (n === 42) throw new Error("x"); out = out + "y"; } catch (e) { out = out + "c"; }
  return out;
}
console.log(all(1, null, [new Item("q")]));
`;
    const ir = sourceToIR(src);
    expect(() => verifyBlockLabels(ir)).not.toThrow();
    expect(ir.includes("br label %")).toBe(true);
  });

  // `%label`, `%label.addr` and `@Item.label` are VALUES. The word `label` inside a name
  // is not a block operand, and a program with a field named `label` emits all three.
  test("identifiers containing `label` are not block references", () => {
    const src = `
class Item { constructor(public label: string) {} }
function show(label: string, it: Item): string { return label + it.label; }
console.log(show("a", new Item("b")));
`;
    const ir = sourceToIR(src);
    expect(ir.includes("%label")).toBe(true); // the hazard is really present
    expect(() => verifyBlockLabels(ir)).not.toThrow();
  });

  // A module-level string constant can hold ANY text. Only `define` bodies are scanned,
  // so a string that spells a branch is not one.
  test("a string constant that spells a branch is not a block reference", () => {
    const ir = sourceToIR(`console.log("br label %ghost ; label %phantom");\n`);
    expect(ir.includes("label %ghost")).toBe(true); // present, as a constant
    expect(() => verifyBlockLabels(ir)).not.toThrow();
  });

  // Same for a variable named `phi`: the tripwire matches an OPCODE, not a name.
  test("a variable named `phi` is not a `phi` instruction", () => {
    const ir = sourceToIR(`function phi(x: number): number { return x + 1; }\nconst phi2 = phi(1);\nconsole.log(phi2);\n`);
    expect(() => verifyBlockLabels(ir)).not.toThrow();
  });
});
