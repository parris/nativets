# Divergences & unsupported features

`node` is our oracle. Two kinds of "we differ from node" exist, tracked separately.

## A. Semantic divergences (we compile it, but differ deliberately)

These are consequences of the **static-typing** design. Small in number; pinned by the
conformance corpus allow-lists.

### 1. Value-returning `&&` / `||` with mixed operand types
JS returns an *operand* (possibly a different type): `true && 0 → 0`, `false || "hi" → "hi"`.
We require **boolean operands** and return `boolean`; mixed-type logical expressions are a
type error. Boolean logic (`a > b && c`, `!flag`) matches node exactly.
Corpus: `logical-and-shortcircuit`, `logical-or-shortcircuit`.

### 2. `String#length` / string ops are UTF-8 byte-oriented
We store strings as NUL-terminated UTF-8 and measure/slice by byte. Identical to JS for
ASCII (all fixtures); differs for non-ASCII (an emoji is 4 bytes here, 2 UTF-16 units in JS).

> `typeof undefined` (a former divergence) is now **supported** and matches node.

## B. Unimplemented features (we refuse to compile — never miscompile)

Everything else we don't support is **rejected with an `NT1xxx` diagnostic**, not silently
miscompiled. Run `nativets coverage <file>` to see exactly what blocks a program, grouped by
code, milestone, and frequency. The catalog lives in `src/diagnostics.ts` (`NYI`):

| Code | Feature | Milestone | Needs |
|------|---------|-----------|-------|
| NT1001 | arrays: empty `[]`, nested/object element types, `console.log(arr)` | M1 | (basic `number[]`/`string[]` are ✅ supported) |
| NT1002 | objects: nested object fields, object methods | M1 | (flat objects, `.f`/`o["f"]`, `Object.keys`, `for-in` are ✅ supported) |
| NT1003 | arrow functions / function values / closures | M2 | captured environments |
| NT1004 | `try`/`catch`/`throw` | M2 | unwinding |
| NT1005 | `JSON` | M3 | objects + reflection |
| NT1006 | spread | M2 | arrays/objects |
| NT1007 | destructuring | M2 | arrays/objects |
| NT1008 | rest parameters | M2 | arrays |
| NT1009 | optional chaining `?.` / nullish `??` | M2 | nullable union types |
| NT1010 | `for-in` | M1 | objects |
| NT1011 | `for-of` over non-strings | M1 | arrays/iterables |

The single biggest unlock is **M1 (a heap value model → arrays + objects)**, which in turn
unblocks much of M2. That is the next architectural push.

When a feature ships: delete its row here, move its corpus case out of `KNOWN_UNSUPPORTED`
in the relevant `test/*conformance*`/`test/gap.test.ts` allow-list, and drop the `NYI` entry.
