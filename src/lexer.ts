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
  if (body[a] !== "@" || body[a + 1] !== "@") return "";
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
function regexCanStart(prev: Token | undefined): boolean {
  if (!prev) return true; // start of input
  if (prev.type === "num" || prev.type === "str" || prev.type === "template" || prev.type === "regex") return false;
  if (prev.type === "ident") return REGEX_AFTER_KEYWORD.has(prev.value);
  if (prev.type === "punct") return !(prev.value === ")" || prev.value === "]" || prev.value === "++" || prev.value === "--");
  return true;
}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`", "0": "\0",
};

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
  };

  // A `#!` shebang on line 1 is not JavaScript — it is a hashbang comment (TC39
  // "HashbangComment", which node and every JS engine strip before parsing). It is
  // skipped to end-of-line rather than tokenized, so an executable script such as
  // our OWN `src/cli.ts` (`#!/usr/bin/env bun`) lexes. Only at offset 0: a `#`
  // anywhere else is still an "Unexpected character". (SH1 tail, self-hosting.)
  if (source.startsWith("#!")) {
    while (i < source.length && source[i] !== "\n") advance();
  }

  /** Raw inner text of a template, up to (not including) its closing backtick. */
  const scanTemplateBody = (sl: number, sc: number): string => {
    let raw = "";
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") { raw += source[i]; advance(); raw += source[i] ?? ""; advance(); continue; }
      if (source[i] === "$" && source[i + 1] === "{") { raw += "${"; advance(2); raw += scanSubstitution(sl, sc); continue; }
      raw += source[i];
      advance();
    }
    if (source[i] !== "`") throw new LexError(`Unterminated template at ${sl}:${sc}`);
    return raw;
  };

  /** A `${…}` substitution's source, up to AND including its matching `}`. Nested
   *  templates, quoted strings and braces are tracked so none of them ends it early. */
  const scanSubstitution = (sl: number, sc: number): string => {
    let out = "";
    let depth = 1;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") { out += ch; advance(); out += source[i] ?? ""; advance(); continue; }
      if (ch === "`") { out += ch; advance(); out += scanTemplateBody(sl, sc) + "`"; advance(); continue; }
      if (ch === '"' || ch === "'") { out += scanQuoted(ch, sl, sc); continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { advance(); return out + "}"; } }
      out += ch;
      advance();
    }
    throw new LexError(`Unterminated template substitution at ${sl}:${sc}`);
  };

  /** A quoted string INSIDE a substitution, copied verbatim (quotes included). */
  const scanQuoted = (q: string, sl: number, sc: number): string => {
    let out = q;
    advance();
    while (i < source.length && source[i] !== q) {
      if (source[i] === "\\") { out += source[i]; advance(); }
      out += source[i];
      advance();
    }
    if (source[i] !== q) throw new LexError(`Unterminated string at ${sl}:${sc}`);
    advance();
    return out + q;
  };

  while (i < source.length) {
    const c = source[i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { advance(); continue; }
    if (c === "/" && source[i + 1] === "/") {
      // PRAGMA COMMENT `//@@name` — the comment spelling of a compile-time attribute.
      //
      // `@@mutable` is not valid TypeScript, so a file carrying the bare sigil cannot
      // ALSO be run by tsc/bun. That is fatal for exactly one program: the compiler's
      // own source, which bun runs today and nativets must compile tomorrow. A line
      // comment whose ENTIRE content is `@@name` lexes to the same two tokens as the
      // sigil, so the attribute is invisible to TypeScript and load-bearing here.
      // Anything else after `//` — including a comment that merely mentions `@@mutable`
      // in prose — stays an ordinary comment. See docs/decorators.md.
      const startLine = line, startCol = col;
      let j = i + 2;
      while (j < source.length && source[j] !== "\n") j++;
      const body = source.slice(i + 2, j);
      const attr = pragmaName(body);
      if (attr !== "") {
        tokens.push({ type: "punct", value: "@@", line: startLine, col: startCol });
        tokens.push({ type: "ident", value: attr, line: startLine, col: startCol + 2 });
      }
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      advance(2);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) advance();
      advance(2);
      continue;
    }

    const sl = line, sc = col;

    // number
    if (c >= "0" && c <= "9") {
      // Radix-prefixed literals `0x1f` / `0b1010` / `0o17` (either case). Kept as raw
      // text — the parser's `Number(value)` decodes every form exactly as node does.
      // Without this the lexer read `0` and then `x1f` as an identifier, which is what
      // made `src/codegen.ts`'s byte constants (`0x22`, `0x5c`) unparseable.
      const radix = source[i + 1];
      if (c === "0" && radix !== undefined && "xXbBoO".includes(radix)) {
        let s = "0" + radix;
        advance(2);
        while (i < source.length && (isHexDigit(source[i]!) || source[i] === "_")) { if (source[i] !== "_") s += source[i]; advance(); }
        tokens.push({ type: "num", value: s, line: sl, col: sc });
        continue;
      }
      let s = "";
      // `_` is a numeric SEPARATOR (`1_000_000`) — legal between digits, dropped here.
      while (i < source.length && ((source[i]! >= "0" && source[i]! <= "9") || source[i] === "_")) { if (source[i] !== "_") s += source[i]; advance(); }
      if (source[i] === ".") { s += "."; advance(); while (i < source.length && source[i]! >= "0" && source[i]! <= "9") { s += source[i]; advance(); } }
      if (source[i] === "e" || source[i] === "E") {
        s += source[i]; advance();
        if (source[i] === "+" || source[i] === "-") { s += source[i]; advance(); }
        while (i < source.length && source[i]! >= "0" && source[i]! <= "9") { s += source[i]; advance(); }
      }
      tokens.push({ type: "num", value: s, line: sl, col: sc });
      continue;
    }

    // identifier / keyword
    if (isIdentStart(c)) {
      let s = "";
      while (i < source.length && isIdentPart(source[i]!)) { s += source[i]; advance(); }
      tokens.push({ type: "ident", value: s, line: sl, col: sc });
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      advance();
      let s = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          advance();
          const e = source[i]!;
          if (e === "x") {
            // `\xHH` — two-hex-digit byte escape (e.g. `\x1b` = ESC), as node does.
            advance();
            const h = (source[i] ?? "") + (source[i + 1] ?? "");
            // `^[0-9a-fA-F]{2}$` — exactly two hex digits (`h` is at most two chars).
            if (h.length !== 2 || !isHexDigit(h[0]!) || !isHexDigit(h[1]!)) {
              throw new LexError(`Invalid \\x escape at ${line}:${col}`);
            }
            s += String.fromCharCode(parseInt(h, 16));
            advance(); advance();
            continue;
          }
          s += ESCAPES[e] ?? e;
          advance();
        } else {
          if (source[i] === "\n") throw new LexError(`Unterminated string at ${line}:${col}`);
          s += source[i];
          advance();
        }
      }
      if (source[i] !== quote) throw new LexError(`Unterminated string at ${sl}:${sc}`);
      advance(); // closing quote
      tokens.push({ type: "str", value: s, line: sl, col: sc });
      continue;
    }

    // template literal — capture raw inner text, INCLUDING nested templates inside a
    // `${…}` substitution (the parser re-lexes each substitution source). Scanning to
    // the first backtick used to end the outer literal early, so
    // `` `{${xs.map((x) => `${x.k}`).join(",")}}` `` — the shape `src/ast.ts` and every
    // `src/codegen.ts` emit site are written in — could not be tokenized at all.
    if (c === "`") {
      advance();
      const raw = scanTemplateBody(sl, sc);
      advance(); // closing backtick
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
    if (c === "/" && regexCanStart(tokens[tokens.length - 1])) {
      let j = i + 1;
      let inClass = false; // inside `[...]`, where `/` is literal and needs no escape
      let closed = false;
      for (; j < source.length && source[j] !== "\n"; j++) {
        const ch = source[j]!;
        // A RegularExpressionBackslashSequence may NOT contain a LineTerminator
        // (test262 language/literals/regexp/7.8.5-1). Skipping the escaped character
        // blindly would scan straight past the newline and swallow the next line.
        if (ch === "\\") { if (source[j + 1] === "\n") { closed = false; break; } j++; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { closed = true; break; }
      }
      if (closed) {
        let end = j + 1;
        while (end < source.length && source[end]! >= "a" && source[end]! <= "z") end++; // flags
        const raw = source.slice(i, end);
        advance(end - i);
        tokens.push({ type: "regex", value: raw, line: sl, col: sc });
        continue;
      }
      // no closer on this line -> it was division after all; fall through to PUNCT.
    }

    const four = source.slice(i, i + 4);
    if (PUNCT_4.includes(four)) { tokens.push({ type: "punct", value: four, line: sl, col: sc }); advance(4); continue; }
    const three = source.slice(i, i + 3);
    if (PUNCT_3.includes(three)) { tokens.push({ type: "punct", value: three, line: sl, col: sc }); advance(3); continue; }
    const two = source.slice(i, i + 2);
    if (PUNCT_2.includes(two)) { tokens.push({ type: "punct", value: two, line: sl, col: sc }); advance(2); continue; }
    if (PUNCT_1.includes(c)) { tokens.push({ type: "punct", value: c, line: sl, col: sc }); advance(); continue; }

    throw new LexError(`Unexpected character '${c}' at ${line}:${col}`);
  }

  tokens.push({ type: "eof", value: "", line, col });
  return tokens;
}
