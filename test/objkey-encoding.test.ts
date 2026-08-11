/**
 * An object KEY must survive the type encoding, or the program is refused.
 *
 * A `Ty` here is a flat string and an object's LAYOUT is that string: `{k1:t1,k2:t2}`,
 * split back into slots by `objectFields` (src/ast.ts) with `splitTopLevel(inner, ",")`
 * and then `part.indexOf(":")`. That split tracks `()`/`[]`/`{}` depth and `<>` angles and
 * knows nothing about quoting — so a key carrying one of those characters does not merely
 * look odd, it CHANGES WHERE THE SLOT BOUNDARIES ARE.
 *
 * Measured on the pre-fix compiler (node v24 as the oracle), by scanning every printable
 * ASCII character through `{ "a<C>b": 1, z: 2 }`:
 *
 *   for (const k in { "a,b": 1, z: 2 })   node → "a,b","z"    ours → "","b","z"
 *   for (const k in { "a:b": 1, z: 2 })   node → "a:b","z"    ours → "a","z"
 *   for (const k in { "a<b": 1, z: 2 })   node → "a<b","z"    ours → "a<b"        ← z GONE
 *   …the same for `(`, `)`, `[`, `]`, `{`, `}`
 *
 * All nine at EXIT 0 with no diagnostic — a lost or renamed field, which is the silent
 * wrong answer CLAUDE.md ranks worst. `JSON.stringify` happened to trip over the garbage
 * type afterwards and reported an NT1005 naming a type called `a`, so the literal path
 * looked "refused" until it was probed through `for-in`.
 *
 * `Object.fromEntries` is the same defect with no accident to save it: it joins
 * `${key}:${vt}` with `key` an arbitrary string literal, and
 * `Object.fromEntries([["a:number,b", "x"]])` EXITED 255 WITH ZERO BYTES OF OUTPUT — the
 * forged type `{a:number,b:string}` type-checked as a two-field record and codegen built
 * a one-slot object for it.
 *
 * The predicate is a ROUND TRIP, not a character blacklist, and that distinction is the
 * point: it accepts exactly the keys that provably survive. `a>b`, `a<x>b`, `a|b`, `a"b`,
 * `a\b` and `""` all encode faithfully and all still compile — a blacklist wide enough to
 * be safe would have rejected every one of them.
 *
 * Cases are derived from that ASCII scan against node; no conformance suite was consulted.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** The diagnostic a source is rejected with, or null if it compiles. */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** The nine characters the ASCII scan proved corrupt the encoding, as source spellings. */
const CORRUPTING = [",", ":", "(", ")", "<", "[", "]", "{", "}"];

/** Characters that look structural but demonstrably round-trip — these must KEEP working. */
const SURVIVING = [">", "|", "&", "=", "?", "@", "$", ".", "-", "+", " ", "'", "*", "%", "\\\\"];

describe("a key that cannot survive the type encoding is REFUSED, not miscompiled", () => {
  for (const c of CORRUPTING) {
    test(`an object-literal key containing ${JSON.stringify(c)} is refused`, () => {
      const r = rejectionOf(`const o = { "a${c}b": 1, z: 2 };\nlet s = "";\nfor (const k in o) s += k;\nconsole.log(s);\n`);
      expect(r).not.toBeNull();
      expect(r?.code).toBe("NT1040");
    });

    test(`an Object.fromEntries key containing ${JSON.stringify(c)} is refused`, () => {
      const r = rejectionOf(`const o = Object.fromEntries([["a${c}b", 1], ["z", 2]]);\nconsole.log(o.z);\n`);
      expect(r).not.toBeNull();
      expect(r?.code).toBe("NT1040");
    });
  }

  /**
   * `#` and `"` are the two characters a round trip alone cannot judge, because they are
   * read against the WHOLE type string by substring rather than by position — so whether
   * one is safe depends on the key's NEIGHBOURS.
   *
   *   const q = { 'a"b': 1, 'c"d': 2, z: 3 };
   *   for (const k in q) …    node → a"b, c"d, z    was → astringd, z
   *
   * `widenLiteralTys` paired the two quotes and replaced everything between them with
   * `string`, FUSING TWO KEYS INTO ONE at exit 0. A single quoted key alone round-trips
   * (nothing closes it), which is exactly why the probe cannot decide this one.
   */
  test("a key containing a quote is refused, even though ONE of them round-trips", () => {
    const r = rejectionOf(`const q = { 'a"b': 1, 'c"d': 2, z: 3 };\nconsole.log(q.z);\n`);
    expect(r?.code).toBe("NT1040");
  });

  test("a single quoted key is refused too — its neighbour decides, so it cannot be allowed", () => {
    const r = rejectionOf(`const q = { 'a"b': 1, z: 2 };\nconsole.log(q.z);\n`);
    expect(r?.code).toBe("NT1040");
  });

  test("a key containing `#` is refused AS A KEY, not as a stray generic", () => {
    // It was already rejected, but as `NT1013: unresolved generic type parameter
    // '{a#b:number,z:number}' survived monomorphization` — a message about a feature the
    // program never used, naming the mangled type instead of the key.
    const r = rejectionOf(`const o = { "a#b": 1, z: 2 };\nconsole.log(o.z);\n`);
    expect(r?.code).toBe("NT1040");
    expect(r?.message).toContain("a#b");
  });

  test("`@` is NOT refused — it is a bare `includes` too, but its consumers walk by position", async () => {
    // Checked rather than assumed, in the adversarial spelling: the key's `@` is followed
    // by the name of a recursive type that really is in the table.
    const src = `type N = { v: number; next: N | undefined };\nconst list: N = { v: 1, next: undefined };\nconst o = { "x@N": 1, z: 2 };\nlet s = "";\nfor (const k in o) s += k + "~";\nconsole.log(s, o.z, list.v);\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the refusal names the offending key and its source position", () => {
    const r = rejectionOf(`const a = 1;\nconst o = { "x,y": 2 };\nconsole.log(a, o["x,y"]);\n`);
    expect(r?.code).toBe("NT1040");
    expect(r?.message).toContain("x,y");
    expect(r?.message).toContain("2:13");
  });

  test("the hint says what to do about it", () => {
    const r = rejectionOf(`const o = { "x,y": 2 };\nconsole.log(o["x,y"]);\n`);
    expect(r?.hint).toBeDefined();
    // The workaround is a Map, whose keys are runtime strings with no encoding at all.
    expect(r?.hint).toContain("Map");
  });

  /**
   * The hint makes two concrete claims. Both are COMPILED here rather than trusted,
   * because a hint that names a workaround which does not build is worse than no hint —
   * it costs the reader the round trip to find that out. (An earlier draft of this very
   * hint listed `"` among the characters that "all compile", one edit after `"` had been
   * added to the refused set.)
   */
  test("the hint's Map workaround compiles and matches node", async () => {
    // Chained, exactly as the hint spells it: a Map here is persistent, so the statement
    // form `m.set(…)` the hint used to recommend is itself an NT1606. That is precisely
    // the failure this test exists to catch, and it caught it.
    const src = `const m = new Map<string, number>().set("a,b", 1).set("a:number,b", 2).set('q"r', 3);\nconsole.log(m.get("a,b"), m.get("a:number,b"), m.get('q"r'), m.size);\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("every character the hint calls legal really is legal", async () => {
    // Read straight off the hint text, so the two cannot drift apart silently.
    const r = rejectionOf(`const o = { "x,y": 2 };\nconsole.log(o["x,y"]);\n`);
    const hint = r?.hint ?? "";
    const claimed = [">", "|", "@", "&", "=", "?", "$", ".", "-", "+", " "];
    for (const c of claimed) expect(hint).toContain(`\`${c}\``);
    const src = `const o = { ${claimed.map((c, i) => `"a${c}b": ${i}`).join(", ")}, "c\\\\d": 98, "e<f>g": 99 };\nconsole.log(JSON.stringify(o));\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("`Object.fromEntries([['a:number,b','x']])` no longer exits 255 with no output", async () => {
    // The single worst case found: it type-checked as a TWO-field record built from a
    // ONE-entry list, so codegen wrote past the object it had allocated.
    const r = rejectionOf(`const o = Object.fromEntries([["a:number,b", "x"]]);\nconsole.log(JSON.stringify(o));\n`);
    expect(r?.code).toBe("NT1040");
  });
});

describe("keys that DO survive the encoding still compile, and match node", () => {
  for (const c of SURVIVING) {
    test(`a key containing ${JSON.stringify(c)} compiles and agrees with node`, async () => {
      const src = `const o = { "a${c}b": 1, z: 2 };\nlet s = "";\nfor (const k in o) s += k + "~";\nconsole.log(s, o["a${c}b"], o.z, JSON.stringify(o));\n`;
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  test("the empty key is a key", async () => {
    const src = `const o = { "": 1, z: 2 };\nlet s = "";\nfor (const k in o) s += k + "~";\nconsole.log(s, o[""], JSON.stringify(o));\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a balanced `<…>` in a key round-trips, so it is NOT rejected with the bare `<`", async () => {
    // `splitTopLevel`'s angle counter comes back to zero, so the field boundary is intact.
    // A character blacklist would have failed this while a round trip passes it.
    const src = `const o = { "a<x>b": 1, z: 2 };\nlet s = "";\nfor (const k in o) s += k + "~";\nconsole.log(s, o.z);\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a backslash in a key round-trips, and JSON.stringify ESCAPES it", async () => {
    // The key is a compile-time constant interned straight into the output, so it took
    // none of the `js_json_quote` escaping the VALUE side has always had: node writes
    // `{"c\\d":1}` and we wrote `{"c\d":1}`, which is not JSON and does not survive its
    // own `JSON.parse`. Silent, exit 0.
    const src = `const o = { "c\\\\d": 1, "t\\tab": 2, z: 3 };\nconsole.log(JSON.stringify(o));\nconsole.log(JSON.stringify(o).length);\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("an optional field's key is escaped on the runtime-omission path too", async () => {
    // A `T | undefined` field makes the separators a RUNTIME decision, which is a second,
    // separate emission site for the key — it had the same unescaped interning.
    const src = `const flag = process.argv.length > 99;\nconst o = { "c\\\\d": 1, q: flag ? 2 : undefined };\nconsole.log(JSON.stringify(o));\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the pretty-printed (indented) form escapes the key as well", async () => {
    const src = `const o = { "c\\\\d": 1, z: 2 };\nconsole.log(JSON.stringify(o, null, 2));\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("Object.fromEntries keeps working for ordinary keys", async () => {
    const src = `const o = Object.fromEntries([["b", "x"], ["10", "y"], ["2", "z"], ["a", "w"]]);\nconsole.log(JSON.stringify(Object.keys(o)));\nconsole.log(JSON.stringify(o));\n`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
