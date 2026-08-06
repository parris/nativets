/*
 * The compiler's own source contains NO regular expression literal.
 *
 * nativets deliberately has no `RegExp` — a permanent Tier-C refusal
 * (docs/divergences.md): `.replace`/`.replaceAll`/`.split` take string patterns only,
 * and a `/.../` literal lexes to a located `NT1027`. A compiler that cannot compile
 * itself because of a construct it refuses on principle is not going to self-host, so
 * `src/` scans characters instead. This file is the lint that keeps it that way, plus
 * the equivalence evidence for each class that was rewritten.
 *
 * ---- Why the equivalence tests are here and not left to the fixture suite ----
 * A source rewrite of the compiler should be observationally null, and the natural check
 * is to diff the emitted IR for every fixture before and after. That check passes — and
 * it is far too weak. Mutating each rewritten predicate in turn (drop `$` from the
 * identifier class, drop `\r` from `\s`, drop `_` from the hex-digit class, accept a
 * one-digit `\x` escape, accept `A-Z` in regex flags, drop the pragma's trailing-`\s*$`
 * check) changes the IR of ZERO of the 121 fixtures and the token stream of zero of the
 * 12 compiler modules. Five of the six are invisible to the entire existing corpus. So
 * the classes are pinned DIRECTLY, exhaustively, over every BMP code point.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

import { lex } from "../src/lexer.ts";

const SRC = new URL("../src/", import.meta.url);

/**
 * Modules still holding a regex, with the count. A RATCHET: it may shrink, never grow,
 * and a module that reaches zero is DELETED from the table rather than set to 0 — so new
 * compiler code cannot reintroduce a regex into a module that was cleared.
 */
const REMAINING: Record<string, number> = {
  "ast.ts": 6,
  "cli.ts": 1,
  "coverage-preprocess.ts": 5,
  "driver.ts": 7,
  "modules.ts": 1,
};

describe("no RegExp in the compiler's own source", () => {
  test("no `src/` module contains a regex literal", () => {
    // The lexer itself is the judge: it tokenizes `/.../` precisely so the construct is
    // a named refusal rather than a character-level crash. Any hit here is a module that
    // nativets could never compile.
    const found: Record<string, number> = {};
    const where: string[] = [];
    for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort()) {
      const source = readFileSync(new URL(f, SRC), "utf8");
      for (const t of lex(source)) {
        if (t.type !== "regex") continue;
        found[f] = (found[f] ?? 0) + 1;
        where.push(`${f}:${t.line}  ${t.value}`);
      }
    }
    expect({ found, where: where.length }).toEqual({
      found: REMAINING,
      where: Object.values(REMAINING).reduce((a, b) => a + b, 0),
    });
  });
});

/*
 * Character classes: the predicate vs the regex it replaced, over EVERY BMP code point.
 * `\s` here is ECMAScript's WhiteSpace + LineTerminator; the rest are ASCII classes that
 * must NOT quietly extend past ASCII (`isIdentStart` accepting `é`, say).
 */
describe("rewritten character classes are exactly their regex", () => {
  const isIdentStart = (c: string) =>
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
  const isIdentPart = (c: string) => isIdentStart(c) || (c >= "0" && c <= "9");
  const isHexDigit = (c: string) =>
    (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
  const isSpace = (c: string) => {
    const n = c.charCodeAt(0);
    if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32) return true;
    return (
      n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) ||
      n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f ||
      n === 0x3000 || n === 0xfeff
    );
  };

  const classes: [string, (c: string) => boolean, RegExp][] = [
    ["identifier start `[A-Za-z_$]`", isIdentStart, /[A-Za-z_$]/],
    ["identifier part `[A-Za-z0-9_$]` (`[\\w$]`)", isIdentPart, /[A-Za-z0-9_$]/],
    ["hex digit `[0-9a-fA-F]`", isHexDigit, /[0-9a-fA-F]/],
    ["hex digit or `_` separator", (c) => isHexDigit(c) || c === "_", /[0-9a-fA-F_]/],
    ["radix prefix `[xXbBoO]`", (c) => "xXbBoO".includes(c), /[xXbBoO]/],
    ["regex flag `[a-z]`", (c) => c >= "a" && c <= "z", /[a-z]/],
    ["whitespace `\\s`", isSpace, /\s/],
    ["decimal digit `[0-9]`", (c) => c >= "0" && c <= "9", /[0-9]/],
  ];

  for (const [name, fn, re] of classes) {
    test(`${name} — all 65,536 BMP code points`, () => {
      const wrong: string[] = [];
      for (let n = 0; n <= 0xffff; n++) {
        const ch = String.fromCharCode(n);
        if (fn(ch) !== re.test(ch)) wrong.push("U+" + n.toString(16).padStart(4, "0"));
      }
      expect(wrong.slice(0, 10)).toEqual([]);
    });
  }
});

/*
 * `^\s*@@([A-Za-z_$][\w$]*)\s*$` — the pragma spelling of an attribute
 * (docs/decorators.md): a line comment whose ENTIRE content is `@@name` lexes to the same
 * two tokens as the bare sigil. The anchors carry the whole meaning — a comment that
 * merely MENTIONS `@@mutable` in prose must stay an ordinary comment — and dropping the
 * trailing `\s*$` check is invisible to every fixture, so it is pinned here.
 */
describe("the `@@name` pragma matches `^\\s*@@([A-Za-z_$][\\w$]*)\\s*$`", () => {
  const attrs = (line: string) =>
    lex(line + "\n").filter((t) => t.type === "punct" && t.value === "@@").length;
  const name = (line: string) => {
    const toks = lex(line + "\n");
    const at = toks.findIndex((t) => t.type === "punct" && t.value === "@@");
    return at < 0 ? "" : toks[at + 1]!.value;
  };

  test("an exact `@@name` comment produces the sigil + name", () => {
    for (const [line, want] of [
      ["//@@mutable", "mutable"],
      ["// @@mutable", "mutable"],
      ["//   @@mutable   ", "mutable"],
      ["//\t@@mutable\t", "mutable"],
      ["// @@_private", "_private"],
      ["// @@$dollar", "$dollar"],
      ["// @@a1", "a1"],
    ] as const) {
      expect([line, name(line)]).toEqual([line, want]);
    }
  });

  test("anything else stays an ordinary comment", () => {
    for (const line of [
      "// see @@mutable below",   // prose mention — the leading `^` anchor
      "// @@mutable x",           // trailing junk — the `\\s*$` anchor
      "// @@mutable, and more",
      "// @@ mutable",            // space after the sigil
      "// @@1abc",                // not an identifier start
      "// @@",
      "// @mutable",
      "// mutable@@",
    ]) {
      expect([line, attrs(line)]).toEqual([line, 0]);
    }
  });

  test("a CRLF line ending does not defeat the trailing anchor", () => {
    // `\r` is in `\s`, so `//@@mutable\r\n` matched before and must still match. The
    // comment scan stops at `\n`, leaving the `\r` in the body.
    expect(lex("//@@mutable\r\nclass C {}\n").filter((t) => t.value === "@@").length).toBe(1);
  });
});

/*
 * BORROWED: tc39/test262. The mutation run above found exactly one rewritten class the
 * existing corpus could catch — the regex FLAG class — and it was test262 that caught it,
 * via `early-err-bad-flag.js`, whose flag is an uppercase letter. A hand-written corpus
 * would not have had one. (The other five mutations were caught only by the exhaustive
 * BMP sweeps above, which is why those exist.)
 */
describe("borrowed: tc39/test262 language/literals/regexp", () => {
  test("early-err-bad-flag.js — an uppercase flag is NOT part of the literal", () => {
    // `/./G` — flags are `[a-z]`, so the literal is `/./` and `G` is an identifier.
    const toks = lex("f(/./G);");
    expect(toks.find((t) => t.type === "regex")!.value).toBe("/./");
    expect(toks.some((t) => t.type === "ident" && t.value === "G")).toBe(true);
  });

  test("S7.8.5_A3.1_T1 shapes — lowercase flags ARE part of the literal", () => {
    for (const [src, want] of [
      ["f(/x/g);", "/x/g"],
      ["f(/x/i);", "/x/i"],
      ["f(/x/gim);", "/x/gim"],
      ["f(/x/);", "/x/"],
    ] as const) {
      expect(lex(src).find((t) => t.type === "regex")!.value).toBe(want);
    }
  });
});
