/*
 * `expr as T` — the TYPE ASSERTION, as distinct from the `as const` assertion that
 * test/as-const.test.ts covers.
 *
 * `Checker.type`'s `AsExpr` case was an UNCHECKED IDENTITY RETYPE — it typed the
 * operand, threw that type away, and handed back the asserted one. Nothing downstream
 * ever revisited the decision, so `as` was a hole straight through three separate
 * guarantees at once. This file pins all three, `node` being the oracle for each.
 *
 * 1. MEMORY SAFETY (the worst of the three). `as` reinterprets a PLACE — it allocates
 *    nothing and copies nothing — so `const b = a as T;` gives one allocation two
 *    names. Ownership did not know that: `a` stayed live and owned, `b` became an owner
 *    too, and the scope freed the same pointer twice. A double free out of safe
 *    TypeScript, with no `@@mutable` and no `unsafe` construct anywhere, and a SILENT
 *    one — the allocator's abort discards buffered stdout, so the program printed
 *    nothing at all rather than printing a wrong answer.
 *
 *    The fix records `b` as an ALIAS of `a`, the same way `const b = a.reverse();`
 *    already was. Alias rather than MOVE is load-bearing: `a` is very often a borrowed
 *    PARAMETER, and `const c = e as Extract<Expr, …>` is the most common `as` shape in
 *    this compiler's own source — moving would refuse every one of them with NT1604,
 *    which is sound but rejects the pattern `Extract<T, U>` exists to serve. What is
 *    genuinely unsafe is letting the second handle ESCAPE, and that is still caught,
 *    because an alias is a borrow binding.
 *
 * 2. SILENT WRONG ANSWERS. A discriminated union `U<…>` IS the member pointer, with
 *    the tag living in the value as the discriminant field (ast.ts, SH2). Retyping one
 *    member to another is therefore a pure pointer retype that reinterprets the SAME
 *    BYTES at a DIFFERENT member's field layout, and `tsc` ACCEPTS a union-to-member
 *    downcast, so nothing anywhere refused it. `{kind:"square",label:"hello"}` cast to
 *    the circle arm and read as `.r` returned `2.123016287e-314` — the `label` string
 *    POINTER, loaded as a `double` — where node says `undefined`.
 *
 * 3. RAW LLVM ERRORS. A general union `G<…>` and a nullable `?U…` are BOXES, not bare
 *    values, so an identity retype across that boundary emitted IR that does not
 *    verify. The user saw clang's `'%t0' defined with type 'ptr' but expected 'double'`
 *    — no `NT****` code, no location in their program, no hint.
 *
 * THE FIX, and why it is a check rather than a refusal: a lexer-accurate census counts
 * 217 `as` assertions in `src/` — 51 `as Ty`, 28 `as Expr`, 26 `as Stmt`, and seven
 * `as Extract<…>` among them — so a blanket refusal would break the compiler's own
 * source many times over. Instead `as` now CHECKS the assertion where a check is
 * possible: `nt_as_tag` tests a `U<…>`'s in-value discriminant, `nt_as_unbox` tests a
 * `G<…>` / nullable box and unwraps it, and both PANIC on a mismatch. Where the layouts
 * are provably identical — the widening direction, and every same-shape retype — no
 * check is emitted at all, so `as` stays free on the paths that use it as documentation.
 *
 * That panic is a DELIBERATE DIVERGENCE: node erases `as` and returns `undefined`.
 * It follows Stage 41 (out-of-range indexing) and `!` (nt_nonnull) exactly, and is
 * recorded in docs/divergences.md. The alternative is the silent wrong answer above.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/* ------------------------------------------------------------------ *
 * 1. MEMORY SAFETY — `as` names one allocation twice; it never creates a second owner.
 * ------------------------------------------------------------------ */
describe("`as` aliases its operand — it never creates a second owner", () => {
  test("an object aliased through `as` is dropped ONCE, not twice", async () => {
    // Before the fix this aborted (SIGTRAP from the allocator's double-free check)
    // and printed nothing at all, the buffered `1` dying with the process.
    await expectNode(`
const o = { a: 1, b: 2 };
const w = o as { a: number };
console.log(w.a);
`);
  });

  test("the IR emits exactly one free for the aliased object", () => {
    const ir = emitIR(`
const o = { a: 1, b: 2 };
const w = o as { a: number };
console.log(w.a);
`);
    const frees = ir.split("\n").filter((l) => l.includes("call void @nt_obj_free")).length;
    expect(frees).toBe(1);
  });

  test("`as` matches the move behaviour of a plain alias", async () => {
    await expectNode(`
const o = { a: 5 };
const w = o as { a: number };
console.log(w.a);
`);
  });

  test("widening a member to its union through `as` also frees once", async () => {
    await expectNode(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
const c = { kind: "circle", r: 5 };
const s = c as Shape;
console.log(s.kind);
`);
  });

  test("the ORIGINAL stays readable through the alias, exactly as under node", async () => {
    // `as` does not move, so `o` is still live here — which is also what node does,
    // `as` being erased there. A MOVE model would have to refuse this.
    await expectNode(`
const o = { a: 1 };
const w = o as { a: number };
console.log(o.a);
console.log(w.a);
`);
  });

  test("the alias may not ESCAPE — that is the part that is unsafe", () => {
    // Handing `w` out would leave `o` to free a pointer the caller still holds. The
    // alias is a borrow binding, so the existing NT1604 catches it for free.
    let err: unknown;
    try {
      emitIR(`
type T = { a: number };
function f(): T {
  const o = { a: 1 };
  const w = o as T;
  return w;
}
console.log(f().a);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT1604");
  });

  test("`as` on a borrowed PARAMETER is allowed — the src/ `Extract` shape", async () => {
    // The single most common `as` in this compiler's own source. A move model would
    // refuse this with NT1604; the alias model must not.
    await expectNode(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function area(s: Shape): number {
  const c = s as { kind: "circle"; r: number };
  return c.r * 2;
}
console.log(area({ kind: "circle", r: 4 }));
`);
  });
});

/* ------------------------------------------------------------------ *
 * 2. DISCRIMINATED UNION `U<…>` — the tag must be CHECKED, not assumed.
 * ------------------------------------------------------------------ */
describe("`as` onto a discriminated-union member checks the tag", () => {
  test("a CORRECT downcast still works and costs nothing extra", async () => {
    await expectNode(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function ok(s: Shape): number { const c = s as { kind: "circle"; r: number }; return c.r; }
console.log(ok({ kind: "circle", r: 7 }));
`);
  });

  test("a WRONG downcast panics instead of returning a pointer as a double", async () => {
    // node prints `undefined`; before the fix we printed `2.123016287e-314`, which is
    // the `label` string pointer reinterpreted as an IEEE-754 double.
    const ours = await compileAndRun(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function bad(s: Shape): number { const c = s as { kind: "circle"; r: number }; return c.r; }
console.log(bad({ kind: "square", label: "hello" }));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
    expect(ours.stdout).not.toContain("e-314");
  });

  test("a WRONG downcast panics even when the layouts MATCH exactly", async () => {
    // The nastiest shape: both arms are {tag, number}, so the bad read returns a
    // perfectly plausible `3` rather than anything that looks wrong.
    const ours = await compileAndRun(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; n: number };
function bad(s: Shape): number { const c = s as { kind: "circle"; r: number }; return c.r; }
console.log(bad({ kind: "square", n: 3 }));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
  });

  test("WIDENING a member to its union needs no check", async () => {
    await expectNode(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function widen(c: { kind: "circle"; r: number }): string { const s = c as Shape; return s.kind; }
console.log(widen({ kind: "circle", r: 1 }));
`);
  });

  test("the widening direction emits NO tag check", () => {
    const ir = emitIR(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function widen(c: { kind: "circle"; r: number }): string { const s = c as Shape; return s.kind; }
console.log(widen({ kind: "circle", r: 1 }));
`);
    expect(ir).not.toContain("call void @nt_as_tag");
  });

  test("the narrowing direction DOES emit a tag check", () => {
    const ir = emitIR(`
type Shape = { kind: "circle"; r: number } | { kind: "square"; label: string };
function narrow(s: Shape): number { const c = s as { kind: "circle"; r: number }; return c.r; }
console.log(narrow({ kind: "circle", r: 1 }));
`);
    expect(ir).toContain("call void @nt_as_tag");
  });
});

/* ------------------------------------------------------------------ *
 * 3. BOXED representations — `G<…>` and `?U…` must not emit invalid IR.
 * ------------------------------------------------------------------ */
describe("`as` across a box boundary emits valid IR", () => {
  test("a general union narrowed to the arm it holds", async () => {
    await expectNode(`
function ok(v: number | string): number { return (v as number) + 1; }
console.log(ok(41));
`);
  });

  test("a general union narrowed to an arm it does NOT hold panics", async () => {
    const ours = await compileAndRun(`
function bad(v: number | string): number { return (v as number) + 1; }
console.log(bad("hi"));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
  });

  test("an arm widened to its general union boxes rather than mis-typing", async () => {
    await expectNode(`
const n = 5;
const u = n as number | string;
console.log(typeof u);
`);
  });

  test("a nullable narrowed to its base, when present", async () => {
    await expectNode(`
function f(x: number | undefined): number { return x as number; }
console.log(f(9));
`);
  });

  test("a nullable narrowed to its base, when ABSENT, panics like `!`", async () => {
    const ours = await compileAndRun(`
function f(x: number | undefined): number { return x as number; }
console.log(f(undefined));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
  });

  test("no `as` form leaks a raw clang type error to the user", async () => {
    for (const src of [
      `function f(v: number | string): number { return (v as number) + 1; }\nconsole.log(f(1));`,
      `const n = 5;\nconst u = n as number | string;\nconsole.log(typeof u);`,
      `function g(x: number | undefined): number { return x as number; }\nconsole.log(g(2));`,
    ]) {
      const ours = await compileAndRun(src);
      expect(ours.stderr).not.toContain("but expected");
      expect(ours.stderr).not.toContain("clang failed");
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3b. The direction the three guards above all miss: a SCALAR asserted to a
 *     REFERENCE type, or back.
 *
 * The union/box guards are keyed on the OPERAND being a `U<…>`, a `G<…>` or a nullable,
 * and the wider-object guard on both sides being object types. A plain `number` asserted
 * to a `string` matches none of them, so `AsExpr` fell through to the unchecked identity
 * retype it was before any of this existed: `e.ty` is returned and codegen emits the
 * operand's `double` straight into a slot the asserted type says is a `ptr`. That is
 * failure mode 3 of this file's header, verbatim and still live —
 *
 *     const n = 12345; console.log((n as string).length);
 *     // node: `undefined`, exit 0
 *     // ours: clang failed — "'%t0' defined with type 'double' but expected 'ptr'"
 *
 * — and the test above ("no `as` form leaks a raw clang type error") did not catch it
 * because all three of its cases are union/nullable shapes.
 *
 * It is reachable from source `tsc` accepts, which is what makes it more than a lint on a
 * mistake `tsc` would already flag: `unknown` is one of the three names still allowed to
 * erase in an ANNOTATION (`ERASURE_STILL_ALLOWED`, src/parser.ts), so a parameter written
 * `e: unknown` IS a `number` here, and `e as string` inside the body is an assertion
 * TypeScript permits from `unknown` to anything. test/type-erasure.test.ts's header claims
 * the residue "is refused in an ASSERTION regardless, which is the only position where the
 * erasure was ever a wrong answer rather than a confusing refusal" — the assertion there
 * names no ambient type at all, so nothing refuses it.
 *
 * No runtime check can rescue this one either: there is no tag, and a double and a pointer
 * are not the same width of the same thing. So it is refused, like the wider-object case.
 * ------------------------------------------------------------------ */
describe("`as` across the scalar/reference boundary is refused", () => {
  test("a number asserted to a string is NT2001, not a clang error", () => {
    let err: unknown;
    try {
      emitIR(`
const n = 12345;
console.log((n as string).length);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
    expect(String(err)).toContain("string");
  });

  test("…and the erased-`unknown` parameter that reaches it from tsc-clean source", () => {
    let err: unknown;
    try {
      emitIR(`
function asStr(e: unknown): string { return e as string; }
console.log(asStr(42));
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
  });

  test("the reference direction is refused too", () => {
    let err: unknown;
    try {
      emitIR(`
const s = "hello";
console.log((s as number) + 1);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
  });

  test("no scalar/reference `as` leaks a raw clang type error", async () => {
    // `compileAndRun` THROWS on a build failure rather than returning it, so the check has
    // to cover the thrown text as well — the raw clang error arrives that way, not on the
    // program's stderr.
    for (const src of [
      `const n = 12345;\nconsole.log((n as string).length);`,
      `function asStr(e: unknown): string { return e as string; }\nconsole.log(asStr(42));`,
      `function m(e: unknown): string { return (e as Error).message; }\nconsole.log(m(42));`,
    ]) {
      let seen = "";
      try {
        const ours = await compileAndRun(src);
        seen = ours.stderr;
      } catch (e) { seen = String(e); }
      expect(seen).not.toContain("but expected");
      expect(seen).not.toContain("clang failed");
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. The one shape NO runtime check can rescue — asserting to a WIDER object.
 * ------------------------------------------------------------------ */
describe("`as` to a wider plain object is refused, not read out of bounds", () => {
  test("a field the operand does not have is `NT2001`, not an OOB read", () => {
    // A missing field is not merely untagged, it is not THERE: the read runs off the
    // end of the allocation. node answers `undefined`; we printed `(null)`, at exit 0.
    let err: unknown;
    try {
      emitIR(`
const o = { a: 1 };
const w = o as { a: number; b: string };
console.log(w.b);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
    expect(String(err)).toContain("not present in the operand");
  });

  test("narrowing to a PREFIX of the operand's fields is still allowed", async () => {
    // This one reads a real slot at the right type, and is exactly node's answer.
    await expectNode(`
const o = { a: 1, b: 2 };
const w = o as { a: number };
console.log(w.a);
`);
  });

  test("a field at a DIFFERENT slot is refused too", () => {
    let err: unknown;
    try {
      emitIR(`
const o = { a: 1, b: "x" };
const w = o as { b: string; a: number };
console.log(w.b);
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
  });
});

/* ------------------------------------------------------------------ *
 * 4b. A union asserted to a NON-MEMBER object — the duck-typing shape.
 *
 * `(e as {name: string}).name` on a union. Codegen can only tag-check an assertion that
 * names a MEMBER; a structural target has no tag to compare, so this fell through to a
 * bare retype and read whatever sat at the target's slot indices — a SECOND silent wrong
 * answer, left open by the first version of this lane's own fix and found by testing the
 * fallthrough rather than the reported case.
 *
 * It matters out of proportion to how exotic it looks: it is `src/`'s own idiom, masked
 * there today only because `Ty`/`Expr`/`Stmt` are unseeded imports that erase to
 * `number`. It becomes reachable exactly when `Extract<T, U>` and import seeding land —
 * i.e. the lane this one is a prerequisite for. (Thanks to lane-externalnames, whose note
 * about those 144 assertion-position sites resolving to `number` prompted the check.)
 * ------------------------------------------------------------------ */
describe("`as` from a union to a NON-MEMBER object", () => {
  test("a field at a DIFFERENT slot than the members put it is refused", () => {
    // Returned `2.12e-314` — the `kind` pointer as a double — where node returns `7`.
    let err: unknown;
    try {
      emitIR(`
type Node = { kind: "a"; x: number } | { kind: "b"; y: string };
function xOf(e: Node): number { const n = e as { x: number }; return n.x; }
console.log(xOf({ kind: "a", x: 7 }));
`);
    } catch (e) { err = e; }
    expect(String(err)).toContain("NT2001");
    expect(String(err)).toContain("no member of the union can be read through that shape");
  });

  test("a structural WINDOW onto SOME members is tag-checked, not refused", async () => {
    // `src/`'s own idiom — `retainedReceiver` casts an `Expr` to `{callee: …}`, guarded
    // by a predicate the checker cannot see through. Refusing it outright was the first
    // thing this lane tried, and it cost a blocker in src/ for no safety gain: the shape
    // is a readable window onto the members that DO have that field, so the tag is
    // checkable. Here the value IS such a member, so it must simply work.
    await expectNode(`
type Node = { kind: "call"; callee: string; n: number } | { kind: "lit"; value: number };
function calleeOf(e: Node): string { const c = e as { kind: string; callee: string }; return c.callee; }
console.log(calleeOf({ kind: "call", callee: "f", n: 1 }));
`);
  });

  test("…and that window PANICS when the value is a member it does not fit", async () => {
    const ours = await compileAndRun(`
type Node = { kind: "call"; callee: string; n: number } | { kind: "lit"; value: number };
function calleeOf(e: Node): string { const c = e as { kind: string; callee: string }; return c.callee; }
console.log(calleeOf({ kind: "lit", value: 9 }));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
  });

  test("a field at ONE agreeing slot in EVERY member is allowed, and free", async () => {
    // `kind` is index 0 with type string in both members, so the read is sound.
    await expectNode(`
type Node = { kind: "a"; x: number } | { kind: "b"; y: string };
function kindOf(e: Node): string { const n = e as { kind: string }; return n.kind; }
console.log(kindOf({ kind: "b", y: "hi" }));
`);
  });

  test("the agreeing-slot cast emits NO tag check", () => {
    const ir = emitIR(`
type Node = { kind: "a"; x: number } | { kind: "b"; y: string };
function kindOf(e: Node): string { const n = e as { kind: string }; return n.kind; }
console.log(kindOf({ kind: "b", y: "hi" }));
`);
    expect(ir).not.toContain("call void @nt_as_tag");
  });

  test("a target that IS a widened member is still tag-checked, not refused", async () => {
    const ours = await compileAndRun(`
type Node = { kind: "id"; name: string } | { kind: "num"; value: number };
function nameOf(e: Node): string { const n = e as { kind: string; name: string }; return n.name; }
console.log(nameOf({ kind: "num", value: 42 }));
`);
    expect(ours.stdout).toBe("");
    expect(ours.stderr).toContain("type assertion failed");
  });
});

/* ------------------------------------------------------------------ *
 * 5. The forms that were already fine must stay free of any new cost.
 * ------------------------------------------------------------------ */
describe("`as` on identical layouts stays a no-op", () => {
  test("a primitive retype", async () => {
    await expectNode(`
const n = 42 as number;
console.log(n + 1);
`);
  });

  test("an array retype", async () => {
    await expectNode(`
const a = [1, 2, 3] as number[];
console.log(a[1]);
`);
  });

  test("a same-shape object retype emits no check", () => {
    const ir = emitIR(`
const o = { a: 1 };
const w = o as { a: number };
console.log(w.a);
`);
    expect(ir).not.toContain("call void @nt_as_tag");
    expect(ir).not.toContain("call i64 @nt_nonnull");
  });
});
