/*
 * Hand-written lexer. No `typescript` dependency.
 *
 * Token kinds:
 *   num       numeric literal (raw text)
 *   ident     identifier or keyword
 *   str       string literal (value already unescaped)
 *   template  template literal raw inner text (between backticks); the parser
 *             splits it into quasis + ${} expression sources
 *   punct     operator/punctuator
 *   eof
 */

export type TokenType = "num" | "ident" | "str" | "template" | "regex" | "punct" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

/**
 * The scanner's cursor — byte offset plus the 1-based line/column it names.
 *
 * It is a RECORD rather than three `let`s because `advance` and the three
 * `scan*` helpers are closures that move it, and a write to a binding captured
 * from an enclosing scope is `NT1031` (it was the last thing standing between
 * this module and self-compilation). Mutating a field of an `@@mutable` record
 * is not a capture write — the binding never changes, the object does — and
 * `//@@mutable` is a comment to TypeScript, so bun runs this file unchanged.
 */
//@@mutable
/**
 * `err` is the FUNNEL for the two nested scanners. `scanQuoted` and `scanTemplateBody` are
 * arrows called from inside `lex`, not from inside a `try`, so a `throw` in either may not
 * cross that frame (NT1004) — the refusal that kept `src/parser.ts` from reaching IR. They
 * record the message here instead and `lex` raises it, where a throw IS legal because
 * `parser.ts`'s `tokenize` calls `lex` inside a `try`.
 *
 * It rides on the cursor because they already share it — no new plumbing, and one place to
 * check. Once set, both scanners stop and return what they have; the value is discarded at
 * the raise, so the partial result never reaches a token.
 */
interface LexState { i: number; line: number; col: number; err?: string }

const PUNCT_4 = [">>>="];
const PUNCT_3 = ["===", "!==", ">>>", "...", "<<=", ">>=", "**="];
const PUNCT_2 = [
  "**", "==", "!=", "<=", ">=", "&&", "||", "??", "?.",
  "++", "--", "+=", "-=", "*=", "/=", "%=", "<<", ">>",
  "&=", "|=", "^=", "=>", "|>", "@@",
];
const PUNCT_1 = [
  "(", ")", "{", "}", "[", "]", ",", ";", ".",
  "=", "+", "-", "*", "/", "%", "<", ">", "!", "?", ":",
  "&", "|", "^", "~", "@",
];

export class LexError extends Error {}

/*
 * Character classes, spelled out.
 *
 * nativets deliberately has no `RegExp` (a Tier-C refusal — docs/divergences.md), so the
 * compiler's own source may not use one either: a `/.../` in here is refused with NT1027
 * and this file never reaches the parser. These predicates are the character classes the
 * scanner used to express as one-character regexes, and each is exactly its class.
 */

/** `[A-Za-z_$]` — an identifier's first character. */
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}
/** `[A-Za-z0-9_$]` (= `[\w$]`) — an identifier's subsequent characters. */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}
/** `[0-9a-fA-F]`. */
function isHexDigit(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
/**
 * ECMAScript `\s` — WhiteSpace + LineTerminator, by code unit. The scanner only ever
 * applies this to a single source line, but that line can still hold a `\r` (CRLF) or a
 * ` `, both of which `\s` matched.
 */
function isSpace(c: string): boolean {
  const n = c.charCodeAt(0);
  if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32) return true;
  return (
    n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) ||
    n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f ||
    n === 0x3000 || n === 0xfeff
  );
}

/**
 * `^\s*@@([A-Za-z_$][\w$]*)\s*$` over a line comment's body — the pragma spelling of an
 * attribute (docs/decorators.md). Returns the attribute name, or `""` when the comment is
 * anything else (including one that merely mentions `@@mutable` in prose).
 */
function pragmaName(body: string): string {
  let a = 0;
  while (a < body.length && isSpace(body[a]!)) a++;
  // `a + 1 < body.length` FIRST, and it is not defensive padding. A bare `//` has an
  // EMPTY body, so `body[a]` is a read at index == length, which node answers `undefined`
  // and nativets PANICS on by design (Stage 41, docs/divergences.md). A self-compiled
  // lexer therefore died on any file holding a bare `//` — 43 lines of `src/` itself. The
  // guard is exactly equivalent under bun: reaching the `@@` test at all needs two more
  // characters. Pinned by test/no-index-last.test.ts and test/sh6-fuzz.test.ts.
  if (a + 1 >= body.length || body[a] !== "@" || body[a + 1] !== "@") return "";
  a += 2;
  if (a >= body.length || !isIdentStart(body[a]!)) return "";
  const start = a;
  a++;
  while (a < body.length && isIdentPart(body[a]!)) a++;
  const name = body.slice(start, a);
  // `\s*$` — everything after the name must be whitespace, all the way to the end.
  while (a < body.length && isSpace(body[a]!)) a++;
  return a === body.length ? name : "";
}

/**
 * Keywords after which a `/` begins a REGEX rather than a division. Everything that can
 * END an expression (identifier, literal, `)`, `]`, postfix `++`/`--`) means division;
 * these keywords cannot end one, so `return /x/.test(s)` lexes as a regex while
 * `(a + b) / c` and `a / b / c` stay division. This is the standard prev-token
 * disambiguation — the ambiguity is genuinely unresolvable without parser context.
 */
const REGEX_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/** May a regex literal begin here, given the previous significant token? */
/*
 * Takes a Token, NOT `Token | undefined`. The start-of-input case is decided by the ONE
 * caller, with a `tokens.length === 0` test, because reaching it as `undefined` meant
 * indexing `tokens[-1]` — which node answers `undefined` and nativets PANICS on
 * (docs/divergences.md). The `if (!prev) return true` this replaces could therefore
 * never have run under nativets; the panic happened one line earlier, at the argument.
 * See test/tsc.test.ts.
 */
function regexCanStart(prev: Token): boolean {
  if (prev.type === "num" || prev.type === "str" || prev.type === "template" || prev.type === "regex") return false;
  if (prev.type === "ident") return REGEX_AFTER_KEYWORD.has(prev.value);
  if (prev.type === "punct") return !(prev.value === ")" || prev.value === "]" || prev.value === "++" || prev.value === "--");
  return true;
}

/**
 * The single-character escapes, as a `switch` rather than a lookup table.
 *
 * It was `const ESCAPES: Record<string, string>` read as `ESCAPES[e] ?? e`, and nativets
 * cannot compile either half: `Record<K,V>` erases to `Map<K,V>` (so an object literal
 * cannot initialize it), and indexing an object by a VARIABLE key is refused because
 * node's `o[k]` consults the prototype chain — `o["toString"]` is a FUNCTION in node,
 * and an own-keys-only lowering would answer `undefined`. A `switch` has neither problem,
 * is what a hand-written lexer would reach for anyway, and keeps this file inside the
 * subset the compiler compiles (docs/self-hosting.md).
 */
function escapeChar(e: string): string {
  switch (e) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "\\": return "\\";
    case "'": return "'";
    case '"': return '"';
    case "`": return "`";
    // `String.fromCharCode(0)`, not the `"\0"` literal: a NUL inside a string literal is
    // itself NT1705 (a nativets string is NUL-terminated), so writing one HERE would make
    // this file un-self-hostable — src/*.ts has to stay inside the subset nativets
    // compiles (docs/self-hosting.md). `src/modules.ts` spells its NUL the same way.
    case "0": return String.fromCharCode(0);
    // \b, \f and \v are spelled by CODE POINT for the same reason as the NUL above, and
    // for a second one that is specific to them: they were MISSING from this table until
    // 2026-08-11, so they decoded to the letters `b`/`f`/`v`. Writing the literal escape
    // here would be read correctly by the bun-hosted stage-1 and INCORRECTLY by a
    // nativets-compiled stage-2 built from a tree that still had the bug — the two stages
    // would disagree, which is exactly the bootstrap fixed point this project is aiming at.
    // A fix for a lexer defect must never be written using the construct it fixes.
    case "b": return String.fromCharCode(8);
    case "f": return String.fromCharCode(12);
    case "v": return String.fromCharCode(11);
    default: return e; // an unknown escape is the character itself — `\q` is `q`
  }
}

/**
 * Decode ONE escape sequence. `raw[i]` is the backslash; returns the decoded text and the
 * index just past the sequence.
 *
 * It exists so the STRING scanner below and the parser's TEMPLATE splitter
 * (`buildTemplate`) decode escapes the same way. They did not: a template's decoder knew
 * only `\n \t \r \\ \` \$` and fell through to the escaped character for everything else,
 * so `` `a\0b` `` was "a0b" and `` `a\x00b` `` was "ax00b" — wrong VALUES that a `.length`
 * assertion cannot see, since the wrong answer is the same length as the right one. One
 * decoder, one set of rules, one place to fix the next escape.
 *
 * The two contexts differ only in which quote needs escaping, and `escapeChar` already
 * maps `'`, `"` and `` ` `` to themselves; `\$` (template-only) falls through to `$` for
 * the same reason node does — an unrecognized escape is the character itself.
 */
/**
 * The result of decoding one escape: the decoded text, and the index just past it.
 *
 * A RECORD, not the `[string, number]` tuple this started as. nativets has no tuple
 * type — a mixed array literal is `NT2001 array elements must share a type (got string,
 * number)` — so the tuple made `src/lexer.ts` un-self-hostable the moment it landed, and
 * moved the module's first blocker without changing its NT CODE. That is exactly the
 * regression `test/selfhost-ratchet.test.ts` was built to catch, and it caught this one:
 * the lane that introduced the tuple re-checked its work by comparing NT codes, which
 * were NT2001 before and after, so its own check passed while the gap widened.
 */
/**
 * `error` is REPORTED, not thrown — the funnel that keeps `decodeEscapeAt` compilable.
 *
 * Its six failures used to `throw new LexError(...)`, and this function is called from
 * inside `lex` and again from `parser.ts`'s `buildTemplate`, in neither case inside a
 * `try`. A throw may cross exactly ONE frame here, and only when EVERY call site of its
 * function catches (NT1004) — so those six throws are what stopped `src/parser.ts` from
 * reaching IR, and they are the reason this reports instead.
 *
 * Both callers raise it immediately, so the message and position a program sees are
 * unchanged — `test/lexer-errors.test.ts` pins all six by exact text, in BOTH carriers.
 * When `error` is set, `text` is empty and `next` steps one character so a caller that
 * ignored it could not spin; no caller does.
 */
export interface DecodedEscape { text: string; next: number; error?: string; }

export function decodeEscapeAt(raw: string, i: number, line: number, col: number): DecodedEscape {
  // `i + 1 < raw.length`, not `raw[i + 1] ?? ""`. The `??` was a DEAD GUARD: a trailing
  // `"\` puts `i + 1` at index == length, and nativets PANICS on that read (Stage 41)
  // before the `??` can answer. Same class as `pragmaName` above.
  const e = i + 1 < raw.length ? raw[i + 1]! : "";
  // LegacyOctalEscapeSequence (ECMAScript Annex B.1.2). `\1`…`\7`, and `\0` when a
  // DECIMAL DIGIT follows it — that combination is octal, not the NUL escape: node reads
  // `"\01"` as U+0001, while we used to read `\0` as NUL and then append a literal "1",
  // which truncated the string AND named the wrong character. `\1` alone was just as
  // wrong: it decoded to the character "1" (charCodeAt 49) where node says 1.
  //
  // A DIVERGENCE, and the claim that stood here was wrong. It said: these are a SyntaxError
  // in strict mode, a TypeScript module is strict, so refusing them is the same answer node
  // gives. The premise holds and the conclusion does not, because whether node treats a
  // `.ts` file as strict depends on THE FILE'S SHAPE. A single file with no `import` or
  // `export` loads as CommonJS — sloppy — and node DECODES the escape:
  //
  //     $ node oct.ts            # no import/export
  //     aAb                      # exit 0
  //
  // `node <file>` is this project's oracle literally, and that is the shape a fixture has,
  // so this refuses a program node runs. It is KEPT — refusing a deprecated Annex B form is
  // the safe direction, and the finding behind it stands (we used to decode `\1` as the
  // character "1", charCodeAt 49, where node says 1) — but it is recorded as a refusal in
  // docs/divergences.md, not claimed as agreement. test/nul-string.test.ts RUNS both shapes.
  //
  // `\8` and `\9` are NOT octal (NonOctalDecimalEscapeSequence) and already decode as
  // node does, so they fall through to `escapeChar`. A BARE `\0` also falls through, and
  // is the NUL escape it has always been — refused downstream as NT1705, for a different
  // reason and with a different message.
  if (e >= "1" && e <= "7") {
    return { text: "", next: i + 1, error: `Octal escape sequences are not allowed at ${line}:${col}` };
  }
  if (e === "0") {
    const d = raw[i + 2] ?? "";
    if (d >= "0" && d <= "9") return { text: "", next: i + 1, error: `Octal escape sequences are not allowed at ${line}:${col}` };
  }
  if (e === "x") {
    // `\xHH` — two-hex-digit byte escape (e.g. `\x1b` = ESC), as node does. Only a
    // LOWERCASE `x` starts one: node reads `\X00` as the three characters "X00".
    const h = (raw[i + 2] ?? "") + (raw[i + 3] ?? "");
    if (h.length !== 2 || !isHexDigit(h[0]!) || !isHexDigit(h[1]!)) {
      return { text: "", next: i + 1, error: `Invalid \\x escape at ${line}:${col}` };
    }
    return { text: String.fromCharCode(parseInt(h, 16)), next: i + 4 };
  }
  if (e === "u") {
    // `\uHHHH` and `\u{H+}` (ECMAScript UnicodeEscapeSequence). These were NOT escapes
    // the lexer knew: `\u` fell through to "an unknown escape is the character itself",
    // so a four-hex-digit escape naming "A" compiled to the SEVEN characters `au0041b`
    // where node gives `aAb` — a silent wrong answer, and the only reason a NUL spelled
    // as a \u escape did not read as a NUL at all.
    // Malformed forms are a SyntaxError in node (test262
    // language/literals/string/unicode-escape-no-hex-err-{double,single}.js), so they are
    // a LexError here rather than a decoded guess.
    if (raw[i + 2] === "{") {
      let j = i + 3;
      let hex = "";
      while (j < raw.length && raw[j] !== "}") { hex += raw[j]; j++; }
      if (raw[j] !== "}" || hex.length === 0 || !allHexDigits(hex)) {
        return { text: "", next: i + 1, error: `Invalid \\u{…} escape at ${line}:${col}` };
      }
      const cp = parseInt(hex, 16);
      // > 0x10FFFF is "undefined Unicode code-point" — a SyntaxError, not a clamp.
      if (cp > 0x10ffff) return { text: "", next: i + 1, error: `Invalid \\u{…} escape at ${line}:${col}: ${hex} is above 10FFFF` };
      return { text: String.fromCodePoint(cp), next: j + 1 };
    }
    const h = (raw[i + 2] ?? "") + (raw[i + 3] ?? "") + (raw[i + 4] ?? "") + (raw[i + 5] ?? "");
    if (h.length !== 4 || !allHexDigits(h)) return { text: "", next: i + 1, error: `Invalid \\u escape at ${line}:${col}` };
    // fromCharCode, not fromCodePoint: `\uHHHH` names a UTF-16 CODE UNIT, so an adjacent
    // pair — a high-surrogate escape followed by a low-surrogate one — has to combine
    // into ONE astral character exactly as it does in node, which it does because both
    // code units land in the same JS string here.
    return { text: String.fromCharCode(parseInt(h, 16)), next: i + 6 };
  }
  return { text: escapeChar(e), next: i + 2 };
}

/** `^[0-9a-fA-F]+$`, and non-empty — nativets has no RegExp (NT1027), so it is a loop. */
function allHexDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const c of s) if (!isHexDigit(c)) return false;
  return true;
}

export function lex(source: string): Token[] {
  // The token stream is the compiler's hottest accumulator — 34,987 elements for
  // `src/checker.ts` alone — so it is an `@@mutable` ACCUMULATOR: `.push` appends in
  // place. Under bun (stage 0) the immutable spelling `tokens = [...tokens, t]` is a real
  // O(n) copy per append and measured 1036x slower; under nativets both are O(1)
  // amortized. Spelled as a comment so the one source satisfies both toolchains
  // (docs/decorators.md, docs/self-hosting.md).
  //@@mutable
  const tokens: Token[] = [];
  const st: LexState = { i: 0, line: 1, col: 1 };

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      // `st.i < source.length` first: an unterminated `/*` walks the cursor one past the
      // end, and that read PANICS under nativets (Stage 41) where node answers `undefined`.
      if (st.i < source.length && source[st.i] === "\n") { st.line++; st.col = 1; } else { st.col++; }
      st.i++;
    }
  };

  // A leading UTF-8 BOM (U+FEFF) is not part of the program. node strips it and so does
  // tsc, so a BOM-prefixed file that runs fine under node must compile here — it used to
  // die with a raw `LexError: Unexpected character ' ' at 1:1` (not even a banded
  // diagnostic, and naming an unprintable character). Found by running the TypeScript
  // conformance union corpus, 13 of whose 25 files are BOM-prefixed.
  //
  // Only at offset 0. ECMAScript actually puts U+FEFF (<ZWNBSP>) in WhiteSpace
  // *everywhere* — `const a<FEFF>= 1` runs under node — but the main scan loop below
  // recognizes only ` \t\r\n` as space anyway, so a mid-file FEFF still (correctly)
  // rejects rather than miscompiles. Widening the whole whitespace class is its own job.
  if (source.charCodeAt(0) === 0xfeff) advance(1);

  // A `#!` shebang on line 1 is not JavaScript — it is a hashbang comment (TC39
  // "HashbangComment", which node and every JS engine strip before parsing). It is
  // skipped to end-of-line rather than tokenized, so an executable script such as
  // our OWN `src/cli.ts` (`#!/usr/bin/env bun`) lexes. Only at offset 0: a `#`
  // anywhere else is still an "Unexpected character". (SH1 tail, self-hosting.)
  if (source.startsWith("#!", st.i)) {
    while (st.i < source.length && source[st.i] !== "\n") advance(1);
  }

  /** A quoted string INSIDE a substitution, copied verbatim (quotes included). */
  const scanQuoted = (q: string, sl: number, sc: number): string => {
    let out = q;
    advance(1);
    while (st.i < source.length && source[st.i] !== q) {
      if (source[st.i] === "\\") { out += source[st.i]; advance(1); }
      // The escape branch just advanced, so the cursor may now be AT the end: a trailing
      // `"\` makes this read out of range, which nativets PANICS on (Stage 41).
      if (st.i >= source.length) break;
      out += source[st.i];
      advance(1);
    }
    // `st.i >= source.length ||` FIRST — at end of input the read panicked one statement
    // BEFORE the `LexError` it was written to raise, so this is the ERROR PATH breaking.
    if (st.i >= source.length || source[st.i] !== q) { st.err = `Unterminated string at ${sl}:${sc}`; return out; }
    advance(1);
    return out + q;
  };

  /**
   * Raw inner text of a template, up to (not including) its closing backtick —
   * INCLUDING every `${…}` substitution, with nested templates, quoted strings
   * and braces tracked so that none of them ends the literal early.
   *
   * A template body and a substitution used to be two MUTUALLY RECURSIVE
   * closures. nativets supports no nested recursion at all (`NT1003`: a nested
   * `function`, a self-recursive arrow and a forward-referenced one are equally
   * refused), and neither the mutable cursor nor an `@@mutable` record survives
   * being passed to a top-level function (`NT1607` — a parameter is a borrow).
   * So the recursion is made explicit instead of implicit, which it can be
   * because every frame appended to the SAME string in source order:
   *
   *   `frames` is the context stack — `-1` is a template body, `n >= 1` is a
   *   substitution whose brace depth is `n`. It is never deeper than the
   *   source's own template nesting (2 in this tree), so the copy-on-append is
   *   free.
   */
  const scanTemplateBody = (sl: number, sc: number): string => {
    let raw = "";
    let frames: number[] = [-1];
    while (frames.length > 0) {
      const top = frames[frames.length - 1]!;
      if (st.i >= source.length) {
        st.err = top === -1
          ? `Unterminated template at ${sl}:${sc}`
          : `Unterminated template substitution at ${sl}:${sc}`;
        return raw;
      }
      const ch = source[st.i]!;
      if (ch === "\\") { raw += ch; advance(1); raw += st.i < source.length ? source[st.i]! : ""; advance(1); continue; }
      if (top === -1) {
        // a template body: `${` opens a substitution, a backtick closes the body
        if (ch === "`") {
          frames = frames.slice(0, frames.length - 1);
          // the OUTERMOST backtick is consumed by the caller, an inner one here
          if (frames.length > 0) { raw += "`"; advance(1); }
          continue;
        }
        if (ch === "$" && st.i + 1 < source.length && source[st.i + 1] === "{") { raw += "${"; advance(2); frames = [...frames, 1]; continue; }
        raw += ch;
        advance(1);
        continue;
      }
      // a substitution: braces nest, a backtick opens a nested template body
      if (ch === "`") { raw += ch; advance(1); frames = [...frames, -1]; continue; }
      // `scanQuoted` reports into `st.err` rather than throwing (see `LexState`), so its
      // failure has to end this loop too — otherwise an unterminated string inside a
      // template would be swallowed and scanning would run on past it.
      if (ch === '"' || ch === "'") { raw += scanQuoted(ch, sl, sc); if (st.err !== undefined) return raw; continue; }
      if (ch === "{") frames = [...frames.slice(0, frames.length - 1), top + 1];
      else if (ch === "}") {
        if (top === 1) { advance(1); raw += "}"; frames = frames.slice(0, frames.length - 1); continue; }
        frames = [...frames.slice(0, frames.length - 1), top - 1];
      }
      raw += ch;
      advance(1);
    }
    return raw;
  };

  while (st.i < source.length) {
    const c = source[st.i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { advance(1); continue; }
    // `st.i + 1 < source.length` FIRST, here and at the `/*` opener below: a file whose
    // LAST byte is `/` reads index == length, which nativets PANICS on (Stage 41). Found
    // by the prefix sweep in test/no-index-last.test.ts, not by eye.
    if (c === "/" && st.i + 1 < source.length && source[st.i + 1] === "/") {
      // PRAGMA COMMENT `//@@name` — the comment spelling of a compile-time attribute.
      //
      // `@@mutable` is not valid TypeScript, so a file carrying the bare sigil cannot
      // ALSO be run by tsc/bun. That is fatal for exactly one program: the compiler's
      // own source, which bun runs today and nativets must compile tomorrow. A line
      // comment whose ENTIRE content is `@@name` lexes to the same two tokens as the
      // sigil, so the attribute is invisible to TypeScript and load-bearing here.
      // Anything else after `//` — including a comment that merely mentions `@@mutable`
      // in prose — stays an ordinary comment. See docs/decorators.md.
      const startLine = st.line, startCol = st.col;
      let j = st.i + 2;
      while (j < source.length && source[j] !== "\n") j++;
      const body = source.slice(st.i + 2, j);
      const attr = pragmaName(body);
      if (attr !== "") {
        tokens.push({ type: "punct", value: "@@", line: startLine, col: startCol });
        tokens.push({ type: "ident", value: attr, line: startLine, col: startCol + 2 });
      }
      while (st.i < source.length && source[st.i] !== "\n") advance(1);
      continue;
    }
    if (c === "/" && st.i + 1 < source.length && source[st.i + 1] === "*") {
      advance(2);
      // The SECOND read needs its own guard: an unterminated `/*` ending in a lone `*`
      // puts `st.i + 1` one past the end.
      while (st.i < source.length && !(source[st.i] === "*" && st.i + 1 < source.length && source[st.i + 1] === "/")) advance(1);
      advance(2);
      continue;
    }

    const sl = st.line, sc = st.col;

    // number
    if (c >= "0" && c <= "9") {
      // Radix-prefixed literals `0x1f` / `0b1010` / `0o17` (either case). Kept as raw
      // text — the parser's `Number(value)` decodes every form exactly as node does.
      // Without this the lexer read `0` and then `x1f` as an identifier, which is what
      // made `src/codegen.ts`'s byte constants (`0x22`, `0x5c`) unparseable.
      // `.at`, not `source[st.i + 1]`: at the very end of the file that index is out of
      // range, and node answers `undefined` while nativets PANICS there by design (the
      // Stage 41 bounds rule; `docs/divergences.md`). `.at` is the spelling that means
      // "may be absent" in BOTH toolchains — identical under bun for a non-negative
      // index, and a real `?Ustring` here, which `!== undefined` then narrows.
      const radix = source.at(st.i + 1);
      if (c === "0" && radix !== undefined && "xXbBoO".includes(radix)) {
        let s = "0" + radix;
        advance(2);
        while (st.i < source.length && (isHexDigit(source[st.i]!) || source[st.i] === "_")) { if (source[st.i] !== "_") s += source[st.i]; advance(1); }
        tokens.push({ type: "num", value: s, line: sl, col: sc });
        continue;
      }
      let s = "";
      // `_` is a numeric SEPARATOR (`1_000_000`) — legal between digits, dropped here.
      while (st.i < source.length && ((source[st.i]! >= "0" && source[st.i]! <= "9") || source[st.i] === "_")) { if (source[st.i] !== "_") s += source[st.i]; advance(1); }
      // Each `st.i < source.length` is the same Stage 41 bounds rule as `pragmaName`'s: a
      // numeric literal that ENDS the file leaves the cursor at index == length, which
      // node answers `undefined` and nativets panics on. `1` as the last byte of a file
      // reached all three of these.
      if (st.i < source.length && source[st.i] === ".") { s += "."; advance(1); while (st.i < source.length && source[st.i]! >= "0" && source[st.i]! <= "9") { s += source[st.i]; advance(1); } }
      if (st.i < source.length && (source[st.i] === "e" || source[st.i] === "E")) {
        s += source[st.i]; advance(1);
        if (st.i < source.length && (source[st.i] === "+" || source[st.i] === "-")) { s += source[st.i]; advance(1); }
        while (st.i < source.length && source[st.i]! >= "0" && source[st.i]! <= "9") { s += source[st.i]; advance(1); }
      }
      tokens.push({ type: "num", value: s, line: sl, col: sc });
      continue;
    }

    // identifier / keyword
    if (isIdentStart(c)) {
      let s = "";
      while (st.i < source.length && isIdentPart(source[st.i]!)) { s += source[st.i]; advance(1); }
      tokens.push({ type: "ident", value: s, line: sl, col: sc });
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      advance(1);
      let s = "";
      while (st.i < source.length && source[st.i] !== quote) {
        if (source[st.i] === "\\") {
          // RAISED HERE, in `lex`, where a throw is legal: `parser.ts`'s `tokenize` calls
          // `lex` inside a `try`, so it crosses exactly one frame. That is the whole point
          // of the decoder reporting rather than throwing.
          const d = decodeEscapeAt(source, st.i, st.line, st.col);
          if (d.error !== undefined) throw new LexError(d.error);
          const text = d.text, next = d.next;
          s += text;
          advance(next - st.i);
        } else {
          if (source[st.i] === "\n") throw new LexError(`Unterminated string at ${st.line}:${st.col}`);
          s += source[st.i];
          advance(1);
        }
      }
      // `st.i >= source.length ||` FIRST — and this one is the ERROR PATH breaking, not
      // just a divergence: at end of input the read panics one statement BEFORE the
      // `LexError` it was written to raise, so `"abc` aborted where `"abc\n` threw
      // correctly. See test/sh6-fuzz.test.ts's split of the error path.
      if (st.i >= source.length || source[st.i] !== quote) throw new LexError(`Unterminated string at ${sl}:${sc}`);
      advance(1); // closing quote
      tokens.push({ type: "str", value: s, line: sl, col: sc });
      continue;
    }

    // template literal — capture raw inner text, INCLUDING nested templates inside a
    // `${…}` substitution (the parser re-lexes each substitution source). Scanning to
    // the first backtick used to end the outer literal early, so
    // `` `{${xs.map((x) => `${x.k}`).join(",")}}` `` — the shape `src/ast.ts` and every
    // `src/codegen.ts` emit site are written in — could not be tokenized at all.
    if (c === "`") {
      advance(1);
      const raw = scanTemplateBody(sl, sc);
      // THE RAISE. Both nested scanners funnel here; a throw in `lex` is legal because
      // `tokenize` calls it inside a `try`, so it crosses exactly one frame.
      //
      // Bound to a LOCAL first: the guard has to narrow the thing that is READ, and a field
      // of another object is not a stable access path here — `new LexError(st.err)` is
      // `expects string, got ?Ustring` even directly under the test (docs/self-hosting.md,
      // the same shape as `sub.blockedOn`).
      const err = st.err;
      if (err !== undefined) throw new LexError(err);
      advance(1); // closing backtick
      tokens.push({ type: "template", value: raw, line: sl, col: sc });
      continue;
    }

    // Regex literal `/pattern/flags`. nativets has NO RegExp (Tier C) — this exists so a
    // regex is a LOCATED, named refusal (NT1027 at parse) instead of a character-level
    // lexer crash on the first `\` inside it, which killed the whole file and made 8 of
    // the 12 compiler modules unmeasurable (docs/self-hosting.md).
    //
    // Two guards keep a DIVISION from ever being mistaken for a regex — a misread would
    // swallow real code up to the next `/`:
    //   1. the previous-token rule (`regexCanStart`), and
    //   2. a closing unescaped `/` must exist on the SAME line (a regex literal cannot
    //      span lines), else we fall through and treat `/` as the operator it is.
    // `tokens.length === 0` IS the start-of-input arm — see regexCanStart.
    if (c === "/" && (tokens.length === 0 || regexCanStart(tokens[tokens.length - 1]!))) {
      let j = st.i + 1;
      let inClass = false; // inside `[...]`, where `/` is literal and needs no escape
      let closed = false;
      for (; j < source.length && source[j] !== "\n"; j++) {
        const ch = source[j]!;
        // A RegularExpressionBackslashSequence may NOT contain a LineTerminator
        // (test262 language/literals/regexp/7.8.5-1). Skipping the escaped character
        // blindly would scan straight past the newline and swallow the next line.
        // `j + 1 >= source.length ||` first: a regex body ending in a lone `\` reads past
          // the end, and "not closed" is the same answer node reaches there anyway.
          if (ch === "\\") { if (j + 1 >= source.length || source[j + 1] === "\n") { closed = false; break; } j++; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { closed = true; break; }
      }
      if (closed) {
        let end = j + 1;
        while (end < source.length && source[end]! >= "a" && source[end]! <= "z") end++; // flags
        const raw = source.slice(st.i, end);
        advance(end - st.i);
        tokens.push({ type: "regex", value: raw, line: sl, col: sc });
        continue;
      }
      // no closer on this line -> it was division after all; fall through to PUNCT.
    }

    const four = source.slice(st.i, st.i + 4);
    if (PUNCT_4.includes(four)) { tokens.push({ type: "punct", value: four, line: sl, col: sc }); advance(4); continue; }
    const three = source.slice(st.i, st.i + 3);
    if (PUNCT_3.includes(three)) { tokens.push({ type: "punct", value: three, line: sl, col: sc }); advance(3); continue; }
    const two = source.slice(st.i, st.i + 2);
    if (PUNCT_2.includes(two)) { tokens.push({ type: "punct", value: two, line: sl, col: sc }); advance(2); continue; }
    if (PUNCT_1.includes(c)) { tokens.push({ type: "punct", value: c, line: sl, col: sc }); advance(1); continue; }

    throw new LexError(`Unexpected character '${c}' at ${st.line}:${st.col}`);
  }

  tokens.push({ type: "eof", value: "", line: st.line, col: st.col });
  return tokens;
}
