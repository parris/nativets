/*
 * Node-differential findings from the fuzz lane (`test/fzq-fuzz.ts`).
 *
 * Every case here is a SILENT WRONG ANSWER found by differential sweeping: nativets compiles
 * it, runs it to exit 0, and prints a value node does not print. None is in
 * `docs/divergences.md`, so by the prime directive each is a defect, not a decision.
 *
 * The comparison is on RAW BYTES and the EXIT CODE, never on decoded text — a decoding
 * compare turns a memory-disclosure bug into U+FFFD on both sides and reports a match.
 *
 * These tests are expected to FAIL until the defects are fixed; each `it` names the owning
 * area so a fixing lane can claim one. They are marked `.failing` so the suite stays green
 * while the findings stay pinned — flipping one to a plain `it` is how a fix is proven.
 */
import { describe, it, expect } from "bun:test";

import { ourRun, nodeRun, isRefusal, isUtf8 } from "./fzq-fuzz.ts";

/** Run both sides and assert byte-for-byte stdout equality plus equal exit codes. */
async function expectSameBytes(source: string): Promise<void> {
  const oracle = nodeRun(source);
  const ours = await ourRun(source);
  if (isRefusal(ours)) throw new Error(`nativets refused:\n${ours.refused}`);
  // A non-UTF-8 stdout is itself the signature of a heap disclosure; surface it explicitly
  // rather than letting it hide inside a string diff.
  expect({ utf8: isUtf8(ours.stdout) }).toEqual({ utf8: isUtf8(oracle.stdout) });
  expect(ours.stdout.toString("latin1")).toBe(oracle.stdout.toString("latin1"));
  expect(Buffer.compare(ours.stdout, oracle.stdout)).toBe(0);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("fuzz findings — arithmetic", () => {
  /*
   * `**` lowers to C `pow`, and C and ECMAScript disagree on exactly three inputs.
   * C99 F.10.4.4 defines pow(1, anything) = 1 and pow(±1, ±inf) = 1; ECMAScript
   * Number::exponentiate says the result is NaN when the exponent is NaN, and NaN when
   * the base's magnitude is 1 and the exponent is ±Infinity. Five of eight wrong, exit 0.
   */
  it("`**` follows ECMAScript, not C pow, for NaN / ±Infinity exponents", async () => {
    await expectSameBytes([
      "console.log(1 ** NaN);",          // node NaN, ours 1
      "console.log(1 ** Infinity);",     // node NaN, ours 1
      "console.log(1 ** -Infinity);",    // node NaN, ours 1
      "console.log((-1) ** Infinity);",  // node NaN, ours 1
      "console.log((-1) ** -Infinity);", // node NaN, ours 1
      "console.log((-1) ** NaN);",       // node NaN, ours NaN — C agrees here
      "console.log(2 ** NaN);",          // node NaN, ours NaN — C agrees here
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — Array#includes", () => {
  /*
   * `Array#includes` is specified on SameValueZero, which differs from `===` at exactly one
   * pair of values: NaN equals NaN. `indexOf` (strict equality) is correct here, and so are
   * `Set#has` / `Map#has` / `Map#get`, which handle both NaN and -0 the node way — so this
   * is one method, not a model-wide gap.
   */
  /* FIXED — `nt_arr_includes_num` now picks its predicate on `isnan(needle)`; the full
   * behavior (±0, past the 32-element vector threshold, the untouched siblings) is
   * covered in test/array-includes.test.ts. */
  it("`[NaN].includes(NaN)` is true (SameValueZero), not false", async () => {
    await expectSameBytes([
      "const a = [NaN, 1];",
      "console.log(a.includes(NaN));",   // node true, ours true
      "console.log(a.indexOf(NaN));",    // node -1, ours -1 — correct
      "console.log([1, 2].includes(NaN));",
      "const s = new Set<number>([NaN, 1]);",
      "console.log(s.has(NaN), s.size);", // node true 2, ours true 2 — correct
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — string → number conversions", () => {
  /*
   * `parseInt` accepts a SECOND sign character and then ignores it. ECMAScript's
   * ParseInt reads at most one `+`/`-`; anything else makes the numeric prefix empty and
   * the result NaN. Ours returns a number — and for `"+-1"` the sign it returns is the
   * one from the SECOND character, so the answer is not merely wrong, it is inverted.
   */
  it.failing("parseInt rejects a second sign character", async () => {
    await expectSameBytes([
      'console.log(parseInt("--1"));', // node NaN, ours 1
      'console.log(parseInt("-+1"));', // node NaN, ours -1
      'console.log(parseInt("+-1"));', // node NaN, ours -1
      'console.log(parseInt("++1"));', // node NaN, ours 1
      "",
    ].join("\n"));
  });

  /*
   * `parseFloat` is defined on StrDecimalLiteral, which has no hex/binary/octal form — node
   * reads `"0x1f"` as the decimal `0` and stops at the `x`. Ours runs the `Number()` scanner
   * and returns 31.
   */
  it.failing("parseFloat does not accept a hex prefix", async () => {
    await expectSameBytes([
      'console.log(parseFloat("0x1f"));',     // node 0, ours 31
      'console.log(parseFloat("0x10"));',     // node 0, ours 16
      'console.log(parseFloat("  0x10  "));', // node 0, ours 16
      "",
    ].join("\n"));
  });

  /*
   * The mirror image: `Number(string)` IS defined on StrNumericLiteral, which since ES2015
   * includes the `0b`/`0o` prefixes. Ours knows `0x` and not the other two.
   */
  it.failing("Number() accepts the 0b / 0o prefixes", async () => {
    await expectSameBytes([
      'console.log(Number("0b101"));',  // node 5,  ours NaN
      'console.log(Number("0o17"));',   // node 15, ours NaN
      'console.log(Number("0B11"));',   // node 3,  ours NaN
      'console.log(Number("0O7"));',    // node 7,  ours NaN
      'console.log(Number("0x1f"));',   // node 31, ours 31 — correct
      "",
    ].join("\n"));
  });

  /*
   * `Infinity` in a numeric string is case-SENSITIVE: StrNumericLiteral spells it exactly
   * `Infinity`. Ours matches case-insensitively, so a string that node reads as NaN becomes
   * a finite-looking Infinity here — the direction that keeps a bad program running.
   */
  it.failing("Number()/parseFloat() only accept the exact spelling `Infinity`", async () => {
    await expectSameBytes([
      'console.log(Number("infinity"));',      // node NaN, ours Infinity
      'console.log(Number("INFINITY"));',      // node NaN, ours Infinity
      'console.log(parseFloat("infinity"));',  // node NaN, ours Infinity
      'console.log(Number("Infinity"));',      // node Infinity, ours Infinity — correct
      "",
    ].join("\n"));
  });

  /*
   * StrWhiteSpace includes VERTICAL TAB (U+000B), and an all-whitespace string converts to 0.
   * Only the WHITESPACE-ONLY case is wrong here: `Number("\v1")` is 1 on both sides (the
   * numeric scan reaches the digit through C's `isspace`, which does know \v), so the miss is
   * specifically in whatever decides "this string is blank, therefore 0". Pure ASCII, so it
   * is independent of the UTF-8 byte-orientation divergence (§A.2).
   */
  it.failing("Number() treats a whitespace-only vertical tab as 0", async () => {
    await expectSameBytes([
      'console.log(Number("\\u000b"));',    // node 0, ours NaN
      'console.log(Number("\\u000b\\u000b"));', // node 0, ours NaN
      'console.log(Number("\\u000b1"));',   // node 1, ours 1 — correct
      'console.log(Number(" \\t\\n\\r"));', // node 0, ours 0 — correct
      "",
    ].join("\n"));
  });

  /*
   * `parseInt("-0")` is -0, not 0. Invisible through `String()` (both "0") but visible
   * through console.log, which is util.inspect's formatNumber and prints `-0`.
   */
  it.failing("parseInt preserves the sign of a negative zero", async () => {
    await expectSameBytes([
      'console.log(parseInt("-0"));',      // node -0, ours 0
      'console.log(parseInt("-0", 16));',  // node -0, ours 0
      'console.log(parseInt("-0.9"));',    // node -0, ours 0
      "",
    ].join("\n"));
  });

  /*
   * A radix parse accumulates in a 64-bit integer and SATURATES at INT64_MAX. ECMAScript
   * accumulates mathematically and rounds to the nearest double at the end, so any input
   * whose value exceeds 2^63 comes back as the same wrong constant here.
   */
  it.failing("parseInt with a radix does not saturate at INT64_MAX", async () => {
    await expectSameBytes([
      'console.log(parseInt("9007199254740993", 16));', // node 10378291982571407000, ours 9223372036854776000
      'console.log(parseInt("9007199254740993", 36));', // node 1.9896986116031812e+24, ours the same constant
      'console.log(parseInt("ffffffffffffffffff", 16));',
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — the lexer's escape table", () => {
  /*
   * `\b` (U+0008), `\f` (U+000C) and `\v` (U+000B) are SingleEscapeCharacters in
   * ECMAScript, and `escapeChar` in `src/lexer.ts` does not list them. They therefore reach
   * its `default: return e` — the correct rule for an UNKNOWN escape (`\q` is `q`) applied to
   * three escapes that are not unknown — so `"\b"` is the letter `b`.
   *
   * This is the worst kind of quiet: the wrong string is the same LENGTH as the right one
   * (one character either way), so a `.length` assertion cannot see it, and it is well-formed
   * ASCII, so nothing downstream complains. Both string and template literals are affected —
   * one decoder serves both, which is why the miss is symmetric.
   *
   * Everything else in the escape space is correct, checked in the same sweep:
   * `\n \t \r \\ \' \" \` \0`, `\xNN`, `\uNNNN`, `\u{NNNNN}`, an unknown escape, and the
   * octal refusal (NT0001).
   */
  it("`\\b`, `\\f` and `\\v` decode to U+0008 / U+000C / U+000B", async () => {
    await expectSameBytes([
      'console.log("\\b".charCodeAt(0));',  // node 8,  ours 98  ("b")
      'console.log("\\f".charCodeAt(0));',  // node 12, ours 102 ("f")
      'console.log("\\v".charCodeAt(0));',  // node 11, ours 118 ("v")
      'console.log(JSON.stringify("\\b"));', // node "\b", ours "b"
      'console.log(`x\\by`.charCodeAt(1));', // node 8, ours 98 — templates too
      'console.log("\\n".charCodeAt(0));',  // node 10, ours 10 — correct
      'console.log("\\q".charCodeAt(0));',  // node 113, ours 113 — correct (unknown escape)
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — object literals", () => {
  /*
   * In node `__proto__:` in an object LITERAL is the prototype setter (B.3.1
   * `__proto__` Property Names in Object Initializers), not a data property: the key never
   * appears in `Object.keys`, `JSON.stringify` or `Object.values`. Here it was an ordinary
   * key — a silent wrong answer at exit 0.
   *
   * It is NOT fixable. The setter's whole job is to install a PROTOTYPE, and nativets has no
   * prototype chain: an object is a flat record with a fixed slot layout decided at compile
   * time from its static type. The three shapes the setter takes all need the chain:
   *   `{ __proto__: obj }`  — `o.b` must resolve on `obj`;
   *   `{ __proto__: null }` — the object LOSES `Object.prototype`, so `"toString" in o` turns
   *                           false, and our `in` answers that from a compile-time key list;
   *   `{ __proto__: 1 }`    — a primitive is a no-op, so this one *is* expressible (drop the
   *                           key) but it is an obfuscated `{}`; special-casing it would buy
   *                           nothing and put a discarded, unowned value in the literal path.
   * So the whole construct is refused (NT1038) rather than compiled three ways. This is the
   * documented refusal in docs/divergences.md; the two tests below are its contract.
   */
  it("`__proto__` as a literal object-literal key is refused, not miscompiled", async () => {
    // Every non-shorthand spelling of the key, including the ones we could have limped
    // through: identifier, string, self-named value, object value, null value.
    for (const stmt of [
      'console.log(JSON.stringify({ "__proto__": 1 }));',
      "console.log(JSON.stringify({ __proto__: 1 }));",
      'console.log(Object.keys({ "__proto__": 1, other: 2 }).join("|"));',
      "console.log(JSON.stringify({ __proto__: { b: 2 }, a: 1 }));",
      "console.log(JSON.stringify({ __proto__: null, a: 1 }));",
      "const __proto__ = 7;\nconsole.log(JSON.stringify({ __proto__: __proto__ }));",
    ]) {
      const r = await ourRun(`${stmt}\n`);
      if (!isRefusal(r)) throw new Error(`compiled instead of refusing:\n${stmt}`);
      expect({ stmt, nt1038: r.refused.includes("NT1038") }).toEqual({ stmt, nt1038: true });
    }
  });

  /*
   * The hint's advice, compiled against node. NT1038 says the SHORTHAND `{ __proto__ }` is an
   * ordinary property — B.3.1 only rewrites `PropertyName : AssignmentExpression`, so
   * `IdentifierReference` shorthand is untouched, and node really does keep the key. If that
   * claim were wrong the diagnostic would be sending people at a second wrong answer.
   */
  it("the NT1038 hint is true: shorthand `{ __proto__ }` IS an ordinary property", async () => {
    await expectSameBytes([
      "const __proto__ = 7;",
      "console.log(JSON.stringify({ __proto__ }));",          // node {"__proto__":7}
      'console.log(Object.keys({ __proto__, other: 2 }).join("|"));', // node __proto__|other
      "",
    ].join("\n"));
  });

  /*
   * A NUMERIC key is taken as its RAW SOURCE TEXT. `expectKey` (src/parser.ts) returns the
   * number token's spelling straight through, but a `PropertyName` that is a `NumericLiteral`
   * is `ToString(ToNumber(literal))` — the key is the number's canonical form, not the digits
   * that were typed. So node's `{ 1e3: "x" }` has the key `1000` and ours has `1e3`.
   *
   * Found while refusing `__proto__` above: the same one-line `expectKey` feeds both, and this
   * is the same failure shape — a key that is a plausible string, so `JSON.stringify` and
   * `Object.keys` both print something well-formed and exit 0.
   *
   * The canonical spellings are already right (`{1: …}`, `{0.5: …}`), which is exactly why
   * this hid: only a NON-canonical literal witnesses it, and the fix is `ToString(ToNumber(…))`
   * on the token — the `numToStr` that `test/numtostr.test.ts` already pins, reused here.
   */
  it.failing("a numeric object-literal key is ToString(ToNumber(…)), not its source text", async () => {
    await expectSameBytes([
      'console.log(Object.keys({ 1: "p", 2: "q" }).join("|"));', // node 1|2, ours 1|2 — correct
      'console.log(Object.keys({ 1e3: "x" }).join("|"));',       // node 1000,  ours 1e3
      'console.log(Object.keys({ 1.0: "y" }).join("|"));',       // node 1,     ours 1.0
      'console.log(Object.keys({ 0x10: "z" }).join("|"));',      // node 16,    ours 0x10
      'console.log(Object.keys({ 1e21: "w" }).join("|"));',      // node 1e+21, ours 1e21
      'console.log(Object.keys({ 0.5: "v" }).join("|"));',       // node 0.5,   ours 0.5 — correct
      'console.log(JSON.stringify({ 1e3: "x" }));',              // node {"1000":"x"}
      "",
    ].join("\n"));
  });

  /*
   * Key ORDER. OrdinaryOwnPropertyKeys puts every ARRAY-INDEX key first, in ascending
   * NUMERIC order, and only then the rest in insertion order. Ours is insertion order
   * throughout, so `{ b: 1, a: 2, "10": 3, "2": 4 }` stringifies with its keys in the wrong
   * order — same keys, same values, different bytes, exit 0.
   *
   * The rule is narrow and the sweep pins both halves of it: `"0"`, `"1"`, `"2"`, `"10"` are
   * array indices and move to the front; `"01"`, `"1.5"` and `"-1"` are NOT canonical index
   * strings and must stay where they were written. Any fix that sorts "anything numeric-ish"
   * would break the second half.
   */
  it.failing("array-index keys enumerate first, in ascending numeric order", async () => {
    await expectSameBytes([
      'const o = { b: 1, a: 2, "10": 3, "2": 4 };',
      "console.log(JSON.stringify(Object.keys(o)));",   // node ["2","10","b","a"]
      "console.log(JSON.stringify(o));",                // node {"2":4,"10":3,"b":1,"a":2}
      "console.log(JSON.stringify(Object.values(o)));", // node [4,3,1,2]
      'const q = { z: 1, "01": 2, "1.5": 3, "-1": 4, "0": 5 };',
      "console.log(JSON.stringify(Object.keys(q)));",   // node ["0","z","01","1.5","-1"]
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — base64", () => {
  /*
   * `btoa` is defined on a BINARY string: one code unit per byte, and a code point above
   * U+00FF is an InvalidCharacterError. Ours base64-encodes the UTF-8 bytes instead, so
   * `btoa("é")` differs (`w6k=` vs `6Q==`) and `btoa("你")` — which node REFUSES — returns a
   * plausible-looking answer at exit 0. This is §A.2's byte orientation reaching a function
   * whose whole contract is about which bytes those are, and §A.2 does not cover it.
   */
  it.failing("btoa is Latin-1, and rejects a code point above U+00FF", async () => {
    await expectSameBytes('console.log(btoa("\\u00e9"));\n'); // node 6Q==, ours w6k=
  });

  /*
   * `atob` validates: a bad length, stray padding or a non-alphabet character is an
   * InvalidCharacterError. Ours accepts all three and returns a decoded string — the
   * silent-wrong-answer direction on untrusted input.
   */
  it.failing("atob rejects malformed input instead of decoding it", async () => {
    const src = 'console.log(atob("YQ==="));\nconsole.log("after");\n';
    const oracle = nodeRun(src);
    const ours = await ourRun(src);
    if (isRefusal(ours)) throw new Error(`refused: ${ours.refused}`);
    expect(oracle.exitCode).toBe(1); // node throws
    expect(ours.exitCode).toBe(oracle.exitCode); // ours exits 0 having printed "a"
  });
});

describe("fuzz findings — non-ASCII case mapping", () => {
  /*
   * §A.2 documents that string LENGTH and SLICING are UTF-8 byte oriented. It does not cover
   * case mapping, and `toUpperCase`/`toLowerCase` are a no-op outside ASCII — the bytes are
   * well-formed UTF-8, they are simply the unmapped input, so nothing signals the miss.
   */
  it.failing("toUpperCase/toLowerCase map non-ASCII letters", async () => {
    await expectSameBytes([
      'console.log("\\u00e9".toUpperCase());', // node É, ours é
      'console.log("\\u00c9".toLowerCase());', // node é, ours É
      'console.log("abc".toUpperCase());',     // node ABC, ours ABC — correct
      "",
    ].join("\n"));
  });
});

describe("fuzz findings — refusals and stops (ranked last)", () => {
  /*
   * FIXED. The report read this as an argument-position inconsistency — `String(Math.PI)`
   * refused while `console.log(Math.PI)` and `(Math.PI).toFixed(3)` compiled. Measured,
   * none of the three compiled: `Math` was recognized ONLY as a call CALLEE, so every
   * `Math.<constant>` read failed identically and the working neighbours were all
   * `Math.<method>(…)` calls. `String()` was never involved. The eight data properties
   * now have a member-read path of their own; see `test/stdlib-batch1.test.ts`.
   */
  it("String(Math.PI) compiles", async () => {
    await expectSameBytes("console.log(String(Math.PI));\n");
  });

  /*
   * FIXED (fx-padstop). `"abc".padStart(Infinity, "xy")` is a RangeError in node (exit 1,
   * a message on stderr). Here the process died on a SIGNAL with an EMPTY stderr — no
   * `nativets: out of memory`, no panic line, nothing: `(long)Infinity` is UB in C, arm64
   * saturated it to LONG_MAX and asked malloc for 9 exabytes. (On x86-64 the same
   * conversion yields LONG_MIN, which makes `n >= target` true and silently answers
   * `"abc"` at exit 0 — the same source, a wrong answer instead of a stop, decided by the
   * host.) It now stops the documented way, with a `panic:` line naming the length.
   *
   * The pinned assertion is REWRITTEN, not merely un-`.failing`ed: as recorded it demanded
   * `stderrLen: 0`, which describes neither the bug nor a diagnostic. What a fix has to
   * deliver is asserted instead — stdout byte-identical to node's up to the stop, a real
   * message on stderr, and a deliberate exit code. The neighbours this shares a path with
   * (`padEnd`, `.repeat`, and `.repeat`'s far worse size_t WRAP) are covered case by case
   * in test/panic.test.ts, "string length".
   */
  it("an over-long padStart stops with a diagnostic, not a bare signal", async () => {
    const src = 'console.log("start");\nconsole.log("abc".padStart(Infinity, "xy"));\n';
    const oracle = nodeRun(src);
    const ours = await ourRun(src);
    if (isRefusal(ours)) throw new Error(`refused: ${ours.refused}`);
    expect(oracle.exitCode).toBe(1);
    expect(oracle.stderr.toString("utf8")).toContain("RangeError: Invalid string length");
    // Both sides stop at the same point, so everything printed before it must agree byte
    // for byte — the part of the contract a differential run actually compares.
    expect(Buffer.compare(ours.stdout, oracle.stdout)).toBe(0);
    expect(ours.stdout.toString("latin1")).toBe("start\n");
    // Ours: a controlled panic (SIGABRT, shell 134) with the reason on stderr, not silence.
    expect(ours.stderr.toString("utf8")).toContain("panic: invalid string length");
    expect(ours.signal).toBe("SIGABRT");
    // The exit code is where we diverge from node's 1 — deliberately, and documented in
    // docs/divergences.md: this is a panic, like an out-of-range index, not a throw.
    expect(ours.exitCode).toBe(-1); // spawnSync reports `status: null` for a signalled child
  });
});
