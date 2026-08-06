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

export type TokenType = "num" | "ident" | "str" | "template" | "punct" | "eof";

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
      const m = /^\s*@@([A-Za-z_$][\w$]*)\s*$/.exec(body);
      if (m) {
        tokens.push({ type: "punct", value: "@@", line: startLine, col: startCol });
        tokens.push({ type: "ident", value: m[1]!, line: startLine, col: startCol + 2 });
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
      if (c === "0" && radix !== undefined && /[xXbBoO]/.test(radix)) {
        let s = "0" + radix;
        advance(2);
        while (i < source.length && /[0-9a-fA-F_]/.test(source[i]!)) { if (source[i] !== "_") s += source[i]; advance(); }
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
    if (/[A-Za-z_$]/.test(c)) {
      let s = "";
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i]!)) { s += source[i]; advance(); }
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
            if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new LexError(`Invalid \\x escape at ${line}:${col}`);
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
